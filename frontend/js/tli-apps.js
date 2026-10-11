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
    if (_locked || !e.data || !e.source) return;
    const epoch = _epoch;

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
      if (_locked || epoch !== _epoch || _appFrames[sourceAppId] !== info || !info.permissions.includes(method)) return;
      e.source.postMessage(
        { type: "tli-bridge-response", id: id, result: result },
        "*"
      );
    } catch (err) {
      if (_locked || epoch !== _epoch || _appFrames[sourceAppId] !== info) return;
      e.source.postMessage(
        { type: "tli-bridge-response", id: id, error: err.message },
        "*"
      );
    }
  });

  // ── App loader ────────────────────────────────────────────────────
  let _loading = null, _loadController = null, _epoch = 0, _locked = false;
  function _invalidateLoad() { _loadController?.abort(); _loadController = null; _loading = null; }
  function _clearApps() {
    for (const id of _mounted) { document.getElementById('panel-app-' + id)?.remove(); delete _appFrames[id]; }
    _mounted.clear(); document.getElementById('installed-app-list')?.replaceChildren();
  }
  function _openApp(id) {
    if (_locked || !_mounted.has(id)) return false;
    window.switchPanel?.('panel-app-' + id);
    const frame = _appFrames[id]?.iframe;
    if (frame && !frame.getAttribute('src')) frame.src = '/apps/' + encodeURIComponent(id) + '/index.html';
    return true;
  }
  async function _loadApps() {
    if (_locked) return;
    if (_loading) return _loading;
    const epoch = _epoch;
    const controller = new AbortController(); _loadController = controller;
    const run = async () => {
      const status = document.getElementById('installed-app-status');
      try {
        const response = await fetch('/hub/apps', {cache:'no-store', signal:AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])});
        if (_locked || epoch !== _epoch) return;
        if (response.status === 401) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
        if (!response.ok) throw new Error('Installed apps could not be loaded.');
        const data = await response.json();
        if (!Array.isArray(data.apps)) throw new Error('The host returned an incomplete app list.');
        if (_locked || epoch !== _epoch) return;
        const apps = data.apps.filter(app => app && typeof app.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(app.id));
        const list = document.getElementById('installed-app-list'), main = document.querySelector('.main-scroll');
        if (!list || !main) return;
        for (const id of [..._mounted]) if (!apps.some(app => app.id === id)) {
          const panel = document.getElementById('panel-app-' + id);
          if (panel && !panel.hidden) window.switchPanel?.('panel-installed-apps');
          panel?.remove(); _mounted.delete(id); delete _appFrames[id];
        }
        list.replaceChildren();
        for (const app of apps) {
          const label = typeof app.name === 'string' ? app.name : app.id;
          const button = document.createElement('button'); button.type = 'button'; button.className = 'simplify-card tli-app-nav-btn'; button.dataset.appId = app.id;
          const copy = document.createElement('span'); copy.className = 'simplify-card-copy';
          const title = document.createElement('strong'); title.textContent = label;
          const desc = document.createElement('span'); desc.textContent = 'Open app · v' + (app.version || '1.0'); copy.append(title, desc); button.append(copy);
          button.addEventListener('click', () => _openApp(app.id)); list.append(button);
          if (_mounted.has(app.id)) {
            _appFrames[app.id].permissions = Array.isArray(app.permissions) ? app.permissions : [];
            continue;
          }
          _mounted.add(app.id);
          const panel = document.createElement('section'); panel.className = 'panel-container tli-app-panel'; panel.id = 'panel-app-' + app.id; panel.hidden = true;
          const header = document.createElement('div'); header.className = 'tli-app-panel-header';
          const back = document.createElement('button'); back.type = 'button'; back.className = 'btn-outline'; back.textContent = '‹ Installed apps'; back.addEventListener('click', () => window.switchPanel?.('panel-installed-apps'));
          const heading = document.createElement('h2'); heading.className = 'tli-app-panel-title'; heading.textContent = label;
          const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'btn-outline'; reload.textContent = 'Reload app';
          header.append(back, heading, reload); panel.append(header);
          const iframe = document.createElement('iframe'); iframe.className = 'tli-app-frame'; iframe.title = label;
          iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin'); panel.append(iframe); main.append(panel);
          _appFrames[app.id] = {iframe, permissions:Array.isArray(app.permissions) ? app.permissions : []};
          reload.addEventListener('click', () => { if (!_locked && iframe.getAttribute('src')) iframe.src = iframe.src; });
        }
        if (status) status.textContent = apps.length ? apps.length + ' installed app' + (apps.length === 1 ? '' : 's') + '. Choose one to open it.' : 'No apps installed. Existing packages can be managed in Advanced tools.';
      } catch (error) { if (epoch === _epoch && status) status.textContent = error.message + ' Previously loaded apps are retained.'; }
    };
    const pending = run(); _loading = pending;
    try { await pending; } finally { if (_loading === pending) { _loading = null; _loadController = null; } }
  }
  document.addEventListener('tli-panel-switched', event => {
    const id = event.detail?.panelId;
    if (typeof id === 'string' && id.startsWith('panel-app-')) {
      const app = id.slice(10), frame = _appFrames[app]?.iframe;
      if (!_locked && frame && !frame.getAttribute('src')) frame.src = '/apps/' + encodeURIComponent(app) + '/index.html';
    }
  });
  window.addEventListener('tli-session-locked', () => { _locked = true; _epoch++; _invalidateLoad(); _clearApps(); const status = document.getElementById('installed-app-status'); if (status) status.textContent = 'Unlock TLI to view installed apps.'; });
  window.addEventListener('tli-session-unlocked', () => { _locked = false; _epoch++; _invalidateLoad(); if (!document.querySelector('.panel-container:not([hidden])')) window.switchPanel?.('panel-installed-apps'); else if (!document.getElementById('panel-installed-apps')?.hidden) _loadApps(); });

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
    open: _openApp,
  };
})();
