/* Household delegation is separate from the temporary owner Pi-hole connection. */
(function (root) {
  'use strict';
  const protocol = 'tli-pihole-access-v1', prefix = '/api/homelab/pihole/self-service/';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value, max = 500) => typeof value === 'string' && value.length <= max;
  const time = value => string(value, 100) && Number.isFinite(Date.parse(value));
  const ids = value => Array.isArray(value) && value.length <= 1000 && value.every(id => Number.isInteger(id) && id >= 0) && new Set(value).size === value.length;
  function privateIP(value) {
    if (!string(value, 128) || value.includes('%')) return false;
    if (value.includes(':')) {
      if (!/^f[cd][a-f0-9]{2}:/i.test(value) || !/^[a-f0-9:]+$/i.test(value)) return false;
      try {return new URL('https://[' + value + ']').hostname.startsWith('[');} catch (_) {return false;}
    }
    if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return false;
    const parts = value.split('.').map(Number);
    return parts.every(part => part <= 255) && (parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168);
  }
  function sameIP(first, second) {
    if (!privateIP(first) || !privateIP(second)) return false;
    if (first.includes(':') !== second.includes(':')) return false;
    return first.includes(':') ? new URL('https://[' + first + ']').hostname === new URL('https://[' + second + ']').hostname : first === second;
  }
  function portalURL(value) {
    if (!string(value, 400) || !value || value.trim() !== value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !privateIP(url.hostname.replace(/^\[|\]$/g, '')) || url.username || url.password || url.search || url.hash || !['/', '/pihole-access'].includes(url.pathname)) return null;
      return url.origin + '/pihole-access';
    } catch (_) { return null; }
  }
  function origin(value) { const normalized = portalURL(value); if (!normalized) return false; try { return new URL(value).pathname === '/'; } catch (_) { return false; } }
  const pending = value => object(value) && string(value.id, 200) && !!value.id && string(value.name, 80) && !!value.name && privateIP(value.source_ip) && time(value.expires_at);
  const grant = value => object(value) && string(value.id, 200) && !!value.id && string(value.name, 80) && !!value.name && privateIP(value.client) && typeof value.revoked === 'boolean';
  const client = value => object(value) && Number.isInteger(value.id) && string(value.client, 256) && (value.comment === null || string(value.comment, 1024)) && ids(value.groups) && typeof value.editable === 'boolean';
  const group = value => object(value) && Number.isInteger(value.id) && value.id >= 0 && string(value.name, 1000) && [true, false, 0, 1].includes(value.enabled);
  function validStatus(value) {
    return object(value) && typeof value.enabled === 'boolean' && (value.origin === null || origin(value.origin)) && (!value.enabled || origin(value.origin))
      && Array.isArray(value.requests) && value.requests.length <= 1000 && value.requests.every(pending)
      && Array.isArray(value.grants) && value.grants.length <= 1000 && value.grants.every(grant) && time(value.checked_at)
      && new Set(value.requests.map(row => row.id)).size === value.requests.length && new Set(value.grants.map(row => row.id)).size === value.grants.length;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {privateIP, sameIP, portalURL, validStatus};
  if (!root?.document) return;
  const document = root.document, refs = {};
  const state = {epoch: 0, suspended: false, locked: false, busy: false, controller: null, snapshot: null, inventory: null, uncertain: false, requestControls: [], revokeControls: []};
  const current = epoch => epoch === state.epoch && !state.suspended && !state.locked;
  const available = () => !state.suspended && !state.locked;
  const node = (tag, text, cls, id) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; if (id) { el.id = id; refs[id] = el; } return el; };
  const tell = text => { if (refs['pihole-sharing-status']) refs['pihole-sharing-status'].textContent = text; };
  function button(text, action, id, cls = 'btn-outline') { const el = node('button', text, cls, id); el.type = 'button'; el.addEventListener('click', action); return el; }
  function field(text, type, id, placeholder = '') { const label = node('label', null, 'pihole-sharing-field'), input = node('input', null, null, id); input.type = type; input.placeholder = placeholder; input.autocomplete = 'off'; label.append(node('span', text), input); return label; }
  function checkbox(text, id) { const label = node('label', null, 'pihole-sharing-check'), input = node('input', null, null, id); input.type = 'checkbox'; label.append(input, node('span', text)); return {label, input}; }
  function sync() {
    if (!refs['pihole-sharing-workspace']) return;
    const blocked = !available() || state.busy, enabled = state.snapshot?.enabled === true;
    for (const id of ['pihole-sharing-origin', 'pihole-sharing-password', 'pihole-sharing-pin', 'pihole-sharing-consent']) refs[id].disabled = blocked || enabled || state.uncertain;
    refs['pihole-sharing-enable'].disabled = blocked || enabled || state.uncertain || !refs['pihole-sharing-consent'].checked;
    refs['pihole-sharing-check'].disabled = blocked;
    refs['pihole-sharing-disable'].disabled = blocked || !enabled || state.uncertain;
    refs['pihole-sharing-inventory'].disabled = blocked || !enabled || state.uncertain;
    for (const control of state.requestControls) {
      const selected = state.inventory?.clients.find(row => row.client === control.select.value);
      control.select.disabled = blocked || !enabled || !state.inventory || state.uncertain;
      control.confirm.disabled = control.select.disabled || !selected;
      control.button.disabled = control.confirm.disabled || !control.confirm.checked || !sameIP(selected?.client, control.request.source_ip) || selected?.editable !== true || !selected.groups.length || Date.parse(control.request.expires_at) <= Date.now();
    }
    for (const control of state.revokeControls) control.button.disabled = blocked || state.uncertain || control.value.revoked;
    refs['pihole-sharing-workspace'].setAttribute('aria-busy', String(state.busy));
  }
  function link() {
    const value = portalURL(refs['pihole-sharing-host'].value.trim()), box = refs['pihole-sharing-link']; box.replaceChildren();
    if (!value) return;
    const anchor = node('a', 'Open my device controls', 'pihole-sharing-link'); anchor.href = value; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; box.append(anchor, node('p', value, 'pihole-sharing-muted'));
  }
  function render() {
    if (!refs['pihole-sharing-service']) return;
    const snapshot = state.snapshot;
    refs['pihole-sharing-service'].textContent = snapshot ? (snapshot.enabled ? 'Household sharing is enabled for ' + snapshot.origin + '. The connector keeps running when the owner locks TLI.' : 'Household sharing is disabled. Existing Pi-hole group assignments are unchanged.') + ' Checked ' + new Date(snapshot.checked_at).toLocaleString() + '.' : 'Household sharing has not been checked.';
    const requests = refs['pihole-sharing-requests']; requests.replaceChildren(); state.requestControls = [];
    if (!snapshot) requests.append(node('p', 'Check sharing to see access requests.', 'pihole-sharing-muted'));
    else if (!snapshot.requests.length) requests.append(node('p', 'No pending requests in this snapshot.', 'pihole-sharing-muted'));
    else for (const value of snapshot.requests) {
      const row = node('article', null, 'pihole-sharing-row'); row.append(node('h4', value.name), node('p', 'Observed device address · ' + value.source_ip), node('p', 'Request expires ' + new Date(value.expires_at).toLocaleString(), 'pihole-sharing-muted'));
      const select = node('select'); select.setAttribute('aria-label', 'Pi-hole client for ' + value.name); const placeholder = node('option', 'Choose the matching configured client'); placeholder.value = ''; select.append(placeholder);
      for (const candidate of state.inventory?.clients || []) if (candidate.editable && sameIP(candidate.client, value.source_ip) && candidate.groups.length) { const option = node('option', (candidate.comment ? candidate.comment + ' · ' : '') + candidate.client); option.value = candidate.client; select.append(option); }
      const label = node('label', null, 'pihole-sharing-field'); label.append(node('span', 'Existing Pi-hole client'), select); row.append(label);
      if (!state.inventory) row.append(node('p', 'Read devices before approving.', 'pihole-sharing-muted'));
      else if (!state.inventory.clients.some(candidate => candidate.editable && sameIP(candidate.client, value.source_ip) && candidate.groups.length)) row.append(node('p', 'No matching configured IP with filtering groups was returned. Configure this individual device in Pi-hole, then read devices again.', 'pihole-sharing-muted'));
      const approval = checkbox('I verified this is the individual device, with a reserved IP that matches its Pi-hole DNS client. It is not a router or shared forwarder.'); row.append(approval.label);
      const control = {request: value, select, confirm: approval.input}; control.button = button('Approve this device', () => approve(control)); row.append(control.button);
      select.addEventListener('change', () => {approval.input.checked = false; sync();}); approval.input.addEventListener('change', sync);
      requests.append(row); state.requestControls.push(control);
    }
    const grants = refs['pihole-sharing-grants']; grants.replaceChildren(); state.revokeControls = [];
    if (!snapshot) grants.append(node('p', 'Check sharing to see approved devices.', 'pihole-sharing-muted'));
    else if (!snapshot.grants.length) grants.append(node('p', 'No approved devices in this snapshot.', 'pihole-sharing-muted'));
    else for (const value of snapshot.grants) {
      const row = node('article', null, 'pihole-sharing-row'); row.append(node('h4', value.name), node('p', value.client + (value.revoked ? ' · Access revoked' : ' · Device access approved')));
      const control = {value}; control.button = button(value.revoked ? 'Access revoked' : 'Revoke device access', () => revoke(control)); row.append(control.button); grants.append(row); state.revokeControls.push(control);
    }
    const origins = refs['pihole-sharing-host-options']; origins.replaceChildren();
    if (snapshot && Array.isArray(snapshot.portal_origins)) for (const value of snapshot.portal_origins.slice(0, 16)) {
      const url = portalURL(value); if (!url) continue;
      const epoch = state.epoch;
      const choose = button('Use ' + new URL(url).origin, () => {if (!current(epoch) || state.snapshot !== snapshot) return; refs['pihole-sharing-host'].value = url; link();}); origins.append(choose);
    }
    sync();
  }
  function clear(message, locked = state.locked) {
    state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false; state.locked = locked; state.snapshot = null; state.inventory = null; state.uncertain = false;
    for (const id of ['pihole-sharing-origin', 'pihole-sharing-password', 'pihole-sharing-pin', 'pihole-sharing-host']) if (refs[id]) refs[id].value = '';
    if (refs['pihole-sharing-consent']) refs['pihole-sharing-consent'].checked = false;
    if (refs['pihole-sharing-link']) refs['pihole-sharing-link'].replaceChildren();
    render(); tell(message);
  }
  async function request(endpoint, payload, epoch) {
    if (!current(epoch)) throw Error('Owner access changed.');
    const response = await fetch(prefix + endpoint, {method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: state.controller.signal,
      headers: {Accept: 'application/json', ...(payload === undefined ? {} : {'Content-Type': 'application/json'})}, ...(payload === undefined ? {} : {body: JSON.stringify(payload)})});
    if (!current(epoch)) throw Error('Owner access changed.');
    if (response.status === 401 || response.status === 403) { clear('Owner details cleared. Unlock TLI and check sharing explicitly. Household sharing may still be running.', true); root.dispatchEvent(new CustomEvent('tli-session-locked')); throw Error('Owner access must be verified.'); }
    let raw = '', length = 0; const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (true) { const {done, value} = await reader.read(); if (!current(epoch)) {await reader.cancel(); throw Error('Owner access changed.');} if (done) break; length += value.byteLength; if (length > 4194304) {await reader.cancel(); throw Error('The sharing response was too large.');} raw += decoder.decode(value, {stream: true}); }
      raw += decoder.decode();
    } else { raw = await response.text(); if (!current(epoch)) throw Error('Owner access changed.'); if (new TextEncoder().encode(raw).length > 4194304) throw Error('The sharing response was too large.'); }
    if (!current(epoch)) throw Error('Owner access changed.');
    let value; try {value = JSON.parse(raw);} catch (_) {throw Error('The sharing response could not be read.');}
    if (!response.ok) throw Error(string(value?.detail, 3000) ? value.detail : 'The sharing request could not be completed.');
    if (value?.protocol !== protocol || value.ok !== true) throw Error('The sharing response could not be verified.'); return value;
  }
  async function run(message, operation) {
    if (!available() || state.busy) return;
    const epoch = state.epoch, controller = new AbortController(); state.controller = controller; state.busy = true; tell(message); sync(); const timeout = setTimeout(() => controller.abort(), 30000);
    try {await operation(epoch);} catch (error) {if (current(epoch)) tell((error.name === 'AbortError' ? 'The request was interrupted or timed out.' : error.message) + (state.uncertain ? ' The outcome is unconfirmed. Check sharing before another action; nothing is retried automatically.' : ''));}
    finally {clearTimeout(timeout); if (current(epoch)) {state.busy = false; state.controller = null; sync();}}
  }
  function check() {
    return run('Checking household sharing, requests and device approvals…', async epoch => {
      state.snapshot = null; state.inventory = null; render();
      const value = await request('status', undefined, epoch); if (!validStatus(value)) throw Error('Household sharing details were not confirmed.');
      state.snapshot = value; state.uncertain = false; render(); tell('Sharing checked. Read devices before approving a request.');
    });
  }
  function enable() {
    if (!available() || state.busy || state.uncertain || state.snapshot?.enabled || !refs['pihole-sharing-consent'].checked) return;
    const payload = {origin: refs['pihole-sharing-origin'].value.trim(), password: refs['pihole-sharing-password'].value, certificate_sha256: refs['pihole-sharing-pin'].value.trim()}; refs['pihole-sharing-password'].value = '';
    if (!origin(payload.origin) || !payload.password) {payload.password = ''; tell('Enter Pi-hole’s private HTTPS IP address and an application password.'); return;}
    return run('Enabling the household Pi-hole connector…', async epoch => {
      state.uncertain = true; sync(); const pending = request('enable', payload, epoch); payload.password = ''; const value = await pending;
      if (value.enabled !== true || !origin(value.origin) || new URL(value.origin).origin !== new URL(payload.origin).origin) throw Error('Household sharing was not confirmed.');
      state.snapshot = null; state.inventory = null; refs['pihole-sharing-consent'].checked = false; render(); tell('Household sharing enabled. Check sharing to read requests and approvals. The app password stays in host memory until you disable sharing or TLI restarts.');
    }).finally(() => {payload.password = '';});
  }
  function disable() {
    if (!available() || state.busy || state.uncertain || !state.snapshot?.enabled) return;
    return run('Disabling household Pi-hole sharing…', async epoch => {
      state.uncertain = true; const value = await request('disable', {}, epoch); if (value.enabled !== false) throw Error('Disabling sharing was not confirmed.');
      state.snapshot = null; state.inventory = null; render(); tell('Household sharing disabled. Pi-hole group assignments were not changed. Check sharing to refresh this view.');
    });
  }
  function inventory() {
    if (!available() || state.busy || state.uncertain || !state.snapshot?.enabled) return;
    return run('Reading configured Pi-hole clients for approval…', async epoch => {
      state.inventory = null; render(); const value = await request('inventory', {}, epoch);
      if (!Array.isArray(value.clients) || value.clients.length > 10000 || !value.clients.every(client) || !Array.isArray(value.groups) || value.groups.length > 1000 || !value.groups.every(group) || !time(value.checked_at) || new Set(value.clients.map(row => row.client)).size !== value.clients.length) throw Error('The Pi-hole inventory was not confirmed.');
      state.inventory = value; render(); tell('Device snapshot read. Match each request to its exact reserved Pi-hole client IP.');
    });
  }
  function approve(control) {
    if (!available() || state.busy || state.uncertain || !state.snapshot?.enabled || !state.requestControls.includes(control) || !control.confirm.checked || Date.parse(control.request.expires_at) <= Date.now()) return;
    const selected = state.inventory?.clients.find(row => row.client === control.select.value);
    if (!selected?.editable || !selected.groups.length || !sameIP(selected.client, control.request.source_ip)) return;
    const target = {request_id: control.request.id, client: selected.client, reviewed: true}; control.confirm.checked = false;
    return run('Approving only this device’s filtering controls…', async epoch => {
      state.uncertain = true; const value = await request('approve', target, epoch);
      if (!grant(value.grant) || value.grant.client !== target.client || value.grant.name !== control.request.name || value.grant.revoked) throw Error('The exact device approval was not confirmed.');
      state.snapshot = null; state.inventory = null; render(); tell('Device approved. Ask them to choose Check access on their page. Check sharing to refresh owner details.');
    });
  }
  function revoke(control) {
    if (!available() || state.busy || state.uncertain || !state.revokeControls.includes(control) || control.value.revoked) return;
    return run('Revoking this device’s self-service access…', async epoch => {
      state.uncertain = true; const value = await request('revoke', {grant_id: control.value.id}, epoch);
      if (!grant(value.grant) || value.grant.id !== control.value.id || value.grant.client !== control.value.client || !value.grant.revoked) throw Error('Device revocation was not confirmed.');
      state.snapshot = null; state.inventory = null; render(); tell('Device access revoked. Its Pi-hole group assignments were not changed. Check sharing to refresh.');
    });
  }
  function init() {
    const mount = document.getElementById('pihole-sharing-mount'); if (!mount || refs['pihole-sharing-workspace']) return;
    const box = node('section', null, 'pihole-sharing-workspace', 'pihole-sharing-workspace'); mount.append(box); box.setAttribute('aria-labelledby', 'pihole-sharing-title');
    box.append(node('h2', 'Let each device choose', null, 'pihole-sharing-title'), node('p', 'Give a guest or family member a simple pause and restore page for their own device. Approve the exact device once; your Pi-hole password and household DNS history stay private.'));
    const shortcut = node('section'); shortcut.append(node('h3', 'Open or share the household page'), node('p', 'Enter the household TLI computer’s verified HTTPS address. Open the link on the device that needs control; it works in a phone or computer browser.', 'pihole-sharing-muted'), field('Household TLI HTTPS address', 'url', 'pihole-sharing-host', 'https://192.168.1.10:8000'));
    shortcut.append(node('div', null, 'pihole-sharing-actions', 'pihole-sharing-host-options'), node('div', null, null, 'pihole-sharing-link')); box.append(shortcut);
    refs['pihole-sharing-host'].addEventListener('input', link);
    const config = node('details'); config.append(node('summary', 'Owner setup · enable household sharing'));
    const form = node('form', null, 'pihole-sharing-form', 'pihole-sharing-form'); form.autocomplete = 'off'; form.append(field('Pi-hole HTTPS address', 'url', 'pihole-sharing-origin', 'https://192.168.1.2'), field('Pi-hole app password', 'password', 'pihole-sharing-password'), field('Certificate SHA-256 fingerprint (optional)', 'text', 'pihole-sharing-pin'));
    refs['pihole-sharing-origin'].required = refs['pihole-sharing-password'].required = true;
    const consent = checkbox('Allow the household connector to retain this app password in host memory until sharing is disabled or TLI restarts. Approved device access continues when I lock TLI.', 'pihole-sharing-consent'); form.append(consent.label);
    const submit = button('Enable household sharing', () => {}, 'pihole-sharing-enable', 'btn-primary'); submit.type = 'submit'; form.append(submit); form.addEventListener('submit', event => {event.preventDefault(); return enable();}); consent.input.addEventListener('change', sync); config.append(form);
    config.append(node('p', 'Use a dedicated Pi-hole application password and independently verify a self-signed certificate fingerprint. The password is never stored in the browser or on disk. After a TLI restart, enable sharing again. Approvals do not grant general TLI access.', 'pihole-sharing-muted')); box.append(config);
    const actions = node('div', null, 'pihole-sharing-actions'); actions.append(button('Check sharing & requests', check, 'pihole-sharing-check'), button('Read devices for approval', inventory, 'pihole-sharing-inventory'), button('Disable household sharing', disable, 'pihole-sharing-disable')); box.append(actions, node('p', null, 'pihole-sharing-muted', 'pihole-sharing-service'));
    const status = node('p', 'Check household sharing or open a verified household link to begin.', 'pihole-sharing-status', 'pihole-sharing-status'); status.setAttribute('role', 'status'); box.append(status);
    box.append(node('h3', 'Requests from devices'), node('p', 'Only the request’s observed address can be approved. Verify Pi-hole sees that individual device and reserve its DHCP address first. A router or shared DNS forwarder cannot safely identify one guest.', 'pihole-sharing-muted'), node('div', null, 'pihole-sharing-list', 'pihole-sharing-requests'));
    box.append(node('h3', 'Approved devices'), node('div', null, 'pihole-sharing-list', 'pihole-sharing-grants'), node('p', 'Revoking access, disabling sharing, forgetting a browser or closing TLI does not restore paused filtering. Restore it first or use the owner Pi-hole controls. Device pauses have no automatic timer.', 'pihole-sharing-muted'));
    render();
  }
  for (const name of ['tli-session-locked', 'tli-user-changed', 'tli-account-changed']) root.addEventListener(name, () => clear('Owner details cleared. Household sharing may still be running. Unlock and check sharing explicitly.', true));
  root.addEventListener('tli-session-unlocked', () => clear('Owner access unlocked. Check sharing explicitly to continue.', false));
  root.addEventListener('pagehide', () => {state.suspended = true; clear('Owner details cleared. Household sharing may still be running.');});
  root.addEventListener('pageshow', () => {state.suspended = false; sync();});
  document.addEventListener('tli-panel-switched', event => {if (event.detail?.panelId !== 'panel-homelab') clear('Owner details cleared. Check sharing when you return. Household sharing may still be running.');});
  root.TLIPiHoleSharing = {check, enable, disable, inventory};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})(typeof window === 'undefined' ? null : window);
