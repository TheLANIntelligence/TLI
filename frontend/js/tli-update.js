// Download first; reviewed installation and reconnect never replay a mutation.
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
  let session = 0, locked = false, observationReady = true;
  let lockedInstall = null;
  const install = {generation:0, preview:null, command:null, pending:null, timer:null, polls:0, until:0, opener:null};
  const requests = new Set();
  const dialog = () => $('tli-update-install-dialog');
  const usable = () => !stopped && !locked && observationReady;
  const fresh = ticket => ticket.session === session && ticket.revision === revision && usable();
  const snapshot = () => ({session, revision});
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
    const controller = new AbortController(); requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), path.endsWith('/preview') ? 30000 : 15000);
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal:controller.signal,
        ...(method === 'POST' ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      let data;
      try { data = await response.json(); } catch { throw Error('The host returned an unreadable update response.'); }
      if (!response.ok) throw Object.assign(Error(typeof data?.detail === 'string' ? data.detail : `The update request failed (${response.status}).`), {status:response.status});
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('The host returned an invalid update response.');
      return data;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  function applyStatus(data) {
    if (!states.includes(data?.state) || (['available', 'ready'].includes(data.state) && (typeof data.latest_version !== 'string' || !data.latest_version.trim()))) {
      throw Error('The host returned an unsupported update status. Check that the app and host files match.');
    }
    if (!settingsConfirmed) { try { loadPreferences(data); } catch (error) { preferencesUnavailable(error); } }
    if (status?.state !== data.state || status?.latest_version !== data.latest_version) actionError = '';
    if (releaseVersion(data.latest_version)) lastKnownVersion = releaseVersion(data.latest_version);
    status = data;
    const operation = data.install_operation;
    if (!install.command && operation && validIdentity(operation) && /^[a-f0-9]{32,64}$/.test(operation.request_id || '') && localURL(operation.next_url) && typeof operation.version === 'string' && validReceipt(operation, operation)) install.command = {...operation};
    connectionError = '';
    render();
  }
  function action() {
    if (!usable()) return null;
    if (install.command) return 'install-progress';
    if (connectionError || status?.state === 'error') return 'check';
    if (status?.state === 'available' && status.can_prepare === true && localDesktop()) return 'prepare';
    if (status?.state === 'ready' && status.can_install === true && localDesktop()) return 'install';
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
    if (!message && state === 'available') message = d.can_prepare === true ? 'Download and verify the package first. Installation and restart require a separate review.' : 'Get this release from the download page and follow its update instructions.';
    if (ready && d.can_install === true && !actionError && !connectionError) message = 'The package is verified. Review installation and restart when your work is finished. Your original folder, saved data and models stay in place.';
    if (ready && d.can_install !== true && typeof d.install_reason === 'string' && d.install_reason) message = d.install_reason + ' Manual installation remains available below.';
    if (state === 'available' && d.can_prepare === true && !localDesktop()) message = 'Open TLI in a local desktop browser on the host computer (localhost) to download this update and finish installation.';
    if (ready && !localDesktop()) message += ' Open TLI in a local desktop browser on the host computer (localhost) to open the update folder and finish installation.';
    set('settings-update-message', message);
    hide('settings-update-ready', !ready);
    if ($('settings-update-ready') && ready && d.can_install !== true) $('settings-update-ready').open = true;
    set('settings-update-path', typeof d.ready_path === 'string' ? 'Update folder: ' + d.ready_path : '');
    const mac = ['mac', 'macos', 'darwin'].includes(d.platform);
    set('settings-update-installer', mac ? 'Run TLI_Update.command in that folder.' : d.platform === 'linux' ? 'Run TLI_Update.sh in that folder.' : 'Run TLI_Update.bat in that folder.');
    set('settings-update-stop', mac || d.platform === 'linux'
      ? 'Finish active work, then press Control+C in the Terminal window that started TLI. Stop any optional Host Start helper too. Closing this browser alone does not stop TLI.'
      : 'Finish active work, then choose Quit TLI below and review the confirmation. If TLI was started in a terminal, stop it there with Ctrl+C. Stop any optional Host Start helper too. Closing this browser alone does not stop TLI.');
    hide('settings-update-quit-btn', !ready || !localDesktop() || mac || d.platform === 'linux');
    if ($('settings-update-quit-btn')) $('settings-update-quit-btn').disabled = busy || !window.TLIHostLifecycle?.open;
    const next = action(), actionText = next === 'install' ? 'Install and restart…' : next === 'install-progress' ? 'View installation' : next === 'open' ? 'Open update folder' : next === 'check' ? 'Retry check' : 'Download update';
    for (const id of ['settings-update-action-btn', 'tli-update-apply-btn']) {
      hide(id, !next);
      if ($(id)) { $(id).disabled = busy || active; $(id).textContent = busy ? 'Please wait…' : actionText; }
    }
    if ($('settings-check-update-btn')) {
      $('settings-check-update-btn').disabled = !usable() || busy || active || !!install.command;
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
    if ($('settings-update-open-btn')) $('settings-update-open-btn').disabled = !usable() || busy || !localDesktop() || d.can_open !== true || !!install.command;
    if ($('settings-update-quit-btn')) $('settings-update-quit-btn').disabled ||= !usable() || !!install.command;
    if (install.command) {
      const complete = install.command.status === 'confirmed';
      set('settings-update-state', complete ? `Updated to v${install.command.version}` : 'Installation requested — checking restart');
      set('settings-update-message', complete ? 'The reviewed version is running in a new process of this installation. Reload TLI to load its updated interface.' : 'Open the installation view for progress and connection checks. The installation request will not be sent again.');
      hide('settings-update-ready', true);
    }
  }
  function schedulePoll() {
    clearTimeout(timer);
    timer = null;
    if (!usable() || document.hidden || install.command) return;
    const ms = working.includes(status?.state) ? 1500 : startupPoll ? 15000 : 60000;
    timer = setTimeout(async () => { startupPoll = false; await refreshStatus(); }, ms);
  }
  async function refreshStatus() {
    if (refreshing || busy || !usable() || document.hidden || install.command) { schedulePoll(); return; }
    refreshing = true;
    const ticket = snapshot();
    try { const data = await request('/update/status'); if (fresh(ticket)) applyStatus(data); }
    catch (error) { if (fresh(ticket)) { connectionError = error.message + ' Use Check for updates to retry.'; render(); } }
    finally { if (ticket.session === session) { refreshing = false; schedulePoll(); } }
  }
  async function runAction(kind) {
    if (!usable() || document.hidden || busy) return;
    if (['install', 'install-progress'].includes(kind)) return openInstall();
    if (!['check', 'prepare', 'open'].includes(kind) || install.command || (working.includes(status?.state) && !connectionError)) return;
    if (kind === 'open' ? status?.state !== 'ready' || status.can_open !== true || !localDesktop() : kind !== 'check' && kind !== action()) return;
    busy = true;
    revision++;
    const ticket = snapshot();
    actionError = '';
    clearTimeout(timer);
    render();
    try {
      const data = await request(kind === 'prepare' ? '/update/apply' : kind === 'open' ? '/update/open' : '/update/check', 'POST');
      if (!fresh(ticket)) return;
      if (kind === 'check') applyStatus(data);
      else {
        if (data.ok !== true) throw Error('The host did not confirm the update request.');
        if (kind === 'prepare') { const next = await request('/update/status'); if (fresh(ticket)) applyStatus(next); }
        else actionError = 'Update folder opened. Follow the steps below to stop TLI and run the update script in that folder.';
      }
    } catch (error) {
      if (!fresh(ticket)) return;
      if (kind === 'open') actionError = 'Could not open the update folder: ' + error.message + ' Try Open update folder again, or use the folder path below on this computer.';
      else { status = { ...status, state: 'error', error: error.message + ' Retry the update check.' }; connectionError = ''; }
      toast(error.message);
    } finally { if (fresh(ticket)) { busy = false; render(); schedulePoll(); } }
  }
  async function savePreferences() {
    const button = $('settings-update-url-save');
    if (!usable() || !settingsConfirmed || button?.disabled || install.command) return;
    const ticket = {session};
    const currentSave = () => ticket.session === session && usable();
    const url = $('settings-update-url')?.value?.trim() || '';
    const auto = $('settings-update-auto-check')?.checked ?? savedAutoCheck;
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    try {
      const data = await request('/update/settings', 'POST', { update_url: url, auto_check: auto });
      if (!currentSave()) return;
      if (data.ok !== true) throw Error('The host did not confirm the save.');
      savedAutoCheck = auto;
      settingsMessage('Update preferences saved on this host. Your choice applies immediately to automatic checks.');
      if (button) { button.textContent = 'Saved ✓'; setTimeout(() => { if (currentSave()) button.textContent = 'Save'; }, 2000); }
    } catch (error) {
      if (!currentSave()) return;
      if (button) button.textContent = 'Save';
      settingsMessage('Update preferences could not be saved. Your changes are still available to retry.');
      toast('Could not save update settings: ' + error.message);
    } finally { if (button && currentSave()) button.disabled = false; }
  }
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  const validIdentity = value => value?.schema_version === 1 && identity(value.instance_id) && identity(value.installation_id);
  const localURL = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase()) && !url.username && !url.password && !url.hash ? url : null; } catch { return null; } };
  const installText = text => set('tli-update-install-status', text);
  const installFresh = ticket => usable() && ticket.session === session && ticket.generation === install.generation;
  const installActive = ticket => installFresh(ticket) && dialog()?.open && !document.hidden;
  function stopInstallPoll() { clearTimeout(install.timer); install.timer = null; }
  function installControls() {
    const restricted = !usable() || !localDesktop() || !!install.pending || document.hidden;
    if ($('tli-update-install-confirm')) {
      $('tli-update-install-confirm').disabled = restricted || !install.preview || install.preview.expires_at * 1000 <= Date.now() || !!install.command;
      $('tli-update-install-confirm').hidden = !!install.command;
    }
    if ($('tli-update-install-check')) $('tli-update-install-check').disabled = restricted;
    set('tli-update-install-cancel', install.command ? 'Close' : 'Not now');
  }
  function showInstallCommand() {
    const command = install.command; if (!command) return;
    hide('tli-update-install-warning', true); hide('tli-update-install-details', true);
    set('tli-update-install-title', command.status === 'confirmed' ? 'Update confirmed' : 'Installing TLI');
    set('tli-update-install-version', `Reviewed update: v${command.version}`);
    hide('tli-update-install-check', command.status === 'confirmed');
    set('tli-update-install-check', 'Check connection');
    const changedAddress = localURL(command.next_url)?.origin !== new URL(window.location.href).origin;
    hide('tli-update-install-reload', command.status !== 'confirmed' && !changedAddress);
    set('tli-update-install-reload', changedAddress ? 'Open TLI at reviewed address' : 'Reload updated TLI');
    hide('tli-update-install-manual', !['failed', 'uncertain', 'mismatch'].includes(command.status));
    const labels = {
      uncertain: 'The installation response was not confirmed. TLI may already be updating. Check the connection before taking another action. Nothing will be resent.',
      accepted: 'Installation was accepted. Waiting for TLI to stop, install the verified files, and restart…',
      stopping: 'TLI is stopping. Active connections will disconnect before application files are installed.',
      installing: 'Installing the verified application files in your original TLI folder…',
      preparing: 'Preparing updated Python and runtime components. Internet access may be needed. Model weights remain in place; TLI has not restarted yet.',
      restarting: 'The files were installed. Waiting for TLI to restart and confirm its version…',
      completed: 'The installer finished. Waiting to confirm the reviewed version in the restarted host…',
      confirmed: `TLI v${command.version} is responding in a new process of your original installation. Reload TLI to load the updated interface; unlock it if asked.`,
      failed: 'Installation could not be confirmed: ' + (command.message || 'Review the retained update files and recovery instructions.') + ' No installation request was repeated.',
      mismatch: command.message,
    };
    installText(labels[command.status] || labels.uncertain);
    if (changedAddress) installText((labels[command.status] || labels.uncertain) + ' The reviewed address changed. Use Open TLI; credentials and checks are never sent to another address automatically.');
    installControls(); render();
  }
  async function reviewInstall() {
    if (!usable() || !localDesktop() || install.pending || install.command || !dialog()?.open || document.hidden) return;
    const ticket = {session, generation:++install.generation}; install.preview = null; install.pending = ticket;
    hide('tli-update-install-check', true); hide('tli-update-install-manual', true); installControls(); installText('Verifying this package and the original installation before review…');
    try {
      const preview = await request('/update/install/preview', 'POST'); if (!installActive(ticket)) return;
      const texts = values => Array.isArray(values) && values.length <= 20 && values.every(value => typeof value === 'string' && value.length <= 2000);
      if (!validIdentity(preview) || preview.action !== 'install' || !identity(preview.preview_id) || !Number.isFinite(preview.expires_at) || preview.expires_at * 1000 <= Date.now() || typeof preview.version !== 'string' || releaseVersion(preview.version) !== releaseVersion(status?.latest_version) || !localURL(preview.current_url) || localURL(preview.current_url).origin !== new URL(window.location.href).origin || !localURL(preview.next_url) || !texts(preview.consequences) || !texts(preview.preserves)) throw Error('The host did not provide a valid installation review. Nothing was requested to stop.');
      install.preview = preview;
      set('tli-update-install-version', `Update v${releaseVersion(preview.current_version)} → v${releaseVersion(preview.version)}`);
      set('tli-update-install-destination', `Original host: ${preview.current_url}. After restart: ${preview.next_url}.`);
      set('tli-update-install-details', preview.consequences.join(' '));
      set('tli-update-install-preserves', 'Preserved in your original installation: ' + preview.preserves.join(', ') + '. Keep using its existing folder and shortcuts.');
      installText('Review the interruption and preserved files, then choose Install and restart when ready.');
    } catch (error) { if (installActive(ticket)) { installText(error.status === 404 ? 'This running host does not support installation inside TLI. Use Manual installation options in Settings for this update.' : error.message); hide('tli-update-install-check', false); set('tli-update-install-check', 'Refresh review'); hide('tli-update-install-manual', false); } }
    finally { if (install.pending === ticket) install.pending = null; if (installFresh(ticket)) installControls(); }
  }
  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
    if (!window.crypto?.getRandomValues) throw Error('Secure request identifiers are unavailable. Use manual installation.');
    const bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes); return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }
  function validReceipt(value, command) {
    return validIdentity(value) && value.request_id === command.request_id && value.action === 'install' && value.installation_id === command.installation_id && value.instance_id === command.instance_id && releaseVersion(value.version) === releaseVersion(command.version) && ['accepted', 'stopping', 'installing', 'preparing', 'restarting', 'completed', 'failed', 'uncertain'].includes(value.status);
  }
  async function confirmInstall() {
    const preview = install.preview;
    if (!usable() || !localDesktop() || !dialog()?.open || document.hidden || install.pending || install.command || !preview) return;
    if (preview.expires_at * 1000 <= Date.now()) { install.preview = null; installControls(); installText('This review expired. Refresh it before installing.'); hide('tli-update-install-check', false); set('tli-update-install-check', 'Refresh review'); return; }
    let id; try { id = requestId(); } catch (error) { installText(error.message); return; }
    const ticket = {session, generation:install.generation};
    const command = {request_id:id, action:'install', instance_id:preview.instance_id, installation_id:preview.installation_id, version:preview.version, next_url:preview.next_url, status:'uncertain'};
    install.command = command; install.preview = null; install.pending = ticket; clearTimeout(timer); installControls(); render(); installText('Sending your confirmed installation and restart request…');
    try {
      const receipt = await request('/update/install/confirm', 'POST', {preview_id:preview.preview_id, request_id:id});
      if (ticket.session !== session || install.command !== command) return;
      if (!validReceipt(receipt, command)) throw Error('The host did not confirm a matching installation receipt.');
      command.status = receipt.status; command.message = receipt.message;
    } catch (error) {
      if (ticket.session !== session || install.command !== command) return;
      if ([400,401,403,404,409,410,422].includes(error.status)) { command.status = 'failed'; command.message = error.message + ' The request was rejected.'; }
    } finally {
      if (install.pending === ticket) install.pending = null;
      if (installActive(ticket)) { showInstallCommand(); install.until = Date.now() + 120000; install.polls = 0; scheduleInstallPoll(); }
    }
  }
  function scheduleInstallPoll() {
    stopInstallPoll();
    if (!usable() || document.hidden || !dialog()?.open || !install.command || ['failed', 'confirmed', 'mismatch'].includes(install.command.status) || localURL(install.command.next_url)?.origin !== new URL(window.location.href).origin) return;
    if (Date.now() >= install.until || install.polls >= 60) { installText('The new version is not confirmed yet. Check the connection when ready, or start TLI from its original launcher. The installation request was not repeated.'); hide('tli-update-install-manual', false); return; }
    install.timer = setTimeout(() => checkInstallConnection(true), install.polls ? 2000 : 1000);
  }
  async function checkInstallConnection(automatic = false) {
    if (!usable() || !localDesktop() || document.hidden || !dialog()?.open || install.pending) return;
    if (!install.command) return reviewInstall();
    const command = install.command, ticket = {session, generation:install.generation};
    if (localURL(command.next_url)?.origin !== new URL(window.location.href).origin) { showInstallCommand(); return; }
    stopInstallPoll(); install.pending = ticket; installControls(); if (automatic) install.polls++;
    try {
      const host = await request('/api/host-control/v1/lifecycle/ready'); if (!installActive(ticket) || install.command !== command) return;
      if (!validIdentity(host) || host.installation_id !== command.installation_id) throw Error('The responding installation does not match the reviewed installation.');
      if (host.instance_id !== command.instance_id) {
        if (releaseVersion(host.current_version) === releaseVersion(command.version)) { command.status = 'confirmed'; status = {...status, current_version:host.current_version}; }
        else { command.status = 'mismatch'; command.message = `TLI restarted, but v${command.version} is not confirmed. The responding host reports ${typeof host.current_version === 'string' ? 'v' + host.current_version : 'no version'}. Keep the update files and check again; nothing will be reinstalled automatically.`; }
        showInstallCommand(); return;
      }
      const receipt = await request('/update/install/receipt/' + encodeURIComponent(command.request_id)); if (!installActive(ticket) || install.command !== command) return;
      if (!validReceipt(receipt, command)) throw Error('The host did not return a matching installation receipt.');
      command.status = receipt.status; command.message = receipt.message; showInstallCommand();
    } catch (error) { if (installActive(ticket)) installText('Reconnecting to TLI. The reviewed version is not confirmed yet. ' + error.message + ' No installation request was repeated.'); }
    finally { if (install.pending === ticket) install.pending = null; if (installActive(ticket)) { installControls(); if (automatic) scheduleInstallPoll(); } }
  }
  function openInstall() {
    if (!usable() || !localDesktop() || !dialog() || dialog().open || !install.command && status?.can_install !== true) return;
    stopInstallPoll(); install.generation++; install.preview = null; install.pending = null;
    install.opener = document.activeElement;
    hide('tli-update-install-warning', false); hide('tli-update-install-details', false);
    set('tli-update-install-title', 'Install update and restart?'); set('tli-update-install-version', ''); set('tli-update-install-destination', ''); set('tli-update-install-details', '');
    hide('tli-update-install-reload', true); dialog().showModal(); $('tli-update-install-cancel')?.focus(); installControls();
    if (install.command) showInstallCommand(); else return reviewInstall();
  }
  $('tli-update-install-confirm')?.addEventListener('click', confirmInstall);
  $('tli-update-install-check')?.addEventListener('click', () => checkInstallConnection());
  $('tli-update-install-cancel')?.addEventListener('click', () => dialog()?.close());
  $('tli-update-install-reload')?.addEventListener('click', () => {
    const command = install.command;
    if (!usable() || !dialog()?.open || !command || !localURL(command.next_url) || command.status !== 'confirmed' && localURL(command.next_url).origin === new URL(window.location.href).origin) return;
    stopInstallPoll(); window.location.assign(command.next_url);
  });
  dialog()?.addEventListener('close', () => { install.generation++; stopInstallPoll(); install.preview = null; install.pending = null; if (usable() && install.opener?.isConnected) install.opener.focus({preventScroll:true}); });
  for (const id of ['settings-update-action-btn', 'tli-update-apply-btn']) $(id)?.addEventListener('click', () => runAction(action()));
  $('settings-update-open-btn')?.addEventListener('click', () => runAction('open'));
  $('settings-check-update-btn')?.addEventListener('click', () => runAction('check'));
  $('settings-update-url-save')?.addEventListener('click', savePreferences);
  $('tli-update-dismiss-btn')?.addEventListener('click', () => { dismissedVersions.add(releaseVersion(status?.latest_version) || lastKnownVersion); render(); });
  $('settings-update-quit-btn')?.addEventListener('click', event => {
    if (usable() && !install.command && !busy && status?.state === 'ready' && ['windows', 'win32'].includes(status.platform) && localDesktop()) window.TLIHostLifecycle?.open?.('quit', event.currentTarget);
  });
  for (const id of ['tli-update-notes-btn', 'settings-update-notes-btn']) $(id)?.addEventListener('click', () => {
    if (!usable()) return;
    set('tli-update-notes-title', 'TLI v' + (status?.latest_version || '?').replace(/^v/, '') + ' — Release Notes');
    set('tli-update-notes-body', typeof status?.notes === 'string' && status.notes ? status.notes : 'No release notes available.');
    hide('tli-update-notes-pop', false);
  });
  $('tli-update-notes-close')?.addEventListener('click', () => hide('tli-update-notes-pop', true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); stopInstallPoll(); install.generation++; install.preview = null; install.pending = null; installControls(); }
    else { refreshStatus(); if (dialog()?.open) { if (install.command) showInstallCommand(); else { installText('The installation review was interrupted. Refresh it before continuing.'); hide('tli-update-install-check', false); set('tli-update-install-check', 'Refresh review'); } } }
  });
  function clearSession(lock, rememberInstall = false) {
    if (!rememberInstall) lockedInstall = null;
    else if (install.command && !['confirmed', 'failed'].includes(install.command.status)) {
      // A restart invalidates PIN sessions. Retain only enough identity for a
      // later explicit read; never retain review grants, paths or receipt text.
      lockedInstall = Object.fromEntries(['request_id','action','instance_id','installation_id','version','next_url'].map(key => [key, install.command[key]]));
      lockedInstall.status = 'uncertain';
    }
    session++; revision++; locked = lock; observationReady = false; busy = false; refreshing = false;
    for (const controller of requests) controller.abort(); requests.clear();
    clearTimeout(timer); stopInstallPoll(); install.generation++; install.preview = null; install.command = null; install.pending = null;
    if (dialog()?.open) dialog().close();
    status = null; settingsConfirmed = false; savedAutoCheck = null; actionError = ''; connectionError = ''; lastKnownVersion = ''; dismissedVersions.clear();
    for (const id of ['settings-update-path','tli-update-notes-title','tli-update-notes-body','tli-update-install-version','tli-update-install-destination','tli-update-install-details','tli-update-install-status','tli-update-install-preserves']) set(id, '');
    hide('tli-update-notes-pop', true); showHostVersion(null);
    if ($('settings-update-url')) $('settings-update-url').value = '';
    if ($('settings-update-auto-check')) { $('settings-update-auto-check').checked = false; $('settings-update-auto-check').disabled = true; }
    if ($('settings-update-url-save')) { $('settings-update-url-save').disabled = true; $('settings-update-url-save').textContent = 'Save'; }
    settingsMessage('Verify browser access before reading or changing update preferences.'); render(); installControls();
  }
  window.addEventListener?.('tli-session-locked', () => clearSession(true, true));
  for (const event of ['tli-account-changed','tli-user-changed']) window.addEventListener?.(event, () => clearSession(true));
  window.addEventListener?.('tli-session-unlocked', () => { locked = false; revision++; render(); installControls(); });
  window.addEventListener?.('tli-private-observation-ready', () => {
    if (!locked && !observationReady) {
      observationReady = true;
      if (lockedInstall) { install.command = lockedInstall; lockedInstall = null; render(); installControls(); }
      else refreshStatus();
    }
  });
  window.addEventListener?.('pagehide', () => { stopped = true; clearSession(false); });
  window.addEventListener?.('pageshow', () => { stopped = false; });
  async function init() {
    if (window.TLIHostIdentity?.get?.().status === 'locked') { clearSession(true); return; }
    const ticket = snapshot();
    if ($('settings-update-url-save')) $('settings-update-url-save').disabled = true;
    if ($('settings-update-auto-check')) $('settings-update-auto-check').disabled = true;
    try {
      const data = await request('/update/status');
      if (!fresh(ticket)) return;
      try { loadPreferences(data); } catch (error) { preferencesUnavailable(error); }
      applyStatus(data);
    } catch (error) { if (!fresh(ticket)) return; if (!settingsConfirmed) preferencesUnavailable(error); connectionError = error.message + ' Use Check for updates to retry.'; render(); }
    schedulePoll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
