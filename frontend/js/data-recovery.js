/* Explicit saved-data checks and portable notes, chat and report backups. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { epoch: 0, busy: false, report: null, controller: null };
  const backup = { epoch: 0, busy: false, controller: null, url: null, report: null };
  const recovery = { epoch: 0, busy: false, controller: null, review: null, receipt: null, request: null, creating: false, uncertain: false, locked: false };
  const backupProtocol = 'tli-notebook-history-backup-v1';
  const backupProtocolV2 = 'tli-saved-work-backup-v2';
  const maxArchiveBytes = 64 * 1024 * 1024;
  const labels = { readable: 'Readable', not_created: 'Not created', unavailable: 'Unavailable', not_checked: 'Not checked' };
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const text = (value, max = 3000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const textList = values => Array.isArray(values) && values.length > 0 && values.length <= 12 && values.every(value => text(value));
  function validReport(data) {
    const ids = ['notebook', 'conversations', 'diagnostics'];
    return data?.schema_version === 1 && text(data.checked_at, 64) && Number.isFinite(Date.parse(data.checked_at)) &&
      text(data.host?.id, 256) && text(data.host?.name, 256) && text(data.scope, 6000) &&
      Array.isArray(data.checks) && data.checks.length === ids.length && new Set(data.checks.map(check => check?.id)).size === ids.length &&
      data.checks.every(check => ids.includes(check?.id) && Object.hasOwn(labels, check.status) && text(check.label, 120) && text(check.detail)) &&
      data.backup?.status === 'unknown' && text(data.backup.detail) && text(data.guidance?.summary) && textList(data.guidance.steps) && textList(data.guidance.limitations);
  }
  function notice(value, error = false) {
    const status = $('data-recovery-status'); if (!status) return;
    status.textContent = value; status.classList.toggle('error', error);
  }
  function clear() {
    state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false; state.report = null;
    $('data-recovery-report')?.replaceChildren();
    if ($('data-recovery-report')) $('data-recovery-report').hidden = true;
    if ($('data-recovery-check')) $('data-recovery-check').disabled = false;
    notice('Unlock TLI, then check saved data when you are ready.');
    clearBackup(); clearRecovery();
  }
  function render(report) {
    const box = $('data-recovery-report'); box.replaceChildren(); box.hidden = false;
    box.append(node('h3', `Saved data on ${report.host.name}`), node('p', 'Last completed check: ' + new Date(report.checked_at).toLocaleString(), 'data-recovery-meta'), node('p', report.scope, 'data-recovery-scope'));
    const checks = node('div', null, 'data-recovery-results');
    report.checks.forEach(check => {
      const card = node('article', null, 'data-recovery-check'); card.setAttribute('data-state', check.status);
      const header = node('div', null, 'data-recovery-check-header');
      header.append(node('h4', check.id === 'notebook' ? 'Notes & fixes' : check.label), node('span', labels[check.status], 'data-recovery-badge'));
      card.append(header, node('p', check.detail)); checks.append(card);
    });
    box.append(checks, node('h3', 'Backup status: unknown'), node('p', report.backup.detail));
    const guidance = node('section', null, 'data-recovery-guidance'); guidance.setAttribute('aria-label', 'Manual backup and recovery guidance');
    guidance.append(node('h3', 'Manual backup and recovery'), node('p', report.guidance.summary));
    const steps = node('ol'); report.guidance.steps.forEach(step => steps.append(node('li', step)));
    const limitations = node('ul'); report.guidance.limitations.forEach(limitation => limitations.append(node('li', limitation)));
    guidance.append(steps, node('h4', 'What this check cannot verify'), limitations); box.append(guidance);
  }
  async function check() {
    if (state.busy) return;
    const epoch = state.epoch; state.busy = true; state.controller = new AbortController();
    $('data-recovery-check').disabled = true;
    notice('Checking saved data on your TLI host…' + (state.report ? ' Results below are from the previous completed check.' : ''));
    try {
      const response = await fetch('/api/intelligence/data-health', { method: 'GET', cache: 'no-store', signal: state.controller.signal, headers: { 'Accept': 'application/json' } });
      if (epoch !== state.epoch) return;
      if (response.status === 401) { clear(); return; }
      const data = await response.json().catch(() => null);
      if (epoch !== state.epoch) return;
      if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Saved-data check failed (${response.status}).`);
      if (!validReport(data)) throw new Error('TLI returned an incomplete saved-data check.');
      state.report = data; render(data);
      const needsReview = data.checks.some(item => item.status === 'unavailable' || item.status === 'not_checked');
      notice(needsReview ? 'Check completed with unavailable or unchecked data. Review the details below.' : 'Check completed for these saved stores. A backup has not been verified.');
    } catch (error) {
      if (epoch !== state.epoch) return;
      notice((error?.message || 'The saved-data check could not complete.') + (state.report ? ' Previous results remain below and may be out of date.' : ' No saved-data result is available. Try again when TLI is reachable.'), true);
    } finally {
      if (epoch === state.epoch) { state.busy = false; state.controller = null; $('data-recovery-check').disabled = false; }
    }
  }
  function backupNotice(id, value, error = false) {
    const status = $(id); if (!status) return;
    status.textContent = value; status.classList.toggle('error', error);
  }
  function backupBusy(value) {
    backup.busy = value;
    ['backup-create', 'backup-format', 'backup-verify', 'backup-password', 'backup-confirm-password', 'backup-review', 'backup-file', 'backup-verify-password'].forEach(id => { if ($(id)) $(id).disabled = value; });
  }
  function clearBackup() {
    backup.epoch++; backup.controller?.abort(); backup.controller = null; backupBusy(false); backup.report = null;
    if (backup.url) globalThis.URL?.revokeObjectURL(backup.url);
    backup.url = null;
    ['backup-password', 'backup-confirm-password', 'backup-verify-password', 'backup-file'].forEach(id => { if ($(id)) $(id).value = ''; });
    if ($('backup-review')) $('backup-review').checked = false;
    if ($('backup-download')) { $('backup-download').hidden = true; $('backup-download').removeAttribute?.('href'); }
    $('backup-verification-report')?.replaceChildren();
    if ($('backup-verification-report')) $('backup-verification-report').hidden = true;
    backupNotice('backup-create-status', 'No archive has been prepared in this view.');
    backupNotice('backup-verify-status', 'No uploaded archive has been verified in this view.');
  }
  function privateConnection() {
    const loc = globalThis.location;
    return loc?.protocol === 'https:' || (loc?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(loc.hostname));
  }
  function passwordValid(value) {
    return typeof value === 'string' && value.length >= 12 && value.length <= 1024 && Boolean(value.trim()) && new TextEncoder().encode(value).length <= 1024;
  }
  function requestID() {
    if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('A secure browser context is required. Open TLI on this computer or use its HTTPS address.');
    return globalThis.crypto.randomUUID();
  }
  async function responseError(response, fallback) {
    const data = await response.json().catch(() => null);
    return text(data?.detail) ? data.detail : fallback;
  }
  async function createBackup() {
    if (backup.busy) return;
    const id = 'backup-create-status';
    if (!privateConnection()) { backupNotice(id, 'Open TLI on its host computer or use its secure HTTPS address before submitting a backup password.', true); return; }
    const password = $('backup-password').value;
    if (!passwordValid(password)) { backupNotice(id, 'Use at least 12 characters for the archive password (up to 1024 UTF-8 bytes).', true); return; }
    if (password !== $('backup-confirm-password').value) { backupNotice(id, 'The two archive passwords do not match.', true); return; }
    if (!$('backup-review').checked) { backupNotice(id, 'Review and acknowledge the backup scope and password requirement first.', true); return; }
    const epoch = backup.epoch;
    const extended = $('backup-format')?.value === 'saved-work-v2';
    backupBusy(true); backup.controller = new AbortController();
    backupNotice(id, 'Preparing your encrypted notes, chats & reports backup on the TLI host…');
    try {
      const response = await fetch('/api/intelligence/backups/create', { method: 'POST', cache: 'no-store', redirect: 'error', signal: backup.controller.signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/vnd.tli.notebook-history-backup' }, body: JSON.stringify({ password, request_id: requestID(), ...(extended ? { format: 'saved-work-v2' } : {}) }) });
      if (epoch !== backup.epoch) return;
      if (response.status === 401) { clear(); return; }
      if (!response.ok) throw new Error(await responseError(response, 'The archive could not be prepared.'));
      const hash = response.headers.get('X-TLI-Backup-SHA256');
      if (response.headers.get('X-TLI-Backup-Protocol') !== (extended ? backupProtocolV2 : backupProtocol) || !/^[a-f0-9]{64}$/.test(hash || '') ||
          !response.headers.get('Content-Type')?.startsWith('application/vnd.tli.notebook-history-backup')) throw new Error('TLI returned an unsupported backup response. No archive download was started.');
      const blob = await response.blob();
      if (epoch !== backup.epoch) return;
      if (blob.size < 80 || blob.size > maxArchiveBytes) throw new Error('TLI returned an invalid archive size. No download was started.');
      const actual = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (epoch !== backup.epoch) return;
      if (actual !== hash) throw new Error('The received archive did not match its transfer checksum. No download was started.');
      const url = globalThis.URL.createObjectURL(blob);
      if (backup.url) globalThis.URL.revokeObjectURL(backup.url);
      backup.url = url;
      const link = $('backup-download'); link.href = url;
      link.download = (extended ? 'TLI-Saved-work-' : 'TLI-Notebook-history-') + new Date().toISOString().slice(0, 10) + '.tlibackup'; link.hidden = false;
      link.click();
      backupNotice(id, 'Encrypted archive prepared; a download was requested. Check that the file was saved, keep a separate copy, then use Verify below. A live restore has not been tested.');
    } catch (error) {
      if (epoch === backup.epoch) backupNotice(id, (error?.message || 'The archive could not be prepared.') + ' No automatic retry was started.' + (backup.url ? ' The previous archive download link remains available.' : ''), true);
    } finally {
      if (epoch === backup.epoch) { $('backup-password').value = ''; $('backup-confirm-password').value = ''; backup.controller = null; backupBusy(false); }
    }
  }
  function validVerification(data) {
    const extended = data?.schema_version === 2;
    const version = extended ? 2 : 1, protocol = extended ? backupProtocolV2 : backupProtocol;
    const ids = ['notebook', 'conversations', 'diagnostics', ...(extended ? ['cases'] : [])], names = ['account.json', ...ids.map(id => id + '.json')];
    const manifest = data?.manifest, source = data?.source;
    return data?.ok === true && data.schema_version === version && data.protocol === protocol && data.archive_integrity === 'verified' &&
      data.contents_readable === true && data.restored_live === false && data.recovery_scope === (extended ? 'Saved work backup' : 'Notebook & history backup') &&
      text(data.checked_at, 64) && Number.isFinite(Date.parse(data.checked_at)) && /^[a-f0-9]{64}$/.test(data.archive_sha256 || '') && text(data.detail) &&
      source && text(source.owner_id, 256) && text(source.tli_version, 64) && text(source.source_host?.name, 256) && text(source.source_host?.id, 256) &&
      text(source.exported_at, 64) && Number.isFinite(Date.parse(source.exported_at)) &&
      data.counts && Object.keys(data.counts).length === ids.length && ids.every(id => Number.isSafeInteger(data.counts[id]) && data.counts[id] >= 0) &&
      manifest?.schema_version === version && manifest.protocol === protocol && manifest.scope === data.recovery_scope && manifest.created_at === source.exported_at &&
      textList(manifest.included) && textList(manifest.excluded) && textList(manifest.limitations) &&
      Array.isArray(manifest.entries) && manifest.entries.length === names.length && new Set(manifest.entries.map(row => row?.name)).size === names.length &&
      manifest.entries.every(row => names.includes(row?.name) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 16 * 1024 * 1024 &&
        /^[a-f0-9]{64}$/.test(row.sha256 || '') && Number.isSafeInteger(row.records) && row.records === (row.name === 'account.json' ? 1 : data.counts[row.name.slice(0, -5)]));
  }
  function renderVerification(report) {
    const box = $('backup-verification-report'); box.replaceChildren(); box.hidden = false;
    box.append(node('h4', 'Uploaded archive verified'), node('p', report.detail),
      node('p', `Archive account: ${report.source.owner_id} · Source: ${report.source.source_host.name} · TLI ${report.source.tli_version}`, 'data-recovery-meta'),
      node('p', 'Exported: ' + new Date(report.source.exported_at).toLocaleString() + ' · Verified: ' + new Date(report.checked_at).toLocaleString(), 'data-recovery-meta'));
    const counts = node('ul');
    [['notebook', 'Notes & fixes (including retained deleted records)'], ['conversations', 'AI conversations'], ['diagnostics', 'Saved diagnostic reports']].forEach(([id, label]) => counts.append(node('li', `${label}: ${report.counts[id]}`)));
    counts.append(node('li', report.schema_version === 2 ? `Troubleshooting problems: ${report.counts.cases}` : 'Troubleshooting is not included in this earlier archive format.'));
    box.append(counts, node('p', 'Archive integrity: verified. Saved contents: readable. Live restoration: not performed.', 'data-backup-verdict'));
    const manifest = node('details'); manifest.append(node('summary', 'Full archive manifest and scope'));
    manifest.append(node('h4', 'Included'));
    const included = node('ul'); report.manifest.included.forEach(value => included.append(node('li', value))); manifest.append(included);
    const files = node('ul'); report.manifest.entries.forEach(row => files.append(node('li', `${row.name} · ${row.bytes.toLocaleString()} bytes · SHA-256 ${row.sha256}`))); manifest.append(files);
    manifest.append(node('h4', 'Excluded'));
    const excluded = node('ul'); report.manifest.excluded.forEach(value => excluded.append(node('li', value))); manifest.append(excluded);
    const limitations = node('ul'); report.manifest.limitations.forEach(value => limitations.append(node('li', value))); manifest.append(node('h4', 'Recovery limits'), limitations);
    box.append(manifest, node('p', 'Archive SHA-256: ' + report.archive_sha256, 'data-backup-hash'));
  }
  async function verifyBackup() {
    if (backup.busy) return;
    const id = 'backup-verify-status', file = $('backup-file').files?.[0], password = $('backup-verify-password').value;
    if (!privateConnection()) { backupNotice(id, 'Open TLI on its host computer or use its secure HTTPS address before submitting a backup password.', true); return; }
    if (!file || !file.name.toLowerCase().endsWith('.tlibackup') || file.size < 80 || file.size > maxArchiveBytes) { backupNotice(id, 'Choose one .tlibackup file no larger than 64 MiB.', true); return; }
    if (!passwordValid(password)) { backupNotice(id, 'Enter the archive password (at least 12 characters).', true); return; }
    const epoch = backup.epoch; backupBusy(true); backup.controller = new AbortController();
    backupNotice(id, 'Verifying the uploaded archive in an isolated copy. Live data will not be restored or changed.' + (backup.report ? ' The result below is from an earlier verification.' : ''));
    try {
      const form = new FormData(); form.append('password', password); form.append('request_id', requestID()); form.append('file', file);
      const response = await fetch('/api/intelligence/backups/verify', { method: 'POST', cache: 'no-store', redirect: 'error', signal: backup.controller.signal, headers: { 'Accept': 'application/json' }, body: form });
      if (epoch !== backup.epoch) return;
      if (response.status === 401) { clear(); return; }
      const data = await response.json().catch(() => null);
      if (epoch !== backup.epoch) return;
      if (!response.ok) throw new Error(text(data?.detail) ? data.detail : 'The uploaded archive could not be verified.');
      if (!validVerification(data)) throw new Error('TLI returned an incomplete archive verification. It cannot be shown as verified.');
      backup.report = data; renderVerification(data);
      backupNotice(id, 'This uploaded notes, chats & reports archive passed integrity and saved-content checks. No live restore was performed.');
    } catch (error) {
      if (epoch === backup.epoch) backupNotice(id, (error?.message || 'The archive could not be verified.') + ' No automatic retry was started.' + (backup.report ? ' The previous verification remains below; it does not describe this attempt.' : ''), true);
    } finally {
      if (epoch === backup.epoch) { $('backup-verify-password').value = ''; backup.controller = null; backupBusy(false); }
    }
  }
  function backupControls() {
    const section = node('section', null, 'data-backup'); section.setAttribute('aria-label', 'Back up notes, chats & reports');
    section.append(node('h3', 'Back up notes, chats & reports'), node('p', 'Download a password-protected backup of this account’s saved notes, AI conversations and diagnostic reports. This is not a whole-installation backup.'));
    const scope = node('details'); scope.append(node('summary', 'Review what is included and excluded'));
    scope.append(node('p', 'Included: all retained Notes & fixes records, AI conversation messages and their saved context records, saved diagnostic reports, and account/source metadata. Original stores and their keys stay unchanged.'));
    scope.append(node('p', 'Excluded: Vault contents and secrets; host PIN and keys; cryptographic identity; Companion credentials; other accounts; unowned legacy device memories and LAN chat; models, configuration and device settings; image/document files; saved places, storage scan history, activity review and cleanup receipts.'));
    scope.append(node('p', 'Each source store must be readable and no larger than 16 MiB. The archive is limited to 64 MiB. Unreadable or oversized stores stop creation; no partial backup is offered.'));
    section.append(scope, node('p', 'Keep the archive password separately. TLI cannot recover it. Password operations require HTTPS or opening TLI on the host computer.', 'data-recovery-meta'));
    const grid = node('div', null, 'data-backup-grid');
    const create = node('section', null, 'data-backup-card'); create.append(node('h4', '1. Create an encrypted archive'));
    const formatLabel = node('label', null, 'data-backup-field'), format = node('select'); format.id = 'backup-format';
    for (const [value, label] of [['saved-work-v2', 'Saved work · includes Troubleshooting'], ['', 'Earlier format · notes, chats & reports only']]) { const option = node('option', label); option.value = value; format.append(option); }
    format.value = 'saved-work-v2'; format.addEventListener('change', () => { if ($('backup-review')) $('backup-review').checked = false; });
    formatLabel.append(node('span', 'Archive contents'), format); create.append(formatLabel,
      node('p', 'Saved work includes your Troubleshooting problems, attempted steps, outcomes and evidence links. The earlier format excludes Troubleshooting. Both exclude Vault, credentials and external files.', 'data-recovery-meta'));
    function input(parent, id, label, type, autocomplete) {
      const wrapper = node('label', null, 'data-backup-field'); wrapper.append(node('span', label));
      const field = node('input'); field.id = id; field.type = type; field.autocomplete = autocomplete || 'off';
      if (type === 'password') { field.maxLength = 1024; field.spellcheck = false; }
      wrapper.append(field); parent.append(wrapper); return field;
    }
    input(create, 'backup-password', 'New archive password (12+ characters)', 'password', 'new-password');
    input(create, 'backup-confirm-password', 'Confirm archive password', 'password', 'new-password');
    const review = node('label', null, 'data-backup-ack'); const checkbox = node('input'); checkbox.id = 'backup-review'; checkbox.type = 'checkbox';
    review.append(checkbox, node('span', 'I reviewed the scope and understand that the archive password is required for recovery.'));
    const make = node('button', 'Create & download backup', 'btn-outline'); make.id = 'backup-create'; make.type = 'button'; make.addEventListener('click', createBackup);
    const createStatus = node('p', 'No archive has been prepared in this view.', 'data-recovery-status'); createStatus.id = 'backup-create-status'; createStatus.setAttribute('role', 'status');
    const download = node('a', 'Download prepared archive again', 'data-backup-download'); download.id = 'backup-download'; download.hidden = true;
    create.append(review, make, createStatus, download);
    const verify = node('section', null, 'data-backup-card'); verify.append(node('h4', '2. Verify a saved archive'));
    const file = input(verify, 'backup-file', 'Choose the saved .tlibackup file (up to 64 MiB)', 'file'); file.accept = '.tlibackup';
    input(verify, 'backup-verify-password', 'Archive password', 'password');
    verify.append(node('p', 'Verification decrypts and checks an isolated encrypted temporary copy. It never imports, merges or restores over live data.', 'data-recovery-meta'));
    const inspect = node('button', 'Verify uploaded archive', 'btn-outline'); inspect.id = 'backup-verify'; inspect.type = 'button'; inspect.addEventListener('click', verifyBackup);
    const verifyStatus = node('p', 'No uploaded archive has been verified in this view.', 'data-recovery-status'); verifyStatus.id = 'backup-verify-status'; verifyStatus.setAttribute('role', 'status');
    verify.append(inspect, verifyStatus); grid.append(create, verify);
    const report = node('div', null, 'data-backup-report'); report.id = 'backup-verification-report'; report.hidden = true;
    section.append(grid, report); return section;
  }
  function recoveryBusy(value) {
    recovery.busy = value;
    const blocked = value || recovery.locked;
    ['recovery-copy-file', 'recovery-copy-password', 'recovery-copy-destination', 'recovery-copy-review'].forEach(id => { if ($(id)) $(id).disabled = blocked; });
    if ($('recovery-copy-ack')) $('recovery-copy-ack').disabled = blocked || !recovery.review;
    if ($('recovery-copy-create')) $('recovery-copy-create').disabled = blocked || !recovery.review || !$('recovery-copy-ack')?.checked;
  }
  function discardRecoveryReview() {
    recovery.review = null; recovery.request = null;
    $('recovery-copy-review-result')?.replaceChildren();
    if ($('recovery-copy-review-result')) $('recovery-copy-review-result').hidden = true;
    if ($('recovery-copy-ack')) $('recovery-copy-ack').checked = false;
    if ($('recovery-copy-confirmation')) $('recovery-copy-confirmation').hidden = true;
    recoveryBusy(recovery.busy);
  }
  function clearRecovery() {
    if (recovery.creating) recovery.uncertain = true;
    recovery.epoch++; recovery.controller?.abort(); recovery.controller = null; recovery.creating = false; recovery.busy = false;
    discardRecoveryReview(); recovery.receipt = null;
    ['recovery-copy-file', 'recovery-copy-password', 'recovery-copy-destination'].forEach(id => { if ($(id)) $(id).value = ''; });
    $('recovery-copy-receipt')?.replaceChildren();
    if ($('recovery-copy-receipt')) $('recovery-copy-receipt').hidden = true;
    backupNotice('recovery-copy-status', recovery.uncertain ? 'A previous recovery request may have completed. Check the destination on the TLI host before preparing another request. Nothing was retried.' : 'Choose an archive and a new destination folder, then review the copy before creating it.');
  }
  const recoveryIDs = ['notebook', 'conversations', 'diagnostics'];
  const recoveryKeys = data => [...recoveryIDs, ...(Object.hasOwn(data?.counts || {}, 'cases') ? ['cases'] : [])];
  const recoveryReadbackChecks = ['encrypted_payloads', 'current_readers', 'record_identifiers', 'stored_metadata', 'owner_mapping', 'files_unchanged'];
  const recoveryExclusions = 'Excluded: Vault files and secrets, host PIN and keys, device identity, Companion credentials, other accounts, models and application files, configuration, image/document files and saved places.';
  function validRecovery(data, expectedHash) {
    return data?.ok === true && data.schema_version === 1 && data.scope === 'separate-data-copy' && data.activated === false &&
      text(data.destination, 1024) && /^[a-f0-9]{64}$/.test(data.archive_sha256 || '') && data.archive_sha256 === expectedHash &&
      text(data.source?.owner_id, 256) && text(data.source?.tli_version, 64) && text(data.source?.source_host?.name, 256) && text(data.source?.source_host?.id, 256) &&
      text(data.source?.exported_at, 64) && Number.isFinite(Date.parse(data.source.exported_at)) &&
      data.owner_mapping?.source_owner === data.source.owner_id && data.owner_mapping.target_owner === 'local' &&
      data.counts && Object.keys(data.counts).length === recoveryKeys(data).length && recoveryKeys(data).every(id => Number.isSafeInteger(data.counts[id]) && data.counts[id] >= 0);
  }
  function recoveryFacts(box, data) {
    const path = node('p', data.destination, 'data-recovery-path');
    box.append(node('h4', 'Destination on the TLI host'), path,
      node('p', `Archive account ${data.owner_mapping.source_owner} → fresh local owner in the recovered copy.`, 'data-backup-verdict'),
      node('p', 'The copy has no owner PIN or phone pairings. Configure access before any future activation. This current host remains in use.', 'data-recovery-meta'),
      node('p', `Source: ${data.source.source_host.name} · TLI ${data.source.tli_version} · Exported ${new Date(data.source.exported_at).toLocaleString()}`, 'data-recovery-meta'));
    const counts = node('ul', null, 'data-recovery-copy-counts');
    [['notebook', 'Notes & fixes records'], ['conversations', 'AI conversations'], ['diagnostics', 'Diagnostic reports']].forEach(([id, label]) => counts.append(node('li', `${label}: ${data.counts[id].toLocaleString()}`)));
    counts.append(node('li', Object.hasOwn(data.counts, 'cases') ? `Troubleshooting problems: ${data.counts.cases.toLocaleString()}` : 'Troubleshooting is not included in this earlier archive.'));
    box.append(counts, node('p', 'Only this account’s retained saved records are copied. Notes include retained deleted records; this is not a merge into the current account.'),
      node('p', recoveryExclusions, 'data-recovery-meta'), node('p', 'Archive SHA-256: ' + data.archive_sha256, 'data-backup-hash'));
  }
  function renderRecoveryReview(data) {
    const box = $('recovery-copy-review-result'); box.replaceChildren(); box.hidden = false;
    box.append(node('h3', 'Review the separate copy'));
    recoveryFacts(box, data);
    box.append(node('p', 'This folder will contain recovered data, not an installed application. Your current TLI host and data will stay in use.', 'data-recovery-meta'),
      node('p', 'Checked: ' + new Date(data.checked_at).toLocaleString() + ' · Review expires: ' + new Date(data.expires_at).toLocaleString(), 'data-recovery-meta'));
    const scope = node('details'); scope.append(node('summary', 'Recovery scope and requirements'));
    for (const [title, values] of [['Included', data.included], ['Excluded', data.excluded], ['Limits', data.limitations]]) { const list = node('ul'); values.forEach(value => list.append(node('li', value))); scope.append(node('h4', title), list); }
    if (Number.isSafeInteger(data.required_free_bytes) && Number.isSafeInteger(data.available_free_bytes)) scope.append(node('p', `Destination free space: ${data.available_free_bytes.toLocaleString()} bytes · Required estimate: ${data.required_free_bytes.toLocaleString()} bytes`, 'data-recovery-meta'));
    box.append(scope);
    $('recovery-copy-confirmation').hidden = false;
  }
  function renderRecoveryReceipt(data) {
    const box = $('recovery-copy-receipt'); box.replaceChildren(); box.hidden = false;
    box.append(node('h3', 'Separate recovery copy created'), node('p', 'Completed: ' + new Date(data.completed_at).toLocaleString(), 'data-recovery-meta'));
    recoveryFacts(box, data);
    box.append(node('p', 'Current application readers reopened the recovered copy. The copy was not activated.', 'data-backup-verdict'),
      node('p', 'Keep the original archive and this receipt. Review the separate copy before any future installation or activation. No application was installed or started.'));
  }
  function recoveryDraft() {
    const file = $('recovery-copy-file').files?.[0], password = $('recovery-copy-password').value, destination = $('recovery-copy-destination').value.trim();
    if (!privateConnection()) throw new Error('Open TLI on its host computer or use its secure HTTPS address before submitting an archive password.');
    if (!file || !file.name.toLowerCase().endsWith('.tlibackup') || file.size < 80 || file.size > maxArchiveBytes) throw new Error('Choose one .tlibackup file no larger than 64 MiB.');
    if (!passwordValid(password)) throw new Error('Enter the archive password (at least 12 characters).');
    if (/^(?:\\\\|\/\/)/.test(destination)) throw new Error('Choose a local folder on the TLI host. Network shares are not supported for recovery.');
    if (!destination || destination.length > 1024 || /[\r\n\0]/.test(destination) || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(destination)) throw new Error('Enter the full host path of a new folder under an existing parent.');
    return { file, password, destination };
  }
  function recoveryForm(draft, token) {
    const form = new FormData(); form.append('file', draft.file); form.append('password', draft.password);
    form.append('destination', draft.destination); form.append('request_id', requestID());
    if (token) form.append('review_token', token);
    return form;
  }
  async function reviewRecovery() {
    if (recovery.busy || recovery.locked) return;
    let draft; try { draft = recoveryDraft(); } catch (error) { backupNotice('recovery-copy-status', error.message, true); return; }
    const epoch = recovery.epoch; discardRecoveryReview(); recoveryBusy(true); recovery.controller = new AbortController();
    backupNotice('recovery-copy-status', 'Checking this archive and destination for review. A recovery folder has not been requested.' + (recovery.receipt ? ' The completed receipt below describes an earlier copy.' : ''));
    try {
      const hash = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await draft.file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (epoch !== recovery.epoch) return;
      const response = await fetch('/api/intelligence/backups/recovery/review', { method: 'POST', cache: 'no-store', redirect: 'error', signal: recovery.controller.signal, headers: { 'Accept': 'application/json' }, body: recoveryForm(draft) });
      if (epoch !== recovery.epoch) return;
      if (response.status === 401) { recovery.locked = true; clear(); return; }
      const data = await response.json().catch(() => null);
      if (epoch !== recovery.epoch) return;
      if (!response.ok) throw new Error(text(data?.detail) ? data.detail : `Recovery review failed (${response.status}).`);
      if (!validRecovery(data, hash) || !textList(data.included) || !textList(data.excluded) || !textList(data.limitations) || !Number.isFinite(Date.parse(data.checked_at)) || !text(data.review_token, 1024) || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now()) throw new Error('TLI returned an incomplete or expired recovery review. No copy can be created from it.');
      recovery.review = data; recovery.request = draft; renderRecoveryReview(data);
      backupNotice('recovery-copy-status', 'Review ready. Check the source account, destination and contents, then acknowledge the separate copy before creating it.');
    } catch (error) {
      if (epoch !== recovery.epoch) return;
      discardRecoveryReview();
      backupNotice('recovery-copy-status', (error?.message || 'Recovery review could not complete.') + ' No create request was sent. Review again when ready.' + (recovery.receipt ? ' The previous completed receipt remains below.' : ''), true);
    } finally {
      if (epoch === recovery.epoch) { recovery.controller = null; recoveryBusy(false); }
    }
  }
  async function createRecovery() {
    if (recovery.busy || recovery.locked) return;
    if (!recovery.review || !$('recovery-copy-ack').checked) { backupNotice('recovery-copy-status', 'Review and acknowledge this separate copy first.', true); return; }
    let draft; try { draft = recoveryDraft(); } catch (error) { discardRecoveryReview(); backupNotice('recovery-copy-status', error.message, true); return; }
    const review = recovery.review, reviewed = recovery.request;
    if (draft.file !== reviewed.file || draft.password !== reviewed.password || draft.destination !== reviewed.destination || Date.parse(review.expires_at) <= Date.now()) {
      discardRecoveryReview(); backupNotice('recovery-copy-status', 'The review expired or its archive, password or destination changed. Review the copy again.', true); return;
    }
    const epoch = recovery.epoch; recoveryBusy(true); recovery.creating = true; recovery.controller = new AbortController();
    let responseReceived = false, requestStarted = false;
    backupNotice('recovery-copy-status', 'Creating the reviewed separate data copy on the TLI host…' + (recovery.receipt ? ' The receipt below is from an earlier completed copy.' : ''));
    try {
      const form = recoveryForm({ ...draft, destination: review.destination }, review.review_token);
      requestStarted = true;
      const response = await fetch('/api/intelligence/backups/recovery/create', { method: 'POST', cache: 'no-store', redirect: 'error', signal: recovery.controller.signal, headers: { 'Accept': 'application/json' }, body: form });
      if (epoch !== recovery.epoch) return;
      if (response.status === 401) { recovery.creating = false; recovery.locked = true; clear(); return; }
      const data = await response.json().catch(() => null);
      if (epoch !== recovery.epoch) return;
      responseReceived = !response.ok;
      if (!response.ok) throw new Error(text(data?.detail) ? data.detail : `Recovery creation failed (${response.status}).`);
      if (!validRecovery(data, review.archive_sha256) || data.destination !== review.destination || data.owner_mapping.source_owner !== review.owner_mapping.source_owner || (Object.keys(data.counts).length !== Object.keys(review.counts).length || recoveryKeys(review).some(id => data.counts[id] !== review.counts[id])) || !Number.isFinite(Date.parse(data.completed_at)) || data.readback?.ok !== true || data.readback.schema_version !== 1 || data.readback.reader !== 'current-application' || data.readback.owner !== 'local' || !data.readback.checks || Array.isArray(data.readback.checks) || Object.keys(data.readback.checks).length !== recoveryReadbackChecks.length || !recoveryReadbackChecks.every(key => data.readback.checks[key] === true) || !Number.isFinite(Date.parse(data.readback.checked_at)) || (Object.keys(data.readback.counts || {}).length !== recoveryKeys(data).length || recoveryKeys(data).some(id => data.readback.counts?.[id] !== data.counts[id]))) throw new Error('TLI did not return a complete recovery receipt.');
      recovery.receipt = data; recovery.uncertain = false; renderRecoveryReceipt(data);
      backupNotice('recovery-copy-status', 'Separate copy created and read back successfully. Your current TLI host and data remain in use.');
    } catch (error) {
      if (epoch !== recovery.epoch) return;
      recovery.uncertain = requestStarted && !responseReceived;
      backupNotice('recovery-copy-status', (error?.message || 'The recovery request could not complete.') + (recovery.uncertain ? ' The outcome is uncertain: the host may have created the folder. Check that destination before another review.' : ' A new review is required before another create request.') + ' Nothing was retried.' + (recovery.receipt ? ' The previous completed receipt remains below; it does not describe this attempt.' : ''), true);
    } finally {
      if (epoch === recovery.epoch) {
        recovery.creating = false; recovery.controller = null; recovery.busy = false;
        discardRecoveryReview(); $('recovery-copy-password').value = ''; recoveryBusy(false);
      }
    }
  }
  function recoveryControls() {
    const section = node('details', null, 'data-recovery-copy'); section.id = 'recovery-copy-settings';
    section.append(node('summary', 'Recover into a separate copy'));
    const body = node('div', null, 'data-recovery-copy-body');
    body.append(node('p', 'Recover notes, conversations and diagnostic reports into a new folder on the computer hosting TLI. Review the account mapping and exact destination first. This does not replace your current data or switch this TLI host to the copy.'));
    const steps = node('ol', null, 'data-recovery-copy-steps');
    ['Choose archive and destination', 'Review what will be recovered', 'Create the separate copy'].forEach(label => steps.append(node('li', label))); body.append(steps);
    const fields = node('div', null, 'data-recovery-copy-fields');
    function field(id, label, type) {
      const wrapper = node('label', null, 'data-backup-field'); wrapper.append(node('span', label));
      const input = node('input'); input.id = id; input.type = type; input.autocomplete = 'off';
      if (type === 'password') { input.maxLength = 1024; input.spellcheck = false; }
      wrapper.append(input); fields.append(wrapper);
      input.addEventListener(type === 'file' ? 'change' : 'input', () => {
        if (recovery.busy) return;
        if (recovery.review) { discardRecoveryReview(); backupNotice('recovery-copy-status', 'The archive, password or destination changed. Review the new copy before creating it.'); }
      }); return input;
    }
    const file = field('recovery-copy-file', 'Saved .tlibackup archive (up to 64 MiB)', 'file'); file.accept = '.tlibackup';
    field('recovery-copy-password', 'Archive password', 'password');
    const destination = field('recovery-copy-destination', 'Full path of a new folder on the TLI host', 'text'); destination.maxLength = 1024; destination.spellcheck = false;
    destination.setAttribute('aria-describedby', 'recovery-copy-destination-help');
    const help = node('p', 'Choose a new local folder under an existing parent, outside the current TLI installation. The destination must not already exist. Network shares are not supported. This path belongs to the TLI host, not the phone or browser viewing this page.', 'data-recovery-meta'); help.id = 'recovery-copy-destination-help';
    body.append(fields, help);
    const review = node('button', 'Review recovery copy', 'btn-outline'); review.id = 'recovery-copy-review'; review.type = 'button'; review.addEventListener('click', reviewRecovery);
    const status = node('p', 'Choose an archive and a new destination folder, then review the copy before creating it.', 'data-recovery-status'); status.id = 'recovery-copy-status'; status.setAttribute('role', 'status');
    const result = node('div', null, 'data-backup-report'); result.id = 'recovery-copy-review-result'; result.hidden = true;
    const confirmation = node('div', null, 'data-recovery-copy-confirmation'); confirmation.id = 'recovery-copy-confirmation'; confirmation.hidden = true;
    const ack = node('label', null, 'data-backup-ack'), checkbox = node('input'); checkbox.id = 'recovery-copy-ack'; checkbox.type = 'checkbox'; checkbox.disabled = true;
    ack.append(checkbox, node('span', 'I reviewed the account, contents and destination. Create only this separate copy; keep the current TLI data and active host unchanged.'));
    checkbox.addEventListener('change', () => recoveryBusy(recovery.busy));
    const create = node('button', 'Create reviewed copy', 'btn-primary'); create.id = 'recovery-copy-create'; create.type = 'button'; create.disabled = true; create.addEventListener('click', createRecovery);
    confirmation.append(ack, create);
    const receipt = node('div', null, 'data-backup-report'); receipt.id = 'recovery-copy-receipt'; receipt.hidden = true; receipt.setAttribute('aria-live', 'polite');
    body.append(review, status, result, confirmation, receipt); section.append(body);
    section.addEventListener('toggle', () => { if (!section.open) clearRecovery(); });
    return section;
  }
  function init() {
    const panel = $('panel-settings'); if (!panel || $('data-recovery-settings')) return;
    const section = node('details', null, 'data-recovery'); section.id = 'data-recovery-settings';
    section.setAttribute('data-settings-keywords', 'Notebook notes saved memory history chats conversations reports diagnostics backup archive recovery password');
    section.append(node('summary', 'Saved data & backups'));
    const body = node('div', null, 'data-recovery-body');
    const notes = node('section', null, 'data-recovery-notes');
    notes.append(node('h3', 'Notes & fixes, chats and Vault'), node('p', 'Notes & fixes holds details you choose to keep: your setup, preferences, past fixes and reviewed copies of chat messages. Chat history keeps the conversation itself. Saving a conversation does not automatically turn it into a note. Vault notes stay in Vault behind its separate passphrase and are not included in this backup.'));
    notes.append(node('p', 'With “Use saved notes” enabled in AI Chat, TLI may include relevant notes. Selecting specific notes uses only those notes and your next question, without earlier conversation. Saved notes are context, not fresh measurements of your computer.', 'data-recovery-meta'));
    const openNotes = node('button', 'Open Notes & fixes', 'btn-outline'); openNotes.id = 'data-recovery-open-notes'; openNotes.type = 'button';
    openNotes.addEventListener('click', () => {
      if (typeof window.TLINotebook?.open === 'function') window.TLINotebook.open();
      else notice('Notes & fixes is unavailable in this page. Reopen TLI and use AI Chat → Options → Notes & fixes.', true);
    });
    notes.append(openNotes);
    body.append(notes, node('h3', 'Check saved data'), node('p', 'Check whether your saved notes, conversations and diagnostic reports can be read on the computer hosting TLI. This check does not create or verify a backup.', 'data-recovery-intro'));
    const controls = node('div', null, 'data-recovery-controls');
    const refresh = node('button', 'Check saved data', 'btn-outline'); refresh.id = 'data-recovery-check'; refresh.type = 'button'; refresh.addEventListener('click', check);
    controls.append(refresh, node('span', 'Runs only when you choose this check.', 'data-recovery-meta'));
    const status = node('p', 'No saved-data check has run in this view.', 'data-recovery-status'); status.id = 'data-recovery-status'; status.setAttribute('role', 'status');
    const report = node('div'); report.id = 'data-recovery-report'; report.hidden = true;
    body.append(controls, status, report, backupControls(), recoveryControls()); section.append(body); panel.append(section);
    section.addEventListener('toggle', () => { if (!section.open) clearRecovery(); });
    document.addEventListener?.('tli-panel-switched', event => { if (event.detail?.panelId !== 'panel-settings') clearRecovery(); });
    if (typeof MutationObserver === 'function') {
      const visibility = new MutationObserver(() => {
        if ((recovery.review || recovery.busy || $('recovery-copy-password')?.value) && section.closest?.('[hidden], .hidden')) clearRecovery();
      });
      visibility.observe(panel, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    }
    window.addEventListener('tli-session-locked', () => { recovery.locked = true; clear(); });
    window.addEventListener('tli-session-unlocked', () => { recovery.locked = false; recoveryBusy(false); }); window.addEventListener('pagehide', clear);
    document.addEventListener?.('visibilitychange', () => { if (document.hidden) clear(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
