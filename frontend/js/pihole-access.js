/* A separate, device-scoped browser page. It never handles the guest cookie. */
(function (root) {
  'use strict';
  const protocol = 'tli-pihole-access-v1', prefix = '/api/pihole-access/';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value, max = 500) => typeof value === 'string' && value.length <= max;
  const time = value => string(value, 100) && Number.isFinite(Date.parse(value));
  const phases = ['pending', 'on', 'off', 'changed', 'offline', 'unpaired'];
  function validStatus(value) {
    return object(value) && phases.includes(value.state) && time(value.checked_at) && string(value.detail, 3000)
      && (value.name === undefined || string(value.name, 80)) && (value.client === undefined || string(value.client, 128))
      && (!['on', 'off', 'changed'].includes(value.state) || string(value.client, 128) && value.client.length > 0);
  }
  function validOutcome(value) {
    return object(value) && ['confirmed', 'accepted', 'unknown', 'mismatch', 'not_attempted', 'unchanged', 'prepared'].includes(value.outcome)
      && typeof value.attempted === 'boolean' && typeof value.acknowledged === 'boolean'
      && typeof value.membership_verified === 'boolean' && string(value.summary, 3000) && time(value.checked_at);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {validStatus, validOutcome};
  if (!root?.document) return;
  const document = root.document, refs = {};
  const state = {epoch: 0, suspended: false, busy: false, controller: null, snapshot: null, outcome: null, uncertain: false};
  const current = epoch => epoch === state.epoch && !state.suspended;
  const node = (tag, text, cls, id) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; if (id) { el.id = id; refs[id] = el; } return el; };
  const tell = text => { if (refs['pihole-access-status']) refs['pihole-access-status'].textContent = text; };
  function button(text, action, id, cls = '') { const el = node('button', text, cls, id); el.type = 'button'; el.addEventListener('click', action); return el; }
  function sync() {
    if (!refs['pihole-access-request']) return;
    const blocked = state.busy || state.suspended;
    const phase = state.snapshot?.state;
    refs['pihole-access-request'].disabled = blocked || state.uncertain || !!(phase && phase !== 'unpaired');
    refs['pihole-access-name'].disabled = refs['pihole-access-request'].disabled;
    refs['pihole-access-check'].disabled = blocked;
    refs['pihole-access-forget'].disabled = blocked;
    refs['pihole-access-pause'].disabled = blocked || state.uncertain || phase !== 'on';
    refs['pihole-access-restore'].disabled = blocked || state.uncertain || phase !== 'off';
    refs['pihole-access-workspace'].setAttribute('aria-busy', String(state.busy));
  }
  function render() {
    if (!refs['pihole-access-state']) return;
    const box = refs['pihole-access-state']; box.replaceChildren();
    const value = state.snapshot;
    const titles = {pending: 'Waiting for household approval', on: 'Your filtering groups are on', off: 'Your filtering is paused', changed: 'The owner needs to review this device', offline: 'The household connection is unavailable', unpaired: 'This browser has no device access'};
    box.append(node('h2', value ? titles[value.state] : 'Check access to begin'));
    if (value) {
      if (value.name) box.append(node('p', value.name));
      if (value.client) box.append(node('p', 'Approved device IP · ' + value.client, 'pihole-access-muted'));
      if (value.detail) box.append(node('p', value.detail));
      if (value.checked_at) box.append(node('p', 'Checked ' + new Date(value.checked_at).toLocaleString(), 'pihole-access-muted'));
      if (value.state === 'on' || value.state === 'off') box.append(node('p', 'This confirms Pi-hole group membership. It does not verify every app’s DNS behavior.', 'pihole-access-muted'));
    } else box.append(node('p', 'Check saved access, or request permission for this device. Nothing changes when this page opens.', 'pihole-access-muted'));
    const outcome = refs['pihole-access-outcome']; outcome.replaceChildren();
    if (state.outcome) {
      outcome.append(node('strong', 'Last change · ' + state.outcome.outcome), node('p', state.outcome.summary));
      outcome.append(node('p', state.outcome.membership_verified ? 'Group membership was verified after this change.' : 'Group membership was not verified after this change.', 'pihole-access-muted'));
    }
    sync();
  }
  function clear(message) {
    state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false;
    state.snapshot = null; state.outcome = null; state.uncertain = false;
    if (refs['pihole-access-name']) refs['pihole-access-name'].value = '';
    render(); tell(message);
  }
  async function request(endpoint, payload, epoch) {
    if (!current(epoch)) throw Error('This page changed.');
    const response = await fetch(prefix + endpoint, {method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: state.controller.signal,
      headers: {Accept: 'application/json', ...(payload === undefined ? {} : {'Content-Type': 'application/json'})}, ...(payload === undefined ? {} : {body: JSON.stringify(payload)})});
    if (!current(epoch)) throw Error('This page changed.');
    if (response.status === 401 || response.status === 403) {
      state.snapshot = null; state.outcome = null; state.uncertain = true; render();
      throw Error('Device access could not be verified. Check access, forget this browser, or ask the household owner.');
    }
    let raw = '', length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const {done, value} = await reader.read();
        if (!current(epoch)) { await reader.cancel(); throw Error('This page changed.'); }
        if (done) break;
        length += value.byteLength;
        if (length > 262144) { await reader.cancel(); throw Error('The device response was too large.'); }
        raw += decoder.decode(value, {stream: true});
      }
      raw += decoder.decode();
    } else {
      raw = await response.text();
      if (!current(epoch)) throw Error('This page changed.');
      if (new TextEncoder().encode(raw).length > 262144) throw Error('The device response was too large.');
    }
    if (!current(epoch)) throw Error('This page changed.');
    let value; try { value = JSON.parse(raw); } catch (_) { throw Error('The device response could not be read.'); }
    if (!response.ok) throw Error(string(value?.detail, 3000) ? value.detail : 'The device request could not be completed.');
    if (value?.protocol !== protocol || value.ok !== true) throw Error('The device response could not be verified.');
    return value;
  }
  async function run(message, operation) {
    if (state.busy || state.suspended) return;
    const epoch = state.epoch, controller = new AbortController(); state.controller = controller; state.busy = true; tell(message); sync();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try { await operation(epoch); }
    catch (error) { if (current(epoch)) tell((error.name === 'AbortError' ? 'The request was interrupted or timed out.' : error.message) + (state.uncertain ? ' Check access before another change. Nothing is retried automatically.' : '')); }
    finally { clearTimeout(timeout); if (current(epoch)) { state.busy = false; state.controller = null; sync(); } }
  }
  function check() {
    return run('Checking this device’s saved access and filtering groups…', async epoch => {
      state.snapshot = null; render();
      const value = await request('status', undefined, epoch);
      if (!validStatus(value)) throw Error('Device access and filtering groups were not confirmed.');
      state.snapshot = value; state.uncertain = false; render(); tell('Access checked. Choose an action when you’re ready.');
    });
  }
  function ask() {
    if (state.busy || state.suspended || state.uncertain || state.snapshot && state.snapshot.state !== 'unpaired') return;
    const name = refs['pihole-access-name'].value.trim();
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) { tell('Enter a short device name the household owner will recognize.'); return; }
    return run('Requesting access for this browser and device…', async epoch => {
      state.uncertain = true; sync();
      const value = await request('request', {name}, epoch);
      if (value.state !== 'pending' || !string(value.source_ip, 128) || !value.source_ip || !time(value.expires_at)) throw Error('The access request was not confirmed.');
      refs['pihole-access-name'].value = '';
      state.snapshot = {state: 'pending', name, detail: 'Ask the household owner to approve ' + name + ' at ' + value.source_ip + '. Then choose Check access. This request expires ' + new Date(value.expires_at).toLocaleString() + '.'};
      state.uncertain = false; render(); tell('Access requested. No filtering has changed.');
    });
  }
  function filtering(enabled) {
    if (state.busy || state.suspended || state.uncertain || state.snapshot?.state !== (enabled ? 'off' : 'on')) return;
    const selected = state.snapshot.client;
    if (!root.crypto?.randomUUID) { tell('Secure device controls are unavailable in this browser. Open the household HTTPS link.'); return; }
    const operation_id = root.crypto.randomUUID();
    return run(enabled ? 'Restoring this device’s approved filtering groups…' : 'Pausing filtering for this device…', async epoch => {
      state.uncertain = true; state.outcome = null; state.snapshot = null; render();
      const value = await request('filtering', {enabled, operation_id}, epoch);
      if (!validStatus(value) || value.client !== selected || value.outcome !== undefined && !validOutcome(value.outcome)) throw Error('The change outcome was not confirmed.');
      state.snapshot = value; state.outcome = value.outcome || null;
      state.uncertain = !value.outcome?.membership_verified || !['on', 'off'].includes(value.state);
      render(); tell(state.uncertain ? 'The change needs a fresh access check before another action.' : 'Change finished. The current group membership is shown above.');
    });
  }
  function forget() {
    if (state.busy || state.suspended) return;
    return run('Removing this browser’s device access…', async epoch => {
      state.uncertain = true;
      const value = await request('forget', {}, epoch);
      if (value.forgotten !== true) throw Error('Access removal was not confirmed.');
      state.snapshot = null; state.outcome = null; state.uncertain = false; render(); tell('This browser’s access was removed. Filtering was not changed; ask the owner if it still needs restoring.');
    });
  }
  function init() {
    const mount = document.getElementById('pihole-access-mount'); if (!mount || refs['pihole-access-workspace']) return;
    const workspace = node('section', null, null, 'pihole-access-workspace'); mount.append(workspace);
    const form = node('form', null, null, 'pihole-access-form'); form.autocomplete = 'off';
    const label = node('label', 'Your device name'), input = node('input', null, null, 'pihole-access-name'); input.type = 'text'; input.maxLength = 64; input.autocomplete = 'off'; input.placeholder = 'Alex’s phone'; label.append(input);
    const submit = button('Request device access', () => {}, 'pihole-access-request'); submit.type = 'submit';
    form.append(label, node('div', null, 'pihole-access-actions', 'pihole-access-request-actions')); refs['pihole-access-request-actions'].append(submit);
    form.addEventListener('submit', event => {event.preventDefault(); return ask();}); workspace.append(form);
    workspace.append(node('section', null, 'pihole-access-state', 'pihole-access-state'));
    const actions = node('div', null, 'pihole-access-actions'); actions.append(button('Pause my filtering', () => filtering(false), 'pihole-access-pause', 'primary'), button('Restore my filtering', () => filtering(true), 'pihole-access-restore', 'primary')); workspace.append(actions);
    workspace.append(node('p', 'Pauses last until you restore filtering. There is no timer. Closing this page or removing access does not restore it.', 'pihole-access-muted'));
    const checks = node('div', null, 'pihole-access-actions'); checks.append(button('Check access', check, 'pihole-access-check'), button('Forget this browser', forget, 'pihole-access-forget')); workspace.append(checks);
    const status = node('p', 'Request access or check an existing approval to begin.', 'pihole-access-status', 'pihole-access-status'); status.setAttribute('role', 'status'); workspace.append(status, node('div', null, 'pihole-access-outcome', 'pihole-access-outcome'));
    workspace.append(node('p', 'Only your approved device can be controlled here. This page does not show DNS history. Keep using the same Wi-Fi and reserved device address; an address change needs owner review. The household TLI computer must stay running with sharing enabled.', 'pihole-access-muted pihole-access-footnote'));
    render();
  }
  root.addEventListener('pagehide', () => {state.suspended = true; clear('Details cleared. Check access when you return.');});
  root.addEventListener('pageshow', () => {state.suspended = false; sync();});
  root.TLIPiHoleAccess = {check, ask, filtering, forget};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})(typeof window === 'undefined' ? null : window);
