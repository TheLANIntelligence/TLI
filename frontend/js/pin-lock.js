/* =============================================================
   TLI PIN Lock
   - Checks /system/pin/status on load.
   - If PIN is enabled and no valid session → show lock screen.
   - Session stored in sessionStorage (auto-clears on tab close).
   - Lock button in header re-locks the session.
   ============================================================= */
(function () {
  const SS_KEY = "tli_session_unlocked";

  function _isUnlocked() {
    try { return sessionStorage.getItem(SS_KEY) === "1"; } catch { return false; }
  }
  function _setUnlocked(v) {
    try {
      if (v) sessionStorage.setItem(SS_KEY, "1");
      else sessionStorage.removeItem(SS_KEY);
    } catch {}
  }

  function _lockScreen() { return document.getElementById("tli-lock-screen"); }
  function _lockInput()  { return document.getElementById("tli-lock-input"); }
  function _lockError()  { return document.getElementById("tli-lock-error"); }
  function _lockBtn()    { return document.getElementById("tli-lock-btn"); }

  function _showLock() {
    const s = _lockScreen();
    if (s) { s.classList.remove("hidden"); s.removeAttribute("hidden"); }
    document.body.style.overflow = "hidden";
    setTimeout(() => { const i = _lockInput(); if (i) i.focus(); }, 120);
  }

  function _hideLock() {
    const s = _lockScreen();
    if (s) s.classList.add("hidden");
    document.body.style.overflow = "";
    const b = _lockBtn();
    if (b) b.hidden = false;
  }

  async function _checkAndLock() {
    try {
      const r = await fetch("/system/pin/status", { cache: "no-store" });
      if (!r.ok) return; // backend unreachable — don't block
      const d = await r.json();
      if (d.enabled && !_isUnlocked()) {
        _showLock();
      } else if (!d.enabled) {
        // PIN not set — hide lock screen and lock btn
        _hideLock();
        const b = _lockBtn();
        if (b) b.hidden = true;
        _suggestPin();
      } else {
        // PIN set + already unlocked — show lock btn
        const b = _lockBtn();
        if (b) b.hidden = false;
      }
    } catch {
      // Silent — don't block app on network error
    }
  }

  async function _submitPin() {
    const input = _lockInput();
    const errEl = _lockError();
    const pin = input ? input.value : "";
    if (!pin) { if (errEl) errEl.textContent = "Enter your PIN."; return; }

    try {
      const r = await fetch("/system/pin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (r.ok) {
        _setUnlocked(true);
        if (input) input.value = "";
        if (errEl) errEl.textContent = "";
        _hideLock();
      } else {
        if (errEl) errEl.textContent = "Incorrect PIN. Try again.";
        if (input) { input.value = ""; input.focus(); }
      }
    } catch {
      if (errEl) errEl.textContent = "Could not reach backend. Try again.";
    }
  }

  function _suggestPin() {
    const LS_KEY = "tli_pin_nudge_v1";
    try { if (localStorage.getItem(LS_KEY)) return; } catch {}
    const el = document.createElement("div");
    el.className = "tli-pin-nudge";
    el.innerHTML =
      '<div class="tli-pin-nudge-title">No PIN set</div>' +
      '<div class="tli-pin-nudge-body">TLI is open to anyone on your LAN. Set a PIN in Settings to restrict access.</div>' +
      '<div class="tli-pin-nudge-actions">' +
        '<button id="tli-pin-nudge-go" class="btn btn-sm btn-primary">Go to Settings</button>' +
        '<button id="tli-pin-nudge-dismiss" class="btn btn-sm btn-ghost">Dismiss</button>' +
      '</div>';
    document.body.appendChild(el);
    const dismissPermanent = () => {
      el.remove();
      try { localStorage.setItem(LS_KEY, "1"); } catch {}
    };
    const dismissTemporary = () => {
      el.remove(); // hide this session only — reappears next load if PIN still not set
    };
    el.querySelector("#tli-pin-nudge-go").addEventListener("click", () => {
      dismissTemporary();
      if (typeof switchPanel === "function") switchPanel("panel-settings");
    });
    el.querySelector("#tli-pin-nudge-dismiss").addEventListener("click", dismissPermanent);
  }

  async function _emergencyReset() {
    try {
      const r = await fetch("/system/pin/emergency-reset", { method: "POST" });
      if (r.ok) {
        _setUnlocked(true);
        _hideLock();
        location.reload();
      } else {
        const errEl = _lockError();
        if (errEl) errEl.textContent = "Reset failed. Try restarting the backend.";
      }
    } catch {
      const errEl = _lockError();
      if (errEl) errEl.textContent = "Could not reach backend.";
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    _checkAndLock();

    // Submit on button click
    const submitBtn = document.getElementById("tli-lock-submit");
    if (submitBtn) submitBtn.addEventListener("click", _submitPin);

    // Submit on Enter key
    const inp = _lockInput();
    if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") _submitPin(); });

    // Lock button in header
    const lockBtn = _lockBtn();
    if (lockBtn) {
      lockBtn.addEventListener("click", () => {
        _setUnlocked(false);
        _showLock();
      });
    }

    // Forgot PIN flow
    const forgotBtn = document.getElementById("tli-lock-forgot");
    const resetPanel = document.getElementById("tli-lock-reset-panel");
    const resetConfirmBtn = document.getElementById("tli-lock-reset-confirm-btn");
    const resetCancelBtn = document.getElementById("tli-lock-reset-cancel-btn");

    if (forgotBtn && resetPanel) {
      forgotBtn.addEventListener("click", () => {
        resetPanel.classList.remove("hidden");
        forgotBtn.style.display = "none";
      });
    }
    if (resetCancelBtn && resetPanel) {
      resetCancelBtn.addEventListener("click", () => {
        resetPanel.classList.add("hidden");
        if (forgotBtn) forgotBtn.style.display = "";
      });
    }
    if (resetConfirmBtn) {
      resetConfirmBtn.addEventListener("click", _emergencyReset);
    }
  });

  // Expose for settings panel
  window.TLIPinLock = { checkAndLock: _checkAndLock };
})();
