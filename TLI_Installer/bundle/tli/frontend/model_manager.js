/* ============================================
   TLI Model Manager — drop-in after app.js
   
   Shows:
   - Active model badge in chat header
   - Download progress bar when downloading
   - Model picker (Lite / Standard / Power)
   
   Polls /api/ai/model/progress during downloads.
   Uses /api/ai/models/presets and /api/ai/models/select.
   ============================================ */

(function () {
  "use strict";

  // ---- State ----
  let _polling = false;
  let _pollTimer = null;
  let _currentPresets = [];
  let _activePreset = "";

  // ---- Tier colors and icons ----
  const TIER_META = {
    lite:     { color: "#22c55e", icon: "⚡", label: "Lite" },
    standard: { color: "#3b82f6", icon: "🔵", label: "Standard" },
    power:    { color: "#a855f7", icon: "🟣", label: "Power" },
  };

  // ========================================
  //  Inject progress bar into chat header
  // ========================================

  function _ensureProgressBar() {
    if (document.getElementById("tli-model-progress-wrap")) return;

    // Find the chat card header
    const badge = document.getElementById("ai-source-badge");
    if (!badge) return;

    const wrap = document.createElement("div");
    wrap.id = "tli-model-progress-wrap";
    wrap.style.cssText = `
      display: none;
      margin-top: 8px;
      padding: 10px 14px;
      background: var(--bg-elevated-alt);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-size: 13px;
      color: var(--text-muted);
      animation: chatSlideIn 0.3s ease-out;
    `;

    wrap.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span id="tli-model-dl-label">Downloading model...</span>
        <span id="tli-model-dl-pct" style="font-weight:600; color:var(--accent);">0%</span>
      </div>
      <div style="width:100%; height:6px; background:var(--bg-main); border-radius:99px; overflow:hidden;">
        <div id="tli-model-dl-bar" style="
          height:100%;
          width:0%;
          background: linear-gradient(90deg, var(--accent), var(--accent-blue));
          border-radius:99px;
          transition: width 0.5s ease-out;
        "></div>
      </div>
      <div id="tli-model-dl-detail" style="margin-top:4px; font-size:11px; color:var(--text-soft);"></div>
    `;

    // Insert after the card-header-row
    const cardHeader = badge.closest(".card-header-row");
    if (cardHeader && cardHeader.parentNode) {
      cardHeader.parentNode.insertBefore(wrap, cardHeader.nextSibling);
    }
  }

  function _showProgress(dl) {
    _ensureProgressBar();
    const wrap = document.getElementById("tli-model-progress-wrap");
    const bar = document.getElementById("tli-model-dl-bar");
    const pct = document.getElementById("tli-model-dl-pct");
    const label = document.getElementById("tli-model-dl-label");
    const detail = document.getElementById("tli-model-dl-detail");

    if (!wrap) return;

    const done = dl.bytes_done || 0;
    const total = dl.bytes_total || 0;
    const pctVal = total > 0 ? Math.round((done / total) * 100) : 0;
    const doneMB = (done / (1024 * 1024)).toFixed(0);
    const totalMB = (total / (1024 * 1024)).toFixed(0);

    const presetName = dl.preset_id
      ? (TIER_META[dl.preset_id] || {}).label || dl.preset_id
      : "model";

    wrap.style.display = "block";
    bar.style.width = pctVal + "%";
    pct.textContent = pctVal + "%";
    label.textContent = `Downloading ${presetName}...`;
    detail.textContent = total > 0 ? `${doneMB} MB / ${totalMB} MB` : `${doneMB} MB downloaded`;
  }

  function _hideProgress() {
    const wrap = document.getElementById("tli-model-progress-wrap");
    if (wrap) wrap.style.display = "none";
  }

  function _showComplete(dl) {
    _ensureProgressBar();
    const wrap = document.getElementById("tli-model-progress-wrap");
    const bar = document.getElementById("tli-model-dl-bar");
    const pct = document.getElementById("tli-model-dl-pct");
    const label = document.getElementById("tli-model-dl-label");
    const detail = document.getElementById("tli-model-dl-detail");

    if (!wrap) return;

    const presetName = dl.preset_id
      ? (TIER_META[dl.preset_id] || {}).label || dl.preset_id
      : "Model";

    wrap.style.display = "block";
    bar.style.width = "100%";
    pct.textContent = "✓";
    pct.style.color = "var(--accent)";
    label.textContent = `${presetName} downloaded! Restart backend to activate.`;
    detail.textContent = "";

    // Auto-hide after 8s
    setTimeout(() => { _hideProgress(); }, 8000);
  }


  // ========================================
  //  Polling
  // ========================================

  async function _pollProgress() {
    try {
      const r = await fetch("/api/ai/model/progress");
      if (!r.ok) return;
      const dl = await r.json();

      if (dl.status === "downloading") {
        _showProgress(dl);
        if (!_polling) {
          _polling = true;
        }
      } else if (dl.status === "done") {
        _showComplete(dl);
        _polling = false;
        _stopPolling();
        // Refresh presets
        _loadPresets();
      } else if (dl.status === "error") {
        _ensureProgressBar();
        const wrap = document.getElementById("tli-model-progress-wrap");
        const label = document.getElementById("tli-model-dl-label");
        const detail = document.getElementById("tli-model-dl-detail");
        if (wrap) wrap.style.display = "block";
        if (label) label.textContent = "Download failed";
        if (detail) detail.textContent = dl.error || "Unknown error";
        _polling = false;
        _stopPolling();
      } else {
        if (_polling) {
          _hideProgress();
          _polling = false;
          _stopPolling();
        }
      }
    } catch (e) {
      // silently continue
    }
  }

  function _startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(_pollProgress, 1500);
  }

  function _stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }


  // ========================================
  //  Model picker (in Settings or standalone)
  // ========================================

  async function _loadPresets() {
    try {
      const r = await fetch("/api/ai/models/presets");
      if (!r.ok) return;
      const data = await r.json();
      _currentPresets = data.presets || [];
      _activePreset = data.active || "";
      _renderPicker();
      _updateBadge();
    } catch (e) {}
  }

  function _updateBadge() {
    const badge = document.getElementById("ai-source-badge");
    if (!badge || !_activePreset) return;

    const meta = TIER_META[_activePreset];
    if (meta) {
      badge.textContent = `AI: ${meta.label}`;
      badge.style.background = meta.color;
      badge.style.color = "#fff";
    }
  }

  function _renderPicker() {
    let container = document.getElementById("tli-model-picker");
    if (!container) {
      // Try to inject into Settings panel
      const settingsPanel = document.getElementById("panel-settings");
      if (!settingsPanel) return;

      // Find first card in settings or append
      const firstCard = settingsPanel.querySelector(".card");
      if (!firstCard) return;

      container = document.createElement("div");
      container.id = "tli-model-picker";
      container.className = "card";
      container.style.cssText = "margin-bottom: 16px;";
      firstCard.parentNode.insertBefore(container, firstCard);
    }

    const presetHTML = _currentPresets.map(p => {
      const meta = TIER_META[p.tier || p.id] || { color: "#888", icon: "○", label: p.id };
      const isActive = p.is_active;
      const isDownloaded = p.downloaded;

      let actionBtn = "";
      if (isActive) {
        actionBtn = `<span style="color:var(--accent); font-weight:600; font-size:12px;">● Active</span>`;
      } else if (isDownloaded) {
        actionBtn = `<button class="chip-button tli-model-activate" data-preset="${p.id}"
          style="border-color:var(--accent); color:var(--accent);">Activate</button>`;
      } else {
        actionBtn = `<button class="chip-button tli-model-download" data-preset="${p.id}"
          style="border-color:${meta.color}; color:${meta.color};">Download ${p.size_human}</button>`;
      }

      return `
        <div style="
          display:flex; align-items:center; gap:12px; padding:10px 14px;
          border:1px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'};
          border-radius:var(--radius-md); margin-bottom:8px;
          background:${isActive ? 'rgba(var(--accent-rgb),0.06)' : 'var(--bg-elevated)'};
          transition: border-color 0.2s;
        ">
          <div style="font-size:24px; flex-shrink:0;">${meta.icon}</div>
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600; font-size:14px; color:var(--text-main);">${p.name}</div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">${p.description}</div>
            <div style="font-size:11px; color:var(--text-soft); margin-top:2px;">
              ${p.license} · Min ${p.min_ram_gb} GB RAM
              ${isDownloaded ? ' · Downloaded ✓' : ''}
            </div>
          </div>
          <div style="flex-shrink:0;">${actionBtn}</div>
        </div>
      `;
    }).join("");

    container.innerHTML = `
      <div class="card-header-row">
        <div>
          <div class="card-title">AI Model</div>
          <div class="card-subtitle">Choose your model tier. All models are fully offline and commercially licensed (Apache 2.0).</div>
        </div>
      </div>
      <div style="padding:0 2px; margin-top:10px;">
        ${presetHTML}
      </div>
    `;

    // Wire up buttons
    container.querySelectorAll(".tli-model-download").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.preset;
        btn.disabled = true;
        btn.textContent = "Starting...";
        try {
          await fetch("/api/ai/model/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: pid }),
          });
          _startPolling();
        } catch (e) {
          btn.textContent = "Error";
        }
      });
    });

    container.querySelectorAll(".tli-model-activate").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.preset;
        btn.disabled = true;
        btn.textContent = "Switching...";
        try {
          const r = await fetch("/api/ai/models/select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: pid }),
          });
          if (r.ok) {
            await _loadPresets();
            try { showToast("Model switched to " + pid, "success"); } catch {}
          } else {
            const j = await r.json().catch(() => ({}));
            btn.textContent = j.detail || "Error";
          }
        } catch (e) {
          btn.textContent = "Error";
        }
      });
    });
  }


  // ========================================
  //  Init
  // ========================================

  function _init() {
    // Load presets on startup
    _loadPresets();

    // Check if a download is already in progress
    _pollProgress().then(() => {
      if (_polling) _startPolling();
    });

    // Re-check presets when Settings panel is shown — observe only the settings panel itself
    const _settingsPanel = document.getElementById("panel-settings");
    if (_settingsPanel) {
      const observer = new MutationObserver(() => {
        if (!_settingsPanel.hidden) _loadPresets();
      });
      observer.observe(_settingsPanel, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  // Run after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    setTimeout(_init, 500);  // slight delay to let app.js init first
  }

  console.log("[TLI] Model Manager loaded — preset selector and download progress active");
})();
