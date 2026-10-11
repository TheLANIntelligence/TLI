/* Read-only compatibility checks; restart controls open the separate user review. */
(function (root) {
  'use strict';
  const PROTOCOL = 'dependable-computers-v1';
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  function assess(payload) {
    const r = payload?.release;
    if (payload?.ok !== true || r?.schema_version !== 1 || r.protocol !== PROTOCOL ||
        !hash(r.source_id) || !hash(r.backend_id) || !hash(r.frontend_id) ||
        !Array.isArray(r.capabilities) || !r.capabilities.every(x => typeof x === 'string') ||
        !['matched', 'restart_required', 'unknown'].includes(r.compatibility?.state)) {
      return {state: 'unknown', capabilities: [], message: 'This browser cannot confirm that the running TLI host supports this update. If application files were updated, finish active work and restart TLI normally, then refresh this page.'};
    }
    return {state: r.compatibility.state, capabilities: r.capabilities.slice(), release: r,
      message: r.compatibility.state === 'matched' ? 'The running host matches its application files and supports this browser checkpoint.' :
        r.compatibility.state === 'restart_required' ? 'TLI’s application files changed after this host started. Finish active work, then choose Restart TLI to load the updated code. You will review the restart before it runs. Existing work has not been cancelled.' :
        'TLI could not read its application identity. Check the installation before starting new work.'};
  }
  if (typeof module === 'object' && module.exports) module.exports = {assess, PROTOCOL};
  if (!root.document || !root.fetch) return;
  let pending = null, checked = 0, state = null;
  const $ = id => document.getElementById(id);
  function render(value) {
    const notice = $('tli-release-notice');
    if (notice) notice.hidden = value.state === 'matched';
    if ($('tli-release-title')) $('tli-release-title').textContent = value.state === 'restart_required' ? 'Restart TLI to finish updating' : 'TLI update needs attention';
    for (const id of ['tli-release-restart','settings-release-restart']) if ($(id)) $(id).hidden = value.state !== 'restart_required';
    if ($('tli-release-message')) $('tli-release-message').textContent = value.message;
    if ($('tli-release-detail')) $('tli-release-detail').textContent = value.release ?
      'Running application ' + value.release.source_id.slice(0, 12) + ' · started ' + (value.release.started_at || 'time unavailable') + '. Application identity excludes models and saved data.' :
      'Application identity unavailable. A page refresh alone cannot load new backend code.';
    if ($('settings-release-state')) $('settings-release-state').textContent = value.message;
    if ($('settings-release-identity')) $('settings-release-identity').textContent = value.release ?
      'Running: ' + value.release.source_id + '\nStarted: ' + (value.release.started_at || 'Unknown') +
      '\nFiles now: ' + (value.release.on_disk?.source_id || 'Not reported') +
      '\nChecked: ' + (value.release.checked_at || 'Not reported') : 'Application identity unavailable.';
    root.dispatchEvent(new CustomEvent('tli-release-status', {detail: {state: value.state}}));
  }
  function check(force = false) {
    if (pending) return pending;
    if (!force && state && Date.now() - checked < 10000) return Promise.resolve(state);
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 6000);
    pending = (async () => {
      try {
        const response = await root.fetch('/api/diagnostics/version', {cache: 'no-store', credentials: 'same-origin', signal: abort.signal});
        state = assess(response.ok ? await response.json() : null);
      } catch (_) { state = {state: 'unknown', capabilities: [], message: 'TLI could not confirm the running host version. Check the connection, then choose Check again. No operation was retried.'}; }
      finally { clearTimeout(timer); pending = null; }
      checked = Date.now(); render(state); return state;
    })();
    return pending;
  }
  async function requireCapability(capability) {
    const value = await check();
    if (value.state !== 'matched' || !value.capabilities.includes(capability)) {
      const error = new Error(value.state === 'matched' ? 'The running host does not support this operation. Update the matching TLI installation before continuing.' : value.message);
      error.status = 409; error.code = 'host_version_not_ready'; throw error;
    }
  }
  root.TLIRelease = {check, requireCapability};
  function reviewRestart(event) {
    if (state?.state === 'restart_required') root.TLIHostLifecycle?.open?.('restart', event.currentTarget);
  }
  function init() {
    $('tli-release-recheck')?.addEventListener('click', () => check(true));
    $('settings-release-recheck')?.addEventListener('click', () => check(true));
    $('tli-release-restart')?.addEventListener('click', reviewRestart);
    $('settings-release-restart')?.addEventListener('click', reviewRestart);
    check();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
  root.addEventListener('tli-session-unlocked', () => check(true));
  root.addEventListener('focus', () => { if (!document.hidden && Date.now() - checked > 30000) check(true); });
})(typeof window === 'object' ? window : globalThis);
