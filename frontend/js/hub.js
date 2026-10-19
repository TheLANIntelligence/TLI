// TLI HUB PANEL
// =====================================================
function setupHubPanel() {
  if (setupHubPanel._done) return;
  setupHubPanel._done = true;

  const toggle      = document.getElementById("hub-enabled-toggle");
  const settingsBtn = document.getElementById("hub-settings-btn");
  const drawer      = document.getElementById("hub-settings-drawer");
  const urlInput    = document.getElementById("hub-url-input");
  const urlSave     = document.getElementById("hub-url-save");
  const tabs        = document.getElementById("hub-tabs");
  const grid        = document.getElementById("hub-grid");
  const statusBar   = document.getElementById("hub-status-bar");
  const sampleBtn   = document.getElementById("hub-browse-sample-btn");
  const searchInput = document.getElementById("hub-search");
  const searchRow   = document.getElementById("hub-search-row");
  const publishForm = document.getElementById("hub-publish-form");
  const runDrawer   = document.getElementById("hub-run-drawer");
  const runOutput   = document.getElementById("hub-run-output");
  const runTitle    = document.getElementById("hub-run-title");
  const runClose    = document.getElementById("hub-run-close");

  if (!grid) return;

  let _activeType = "all";
  let _packages   = [];
  let _installed  = new Set();
  let _searchQ    = "";
  let _sourceIsSample = true, _settingsBusy = false;
  let _locked = false, _epoch = 0, _registryEpoch = 0, _sourceEpoch = 0, _source = null;
  let _savedScripts = new Map(), _installedReadEpoch = 0, _installedReadReady = false;
  const scriptUnavailable = 'Host script execution is unavailable pending reviewed containment. Installing stores source for review; it does not execute it.';
  const sourceStatus = document.createElement('p'); sourceStatus.id = 'hub-source-status'; sourceStatus.setAttribute('role', 'status');
  const sourceCopy = document.createElement('button'); sourceCopy.id = 'hub-copy-source'; sourceCopy.type = 'button'; sourceCopy.className = 'pill-btn ghost'; sourceCopy.textContent = 'Copy source'; sourceCopy.disabled = true;
  runOutput?.after(sourceStatus, sourceCopy);
  function clearSource() { _sourceEpoch++; _source = null; sourceCopy.disabled = true; sourceStatus.textContent = ''; if (runOutput) runOutput.textContent = ''; if (runTitle) runTitle.textContent = 'Stored script source'; if (runDrawer) runDrawer.hidden = true; }
  sourceCopy.addEventListener('click', async () => {
    if (_locked || sourceCopy.disabled || _source === null) return;
    const epoch = _epoch, request = _sourceEpoch;
    sourceCopy.disabled = true;
    try {
      await navigator.clipboard.writeText(_source);
      if (epoch === _epoch && request === _sourceEpoch) sourceStatus.textContent = 'Source copied. Nothing was executed.';
    } catch (_) {
      if (epoch === _epoch && request === _sourceEpoch) sourceStatus.textContent = 'Could not copy. Select the source text and copy it manually.';
    } finally { if (epoch === _epoch && request === _sourceEpoch) sourceCopy.disabled = _locked || _source === null; }
  });
  window.addEventListener?.('tli-session-locked', () => {
    _epoch++; _registryEpoch++; _installedReadEpoch++; _installedReadReady = false; _locked = true; _packages = []; _installed.clear(); _savedScripts.clear(); clearSource(); grid.replaceChildren();
    if (urlInput) urlInput.value = '';
    ['pub-code', 'pub-app-html', 'pub-system-prompt', 'pub-automation-json'].forEach(id => { const input = document.getElementById(id); if (input) input.value = ''; });
    document.getElementById('pub-list')?.replaceChildren();
    if (document.getElementById('pub-status')) document.getElementById('pub-status').textContent = 'Unlock TLI before publishing.';
    if (urlSave) urlSave.textContent = 'Save';
    if (toggle) toggle.disabled = true; if (urlSave) urlSave.disabled = true;
    _showStatus('Unlock TLI to load packages and stored source.');
  });
  window.addEventListener?.('tli-session-unlocked', () => { _locked = false; if (toggle) toggle.disabled = _settingsBusy; if (urlSave) urlSave.disabled = _settingsBusy; });
  window.addEventListener?.('tli-private-observation-ready', () => { if (!_locked) _loadRegistry(); });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  async function responseJSON(response, epoch = _epoch) {
    const data = await response.json().catch(() => null);
    if (epoch === _epoch && (response.status === 401 || response.status === 403)) {
      window.dispatchEvent?.(new CustomEvent('tli-session-locked'));
      window.TLIPinLock?.checkAndLock();
    }
    if (!response.ok || data?.ok === false) throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
    if (!data || typeof data !== 'object') throw new Error('TLI returned an incomplete response.');
    return data;
  }

  const TYPE_LABELS = {
    theme:      "Theme",
    ai_preset:  "Prompt preset",
    script:     "Script",
    automation: "Automation",
    app:        "TLI App",
  };

  // ── Load initial status ────────────────────────────────────────
  const initialEpoch = _epoch;
  fetch("/hub/status").then(r => responseJSON(r, initialEpoch)).then(d => {
    if (initialEpoch !== _epoch || _locked) return;
    if (toggle)   toggle.checked    = d.enabled || false;
    if (urlInput) urlInput.value    = d.hub_url || "";
  }).catch(() => {});

  // ── Settings toggle ────────────────────────────────────────────
  if (settingsBtn && drawer) {
    settingsBtn.addEventListener("click", () => {
      drawer.hidden = !drawer.hidden;
    });
  }

  if (urlSave && urlInput) {
    urlSave.addEventListener("click", async () => {
      if (_settingsBusy || _locked) return;
      const epoch = _epoch;
      _settingsBusy = true; urlSave.disabled = true;
      urlSave.textContent = "Saving…";
      try {
        const result = await responseJSON(await fetch("/hub/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hub_url: urlInput.value.trim() }),
        }), epoch);
        if (epoch !== _epoch) return;
        if (result.ok !== true) throw new Error('The host did not confirm the URL save.');
        urlSave.textContent = "Saved ✓";
        setTimeout(() => { urlSave.textContent = "Save"; }, 2000);
      } catch (error) { if (epoch === _epoch) { urlSave.textContent = 'Save'; _showStatus('URL save failed: ' + error.message + ' Your draft is unchanged.'); } }
      finally { _settingsBusy = false; urlSave.disabled = _locked; }
    });
  }

  if (toggle) {
    toggle.addEventListener("change", async () => {
      if (_settingsBusy || _locked) { toggle.checked = !toggle.checked; return; }
      const epoch = _epoch;
      const enabled = toggle.checked;
      _settingsBusy = true; toggle.disabled = true;
      try {
        const result = await responseJSON(await fetch("/hub/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }), epoch);
        if (epoch !== _epoch) return;
        if (result.ok !== true) throw new Error('The host did not confirm the connection setting.');
        if (enabled) _loadRegistry(false);
        else { _showStatus('Hub disconnected.'); _loadRegistry(true); }
      } catch (error) { if (epoch === _epoch) { toggle.checked = !enabled; _showStatus('Connection change failed: ' + error.message); } }
      finally { _settingsBusy = false; toggle.disabled = _locked; }
    });
  }

  if (sampleBtn) {
    sampleBtn.addEventListener("click", () => _loadRegistry(true));
  }

  // ── Search ─────────────────────────────────────────────────────
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      _searchQ = searchInput.value.trim().toLowerCase();
      _render();
    });
  }

  // ── Script output drawer close ────────────────────────────────
  if (runClose) {
    runClose.addEventListener("click", clearSource);
  }

  // ── Tabs ───────────────────────────────────────────────────────
  if (tabs) {
    tabs.querySelectorAll(".hub-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        tabs.querySelectorAll(".hub-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _activeType = btn.dataset.type;

        const isPublish = _activeType === "publish";
        grid.hidden         = isPublish;
        publishForm.hidden  = !isPublish;
        searchRow.hidden    = isPublish;
        clearSource();

        if (isPublish) {
          _loadPublishPanel();
        } else if (_activeType === 'installed') {
          _loadInstalledScripts();
        } else {
          _render();
        }
      });
    });
  }

  // ── Load on panel open ─────────────────────────────────────────
  document.addEventListener("tli-panel-switched", e => {
    if (e.detail?.panelId === "panel-hub") _loadRegistry();
  });

  // ── Registry loader ────────────────────────────────────────────
  async function _loadRegistry(forceSample = false) {
    if (_locked) return;
    const epoch = _epoch, request = ++_registryEpoch;
    _showStatus("Loading…");
    try {
      const hubStatus = await responseJSON(await fetch('/hub/status'), epoch);
      if (epoch !== _epoch || request !== _registryEpoch) return;
      const useSample = forceSample || !hubStatus.enabled;
      const url = useSample ? "/hub/sample" : "/hub/registry";
      const data = await responseJSON(await fetch(url), epoch);
      if (epoch !== _epoch || request !== _registryEpoch) return;
      if (!Array.isArray(data.packages)) throw new Error('The registry did not return a package list.');
      _sourceIsSample = useSample;

      _packages  = data.packages || [];
      _installed = new Set(_packages.filter(p => p.installed).map(p => p.id));

      const src = data.source === "sample" ? "Sample packages" : "TLI Hub";
      _showStatus(`${_packages.length} packages · ${src}`, true);
      if (_activeType === 'installed') _loadInstalledScripts();
      else _render();
    } catch (e) {
      if (epoch !== _epoch || request !== _registryEpoch) return;
      _showStatus('Registry unavailable: ' + (e.message || 'network error') + (_packages.length ? ' Previous package cards may be out of date.' : ''));
    }
  }

  async function _loadInstalledScripts() {
    if (_locked || _activeType !== 'installed') return;
    const epoch = _epoch, request = ++_installedReadEpoch;
    _installedReadReady = false; grid.replaceChildren(); _showStatus('Loading installed packages…');
    try {
      const data = await responseJSON(await fetch('/hub/installed', {cache: 'no-store', signal: AbortSignal.timeout(10000)}), epoch);
      if (epoch !== _epoch || request !== _installedReadEpoch || _activeType !== 'installed') return;
      if (!Array.isArray(data.installed) || data.installed.some(row => !row || typeof row.id !== 'string' || typeof row.type !== 'string')) throw new Error('TLI did not return the installed package list.');
      _installed = new Set(data.installed.map(row => row.id));
      _savedScripts = new Map(data.installed.filter(row => row.type === 'script').map(row => [row.id, {
        id:row.id, name:typeof row.name === 'string' ? row.name : row.id, type:'script',
        version:row.version, author:row.author, description:'Saved script metadata on this host. View the stored source to inspect its contents.',
      }]));
      _installedReadReady = true;
      _showStatus(`${_installed.size} installed packages · saved host metadata`, true);
      _render();
    } catch (error) {
      if (epoch === _epoch && request === _installedReadEpoch && _activeType === 'installed') _showStatus('Installed packages unavailable: ' + error.message);
    }
  }

  function _showStatus(msg, dim = false) {
    if (!statusBar) return;
    statusBar.hidden    = false;
    statusBar.textContent = msg;
    statusBar.style.opacity = dim ? "0.7" : "1";
  }

  // ── Render ─────────────────────────────────────────────────────
  function _render() {
    if (!grid || _locked) return;
    let filtered = _packages;

    if (_activeType === "installed") {
      if (!_installedReadReady) return;
      const rows = new Map(filtered.filter(p => _installed.has(p.id)).map(p => [p.id, p]));
      _savedScripts.forEach((saved, id) => { if (_installed.has(id) && rows.get(id)?.type !== 'script') rows.set(id, saved); });
      filtered = Array.from(rows.values());
    } else if (_activeType !== "all") {
      filtered = filtered.filter(p => p.type === _activeType);
    }

    if (_searchQ) {
      filtered = filtered.filter(p =>
        (p.name        || "").toLowerCase().includes(_searchQ) ||
        (p.description || "").toLowerCase().includes(_searchQ) ||
        (p.author      || "").toLowerCase().includes(_searchQ) ||
        (p.tags || []).some(t => t.toLowerCase().includes(_searchQ))
      );
    }

    grid.innerHTML = "";

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "hub-empty";
      empty.innerHTML = `
        <div class="hub-empty-icon">📭</div>
        <div class="hub-empty-title">Nothing here yet</div>
        <div class="hub-empty-sub">No ${_activeType === "installed" ? "installed packages" : _activeType === "all" ? "packages" : esc(_activeType) + "s"} found${_searchQ ? ' matching "' + esc(_searchQ) + '"' : ""}.</div>`;
      grid.appendChild(empty);
      return;
    }

    filtered.forEach(pkg => grid.appendChild(_buildCard(pkg)));
  }

  // ── Card builder ───────────────────────────────────────────────
  function _buildCard(pkg) {
    const card = document.createElement("div");
    card.className = "hub-pkg-card" + (_installed.has(pkg.id) ? " installed" : "");

    const typeLabel  = TYPE_LABELS[pkg.type] || pkg.type;
    const tags       = (Array.isArray(pkg.tags) ? pkg.tags : []).map(t => `<span class="hub-pkg-tag">${esc(t)}</span>`).join("");
    const isInstalled = _installed.has(pkg.id);
    const savedOnly = _savedScripts.has(pkg.id) && !_packages.some(row => row.id === pkg.id && row.type === 'script');

    // Theme swatch
    let swatchHtml = "";
    if (pkg.type === "theme" && pkg.preview_css) {
      const bgMatch  = pkg.preview_css.match(/--bg:\s*([^;]+)/);
      const accMatch = pkg.preview_css.match(/--accent:\s*([^;]+)/);
      const bg  = bgMatch  ? bgMatch[1].trim()  : "#0b0f14";
      const acc = accMatch ? accMatch[1].trim()  : "#38e8b2";
      swatchHtml = `<div class="hub-theme-swatch">
        <div class="hub-theme-swatch-bg" style="background:${esc(bg)}"></div>
        <div class="hub-theme-swatch-accent" style="background:${esc(acc)}"></div>
      </div>`;
    }

    // Action buttons
    let actionsHtml = "";
    if (isInstalled) {
      if (pkg.type === "script") {
        actionsHtml = `
          <button class="hub-action-btn hub-source-btn" data-pkg-id="${esc(pkg.id)}">View stored source</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${esc(pkg.id)}">Uninstall</button>`;
      } else if (pkg.type === "ai_preset") {
        actionsHtml = `
          <button class="hub-action-btn hub-activate-btn" data-pkg-id="${esc(pkg.id)}" data-pkg-name="${esc(pkg.name)}">Use prompt preset</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${esc(pkg.id)}">Uninstall</button>`;
      } else if (pkg.type === "theme" && pkg.preview_css) {
        actionsHtml = `
          <button class="hub-action-btn hub-preview-btn" data-pkg-id="${esc(pkg.id)}" data-pkg-css="${encodeURIComponent(pkg.preview_css || "")}">Apply for this session</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${esc(pkg.id)}">Uninstall</button>`;
      } else if (pkg.type === "app") {
        actionsHtml = `
          <button class="hub-action-btn hub-open-btn" data-pkg-id="${esc(pkg.id)}" data-pkg-name="${esc(pkg.name)}">Open</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${esc(pkg.id)}">Uninstall</button>`;
      } else {
        actionsHtml = `<button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${esc(pkg.id)}">Uninstall</button>`;
      }
    } else if (!savedOnly) {
      actionsHtml = `<button class="hub-install-btn" data-pkg-id="${esc(pkg.id)}">Install</button>`;
    }

    card.innerHTML = `
      <div class="hub-pkg-top">
        <div>
          <div class="hub-pkg-name">${esc(pkg.name)}</div>
          <div class="hub-pkg-author">by ${esc(pkg.author || "Unknown")} · v${esc(pkg.version || (savedOnly ? "unknown" : "1.0"))}</div>
        </div>
        <span class="hub-pkg-type-badge type-${esc(pkg.type)}">${esc(typeLabel)}</span>
      </div>
      ${swatchHtml}
      <p class="small-meta">Source: ${esc(savedOnly ? 'Saved installed metadata; no matching script in this catalogue' : _sourceIsSample ? 'Bundled sample catalogue' : 'Configured host registry')} · ${isInstalled ? 'Installed on this host' : 'Not installed'}. Listing does not mean reviewed or verified.</p>
      <div class="hub-pkg-desc">${esc(pkg.description || "")}</div>
      <p class="small-meta">${esc(({script: scriptUnavailable, theme: 'Install stores the package. Apply for this session changes this browser’s appearance.', ai_preset: 'Installing stores the preset. Use prompt preset changes the configured AI prompt.', app: 'Installing adds the app package to this host. Open loads its interface.'})[pkg.type] || 'Inspect this package before installing it on the TLI host.')}</p>
      ${tags ? `<div class="hub-pkg-tags">${tags}</div>` : ""}
      <div class="hub-pkg-footer">
        <div class="hub-card-actions">${actionsHtml}</div>
      </div>
    `;

    // Install
    const installBtn = card.querySelector(".hub-install-btn");
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (installBtn.disabled || _locked) return;
        const epoch = _epoch;
        installBtn.textContent = "Installing…";
        installBtn.disabled = true;
        try {
          const r = await fetch("/hub/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ package_id: pkg.id, use_sample: _sourceIsSample }),
          });
          const data = await responseJSON(r, epoch);
          if (epoch !== _epoch) return;
          if (data.ok !== true) throw new Error('The host did not confirm installation.');
          _installed.add(pkg.id);
          if (typeof showToast === "function") showToast(`${pkg.name} installed`, "success");
          if (pkg.type === "app") window.TLIApps?.reload({afterMutation: true});
          _render();
        } catch (err) {
          if (epoch !== _epoch) return;
          installBtn.textContent = "Install";
          installBtn.disabled = false;
          if (typeof showToast === "function") showToast(err.message, "error");
          // A partial app change may have blocked its saved files. Recheck only
          // metadata so the app controller can close an unavailable frame.
          if (pkg.type === "app") window.TLIApps?.reload({afterMutation: true});
        }
      });
    }

    // Uninstall
    const uninstallBtn = card.querySelector(".hub-uninstall-btn");
    if (uninstallBtn) {
      uninstallBtn.addEventListener("click", async () => {
        if (uninstallBtn.disabled || _locked) return;
        const epoch = _epoch;
        uninstallBtn.textContent = "Removing…";
        uninstallBtn.disabled = true;
        try {
          const result = await responseJSON(await fetch(`/hub/packages/${encodeURIComponent(pkg.id)}`, { method: "DELETE" }), epoch);
          if (epoch !== _epoch) return;
          if (result.ok !== true) throw new Error('The host did not confirm removal.');
          _installed.delete(pkg.id);
          _savedScripts.delete(pkg.id);
          clearSource();
          if (typeof showToast === "function") showToast(`${pkg.name} uninstalled`);
          if (pkg.type === "app") window.TLIApps?.reload({afterMutation: true});
          _render();
        } catch (err) {
          if (epoch !== _epoch) return;
          uninstallBtn.textContent = "Uninstall";
          uninstallBtn.disabled = false;
          if (typeof showToast === "function") showToast(err.message, "error");
          if (pkg.type === "app") window.TLIApps?.reload({afterMutation: true});
        }
      });
    }

    // Stored source is text only; this panel never submits a script run.
    const sourceBtn = card.querySelector(".hub-source-btn");
    if (sourceBtn) {
      sourceBtn.addEventListener("click", async () => {
        if (sourceBtn.disabled || _locked) return;
        const epoch = _epoch;
        clearSource(); const request = _sourceEpoch;
        sourceBtn.disabled = true;
        if (runDrawer) {
          runDrawer.hidden = false;
          if (runTitle) runTitle.textContent = pkg.name + ' — Stored source';
        }
        sourceStatus.textContent = 'Loading stored source…';
        try {
          const data = await responseJSON(await fetch(`/hub/packages/${encodeURIComponent(pkg.id)}/source`, {cache: 'no-store', signal: AbortSignal.timeout(10000)}), epoch);
          if (epoch !== _epoch || request !== _sourceEpoch) return;
          if (data.id !== pkg.id || typeof data.contents !== 'string' || data.execution_allowed !== false) throw new Error('TLI did not return the stored script source.');
          _source = data.contents;
          if (runOutput) runOutput.textContent = _source;
          sourceCopy.disabled = false;
          sourceStatus.textContent = 'Stored source — host execution is unavailable. Copying does not execute it.';
        } catch (err) {
          if (epoch === _epoch && request === _sourceEpoch) sourceStatus.textContent = 'Source unavailable: ' + err.message;
        } finally {
          sourceBtn.disabled = _locked;
        }
      });
    }

    // Activate AI preset
    const activateBtn = card.querySelector(".hub-activate-btn");
    if (activateBtn) {
      activateBtn.addEventListener("click", async () => {
        if (activateBtn.disabled || _locked) return;
        const epoch = _epoch;
        activateBtn.disabled = true;
        try {
          const d = await responseJSON(await fetch('/hub/presets'), epoch);
          if (epoch !== _epoch) return;
          const preset = (d.presets || []).find(p => p.id === pkg.id);
          if (!preset || typeof preset.system_prompt !== 'string') throw new Error("Preset data not found");
          // Write system prompt into settings
          const settings = JSON.parse(localStorage.getItem("tli_settings") || "{}");
          settings.defaultBrain = "custom";
          settings.customSystemPrompt = preset.system_prompt;
          localStorage.setItem("tli_settings", JSON.stringify(settings));
          if (typeof showToast === "function") showToast(`${pkg.name} activated as system prompt`, "success");
        } catch (err) {
          if (epoch !== _epoch) return;
          if (typeof showToast === "function") showToast("Could not activate preset: " + err.message, "error");
        } finally { activateBtn.disabled = _locked; }
      });
    }

    // Preview theme
    const previewBtn = card.querySelector(".hub-preview-btn");
    if (previewBtn) {
      previewBtn.addEventListener("click", () => {
        if (_locked) return;
        const css = decodeURIComponent(previewBtn.dataset.pkgCss || "");
        if (css) _applyTheme(pkg.id, css);
      });
    }

    // Open TLI App — navigate to app's panel
    const openBtn = card.querySelector(".hub-open-btn");
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        if (_locked) return;
        const panelId = "panel-app-" + pkg.id;
        const panel   = document.getElementById(panelId);
        if (!panel) {
          if (typeof showToast === "function")
            showToast("App panel not found — try reloading the page", "error");
          return;
        }
        if (window.TLIApps?.open) window.TLIApps.open(pkg.id);
        else window.switchPanel?.(panelId);
      });
    }

    return card;
  }

  // ── Theme application ──────────────────────────────────────────
  function _applyTheme(id, css) {
    const existing = document.getElementById(`hub-theme-${id}`);
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.id = `hub-theme-${id}`;
    style.textContent = css;
    document.head.appendChild(style);
    if (typeof showToast === "function") showToast("Theme applied for this browser session. Reload to return to the saved theme.", "info");
  }

  // ── Publish panel ──────────────────────────────────────────────
  async function _loadPublishPanel() {
    if (_locked) return;
    // Set local registry URL hint
    const urlHint = document.getElementById("pub-local-url");
    if (urlHint) {
      urlHint.textContent = window.location.origin + "/hub/local-registry";
    }

    // Wire type selector to show/hide fields
    const typeSelect = document.getElementById("pub-type");
    if (typeSelect) {
      const allFields = ["ai_preset", "script", "automation", "theme", "app"];
      function _showPubFields() {
        allFields.forEach(t => {
          const el = document.getElementById("pub-fields-" + t);
          if (el) el.hidden = (t !== typeSelect.value);
        });
      }
      typeSelect.removeEventListener("change", _showPubFields);
      typeSelect.addEventListener("change", _showPubFields);
      _showPubFields();
    }

    // Submit
    const submitBtn = document.getElementById("pub-submit");
    const pubStatus = document.getElementById("pub-status");
    if (submitBtn) {
      submitBtn.onclick = async () => {
        if (submitBtn.disabled || _locked) return;
        const epoch = _epoch;
        const id   = (document.getElementById("pub-id")?.value || "").trim().replace(/[^a-z0-9\-_]/gi, "-");
        const name = (document.getElementById("pub-name")?.value || "").trim();
        const type = document.getElementById("pub-type")?.value;
        const desc = (document.getElementById("pub-desc")?.value || "").trim();
        const tags = (document.getElementById("pub-tags")?.value || "").split(",").map(t => t.trim()).filter(Boolean);

        if (!id || !name) {
          if (pubStatus) pubStatus.textContent = "ID and Name are required.";
          return;
        }

        const payload = { id, name, type, description: desc, tags };

        if (type === "ai_preset") {
          payload.system_prompt = document.getElementById("pub-system-prompt")?.value || "";
        } else if (type === "script") {
          payload.shell = document.getElementById("pub-shell")?.value || "powershell";
          payload.code  = document.getElementById("pub-code")?.value || "";
        } else if (type === "automation") {
          try {
            const j = JSON.parse(document.getElementById("pub-automation-json")?.value || "{}");
            payload.trigger = j.trigger || {};
            payload.actions = j.actions || [];
          } catch {
            if (pubStatus) pubStatus.textContent = "Automation JSON is invalid.";
            return;
          }
        } else if (type === "theme") {
          payload.preview_css = document.getElementById("pub-preview-css")?.value || "";
        } else if (type === "app") {
          payload.inline_html = document.getElementById("pub-app-html")?.value || "";
          payload.icon        = (document.getElementById("pub-app-icon")?.value || "📦").trim();
          payload.permissions = (document.getElementById("pub-app-perms")?.value || "")
            .split(",").map(p => p.trim()).filter(Boolean);
          if (!payload.inline_html) {
            if (pubStatus) pubStatus.textContent = "App HTML is required.";
            return;
          }
        }

        submitBtn.disabled = true;
        if (pubStatus) pubStatus.textContent = "Publishing…";
        try {
          const result = await responseJSON(await fetch("/hub/publish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }), epoch);
          if (epoch !== _epoch) return;
          if (result.ok !== true) throw new Error('The host did not confirm publication.');
          if (pubStatus) pubStatus.textContent = `Published to this host’s registry: ${name}`;
          if (typeof showToast === "function") showToast(`${name} published to local registry`, "success");
          _renderPublishedList();
        } catch (err) {
          if (epoch !== _epoch) return;
          if (pubStatus) pubStatus.textContent = "Error: " + err.message;
        } finally {
          submitBtn.disabled = _locked;
        }
      };
    }

    _renderPublishedList();
  }

  async function _renderPublishedList() {
    const listEl = document.getElementById("pub-list");
    if (!listEl || _locked) return;
    const epoch = _epoch;
    try {
      const d = await responseJSON(await fetch('/hub/local-registry'), epoch);
      if (epoch !== _epoch) return;
      if (!Array.isArray(d.packages)) throw new Error('The host did not return a package list.');
      const pkgs = d.packages;
      if (!pkgs.length) {
        listEl.innerHTML = `<div class="hub-empty-sub" style="padding:10px 0;">No published packages yet.</div>`;
        return;
      }
      listEl.innerHTML = pkgs.map(p => `
        <div class="hub-pub-row">
          <div class="hub-pub-row-info">
            <span class="hub-pkg-type-badge type-${esc(p.type)}" style="font-size:10px;">${esc(TYPE_LABELS[p.type] || p.type)}</span>
            <strong>${esc(p.name)}</strong>
            <span style="opacity:0.6; font-size:11px;">v${esc(p.version)}</span>
          </div>
          <button class="hub-action-btn danger" data-unpublish-id="${esc(p.id)}" style="font-size:11px; padding:3px 10px;">Remove</button>
        </div>
      `).join("");

      listEl.querySelectorAll("[data-unpublish-id]").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (btn.disabled || _locked) return;
          const actionEpoch = _epoch;
          btn.disabled = true;
          try { const result = await responseJSON(await fetch(`/hub/local-registry/${encodeURIComponent(btn.dataset.unpublishId)}`, { method: 'DELETE' }), actionEpoch); if (actionEpoch !== _epoch) return; if (result.ok !== true) throw new Error('The host did not confirm removal.'); await _renderPublishedList(); }
          catch (error) { if (actionEpoch === _epoch) { btn.disabled = false; _showStatus('Removal failed: ' + error.message); } }
        });
      });
    } catch {
      if (epoch !== _epoch) return;
      listEl.innerHTML = `<div class="hub-empty-sub">Could not load published packages.</div>`;
    }
  }

  // Initial load
  _loadRegistry();
}
