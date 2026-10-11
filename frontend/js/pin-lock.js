/* =============================================================
   TLI PIN Lock
   - Checks /system/pin/status on load.
   - If PIN is enabled and no valid session → show lock screen.
   - Session stored in sessionStorage (auto-clears on tab close).
   - Lock button in header re-locks the session.
   ============================================================= */
(function () {
  const SS_KEY = "tli_session_unlocked";
  let _generation = 0, _verificationGeneration = 0, _checking = null, _submitting = false, _locking = null, _verifyRequest = null;

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
    window.dispatchEvent(new CustomEvent('tli-session-locked'));
  }

  // An expired browser session must reveal PIN entry immediately. Waiting for
  // another status read can reuse an older in-flight check whose result was
  // invalidated by this same lock event, leaving an unusable app on screen.
  window.addEventListener('tli-session-locked', () => {
    _generation++; _setUnlocked(false);
    const s = _lockScreen();
    if (s) { s.classList.remove("hidden"); s.removeAttribute("hidden"); s.setAttribute("aria-hidden", "false"); }
    document.body.style.overflow = "hidden";
    setTimeout(() => { const i = _lockInput(); if (i) i.focus(); }, 120);
  });

  function _hideLock() {
    const s = _lockScreen();
    if (s) { s.classList.add("hidden"); s.setAttribute("aria-hidden", "true"); }
    document.body.style.overflow = "";
    const b = _lockBtn();
    if (b) b.hidden = false;
    // Resume authenticated views only after confirmed PIN verification or an
    // explicit server response that PIN protection is disabled.
    window.dispatchEvent(new CustomEvent('tli-session-unlocked'));
  }

  function _accessUnavailable(message) {
    _verificationGeneration++;
    _setUnlocked(false); _showLock();
    const error = _lockError(); if (error) error.textContent = message + (message.includes('Access remains locked') ? '' : ' Access remains locked.');
    const retry = document.getElementById('tli-lock-recheck'); if (retry) retry.hidden = false;
  }

  function _checkAndLock() {
    // An explicit verification is the current access check. Background reads
    // still fail closed, but must not replace its outcome or clear its error.
    if (_submitting) return Promise.resolve();
    if (_checking) return _checking;
    const generation = _generation;
    _checking = (async () => {
      try {
        const r = await fetch("/system/pin/status", { cache: "no-store" });
        const d = await r.json().catch(() => null);
        if (generation !== _generation) return;
        if (!r.ok) throw new Error((typeof d?.detail === 'string' ? d.detail : `TLI could not confirm access status (${r.status}).`) + ' Access remains locked.');
        if (typeof d?.enabled !== 'boolean') throw new Error('TLI returned an invalid access status. Access remains locked. Recheck before continuing.');
        const retry = document.getElementById('tli-lock-recheck'); if (retry) retry.hidden = true;
        const error = _lockError(); if (error) error.textContent = '';
        if (d.enabled && !_isUnlocked()) {
          _showLock();
        } else if (d.enabled === false) {
          _hideLock();
          const b = _lockBtn(); if (b) b.hidden = true;
          _suggestPin();
        } else {
          const b = _lockBtn(); if (b) b.hidden = false;
        }
      } catch (error) {
        if (generation === _generation) _accessUnavailable(error.message || 'Could not reach TLI to confirm access status. Access remains locked. Reconnect to the host and recheck.');
      }
    })().finally(() => { _checking = null; });
    return _checking;
  }

  async function _submitPin() {
    if (_submitting || _locking) return;
    const input = _lockInput();
    const errEl = _lockError();
    const pin = input ? input.value : "";
    if (!pin) { if (errEl) errEl.textContent = "Enter your PIN."; return; }
    ++_generation;
    // Old unauthenticated polls may finish while this new PIN is being checked.
    // Only an explicit lock or security recovery may cancel this attempt.
    const verificationGeneration = ++_verificationGeneration;
    const submit = document.getElementById('tli-lock-submit');
    _submitting = true; if (submit) submit.disabled = true;
    try {
      _verifyRequest = fetch("/system/pin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const r = await _verifyRequest;
      const result = await r.json().catch(() => null);
      if (verificationGeneration !== _verificationGeneration) return;
      if (r.ok && result?.ok === true) {
        _setUnlocked(true);
        if (input) input.value = "";
        if (errEl) errEl.textContent = "";
        _hideLock();
      } else {
        _accessUnavailable(typeof result?.detail === 'string' ? result.detail : r.ok ? 'TLI did not confirm the PIN. Access remains locked.' : `The PIN could not be verified (${r.status}). Access remains locked.`);
        if (input) { input.value = ""; input.focus(); }
      }
    } catch {
      if (verificationGeneration === _verificationGeneration) _accessUnavailable('Could not reach TLI to verify the PIN. Access remains locked. Reconnect and try again.');
    } finally { _verifyRequest = null; _submitting = false; if (submit) submit.disabled = !!_locking; }
  }

  async function _verifyForSetup(pin) {
    if (_submitting || _locking) throw new Error('Another access request is in progress. Wait for it to finish and try again.');
    if (typeof pin !== 'string' || !pin) throw new Error('Enter your saved PIN to continue.');
    ++_generation;
    const verificationGeneration = ++_verificationGeneration;
    const submit = document.getElementById('tli-lock-submit');
    _submitting = true; if (submit) submit.disabled = true;
    try {
      // Share the normal verification barrier so an explicit browser lock
      // waits for this response's cookie before revoking the session.
      _verifyRequest = fetch('/system/pin/verify', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
      });
      let response;
      try { response = await _verifyRequest; }
      catch { throw new Error('Could not reach TLI to verify your saved PIN. Check the connection and try again.'); }
      const result = await response.json().catch(() => null);
      if (verificationGeneration !== _verificationGeneration) throw new Error('PIN verification was cancelled because browser access was locked. Unlock TLI to continue setup.');
      if (!response.ok || result?.ok !== true) {
        const message = typeof result?.detail === 'string' ? result.detail : response.ok
          ? 'TLI did not confirm your PIN. Enter your saved PIN and try again.'
          : `Your saved PIN could not be verified (${response.status}). Try again.`;
        _setUnlocked(false);
        if (response.status === 401 || response.status === 503) _accessUnavailable(message);
        throw new Error(message);
      }
      _setUnlocked(true);
      const error = _lockError(); if (error) error.textContent = '';
      document.querySelectorAll('.tli-pin-nudge').forEach(nudge => nudge.remove());
      _hideLock();
      return true;
    } catch (error) {
      if (verificationGeneration === _verificationGeneration) _setUnlocked(false);
      throw error;
    } finally {
      _verifyRequest = null; _submitting = false;
      if (submit) submit.disabled = !!_locking;
    }
  }

  function _lock() {
    if (_locking) return _locking;
    _verificationGeneration++;
    _generation++; _setUnlocked(false); _showLock();
    const submit = document.getElementById('tli-lock-submit');
    if (submit) submit.disabled = true;
    const error = _lockError(); if (error) error.textContent = 'Locking this browser session…';
    const retryLock = document.getElementById('tli-lock-retry'); if (retryLock) retryLock.hidden = true;
    const verification = _verifyRequest;
    _locking = (async () => {
      // A late unlock response can set a new HTTP-only cookie even when its UI
      // result is stale. Wait for it before revoking this browser's cookie.
      if (verification) await verification.catch(() => null);
      try {
        const response = await fetch('/system/pin/lock', { method: 'POST', credentials: 'same-origin' });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.ok !== true || result.locked !== true) throw new Error(typeof result?.detail === 'string' ? result.detail : 'TLI did not confirm the browser session was revoked.');
        if (error) error.textContent = 'Browser session locked. Enter your PIN to continue.';
        return result;
      } catch (failure) {
        const message = (failure?.message || 'Could not reach TLI.') + ' This view is locked, but the server session may still be active. Recheck the connection and explicitly lock again.';
        _accessUnavailable(message);
        if (retryLock) retryLock.hidden = false;
        throw new Error(message);
      }
    })().finally(() => { _locking = null; if (submit) submit.disabled = _submitting; });
    return _locking;
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

  document.addEventListener("DOMContentLoaded", () => {
    const retry = document.createElement('button'); retry.id = 'tli-lock-recheck'; retry.type = 'button'; retry.className = 'btn-outline';
    retry.textContent = 'Recheck access status'; retry.hidden = true; retry.addEventListener('click', _checkAndLock);
    _lockError()?.after(retry);
    const retryLock = document.createElement('button'); retryLock.id = 'tli-lock-retry'; retryLock.type = 'button'; retryLock.className = 'btn-outline';
    retryLock.textContent = 'Retry browser lock'; retryLock.hidden = true;
    retryLock.addEventListener('click', () => _lock().catch(() => {})); retry.after(retryLock);
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
      lockBtn.addEventListener("click", () => _lock().catch(() => {}));
    }

    // Forgot PIN flow
    const forgotBtn = document.getElementById("tli-lock-forgot");
    const resetPanel = document.getElementById("tli-lock-reset-panel");
    const resetConfirmBtn = document.getElementById("tli-lock-reset-confirm-btn");
    const resetCancelBtn = document.getElementById("tli-lock-reset-cancel-btn");
    const recovery = resetPanel?.querySelector('.tli-lock-reset-warn');
    if (recovery) recovery.textContent = 'This screen cannot remove or bypass your PIN. If saved security files are unavailable, stop TLI and preserve the existing files. Restore a matching backup using the original operating-system account; Windows-protected keys may also require the original computer. Do not run setup over this installation.';
    if (resetCancelBtn) resetCancelBtn.textContent = 'Back to PIN';

    if (forgotBtn && resetPanel) {
      forgotBtn.addEventListener("click", () => {
        resetPanel.classList.remove("hidden");
        resetPanel.setAttribute("aria-hidden", "false");
        forgotBtn.setAttribute("aria-expanded", "true");
        forgotBtn.style.display = "none";
        if (resetCancelBtn) resetCancelBtn.focus();
      });
    }
    if (resetCancelBtn && resetPanel) {
      resetCancelBtn.addEventListener("click", () => {
        resetPanel.classList.add("hidden");
        resetPanel.setAttribute("aria-hidden", "true");
        if (forgotBtn) forgotBtn.setAttribute("aria-expanded", "false");
        if (forgotBtn) forgotBtn.style.display = "";
        if (forgotBtn) forgotBtn.focus();
      });
    }
    if (resetConfirmBtn) {
      resetConfirmBtn.textContent = 'Recheck access status'; resetConfirmBtn.className = 'btn btn-outline btn-sm';
      resetConfirmBtn.addEventListener("click", _checkAndLock);
    }
  });

  // Expose for settings panel
  window.TLIPinLock = { checkAndLock: _checkAndLock, lock: _lock, showRecovery: _accessUnavailable, verifyForSetup: _verifyForSetup };
})();
