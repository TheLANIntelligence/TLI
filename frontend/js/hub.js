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

  const TYPE_LABELS = {
    theme:      "Theme",
    ai_preset:  "AI Preset",
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
      urlSave.textContent = "Saving…";
      try {
        await fetch("/hub/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hub_url: urlInput.value.trim() }),
        });
        urlSave.textContent = "Saved ✓";
        setTimeout(() => { urlSave.textContent = "Save"; }, 2000);
      } catch { urlSave.textContent = "Save"; }
    });
  }

  if (toggle) {
    toggle.addEventListener("change", async () => {
      const enabled = toggle.checked;
      try {
        await fetch("/hub/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (enabled) _loadRegistry(false);
        else _showStatus("Hub disconnected. Showing built-in starter pack.");
      } catch {}
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
      const hubStatus = await fetch("/hub/status").then(r => r.json()).catch(() => ({}));
      const useSample = forceSample || !hubStatus.enabled;
      const url = useSample ? "/hub/sample" : "/hub/registry";
      const data = await fetch(url).then(r => r.json());

      _packages  = data.packages || [];
      _installed = new Set(_packages.filter(p => p.installed).map(p => p.id));

      const src = data.source === "sample" ? "Starter Pack" : "TLI Hub";
      _showStatus(`${_packages.length} packages · ${src}`, true);
      _render();
    } catch (e) {
      _showStatus("Failed to load registry: " + (e.message || "network error"));
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
        <div class="hub-empty-sub">No ${_activeType === "installed" ? "installed packages" : _activeType === "all" ? "packages" : _activeType + "s"} found${_searchQ ? ' matching "' + _searchQ + '"' : ""}.</div>`;
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
    const tags       = (pkg.tags || []).map(t => `<span class="hub-pkg-tag">${t}</span>`).join("");
    const isInstalled = _installed.has(pkg.id);

    // Theme swatch
    let swatchHtml = "";
    if (pkg.type === "theme" && pkg.preview_css) {
      const bgMatch  = pkg.preview_css.match(/--bg:\s*([^;]+)/);
      const accMatch = pkg.preview_css.match(/--accent:\s*([^;]+)/);
      const bg  = bgMatch  ? bgMatch[1].trim()  : "#0b0f14";
      const acc = accMatch ? accMatch[1].trim()  : "#38e8b2";
      swatchHtml = `<div class="hub-theme-swatch">
        <div class="hub-theme-swatch-bg" style="background:${bg}"></div>
        <div class="hub-theme-swatch-accent" style="background:${acc}"></div>
      </div>`;
    }

    // Action buttons
    let actionsHtml = "";
    if (isInstalled) {
      if (pkg.type === "script") {
        actionsHtml = `
          <button class="hub-action-btn hub-run-btn" data-pkg-id="${pkg.id}" data-pkg-name="${pkg.name}">▶ Run</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${pkg.id}">Uninstall</button>`;
      } else if (pkg.type === "ai_preset") {
        actionsHtml = `
          <button class="hub-action-btn hub-activate-btn" data-pkg-id="${pkg.id}" data-pkg-name="${pkg.name}">Activate</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${pkg.id}">Uninstall</button>`;
      } else if (pkg.type === "theme" && pkg.preview_css) {
        actionsHtml = `
          <button class="hub-action-btn hub-preview-btn" data-pkg-id="${pkg.id}" data-pkg-css="${encodeURIComponent(pkg.preview_css || "")}">Preview</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${pkg.id}">Uninstall</button>`;
      } else if (pkg.type === "app") {
        actionsHtml = `
          <button class="hub-action-btn hub-open-btn" data-pkg-id="${pkg.id}" data-pkg-name="${pkg.name}">Open</button>
          <button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${pkg.id}">Uninstall</button>`;
      } else {
        actionsHtml = `<button class="hub-action-btn hub-uninstall-btn danger" data-pkg-id="${pkg.id}">Uninstall</button>`;
      }
    } else {
      actionsHtml = `<button class="hub-install-btn" data-pkg-id="${pkg.id}">Install</button>`;
    }

    card.innerHTML = `
      <div class="hub-pkg-top">
        <div>
          <div class="hub-pkg-name">${pkg.name}</div>
          <div class="hub-pkg-author">by ${pkg.author || "Unknown"} · v${pkg.version || "1.0"}</div>
        </div>
        <span class="hub-pkg-type-badge type-${pkg.type}">${typeLabel}</span>
      </div>
      ${swatchHtml}
      <div class="hub-pkg-desc">${pkg.description || ""}</div>
      ${tags ? `<div class="hub-pkg-tags">${tags}</div>` : ""}
      <div class="hub-pkg-footer">
        <div class="hub-pkg-rating"><span>★</span> ${pkg.rating ? pkg.rating.toFixed(1) : "—"}</div>
        <div class="hub-card-actions">${actionsHtml}</div>
      </div>
    `;

    // Install
    const installBtn = card.querySelector(".hub-install-btn");
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        installBtn.textContent = "Installing…";
        installBtn.disabled = true;
        try {
          const r = await fetch("/hub/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ package_id: pkg.id, use_sample: true }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.detail || "Install failed");
          }
          _installed.add(pkg.id);
          if (typeof showToast === "function") showToast(`${pkg.name} installed`, "success");
          if (pkg.type === "theme" && pkg.preview_css) _applyTheme(pkg.id, pkg.preview_css);
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
        uninstallBtn.textContent = "Removing…";
        uninstallBtn.disabled = true;
        try {
          const r = await fetch(`/hub/packages/${pkg.id}`, { method: "DELETE" });
          if (!r.ok) throw new Error("Uninstall failed");
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
        runBtn.textContent = "Running…";
        runBtn.disabled = true;
        if (runDrawer) {
          runDrawer.hidden = false;
          if (runTitle) runTitle.textContent = pkg.name + " — Output";
          if (runOutput) runOutput.textContent = "Running…";
        }
        try {
          const r = await fetch(`/hub/packages/${pkg.id}/run`, { method: "POST" });
          const d = await r.json();
          const out = (d.stdout || "") + (d.stderr ? "\n[stderr]\n" + d.stderr : "");
          if (runOutput) runOutput.textContent = out || "(no output)";
          if (!d.ok && typeof showToast === "function") showToast(`Script exited with code ${d.exit_code}`, "error");
        } catch (err) {
          if (runOutput) runOutput.textContent = "Error: " + err.message;
          if (typeof showToast === "function") showToast("Script failed: " + err.message, "error");
        } finally {
          runBtn.textContent = "▶ Run";
          runBtn.disabled = false;
        }
      });
    }

    // Activate AI preset
    const activateBtn = card.querySelector(".hub-activate-btn");
    if (activateBtn) {
      activateBtn.addEventListener("click", async () => {
        try {
          const r = await fetch("/hub/presets");
          const d = await r.json();
          const preset = (d.presets || []).find(p => p.id === pkg.id);
          if (!preset) throw new Error("Preset data not found");
          // Write system prompt into settings
          const settings = JSON.parse(localStorage.getItem("tli_settings") || "{}");
          settings.defaultBrain = "custom";
          settings.customSystemPrompt = preset.system_prompt;
          localStorage.setItem("tli_settings", JSON.stringify(settings));
          if (typeof showToast === "function") showToast(`${pkg.name} activated as system prompt`, "success");
        } catch (err) {
          if (typeof showToast === "function") showToast("Could not activate preset: " + err.message, "error");
        }
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
        // Activate the panel the same way the nav buttons do
        document.querySelectorAll(".panel-container").forEach(p => {
          p.hidden = true; p.classList.remove("active");
        });
        document.querySelectorAll(".side-nav-button").forEach(b => b.classList.remove("active"));
        panel.hidden = false;
        panel.classList.add("active");
        const navBtn = document.querySelector(`[data-app-id="${pkg.id}"]`);
        if (navBtn) navBtn.classList.add("active");
        document.dispatchEvent(new CustomEvent("tli-panel-switched", { detail: { panelId } }));
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
    if (typeof showToast === "function") showToast("Theme applied — reload to make permanent", "info");
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
          const r = await fetch("/hub/publish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.detail || "Publish failed");
          }
          if (pubStatus) pubStatus.textContent = `Published: ${name}`;
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
      const r = await fetch("/hub/local-registry");
      const d = await r.json();
      const pkgs = d.packages || [];
      if (!pkgs.length) {
        listEl.innerHTML = `<div class="hub-empty-sub" style="padding:10px 0;">No published packages yet.</div>`;
        return;
      }
      listEl.innerHTML = pkgs.map(p => `
        <div class="hub-pub-row">
          <div class="hub-pub-row-info">
            <span class="hub-pkg-type-badge type-${p.type}" style="font-size:10px;">${TYPE_LABELS[p.type] || p.type}</span>
            <strong>${p.name}</strong>
            <span style="opacity:0.6; font-size:11px;">v${p.version}</span>
          </div>
          <button class="hub-action-btn danger" data-unpublish-id="${p.id}" style="font-size:11px; padding:3px 10px;">Remove</button>
        </div>
      `).join("");

      listEl.querySelectorAll("[data-unpublish-id]").forEach(btn => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          await fetch(`/hub/local-registry/${btn.dataset.unpublishId}`, { method: "DELETE" }).catch(() => {});
          _renderPublishedList();
        });
      });
    } catch {
      listEl.innerHTML = `<div class="hub-empty-sub">Could not load published packages.</div>`;
    }
  }

  // Initial load
  _loadRegistry();
}
