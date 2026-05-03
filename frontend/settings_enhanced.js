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
  let _activeTierLabel = "";


  // ==================================================================
  //  Section toggle wiring
  //  Sections are already structured in HTML — we just wire the clicks.
  // ==================================================================

  function initSectionToggles() {
    document.querySelectorAll(".settings-section-header").forEach(function (hdr) {
      if (hdr.dataset.bound) return;
      hdr.dataset.bound = "1";
      const section = hdr.closest(".settings-section");
      if (!section) return;
      hdr.addEventListener("click", function () {
        section.classList.toggle("collapsed");
      });
      hdr.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          section.classList.toggle("collapsed");
        }
      });
    });
  }


  // ==================================================================
  //  Model presets UI
  // ==================================================================

  async function loadPresets() {
    try {
      const r = await fetch("/api/ai/models/presets");
      if (!r.ok) return;
      const data = await r.json();
      renderPresets(data.presets || [], data.active || "");
      updateBadge(data.active);
    } catch (_) {}
  }

  function updateBadge(activePreset) {
    const meta = TIER_META[activePreset];
    if (meta) {
      _activeTierLabel = meta.label;
      _interceptBadge();
    }
  }

  function _fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  function renderPresets(presets, active) {
    const container = document.getElementById("tli-model-presets-list");
    if (!container) return;

    if (!presets.length) {
      container.innerHTML = '<div class="settings-loading-placeholder">No models configured.</div>';
      return;
    }

    container.innerHTML = presets.map(function (p) {
      const meta       = TIER_META[p.tier || p.id] || { color: "#888", icon: "○", label: p.id };
      const isActive   = p.is_active;
      const isDownloaded = p.downloaded;
      const sizeOnDisk = p.size_on_disk ? _fmtSize(p.size_on_disk) : "";

      let actionHTML;
      if (isActive) {
        actionHTML =
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">' +
            '<span class="tli-active-badge">Active</span>' +
            '<button class="chip-button tli-preset-delete" data-preset="' + p.id + '"' +
              ' style="font-size:10px;color:var(--text-soft);border-color:var(--border-subtle);"' +
              ' title="Uninstall model">Uninstall</button>' +
          '</div>';
      } else if (isDownloaded) {
        actionHTML =
          '<button class="chip-button tli-preset-activate" data-preset="' + p.id + '"' +
            ' style="border-color:var(--accent);color:var(--accent);">Activate</button>' +
          '<button class="chip-button tli-preset-delete" data-preset="' + p.id + '"' +
            ' style="border-color:#ef4444;color:#ef4444;font-size:10px;" title="Delete model">✕</button>';
      } else {
        actionHTML =
          '<button class="chip-button tli-preset-download" data-preset="' + p.id + '"' +
            ' style="border-color:' + meta.color + ';color:' + meta.color + ';">Download ' + (p.size_human || "") + '</button>';
      }

      const metaParts = [p.license, (p.min_ram_gb || "") + " GB+ RAM"].filter(Boolean);
      if (isDownloaded && sizeOnDisk) metaParts.push('<span class="tli-size-pill">' + sizeOnDisk + ' on disk</span>');
      if (isDownloaded && !isActive) metaParts.push("✓ Ready");

      return (
        '<div class="tli-model-card' + (isActive ? ' tli-model-active' : '') + '">' +
          '<div class="tli-model-card-icon">' + meta.icon + '</div>' +
          '<div class="tli-model-card-info">' +
            '<div class="tli-model-card-name">' + p.name + '</div>' +
            '<div class="tli-model-card-desc">' + (p.description || "") + '</div>' +
            '<div class="tli-model-card-meta">' + metaParts.join(' · ') + '</div>' +
          '</div>' +
          '<div class="tli-model-card-actions">' + actionHTML + '</div>' +
        '</div>'
      );
    }).join("");

    // Wire download buttons
    container.querySelectorAll(".tli-preset-download").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const pid = btn.dataset.preset;
        btn.disabled = true;
        btn.textContent = "Starting…";
        try {
          const r = await fetch("/api/ai/model/download", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: pid }),
          });
          if (r.ok) { btn.textContent = "Downloading…"; startPolling(); }
          else {
            const j = await r.json().catch(function () { return {}; });
            btn.textContent = j.detail || "Failed";
            btn.disabled = false;
          }
        } catch (_) { btn.textContent = "Error"; btn.disabled = false; }
      });
    });

    // Wire activate buttons
    container.querySelectorAll(".tli-preset-activate").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const pid = btn.dataset.preset;
        btn.disabled = true;
        btn.textContent = "Switching…";
        try {
          const r = await fetch("/api/ai/models/select", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: pid }),
          });
          if (r.ok) {
            loadPresets();
            try { showToast((TIER_META[pid] || {}).label + " model activated", "success"); } catch (_) {}
            try {
              const meshFirst = ["PREFER_LAN_ALLOW_LOCAL", "LAN_ONLY"];
              if (meshFirst.includes(window.AI_POLICY)) {
                window.AI_POLICY = "AUTO";
                if (typeof saveAIPolicy === "function") saveAIPolicy("AUTO");
                showToast("AI routing switched to Smart — using your local model", "info");
              }
            } catch (_) {}
          } else {
            const j = await r.json().catch(function () { return {}; });
            btn.textContent = j.detail || "Error";
          }
        } catch (_) { btn.textContent = "Error"; }
      });
    });

    // Wire delete buttons
    container.querySelectorAll(".tli-preset-delete").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const pid  = btn.dataset.preset;
        const name = (TIER_META[pid] || {}).label || pid;
        const isCurrentlyActive = btn.closest(".tli-model-active") !== null;
        const msg = isCurrentlyActive
          ? "Uninstall " + name + "? This will disable your AI until you download another model."
          : "Delete " + name + " model? You can re-download it later.";
        if (!confirm(msg)) return;
        btn.disabled = true;
        btn.textContent = "Removing…";
        try {
          if (isCurrentlyActive) {
            await fetch("/api/ai/clear-session", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_id: "_noop" }),
            }).catch(function () {});
          }
          const r = await fetch("/api/ai/model/" + pid, { method: "DELETE" });
          if (r.ok) {
            loadPresets();
            try { showToast(name + " uninstalled", "success"); } catch (_) {}
          } else {
            const j = await r.json().catch(function () { return {}; });
            if (j.detail && j.detail.includes("active")) {
              btn.textContent = "Switch first";
              try { showToast("Download another model first, then delete this one", "info"); } catch (_) {}
            } else {
              try { showToast(j.detail || "Failed", "error"); } catch (_) {}
            }
            btn.disabled = false;
          }
        } catch (_) { btn.textContent = "Error"; btn.disabled = false; }
      });
    });
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
      if (dl.status === "downloading") {
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
        if (label) label.textContent   = "Download complete! Restart to activate.";
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

  function _interceptBadge() {
    if (!_activeTierLabel) return;
    const pill = document.getElementById("ai-source-text");
    if (pill) {
      const txt = pill.textContent || "";
      if (txt.includes("Bundled") || txt.includes("Checking") || txt.includes("LM Studio")) {
        pill.textContent = "AI: " + _activeTierLabel;
      }
    }
  }

  function _startBadgeWatch() {
    const pill = document.getElementById("ai-source-text");
    if (pill) {
      new MutationObserver(_interceptBadge).observe(pill, {
        childList: true, characterData: true, subtree: true,
      });
    }
    _interceptBadge();
  }


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
        if (!r.ok) {
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
      deactivateBtn.disabled = true;
      try {
        await fetch("/license/deactivate", { method: "DELETE" });
        _licMsg(msg, "License removed. Reverted to Free tier.", "ok");
        await loadLicenseStatus();
      } catch (_) {
        _licMsg(msg, "Failed to remove license.", "err");
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
    pollProgress().then(function () { if (_polling) startPolling(); });
    _startBadgeWatch();

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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else setTimeout(init, 300);

  console.log("[TLI] Settings Enhanced v3 loaded");
})();
