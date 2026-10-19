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

  let _licEpoch = 0, _licRead = 0, _licLocked = false, _licReady = true, _licVerified = false, _licBusy = false, _licPausedFrom = null;
  const _licCurrent = epoch => epoch === _licEpoch && !_licLocked && _licReady;
  const _licEl = id => document.getElementById(id);
  function _licControls() {
    for (const id of ['tli-lic-activate-btn','tli-lic-deactivate-btn','tli-lic-key-input']) if (_licEl(id)) _licEl(id).disabled = !_licCurrent(_licEpoch) || _licBusy;
    const refresh = _licEl('tli-lic-refresh-btn');
    if (refresh) { refresh.disabled = _licLocked || _licBusy; refresh.textContent = _licReady ? 'Refresh license details' : 'Check license access'; }
  }
  function _licClear() {
    const pending = _licBusy;
    _licEpoch++; _licRead++; _licBusy = false;
    for (const id of ['tli-lic-licensee','tli-lic-expiry','tli-lic-features','tli-lic-msg']) if (_licEl(id)) _licEl(id).textContent = '';
    if (_licEl('tli-lic-tier-badge')) _licEl('tli-lic-tier-badge').textContent = 'Unavailable';
    if (_licEl('tli-lic-key-input')) _licEl('tli-lic-key-input').value = '';
    if (_licEl('tli-lic-activate-btn')) _licEl('tli-lic-activate-btn').textContent = 'Activate';
    _licControls();
    if (pending) _licMsg(_licEl('tli-lic-msg'), 'License change interrupted. Outcome not confirmed. No retry was sent. Refresh details after unlocking.', 'err');
  }
  async function _licRequest(url, options, epoch) {
    if (!_licCurrent(epoch)) throw new Error('License access changed.');
    const response = await fetch(url, {credentials:'same-origin',cache:'no-store',...options});
    const data = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      const current = _licCurrent(epoch);
      if (current || epoch === _licPausedFrom && !_licReady && !_licVerified) {
        if (current) window.dispatchEvent(new CustomEvent('tli-session-locked'));
        _licMsg(_licEl('tli-lic-msg'), (typeof data?.detail === 'string' ? data.detail : 'Unlock TLI to manage the saved license.') + (options.method ? ' Change outcome not confirmed.' : '') + ' No retry was sent.', 'err');
        if (current) window.TLIPinLock?.checkAndLock();
      }
    }
    if (!_licCurrent(epoch)) throw new Error('License access changed.');
    if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
    if (!data || typeof data !== 'object') throw new Error('The host returned an unreadable license result.');
    return data;
  }
  async function loadLicenseStatus() {
    const badge = _licEl('tli-lic-tier-badge');
    if (!badge || !_licCurrent(_licEpoch)) return;
    const epoch = _licEpoch, read = ++_licRead;
    try {
      const d = await _licRequest('/license/details', {}, epoch);
      if (!_licCurrent(epoch) || read !== _licRead) return;
      if (!TIER_BADGES[d.tier] || typeof d.valid !== 'boolean' || typeof d.beta !== 'boolean' || typeof d.licensee !== 'string' ||
          d.expires_at != null && typeof d.expires_at !== 'string' || !d.features || typeof d.features !== 'object' || Array.isArray(d.features) || Object.values(d.features).some(value => typeof value !== 'boolean')) throw new Error('The host did not return complete license details.');
      const meta = TIER_BADGES[d.tier]; badge.textContent = d.beta ? 'BETA' : meta.label; badge.className = 'tli-lic-tier-badge ' + meta.cls;
      if (_licEl('tli-lic-licensee')) _licEl('tli-lic-licensee').textContent = d.licensee;
      if (_licEl('tli-lic-expiry')) _licEl('tli-lic-expiry').textContent = d.expires_at ? 'Expires ' + d.expires_at.slice(0,10) : d.valid ? 'No expiry' : '';
      const features = _licEl('tli-lic-features');
      if (features) {
        features.textContent = '';
        for (const [key,value] of Object.entries(d.features)) { const node = document.createElement('span'); node.className = 'tli-lic-feat' + (value ? ' tli-lic-feat--on' : ''); node.textContent = FEATURE_LABELS[key] || key; features.appendChild(node); }
      }
    } catch (error) {
      if (_licCurrent(epoch) && read === _licRead) {
        for (const id of ['tli-lic-licensee','tli-lic-expiry','tli-lic-features']) if (_licEl(id)) _licEl(id).textContent = '';
        badge.textContent = 'Unavailable'; _licMsg(_licEl('tli-lic-msg'), 'License details unavailable. ' + error.message, 'err');
      }
    }
  }
  function _bindLicenseButtons() {
    const activate = _licEl('tli-lic-activate-btn'), deactivate = _licEl('tli-lic-deactivate-btn'), input = _licEl('tli-lic-key-input'), msg = _licEl('tli-lic-msg');
    if (!activate || !deactivate || !input || activate.dataset.bound) return;
    activate.dataset.bound = '1';
    const row = _licEl('tli-lic-status-row');
    if (row && !_licEl('tli-lic-refresh-btn')) {
      const refresh = document.createElement('button'); refresh.id = 'tli-lic-refresh-btn'; refresh.type = 'button'; refresh.className = 'btn-outline btn-sm';
      refresh.addEventListener('click', async () => {
        if (_licLocked || _licBusy) return;
        if (!_licReady) { await window.EventInterpreter?.retry(); return; }
        await loadLicenseStatus();
      }); row.appendChild(refresh);
    }
    async function write(remove) {
      if (!_licCurrent(_licEpoch) || _licBusy) return;
      const key = input.value.trim();
      if (!remove && !key) { _licMsg(msg, 'Paste your license key above.', 'warn'); return; }
      const epoch = _licEpoch; _licBusy = true; _licRead++; input.value = ''; _licControls();
      if (!remove) activate.textContent = 'Activating…';
      try {
        const d = await _licRequest(remove ? '/license/deactivate' : '/license/activate', remove ? {method:'DELETE'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})}, epoch);
        if (!_licCurrent(epoch)) return;
        if (remove ? d.valid !== false || d.message !== 'License removed' : d.valid !== true || !TIER_BADGES[d.tier]) throw new Error('The host did not confirm the requested license change.');
        _licMsg(msg, remove ? 'Saved license key removed. Current access is shown above.' : 'Activated — ' + d.tier.toUpperCase() + ' tier.', 'ok');
        await loadLicenseStatus();
      } catch (error) {
        if (_licCurrent(epoch)) _licMsg(msg, (remove ? 'Failed to remove license. ' : 'Activation not confirmed. ') + error.message + ' No retry was sent. Refresh license details before trying again.', 'err');
      } finally { if (_licCurrent(epoch)) { _licBusy = false; activate.textContent = 'Activate'; _licControls(); } }
    }
    activate.addEventListener('click', () => write(false)); deactivate.addEventListener('click', () => write(true)); _licControls();
  }
  function _licMsg(el, text, type) {
    if (!el) return;
    el.textContent = text; el.className = 'tli-lic-msg tli-lic-msg--' + type;
  }
  window.addEventListener('tli-session-locked', () => { _licPausedFrom = _licEpoch; _licLocked = true; _licReady = false; _licVerified = false; _licClear(); });
  window.addEventListener('tli-session-unlocked', event => {
    const verified = event?.detail?.source === 'pin-verification';
    if (!_licLocked && (!verified || _licVerified)) return;
    const replace = !_licLocked && _licReady; _licLocked = false; _licReady = false; if (verified) _licVerified = true;
    if (replace) _licClear(); _licControls();
  });
  window.addEventListener('tli-private-observation-ready', () => {
    if (_licLocked || _licReady) return; _licReady = true; _licPausedFrom = null; _licControls();
    if (_licEl('panel-settings')?.hidden === false) loadLicenseStatus();
  });
  window.addEventListener('pagehide', () => { _licReady = false; _licPausedFrom = null; _licClear(); });


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
