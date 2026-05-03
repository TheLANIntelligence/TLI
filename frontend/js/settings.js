// ---------- settings panel (local only) ----------
const settingsKey = "tli_settings";
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

  $("temperature-input").value = s.defaultTemp || "0.7";
  $("max-tokens-input").value  = s.defaultMax  || "768";

  // Apply theme to <html>
  const theme = s.defaultTheme || DEFAULT_THEME;
  applyTheme(theme);

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

    // Apply suggested UI defaults (safe: only touches Settings controls)
    const ui = data.ui_defaults || {};
    const tempEl = $("settings-temp");
    const maxEl  = $("settings-max");
    if (tempEl && ui.temp) tempEl.value = ui.temp;
    if (maxEl && ui.max_tokens) maxEl.value = ui.max_tokens;

    if (meta && data.profiles && data.current && data.profiles[data.current]) {
      meta.textContent =
        "Profile: " + (data.profiles[data.current].label || data.current) +
        " · Suggested defaults applied in this Settings view.";
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

  if (brainEl)  brainEl.value  = s.defaultBrain || "auto";
  if (modeEl)   modeEl.value   = s.defaultMode  || "default";

  if (teachingBtn) {
    if (s.teachingOn) teachingBtn.classList.add("on");
    else teachingBtn.classList.remove("on");
  }

  if (tempEl)   tempEl.value   = s.defaultTemp  || "0.7";
  if (maxEl)    maxEl.value    = s.defaultMax   || "768";
  if (themeEl)  themeEl.value  = s.defaultTheme || DEFAULT_THEME;

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
      if (!select) return;

      try {
        const resp = await fetch("/system/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: select.value }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        showToast("System profile saved: " + (data.current || select.value));
        fetchSystemProfileSettings(); // refresh meta + defaults
      } catch (err) {
        showToast("Could not save system profile: " + err);
        debugLog("error", "Failed to save system profile: " + err);
      }
    });
  }


  // Teaching toggle
  if (teachingBtn) {
    teachingBtn.addEventListener("click", () => {
      teachingBtn.classList.toggle("on");
    });
  }

  // Live theme preview
  const themeSelectEl = $("settings-theme");
  if (themeSelectEl) {
    themeSelectEl.addEventListener("change", () => {
      applyTheme(themeSelectEl.value);
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

      try {
        const resp = await fetch("/models/set-default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id: modelId, label }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        showToast(
          "Saved default model: " +
          (data.model && data.model.label ? data.model.label : label)
        );
        debugLog("info", "Updated default model: " + JSON.stringify(data));
      } catch (err) {
        showToast("Could not save model setting: " + err);
        debugLog("error", "Failed to save default model: " + err);
      }
    });
  }

   // Save settings (including theme) to localStorage AND apply immediately
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const brainEl    = $("settings-brain");
      const teachingEl = $("settings-teaching");
      const tempEl     = $("settings-temp");
      const maxEl      = $("settings-max");
      const themeEl    = $("settings-theme");

      const s = {
        defaultBrain: brainEl ? brainEl.value : "auto",
        // defaultMode is omitted for now – there is no settings-mode element in the UI
        teachingOn:   teachingEl ? teachingEl.classList.contains("on") : false,
        defaultTemp:  tempEl ? tempEl.value : "0.7",
        defaultMax:   maxEl ? maxEl.value : "768",
        defaultTheme: themeEl ? themeEl.value : DEFAULT_THEME,
      };

      writeSettings(s);
      applySettingsToUI(s);
      showToast("Settings saved locally and applied.");
      debugLog("info", "Settings saved to localStorage and applied.");
    });
  }

  // Apply current controls immediately AND persist them
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const brainEl    = $("settings-brain");
      const teachingEl = $("settings-teaching");
      const tempEl     = $("settings-temp");
      const maxEl      = $("settings-max");
      const themeEl    = $("settings-theme");

      const s = {
        defaultBrain: brainEl ? brainEl.value : "auto",
        teachingOn:   teachingEl ? teachingEl.classList.contains("on") : false,
        defaultTemp:  tempEl ? tempEl.value : "0.7",
        defaultMax:   maxEl ? maxEl.value : "768",
        defaultTheme: themeEl ? themeEl.value : DEFAULT_THEME,
      };

      writeSettings(s);
      applySettingsToUI(s);
      showToast("Applied to header, advanced defaults, and theme (saved for next time).");
      debugLog("info", "Settings applied to UI and saved.");
    });
  }


  // Clear history (local only)
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!confirm("Clear previous prompts and conversations from this browser?")) return;
      localStorage.setItem(previousPromptsKey, JSON.stringify([]));
      localStorage.setItem(previousConversationsKey, JSON.stringify([]));
      loadPreviousPrompts();
      showToast("Local history cleared.");
      debugLog("info", "Local history cleared (prompts + conversations).");
    });
  }

  // Export settings + history
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const payload = {
        tli_settings: readSettings(),
        tli_previous_prompts:
          JSON.parse(localStorage.getItem(previousPromptsKey) || "[]"),
        tli_previous_conversations:
          JSON.parse(localStorage.getItem(previousConversationsKey) || "[]"),
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
          if (j.tli_settings) writeSettings(j.tli_settings);
          if (Array.isArray(j.tli_previous_prompts))
            localStorage.setItem(previousPromptsKey, JSON.stringify(j.tli_previous_prompts));
          if (Array.isArray(j.tli_previous_conversations))
            localStorage.setItem(previousConversationsKey, JSON.stringify(j.tli_previous_conversations));

          loadSettingsPanel();
          applySettingsToUI(readSettings());
          loadPreviousPrompts();
          showToast("Import complete.");
          debugLog("info", "Settings/history import complete.");
        } catch (err) {
          showToast("Import failed: " + err.message);
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
        showToast("Node identity saved.", "success");
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
      const tog = $("settings-prefer-mesh-ai");
      const thresh = $("settings-mesh-cpu-threshold");
      const statusEl = $("settings-mesh-ai-status");
      const prefer = tog ? tog.checked : false;
      const cpu = thresh ? parseInt(thresh.value) : 80;
      meshAISaveBtn.disabled = true;
      try {
        const r = await fetch("/api/ai/mesh/preference", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefer_mesh_ai: prefer, mesh_ai_cpu_threshold: cpu }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        if (statusEl) statusEl.textContent = prefer
          ? `Mesh AI preferred — will route to best available mesh peer.`
          : `Local AI preferred — mesh used only when local AI is unavailable or CPU ≥ ${d.mesh_ai_cpu_threshold}%.`;
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
    try {
      const r = await fetch("/system/pin/status", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const desc      = $("settings-pin-status-desc");
      const label     = $("settings-pin-action-label");
      const curInput  = $("settings-pin-current");
      const saveBtn   = $("settings-pin-save");
      const removeBtn = $("settings-pin-remove");
      const callout = $("settings-pin-callout");
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
    } catch {}
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
