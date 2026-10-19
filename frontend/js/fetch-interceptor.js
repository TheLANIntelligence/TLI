/* =============================================================
   Global 401 interceptor — auto-relock on session expiry
   Monkey-patches window.fetch so any 401 from the backend
   immediately shows the lock screen without user action.
   ============================================================= */
(function () {
  const _origFetch = window.fetch;
  // A response belongs to the PIN session in which its request began. The
  // backend still rejects that old request, but it must not relock a later
  // session (or clear its newly edited drafts) after lock and unlock.
  let sessionGeneration = 0;
  for (const event of ['tli-session-locked','tli-session-unlocked','tli-account-changed','tli-user-changed','pagehide']) {
    window.addEventListener(event, () => { sessionGeneration++; });
  }
  function isLocalMCPGrantRequest(input, init) {
    // MCP grants have an independent, shorter lifetime. Their 401 must clear
    // only the inspector, not unrelated unsaved browser work. Management
    // routes, sibling URLs and every ordinary browser request still relock.
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
      const headers = new Headers(init?.headers ?? input?.headers);
      return url.origin === window.location.origin && url.pathname === '/api/mcp'
        && /^Bearer tlim_[A-Za-z0-9_-]{40,64}$/i.test(headers.get('Authorization') || '');
    } catch (_) { return false; }
  }
  window.fetch = async function (...args) {
    const generation = sessionGeneration;
    const independentMCPGrant = isLocalMCPGrantRequest(args[0], args[1]);
    const resp = await _origFetch.apply(this, args);
    if (resp.status === 401 && !independentMCPGrant && generation === sessionGeneration) {
      window.dispatchEvent(new CustomEvent('tli-session-locked'));
      // Clone so the caller can still read the body if needed
      const clone = resp.clone();
      // Show lock screen
      if (window.TLIPinLock && typeof window.TLIPinLock.checkAndLock === "function") {
        window.TLIPinLock.checkAndLock();
      }
      return clone;
    }
    return resp;
  };
})();
