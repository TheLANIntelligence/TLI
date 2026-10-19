// ---------- settings panel (browser preferences + host controls) ----------
const settingsKey = "tli_settings";
const settingsLegacyConversationsKey = "tli_previous_conversations";
function readSettings() {
  try {
    const raw = localStorage.getItem(settingsKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeSettings(s) {
  localStorage.setItem(settingsKey, JSON.stringify(s));
}

function settingsFeedback(id, message, failed = false) {
  const target = $(id);
  if (target) {
    target.textContent = message;
    target.setAttribute("role", "status");
    target.dataset.state = failed ? "error" : "saved";
  }
}

// Apply settings to the ACTIVE UI (header chips + theme)
function applySettingsToUI(s) {
  const modeEl  = $("mode-select");

  if (modeEl) {
    modeEl.value = s.defaultMode || "default";
  }

  const tgl = $("teaching-toggle");
  if (tgl) {
    if (s.teachingOn) tgl.classList.add("on");
    else tgl.classList.remove("on");
  }

  const tempEl = $("temperature-input"), maxEl = $("max-tokens-input");
  if (tempEl) tempEl.value = s.defaultTemp || "0.7";
  if (maxEl) maxEl.value = s.defaultMax || "768";

  // Apply theme to <html>
  if (window.TLIThemes?.applyPreference) window.TLIThemes.applyPreference(s);
  else applyTheme(s.defaultTheme || DEFAULT_THEME);

  // (keep the rest of this function exactly as you have it now)

}

// ----- Settings: Model server + UI prefs -----
let settingsModelEpoch = 0, settingsModelRead = 0, settingsModelReady = true, settingsModelLocked = false, settingsModelSaving = null;
const settingsModelCurrent = token => settingsModelReady && !settingsModelLocked && token.epoch === settingsModelEpoch && token.read === settingsModelRead;
function clearModelSettings(message = 'Unlock TLI and check access to load models.') {
  for (const id of ['settings-model-url', 'settings-model-compat']) { const node = $(id); if (node) node.textContent = ''; }
  const select = $('settings-model-id'); if (select) { select.innerHTML = ''; select.value = ''; select.disabled = true; }
  const save = $('settings-model-save'); if (save) save.disabled = true;
  const status = $('settings-model-status'); if (status) status.textContent = message;
}
window.addEventListener('tli-session-locked', () => {
  settingsModelLocked = true; settingsModelReady = false; settingsModelEpoch++;
  clearModelSettings(settingsModelSaving ? 'Access changed. The model save is unconfirmed; check the saved selection after unlocking.' : undefined);
  settingsModelSaving = null;
});
window.addEventListener('tli-session-unlocked', () => { settingsModelLocked = false; settingsModelEpoch++; });
window.addEventListener('tli-private-observation-ready', () => {
  if (settingsModelLocked || settingsModelReady) return;
  settingsModelReady = true;
  const panel = $('panel-settings');
  if (panel && !panel.classList.contains('hidden') && !document.hidden) fetchModelSettings();
});
window.addEventListener('pagehide', () => { settingsModelEpoch++; settingsModelReady = false; clearModelSettings(); });

async function fetchModelSettings() {
  const urlSpan  = $("settings-model-url");
  const statusEl = $("settings-model-status");
  const select   = $("settings-model-id");
  const compatEl = $("settings-model-compat");


  if (!select) return;
  if (!settingsModelReady || settingsModelLocked) return;
  const token = {epoch: settingsModelEpoch, read: ++settingsModelRead};
  clearModelSettings('Contacting model server…');

  if (statusEl) statusEl.textContent = "Contacting model server…";

  try {
    const resp = await fetch("/models/available", {cache: 'no-store', signal: AbortSignal.timeout(10000)});
    if (!settingsModelCurrent(token)) return;
    const data = await resp.json().catch(() => null);
    if (!settingsModelCurrent(token)) return;
    if (resp.status === 401 || resp.status === 403) {
      window.dispatchEvent(new CustomEvent('tli-session-locked')); return;
    }
    if (!resp.ok) {
      throw new Error(typeof data?.detail === 'string' ? data.detail : "HTTP " + resp.status);
    }
    if (!Array.isArray(data?.models) || data.models.some(model => !model || typeof model.id !== 'string' || !model.id)) throw Error('Model list unreadable.');
        const compat = data.compat || null;
    if (compatEl && compat) {
      const badge = compat.ok ? "OK" : "DEGRADED";
      const extra = compat.ok
        ? `schema=${compat.schema_ok ? "ok" : "?"} · models=${compat.model_count} · ${compat.latency_ms || "?"}ms`
        : `error=${compat.error || "unknown"}`;
      compatEl.textContent = `Compatibility: ${badge} · ${extra}`;
    }


    // Show LM Studio URL
    if (urlSpan && data.server_url) {
      urlSpan.textContent = data.server_url;
    }

    // Populate dropdown
    select.innerHTML = "";
    const models = data.models || [];
    if (!models.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No models reported by server";
      select.appendChild(opt);
    } else {
      models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        select.appendChild(opt);
      });

      // Pre-select current default
      const current       = data.current || {};
      const currentKey    = current.default_key;
      const currentModels = current.models || {};
      const cfg           = currentModels[currentKey];
      if (cfg && cfg.id) {
        select.value = cfg.id;
      }
    }

    select.disabled = !models.length;
    const save = $('settings-model-save'); if (save) save.disabled = !models.length || !!settingsModelSaving;
    if (statusEl) statusEl.textContent = "Models loaded";
    debugLog("info", "Loaded model list from backend.");
  } catch (err) {
    if (!settingsModelCurrent(token)) return;
    clearModelSettings('Model list unavailable: ' + err.message);
    debugLog("error", "Failed to fetch model list: " + err);
  }
}
let settingsProfileEpoch = 0, settingsProfileRead = 0, settingsProfileMeta = 0;
let settingsProfileReady = true, settingsProfileLocked = false, settingsProfileLoaded = false, settingsProfileSaving = null;
const settingsProfileCurrent = token => settingsProfileReady && !settingsProfileLocked && token.epoch === settingsProfileEpoch && token.read === settingsProfileRead;
function clearProfileSettings(message = 'Unlock TLI and check access to load the host profile.', failed = true) {
  settingsProfileLoaded = false; settingsProfileMeta++;
  const select = $('settings-system-profile'); if (select) { select.value = ''; select.disabled = true; }
  const save = $('settings-system-profile-save'); if (save) save.disabled = true;
  settingsFeedback('settings-system-profile-meta', message, failed);
  const meta = $('settings-system-profile-meta'); if (meta && !failed) meta.dataset.state = 'loading';
}
window.addEventListener('tli-session-locked', () => {
  settingsProfileLocked = true; settingsProfileReady = false; settingsProfileEpoch++;
  clearProfileSettings(settingsProfileSaving ? 'Access changed. The profile save is unconfirmed; refresh the saved profile after unlocking.' : undefined);
  settingsProfileSaving = null;
});
window.addEventListener('tli-session-unlocked', () => { settingsProfileLocked = false; settingsProfileEpoch++; });
window.addEventListener('tli-private-observation-ready', () => {
  if (settingsProfileLocked || settingsProfileReady) return;
  settingsProfileReady = true;
  const panel = $('panel-settings');
  if (panel && !panel.classList.contains('hidden') && !document.hidden) fetchSystemProfileSettings();
});
window.addEventListener('pagehide', () => { settingsProfileEpoch++; settingsProfileReady = false; clearProfileSettings(); });

async function fetchSystemProfileSettings() {
  const select = $("settings-system-profile");
  const meta   = $("settings-system-profile-meta");
  if (!select) return;
  if (!settingsProfileReady || settingsProfileLocked) return;
  const token = {epoch: settingsProfileEpoch, read: ++settingsProfileRead};
  clearProfileSettings('Loading saved host profile…', false);

  try {
    const resp = await fetch("/system/profile", {cache: 'no-store', signal: AbortSignal.timeout(10000)});
    if (!settingsProfileCurrent(token)) return;
    const data = await resp.json().catch(() => null);
    if (!settingsProfileCurrent(token)) return;
    if (resp.status === 401 || resp.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
    if (!resp.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : "HTTP " + resp.status);
    if (typeof data?.current !== 'string' || !data.current || !data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles) || !Object.hasOwn(data.profiles, data.current) || !data.profiles[data.current] || typeof data.profiles[data.current] !== 'object' || Array.isArray(data.profiles[data.current])) throw Error('Saved profile unreadable.');
    select.value = data.current;
    settingsProfileLoaded = true; settingsProfileMeta++;
    select.disabled = false;
    const save = $('settings-system-profile-save'); if (save) save.disabled = !!settingsProfileSaving;

    if (meta && data.profiles && data.current && data.profiles[data.current]) {
      settingsFeedback('settings-system-profile-meta',
        "Profile: " + (data.profiles[data.current].label || data.current) +
        " · Saved on the TLI host. Your chat preferences are unchanged.");
    }

    debugLog("info", "Loaded system profile from backend.");
  } catch (err) {
    if (!settingsProfileCurrent(token)) return;
    clearProfileSettings('Host profile unavailable: ' + err.message + ' Refresh the saved profile before making a change.');
    debugLog("error", "Failed to fetch system profile: " + err);
  }
}
async function fetchHardwareProbe() {
  const meta = $("settings-system-profile-meta");
  if (!meta) return;
  if (!settingsProfileReady || settingsProfileLocked) return;
  const token = {epoch: settingsProfileEpoch, read: settingsProfileRead}, display = settingsProfileMeta;

  try {
    const resp = await fetch("/system/probe", {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000)});
    if (token.epoch !== settingsProfileEpoch || settingsProfileLocked || !settingsProfileReady) return;
    if (resp.status === 401 || resp.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
    if (!settingsProfileCurrent(token) || display !== settingsProfileMeta) return;
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const p = await resp.json();
    if (!settingsProfileCurrent(token) || display !== settingsProfileMeta) return;
    if (!p || !['cpu_cores','cpu_threads'].every(key => Number.isInteger(p[key]) && p[key] >= 0) ||
        typeof p.ram_total_gb !== 'number' || !Number.isFinite(p.ram_total_gb) || p.ram_total_gb < 0 ||
        !['lite','balanced','power'].includes(p.suggested_profile)) throw Error('Hardware observation unreadable.');

    const parts = [
      `${p.cpu_cores}C/${p.cpu_threads}T`,
      `${p.ram_total_gb} GB RAM`,
    ];
    if (p.gpu_vram_gb != null) parts.push(`${p.gpu_vram_gb} GB VRAM`);

    meta.textContent =
      `Hardware: ${parts.join(" · ")} · Suggested profile: ${String(p.suggested_profile).toUpperCase()}`;
  } catch (err) {
    if (!settingsProfileCurrent(token) || display !== settingsProfileMeta) return;
    settingsFeedback('settings-system-profile-meta', 'Hardware observation unavailable. The saved profile selection is unchanged.', true);
    debugLog("warn", "Hardware probe unavailable.");
  }
}

// Load Settings panel controls from localStorage
function loadSettingsPanel() {
  const s = readSettings() || {};

  const brainEl    = $("settings-brain");
  const modeEl     = $("settings-mode");
  const teachingBtn = $("settings-teaching");
  const tempEl     = $("settings-temp");
  const maxEl      = $("settings-max");
  const themeEl    = $("settings-theme");

  if (brainEl) {
    const savedBrain = s.defaultBrain || "auto";
    if (brainEl.options && !Array.from(brainEl.options).some(option => option.value === savedBrain)) {
      const savedOption = document.createElement("option");
      savedOption.value = savedBrain;
      savedOption.textContent = "Saved model hint: " + savedBrain;
      brainEl.appendChild(savedOption);
    }
    brainEl.value = savedBrain;
  }
  if (modeEl)   modeEl.value   = s.defaultMode  || "default";

  if (teachingBtn) {
    if (s.teachingOn) teachingBtn.classList.add("on");
    else teachingBtn.classList.remove("on");
    teachingBtn.setAttribute("aria-pressed", String(!!s.teachingOn));
  }

  if (tempEl)   tempEl.value   = s.defaultTemp  || "0.7";
  if (maxEl)    maxEl.value    = s.defaultMax   || "768";
  if (themeEl) themeEl.value = s.appearanceMode === "system"
    ? (document.documentElement.getAttribute("data-theme") || DEFAULT_THEME)
    : (window.TLIThemes?.resolve(s.defaultTheme).id || s.defaultTheme || DEFAULT_THEME);
  const appearanceEl = $("settings-appearance-mode");
  if (appearanceEl) appearanceEl.value = s.appearanceMode === "system" ? "system" : "theme";

  // Ask backend which models exist & which one is current
  fetchModelSettings();
  fetchSystemProfileSettings();
}
fetchSystemProfileSettings();
fetchHardwareProbe();

function setupSettingsPanel() {
  if (setupSettingsPanel._done) return;
  setupSettingsPanel._done = true;
  const teachingBtn = $("settings-teaching");
  const saveBtn     = $("settings-save");
  const applyBtn    = $("settings-apply");
  const clearBtn    = $("settings-clear-history");
  const exportBtn   = $("settings-export");
  const importInput = $("settings-import");
  const refreshModelsBtn = $("settings-model-refresh");
  const saveModelBtn     = $("settings-model-save");
  const saveProfileBtn = $("settings-system-profile-save");
  const refreshProfileBtn = $('settings-system-profile-refresh');
  if (refreshProfileBtn) refreshProfileBtn.addEventListener('click', () => {
    if (settingsProfileLocked) return;
    if (!settingsProfileReady) { window.EventInterpreter?.retry?.(); return; }
    fetchSystemProfileSettings();
  });
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener("click", async () => {
      const select = $("settings-system-profile");
      if (!select || saveProfileBtn.disabled || !settingsProfileLoaded || !settingsProfileReady || settingsProfileLocked || settingsProfileSaving) return;
      const profile = select.value;
      if (!profile) return;
      const token = {epoch: settingsProfileEpoch, read: settingsProfileRead};
      saveProfileBtn.disabled = true; settingsProfileSaving = token; settingsProfileMeta++;

      try {
        const resp = await fetch("/system/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile }),
        });
        if (!settingsProfileCurrent(token)) return;
        const data = await resp.json().catch(() => null);
        if (!settingsProfileCurrent(token)) return;
        if (resp.status === 401 || resp.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
        if (!resp.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : "HTTP " + resp.status);
        if (data?.ok !== true || data.current !== profile) throw new Error("The host did not confirm the selected profile.");
        showToast("System profile saved: " + data.current);
        await fetchSystemProfileSettings();
      } catch (err) {
        if (!settingsProfileCurrent(token)) return;
        clearProfileSettings('Profile save unconfirmed: ' + err.message + ' Refresh the saved profile before trying again. No retry was sent.');
        showToast("Profile save unconfirmed. Refresh the saved profile before trying again.", "error");
        debugLog("error", "Failed to save system profile: " + err);
      } finally {
        if (settingsProfileSaving === token) {
          settingsProfileSaving = null;
          if (settingsProfileReady && !settingsProfileLocked && token.epoch === settingsProfileEpoch) saveProfileBtn.disabled = !settingsProfileLoaded;
        }
      }
    });
  }


  // Teaching toggle
  if (teachingBtn) {
    teachingBtn.addEventListener("click", () => {
      teachingBtn.classList.toggle("on");
      teachingBtn.setAttribute("aria-pressed", String(teachingBtn.classList.contains("on")));
    });
  }

  // Theme is a browser preference and saves independently from chat defaults.
  const themeSelectEl = $("settings-theme");
  const appearanceSelectEl = $("settings-appearance-mode");
  if (themeSelectEl) {
    themeSelectEl.addEventListener("change", () => {
      const previousTheme = document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
      try {
        // One atomic browser write keeps mode and the explicit palette in sync.
        // System appearance never changes defaultTheme when the OS changes.
        const saved = { ...readSettings(), defaultTheme: themeSelectEl.value, appearanceMode: "theme" };
        writeSettings(saved);
        applyTheme(themeSelectEl.value);
        if (appearanceSelectEl) appearanceSelectEl.value = "theme";
        settingsFeedback("settings-theme-status", "Theme saved in this browser.");
      } catch (error) {
        themeSelectEl.value = previousTheme;
        settingsFeedback("settings-theme-status", "Theme could not be saved. Check browser storage and try again.", true);
        showToast("Could not save theme: " + error.message, "error");
      }
    });
  }
  if (appearanceSelectEl) {
    appearanceSelectEl.value = readSettings().appearanceMode === "system" ? "system" : "theme";
    appearanceSelectEl.disabled = !window.TLIThemes?.applyPreference;
    if (appearanceSelectEl.disabled) settingsFeedback("settings-theme-status", "System appearance is unavailable. You can still choose a color theme.");
    appearanceSelectEl.addEventListener("change", () => {
      if (appearanceSelectEl.disabled) return;
      const previous = readSettings();
      const next = { ...previous, appearanceMode: appearanceSelectEl.value === "system" ? "system" : "theme" };
      try {
        writeSettings(next);
        if (window.TLIThemes?.applyPreference) window.TLIThemes.applyPreference(next);
        else applyTheme(next.defaultTheme || DEFAULT_THEME);
        settingsFeedback("settings-theme-status", next.appearanceMode === "system"
          ? "Following your device appearance. Your color theme is remembered."
          : "Your selected color theme is restored.");
      } catch (error) {
        appearanceSelectEl.value = previous.appearanceMode === "system" ? "system" : "theme";
        settingsFeedback("settings-theme-status", "Appearance could not be saved. Check browser storage and try again.", true);
        showToast("Could not save appearance: " + error.message, "error");
      }
    });
  }

  // Refresh model list
  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener("click", () => {
      if (settingsModelLocked) return;
      if (!settingsModelReady) { window.EventInterpreter?.retry?.(); return; }
      fetchModelSettings();
    });
  }

  // Save default model on backend
  if (saveModelBtn) {
    saveModelBtn.addEventListener("click", async () => {
      if (saveModelBtn.disabled || settingsModelSaving || !settingsModelReady || settingsModelLocked) return;
      const token = {epoch: settingsModelEpoch, read: settingsModelRead};
      const select = $("settings-model-id");
      if (!select || !select.value) {
        showToast("No model selected.");
        return;
      }

      const modelId = select.value;
      const label =
        (select.selectedOptions && select.selectedOptions[0]
          ? select.selectedOptions[0].textContent
          : modelId) || modelId;

      saveModelBtn.disabled = true; settingsModelSaving = token;
      try {
        const resp = await fetch("/models/set-default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id: modelId, label }),
        });
        if (!settingsModelCurrent(token)) return;
        const data = await resp.json().catch(() => null);
        if (!settingsModelCurrent(token)) return;
        if (resp.status === 401 || resp.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
        if (!resp.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : "HTTP " + resp.status);
        if (data?.ok !== true || data.model?.id !== modelId) throw new Error("The host did not confirm the selected model.");
        showToast(
          "Saved default model: " +
          (data.model && data.model.label ? data.model.label : label)
        );
        debugLog("info", "Updated default model: " + JSON.stringify(data));
      } catch (err) {
        if (!settingsModelCurrent(token)) return;
        clearModelSettings('Model save unconfirmed: ' + err.message + ' Refresh models before trying again. No retry was sent.');
        showToast("Model save unconfirmed. Refresh models before trying again.", "error");
        debugLog("error", "Failed to save default model: " + err);
      } finally {
        if (settingsModelSaving === token) {
          settingsModelSaving = null;
          if (settingsModelReady && !settingsModelLocked && token.epoch === settingsModelEpoch) {
            saveModelBtn.disabled = !!$('settings-model-id')?.disabled;
          }
        }
      }
    });
  }

  // Save only the fields owned by Chat preferences. Search Assist and custom
  // model metadata share this object and must survive an unrelated save.
  function saveChatPreferences() {
    try {
      const previous = readSettings() || {};
      const brainEl    = $("settings-brain");
      const teachingEl = $("settings-teaching");
      const tempEl     = $("settings-temp");
      const maxEl      = $("settings-max");

      const s = {
        ...previous,
        defaultBrain: brainEl?.value || previous.defaultBrain || "auto",
        teachingOn:   teachingEl ? teachingEl.classList.contains("on") : false,
        defaultTemp:  tempEl?.value || previous.defaultTemp || "0.7",
        defaultMax:   maxEl?.value || previous.defaultMax || "768",
      };

      writeSettings(s);
      applySettingsToUI(s);
      settingsFeedback("settings-chat-status", "Chat preferences saved in this browser and applied to new messages.");
      showToast("Chat preferences saved in this browser.", "success");
      debugLog("info", "Chat preferences saved and applied.");
    } catch (error) {
      settingsFeedback("settings-chat-status", "Chat preferences could not be saved. Try again after checking browser storage.", true);
      showToast("Could not save chat preferences: " + error.message, "error");
    }
  }
  if (saveBtn) saveBtn.addEventListener("click", saveChatPreferences);
  // Retain the legacy control ID as a compatibility alias, with one save path.
  if (applyBtn) applyBtn.addEventListener("click", saveChatPreferences);


  // Clear history (local only)
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!confirm("Clear legacy prompts and conversation copies from this browser? Saved conversations and Notebook notes on the TLI host are unchanged.")) return;
      try {
        localStorage.setItem(previousPromptsKey, JSON.stringify([]));
        localStorage.setItem(settingsLegacyConversationsKey, JSON.stringify([]));
        loadPreviousPrompts();
        showToast("Legacy browser history cleared. Saved conversations are unchanged.", "success");
        debugLog("info", "Legacy browser history cleared.");
      } catch (error) {
        showToast("Could not finish clearing legacy browser history: " + error.message, "error");
      }
    });
  }

  // Export settings + history
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      try {
        const payload = {
          tli_settings: readSettings(),
          tli_previous_prompts:
            JSON.parse(localStorage.getItem(previousPromptsKey) || "[]"),
          tli_previous_conversations:
            JSON.parse(localStorage.getItem(settingsLegacyConversationsKey) || "[]"),
          exported_at: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "tli_export.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        debugLog("info", "Settings/history exported to tli_export.json.");
      } catch (error) {
        showToast("Could not export browser preferences and legacy history: " + error.message, "error");
      }
    });
  }

  // Import settings + history
  if (importInput) {
    importInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const j = JSON.parse(reader.result);
          if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("Choose a TLI browser preferences export.");
          const fields = ["tli_settings", "tli_previous_prompts", "tli_previous_conversations"];
          if (!fields.some(key => Object.prototype.hasOwnProperty.call(j, key))) throw new Error("This file does not contain TLI browser preferences or legacy history.");
          if (Object.prototype.hasOwnProperty.call(j, "tli_settings") && (!j.tli_settings || typeof j.tli_settings !== "object" || Array.isArray(j.tli_settings))) throw new Error("Browser preferences must be a settings object.");
          for (const key of fields.slice(1)) {
            if (Object.prototype.hasOwnProperty.call(j, key) && !Array.isArray(j[key])) throw new Error("Legacy history must contain lists.");
          }
          if (!confirm("Replace the browser preferences and legacy history included in this file? Saved conversations and Notebook notes on the TLI host are unchanged.")) return;
          if (j.tli_settings) writeSettings(j.tli_settings);
          if (Array.isArray(j.tli_previous_prompts))
            localStorage.setItem(previousPromptsKey, JSON.stringify(j.tli_previous_prompts));
          if (Array.isArray(j.tli_previous_conversations))
            localStorage.setItem(settingsLegacyConversationsKey, JSON.stringify(j.tli_previous_conversations));

          loadSettingsPanel();
          applySettingsToUI(readSettings());
          loadPreviousPrompts();
          showToast("Browser preferences and included legacy history imported.", "success");
          debugLog("info", "Settings/history import complete.");
        } catch (err) {
          showToast("Import failed: " + err.message, "error");
          debugLog("error", "Settings/history import failed: " + err.message);
        } finally {
          e.target.value = "";
        }
      };
      reader.readAsText(file);
    });
  }

  // ── Node Identity ──────────────────────────────────────────
  const nodeIdentitySaveBtn = $("settings-node-identity-save");
  let nodeEpoch=0, nodeLocked=false, nodeReady=true, nodeLoaded=false, nodeRequest=null, savedNodeId=null, savedNodeName=null;
  const nodeCurrent = request => nodeRequest===request && request.epoch===nodeEpoch && !nodeLocked && nodeReady;
  function nodeControls() {
    for (const id of ['settings-node-name','settings-node-role']) { const el=$(id); if(el)el.disabled=nodeLocked||!nodeReady||!nodeLoaded||!!nodeRequest; }
    if(nodeIdentitySaveBtn) { nodeIdentitySaveBtn.disabled=nodeLocked||!nodeReady||!!nodeRequest; nodeIdentitySaveBtn.textContent=nodeLoaded?'Save name & role':'Check saved name & role'; }
  }
  function clearNodeIdentity() {
    nodeLoaded=false; savedNodeId=null; savedNodeName=null;
    const name=$('settings-node-name'),role=$('settings-node-role'),id=$('settings-node-id');
    if(name)name.value='';if(role)role.value='';if(id)id.textContent='—';nodeControls();
  }
  function validNodeIdentity(data) {
    return data && typeof data.node_id==='string' && !!data.node_id.trim() &&
      typeof data.node_name==='string' && !!data.node_name.trim() && Array.from(data.node_name).length<=4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(data.node_name) &&
      ['standalone','member','host'].includes(data.role);
  }
  async function _loadNodeIdentity() {
    if(nodeLocked||!nodeReady||nodeRequest||!nodeIdentitySaveBtn)return;
    const request={epoch:nodeEpoch};nodeRequest=request;clearNodeIdentity();
    try {
      const r = await fetch("/status", { cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000) });
      if(!nodeCurrent(request))return;
      if(r.status===401||r.status===403){window.dispatchEvent(new CustomEvent('tli-session-locked'));return;}
      const body = await r.json().catch(()=>null);
      if(!nodeCurrent(request))return;
      const d={node_id:body?.device_id,node_name:body?.device_nickname,role:body?.node_role};
      if(!r.ok||!validNodeIdentity(d))throw Error(typeof body?.detail==='string'?body.detail:'The saved name and role could not be read.');
      const nameEl = $("settings-node-name");
      const roleEl = $("settings-node-role");
      const nodeIdEl = $("settings-node-id");
      if (nameEl) nameEl.value = d.node_name;
      if (roleEl) roleEl.value = d.role;
      if (nodeIdEl) nodeIdEl.textContent = d.node_id;
      savedNodeId=d.node_id;savedNodeName=d.node_name;nodeLoaded=true;
    } catch(error) { if(nodeCurrent(request))showToast('Saved computer identity unavailable. '+error.message,'error'); }
    finally { if(nodeRequest===request){nodeRequest=null;nodeControls();} }
  }

  if (nodeIdentitySaveBtn) {
    nodeIdentitySaveBtn.addEventListener("click", async () => {
      if (nodeIdentitySaveBtn.disabled||nodeRequest||nodeLocked||!nodeReady) return;
      if (!nodeLoaded) return _loadNodeIdentity();
      const nameEl = $("settings-node-name");
      const roleEl = $("settings-node-role");
      const rawName = nameEl ? nameEl.value : "", changedName=rawName!==savedNodeName;
      const name = changedName ? rawName.trim() : savedNodeName;
      const role = roleEl ? roleEl.value : "standalone";
      if (!name||(changedName&&(Array.from(name).length>64||/[\u0000-\u001f\u007f-\u009f]/.test(rawName)))||!['standalone','member','host'].includes(role)) { showToast("Choose a name of 1–64 characters without control characters and a supported role.", "error"); return; }
      const request={epoch:nodeEpoch,id:savedNodeId};nodeRequest=request;nodeControls();
      try {
        const r = await fetch("/mesh/node/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(changedName?{node_name:name}:{}), role }),credentials:'same-origin',signal:AbortSignal.timeout(10000),
        });
        if(!nodeCurrent(request))return;
        if(r.status===401||r.status===403){window.dispatchEvent(new CustomEvent('tli-session-locked'));return;}
        const data = await r.json().catch(()=>null);
        if(!nodeCurrent(request))return;
        if(!r.ok)throw Error(typeof data?.detail==='string'?data.detail:'The host did not confirm the save.');
        if (data?.ok !== true || !validNodeIdentity(data) || data.node_id!==request.id || data.node_name!==name || data.role!==role) throw new Error("The host did not confirm the saved name and role.");
        savedNodeName=data.node_name;
        const identity=window.TLIUI?.hostIdentity||window.TLIHostIdentity;
        identity?.observe?.({id:data.node_id,name:data.node_name,source:'host-rename',generation:identity.get?.().generation});
        showToast("Computer name and network role saved.", "success");
      } catch (e) {
        if(!nodeCurrent(request))return;
        nodeLoaded=false;
        showToast("The name and role change is not confirmed; it may have completed. Check the saved name and role before another save. " + e.message, "error");
      } finally {
        if(nodeRequest===request){nodeRequest=null;nodeControls();}
      }
    });
  }

  for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event,()=>{
    nodeEpoch++;nodeLocked=true;nodeReady=false;nodeRequest=null;clearNodeIdentity();
  });
  window.addEventListener('tli-session-unlocked',()=>{nodeEpoch++;nodeLocked=false;nodeControls();});
  window.addEventListener('tli-private-observation-ready',()=>{
    if(nodeLocked)return;const recovering=!nodeReady;nodeReady=true;nodeControls();
    const panel=$('panel-settings');if(recovering&&panel&&!panel.hidden&&!panel.classList.contains('hidden')&&!document.hidden)_loadNodeIdentity();
  });
  window.addEventListener('pagehide',()=>{nodeEpoch++;nodeLocked=true;nodeReady=false;nodeRequest=null;clearNodeIdentity();});

  _loadNodeIdentity();

  // ── Cryptographic Identity card ──────────────────────────
  async function _loadCryptoIdentity() {
    try {
      const r = await fetch("/identity", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const fpEl  = $("identity-fingerprint");
      const pkEl  = $("identity-pubkey");
      const caEl  = $("identity-created-at");
      if (fpEl) fpEl.textContent = d.fingerprint || "—";
      if (pkEl) pkEl.textContent = d.public_key   || "—";
      if (caEl && d.created_at) caEl.textContent = "Identity created: " + d.created_at.replace("T", " ").replace("Z", " UTC");
    } catch {}
  }

  const copyFpBtn = $("identity-copy-fp");
  const copyPkBtn = $("identity-copy-pk");
  if (copyFpBtn) {
    copyFpBtn.addEventListener("click", () => {
      const fp = ($("identity-fingerprint") || {}).textContent;
      if (fp && fp !== "—") navigator.clipboard.writeText(fp).then(() => showToast("Fingerprint copied"));
    });
  }
  if (copyPkBtn) {
    copyPkBtn.addEventListener("click", () => {
      const pk = ($("identity-pubkey") || {}).textContent;
      if (pk && pk !== "—") navigator.clipboard.writeText(pk).then(() => showToast("Public key copied"));
    });
  }

  _loadCryptoIdentity();

  // ── Mesh AI Routing settings ──────────────────────────────
  async function _loadMeshAIPreference() {
    try {
      const r = await fetch("/api/ai/mesh/preference", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const tog = $("settings-prefer-mesh-ai");
      const thresh = $("settings-mesh-cpu-threshold");
      if (tog) tog.checked = !!d.prefer_mesh_ai;
      if (thresh) thresh.value = d.mesh_ai_cpu_threshold ?? 80;
    } catch {}
  }

  const meshAISaveBtn = $("settings-mesh-ai-save");
  if (meshAISaveBtn) {
    meshAISaveBtn.addEventListener("click", async () => {
      if (meshAISaveBtn.disabled) return;
      const tog = $("settings-prefer-mesh-ai");
      const thresh = $("settings-mesh-cpu-threshold");
      const statusEl = $("settings-mesh-ai-status");
      const prefer = tog ? tog.checked : false;
      const cpu = thresh ? Number(thresh.value) : 80;
      if (!Number.isInteger(cpu) || cpu < 40 || cpu > 100) {
        showToast("Choose a CPU threshold from 40 to 100 percent.", "error");
        return;
      }
      meshAISaveBtn.disabled = true;
      try {
        const r = await fetch("/api/ai/mesh/preference", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefer_mesh_ai: prefer, mesh_ai_cpu_threshold: cpu }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        if (d.ok !== true) throw new Error("The host did not confirm the save.");
        if (statusEl) statusEl.textContent = d.prefer_mesh_ai
          ? "Saved: prefer another available TLI computer for AI requests. Browser routing rules still apply."
          : `Saved: prefer this host; another available TLI computer may be used when AI is unavailable, CPU reaches ${d.mesh_ai_cpu_threshold}%, or RAM pressure is high. Browser routing rules still apply.`;
        showToast("Mesh AI settings saved.", "success");
      } catch (e) {
        showToast("Failed to save mesh AI settings: " + e.message, "error");
      } finally {
        meshAISaveBtn.disabled = false;
      }
    });
  }

  _loadMeshAIPreference();

  // ── PIN Lock settings ─────────────────────────────────────
  async function _refreshPinUI() {
    const desc      = $("settings-pin-status-desc");
    const label     = $("settings-pin-action-label");
    const curInput  = $("settings-pin-current");
    const saveBtn   = $("settings-pin-save");
    const removeBtn = $("settings-pin-remove");
    const callout   = $("settings-pin-callout");
    try {
      const r = await fetch("/system/pin/status", { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok || typeof d?.enabled !== 'boolean') throw new Error(typeof d?.detail === 'string' ? d.detail : 'TLI could not confirm the saved PIN status. Recheck after reconnecting to the host.');
      if (saveBtn) saveBtn.disabled = false;
      if (removeBtn) removeBtn.disabled = false;
      if (d.enabled) {
        if (desc)      desc.textContent = "PIN is set. Changing requires your current PIN.";
        if (label)     label.textContent = "Change PIN";
        if (curInput)  curInput.style.display = "";
        if (saveBtn)   saveBtn.textContent = "Change PIN";
        if (removeBtn) removeBtn.style.display = "";
        if (callout)   callout.style.display = "none";
        // Clear permanent nudge dismissal so it can reappear if PIN is later removed
        try { localStorage.removeItem("tli_pin_nudge_v1"); } catch {}
      } else {
        if (desc)      desc.textContent = "No PIN set. Protected private controls are limited to this TLI computer.";
        if (label)     label.textContent = "Set PIN";
        if (curInput)  curInput.style.display = "none";
        if (saveBtn)   saveBtn.textContent = "Set PIN";
        if (removeBtn) removeBtn.style.display = "none";
        if (callout)   callout.style.display = "";
      }
    } catch (error) {
      const message = 'PIN status unavailable. ' + (error.message || 'Reconnect to TLI and recheck.');
      if (desc) desc.textContent = message;
      if (label) label.textContent = 'PIN unavailable';
      if (saveBtn) saveBtn.disabled = true;
      if (removeBtn) removeBtn.disabled = true;
      if (callout) callout.style.display = 'none';
      window.TLIPinLock?.showRecovery?.(message);
    }
  }

  const pinSaveBtn   = $("settings-pin-save");
  const pinRemoveBtn = $("settings-pin-remove");
  let pinMutationPending = false;

  function _clearPinInputs() {
    [$("settings-pin-current"), $("settings-pin-new"), $("settings-pin-confirm")]
      .forEach(el => { if (el) el.value = ""; });
  }

  function _requirePinAccessCheck(message) {
    try { sessionStorage.removeItem("tli_session_unlocked"); } catch {}
    // Invalidate an older verification as well as the visible unlocked hint.
    if (window.TLIPinLock?.showRecovery) window.TLIPinLock.showRecovery(message);
    else window.dispatchEvent(new CustomEvent('tli-session-locked'));
  }

  if (pinSaveBtn) {
    pinSaveBtn.addEventListener("click", async () => {
      if (pinMutationPending) return;
      const cur     = ($("settings-pin-current")?.value || "").trim();
      const newPin  = ($("settings-pin-new")?.value     || "").trim();
      const confirm = ($("settings-pin-confirm")?.value || "").trim();
      if (!newPin) { showToast("Enter a new PIN.", "error"); return; }
      if (newPin.length < 4) { showToast("PIN must be at least 4 characters.", "error"); return; }
      if (newPin !== confirm) { showToast("PINs do not match.", "error"); return; }

      pinMutationPending = true;
      pinSaveBtn.disabled = true;
      if (pinRemoveBtn) pinRemoveBtn.disabled = true;
      _clearPinInputs();
      try {
        const body = { pin: newPin };
        if (cur) body.current_pin = cur;
        const r = await fetch("/system/pin/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await r.json().catch(() => null);
        if (!r.ok && r.status < 500) {
          showToast("PIN was not saved: " + (typeof result?.detail === 'string' ? result.detail : "HTTP " + r.status), "error");
          return;
        }
        if (!r.ok || result?.ok !== true || result.locked !== true) throw new Error('Unconfirmed PIN change');
        _requirePinAccessCheck("PIN saved. Enter your new PIN to unlock TLI.");
        showToast("PIN saved. Enter your new PIN to unlock TLI.", "success");
        await _refreshPinUI();
      } catch {
        const message = "TLI could not confirm whether the PIN was saved. Recheck access and verify your PIN before trying another change.";
        _requirePinAccessCheck(message);
        showToast(message, "error");
      } finally {
        pinMutationPending = false;
        pinSaveBtn.disabled = false;
        if (pinRemoveBtn) pinRemoveBtn.disabled = false;
      }
    });
  }

  if (pinRemoveBtn) {
    pinRemoveBtn.addEventListener("click", async () => {
      if (pinMutationPending) return;
      const cur = ($("settings-pin-current")?.value || "").trim();
      if (!cur) { showToast("Enter your current PIN to remove it.", "error"); return; }
      pinMutationPending = true;
      pinRemoveBtn.disabled = true;
      if (pinSaveBtn) pinSaveBtn.disabled = true;
      _clearPinInputs();
      try {
        const r = await fetch("/system/pin/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: cur }),
        });
        const result = await r.json().catch(() => null);
        if (!r.ok && r.status < 500) {
          showToast("PIN was not removed: " + (typeof result?.detail === 'string' ? result.detail : "HTTP " + r.status), "error");
          return;
        }
        if (!r.ok || result?.ok !== true) throw new Error('Unconfirmed PIN removal');
        _requirePinAccessCheck("PIN removed. Recheck access status to continue. Protected private controls are limited to this TLI computer.");
        showToast("PIN removed. Protected private controls are limited to this TLI computer.", "success");
        await _refreshPinUI();
        const lockBtn = document.getElementById("tli-lock-btn");
        if (lockBtn) lockBtn.hidden = true;
      } catch {
        const message = "TLI could not confirm whether the PIN was removed. Recheck access before trying another change.";
        _requirePinAccessCheck(message);
        showToast(message, "error");
      } finally {
        pinMutationPending = false;
        pinRemoveBtn.disabled = false;
        if (pinSaveBtn) pinSaveBtn.disabled = false;
      }
    });
  }

  _refreshPinUI();
}
async function handleLocalDiagnosticsClick() {
  const panel = $("mesh-node-diagnostics");
  if (!panel) return;

  panel.textContent = "Loading diagnostics…";

  try {
    const res = await fetch("/agent/system_summary");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const summary = await res.json();
    renderLocalDiagnostics(panel, summary);
  } catch (err) {
    console.error(err);
    panel.textContent = "Diagnostics failed: " + err.message;
  }
}

function renderLocalDiagnostics(panel, summary) {
  const { cpu, ram, disk, uptime } = summary;

  panel.innerHTML = `
    <div class="diag-row"><strong>CPU:</strong> ${cpu.percent.toFixed(1)}%</div>
    <div class="diag-row"><strong>RAM:</strong> ${ram.percent_used.toFixed(1)}%
      (${ram.used_human} / ${ram.total_human})
    </div>
    <div class="diag-row"><strong>Disk:</strong> ${disk.overall_percent_used.toFixed(1)}%</div>
    <div class="diag-row"><strong>Uptime:</strong> ${uptime.human_readable}</div>
  `;
}
