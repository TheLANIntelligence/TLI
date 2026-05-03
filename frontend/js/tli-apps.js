// TLI APPS RUNTIME — v1
// Fetches installed TLI App packages, injects nav buttons + iframe panels,
// and hosts the postMessage bridge between apps and the TLI shell.
// =====================================================================
(function () {
  // Track which app IDs are already mounted to avoid duplicates on reload
  const _mounted = new Set();

  // Map of appId → { iframe, permissions }
  const _appFrames = {};

  // Per-app namespaced storage prefix
  const _STORE_PREFIX = "tli-app-storage:";

  // ── Bridge API handlers ───────────────────────────────────────────
  const _handlers = {
    "mesh.devices": async function () {
      try {
        const d = await fetch("/mesh/directory").then(function (r) { return r.json(); });
        return d.devices || d.peers || [];
      } catch {
        return [];
      }
    },

    "notifications": function (params) {
      if (typeof showToast === "function") {
        showToast(params.text || "", params.level || "info");
      }
      return { ok: true };
    },

    "settings.read": function () {
      try {
        return JSON.parse(localStorage.getItem("tli_settings") || "{}");
      } catch {
        return {};
      }
    },

    "shell.badge": function (params, appId) {
      const btn = document.querySelector('[data-app-id="' + appId + '"]');
      if (!btn) return { ok: false };
      let badge = btn.querySelector(".tli-app-badge");
      const n = parseInt(params.n, 10) || 0;
      if (n > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "tli-app-badge";
          btn.appendChild(badge);
        }
        badge.textContent = n;
      } else if (badge) {
        badge.remove();
      }
      return { ok: true };
    },

    "storage.local": function (params, appId) {
      const ns = _STORE_PREFIX + appId + ":";
      const key = ns + (params.key || "");
      switch (params.action) {
        case "get":
          try { return { value: JSON.parse(localStorage.getItem(key)) }; }
          catch { return { value: null }; }
        case "set":
          localStorage.setItem(key, JSON.stringify(params.value));
          return { ok: true };
        case "remove":
          localStorage.removeItem(key);
          return { ok: true };
        case "clear": {
          Object.keys(localStorage)
            .filter(function (k) { return k.startsWith(ns); })
            .forEach(function (k) { localStorage.removeItem(k); });
          return { ok: true };
        }
        default:
          return { error: "Unknown storage action: " + params.action };
      }
    },
  };

  // ── postMessage bridge listener ───────────────────────────────────
  window.addEventListener("message", async function (e) {
    if (!e.data || !e.source) return;

    // App announces itself — send ready signal with granted permissions
    if (e.data.type === "tli-app-ready") {
      for (const [appId, info] of Object.entries(_appFrames)) {
        if (info.iframe && info.iframe.contentWindow === e.source) {
          e.source.postMessage(
            { type: "tli-bridge-ready", permissions: info.permissions },
            "*"
          );
          break;
        }
      }
      return;
    }

    if (e.data.type !== "tli-bridge") return;

    const { id, method, params } = e.data;

    // Find source app
    let sourceAppId = null;
    for (const [appId, info] of Object.entries(_appFrames)) {
      if (info.iframe && info.iframe.contentWindow === e.source) {
        sourceAppId = appId;
        break;
      }
    }
    if (!sourceAppId) return;

    const info = _appFrames[sourceAppId];

    // Badge calls are fire-and-forget, no response needed
    if (method === "shell.badge") {
      _handlers["shell.badge"](params || {}, sourceAppId);
      return;
    }

    // Permission check
    if (!info.permissions.includes(method)) {
      e.source.postMessage(
        { type: "tli-bridge-response", id: id, error: "Permission denied: " + method },
        "*"
      );
      return;
    }

    // Dispatch to handler
    try {
      const handler = _handlers[method];
      if (!handler) {
        e.source.postMessage(
          { type: "tli-bridge-response", id: id, error: "Unknown method: " + method },
          "*"
        );
        return;
      }
      const result = await handler(params || {}, sourceAppId);
      e.source.postMessage(
        { type: "tli-bridge-response", id: id, result: result },
        "*"
      );
    } catch (err) {
      e.source.postMessage(
        { type: "tli-bridge-response", id: id, error: err.message },
        "*"
      );
    }
  });

  // ── App loader ────────────────────────────────────────────────────
  async function _loadApps() {
    let apps = [];
    try {
      const d = await fetch("/hub/apps").then(function (r) { return r.json(); });
      apps = d.apps || [];
    } catch {
      return;
    }

    if (!apps.length) return;

    const sidebar   = document.querySelector(".sidebar-nav");
    const mainScroll = document.querySelector(".main-scroll");
    if (!sidebar || !mainScroll) return;

    // Insert new app nav buttons before the Settings button
    const settingsBtn = sidebar.querySelector('[data-panel-target="panel-settings"]');

    apps.forEach(function (app) {
      if (_mounted.has(app.id)) return;  // already injected
      _mounted.add(app.id);

      const panelId = "panel-app-" + app.id;

      // ── Nav button ──────────────────────────────────────────────
      const btn = document.createElement("button");
      btn.className = "side-nav-button tli-app-nav-btn";
      btn.dataset.panelTarget = panelId;
      btn.dataset.appId = app.id;
      btn.innerHTML =
        '<div class="side-nav-button-icon">' + (app.icon || "📦") + "</div>" +
        "<span>" + app.name + "</span>";

      if (settingsBtn) sidebar.insertBefore(btn, settingsBtn);
      else sidebar.appendChild(btn);

      // ── Panel + iframe ──────────────────────────────────────────
      const panel = document.createElement("section");
      panel.className = "panel-container tli-app-panel";
      panel.id = panelId;
      panel.hidden = true;

      const appHeader = document.createElement("div");
      appHeader.className = "tli-app-panel-header";
      appHeader.innerHTML =
        '<span class="tli-app-panel-title">' + (app.icon || "📦") + " " + app.name + "</span>" +
        '<span class="tli-app-panel-version">v' + (app.version || "1.0") + " · " + (app.author || "Unknown") + "</span>" +
        '<button class="pill-btn ghost tli-app-panel-reload" title="Reload app">↺</button>';
      panel.appendChild(appHeader);

      const iframe = document.createElement("iframe");
      iframe.className = "tli-app-frame";
      iframe.src = "/apps/" + app.id + "/index.html";
      iframe.title = app.name;
      // allow-same-origin needed for /tli-bridge.js fetch to work
      iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
      panel.appendChild(iframe);
      mainScroll.appendChild(panel);

      _appFrames[app.id] = {
        iframe: iframe,
        permissions: app.permissions || [],
      };

      // Reload button in panel header
      appHeader.querySelector(".tli-app-panel-reload").addEventListener("click", function () {
        iframe.src = iframe.src;
      });

      // ── Nav click handler ───────────────────────────────────────
      btn.addEventListener("click", function () {
        document.querySelectorAll(".panel-container").forEach(function (p) {
          p.hidden = true;
          p.classList.remove("active");
        });
        document.querySelectorAll(".side-nav-button").forEach(function (b) {
          b.classList.remove("active");
        });
        panel.hidden = false;
        panel.classList.add("active");
        btn.classList.add("active");
        document.dispatchEvent(
          new CustomEvent("tli-panel-switched", { detail: { panelId: panelId } })
        );
      });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────
  function _init() {
    _loadApps();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }

  // ── Public API (hub.js calls this after app install) ──────────────
  window.TLIApps = {
    reload: _loadApps,
  };
})();
