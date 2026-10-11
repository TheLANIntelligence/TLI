/* ============================================
   TLI Settings Enhanced v3

   The settings panel is now pre-structured in HTML —
   no DOM manipulation needed.  This file handles:
     - Section collapse/expand toggle wiring
     - AI model presets (download, activate, delete)
     - Download progress polling
     - Badge interceptor (AI tier pill in header)
     - License status + key activation
   ============================================ */

(function () {
  "use strict";

  const TIER_META = {
    lite:     { color: "#22c55e", icon: "⚡", label: "Lite" },
    standard: { color: "#3b82f6", icon: "🔵", label: "Standard" },
    power:    { color: "#a855f7", icon: "🟣", label: "Power" },
  };

  let _polling = false;
  let _pollTimer = null;


  // ==================================================================
  //  Section toggle wiring
  //  Sections are already structured in HTML — we just wire the clicks.
  // ==================================================================

  function initSectionToggles() {
    document.querySelectorAll("#panel-settings .settings-section-header").forEach(function (hdr, index) {
      const section = hdr.closest(".settings-section");
      const body = section?.querySelector(".settings-section-body");
      if (!section || !body) return;
      if (!hdr.id) hdr.id = `${section.id || "settings-section-" + index}-heading`;
      if (!body.id) body.id = `${section.id || "settings-section-" + index}-body`;
      hdr.setAttribute("role", "button");
      if (hdr.tagName !== "BUTTON") hdr.setAttribute("tabindex", "0");
      hdr.setAttribute("aria-controls", body.id);
      body.setAttribute("aria-labelledby", hdr.id);
      function syncExpanded() {
        const expanded = !section.classList.contains("collapsed");
        hdr.setAttribute("aria-expanded", String(expanded));
        body.setAttribute("aria-hidden", String(!expanded));
        body.hidden = !expanded;
      }
      syncExpanded();
      if (hdr.dataset.bound) return;
      hdr.dataset.bound = "1";
      function toggle() {
        section.classList.toggle("collapsed");
        syncExpanded();
      }
      hdr.addEventListener("click", toggle);
      hdr.addEventListener("keydown", function (e) {
        if (hdr.tagName !== "BUTTON" && e.target === hdr && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          if (!e.repeat) toggle();
        }
      });
      // Existing navigation can open a section by removing its collapsed class.
      new MutationObserver(syncExpanded).observe(section, { attributes: true, attributeFilter: ["class"] });
    });
  }


  // ==================================================================
  //  Model presets UI
  // ==================================================================

  async function loadPresets() {
    try {
      const r = await fetch("/api/ai/models/presets");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      renderPresets(data.presets || [], data.active || "");
    } catch (_) {
      renderPresets([], "", true);
    }
  }

  function _fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  function renderPresets(presets, active, unavailable = false) {
    const container = document.getElementById("tli-model-presets-list");
    if (!container) return;
    container.innerHTML = "";
    const summary = document.createElement("p");
    const running = presets.find(p => p.running === true);
    summary.textContent = unavailable ? "Model status is unavailable. Open the model library to recheck." : running ? `Running: ${running.name}` : "No bundled model is confirmed running. Installed models can be checked and selected in the model library.";
    const manage = document.createElement("button");
    manage.className = "chip-button"; manage.textContent = "Open model library";
    manage.addEventListener("click", () => window.tliOpenModelManagerModal?.());
    container.appendChild(summary); container.appendChild(manage);
  }


  // ==================================================================
  //  Download progress
  // ==================================================================

  function showProgress(dl) {
    const wrap  = document.getElementById("tli-model-progress-wrap");
    const bar   = document.getElementById("tli-model-dl-bar");
    const pct   = document.getElementById("tli-model-dl-pct");
    const label = document.getElementById("tli-model-dl-label");
    const detail = document.getElementById("tli-model-dl-detail");
    if (!wrap) return;
    const done = dl.bytes_done || 0, total = dl.bytes_total || 0;
    const pctVal = total > 0 ? Math.round((done / total) * 100) : 0;
    const name = (TIER_META[dl.preset_id] || {}).label || "model";
    wrap.style.display = "block";
    if (bar)   bar.style.width   = pctVal + "%";
    if (pct)   pct.textContent   = pctVal + "%";
    if (label) label.textContent = "Downloading " + name + "…";
    if (detail) detail.textContent = total > 0
      ? _fmtSize(done) + " / " + _fmtSize(total)
      : _fmtSize(done) + " downloaded";
  }

  function hideProgress() {
    const wrap = document.getElementById("tli-model-progress-wrap");
    if (wrap) wrap.style.display = "none";
  }

  async function pollProgress() {
    try {
      const r = await fetch("/api/ai/model/progress");
      if (!r.ok) return;
      const dl = await r.json();
      if (dl.in_progress) {
        showProgress(dl);
        _polling = true;
      } else if (dl.status === "done") {
        const wrap  = document.getElementById("tli-model-progress-wrap");
        const bar   = document.getElementById("tli-model-dl-bar");
        const pct   = document.getElementById("tli-model-dl-pct");
        const label = document.getElementById("tli-model-dl-label");
        if (wrap)  wrap.style.display  = "block";
        if (bar)   bar.style.width     = "100%";
        if (pct)   { pct.textContent   = "✓"; pct.style.color = "var(--accent)"; }
        if (label) label.textContent   = "Installed. Open the model library to check and select it.";
        _polling = false;
        stopPolling();
        loadPresets();
        setTimeout(hideProgress, 8000);
      } else if (dl.status === "error") {
        const wrap  = document.getElementById("tli-model-progress-wrap");
        const label = document.getElementById("tli-model-dl-label");
        if (wrap)  wrap.style.display  = "block";
        if (label) label.textContent   = "Failed: " + (dl.error || "unknown");
        _polling = false;
        stopPolling();
      } else {
        if (_polling) { hideProgress(); _polling = false; stopPolling(); }
      }
    } catch (_) {}
  }

  function startPolling() { if (!_pollTimer) _pollTimer = setInterval(pollProgress, 1500); }
  function stopPolling()  { if (_pollTimer)  { clearInterval(_pollTimer); _pollTimer = null; } }


  // ==================================================================
  //  Badge interceptor — overrides app.js "AI: Bundled" label
  // ==================================================================

  // Provider badge ownership stays with ai-source.js.

  // ==================================================================
  //  License
  // ==================================================================

  const TIER_BADGES = {
    free:  { label: "FREE",  cls: "tli-lic-badge--free"  },
    trial: { label: "TRIAL", cls: "tli-lic-badge--trial" },
    pro:   { label: "PRO",   cls: "tli-lic-badge--pro"   },
  };

  const FEATURE_LABELS = {
    mesh:            "Mesh Networking",
    vault:           "Encrypted Vault",
    home_automation: "Home Automation",
    advanced_ai:     "Advanced AI Settings",
    peer_nodes:      "Peer Nodes",
    multi_shelly:    "Multiple Shelly Devices",
    debug_panel:     "Debug Panel",
  };

  async function loadLicenseStatus() {
    const badge    = document.getElementById("tli-lic-tier-badge");
    const licensee = document.getElementById("tli-lic-licensee");
    const expiry   = document.getElementById("tli-lic-expiry");
    const features = document.getElementById("tli-lic-features");
    if (!badge) return;
    try {
      const r = await fetch("/license/status");
      if (!r.ok) return;
      const d = await r.json();
      const tier = d.tier || "free";
      const meta = TIER_BADGES[tier] || TIER_BADGES.free;
      badge.textContent = meta.label;
      badge.className   = "tli-lic-tier-badge " + meta.cls;
      if (licensee) licensee.textContent = d.licensee || "";
      if (expiry) {
        expiry.textContent = d.expires_at
          ? "Expires " + d.expires_at.slice(0, 10)
          : (d.valid ? "No expiry" : "");
      }
      if (features && d.features) {
        features.innerHTML = Object.entries(d.features).map(function ([k, v]) {
          return '<span class="tli-lic-feat' + (v ? ' tli-lic-feat--on' : '') + '">' + (FEATURE_LABELS[k] || k) + '</span>';
        }).join("");
      }
    } catch (_) {}
  }

  function _bindLicenseButtons() {
    const activateBtn   = document.getElementById("tli-lic-activate-btn");
    const deactivateBtn = document.getElementById("tli-lic-deactivate-btn");
    const keyInput      = document.getElementById("tli-lic-key-input");
    const msg           = document.getElementById("tli-lic-msg");
    if (!activateBtn || !deactivateBtn || !keyInput) return;
    if (activateBtn.dataset.bound) return;
    activateBtn.dataset.bound = "1";

    activateBtn.addEventListener("click", async function () {
      if (activateBtn.disabled || deactivateBtn.disabled) return;
      const key = keyInput.value.trim();
      if (!key) { _licMsg(msg, "Paste your license key above.", "warn"); return; }
      activateBtn.disabled = true;
      activateBtn.textContent = "Activating…";
      try {
        const r = await fetch("/license/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        const d = await r.json();
        if (!r.ok || d.valid !== true) {
          _licMsg(msg, d.detail || "Activation failed.", "err");
        } else {
          keyInput.value = "";
          _licMsg(msg, "Activated — " + (d.tier || "").toUpperCase() + " tier. Restart TLI if prompted.", "ok");
          await loadLicenseStatus();
        }
      } catch (_) {
        _licMsg(msg, "Network error during activation.", "err");
      } finally {
        activateBtn.disabled = false;
        activateBtn.textContent = "Activate";
      }
    });

    deactivateBtn.addEventListener("click", async function () {
      if (deactivateBtn.disabled || activateBtn.disabled) return;
      deactivateBtn.disabled = true;
      try {
        const r = await fetch("/license/deactivate", { method: "DELETE" });
        const data = await r.json();
        if (!r.ok || data.valid !== false || data.message !== "License removed") throw new Error(typeof data.detail === "string" ? data.detail : "The host did not confirm removal.");
        _licMsg(msg, "Saved license key removed. Current access is shown above.", "ok");
        await loadLicenseStatus();
      } catch (error) {
        _licMsg(msg, "Failed to remove license. " + error.message, "err");
      } finally {
        deactivateBtn.disabled = false;
      }
    });
  }

  function _licMsg(el, text, type) {
    if (!el) return;
    el.textContent = text;
    el.className   = "tli-lic-msg tli-lic-msg--" + type;
    setTimeout(function () { if (el.textContent === text) el.textContent = ""; }, 5000);
  }


  // ==================================================================
  //  Init
  // ==================================================================

  function init() {
    initSectionToggles();
    loadPresets();
    loadLicenseStatus();
    _bindLicenseButtons();
    pollProgress().then(function () { if (_polling) startPolling(); });

    // Refresh when the Settings panel becomes visible
    const sp = document.getElementById("panel-settings");
    if (sp) {
      let _lastLoad = 0;
      new MutationObserver(function () {
        if (!sp.hidden && Date.now() - _lastLoad > 5000) {
          _lastLoad = Date.now();
          initSectionToggles();
          loadPresets();
          loadLicenseStatus();
          _bindLicenseButtons();
        }
      }).observe(sp, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  window.TLISettingsSections = { refresh: initSectionToggles };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else setTimeout(init, 300);

  console.log("[TLI] Settings Enhanced v3 loaded");
})();
