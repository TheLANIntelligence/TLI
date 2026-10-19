// TLI App Bridge — isolated local-shell compatibility shim.
// The host injects this shim before package scripts. Package declarations do
// not grant authority. Saved bridge storage remains untouched and unavailable.
(function (global) {
  const permissions = Object.freeze([]);
  const unavailable = function () {
    return Promise.reject(new Error('Host-connected app features are unavailable. Package permissions are requests, not user grants.'));
  };
  global.TLIBridge = Object.freeze({
    available: false,
    ready: function (fn) {
      if (typeof fn !== 'function') return;
      const notify = function () { fn(permissions); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notify, {once: true});
      else Promise.resolve().then(notify);
    },
    call: unavailable,
    notify: unavailable,
    getMeshDevices: unavailable,
    getSettings: unavailable,
    setBadge: unavailable,
    storage: unavailable,
  });
})(window);
