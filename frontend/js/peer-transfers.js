/* Explicit encrypted Inbox transfers. No peer traffic on navigation. */
(function () {
  'use strict';
  const PROTOCOL = 'tli-peer-file-v1', CHUNK = 65536, MAX_FILE = 250 * 1024 * 1024;
  const FINAL = new Set(['received', 'delivered', 'cancelled', 'declined', 'expired', 'discarded']);
  let dialog, list, note, draftBox, reviewBox, opener, selectedPeer = null;
  let epoch = 0, locked = false, open = false, running = false, records = [], draft = null, timer = null;
  const active = token => token === epoch && !locked && open && !document.hidden;
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const bytes = value => value < 1024 ? value + ' B' : (value / 1048576).toFixed(2) + ' MiB';
  function message(text, error = false) { if (!note) return; note.textContent = text; note.dataset.error = String(error); }
  function valid(row) {
    if (!row || row.protocol !== PROTOCOL || !/^[a-f0-9]{32}$/.test(row.id) || !['incoming', 'outgoing'].includes(row.direction)
      || !row.peer || typeof row.peer.id !== 'string' || typeof row.peer.name !== 'string' || row.peer.name.length > 300
      || typeof row.filename !== 'string' || row.filename.length > 180 || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_FILE
      || !['staging', 'offered', 'accepted', 'uncertain', ...FINAL].includes(row.state)
      || !Number.isSafeInteger(row.staged_bytes) || row.staged_bytes < 0 || row.staged_bytes > row.size
      || !Number.isSafeInteger(row.acknowledged_bytes) || row.acknowledged_bytes < 0 || row.acknowledged_bytes > row.size
      || !Number.isFinite(row.expires_at) || typeof row.verified !== 'boolean'
      || !(row.sha256 === null || typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256))
      || (['offered', 'accepted', 'received', 'delivered'].includes(row.state) && row.sha256 === null)
      || row.verified !== ['received', 'delivered'].includes(row.state)
      || (row.state === 'received' && (row.direction !== 'incoming' || row.staged_bytes !== row.size))
      || (row.state === 'delivered' && (row.direction !== 'outgoing' || row.staged_bytes !== row.size || row.acknowledged_bytes !== row.size))) throw Error('The transfer response is unavailable or incompatible. Refresh TLI before continuing.');
    return row;
  }
  function bound(prior, response, action) {
    valid(response);
    if (['id', 'direction', 'filename', 'size'].some(key => prior[key] !== response[key])
      || prior.peer.id !== response.peer.id || prior.peer.name !== response.peer.name
      || (prior.sha256 !== null && prior.sha256 !== response.sha256)) throw Error('The response belongs to a different transfer. The previous record was preserved.');
    const states = {offer: ['offered'], accept: ['accepted'], review: ['offered', 'accepted'], 'send-next': ['accepted'], complete: ['delivered'],
      'peer-status': ['offered', 'accepted', 'delivered', 'declined', 'cancelled', 'expired'], cancel: ['cancelled'], decline: ['declined'], discard: ['discarded'], stage: ['staging']};
    if (states[action] && !states[action].includes(response.state)) throw Error('The operation was not confirmed in its expected state. Check the recorded transfer before continuing.');
    if (action === 'send-next' && response.acknowledged_bytes !== Math.min(prior.size, prior.acknowledged_bytes + CHUNK)) throw Error('The chunk acknowledgment did not advance by the exact expected amount. No retry was sent.');
    return response;
  }
  async function api(path, body, token = epoch) {
    const response = await fetch('/mesh/files' + path, {method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json();
    if (!active(token)) throw Error('Transfer paused. Reopen the Inbox to check its recorded state.');
    if (!response.ok) throw Error(value?.detail?.message || (typeof value?.detail === 'string' ? value.detail : 'The transfer request failed. Check status before retrying.'));
    return value;
  }
  async function gate(token) {
    if (!window.TLIRelease?.requireCapability) throw Error('Refresh TLI to load the secure file-transfer capability check.');
    await window.TLIRelease.requireCapability('trusted_file_transfer_v1');
    if (!active(token)) throw Error('The transfer review is no longer open.');
  }
  function upsert(row) { valid(row); const i = records.findIndex(r => r.id === row.id); if (i < 0) records.unshift(row); else records[i] = row; paint(); return row; }
  async function refresh(token = epoch) {
    const result = await api('', undefined, token);
    if (!result || result.protocol !== PROTOCOL || result.ok !== true || !Array.isArray(result.transfers) || result.transfers.length > 256) throw Error('The private transfer list was not valid.');
    const next = result.transfers.map(valid);
    if (!active(token)) return;
    records = next; paint();
  }
  function button(text, action, danger = false) {
    const n = el('button', text, 'btn btn-outline' + (danger ? ' peer-file-danger' : '')); n.type = 'button';
    n.addEventListener('click', async () => {
      if (n.disabled || locked) return;
      const token = epoch; n.disabled = true;
      try { await action(token); } catch (error) { if (active(token)) message(error.message, true); }
      finally { n.disabled = false; }
    }); return n;
  }
  async function act(row, action, token, body = {}) {
    const result = bound(row, await api('/' + row.id + '/' + action, body, token), action);
    if (action === 'offer' && draft?.id === row.id) { draft = null; draftBox.replaceChildren(); }
    return upsert(result);
  }
  function paint() {
    if (!list) return;
    list.replaceChildren();
    if (!records.length) list.append(el('p', 'No transfers for this account. Offers and filenames remain private to their receiving owner.'));
    for (const row of records) {
      const card = el('article', undefined, 'peer-file-card'); card.dataset.transferId = row.id;
      card.append(el('h3', row.filename), el('p', (row.direction === 'incoming' ? 'From ' : 'To ') + row.peer.name + ' · ' + bytes(row.size)));
      const labels = {received: 'Verified in encrypted TLI Inbox', delivered: 'Receiver confirmed complete file checksum', uncertain: 'Acknowledgment uncertain — check status explicitly', offered: row.direction === 'incoming' ? 'Waiting for your review' : 'Waiting for receiver consent', accepted: 'Receiver consent recorded', staging: 'Preparing on this host', cancelled: 'Stopped locally', declined: 'Offer declined', expired: 'Review period expired', discarded: 'Local content discarded'};
      card.append(el('p', labels[row.state], 'peer-file-state'));
      if (row.sha256) card.append(el('p', 'SHA-256: ' + row.sha256, 'peer-file-hash'));
      const count = row.direction === 'incoming' || row.state === 'staging' ? row.staged_bytes : row.acknowledged_bytes;
      const progress = el('progress'); progress.max = Math.max(1, row.size); progress.value = count; progress.setAttribute('aria-label', 'Recorded file progress');
      card.append(progress, el('p', (row.state === 'discarded' ? 'Historical progress before local discard: ' : row.direction === 'incoming' ? 'Received and stored: ' : row.state === 'staging' ? 'Staged on this host: ' : 'Peer-acknowledged: ') + bytes(count) + ' / ' + bytes(row.size)));
      const controls = el('div', undefined, 'peer-file-actions');
      if (row.direction === 'incoming' && ['offered', 'accepted'].includes(row.state)) {
        controls.append(button(row.state === 'accepted' ? 'Review / renew session consent' : 'Review incoming file', token => review(row, token)));
        if (row.state === 'offered') controls.append(button('Decline', token => act(row, 'decline', token), true));
      }
      if (row.direction === 'outgoing' && !FINAL.has(row.state)) {
        if (row.resume_required) controls.append(button('Resume in this session', async token => { await gate(token); await act(row, 'resume', token); message('Session renewed. Check receiver status before sending content.'); }));
        if (row.state === 'staging' && row.staged_bytes === row.size) controls.append(button('Offer file to receiver', async token => { await gate(token); await act(row, 'offer', token); message('Only the offer metadata was sent. The receiver must review and accept it.'); }));
        if (['offered', 'accepted', 'uncertain'].includes(row.state)) controls.append(button('Check receiver status', token => act(row, 'peer-status', token)));
        if (row.state === 'accepted') controls.append(button('Send accepted file', token => send(row, token)));
        if (row.state === 'uncertain' && row.uncertain_operation === 'offer') controls.append(button('Retry same metadata offer', async token => { await gate(token); await act(row, 'offer', token); }));
      }
      if (row.direction === 'incoming' && row.state === 'received' && row.verified) controls.append(button('Download verified file', () => {
        const a = el('a'); a.href = '/mesh/files/' + row.id + '/download'; a.download = row.filename; a.rel = 'noopener'; a.click();
        message('Download requested. Your browser chooses the download location and reports whether saving succeeded.');
      }));
      if (!FINAL.has(row.state)) controls.append(button('Stop this transfer', async token => { await act(row, 'cancel', token); message('Stopped on this host. Content already received is not recalled; the other computer may retain its own copy.'); }, true));
      controls.append(button('Discard local content', async token => {
        if (!window.confirm('Discard this transfer’s local encrypted content? This does not remove copies on the other computer or existing downloads.')) return;
        await act(row, 'discard', token); message('Local retained content discarded. The bounded receipt remains until its expired offer can be forgotten.');
      }, true));
      card.append(controls); list.append(card);
    }
  }
  async function review(row, token) {
    await gate(token);
    const result = bound(row, await api('/' + row.id + '/review', {}, token), 'review');
    if (typeof result.review_id !== 'string' || !/^[a-f0-9]{48}$/.test(result.review_id)) throw Error('The exact receiver review was unavailable.');
    reviewBox.replaceChildren(el('h3', 'Review this incoming file'), el('p', result.filename + ' · ' + bytes(result.size)),
      el('p', 'From reviewed computer: ' + result.peer.name), el('p', 'SHA-256: ' + result.sha256, 'peer-file-hash'),
      el('p', 'Receive into TLI Inbox (encrypted on host)'), el('p', 'TLI will verify the complete checksum before making it downloadable. Download afterward to choose a browser download location. This grants consent for this file only; no commands or automatic future transfers.'));
    reviewBox.append(button('Receive into TLI Inbox (encrypted on host)', async current => {
      await gate(current); await act(row, 'accept', current, {review_id: result.review_id});
      reviewBox.replaceChildren(); message('This file is accepted for the remaining offer period while this session stays valid. The sender can now send its chunks.');
    }), button('Keep pending', () => reviewBox.replaceChildren()));
    reviewBox.hidden = false; reviewBox.scrollIntoView({block: 'nearest'});
  }
  async function prepare(token) {
    if (running || !draft) return;
    await gate(token);
    if (running || !active(token) || !draft) return;
    running = true;
    const current = draft;
    try {
      const r = valid(await api('/outgoing', {request_id: current.requestId, peer_id: current.peer.id, filename: current.file.name, size: current.file.size}, token));
      if (r.direction !== 'outgoing' || r.peer.id !== current.peer.id || r.filename !== current.file.name || r.size !== current.file.size || r.state !== 'staging') throw Error('The prepared file record did not match this selected file. No chunks were sent.');
      if (r.staged_bytes !== r.size && r.staged_bytes % CHUNK !== 0) throw Error('The recorded staging offset is not a complete chunk boundary. Preparation paused.');
      current.id = r.id; upsert(r);
      let row = r;
      for (let offset = row.staged_bytes; offset < current.file.size; offset += CHUNK) {
        if (!active(token)) return;
        const chunk = new Uint8Array(await current.file.slice(offset, offset + CHUNK).arrayBuffer());
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk)), b => b.toString(16).padStart(2, '0')).join('');
        if (!active(token)) return;
        let binary = ''; for (const value of chunk) binary += String.fromCharCode(value);
        const next = bound(row, await api('/' + r.id + '/stage', {index: offset / CHUNK, data: btoa(binary), sha256: hash}, token), 'stage');
        if (next.staged_bytes !== Math.min(current.file.size, offset + CHUNK)) throw Error('Local staging did not confirm the exact chunk length. Preparation paused.');
        row = next; upsert(row);
      }
      if (active(token)) message('The selected file is prepared on this host. Choose Offer file to send its metadata for receiver review.');
    } finally { running = false; }
  }
  async function send(row, token) {
    if (running) return;
    await gate(token);
    if (running || !active(token)) return;
    running = true;
    try {
      // Explicit click first reconciles consent/progress; no replay of uncertain chunks.
      row = await act(row, 'peer-status', token);
      if (row.state !== 'accepted') throw Error('The receiver has not supplied current consent. No content was sent.');
      while (row.acknowledged_bytes < row.size) {
        if (!active(token)) return;
        row = await act(row, 'send-next', token);
      }
      if (!active(token)) return;
      row = await act(row, 'complete', token);
      message('The receiver confirmed the complete file checksum in its encrypted TLI Inbox.');
    } finally { running = false; }
  }
  function chooseFile(token) {
    if (!window.isSecureContext || typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function' || typeof crypto.subtle?.digest !== 'function') throw Error('Open TLI over HTTPS (or localhost on the host) to prepare encrypted transfers.');
    const peer = selectedPeer && {...selectedPeer};
    const input = el('input'); input.type = 'file'; input.multiple = false;
    input.addEventListener('change', () => {
      const file = input.files?.[0]; if (!file || !active(token) || !peer || selectedPeer?.id !== peer.id) return;
      if (!Number.isSafeInteger(file.size) || file.size > MAX_FILE) { message('Select one regular file of at most 250 MiB.', true); return; }
      draft = {file, peer, requestId: crypto.randomUUID().replaceAll('-', '')};
      draftBox.replaceChildren(el('h3', 'Prepare an offer'), el('p', file.name + ' · ' + bytes(file.size) + ' · To ' + peer.name),
        el('p', 'Preparation encrypts the selected file on this host in 64 KiB chunks. No content goes to the peer until its owner accepts the separate offer.'),
        button('Prepare on this host', token => prepare(token)));
    }); input.click();
  }
  function pause() { epoch++; if (timer) clearTimeout(timer); timer = null; }
  function close() { open = false; pause(); if (dialog?.open) dialog.close(); if (!locked) opener?.focus(); }
  function build() {
    if (dialog) return;
    dialog = el('dialog', undefined, 'peer-files-dialog'); dialog.id = 'peer-files-dialog'; dialog.setAttribute('aria-labelledby', 'peer-files-title');
    const title = el('h2', 'Files between reviewed computers'); title.id = 'peer-files-title';
    note = el('p', '', 'peer-file-notice'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
    draftBox = el('section', undefined, 'peer-file-draft'); reviewBox = el('section', undefined, 'peer-file-review'); reviewBox.hidden = true;
    list = el('section', undefined, 'peer-file-list'); list.setAttribute('aria-label', 'Private transfer records');
    const actions = el('div', undefined, 'peer-file-actions');
    actions.append(button('Choose one file', async token => { await gate(token); if (!selectedPeer) throw Error('Select a reviewed computer in LAN Messages before choosing a file.'); chooseFile(token); }),
      button('Refresh this Inbox', token => refresh(token)), button('Close', close));
    dialog.append(title, el('p', 'Each file requires receiver review. Files stay encrypted in the managed TLI Inbox; downloading is a separate browser action. Maximum 250 MiB per file, four active offers per account, and a bounded retained Inbox.'),
      el('p', 'Closing or leaving this page pauses this browser’s transfer loop. It does not cancel the offer or erase bytes already received. Use Stop explicitly. Offers expire after 30 minutes.'), actions, note, draftBox, reviewBox, list);
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    document.body.append(dialog);
  }
  async function show(peer) {
    if (locked) return;
    build(); opener = document.activeElement; selectedPeer = peer && typeof peer.id === 'string' ? {id: peer.id, name: String(peer.name || peer.display_name || peer.id)} : null;
    open = true; epoch++; const token = epoch;
    if (!dialog.open) dialog.showModal();
    message('Loading this account’s private transfer records…');
    try { await refresh(token); if (active(token)) message(selectedPeer ? 'Selected computer: ' + selectedPeer.name : 'Inbox review. Select a computer in LAN Messages to prepare a new outgoing offer.'); }
    catch (error) { if (active(token)) message(error.message, true); }
  }
  function mount() {
    const target = document.querySelector('.tli-chat-titleblock'); if (!target || document.getElementById('peer-files-inbox')) return;
    const n = button('Encrypted file Inbox', () => show(null)); n.id = 'peer-files-inbox'; target.append(n);
  }
  window.TLIPeerTransfers = {open: show, onClose: close, mount};
  window.addEventListener('tli-session-locked', () => { locked = true; close(); draft = null; records = []; selectedPeer = null; list?.replaceChildren(); draftBox?.replaceChildren(); reviewBox?.replaceChildren(); message(''); });
  window.addEventListener('tli-session-unlocked', () => { locked = false; epoch++; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); } else if (open && !locked) { message('Transfer loop paused. Refresh recorded state and continue explicitly.'); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  if (typeof module !== 'undefined' && module.exports) module.exports = {valid, bound, bytes, PROTOCOL, CHUNK, MAX_FILE};
})();
