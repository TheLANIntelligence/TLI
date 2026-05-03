/* =============================================================
   Global 401 interceptor — auto-relock on session expiry
   Monkey-patches window.fetch so any 401 from the backend
   immediately shows the lock screen without user action.
   ============================================================= */
(function () {
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await _origFetch.apply(this, args);
    if (resp.status === 401) {
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
