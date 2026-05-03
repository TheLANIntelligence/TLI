/* ============================================
   TLI Settings Enhanced v2 — polished
   
   - Reorganized settings into collapsible sections
   - Model manager with proper active/download states
   - Badge interceptor for consistent tier display
   - Download progress bar
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
  let _activeTierColor = "";


  // ==================================================================
  //  Reorganize Settings into collapsible sections
  // ==================================================================

  function reorganizeSettings() {
    const panel = document.getElementById("panel-settings");
    if (!panel) return;
    const mainCard = panel.querySelector(".card:not(.right-column-card)");
    if (!mainCard || mainCard.dataset.enhanced) return;
    mainCard.dataset.enhanced = "1";

    const headerRow = mainCard.querySelector(".card-header-row");
    const frag = document.createDocumentFragment();
    if (headerRow) frag.appendChild(headerRow);

    // --- AI Model ---
    const modelSection = _mkSection("ai-model", "AI Model", "Choose your bundled AI model. All models run offline with Apache 2.0 licensing.");
    modelSection.querySelector(".settings-section-body").innerHTML = `
      <div id="tli-model-presets-list"><div style="color:var(--text-soft);font-size:13px;">Loading models...</div></div>
      <div id="tli-model-progress-wrap" class="tli-dl-wrap" style="display:none;">
        <div class="tli-dl-header">
          <span id="tli-model-dl-label" class="tli-dl-label">Downloading...</span>
          <span id="tli-model-dl-pct" class="tli-dl-pct">0%</span>
        </div>
        <div class="tli-dl-track"><div id="tli-model-dl-bar" class="tli-dl-fill"></div></div>
        <div id="tli-model-dl-detail" class="tli-dl-detail"></div>
      </div>`;
    frag.appendChild(modelSection);

    // --- LM Studio (collapsed) ---
    const lmSection = _mkSection("lm-studio", "LM Studio (Advanced)", "Optional. Connect to LM Studio for additional models.", true);
    const lmBody = lmSection.querySelector(".settings-section-body");
    _moveElements(mainCard, lmBody, [
      { type: "label", text: "Model server" },
      { type: "class", cls: "model-server-row" },
      { type: "id", id: "settings-model-compat" },
      { type: "label", text: "Available models" },
      { type: "id", id: "settings-model-id" },
      { type: "parentOf", id: "settings-model-refresh", cls: "button-row" },
      { type: "meta", text: "TLI uses your local LM Studio" },
    ]);
    frag.appendChild(lmSection);

    // --- Intelligence ---
    const intSection = _mkSection("intelligence", "Intelligence", "AI provider routing and system profile.");
    const intBody = intSection.querySelector(".settings-section-body");
    _moveElements(mainCard, intBody, [
      { type: "parentOf", id: "settings-ai-source", cls: "settings-row" },
      { type: "parentOf", id: "settings-ai-lan-host", cls: "settings-row" },
      { type: "meta", text: "Manage button" },
      { type: "label", text: "System profile" },
      { type: "class", cls: "system-profile-row" },
      { type: "id", id: "settings-system-profile-meta" },
    ]);
    // Remove orphan "Intelligence" labels that got left behind
    intBody.querySelectorAll(".field-label").forEach(el => {
      if (el.textContent.trim() === "Intelligence") el.remove();
    });
    frag.appendChild(intSection);

    // --- Chat Preferences ---
    const chatSection = _mkSection("chat-prefs", "Chat Preferences", "Controls how your AI responds.");
    const chatBody = chatSection.querySelector(".settings-section-body");
    _moveElements(mainCard, chatBody, [
      { type: "label", text: "Default Brain" },
      { type: "id", id: "settings-brain" },
      { type: "label", text: "Teaching mode" },
      { type: "id", id: "settings-teaching" },
      { type: "label", text: "Temperature" },
      { type: "id", id: "settings-temp" },
      { type: "label", text: "Max tokens" },
      { type: "id", id: "settings-max" },
      { type: "parentOf", id: "settings-save", cls: "button-row" },
    ]);
    frag.appendChild(chatSection);

    // --- Appearance ---
    const themeSection = _mkSection("appearance", "Appearance", "Theme and visual options.");
    const themeBody = themeSection.querySelector(".settings-section-body");
    _moveElements(mainCard, themeBody, [
      { type: "label", text: "Theme" },
      { type: "id", id: "settings-theme" },
    ]);
    frag.appendChild(themeSection);

    // --- Node Identity (collapsed) ---
    const nodeSection = _mkSection("node-identity", "Node Identity", "How this device appears in the mesh.", true);
    const nodeBody = nodeSection.querySelector(".settings-section-body");
    _moveElements(mainCard, nodeBody, [
      { type: "parentOf", id: "settings-node-name", cls: "settings-row" },
      { type: "parentOf", id: "settings-node-role", cls: "settings-row" },
      { type: "parentOf", id: "settings-node-identity-save", cls: "button-row" },
    ]);
    // Move the "Node ID: …" small-meta line (contains #settings-node-id code element)
    const nodeIdCode = mainCard.querySelector("#settings-node-id");
    if (nodeIdCode) {
      const metaLine = nodeIdCode.closest(".small-meta");
      if (metaLine && metaLine.parentNode === mainCard) nodeBody.appendChild(metaLine);
    }
    frag.appendChild(nodeSection);

    // --- Security (PIN Lock + Vault) ---
    const secSection = _mkSection("security", "Security", "PIN lock and vault passphrase management.");
    const secBody = secSection.querySelector(".settings-section-body");
    // PIN
    _moveElements(mainCard, secBody, [
      { type: "id", id: "settings-pin-callout" },
      { type: "id", id: "settings-pin-status-desc" },
      { type: "id", id: "settings-pin-set-block" },
    ]);
    // Vault divider + label + block
    const vaultDivider = document.createElement("hr");
    vaultDivider.className = "settings-divider";
    vaultDivider.style.margin = "14px 0";
    secBody.appendChild(vaultDivider);
    _moveElements(mainCard, secBody, [
      { type: "label", text: "Secure Vault" },
      { type: "id", id: "settings-vault-block" },
    ]);
    frag.appendChild(secSection);

    // --- Online Search (collapsed) ---
    const searchSection = _mkSection("search", "Online Search Assist", "searXNG integration for web-augmented answers.", true);
    const searchBody = searchSection.querySelector(".settings-section-body");
    // Move all search-related elements
    ["settings-search-enable", "settings-searx-url",
     "settings-search-topk", "settings-search-export", "settings-search-clear",
     "settings-search-receipts"].forEach(id => {
      const el = mainCard.querySelector("#" + id);
      if (el) {
        const row = el.closest(".settings-row");
        if (row && row.parentNode === mainCard) { searchBody.appendChild(row); return; }
        const par = el.closest(".button-row");
        if (par && par.parentNode === mainCard) { searchBody.appendChild(par); return; }
        if (el.parentNode === mainCard) searchBody.appendChild(el);
      }
    });
    _moveElements(mainCard, searchBody, [
      { type: "label", text: "Online Search Assist" },
      { type: "label", text: "searXNG URL" },
      { type: "label", text: "Search receipts" },
      { type: "meta", text: "Tip: If you run searXNG" },
      { type: "meta", text: "Every search creates" },
    ]);
    frag.appendChild(searchSection);

    // --- License ---
    const licSection = _mkSection("license", "License", "Activate a license key to unlock Pro features.", true);
    const licBody = licSection.querySelector(".settings-section-body");
    licBody.innerHTML = `
      <div id="tli-lic-status-row" class="tli-lic-status-row">
        <span class="tli-lic-tier-badge" id="tli-lic-tier-badge">FREE</span>
        <span class="tli-lic-licensee" id="tli-lic-licensee"></span>
        <span class="tli-lic-expiry" id="tli-lic-expiry"></span>
      </div>
      <div class="tli-lic-features" id="tli-lic-features"></div>
      <div class="settings-row" style="margin-top:14px;">
        <label class="field-label" for="tli-lic-key-input">License Key</label>
        <input id="tli-lic-key-input" class="tli-input" type="text"
               placeholder="TLI1-..." autocomplete="off" spellcheck="false" />
      </div>
      <div class="button-row" style="margin-top:8px;gap:8px;">
        <button class="btn btn-primary btn-sm" id="tli-lic-activate-btn">Activate</button>
        <button class="btn btn-ghost btn-sm" id="tli-lic-deactivate-btn">Remove Key</button>
      </div>
      <div class="tli-lic-msg" id="tli-lic-msg" aria-live="polite"></div>`;
    frag.appendChild(licSection);

    // --- Keep existing collapsible cards ---
    mainCard.querySelectorAll(".collapsible-card").forEach(c => frag.appendChild(c));

    // Rebuild
    mainCard.innerHTML = "";
    mainCard.appendChild(frag);

    // Cleanup orphans
    mainCard.querySelectorAll("hr.settings-divider").forEach(hr => hr.remove());
    // Remove any remaining orphan field-labels in the main card (not inside sections)
    Array.from(mainCard.children).forEach(child => {
      if (child.classList && child.classList.contains("field-label") && !child.closest(".settings-section")) {
        child.remove();
      }
    });
  }

  function _mkSection(id, title, subtitle, collapsed) {
    const s = document.createElement("div");
    s.className = "settings-section" + (collapsed ? " collapsed" : "");
    s.id = "settings-section-" + id;
    s.innerHTML = `
      <div class="settings-section-header" role="button" tabindex="0">
        <div><div class="settings-section-title">${title}</div>
        <div class="settings-section-subtitle">${subtitle}</div></div>
        <div class="settings-section-chevron">▾</div>
      </div>
      <div class="settings-section-body"></div>`;
    const hdr = s.querySelector(".settings-section-header");
    hdr.addEventListener("click", () => s.classList.toggle("collapsed"));
    hdr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); s.classList.toggle("collapsed"); }});
    return s;
  }

  function _moveElements(from, to, specs) {
    for (const spec of specs) {
      if (spec.type === "id") {
        const el = from.querySelector("#" + spec.id);
        if (el && el.closest(".card:not(.right-column-card)") === from) to.appendChild(el);
      } else if (spec.type === "label") {
        from.querySelectorAll(".field-label").forEach(el => {
          if (el.textContent.trim().startsWith(spec.text) && el.parentNode === from) to.appendChild(el);
        });
      } else if (spec.type === "meta") {
        from.querySelectorAll(".small-meta").forEach(el => {
          if (el.textContent.includes(spec.text) && el.parentNode === from) to.appendChild(el);
        });
      } else if (spec.type === "class") {
        from.querySelectorAll("." + spec.cls).forEach(el => {
          if (el.parentNode === from) to.appendChild(el);
        });
      } else if (spec.type === "parentOf") {
        const el = from.querySelector("#" + spec.id);
        if (el) {
          const parent = el.closest("." + spec.cls);
          if (parent && parent.parentNode === from) to.appendChild(parent);
        }
      }
    }
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
    } catch {}
  }

  function updateBadge(activePreset) {
    const meta = TIER_META[activePreset];
    if (meta) {
      _activeTierLabel = meta.label;
      _activeTierColor = meta.color;
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

    container.innerHTML = presets.map(p => {
      const meta = TIER_META[p.tier || p.id] || { color: "#888", icon: "○", label: p.id };
      const isActive = p.is_active;
      const isDownloaded = p.downloaded;
      const sizeOnDisk = p.size_on_disk ? _fmtSize(p.size_on_disk) : "";

      let actionHTML;
      if (isActive) {
        actionHTML = `
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
            <span class="tli-active-badge">Active</span>
            <button class="chip-button tli-preset-delete" data-preset="${p.id}"
              style="font-size:10px; color:var(--text-soft); border-color:var(--border-subtle);" title="Uninstall model">Uninstall</button>
          </div>`;
      } else if (isDownloaded) {
        actionHTML = `
          <button class="chip-button tli-preset-activate" data-preset="${p.id}"
            style="border-color:var(--accent); color:var(--accent);">Activate</button>
          <button class="chip-button tli-preset-delete" data-preset="${p.id}"
            style="border-color:#ef4444; color:#ef4444; font-size:10px;" title="Delete model">✕</button>`;
      } else {
        actionHTML = `<button class="chip-button tli-preset-download" data-preset="${p.id}"
          style="border-color:${meta.color}; color:${meta.color};">Download ${p.size_human}</button>`;
      }

      const metaParts = [p.license, p.min_ram_gb + " GB+ RAM"];
      if (isDownloaded && sizeOnDisk) metaParts.push(`<span class="tli-size-pill">${sizeOnDisk} on disk</span>`);
      if (isDownloaded && !isActive) metaParts.push("✓ Ready");

      return `
        <div class="tli-model-card ${isActive ? 'tli-model-active' : ''}">
          <div class="tli-model-card-icon">${meta.icon}</div>
          <div class="tli-model-card-info">
            <div class="tli-model-card-name">${p.name}</div>
            <div class="tli-model-card-desc">${p.description}</div>
            <div class="tli-model-card-meta">${metaParts.join(' · ')}</div>
          </div>
          <div class="tli-model-card-actions">${actionHTML}</div>
        </div>`;
    }).join("");

    // Wire download buttons
    container.querySelectorAll(".tli-preset-download").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.preset;
        btn.disabled = true;
        btn.textContent = "Starting...";
        try {
          const r = await fetch("/api/ai/model/download", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: pid }),
          });
          if (r.ok) { btn.textContent = "Downloading..."; startPolling(); }
          else { const j = await r.json().catch(() => ({})); btn.textContent = j.detail || "Failed"; btn.disabled = false; }
        } catch { btn.textContent = "Error"; btn.disabled = false; }
      });
    });

    // Wire activate buttons
    container.querySelectorAll(".tli-preset-activate").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.preset;
        btn.disabled = true;
        btn.textContent = "Switching...";
        try {
          const r = await fetch("/api/ai/models/select", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: pid }),
          });
          if (r.ok) { loadPresets(); try { showToast((TIER_META[pid]||{}).label + " model activated", "success"); } catch {} }
          else { const j = await r.json().catch(() => ({})); btn.textContent = j.detail || "Error"; }
        } catch { btn.textContent = "Error"; }
      });
    });

    // Wire delete buttons (works for both active and inactive models)
    container.querySelectorAll(".tli-preset-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.preset;
        const name = (TIER_META[pid] || {}).label || pid;
        const isCurrentlyActive = btn.closest(".tli-model-active") !== null;
        const msg = isCurrentlyActive
          ? `Uninstall ${name}? This will disable your AI until you download another model.`
          : `Delete ${name} model? You can re-download it later.`;
        if (!confirm(msg)) return;
        btn.disabled = true;
        btn.textContent = "Removing...";
        try {
          // If active, we need to deselect first — backend won't allow deleting active
          if (isCurrentlyActive) {
            // Clear the active config so backend allows deletion
            await fetch("/api/ai/clear-session", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_id: "_noop" }),
            }).catch(() => {});
          }
          const r = await fetch("/api/ai/model/" + pid, { method: "DELETE" });
          if (r.ok) {
            loadPresets();
            try { showToast(name + " uninstalled", "success"); } catch {}
          } else {
            const j = await r.json().catch(() => ({}));
            // If it fails because it's active, try force approach
            if (j.detail && j.detail.includes("active")) {
              btn.textContent = "Switch first";
              try { showToast("Download another model first, then delete this one", "info"); } catch {}
            } else {
              try { showToast(j.detail || "Failed", "error"); } catch {}
            }
            btn.disabled = false;
          }
        } catch { btn.textContent = "Error"; btn.disabled = false; }
      });
    });
  }


  // ==================================================================
  //  Download progress
  // ==================================================================

  function showProgress(dl) {
    const wrap = document.getElementById("tli-model-progress-wrap");
    const bar = document.getElementById("tli-model-dl-bar");
    const pct = document.getElementById("tli-model-dl-pct");
    const label = document.getElementById("tli-model-dl-label");
    const detail = document.getElementById("tli-model-dl-detail");
    if (!wrap) return;
    const done = dl.bytes_done || 0, total = dl.bytes_total || 0;
    const pctVal = total > 0 ? Math.round((done / total) * 100) : 0;
    const name = (TIER_META[dl.preset_id] || {}).label || "model";
    wrap.style.display = "block";
    if (bar) bar.style.width = pctVal + "%";
    if (pct) pct.textContent = pctVal + "%";
    if (label) label.textContent = "Downloading " + name + "...";
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
      if (dl.status === "downloading") { showProgress(dl); _polling = true; }
      else if (dl.status === "done") {
        const wrap = document.getElementById("tli-model-progress-wrap");
        const bar = document.getElementById("tli-model-dl-bar");
        const pct = document.getElementById("tli-model-dl-pct");
        const label = document.getElementById("tli-model-dl-label");
        if (wrap) wrap.style.display = "block";
        if (bar) bar.style.width = "100%";
        if (pct) { pct.textContent = "✓"; pct.style.color = "var(--accent)"; }
        if (label) label.textContent = "Download complete! Restart to activate.";
        _polling = false; stopPolling(); loadPresets();
        setTimeout(hideProgress, 8000);
      } else if (dl.status === "error") {
        const wrap = document.getElementById("tli-model-progress-wrap");
        const label = document.getElementById("tli-model-dl-label");
        if (wrap) wrap.style.display = "block";
        if (label) label.textContent = "Failed: " + (dl.error || "unknown");
        _polling = false; stopPolling();
      } else {
        if (_polling) { hideProgress(); _polling = false; stopPolling(); }
      }
    } catch {}
  }

  function startPolling() { if (!_pollTimer) _pollTimer = setInterval(pollProgress, 1500); }
  function stopPolling() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }


  // ==================================================================
  //  Badge interceptor — overrides app.js "AI: Bundled"
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

  // ==================================================================
  //  License
  // ==================================================================

  const TIER_BADGES = {
    free:  { label: "FREE",  cls: "tli-lic-badge--free" },
    trial: { label: "TRIAL", cls: "tli-lic-badge--trial" },
    pro:   { label: "PRO",   cls: "tli-lic-badge--pro" },
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
      licensee.textContent = d.licensee || "";
      if (d.expires_at) {
        expiry.textContent = "Expires " + d.expires_at.slice(0, 10);
      } else if (d.valid) {
        expiry.textContent = "No expiry";
      } else {
        expiry.textContent = "";
      }
      if (features && d.features) {
        features.innerHTML = Object.entries(d.features).map(([k, v]) =>
          `<span class="tli-lic-feat${v ? " tli-lic-feat--on" : ""}">${FEATURE_LABELS[k] || k}</span>`
        ).join("");
      }
    } catch (_) {}
  }

  function _bindLicenseButtons() {
    const activateBtn    = document.getElementById("tli-lic-activate-btn");
    const deactivateBtn  = document.getElementById("tli-lic-deactivate-btn");
    const keyInput       = document.getElementById("tli-lic-key-input");
    const msg            = document.getElementById("tli-lic-msg");
    if (!activateBtn || !deactivateBtn || !keyInput) return;
    // Prevent double-binding
    if (activateBtn.dataset.bound) return;
    activateBtn.dataset.bound = "1";

    activateBtn.addEventListener("click", async () => {
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
          _licMsg(msg, `Activated — ${(d.tier || "").toUpperCase()} tier. Restart TLI if prompted.`, "ok");
          await loadLicenseStatus();
        }
      } catch (e) {
        _licMsg(msg, "Network error during activation.", "err");
      } finally {
        activateBtn.disabled = false;
        activateBtn.textContent = "Activate";
      }
    });

    deactivateBtn.addEventListener("click", async () => {
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
    el.className = "tli-lic-msg tli-lic-msg--" + type;
    setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 5000);
  }

  function _startBadgeWatch() {
    const pill = document.getElementById("ai-source-text");
    if (pill) {
      new MutationObserver(_interceptBadge).observe(pill, { childList: true, characterData: true, subtree: true });
    }
    _interceptBadge();
  }


  // ==================================================================
  //  Init
  // ==================================================================

  function init() {
    reorganizeSettings();
    loadPresets();
    pollProgress().then(() => { if (_polling) startPolling(); });

    // Refresh when Settings panel shown (debounced)
    let _lastLoad = 0;
    const sp = document.getElementById("panel-settings");
    if (sp) {
      new MutationObserver(() => {
        if (!sp.hidden && Date.now() - _lastLoad > 5000) {
          _lastLoad = Date.now();
          reorganizeSettings();
          loadPresets();
          loadLicenseStatus();
          _bindLicenseButtons();
        }
      }).observe(sp, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else setTimeout(init, 600);

  console.log("[TLI] Settings Enhanced v2 loaded");
})();
