/* Pi-hole access and changes are explicit; a DNS request is not a page visit. */
(function (root) {
  'use strict';
  const protocol = 'tli-pihole-v1', prefix = '/api/homelab/pihole/';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value, limit = 1000) => typeof value === 'string' && value.length <= limit;
  const text = (value, fallback = '') => string(value, 10000) ? value.slice(0, 1000) : fallback;
  const ids = value => Array.isArray(value) && value.length <= 1000 && value.every(id => Number.isInteger(id) && id >= 0) && new Set(value).size === value.length;
  const same = (a, b) => ids(a) && ids(b) && a.length === b.length && a.every(id => b.includes(id));
  const time = value => typeof value === 'string' && value.length < 100 && Number.isFinite(Date.parse(value));
  function literalIP(value) {
    if (!string(value, 128) || !value || value.includes('%')) return false;
    if (!value.includes(':')) return /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(part => Number(part) < 256);
    if (!/^[a-f\d:.]+$/i.test(value)) return false;
    try { return new URL('https://[' + value + ']').hostname.startsWith('['); } catch (_) { return false; }
  }
  function origin(value) {
    if (!string(value, 300)) return false;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && literalIP(url.hostname.replace(/^\[|\]$/g, '')); } catch (_) { return false; }
  }
  const connection = value => object(value) && string(value.id, 200) && value.id.length > 0 && origin(value.origin) && time(value.expires_at);
  const group = value => object(value) && Number.isInteger(value.id) && value.id >= 0 && string(value.name) && [true, false, 0, 1].includes(value.enabled) && (value.description === null || string(value.description, 1024));
  const client = value => object(value) && Number.isInteger(value.id) && string(value.client, 256) && value.client.length > 0 && (value.comment === null || string(value.comment, 1024)) && ids(value.groups) && typeof value.editable === 'boolean';
  const outcomes = ['prepared', 'confirmed', 'accepted', 'unknown', 'mismatch', 'not_attempted'];
  function receipt(value) {
    return object(value) && string(value.id, 200) && value.id.length > 0 && origin(value.origin) && literalIP(value.client)
      && ['groups', 'pause', 'restore'].includes(value.action) && object(value.before) && object(value.before.clientrecord)
      && value.before.clientrecord.client === value.client && ids(value.before.clientrecord.groups)
      && Array.isArray(value.before.groups) && value.before.groups.length <= 1000 && value.before.groups.every(group)
      && ids(value.after_groups) && object(value.outcome) && outcomes.includes(value.outcome.outcome)
      && typeof value.outcome.attempted === 'boolean' && typeof value.outcome.acknowledged === 'boolean'
      && typeof value.outcome.membership_verified === 'boolean' && string(value.outcome.summary, 3000);
  }
  const helpers = {literalIP, origin, same, receipt};
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (!root?.document) return;
  const document = root.document, refs = {};
  const state = {epoch: 0, locked: false, suspended: false, busy: false, controller: null, connections: [], connection: null, inventory: null, selected: null, review: null, reviewVersion: 0, activity: null, receipts: [], uncertain: false, expiryTimer: null, reviewTimer: null};
  const node = (tag, content, cls, id) => { const el = document.createElement(tag); if (content != null) el.textContent = content; if (cls) el.className = cls; if (id) { el.id = id; refs[id] = el; } return el; };
  const available = () => !state.locked && !state.suspended;
  const current = epoch => epoch === state.epoch && available();
  const live = () => connection(state.connection) && Date.parse(state.connection.expires_at) > Date.now();
  const editable = () => live() && state.selected?.editable === true && literalIP(state.selected.client);
  const stamp = value => time(value) ? new Date(value).toLocaleString() : 'Time not supplied';
  const queryStamp = value => typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toLocaleString() : stamp(value);
  const tell = value => { if (refs['pihole-status']) refs['pihole-status'].textContent = value; };
  function button(label, action, id, cls = 'btn-outline') {
    const el = node('button', label, cls, id); el.type = 'button'; el.addEventListener('click', action); return el;
  }
  function field(label, type, id, placeholder = '') {
    const wrapper = node('label', null, 'lab-field'); const input = node('input', null, null, id);
    input.type = type; input.placeholder = placeholder; input.autocomplete = 'off'; wrapper.append(node('span', label), input); return wrapper;
  }
  function clearPassword() { if (refs['pihole-password']) refs['pihole-password'].value = ''; }
  function invalidateReview() {
    state.reviewVersion++; state.review = null; clearTimeout(state.reviewTimer); state.reviewTimer = null;
    if (refs['pihole-review']) refs['pihole-review'].replaceChildren();
    if (refs['pihole-confirm']) refs['pihole-confirm'].checked = false;
  }
  function clearInventory() { state.inventory = null; state.selected = null; state.activity = null; invalidateReview(); }
  function reset(message, locked = state.locked) {
    state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false;
    state.locked = locked; state.connections = []; state.connection = null; state.receipts = []; state.uncertain = false;
    clearTimeout(state.expiryTimer); state.expiryTimer = null; clearInventory(); clearPassword();
    for (const id of ['pihole-origin', 'pihole-pin', 'pihole-search']) if (refs[id]) refs[id].value = '';
    render(); tell(message);
  }
  function sync() {
    if (!refs['pihole-workspace']) return;
    const disabled = !available() || state.busy;
    for (const id of ['pihole-connect', 'pihole-check', 'pihole-origin', 'pihole-password', 'pihole-pin']) refs[id].disabled = disabled;
    for (const id of ['pihole-inventory-read', 'pihole-disconnect']) refs[id].disabled = disabled || !live();
    refs['pihole-activity-read'].disabled = disabled || !editable();
    refs['pihole-groups-review'].disabled = disabled || !editable() || state.uncertain || !selectedGroups().length;
    refs['pihole-pause-review'].disabled = disabled || !editable() || state.uncertain || !state.selected?.groups.length;
    refs['pihole-apply'].disabled = disabled || !editable() || state.uncertain || !state.review || Date.parse(state.review.expires_at) <= Date.now() || !refs['pihole-confirm'].checked;
    refs['pihole-confirm'].disabled = disabled || !state.review;
    refs['pihole-client'].disabled = disabled || !state.inventory;
    refs['pihole-search'].disabled = disabled || !state.inventory;
    refs['pihole-unlock'].hidden = !state.locked;
    for (const el of state.groupInputs || []) el.disabled = disabled || !editable();
    for (const entry of state.restoreButtons || []) entry.el.disabled = disabled || !editable() || state.uncertain || !restorable(entry.value);
    for (const entry of state.connectionButtons || []) entry.el.disabled = disabled || Date.parse(entry.value.expires_at) <= Date.now();
    refs['pihole-workspace'].setAttribute('aria-busy', String(state.busy));
  }
  async function request(endpoint, payload, epoch) {
    if (!current(epoch)) throw Error('Pi-hole access changed.');
    const response = await fetch(prefix + endpoint, {method: payload === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: state.controller.signal,
      headers: {Accept: 'application/json', ...(payload === undefined ? {} : {'Content-Type': 'application/json'})}, ...(payload === undefined ? {} : {body: JSON.stringify(payload)})});
    if (!current(epoch)) throw Error('Pi-hole access changed.');
    if (response.status === 401 || response.status === 403) {
      reset('Pi-hole details cleared. Unlock TLI, then explicitly check the connection and saved changes.', true);
      root.dispatchEvent(new CustomEvent('tli-session-locked')); throw Error('TLI access must be verified.');
    }
    let raw = '', length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const {done, value} = await reader.read();
        if (!current(epoch)) { await reader.cancel(); throw Error('Pi-hole access changed.'); }
        if (done) break;
        length += value.byteLength;
        if (length > 4 * 1024 * 1024) { await reader.cancel(); throw Error('Pi-hole returned more data than this view supports.'); }
        raw += decoder.decode(value, {stream: true});
      }
      raw += decoder.decode();
    } else {
      raw = await response.text();
      if (!current(epoch)) throw Error('Pi-hole access changed.');
      if (new TextEncoder().encode(raw).length > 4 * 1024 * 1024) throw Error('Pi-hole returned more data than this view supports.');
    }
    if (!current(epoch)) throw Error('Pi-hole access changed.');
    let value; try { value = JSON.parse(raw); } catch (_) { throw Error('Pi-hole returned unreadable data.'); }
    if (!current(epoch)) throw Error('Pi-hole access changed.');
    if (!response.ok) throw Error(text(value.detail, 'The Pi-hole request could not be completed.'));
    if (value?.protocol !== protocol) throw Error('The Pi-hole response could not be verified.');
    return value;
  }
  async function run(message, operation) {
    if (!available() || state.busy) return;
    const epoch = state.epoch, controller = new AbortController();
    state.controller = controller; state.busy = true; tell(message); sync();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try { await operation(epoch); }
    catch (error) {
      if (current(epoch)) tell((error.name === 'AbortError' ? 'The request was interrupted or timed out.' : error.message)
        + (state.uncertain ? ' The change is unconfirmed. Check connection & saved changes before another review; do not repeat the action.' : '')
        + (state.receipts.length ? ' Earlier saved changes remain below.' : ''));
    } finally { clearTimeout(timeout); if (current(epoch)) { state.busy = false; state.controller = null; sync(); } }
  }
  function armExpiry() {
    clearTimeout(state.expiryTimer); state.expiryTimer = null;
    if (!state.connection) return;
    const selected = state.connection, epoch = state.epoch;
    const expire = () => {
      if (!current(epoch) || state.connection !== selected) return;
      state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false; clearPassword(); clearInventory();
      render(); tell('This Pi-hole connection has expired. Connect again to continue. Saved changes remain available for review.');
    };
    const remaining = Date.parse(selected.expires_at) - Date.now();
    if (remaining <= 0) expire(); else state.expiryTimer = setTimeout(expire, Math.min(remaining + 10, 2147483647));
  }
  function selectConnection(value) {
    if (!available() || state.busy || !state.connections.includes(value) || Date.parse(value.expires_at) <= Date.now()) return;
    state.connection = value; clearInventory(); render(); armExpiry(); tell('Connection selected. Read devices to get a current group snapshot.');
  }
  function connect() {
    if (!available() || state.busy) return;
    const payload = {origin: refs['pihole-origin'].value.trim(), password: refs['pihole-password'].value, certificate_sha256: refs['pihole-pin'].value.trim()};
    clearPassword();
    if (!origin(payload.origin) || !payload.password) { payload.password = ''; tell('Enter a Pi-hole HTTPS address using its private IP and an app password.'); return; }
    invalidateReview();
    return run('Connecting to this Pi-hole…', async epoch => {
      const pending = request('connect', payload, epoch); payload.password = ''; const value = await pending;
      if (!connection(value.connection) || new URL(value.connection.origin).origin !== new URL(payload.origin).origin || Date.parse(value.connection.expires_at) <= Date.now()) throw Error('The Pi-hole connection was not confirmed.');
      state.connection = value.connection; state.connections = [...state.connections.filter(row => row.id !== value.connection.id), value.connection];
      clearInventory(); render(); armExpiry(); tell('Connected for this TLI session. Read devices to inspect Pi-hole group assignments.');
    }).finally(() => { payload.password = ''; });
  }
  function check() {
    return run('Checking this session’s connections and saved changes…', async epoch => {
      const value = await request('status', undefined, epoch);
      if (!Array.isArray(value.connections) || value.connections.length > 100 || !value.connections.every(connection) || !Array.isArray(value.receipts) || value.receipts.length > 1000 || !value.receipts.every(receipt)) throw Error('Connection and saved-change details were not confirmed.');
      const previous = state.connection;
      state.connections = value.connections; state.receipts = value.receipts; state.uncertain = false;
      state.connection = state.connections.find(row => row.id === previous?.id && row.origin === previous.origin) || (state.connections.length === 1 ? state.connections[0] : null);
      if (!state.connection || state.connection.id !== previous?.id) clearInventory();
      invalidateReview(); render(); armExpiry();
      tell(state.connection && live() ? 'Session and saved changes checked. Choose an explicit read or review to continue.' : 'Saved changes checked. Connect to Pi-hole to read devices or review a restore.');
    });
  }
  function disconnect() {
    if (!live() || !available() || state.busy) return;
    const selected = state.connection; invalidateReview();
    return run('Disconnecting this Pi-hole session…', async epoch => {
      const value = await request('disconnect', {connection_id: selected.id}, epoch);
      if (value.disconnected !== true) throw Error('Disconnection was not confirmed. Check connection & saved changes.');
      state.connections = state.connections.filter(row => row.id !== selected.id); state.connection = null; clearTimeout(state.expiryTimer); clearInventory(); render();
      tell('Disconnected. Existing Pi-hole group changes remain in effect; disconnecting does not restore them.');
    });
  }
  function readInventory() {
    if (!live() || !available() || state.busy) return;
    const selected = state.connection; clearInventory(); renderDevices(); renderReview(); renderActivity();
    return run('Reading configured Pi-hole devices and groups…', async epoch => {
      const value = await request('inventory', {connection_id: selected.id}, epoch);
      if (!Array.isArray(value.clients) || value.clients.length > 10000 || !value.clients.every(client) || !Array.isArray(value.groups) || value.groups.length > 1000 || !value.groups.every(group) || !time(value.checked_at)
        || new Set(value.clients.map(row => row.client)).size !== value.clients.length || new Set(value.groups.map(row => row.id)).size !== value.groups.length) throw Error('The Pi-hole device inventory was not confirmed.');
      if (!live() || state.connection !== selected) throw Error('The Pi-hole connection expired. Connect again.');
      state.inventory = value; renderDevices(); renderReceipts(); tell('Device snapshot read. Select an exact IP to inspect activity or review group changes.');
    });
  }
  function chooseClient() {
    if (!available() || state.busy) { refs['pihole-client'].value = state.selected?.client || ''; return; }
    const value = refs['pihole-client'].value;
    state.selected = state.inventory?.clients.find(row => row.client === value) || null;
    state.activity = null; invalidateReview(); renderDevice(); renderActivity(); renderReceipts(); sync();
  }
  function selectedGroups() { return (state.groupInputs || []).filter(input => input.checked).map(input => Number(input.value)); }
  function restorable(value) { return receipt(value) && value.origin === state.connection?.origin && value.client === state.selected?.client; }
  function review(action, saved = null) {
    if (!available() || state.busy || !editable() || state.uncertain || (action === 'restore' && (!state.receipts.includes(saved) || !restorable(saved)))) return;
    const selected = state.selected, selectedConnection = state.connection;
    const after = action === 'groups' ? selectedGroups() : action === 'restore' ? saved.before.clientrecord.groups : [];
    if (!['groups', 'pause', 'restore'].includes(action) || (action === 'groups' && !after.length) || (action === 'pause' && !selected.groups.length)) return;
    invalidateReview(); const version = state.reviewVersion;
    return run('Preparing an exact device change for review…', async epoch => {
      const value = await request('review', {connection_id: selectedConnection.id, client: selected.client, action, groups: action === 'restore' ? [] : after, receipt_id: saved?.id || null}, epoch);
      if (version !== state.reviewVersion || state.selected !== selected || state.connection !== selectedConnection) return;
      if (!string(value.review_id, 200) || !value.review_id || !time(value.expires_at) || Date.parse(value.expires_at) <= Date.now() || !object(value.target) || value.target.client !== selected.client || value.target.origin !== selectedConnection.origin
        || value.action !== action || !same(value.before_groups, selected.groups) || !same(value.after_groups, after) || !Array.isArray(value.group_names) || value.group_names.length > 1000
        || !value.group_names.every(row => object(row) && Number.isInteger(row.id) && string(row.name)) || !string(value.scope, 3000)) throw Error('The exact device change was not confirmed. Read devices again before another review.');
      state.review = value; renderReview();
      state.reviewTimer = setTimeout(() => { if (current(epoch) && state.review === value) { invalidateReview(); renderReview(); sync(); tell('The review expired. Prepare a new review before applying any change.'); } }, Math.min(Date.parse(value.expires_at) - Date.now() + 10, 2147483647));
      tell('Review the exact Pi-hole address, device and group changes below. Nothing has been changed.');
    });
  }
  function execute() {
    if (!available() || state.busy || !editable() || state.uncertain || !state.review || !refs['pihole-confirm'].checked || Date.parse(state.review.expires_at) <= Date.now()) return;
    const reviewed = state.review, selectedConnection = state.connection;
    if (reviewed.target.client !== state.selected.client || reviewed.target.origin !== selectedConnection.origin) return;
    invalidateReview(); state.uncertain = true; clearInventory(); renderDevices(); renderReview(); renderActivity(); renderReceipts();
    return run('Applying the reviewed change once and checking group membership…', async epoch => {
      const value = await request('execute', {connection_id: selectedConnection.id, review_id: reviewed.review_id, reviewed: true}, epoch);
      if (!receipt(value.receipt) || value.receipt.client !== reviewed.target.client || value.receipt.origin !== reviewed.target.origin || value.receipt.action !== reviewed.action || !same(value.receipt.after_groups, reviewed.after_groups)) throw Error('The change outcome was not confirmed.');
      state.receipts = [value.receipt, ...state.receipts.filter(row => row.id !== value.receipt.id)]; state.uncertain = false; renderReceipts();
      tell(text(value.receipt.outcome.summary) + ' Read devices again before preparing another change.');
    });
  }
  function activity() {
    if (!available() || state.busy || !editable()) return;
    const selected = state.selected, selectedConnection = state.connection;
    state.activity = null; renderActivity();
    return run('Reading recent DNS requests for this exact device IP…', async epoch => {
      const value = await request('activity', {connection_id: selectedConnection.id, client: selected.client}, epoch);
      if (state.selected !== selected || state.connection !== selectedConnection) return;
      if (value.client !== selected.client || !Array.isArray(value.items) || value.items.length > 100 || !time(value.checked_at)
        || ![value.from, value.until].every(value => time(value) || typeof value === 'number' && Number.isFinite(value))
        || !value.items.every(row => object(row) && (time(row.time) || typeof row.time === 'number' && Number.isFinite(row.time)) && string(row.domain, 1000) && string(row.type, 100) && (row.status === null || string(row.status, 200)))) throw Error('The DNS activity response was not confirmed.');
      state.activity = value; renderActivity(); tell('Recent DNS activity read for ' + selected.client + '. This is a bounded snapshot, not a browsing history.');
    });
  }
  function renderConnections() {
    if (!refs['pihole-connections']) return;
    refs['pihole-connections'].replaceChildren(); state.connectionButtons = [];
    refs['pihole-connection-detail'].textContent = state.connection ? state.connection.origin + ' · Session ' + (live() ? 'expires ' : 'expired ') + stamp(state.connection.expires_at) : 'No Pi-hole connection selected in this view.';
    for (const value of state.connections) {
      if (value.id === state.connection?.id) continue;
      const epoch = state.epoch, el = button('Use ' + value.origin, () => { if (current(epoch)) selectConnection(value); });
      refs['pihole-connections'].append(el); state.connectionButtons.push({value, el});
    }
  }
  function renderDevices() {
    if (!refs['pihole-client']) return;
    const select = refs['pihole-client']; select.replaceChildren(); const placeholder = node('option', 'Choose a configured device'); placeholder.value = ''; select.append(placeholder);
    const needle = refs['pihole-search'].value.trim().toLowerCase();
    const rows = (state.inventory?.clients || []).filter(row => [row.client, row.comment].some(value => text(value).toLowerCase().includes(needle)));
    for (const row of rows) { const option = node('option', (row.comment ? row.comment + ' · ' : '') + row.client + (row.editable && literalIP(row.client) ? '' : ' · read only')); option.value = row.client; select.append(option); }
    if (state.selected && !rows.includes(state.selected)) { state.selected = null; state.activity = null; invalidateReview(); renderReview(); renderActivity(); }
    select.value = state.selected?.client || '';
    refs['pihole-inventory-detail'].textContent = state.inventory ? rows.length + ' matching configured devices · Snapshot ' + stamp(state.inventory.checked_at) : 'Read devices to see Pi-hole’s configured clients. Unconfigured network devices are not added here.';
    renderDevice(); sync();
  }
  function groupNames(values, definitions = state.inventory?.groups || []) {
    if (!values.length) return 'No groups — Pi-hole filtering bypassed for this client';
    return values.map(id => { const definition = definitions.find(row => row.id === id); return (definition ? definition.name : 'Unknown group') + ' (#' + id + ')'; }).join(', ');
  }
  function renderDevice() {
    const selected = state.selected, target = refs['pihole-selected'], groups = refs['pihole-groups']; if (!target || !groups) return;
    target.replaceChildren(); groups.replaceChildren(); state.groupInputs = [];
    if (!selected) { target.append(node('p', 'Select a device to see its assigned groups.', 'pihole-muted')); return; }
    target.append(node('h3', selected.comment || selected.client), node('p', 'Exact Pi-hole client: ' + selected.client), node('p', 'Current groups: ' + groupNames(selected.groups)));
    target.append(node('p', 'Confirm this IP belongs to the intended device. A router or shared DNS forwarder may represent several devices under one client IP.', 'pihole-muted'));
    if (!editable()) target.append(node('p', 'This selector is read only. Device changes and activity require a configured literal IP, not a MAC address, hostname, alias or subnet.', 'pihole-notice'));
    for (const value of state.inventory.groups) {
      const label = node('label', null, 'pihole-group'), input = node('input'); input.type = 'checkbox'; input.value = String(value.id); input.checked = selected.groups.includes(value.id);
      input.addEventListener('change', () => { invalidateReview(); renderReview(); sync(); });
      label.append(input, node('span', value.name + ' (#' + value.id + ')' + (value.enabled ? '' : ' · disabled'))); groups.append(label); state.groupInputs.push(input);
    }
    if (!state.inventory.groups.length) groups.append(node('p', 'No groups were returned.', 'pihole-muted'));
  }
  function renderReview() {
    const box = refs['pihole-review']; if (!box) return; box.replaceChildren(); refs['pihole-confirm'].checked = false;
    if (!state.review) { refs['pihole-review-controls'].hidden = true; return; }
    const value = state.review; refs['pihole-review-controls'].hidden = false;
    box.append(node('h3', value.action === 'pause' ? 'Review: pause this device until restored' : value.action === 'restore' ? 'Review: restore previous groups' : 'Review: assign device groups'));
    const list = node('dl', null, 'pihole-review-facts');
    for (const [label, content] of [['Pi-hole', value.target.origin], ['Exact device IP', value.target.client], ['Before', groupNames(value.before_groups, value.group_names)], ['After', groupNames(value.after_groups, value.group_names)], ['Review expires', stamp(value.expires_at)]]) list.append(node('dt', label), node('dd', content));
    box.append(list, node('p', value.scope, 'pihole-notice'), node('p', 'This targets one configured client IP. If it belongs to a router or shared DNS forwarder, the change can affect every device using that address.', 'pihole-muted'));
    if (!value.after_groups.length) box.append(node('p', 'This removes all group assignments for this client. Filtering stays paused until you explicitly restore groups, even if TLI closes or disconnects. There is no automatic timer.', 'pihole-notice'));
  }
  function renderActivity() {
    const box = refs['pihole-activity']; if (!box) return; box.replaceChildren();
    if (!state.activity) { box.append(node('p', 'Choose Read recent DNS activity for an explicit snapshot of the last 15 minutes, up to 100 requests.', 'pihole-muted')); return; }
    const value = state.activity;
    box.append(node('p', value.client + ' · ' + queryStamp(value.from) + ' to ' + queryStamp(value.until) + ' · Read ' + stamp(value.checked_at), 'pihole-muted'));
    if (!value.items.length) { box.append(node('p', 'No DNS requests were returned in this window. Pi-hole privacy settings, logging or a different device address may hide activity; this does not prove the device was inactive.', 'pihole-notice')); return; }
    const wrap = node('div', null, 'pihole-table-wrap'), table = node('table', null, 'pihole-table'), head = node('thead'), heading = node('tr'), body = node('tbody');
    for (const label of ['Time', 'Domain', 'Type', 'Pi-hole status']) { const cell = node('th', label); cell.setAttribute('scope', 'col'); heading.append(cell); } head.append(heading);
    for (const row of value.items) { const tr = node('tr'); for (const value of [queryStamp(row.time), row.domain, row.type, text(row.status, 'Not reported')]) tr.append(node('td', value)); body.append(tr); }
    table.append(head, body); wrap.append(table); box.append(wrap);
  }
  function renderReceipts() {
    const box = refs['pihole-receipts']; if (!box) return; box.replaceChildren(); state.restoreButtons = [];
    if (!state.receipts.length) { box.append(node('p', 'Check connection & saved changes to read retained change records. TLI keeps previous group assignments without saving the Pi-hole password.', 'pihole-muted')); return; }
    for (const value of state.receipts) {
      const card = node('article', null, 'pihole-receipt'), epoch = state.epoch;
      card.append(node('h4', value.client + ' · ' + (value.action === 'pause' ? 'Pause' : value.action === 'restore' ? 'Restore' : 'Group assignment')), node('p', value.origin, 'pihole-muted'), node('p', value.outcome.summary));
      card.append(node('p', 'Outcome: ' + value.outcome.outcome + ' · ' + (value.outcome.membership_verified ? 'Group membership verified' : 'Group membership not verified') + ' · ' + stamp(value.outcome.checked_at), 'pihole-muted'));
      card.append(node('p', 'Previous: ' + groupNames(value.before.clientrecord.groups, value.before.groups), 'pihole-muted'));
      {
        const el = button('Review restore of previous groups', () => { if (current(epoch) && state.receipts.includes(value)) return review('restore', value); });
        card.append(el, node('small', 'Connect to the same Pi-hole, read devices, and select this exact IP before reviewing a restore.')); state.restoreButtons.push({value, el});
      }
      box.append(card);
    }
    sync();
  }
  function render() { renderConnections(); renderDevices(); renderReview(); renderActivity(); renderReceipts(); sync(); }
  function init() {
    const mount = document.getElementById('pihole-mount'); if (!mount || refs['pihole-workspace']) return;
    const box = node('section', null, 'lab-section pihole-workspace', 'pihole-workspace'); box.setAttribute('aria-labelledby', 'pihole-title'); mount.append(box);
    const heading = node('div', null, 'lab-section-heading'); heading.append(node('h2', 'Pi-hole · device DNS', null, 'pihole-title'), node('span', 'Pi-hole v6', 'lab-badge')); box.append(heading);
    box.append(node('p', 'See recent DNS requests, assign filtering groups, or pause filtering for one configured device. Every change starts with an exact device review.', 'pihole-intro'));
    const note = node('p', 'Use a dedicated Pi-hole application password. TLI must have a PIN set and be unlocked. Connections are temporary; the password is cleared immediately and is never saved in browser storage.', 'pihole-muted'); box.append(note);
    const config = node('details', null, 'pihole-config'); config.append(node('summary', 'Connect a Pi-hole'));
    const form = node('form', null, 'pihole-form', 'pihole-form'); form.autocomplete = 'off'; form.addEventListener('submit', event => { event.preventDefault(); return connect(); });
    form.append(field('Pi-hole HTTPS address', 'url', 'pihole-origin', 'https://192.168.1.2'), field('Pi-hole app password', 'password', 'pihole-password'), field('Certificate SHA-256 fingerprint (optional)', 'text', 'pihole-pin', 'For a self-signed certificate'));
    refs['pihole-origin'].required = true; refs['pihole-password'].required = true;
    form.append(node('p', 'Enter a private literal IP, using brackets for IPv6. For a self-signed certificate, independently verify its SHA-256 fingerprint in Pi-hole. An empty fingerprint uses system certificate trust.', 'lab-form-note'));
    const submit = button('Connect Pi-hole', () => {}, 'pihole-connect', 'btn-primary'); submit.type = 'submit'; form.append(submit); config.append(form); box.append(config);
    const toolbar = node('div', null, 'pihole-actions'); toolbar.append(button('Check connection & saved changes', check, 'pihole-check'), button('Disconnect', disconnect, 'pihole-disconnect'), button('Unlock TLI', () => root.TLIPinLock?.checkAndLock?.(), 'pihole-unlock')); box.append(toolbar);
    box.append(node('p', null, 'pihole-muted', 'pihole-connection-detail'), node('div', null, 'pihole-actions', 'pihole-connections'));
    const status = node('p', 'Connect or explicitly check this session’s connections and saved changes to begin.', 'pihole-status', 'pihole-status'); status.setAttribute('role', 'status'); box.append(status);
    const devices = node('section', null, 'pihole-part'); devices.append(node('h3', 'Choose a device'), button('Read devices & groups', readInventory, 'pihole-inventory-read'));
    const filters = node('div', null, 'pihole-filters'); filters.append(field('Find a configured device', 'search', 'pihole-search', 'Comment or exact IP'));
    const selectLabel = node('label', null, 'lab-field'), select = node('select', null, null, 'pihole-client'); selectLabel.append(node('span', 'Device in Pi-hole'), select); filters.append(selectLabel); devices.append(filters, node('p', null, 'pihole-muted', 'pihole-inventory-detail'), node('div', null, 'pihole-selected', 'pihole-selected'));
    const groups = node('fieldset', null, 'pihole-group-set'); groups.append(node('legend', 'Assign existing groups'), node('div', null, 'pihole-groups', 'pihole-groups')); devices.append(groups);
    const groupActions = node('div', null, 'pihole-actions'); groupActions.append(button('Review group assignment', () => review('groups'), 'pihole-groups-review'), button('Review pause until restored', () => review('pause'), 'pihole-pause-review')); devices.append(groupActions);
    devices.append(node('p', 'Pausing removes this client’s group assignments until a manual restore. It has no timer and persists if TLI closes. A router or shared DNS forwarder can represent several devices; confirm the client IP before changing it. Devices using another DNS resolver may bypass Pi-hole independently.', 'pihole-muted')); box.append(devices);
    const reviewBox = node('section', null, 'pihole-review-section'); reviewBox.append(node('div', null, 'pihole-review', 'pihole-review'));
    const reviewControls = node('div', null, 'pihole-review-controls', 'pihole-review-controls'), confirmLabel = node('label', null, 'pihole-confirm-label'), confirm = node('input', null, null, 'pihole-confirm'); confirm.type = 'checkbox';
    confirmLabel.append(confirm, node('span', 'I reviewed this Pi-hole address, exact device IP and before/after groups.')); reviewControls.append(confirmLabel, button('Apply to this device', execute, 'pihole-apply', 'btn-primary')); reviewBox.append(reviewControls); box.append(reviewBox);
    const activityBox = node('section', null, 'pihole-part'); activityBox.append(node('h3', 'Recent device DNS activity'), node('p', 'DNS requests are domain lookups, not page visits. Apps and background services also make requests. This snapshot may be limited by Pi-hole privacy and logging settings.', 'pihole-muted'), button('Read recent DNS activity', activity, 'pihole-activity-read'), node('div', null, 'pihole-activity', 'pihole-activity')); box.append(activityBox);
    const receipts = node('section', null, 'pihole-part'); receipts.append(node('h3', 'Saved changes & restore'), node('div', null, 'pihole-receipts', 'pihole-receipts')); box.append(receipts);
    select.addEventListener('change', chooseClient); confirm.addEventListener('change', sync);
    refs['pihole-search'].addEventListener('input', () => { if (available() && !state.busy) { renderDevices(); renderReceipts(); } });
    for (const id of ['pihole-origin', 'pihole-pin']) refs[id].addEventListener('input', () => { invalidateReview(); renderReview(); sync(); });
    render();
  }
  for (const type of ['tli-session-locked', 'tli-user-changed', 'tli-account-changed']) root.addEventListener(type, () => reset('Pi-hole details cleared. Unlock TLI, then explicitly check the connection and saved changes.', true));
  root.addEventListener('tli-session-unlocked', () => reset('Access unlocked. Explicitly check connection & saved changes or connect again to continue.', false));
  root.addEventListener('pagehide', () => { state.suspended = true; reset('Pi-hole details cleared when this page closed.'); });
  root.addEventListener('pageshow', () => { state.suspended = false; sync(); });
  document.addEventListener('tli-panel-switched', event => {
    if (event.detail?.panelId === 'panel-homelab') return;
    state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false; clearPassword(); invalidateReview(); renderReview(); renderReceipts(); renderConnections(); armExpiry(); sync();
  });
  root.TLIPiHole = {connect, check, disconnect, readInventory, activity, review, execute};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})(typeof window === 'undefined' ? null : window);
