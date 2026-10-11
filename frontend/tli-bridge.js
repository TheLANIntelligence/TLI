// TLI App Bridge — v1
// Include this script inside a TLI App iframe:
//   <script src="/tli-bridge.js"></script>
//
// Then use TLIBridge.call(method, params) to access TLI APIs
// that the app declared in its manifest permissions array.
//
// Available methods (permission required in manifest):
//   "mesh.devices"   — returns array of mesh peer objects
//   "mesh.presence"  — future: subscribe to join/leave events
//   "settings.read"  — returns TLI localStorage settings object
//   "notifications"  — show a TLI toast: { text, level }
//   "shell.badge"    — set badge number on nav icon: { n }
//   "storage.local"  — namespaced key/value: { action, key, value }
//
// Example:
//   TLIBridge.ready(() => {
//     TLIBridge.getMeshDevices().then(devices => console.log(devices));
//   });

(function (global) {
  let _reqId = 0;
  const _pending = {};
  const _readyCallbacks = [];
  let _ready = false;
  let _permissions = [];

  // ── Response handler ──────────────────────────────────────────────
  window.addEventListener("message", function (e) {
    if (!e.data) return;

    // Ready signal from TLI shell
    if (e.data.type === "tli-bridge-ready") {
      _permissions = e.data.permissions || [];
      _ready = true;
      _readyCallbacks.forEach(function (fn) { fn(_permissions); });
      _readyCallbacks.length = 0;
      return;
    }

    // API response
    if (e.data.type === "tli-bridge-response") {
      const p = _pending[e.data.id];
      if (!p) return;
      delete _pending[e.data.id];
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    }
  });

  // ── Public API ────────────────────────────────────────────────────
  global.TLIBridge = {
    /**
     * Register a callback to run when the TLI shell has acknowledged
     * this app and sent its granted permissions.
     */
    ready: function (fn) {
      if (_ready) { fn(_permissions); }
      else { _readyCallbacks.push(fn); }
    },

    /**
     * Call a TLI shell API method.
     * @param {string} method  — e.g. "mesh.devices"
     * @param {object} params  — method-specific parameters
     * @returns {Promise}
     */
    call: function (method, params) {
      return new Promise(function (resolve, reject) {
        const id = "tli-" + (++_reqId);
        _pending[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage(
          { type: "tli-bridge", id: id, method: method, params: params || {} },
          "*"
        );
        // Auto-reject after 8 seconds
        setTimeout(function () {
          if (_pending[id]) {
            delete _pending[id];
            reject(new Error("TLI Bridge timeout: " + method));
          }
        }, 8000);
      });
    },

    /** Convenience: show a TLI toast notification */
    notify: function (text, level) {
      return this.call("notifications", { text: text, level: level || "info" });
    },

    /** Convenience: get all mesh peers */
    getMeshDevices: function () {
      return this.call("mesh.devices");
    },

    /** Convenience: read TLI settings */
    getSettings: function () {
      return this.call("settings.read");
    },

    /**
     * Set a number badge on this app's nav icon.
     * Pass 0 to clear the badge.
     */
    setBadge: function (n) {
      window.parent.postMessage(
        { type: "tli-bridge", id: "badge-" + Date.now(), method: "shell.badge", params: { n: n } },
        "*"
      );
    },

    /**
     * Namespaced local storage for this app.
     * action: "get" | "set" | "remove" | "clear"
     */
    storage: function (action, key, value) {
      return this.call("storage.local", { action: action, key: key, value: value });
    },
  };

  // Announce presence to TLI shell so it can send the ready signal
  window.parent.postMessage(
    { type: "tli-app-ready", href: window.location.href },
    "*"
  );
})(window);
