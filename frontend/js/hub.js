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
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  async function responseJSON(response) {
    const data = await response.json().catch(() => null);
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
  fetch("/hub/status").then(r => r.json()).then(d => {
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
      if (_settingsBusy) return;
      _settingsBusy = true; urlSave.disabled = true;
      urlSave.textContent = "Saving…";
      try {
        const result = await responseJSON(await fetch("/hub/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hub_url: urlInput.value.trim() }),
        }));
        if (result.ok !== true) throw new Error('The host did not confirm the URL save.');
        urlSave.textContent = "Saved ✓";
        setTimeout(() => { urlSave.textContent = "Save"; }, 2000);
      } catch (error) { urlSave.textContent = 'Save'; _showStatus('URL save failed: ' + error.message + ' Your draft is unchanged.'); }
      finally { _settingsBusy = false; urlSave.disabled = false; }
    });
  }

  if (toggle) {
    toggle.addEventListener("change", async () => {
      if (_settingsBusy) { toggle.checked = !toggle.checked; return; }
      const enabled = toggle.checked;
      _settingsBusy = true; toggle.disabled = true;
      try {
        const result = await responseJSON(await fetch("/hub/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }));
        if (result.ok !== true) throw new Error('The host did not confirm the connection setting.');
        if (enabled) _loadRegistry(false);
        else { _showStatus('Hub disconnected.'); _loadRegistry(true); }
      } catch (error) { toggle.checked = !enabled; _showStatus('Connection change failed: ' + error.message); }
      finally { _settingsBusy = false; toggle.disabled = false; }
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
    runClose.addEventListener("click", () => { runDrawer.hidden = true; });
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
        if (runDrawer) runDrawer.hidden = true;

        if (isPublish) {
          _loadPublishPanel();
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
    _showStatus("Loading…");
    try {
      const hubStatus = await responseJSON(await fetch('/hub/status'));
      const useSample = forceSample || !hubStatus.enabled;
      const url = useSample ? "/hub/sample" : "/hub/registry";
      const data = await responseJSON(await fetch(url));
      if (!Array.isArray(data.packages)) throw new Error('The registry did not return a package list.');
      _sourceIsSample = useSample;

      _packages  = data.packages || [];
      _installed = new Set(_packages.filter(p => p.installed).map(p => p.id));

      const src = data.source === "sample" ? "Sample packages" : "TLI Hub";
      _showStatus(`${_packages.length} packages · ${src}`, true);
      _render();
    } catch (e) {
      _showStatus('Registry unavailable: ' + (e.message || 'network error') + (_packages.length ? ' Previous package cards may be out of date.' : ''));
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
    if (!grid) return;
    let filtered = _packages;

    if (_activeType === "installed") {
      filtered = filtered.filter(p => _installed.has(p.id));
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
          <button class="hub-action-btn hub-run-btn" data-pkg-id="${esc(pkg.id)}" data-pkg-name="${esc(pkg.name)}">Run script on host</button>
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
    } else {
      actionsHtml = `<button class="hub-install-btn" data-pkg-id="${esc(pkg.id)}">Install</button>`;
    }

    card.innerHTML = `
      <div class="hub-pkg-top">
        <div>
          <div class="hub-pkg-name">${esc(pkg.name)}</div>
          <div class="hub-pkg-author">by ${esc(pkg.author || "Unknown")} · v${esc(pkg.version || "1.0")}</div>
        </div>
        <span class="hub-pkg-type-badge type-${esc(pkg.type)}">${esc(typeLabel)}</span>
      </div>
      ${swatchHtml}
      <p class="small-meta">Source: ${esc(_sourceIsSample ? 'Bundled sample catalogue' : 'Configured host registry')} · ${isInstalled ? 'Installed on this host' : 'Not installed'}. Listing does not mean reviewed or verified.</p>
      <div class="hub-pkg-desc">${esc(pkg.description || "")}</div>
      <p class="small-meta">${esc(({script: 'Installing stores the script. Run script on host executes its code.', theme: 'Install stores the package. Apply for this session changes this browser’s appearance.', ai_preset: 'Installing stores the preset. Use prompt preset changes the configured AI prompt.', app: 'Installing adds the app package to this host. Open loads its interface.'})[pkg.type] || 'Inspect this package before installing it on the TLI host.')}</p>
      ${tags ? `<div class="hub-pkg-tags">${tags}</div>` : ""}
      <div class="hub-pkg-footer">
        <div class="hub-card-actions">${actionsHtml}</div>
      </div>
    `;

    // Install
    const installBtn = card.querySelector(".hub-install-btn");
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (installBtn.disabled) return;
        installBtn.textContent = "Installing…";
        installBtn.disabled = true;
        try {
          const r = await fetch("/hub/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ package_id: pkg.id, use_sample: _sourceIsSample }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.detail || "Install failed");
          }
          const data = await r.json();
          if (data.ok !== true) throw new Error('The host did not confirm installation.');
          _installed.add(pkg.id);
          if (typeof showToast === "function") showToast(`${pkg.name} installed`, "success");
          if (pkg.type === "app" && window.TLIApps) window.TLIApps.reload();
          _render();
        } catch (err) {
          installBtn.textContent = "Install";
          installBtn.disabled = false;
          if (typeof showToast === "function") showToast(err.message, "error");
        }
      });
    }

    // Uninstall
    const uninstallBtn = card.querySelector(".hub-uninstall-btn");
    if (uninstallBtn) {
      uninstallBtn.addEventListener("click", async () => {
        if (uninstallBtn.disabled) return;
        uninstallBtn.textContent = "Removing…";
        uninstallBtn.disabled = true;
        try {
          const result = await responseJSON(await fetch(`/hub/packages/${encodeURIComponent(pkg.id)}`, { method: "DELETE" }));
          if (result.ok !== true) throw new Error('The host did not confirm removal.');
          _installed.delete(pkg.id);
          if (typeof showToast === "function") showToast(`${pkg.name} uninstalled`);
          _render();
        } catch (err) {
          uninstallBtn.textContent = "Uninstall";
          uninstallBtn.disabled = false;
          if (typeof showToast === "function") showToast(err.message, "error");
        }
      });
    }

    // Run script
    const runBtn = card.querySelector(".hub-run-btn");
    if (runBtn) {
      runBtn.addEventListener("click", async () => {
        if (runBtn.disabled) return;
        if (!window.confirm(`Run “${pkg.name}” on the TLI host? This executes the installed script and may change host files or settings. Continue only after reviewing its code.`)) return;
        runBtn.textContent = "Running…";
        runBtn.disabled = true;
        if (runDrawer) {
          runDrawer.hidden = false;
          if (runTitle) runTitle.textContent = pkg.name + " — Output";
          if (runOutput) runOutput.textContent = "Running…";
        }
        try {
          const r = await fetch(`/hub/packages/${encodeURIComponent(pkg.id)}/run`, { method: "POST" });
          const d = await r.json();
          if (!r.ok) throw new Error(d.detail || `Request failed (${r.status}).`);
          const out = (d.stdout || "") + (d.stderr ? "\n[stderr]\n" + d.stderr : "");
          if (runOutput) runOutput.textContent = out || "(no output)";
          if (d.ok !== true) { if (runTitle) runTitle.textContent = pkg.name + ' — failed or incomplete'; if (typeof showToast === 'function') showToast(`Script did not complete successfully${Number.isInteger(d.exit_code) ? ' (exit ' + d.exit_code + ')' : ''}.`, 'error'); }
          else if (runTitle) runTitle.textContent = pkg.name + ' — completed';
        } catch (err) {
          if (runOutput) runOutput.textContent = "Error: " + err.message;
          if (typeof showToast === "function") showToast("Script failed: " + err.message, "error");
        } finally {
          runBtn.textContent = "Run script on host";
          runBtn.disabled = false;
        }
      });
    }

    // Activate AI preset
    const activateBtn = card.querySelector(".hub-activate-btn");
    if (activateBtn) {
      activateBtn.addEventListener("click", async () => {
        if (activateBtn.disabled) return;
        activateBtn.disabled = true;
        try {
          const d = await responseJSON(await fetch('/hub/presets'));
          const preset = (d.presets || []).find(p => p.id === pkg.id);
          if (!preset || typeof preset.system_prompt !== 'string') throw new Error("Preset data not found");
          // Write system prompt into settings
          const settings = JSON.parse(localStorage.getItem("tli_settings") || "{}");
          settings.defaultBrain = "custom";
          settings.customSystemPrompt = preset.system_prompt;
          localStorage.setItem("tli_settings", JSON.stringify(settings));
          if (typeof showToast === "function") showToast(`${pkg.name} activated as system prompt`, "success");
        } catch (err) {
          if (typeof showToast === "function") showToast("Could not activate preset: " + err.message, "error");
        } finally { activateBtn.disabled = false; }
      });
    }

    // Preview theme
    const previewBtn = card.querySelector(".hub-preview-btn");
    if (previewBtn) {
      previewBtn.addEventListener("click", () => {
        const css = decodeURIComponent(previewBtn.dataset.pkgCss || "");
        if (css) _applyTheme(pkg.id, css);
      });
    }

    // Open TLI App — navigate to app's panel
    const openBtn = card.querySelector(".hub-open-btn");
    if (openBtn) {
      openBtn.addEventListener("click", () => {
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
        if (submitBtn.disabled) return;
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
          }));
          if (result.ok !== true) throw new Error('The host did not confirm publication.');
          if (pubStatus) pubStatus.textContent = `Published to this host’s registry: ${name}`;
          if (typeof showToast === "function") showToast(`${name} published to local registry`, "success");
          _renderPublishedList();
        } catch (err) {
          if (pubStatus) pubStatus.textContent = "Error: " + err.message;
        } finally {
          submitBtn.disabled = false;
        }
      };
    }

    _renderPublishedList();
  }

  async function _renderPublishedList() {
    const listEl = document.getElementById("pub-list");
    if (!listEl) return;
    try {
      const d = await responseJSON(await fetch('/hub/local-registry'));
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
          if (btn.disabled) return;
          btn.disabled = true;
          try { const result = await responseJSON(await fetch(`/hub/local-registry/${encodeURIComponent(btn.dataset.unpublishId)}`, { method: 'DELETE' })); if (result.ok !== true) throw new Error('The host did not confirm removal.'); await _renderPublishedList(); }
          catch (error) { btn.disabled = false; _showStatus('Removal failed: ' + error.message); }
        });
      });
    } catch {
      listEl.innerHTML = `<div class="hub-empty-sub">Could not load published packages.</div>`;
    }
  }

  // Initial load
  _loadRegistry();
}
