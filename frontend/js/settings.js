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

async function fetchModelSettings() {
  const urlSpan  = $("settings-model-url");
  const statusEl = $("settings-model-status");
  const select   = $("settings-model-id");
  const compatEl = $("settings-model-compat");


  if (!select) return;

  if (statusEl) statusEl.textContent = "Contacting model server…";

  try {
    const resp = await fetch("/models/available");
    if (!resp.ok) {
      throw new Error("HTTP " + resp.status);
    }
    const data = await resp.json();
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

    if (statusEl) statusEl.textContent = "Models loaded";
    debugLog("info", "Loaded model list from backend.");
  } catch (err) {
    if (statusEl) statusEl.textContent = "Could not reach model server";
    debugLog("error", "Failed to fetch model list: " + err);
  }
}
async function fetchSystemProfileSettings() {
  const select = $("settings-system-profile");
  const meta   = $("settings-system-profile-meta");
  if (!select) return;

  try {
    const resp = await fetch("/system/profile");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();

    if (data && data.current) {
      select.value = data.current;
    }

    if (meta && data.profiles && data.current && data.profiles[data.current]) {
      meta.textContent =
        "Profile: " + (data.profiles[data.current].label || data.current) +
        " · Saved on the TLI host. Your chat preferences are unchanged.";
    }

    debugLog("info", "Loaded system profile from backend.");
  } catch (err) {
    if (meta) meta.textContent = "Could not load system profile (backend unreachable).";
    debugLog("error", "Failed to fetch system profile: " + err);
  }
}
async function fetchHardwareProbe() {
  const meta = $("settings-system-profile-meta");
  if (!meta) return;

  try {
    const resp = await fetch("/system/probe");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const p = await resp.json();

    const parts = [
      `${p.cpu_cores}C/${p.cpu_threads}T`,
      `${p.ram_total_gb} GB RAM`,
    ];
    if (p.gpu_vram_gb != null) parts.push(`${p.gpu_vram_gb} GB VRAM`);

    meta.textContent =
      `Hardware: ${parts.join(" · ")} · Suggested profile: ${String(p.suggested_profile).toUpperCase()}`;
  } catch (err) {
    // keep current text if probe fails; do not break Settings
    debugLog("warn", "Hardware probe failed: " + err);
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
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener("click", async () => {
      const select = $("settings-system-profile");
      if (!select || saveProfileBtn.disabled) return;
      saveProfileBtn.disabled = true;

      try {
        const resp = await fetch("/system/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: select.value }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        if (data.ok !== true) throw new Error("The host did not confirm the save.");
        showToast("System profile saved: " + (data.current || select.value));
        fetchSystemProfileSettings();
      } catch (err) {
        showToast("Could not save system profile: " + err, "error");
        debugLog("error", "Failed to save system profile: " + err);
      } finally {
        saveProfileBtn.disabled = false;
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
      fetchModelSettings();
    });
  }

  // Save default model on backend
  if (saveModelBtn) {
    saveModelBtn.addEventListener("click", async () => {
      if (saveModelBtn.disabled) return;
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

      saveModelBtn.disabled = true;
      try {
        const resp = await fetch("/models/set-default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id: modelId, label }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        if (data.ok !== true) throw new Error("The host did not confirm the save.");
        showToast(
          "Saved default model: " +
          (data.model && data.model.label ? data.model.label : label)
        );
        debugLog("info", "Updated default model: " + JSON.stringify(data));
      } catch (err) {
        showToast("Could not save model setting: " + err, "error");
        debugLog("error", "Failed to save default model: " + err);
      } finally {
        saveModelBtn.disabled = false;
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
  async function _loadNodeIdentity() {
    try {
      const r = await fetch("/mesh/node", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const nameEl = $("settings-node-name");
      const roleEl = $("settings-node-role");
      const nodeIdEl = $("settings-node-id");
      if (nameEl) nameEl.value = d.display_name || d.node_name || "";
      if (roleEl) roleEl.value = d.role || "standalone";
      if (nodeIdEl) nodeIdEl.textContent = d.node_id || "—";
    } catch {}
  }

  const nodeIdentitySaveBtn = $("settings-node-identity-save");
  if (nodeIdentitySaveBtn) {
    nodeIdentitySaveBtn.addEventListener("click", async () => {
      if (nodeIdentitySaveBtn.disabled) return;
      const nameEl = $("settings-node-name");
      const roleEl = $("settings-node-role");
      const name = (nameEl ? nameEl.value : "").trim();
      const role = roleEl ? roleEl.value : "standalone";
      if (!name) { showToast("Node name cannot be empty.", "error"); return; }
      nodeIdentitySaveBtn.disabled = true;
      try {
        const r = await fetch("/mesh/node/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_name: name, role }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        if (data.ok !== true) throw new Error("The host did not confirm the save.");
        showToast("Computer name and network role saved.", "success");
      } catch (e) {
        showToast("Failed to save identity: " + e.message, "error");
      } finally {
        nodeIdentitySaveBtn.disabled = false;
      }
    });
  }

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
        if (desc)      desc.textContent = "No PIN set — anyone on your LAN can access TLI.";
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

  if (pinSaveBtn) {
    pinSaveBtn.addEventListener("click", async () => {
      const cur     = ($("settings-pin-current")?.value || "").trim();
      const newPin  = ($("settings-pin-new")?.value     || "").trim();
      const confirm = ($("settings-pin-confirm")?.value || "").trim();
      if (!newPin) { showToast("Enter a new PIN.", "error"); return; }
      if (newPin.length < 4) { showToast("PIN must be at least 4 characters.", "error"); return; }
      if (newPin !== confirm) { showToast("PINs do not match.", "error"); return; }

      pinSaveBtn.disabled = true;
      try {
        const body = { pin: newPin };
        if (cur) body.current_pin = cur;
        const r = await fetch("/system/pin/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || "HTTP " + r.status);
        }
        // Mark session as unlocked since we just authenticated
        try { sessionStorage.setItem("tli_session_unlocked", "1"); } catch {}
        showToast("PIN saved. TLI is now locked until you unlock it.", "success");
        [$("settings-pin-current"), $("settings-pin-new"), $("settings-pin-confirm")]
          .forEach(el => { if (el) el.value = ""; });
        await _refreshPinUI();
        if (window.TLIPinLock) window.TLIPinLock.checkAndLock();
      } catch (e) {
        showToast("Failed to save PIN: " + e.message, "error");
      } finally {
        pinSaveBtn.disabled = false;
      }
    });
  }

  if (pinRemoveBtn) {
    pinRemoveBtn.addEventListener("click", async () => {
      const cur = ($("settings-pin-current")?.value || "").trim();
      if (!cur) { showToast("Enter your current PIN to remove it.", "error"); return; }
      pinRemoveBtn.disabled = true;
      try {
        const r = await fetch("/system/pin/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: cur }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || "HTTP " + r.status);
        }
        try { sessionStorage.removeItem("tli_session_unlocked"); } catch {}
        showToast("PIN removed. TLI is now open on your LAN.", "success");
        if ($("settings-pin-current")) $("settings-pin-current").value = "";
        await _refreshPinUI();
        const lockBtn = document.getElementById("tli-lock-btn");
        if (lockBtn) lockBtn.hidden = true;
      } catch (e) {
        showToast("Failed to remove PIN: " + e.message, "error");
      } finally {
        pinRemoveBtn.disabled = false;
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
