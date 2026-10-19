const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const guestHelpers = require('../js/pihole-access.js');
const ownerHelpers = require('../js/pihole-sharing.js');
const PROTOCOL = 'tli-pihole-access-v1', NOW = '2026-10-16T12:00:00Z', FUTURE = '2099-10-16T12:00:00Z';
const response = value => ({protocol: PROTOCOL, ok: true, ...value});
const guestStatus = (state = 'on') => response({state, name: 'Alex phone', client: '192.168.1.24', checked_at: NOW, detail: 'Stored group membership was checked.'});
const pending = () => ({id: 'request-1', name: 'Alex phone', source_ip: '192.168.1.24', expires_at: FUTURE});
const grant = (revoked = false) => ({id: 'grant-1', name: 'Alex phone', client: '192.168.1.24', revoked});
const ownerStatus = (enabled = true) => response({enabled, origin: enabled ? 'https://192.168.1.2' : null, requests: [pending()], grants: [grant()], checked_at: NOW, portal_origins: ['https://192.168.1.10:8000']});
const inventory = () => response({clients: [
  {id: 1, client: '192.168.1.24', comment: 'Alex phone', groups: [0], editable: true},
  {id: 2, client: '192.168.1.25', comment: 'Other laptop', groups: [0], editable: true},
  {id: 3, client: 'aa:bb:cc:dd:ee:ff', comment: 'MAC record', groups: [0], editable: false}
], groups: [{id: 0, name: 'Default', enabled: true}], checked_at: NOW});
const outcome = (membership_verified = true) => ({outcome: membership_verified ? 'confirmed' : 'unknown', attempted: true, acknowledged: membership_verified, membership_verified, summary: membership_verified ? 'Group membership checked after the change.' : 'The change result is unknown.', checked_at: NOW});

function fixture(kind = 'guest') {
  const calls = [], events = {}, documentEvents = {}, timers = new Map(); let nextTimer = 0, nextUUID = 0;
  function make(tag) {
    const el = {tagName: tag.toUpperCase(), children: [], parentNode: null, textContent: '', value: '', id: '', hidden: false, disabled: false, checked: false, attributes: {}, handlers: {},
      append(...items) {for (const child of items) {child.parentNode = this; this.children.push(child);}},
      replaceChildren(...items) {for (const child of this.children) child.parentNode = null; this.children = []; this.append(...items);},
      setAttribute(name, value) {this.attributes[name] = value;},
      addEventListener(name, fn) {(this.handlers[name] ||= []).push(fn);},
      async fire(name = 'click') {await Promise.all((this.handlers[name] || []).map(fn => fn({preventDefault() {}})));}
    };
    Object.defineProperty(el, 'innerHTML', {set() {assert.fail('Untrusted guest and client data must only render as text');}});
    return el;
  }
  const body = make('body'), mount = make('div'); mount.id = kind === 'guest' ? 'pihole-access-mount' : 'pihole-sharing-mount'; body.append(mount);
  function find(id, el = body) {return el.id === id ? el : el.children.map(child => find(id, child)).find(Boolean);}
  const document = {readyState: 'complete', createElement: make, getElementById: find, addEventListener: (name, fn) => (documentEvents[name] ||= []).push(fn)};
  const window = {document, crypto: {randomUUID: () => `00000000-0000-4000-8000-${String(++nextUUID).padStart(12, '0')}`}, addEventListener: (name, fn) => (events[name] ||= []).push(fn), dispatchEvent: event => {for (const fn of events[event.type] || []) fn(event);}};
  const f = {calls, window, document, find, timers, handler: async (url, options) => {
    const data = options.body ? JSON.parse(options.body) : null;
    if (kind === 'guest') {
      if (url.endsWith('/status')) return guestStatus();
      if (url.endsWith('/request')) return response({state: 'pending', source_ip: '192.168.1.24', expires_at: FUTURE});
      if (url.endsWith('/filtering')) return {...guestStatus(data.enabled ? 'on' : 'off'), outcome: outcome()};
      if (url.endsWith('/forget')) return response({forgotten: true});
    } else {
      if (url.endsWith('/status')) return ownerStatus();
      if (url.endsWith('/inventory')) return inventory();
      if (url.endsWith('/enable')) return response({enabled: true, origin: data.origin});
      if (url.endsWith('/disable')) return response({enabled: false});
      if (url.endsWith('/approve')) return response({grant: grant()});
      if (url.endsWith('/revoke')) return response({grant: grant(true)});
    }
    assert.fail('Unexpected endpoint ' + url);
  }};
  const storage = {getItem() {assert.fail('No browser storage');}, setItem() {assert.fail('No browser storage');}, removeItem() {assert.fail('No browser storage');}};
  const context = vm.createContext({window, document, console, Date, URL, AbortController, TextDecoder, TextEncoder, localStorage: storage, sessionStorage: storage,
    CustomEvent: class {constructor(type, props) {this.type = type; this.detail = props?.detail;}},
    setTimeout(fn, delay) {const id = ++nextTimer; timers.set(id, {fn, delay}); return id;}, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {calls.push({url, options, body: options.body ? JSON.parse(options.body) : null}); const value = await f.handler(url, options); return {ok: !value._status || value._status < 400, status: value._status || 200, body: null, text: value._text || (async () => JSON.stringify(value))};}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, kind === 'guest' ? '../js/pihole-access.js' : '../js/pihole-sharing.js'), 'utf8'), context);
  f.emit = async (name, detail) => {await Promise.all([...(events[name] || []), ...(documentEvents[name] || [])].map(fn => fn({detail})));};
  const walk = el => [el, ...el.children.flatMap(walk)];
  f.elements = id => walk(find(id)); f.buttons = id => f.elements(id).filter(el => el.tagName === 'BUTTON');
  f.text = id => f.elements(id).map(el => el.textContent).join(' ');
  f.click = async id => {const el = find(id); if (!el.disabled) await el.fire();};
  f.ownerReady = async () => {await f.click('pihole-sharing-check'); await f.click('pihole-sharing-inventory');};
  f.approval = () => ({select: f.elements('pihole-sharing-requests').find(el => el.tagName === 'SELECT'), confirm: f.elements('pihole-sharing-requests').find(el => el.type === 'checkbox'), button: f.buttons('pihole-sharing-requests')[0]});
  f.confirmApproval = async () => {const c = f.approval(); c.select.value = '192.168.1.24'; await c.select.fire('change'); c.confirm.checked = true; await c.confirm.fire('change'); return c;};
  f.credentials = () => {find('pihole-sharing-origin').value = 'https://192.168.1.2'; find('pihole-sharing-password').value = 'secret-app-password'; find('pihole-sharing-pin').value = 'a'.repeat(64); find('pihole-sharing-consent').checked = true;};
  return f;
}

test('standalone guest page loads only its scoped assets, without the owner SPA', () => {
  const html = fs.readFileSync(path.join(__dirname, '../pihole-access.html'), 'utf8');
  assert.match(html, /\/js\/pihole-access\.js/); assert.match(html, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(html, /app\.js|pihole-sharing\.js|pihole\.js|tli_session|localStorage|onload=/);
});

test('guest mount and return make no requests or polling timers', async () => {
  const f = fixture(); await f.emit('pageshow'); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.find('pihole-access-pause').disabled, true); assert.equal(f.find('pihole-access-restore').disabled, true);
  assert.match(f.text('pihole-access-workspace'), /no timer/); assert.match(f.text('pihole-access-workspace'), /does not show DNS history/);
});

test('guest requests only its name and waits for an explicit access check', async () => {
  const f = fixture(); f.find('pihole-access-name').value = 'Alex phone'; await f.find('pihole-access-form').fire('submit');
  assert.deepEqual(f.calls[0].body, {name: 'Alex phone'}); assert.equal(f.calls.length, 1); assert.equal(f.find('pihole-access-name').value, '');
  assert.match(f.text('pihole-access-state'), /Waiting for household approval/); assert.equal(f.find('pihole-access-request').disabled, true);
  assert.equal(f.find('pihole-access-pause').disabled, true); assert.equal(f.calls[0].options.credentials, 'same-origin'); assert.equal(f.calls[0].options.cache, 'no-store');
  assert.equal(f.calls[0].options.headers.Authorization, undefined);
});

test('guest access request cannot choose a target IP or read DNS activity', async () => {
  const f = fixture(); f.find('pihole-access-name').value = '192.168.1.99'; await f.find('pihole-access-form').fire('submit');
  assert.deepEqual(Object.keys(f.calls[0].body), ['name']); assert.ok(f.calls.every(call => !/inventory|activity|groups/.test(call.url)));
});

test('pause and restore use unique operation IDs and never send client selectors', async () => {
  const f = fixture(); await f.click('pihole-access-check'); await f.click('pihole-access-pause');
  assert.equal(f.calls[1].body.enabled, false); assert.deepEqual(Object.keys(f.calls[1].body).sort(), ['enabled', 'operation_id']);
  assert.match(f.calls[1].body.operation_id, /^[a-f\d-]{36}$/); assert.match(f.text('pihole-access-state'), /filtering is paused/);
  assert.match(f.text('pihole-access-outcome'), /membership was verified/); assert.equal(f.find('pihole-access-pause').disabled, true);
  await f.click('pihole-access-restore'); assert.equal(f.calls[2].body.enabled, true); assert.notEqual(f.calls[1].body.operation_id, f.calls[2].body.operation_id);
  assert.match(f.text('pihole-access-state'), /groups are on/); assert.equal(f.find('pihole-access-restore').disabled, true);
});

test('no duplicate click runs while a filtering request is pending', async () => {
  const f = fixture(); await f.click('pihole-access-check'); let finish;
  f.handler = () => new Promise(resolve => finish = resolve); const pending = f.click('pihole-access-pause');
  await f.window.TLIPiHoleAccess.filtering(false); await f.window.TLIPiHoleAccess.filtering(true); assert.equal(f.calls.length, 2);
  finish({...guestStatus('off'), outcome: outcome()}); await pending;
});

test('unconfirmed filtering requires a fresh explicit read and never reuses the operation', async () => {
  const f = fixture(); await f.click('pihole-access-check'); f.handler = async () => ({_status: 502, detail: 'The network result is unavailable.'}); await f.click('pihole-access-pause');
  assert.equal(f.find('pihole-access-pause').disabled, true); assert.equal(f.find('pihole-access-restore').disabled, true); assert.match(f.text('pihole-access-status'), /Nothing is retried automatically/);
  await f.window.TLIPiHoleAccess.filtering(false); assert.equal(f.calls.length, 2);
  f.handler = async () => guestStatus('off'); await f.click('pihole-access-check'); assert.equal(f.find('pihole-access-restore').disabled, false); assert.equal(f.calls.length, 3);
});

test('unknown outcome and changed mapping never become a successful pause', async () => {
  const f = fixture(); await f.click('pihole-access-check'); f.handler = async () => ({...guestStatus('changed'), outcome: outcome(false)}); await f.click('pihole-access-pause');
  assert.match(f.text('pihole-access-state'), /owner needs to review/); assert.match(f.text('pihole-access-outcome'), /not verified/);
  assert.equal(f.find('pihole-access-pause').disabled, true); assert.equal(f.find('pihole-access-restore').disabled, true);
});

test('a no-command response displays its observed state without inventing a result', async () => {
  const f = fixture(); await f.click('pihole-access-check'); f.handler = async () => guestStatus('changed'); await f.click('pihole-access-pause');
  assert.match(f.text('pihole-access-state'), /owner needs to review/); assert.equal(f.text('pihole-access-outcome'), ''); assert.match(f.text('pihole-access-status'), /fresh access check/);
});

test('a filtering response for a different client is rejected', async () => {
  const f = fixture(); await f.click('pihole-access-check'); f.handler = async () => ({...guestStatus('off'), client: '192.168.1.99', outcome: outcome()}); await f.click('pihole-access-pause');
  assert.doesNotMatch(f.text('pihole-access-state'), /192\.168\.1\.99|filtering is paused/); assert.match(f.text('pihole-access-status'), /not confirmed/);
});

test('guest pagehide invalidates a response body and pageshow never resumes it', async () => {
  const f = fixture(); let finish, started; const bodyStarted = new Promise(resolve => started = resolve);
  f.handler = async () => ({_text: () => {started(); return new Promise(resolve => finish = resolve);}});
  const pending = f.click('pihole-access-check'); await bodyStarted; await f.emit('pagehide'); await f.emit('pageshow'); finish(JSON.stringify(guestStatus())); await pending;
  assert.equal(f.calls.length, 1); assert.doesNotMatch(f.text('pihole-access-state'), /Alex phone|192\.168/); assert.equal(f.find('pihole-access-pause').disabled, true);
});

test('forget removes access without claiming filtering was restored', async () => {
  const f = fixture(); f.handler = async url => url.endsWith('/status') ? guestStatus('off') : response({forgotten: true}); await f.click('pihole-access-check'); await f.click('pihole-access-forget');
  assert.deepEqual(f.calls[1].body, {}); assert.match(f.text('pihole-access-status'), /Filtering was not changed/); assert.equal(f.find('pihole-access-request').disabled, false);
});

test('untrusted guest names and details render as plain text', async () => {
  const f = fixture(); f.handler = async () => ({...guestStatus(), name: '<img src=x onerror=alert(1)>', detail: '<script>bad()</script>'}); await f.click('pihole-access-check');
  assert.match(f.text('pihole-access-state'), /<img src=x/); assert.match(f.text('pihole-access-state'), /<script>/);
});

test('guest authorization denial clears stale private data without reading it as success', async () => {
  const f = fixture(); await f.click('pihole-access-check'); f.handler = async () => ({_status: 403, detail: 'Do not expose this internal detail'}); await f.click('pihole-access-check');
  assert.doesNotMatch(f.text('pihole-access-workspace'), /Alex phone|Do not expose/); assert.equal(f.find('pihole-access-pause').disabled, true); assert.match(f.text('pihole-access-status'), /could not be verified/);
});

test('owner mount and navigation do no automatic reads', async () => {
  const f = fixture('owner'); await f.emit('tli-panel-switched', {panelId: 'panel-homelab'}); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.find('pihole-sharing-enable').disabled, true); assert.match(f.text('pihole-sharing-workspace'), /continues when I lock TLI/);
});

test('owner enable requires acknowledgement and clears app password before awaiting', async () => {
  const f = fixture('owner'); f.credentials(); f.find('pihole-sharing-consent').checked = false; await f.find('pihole-sharing-form').fire('submit'); assert.equal(f.calls.length, 0);
  f.credentials(); let finish; f.handler = () => new Promise(resolve => finish = resolve); const pending = f.find('pihole-sharing-form').fire('submit');
  assert.equal(f.find('pihole-sharing-password').value, ''); assert.deepEqual(f.calls[0].body, {origin: 'https://192.168.1.2', password: 'secret-app-password', certificate_sha256: 'a'.repeat(64)});
  await f.find('pihole-sharing-form').fire('submit'); assert.equal(f.calls.length, 1); finish(response({enabled: true, origin: 'https://192.168.1.2'})); await pending;
  assert.match(f.text('pihole-sharing-status'), /host memory/); assert.equal(f.find('pihole-sharing-enable').disabled, true);
});

test('owner approval requires a fresh inventory, exact source-IP match and explicit checkbox', async () => {
  const f = fixture('owner'); await f.click('pihole-sharing-check'); assert.equal(f.approval().button.disabled, true);
  await f.click('pihole-sharing-inventory'); const c = f.approval(); assert.deepEqual(c.select.children.map(el => el.value), ['', '192.168.1.24']);
  c.select.value = '192.168.1.24'; await c.select.fire('change'); assert.equal(c.button.disabled, true); c.confirm.checked = true; await c.confirm.fire('change'); assert.equal(c.button.disabled, false);
  await c.button.fire(); assert.deepEqual(f.calls[2].body, {request_id: 'request-1', client: '192.168.1.24', reviewed: true}); assert.match(f.text('pihole-sharing-status'), /Device approved/);
});

test('programmatic selection of another IP cannot approve it', async () => {
  const f = fixture('owner'); await f.ownerReady(); const c = await f.confirmApproval(); c.select.value = '192.168.1.25'; await c.button.fire(); assert.equal(f.calls.length, 2);
});

test('external pauses and nonliteral clients cannot be granted from the UI', async () => {
  const f = fixture('owner'), original = f.handler; f.handler = async (url, options) => {const value = await original(url, options); if (value.clients) value.clients[0].groups = []; return value;}; await f.ownerReady();
  assert.equal(f.approval().select.children.length, 1); assert.match(f.text('pihole-sharing-requests'), /No matching configured IP/); assert.equal(f.approval().button.disabled, true);
});

test('detached owner controls cannot approve or disclose a previous session after unlock', async () => {
  const f = fixture('owner'); await f.ownerReady(); const c = await f.confirmApproval(), originButton = f.buttons('pihole-sharing-host-options')[0];
  await f.emit('tli-session-locked'); await f.emit('tli-session-unlocked'); await c.button.fire(); await originButton.fire();
  assert.equal(f.calls.length, 2); assert.equal(f.find('pihole-sharing-host').value, ''); assert.doesNotMatch(f.text('pihole-sharing-workspace'), /Alex phone|192\.168\.1\.24/);
});

for (const boundary of ['tli-session-locked', 'tli-user-changed', 'tli-account-changed', 'pagehide']) test(`owner ${boundary} clears details and discards an in-flight response`, async () => {
  const f = fixture('owner'); await f.ownerReady(); let finish; f.handler = () => new Promise(resolve => finish = resolve); const pending = f.click('pihole-sharing-check'); await f.emit(boundary); finish(ownerStatus()); await pending;
  assert.doesNotMatch(f.text('pihole-sharing-workspace'), /Alex phone|192\.168\.1\.24/); assert.match(f.text('pihole-sharing-status'), /may still be running/); assert.equal(f.calls.length, 3);
});

test('owner response body cannot cross lock and unlock epochs', async () => {
  const f = fixture('owner'); let finish, started; const bodyStarted = new Promise(resolve => started = resolve); f.handler = async () => ({_text: () => {started(); return new Promise(resolve => finish = resolve);}});
  const pending = f.click('pihole-sharing-check'); await bodyStarted; await f.emit('tli-session-locked'); await f.emit('tli-session-unlocked'); finish(JSON.stringify(ownerStatus())); await pending;
  assert.equal(f.calls.length, 1); assert.doesNotMatch(f.text('pihole-sharing-workspace'), /Alex phone/); assert.equal(f.find('pihole-sharing-inventory').disabled, true);
});

test('owner approval failures are not replayed and require a status read', async () => {
  const f = fixture('owner'); await f.ownerReady(); const c = await f.confirmApproval(); f.handler = async () => ({_status: 502, detail: 'Approval response unavailable.'}); await c.button.fire(); await c.button.fire();
  assert.equal(f.calls.length, 3); assert.match(f.text('pihole-sharing-status'), /outcome is unconfirmed/); assert.equal(f.find('pihole-sharing-inventory').disabled, true);
});

test('owner revocation and disable never claim to restore filtering', async () => {
  const f = fixture('owner'); await f.click('pihole-sharing-check'); await f.buttons('pihole-sharing-grants')[0].fire();
  assert.deepEqual(f.calls[1].body, {grant_id: 'grant-1'}); assert.match(f.text('pihole-sharing-status'), /assignments were not changed/);
  await f.click('pihole-sharing-check'); await f.click('pihole-sharing-disable'); assert.deepEqual(f.calls[3].body, {}); assert.match(f.text('pihole-sharing-status'), /assignments were not changed/);
});

test('public portal shortcut accepts private HTTPS literal IPs only', async () => {
  for (const value of ['http://192.168.1.2', 'https://example.com', 'https://127.0.0.1', 'https://192.168.1.2@evil.example', 'https://192.168.1.2/private', 'https://192.168.1.2?token=x', 'https://192.168.1.2#secret', 'https://010.0.0.1', 'https://192.168.1.2\\evil', 'https://[fc00:::]']) assert.equal(ownerHelpers.portalURL(value), null, value);
  assert.equal(ownerHelpers.portalURL('https://192.168.1.10:8000'), 'https://192.168.1.10:8000/pihole-access');
  assert.equal(ownerHelpers.portalURL('https://[fd00::1]:8443'), 'https://[fd00::1]:8443/pihole-access');
  const f = fixture('owner'); f.find('pihole-sharing-host').value = 'https://192.168.1.10:8000'; await f.find('pihole-sharing-host').fire('input');
  const anchor = f.elements('pihole-sharing-link').find(el => el.tagName === 'A'); assert.equal(anchor.href, 'https://192.168.1.10:8000/pihole-access'); assert.equal(anchor.rel, 'noopener noreferrer'); assert.equal(f.calls.length, 0);
});

test('strict response helpers reject malformed or unverified snapshots', () => {
  assert.equal(guestHelpers.validStatus(guestStatus()), true); assert.equal(guestHelpers.validStatus({...guestStatus(), checked_at: 'bad'}), false);
  assert.equal(guestHelpers.validOutcome({...outcome(), membership_verified: 'yes'}), false);
  assert.equal(ownerHelpers.validStatus(ownerStatus()), true); assert.equal(ownerHelpers.validStatus({...ownerStatus(), requests: [{...pending(), source_ip: '8.8.8.8'}]}), false);
});

test('owner connection confirmation accepts the backend explicit default HTTPS port', async () => {
  const f = fixture('owner'); f.credentials(); f.handler = async () => response({enabled: true, origin: 'https://192.168.1.2:443'});
  await f.find('pihole-sharing-form').fire('submit'); assert.match(f.text('pihole-sharing-status'), /Household sharing enabled/); assert.doesNotMatch(f.text('pihole-sharing-status'), /not confirmed/);
});

test('IPv6 source comparisons canonicalize while preserving the exact Pi-hole selector', async () => {
  assert.equal(ownerHelpers.sameIP('fd00:0000:0000:0000:0000:0000:0000:0024', 'fd00::24'), true);
  assert.equal(ownerHelpers.sameIP('fd00::25', 'fd00::24'), false); assert.equal(ownerHelpers.privateIP('fe80::24'), false);
  const f = fixture('owner'), raw = 'fd00:0000:0000:0000:0000:0000:0000:0024';
  f.handler = async (url, options) => {
    if (url.endsWith('/status')) return {...ownerStatus(), requests: [{...pending(), source_ip: 'fd00::24'}]};
    if (url.endsWith('/inventory')) return {...inventory(), clients: [{...inventory().clients[0], client: raw}]};
    return response({grant: {...grant(), client: raw}});
  };
  await f.ownerReady(); const c = f.approval(); assert.equal(c.select.children[1].value, raw); c.select.value = raw; await c.select.fire('change'); c.confirm.checked = true; await c.confirm.fire('change'); await c.button.fire();
  assert.equal(f.calls[2].body.client, raw); assert.match(f.text('pihole-sharing-status'), /Device approved/);
});

test('guest names use the same 64-character limit as the server', async () => {
  const f = fixture(); assert.equal(f.find('pihole-access-name').maxLength, 64); f.find('pihole-access-name').value = 'x'.repeat(65); await f.find('pihole-access-form').fire('submit'); assert.equal(f.calls.length, 0);
});

test('expired or revoked guest access can explicitly forget its cookie and request anew', async () => {
  const f = fixture(); f.handler = async url => url.endsWith('/status') ? {_status: 403, _text: async () => {assert.fail('Denied response body should not be read');}} : response({forgotten: true});
  await f.click('pihole-access-check'); assert.equal(f.find('pihole-access-forget').disabled, false); assert.equal(f.find('pihole-access-pause').disabled, true);
  await f.click('pihole-access-forget'); assert.equal(f.find('pihole-access-request').disabled, false); assert.equal(f.calls.length, 2);
});

test('oversized guest responses cannot produce a successful state', async () => {
  const f = fixture(); f.handler = async () => ({_text: async () => JSON.stringify({...guestStatus(), detail: 'x'.repeat(270000)})}); await f.click('pihole-access-check');
  assert.match(f.text('pihole-access-status'), /too large/); assert.equal(f.find('pihole-access-pause').disabled, true);
});
