// Guided updates: download and verify a package, then let the user install it.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const states = ['idle', 'checking', 'up_to_date', 'available', 'downloading', 'verifying', 'preparing', 'ready', 'error'];
  const working = ['checking', 'downloading', 'verifying', 'preparing'];
  const manualURL = 'https://github.com/TheLANIntelligence/TLI/releases';
  let status = null, busy = false, timer = null, refreshing = false, lastKnownVersion = '';
  const dismissedVersions = new Set();
  const releaseVersion = version => typeof version === 'string' ? version.trim().replace(/^v/i, '') : '';
  let startupPoll = true, stopped = false, revision = 0, actionError = '', connectionError = '';
  let settingsConfirmed = false, savedAutoCheck = null;
  const set = (id, value) => { if ($(id)) $(id).textContent = value; };
  const hide = (id, value) => { if ($(id)) $(id).hidden = value; };
  const toast = (message, type = 'error') => { if (typeof showToast === 'function') showToast(message, type); };
  const localDesktop = () => {
    try {
      const url = new URL(window.location.href);
      return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase()) &&
        navigator.userAgentData?.mobile !== true && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    } catch { return false; }
  };
  let settingsSaveStatus = $('settings-update-save-status');
  if (!settingsSaveStatus && $('settings-update-url-save')) {
    settingsSaveStatus = document.createElement('div');
    settingsSaveStatus.id = 'settings-update-save-status';
    settingsSaveStatus.className = 'small-meta';
    settingsSaveStatus.setAttribute('role', 'status');
    $('settings-update-url-save').parentElement?.after(settingsSaveStatus);
  }
  function settingsMessage(message) { if (settingsSaveStatus) settingsSaveStatus.textContent = message; }
  function showHostVersion(version) {
    const text = typeof version === 'string' && version.trim() ? 'v' + version.trim().replace(/^v/, '') : 'Unavailable';
    set('settings-tli-version', text);
    set('version-pill-settings', text);
  }
  function loadPreferences(data) {
    showHostVersion(data?.current_version);
    if (data && typeof data === 'object' && !Object.prototype.hasOwnProperty.call(data, 'auto_check')) {
      const error = Error('The host does not report its saved automatic-update preference.');
      error.code = 'missing_saved_preference';
      throw error;
    }
    if (typeof data?.auto_check !== 'boolean' || typeof data?.update_url !== 'string') throw Error('Invalid saved update preferences.');
    if ($('settings-update-url')) $('settings-update-url').value = data.update_url;
    savedAutoCheck = data.auto_check;
    if ($('settings-update-auto-check')) { $('settings-update-auto-check').checked = data.auto_check; $('settings-update-auto-check').disabled = false; }
    settingsConfirmed = true;
    if ($('settings-update-url-save')) $('settings-update-url-save').disabled = false;
    settingsMessage('Saved update preferences loaded from this host.');
  }
  function preferencesUnavailable(error) {
    settingsConfirmed = false;
    if ($('settings-update-url-save')) $('settings-update-url-save').disabled = true;
    if ($('settings-update-auto-check')) $('settings-update-auto-check').disabled = true;
    settingsMessage(error.code === 'missing_saved_preference'
      ? 'This host does not report saved automatic-update preferences. Use matching TLI app and host files; if host files were updated, restart TLI normally, then refresh. Saving is disabled to preserve your choice.'
      : 'Saved update preferences are unavailable. Reconnect to the host, then refresh TLI to recheck before changing them.');
  }
  async function request(path, method = 'GET', body = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      ...(method === 'POST' ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    let data;
    try { data = await response.json(); } catch { throw Error('The host returned an unreadable update response.'); }
    if (!response.ok) throw Error(typeof data?.detail === 'string' ? data.detail : `The update request failed (${response.status}).`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('The host returned an invalid update response.');
    return data;
  }
  function applyStatus(data) {
    if (!states.includes(data?.state) || (['available', 'ready'].includes(data.state) && (typeof data.latest_version !== 'string' || !data.latest_version.trim()))) {
      throw Error('The host returned an unsupported update status. Check that the app and host files match.');
    }
    if (!settingsConfirmed) { try { loadPreferences(data); } catch (error) { preferencesUnavailable(error); } }
    if (status?.state !== data.state || status?.latest_version !== data.latest_version) actionError = '';
    if (releaseVersion(data.latest_version)) lastKnownVersion = releaseVersion(data.latest_version);
    status = data;
    connectionError = '';
    render();
  }
  function action() {
    if (connectionError || status?.state === 'error') return 'check';
    if (status?.state === 'available' && status.can_prepare === true && localDesktop()) return 'prepare';
    if (status?.state === 'ready' && status.can_open === true && localDesktop()) return 'open';
    return null;
  }
  function render() {
    const d = status || {}, state = d.state || 'idle', active = working.includes(state) && !connectionError, ready = state === 'ready';
    const progress = Number.isFinite(d.progress) ? Math.min(100, Math.max(0, d.progress)) : 0;
    const version = typeof d.latest_version === 'string' ? 'v' + d.latest_version.replace(/^v/, '') : '';
    if (status) showHostVersion(d.current_version);
    const labels = { idle: 'Check for a newer TLI release.', checking: 'Checking for updates…', up_to_date: 'Up to date',
      available: `Update available: ${version}`, downloading: `Downloading… ${progress}%`, verifying: 'Verifying download…',
      preparing: 'Preparing update folder…', ready: `${version} downloaded — installation pending`, error: 'Update could not be prepared' };
    set('settings-update-state', connectionError ? 'Update status unavailable' : labels[state]);
    if ($('settings-update-state')) $('settings-update-state').style.color = connectionError || state === 'error' ? 'var(--danger, #f87171)' : 'var(--text-muted)';
    const platform = { windows: 'Windows', win32: 'Windows', mac: 'macOS', macos: 'macOS', darwin: 'macOS', linux: 'Linux' }[d.platform] || d.platform || 'Not reported';
    set('settings-update-platform', 'Update platform: ' + platform);
    const checked = typeof d.checked_at === 'string' ? new Date(d.checked_at) : null;
    set('settings-update-checked', checked && Number.isFinite(checked.getTime()) ? 'Last checked: ' + checked.toLocaleString() : 'Last checked: not yet');
    const checkError = typeof d.last_check_error === 'string' && d.last_check_error ? 'Automatic update check could not finish: ' + d.last_check_error : '';
    let message = connectionError || actionError || (state === 'error' ? d.error : '') || checkError || d.message || '';
    if (!message && state === 'available') message = d.can_prepare === true ? 'Download the verified package here. Finish installation after quitting TLI.' : 'Get this release from the download page and follow its update instructions.';
    if (state === 'available' && d.can_prepare === true && !localDesktop()) message = 'Open TLI in a local desktop browser on the host computer (localhost) to download this update and finish installation.';
    if (ready && !localDesktop()) message += ' Open TLI in a local desktop browser on the host computer (localhost) to open the update folder and finish installation.';
    set('settings-update-message', message);
    hide('settings-update-ready', !ready);
    set('settings-update-path', typeof d.ready_path === 'string' ? 'Update folder: ' + d.ready_path : '');
    const mac = ['mac', 'macos', 'darwin'].includes(d.platform);
    set('settings-update-installer', mac ? 'Run TLI_Update.command in that folder.' : d.platform === 'linux' ? 'Run TLI_Update.sh in that folder.' : 'Run TLI_Update.bat in that folder.');
    set('settings-update-stop', mac || d.platform === 'linux'
      ? 'Finish active work, then press Control+C in the Terminal window that started TLI. Stop any optional Host Start helper too. Closing this browser alone does not stop TLI.'
      : 'Finish active work, then choose Quit TLI below and review the confirmation. If TLI was started in a terminal, stop it there with Ctrl+C. Stop any optional Host Start helper too. Closing this browser alone does not stop TLI.');
    hide('settings-update-quit-btn', !ready || !localDesktop() || mac || d.platform === 'linux');
    if ($('settings-update-quit-btn')) $('settings-update-quit-btn').disabled = busy || !window.TLIHostLifecycle?.open;
    const next = action(), actionText = next === 'open' ? 'Open update folder' : next === 'check' ? 'Retry check' : 'Download update';
    for (const id of ['settings-update-action-btn', 'tli-update-apply-btn']) {
      hide(id, !next);
      if ($(id)) { $(id).disabled = busy || active; $(id).textContent = busy ? 'Please wait…' : actionText; }
    }
    if ($('settings-check-update-btn')) {
      $('settings-check-update-btn').disabled = busy || active;
      $('settings-check-update-btn').textContent = state === 'checking' ? 'Checking…' : 'Check for updates';
    }
    const manual = (state === 'available' && d.can_prepare !== true) || state === 'error' || !!checkError || !!connectionError;
    for (const id of ['settings-update-manual-link', 'tli-update-manual-link']) {
      hide(id, !manual);
      if ($(id)) $(id).href = manualURL;
    }
    for (const id of ['settings-update-progress-wrap', 'tli-update-progress-wrap']) hide(id, !active);
    if ($('settings-update-progress')) $('settings-update-progress').value = progress;
    set('settings-update-progress-label', labels[state]);
    if ($('tli-update-progress-bar')) $('tli-update-progress-bar').style.setProperty('--w', progress + '%');
    set('tli-update-progress-label', labels[state]);
    hide('tli-update-banner', dismissedVersions.has(releaseVersion(d.latest_version) || lastKnownVersion) || !['available', 'downloading', 'verifying', 'preparing', 'ready', 'error'].includes(state));
    set('tli-update-banner-title', ready ? 'TLI update ready to install' : state === 'error' ? 'TLI update needs attention' : active ? 'Preparing TLI update' : 'TLI update available');
    set('tli-update-version', version);
    for (const id of ['tli-update-notes-btn', 'settings-update-notes-btn']) hide(id, !d.latest_version);
  }
  function schedulePoll() {
    clearTimeout(timer);
    timer = null;
    if (stopped || document.hidden) return;
    const ms = working.includes(status?.state) ? 1500 : startupPoll ? 15000 : 60000;
    timer = setTimeout(async () => { startupPoll = false; await refreshStatus(); }, ms);
  }
  async function refreshStatus() {
    if (refreshing || busy || stopped || document.hidden) { schedulePoll(); return; }
    refreshing = true;
    const ticket = revision;
    try { const data = await request('/update/status'); if (ticket === revision && !stopped) applyStatus(data); }
    catch (error) { if (ticket === revision && !stopped) { connectionError = error.message + ' Use Check for updates to retry.'; render(); } }
    finally { refreshing = false; schedulePoll(); }
  }
  async function runAction(kind) {
    if (!['check', 'prepare', 'open'].includes(kind) || busy || (working.includes(status?.state) && !connectionError)) return;
    if (kind !== 'check' && kind !== action()) return;
    busy = true;
    revision++;
    actionError = '';
    clearTimeout(timer);
    render();
    try {
      const data = await request(kind === 'prepare' ? '/update/apply' : kind === 'open' ? '/update/open' : '/update/check', 'POST');
      if (kind === 'check') applyStatus(data);
      else {
        if (data.ok !== true) throw Error('The host did not confirm the update request.');
        if (kind === 'prepare') applyStatus(await request('/update/status'));
        else actionError = 'Update folder opened. Follow the steps below to stop TLI and run the update script in that folder.';
      }
    } catch (error) {
      if (kind === 'open') actionError = 'Could not open the update folder: ' + error.message + ' Try Open update folder again, or use the folder path below on this computer.';
      else { status = { ...status, state: 'error', error: error.message + ' Retry the update check.' }; connectionError = ''; }
      toast(error.message);
    } finally { busy = false; render(); schedulePoll(); }
  }
  async function savePreferences() {
    const button = $('settings-update-url-save');
    if (!settingsConfirmed || button?.disabled) return;
    const url = $('settings-update-url')?.value?.trim() || '';
    const auto = $('settings-update-auto-check')?.checked ?? savedAutoCheck;
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    try {
      const data = await request('/update/settings', 'POST', { update_url: url, auto_check: auto });
      if (data.ok !== true) throw Error('The host did not confirm the save.');
      savedAutoCheck = auto;
      settingsMessage('Update preferences saved on this host. Your choice applies immediately to automatic checks.');
      if (button) { button.textContent = 'Saved ✓'; setTimeout(() => { button.textContent = 'Save'; }, 2000); }
    } catch (error) {
      if (button) button.textContent = 'Save';
      settingsMessage('Update preferences could not be saved. Your changes are still available to retry.');
      toast('Could not save update settings: ' + error.message);
    } finally { if (button) button.disabled = false; }
  }
  for (const id of ['settings-update-action-btn', 'tli-update-apply-btn']) $(id)?.addEventListener('click', () => runAction(action()));
  $('settings-check-update-btn')?.addEventListener('click', () => runAction('check'));
  $('settings-update-url-save')?.addEventListener('click', savePreferences);
  $('tli-update-dismiss-btn')?.addEventListener('click', () => { dismissedVersions.add(releaseVersion(status?.latest_version) || lastKnownVersion); render(); });
  $('settings-update-quit-btn')?.addEventListener('click', event => {
    if (!busy && status?.state === 'ready' && ['windows', 'win32'].includes(status.platform) && localDesktop()) window.TLIHostLifecycle?.open?.('quit', event.currentTarget);
  });
  for (const id of ['tli-update-notes-btn', 'settings-update-notes-btn']) $(id)?.addEventListener('click', () => {
    set('tli-update-notes-title', 'TLI v' + (status?.latest_version || '?').replace(/^v/, '') + ' — Release Notes');
    set('tli-update-notes-body', typeof status?.notes === 'string' && status.notes ? status.notes : 'No release notes available.');
    hide('tli-update-notes-pop', false);
  });
  $('tli-update-notes-close')?.addEventListener('click', () => hide('tli-update-notes-pop', true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refreshStatus(); });
  window.addEventListener?.('pagehide', () => { stopped = true; revision++; clearTimeout(timer); });
  window.addEventListener?.('pageshow', () => { if (stopped) { stopped = false; refreshStatus(); } });
  async function init() {
    if ($('settings-update-url-save')) $('settings-update-url-save').disabled = true;
    if ($('settings-update-auto-check')) $('settings-update-auto-check').disabled = true;
    try {
      const data = await request('/update/status');
      try { loadPreferences(data); } catch (error) { preferencesUnavailable(error); }
      applyStatus(data);
    } catch (error) { if (!settingsConfirmed) preferencesUnavailable(error); connectionError = error.message + ' Use Check for updates to retry.'; render(); }
    schedulePoll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
