// TLI AUTO-UPDATE — v1
// Polls /update/status, shows banner when update is available,
// handles apply flow with progress bar, and wires Settings panel controls.
// =====================================================================
(function () {
  // ── Element refs ─────────────────────────────────────────────────
  const banner       = document.getElementById("tli-update-banner");
  const versionSpan  = document.getElementById("tli-update-version");
  const applyBtn     = document.getElementById("tli-update-apply-btn");
  const dismissBtn   = document.getElementById("tli-update-dismiss-btn");
  const notesBtn     = document.getElementById("tli-update-notes-btn");
  const notesPop     = document.getElementById("tli-update-notes-pop");
  const notesTitle   = document.getElementById("tli-update-notes-title");
  const notesBody    = document.getElementById("tli-update-notes-body");
  const notesClose   = document.getElementById("tli-update-notes-close");
  const progressWrap = document.getElementById("tli-update-progress-wrap");
  const progressBar  = document.getElementById("tli-update-progress-bar");
  const progressLbl  = document.getElementById("tli-update-progress-label");

  // Settings panel refs
  const settingsVersion   = document.getElementById("settings-tli-version");
  const settingsState     = document.getElementById("settings-update-state");
  const checkBtn          = document.getElementById("settings-check-update-btn");
  const urlInput          = document.getElementById("settings-update-url");
  const urlSave           = document.getElementById("settings-update-url-save");
  const autoCheckBox      = document.getElementById("settings-update-auto-check");

  let _dismissed    = false;
  let _pollTimer    = null;
  let _lastState    = null;

  // ── Load current settings into Settings panel ─────────────────
  async function _loadSettings() {
    try {
      const d = await fetch("/update/status").then(r => r.json());
      if (settingsVersion) settingsVersion.textContent = "v" + (d.current_version || "—");
      if (urlInput && d.update_url) urlInput.value = d.update_url;
    } catch {}
  }

  // ── Apply banner state from status ────────────────────────────
  function _applyStatus(d) {
    const state = d.state;

    // Settings panel version display
    if (settingsVersion) settingsVersion.textContent = "v" + (d.current_version || "—");
    if (settingsState) {
      const labels = {
        idle:        "",
        checking:    "Checking…",
        up_to_date:  "Up to date",
        available:   "Update available: v" + d.latest_version,
        downloading: "Downloading… " + d.progress + "%",
        verifying:   "Verifying…",
        applying:    "Applying…",
        done:        "Updated to v" + d.latest_version + " — reload to activate",
        error:       "Error: " + d.error,
      };
      settingsState.textContent = labels[state] || state;
      settingsState.style.color = state === "error" ? "var(--danger, #f87171)"
                                 : state === "done"  ? "var(--accent, #38e8b2)"
                                 : "var(--text-muted)";
    }

    // Banner
    if (!banner) return;

    if (state === "available" && !_dismissed) {
      banner.hidden = false;
      if (versionSpan) versionSpan.textContent = "v" + d.latest_version;
      if (progressWrap) progressWrap.hidden = true;
      if (applyBtn) { applyBtn.hidden = false; applyBtn.disabled = false; applyBtn.textContent = "Update Now"; }
      return;
    }

    if (["downloading", "verifying", "applying"].includes(state)) {
      banner.hidden = false;
      if (progressWrap) progressWrap.hidden = false;
      if (applyBtn) { applyBtn.hidden = true; }
      if (progressBar) progressBar.style.width = (d.progress || 0) + "%";
      if (progressLbl) {
        const labels2 = { downloading: "Downloading", verifying: "Verifying", applying: "Applying" };
        progressLbl.textContent = (labels2[state] || state) + " " + (d.progress || 0) + "%";
      }
      // Keep polling
      _startPoll(2000);
      return;
    }

    if (state === "done") {
      banner.hidden = false;
      if (progressWrap) progressWrap.hidden = true;
      if (applyBtn) {
        applyBtn.hidden = false;
        applyBtn.disabled = false;
        applyBtn.textContent = "Reload Now";
        applyBtn.onclick = () => location.reload();
      }
      if (versionSpan) versionSpan.textContent = "v" + d.latest_version + " ready";
      if (dismissBtn) dismissBtn.hidden = true;
      _stopPoll();
      return;
    }

    if (state === "error") {
      if (banner && !banner.hidden) {
        // Show error in banner briefly
        if (applyBtn) { applyBtn.textContent = "Retry"; applyBtn.disabled = false; applyBtn.onclick = _applyUpdate; }
        if (progressWrap) progressWrap.hidden = true;
      }
      _stopPoll();
      return;
    }

    // All other states — hide banner
    if (state !== "available") {
      banner.hidden = true;
    }

    _lastState = state;
  }

  // ── Poll ──────────────────────────────────────────────────────
  function _startPoll(ms) {
    _stopPoll();
    _pollTimer = setInterval(async () => {
      try {
        const d = await fetch("/update/status").then(r => r.json());
        _applyStatus(d);
        if (["idle", "up_to_date", "available", "done", "error"].includes(d.state)) {
          _stopPoll();
        }
      } catch {}
    }, ms);
  }

  function _stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // ── Check button ──────────────────────────────────────────────
  async function _checkUpdate() {
    if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = "Checking…"; }
    try {
      const d = await fetch("/update/check", { method: "POST" }).then(r => r.json());
      _applyStatus(d);
      if (d.state === "available") {
        if (typeof showToast === "function") showToast("Update available: v" + d.latest_version, "success");
      } else if (d.state === "up_to_date") {
        if (typeof showToast === "function") showToast("TLI is up to date (v" + d.current_version + ")", "info");
      } else if (d.state === "error") {
        if (typeof showToast === "function") showToast(d.error || "Update check failed", "error");
      }
    } catch {
      if (typeof showToast === "function") showToast("Update check failed", "error");
    } finally {
      if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = "Check for updates"; }
    }
  }

  // ── Apply update ──────────────────────────────────────────────
  async function _applyUpdate() {
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = "Starting…"; }
    if (progressWrap) progressWrap.hidden = false;
    if (progressBar) progressBar.style.width = "0%";
    if (progressLbl) progressLbl.textContent = "Starting…";
    try {
      const r = await fetch("/update/apply", { method: "POST" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || "Could not start update");
      }
      // Start polling for progress
      _startPoll(1500);
    } catch (err) {
      if (typeof showToast === "function") showToast("Update failed: " + err.message, "error");
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "Update Now"; }
      if (progressWrap) progressWrap.hidden = true;
    }
  }

  // ── Save update URL ───────────────────────────────────────────
  async function _saveUpdateUrl() {
    const url    = urlInput?.value?.trim() || "";
    const auto   = autoCheckBox?.checked ?? true;
    if (urlSave) { urlSave.disabled = true; urlSave.textContent = "Saving…"; }
    try {
      await fetch("/update/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update_url: url, auto_check: auto }),
      });
      if (urlSave) { urlSave.textContent = "Saved ✓"; setTimeout(() => { urlSave.textContent = "Save"; }, 2000); }
    } catch {
      if (urlSave) { urlSave.textContent = "Save"; }
    } finally {
      if (urlSave) urlSave.disabled = false;
    }
  }

  // ── Wire up events ────────────────────────────────────────────
  if (applyBtn)   applyBtn.addEventListener("click", _applyUpdate);
  if (dismissBtn) dismissBtn.addEventListener("click", () => { _dismissed = true; banner.hidden = true; });
  if (checkBtn)   checkBtn.addEventListener("click", _checkUpdate);
  if (urlSave)    urlSave.addEventListener("click", _saveUpdateUrl);

  if (notesBtn && notesPop) {
    notesBtn.addEventListener("click", () => {
      fetch("/update/status").then(r => r.json()).then(d => {
        if (notesTitle) notesTitle.textContent = "TLI v" + (d.latest_version || "?") + " — Release Notes";
        if (notesBody)  notesBody.textContent  = d.notes || "No release notes available.";
        notesPop.hidden = false;
      }).catch(() => {});
    });
  }
  if (notesClose) notesClose.addEventListener("click", () => { notesPop.hidden = true; });

  // ── Init: load status + settings on startup ───────────────────
  async function _init() {
    await _loadSettings();
    try {
      const d = await fetch("/update/status").then(r => r.json());
      _applyStatus(d);
      // If update already available from background startup check, show banner
      if (d.state === "available") {
        if (typeof showToast === "function")
          showToast("TLI update available: v" + d.latest_version + " — see update banner", "info");
      }
    } catch {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
})();
