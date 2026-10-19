// Installed apps run as opaque local shells. Manifest permissions are requests,
// never grants; no child message can invoke host APIs or browser storage here.
(function () {
  const _appFrames = new Map();
  const _unavailable = 'Host-connected features are unavailable: saved bridge storage, settings, mesh and notifications. Package permissions are declarations, not user grants.';
  let _loading = null, _loadController = null, _epoch = 0, _locked = false, _accessReady = true, _verifiedSession = false;

  function _invalidateLoad() { _loadController?.abort(); _loadController = null; _loading = null; }
  function _clearApps() {
    let wasOpen = false;
    for (const id of _appFrames.keys()) {
      const panel = document.getElementById('panel-app-' + id);
      if (panel && !panel.hidden) wasOpen = true;
      panel?.remove();
    }
    _appFrames.clear();
    document.getElementById('installed-app-list')?.replaceChildren();
    if (wasOpen) window.switchPanel?.('panel-installed-apps');
  }
  function _current(epoch) { return !_locked && _accessReady && epoch === _epoch; }
  function _openApp(id) {
    if (_locked || !_accessReady || !_appFrames.has(id)) return false;
    window.switchPanel?.('panel-app-' + id);
    const frame = _appFrames.get(id);
    if (!frame.getAttribute('src')) frame.src = '/apps/' + encodeURIComponent(id) + '/index.html';
    return true;
  }
  function _validApps(apps) {
    if (!Array.isArray(apps)) return false;
    const ids = new Set();
    return apps.every(app => {
      if (!app || typeof app.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(app.id) || app.id.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(app.id)) return false;
      const key = app.id.toLowerCase();
      if (ids.has(key)) return false;
      ids.add(key);
      return true;
    });
  }
  async function _loadApps(options) {
    if (_locked || !_accessReady) return;
    if (options?.afterMutation === true) {
      // A read started before the change cannot verify its result. Close old
      // documents while checking the new snapshot; recovery restores launchers.
      _epoch++; _invalidateLoad();
      _accessReady = false; _clearApps(); _accessReady = true;
    }
    if (_loading) return _loading;
    const epoch = _epoch;
    const controller = new AbortController(); _loadController = controller;
    const run = async () => {
      const status = document.getElementById('installed-app-status');
      try {
        const response = await fetch('/hub/apps', {cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])});
        if (!_current(epoch)) return;
        if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
        if (!response.ok) {
          let detail;
          try { detail = (await response.json()).detail; } catch (_) { /* Keep the truthful fallback. */ }
          throw new Error(typeof detail === 'string' ? detail : 'Installed apps could not be loaded.');
        }
        const data = await response.json();
        if (!_current(epoch)) return;
        if (!data || !_validApps(data.apps)) throw new Error('The host returned an incomplete app list.');
        const apps = data.apps;
        const list = document.getElementById('installed-app-list'), main = document.querySelector('.main-scroll');
        if (!list || !main) return;
        for (const id of _appFrames.keys()) if (!apps.some(app => app.id === id)) {
          const panel = document.getElementById('panel-app-' + id);
          if (panel && !panel.hidden) window.switchPanel?.('panel-installed-apps');
          panel?.remove(); _appFrames.delete(id);
        }
        list.replaceChildren();
        for (const app of apps) {
          const label = typeof app.name === 'string' ? app.name : app.id;
          const button = document.createElement('button'); button.type = 'button'; button.className = 'simplify-card tli-app-nav-btn'; button.dataset.appId = app.id;
          const copy = document.createElement('span'); copy.className = 'simplify-card-copy';
          const title = document.createElement('strong'); title.textContent = label;
          const desc = document.createElement('span'); desc.textContent = 'Open local app · v' + (app.version || '1.0') + ' · Host-connected features unavailable'; copy.append(title, desc); button.append(copy);
          button.addEventListener('click', () => _openApp(app.id)); list.append(button);
          if (_appFrames.has(app.id)) continue;
          const panel = document.createElement('section'); panel.className = 'panel-container tli-app-panel'; panel.id = 'panel-app-' + app.id; panel.hidden = true;
          const header = document.createElement('div'); header.className = 'tli-app-panel-header';
          const back = document.createElement('button'); back.type = 'button'; back.className = 'btn-outline'; back.textContent = '‹ Installed apps'; back.addEventListener('click', () => window.switchPanel?.('panel-installed-apps'));
          const heading = document.createElement('h2'); heading.className = 'tli-app-panel-title'; heading.textContent = label;
          const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'btn-outline'; reload.textContent = 'Reload app';
          header.append(back, heading, reload); panel.append(header);
          const notice = document.createElement('p'); notice.className = 'muted'; notice.textContent = _unavailable; panel.append(notice);
          const iframe = document.createElement('iframe'); iframe.className = 'tli-app-frame'; iframe.title = label;
          iframe.setAttribute('sandbox', 'allow-scripts'); iframe.setAttribute('referrerpolicy', 'no-referrer'); panel.append(iframe); main.append(panel);
          _appFrames.set(app.id, iframe);
          reload.addEventListener('click', () => { if (!_locked && _accessReady && _appFrames.get(app.id) === iframe && iframe.getAttribute('src')) iframe.src = iframe.src; });
        }
        if (status) status.textContent = apps.length ? apps.length + ' installed app' + (apps.length === 1 ? '' : 's') + '. Choose one to open its local shell. ' + _unavailable : 'No apps installed. Existing packages can be managed in Advanced tools.';
      } catch (error) {
        if (!_current(epoch)) return;
        _clearApps();
        if (status) status.textContent = (error?.message || 'Installed apps could not be loaded.') + ' Apps are closed until their installed files can be verified. Try loading the list again.';
      }
    };
    const pending = run(); _loading = pending;
    try { await pending; } finally { if (_loading === pending) { _loading = null; _loadController = null; } }
  }
  document.addEventListener('tli-panel-switched', event => {
    const id = event.detail?.panelId;
    if (typeof id === 'string' && id.startsWith('panel-app-')) {
      const app = id.slice(10), frame = _appFrames.get(app);
      if (!_locked && _accessReady && frame && !frame.getAttribute('src')) frame.src = '/apps/' + encodeURIComponent(app) + '/index.html';
    }
  });
  window.addEventListener('tli-session-locked', () => {
    _locked = true; _accessReady = false; _verifiedSession = false; _epoch++; _invalidateLoad(); _clearApps();
    const status = document.getElementById('installed-app-status'); if (status) status.textContent = 'Unlock TLI to view installed apps.';
  });
  window.addEventListener('tli-session-unlocked', event => {
    const verified = event?.detail?.source === 'pin-verification';
    if (!_locked && (!verified || _verifiedSession)) return;
    if (verified) _verifiedSession = true;
    _locked = false; _accessReady = false; _epoch++; _invalidateLoad(); _clearApps();
    const status = document.getElementById('installed-app-status'); if (status) status.textContent = 'Waiting for TLI to verify access to installed apps.';
  });
  window.addEventListener('tli-private-observation-ready', () => {
    if (_locked || _accessReady) return;
    _accessReady = true;
    _loadApps();
  });
  function _init() { _loadApps(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();
  // Hub calls reload after an explicit install. Reload only reads metadata;
  // opening or reloading package code always needs a separate user action.
  window.TLIApps = {reload: _loadApps, open: _openApp};
})();
