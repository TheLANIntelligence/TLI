const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, '../js/bluetooth-devices.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const drain = async () => { await tick(); await tick(); };
const address = 'AA:BB:CC:DD:EE:01', candidateAddress = 'AA:BB:CC:DD:EE:02';
const profile = (overrides = {}) => ({ id: 'govee_h6125_v1', vendor: 'govee_ble', brand: 'Govee', model: 'H6125', id_prefix: 'govee-ble-', capabilities: ['switch.on', 'switch.off'], validation: 'experimental', ...overrides });
const device = (overrides = {}) => ({ device_id: 'govee-ble-aabbccddee01', name: 'Desk light', vendor: 'govee_ble', ip: 'ble://' + address,
  relay: 0, extra: { transport: 'bluetooth', model: 'H6125', address, profile: 'govee_h6125_v1' }, capabilities: ['switch.on', 'switch.off'], room: null, tags: [], ...overrides });
const candidate = (overrides = {}) => ({ address: candidateAddress, name: 'Govee_H6125', model: 'H6125', supported: true, profile_hints: [profile().id], ...overrides });
function fixture({ locked = false, loading = false, devices = [device()], profiles = [profile()], support = { available: true, platform: 'win32', reason: 'Optional dependency installed.' } } = {}) {
  const ids = {}, windowEvents = {}, documentEvents = {}, calls = [], lockEvents = [], confirmations = []; let handler, confirmResult = true;
  function element(tag) {
    let text = '';
    const n = { tagName: tag.toUpperCase(), children: [], handlers: {}, attrs: {}, dataset: {}, disabled: false, hidden: false, checked: false, value: '',
      append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } },
      replaceChildren(...nodes) { this.children = []; text = ''; this.append(...nodes); },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      fire(type) { return Promise.all((this.handlers[type] || []).map(fn => fn({ target: this }))); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.tagName.toLowerCase() === selector); },
    };
    Object.defineProperties(n, { id: { get() { return n._id; }, set(id) { n._id = id; ids[id] = n; } },
      textContent: { get() { return text + this.children.map(child => child.textContent).join(' '); }, set(value) { text = String(value); this.children = []; } },
      innerHTML: { set() { throw new Error('Untrusted markup must never be rendered as HTML.'); } } });
    return n;
  }
  for (const id of ['panel-homeauto', 'bluetooth-devices-mount', 'tli-lock-screen']) { const n = element('div'); n.id = id; }
  ids['panel-homeauto'].hidden = true; ids['tli-lock-screen'].attrs['aria-hidden'] = locked ? 'false' : 'true';
  const doc = { readyState: loading ? 'loading' : 'complete', hidden: false, getElementById: id => ids[id] || null, createElement: element,
    addEventListener(type, fn) { (documentEvents[type] ||= []).push(fn); } };
  const win = { confirm(message) { confirmations.push(message); return confirmResult; }, addEventListener(type, fn) { (windowEvents[type] ||= []).push(fn); }, dispatchEvent(event) {
    if (event.type === 'tli-session-locked') lockEvents.push(event);
    for (const fn of windowEvents[event.type] || []) fn(event);
  }, EventInterpreter: { retry: async () => { calls.push({ url: 'private-access-check', options: {} }); } } };
  const defaults = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url === '/homepower/bluetooth/status') return { data: { profiles, ...support } };
    if (url === '/homepower/devices') return { data: { devices } };
    if (url === '/homepower/bluetooth/discover') return { data: { devices: [candidate()] } };
    if (url === '/homepower/bluetooth/enroll') {
      const p = profiles.find(p => p.id === body.profile); assert.ok(p, 'enrollment chooses an installed profile');
      return { data: { ok: true, device: device({ device_id: p.id_prefix + body.address.replaceAll(':', '').toLowerCase(), vendor: p.vendor, name: body.name, ip: 'ble://' + body.address,
        extra: { transport: 'bluetooth', profile: p.id, model: p.model, address: body.address }, capabilities: p.capabilities, room: body.room }) } };
    }
    if (url.endsWith('/status')) return { data: { ok: false, on: null, verified: false } };
    if (url.endsWith('/execute')) return { data: { ok: true, acknowledged: false, outcome: 'sent', verified: false, request_id: body.request_id } };
    if (options.method === 'DELETE') return { data: { ok: true } };
    throw new Error('Unexpected request: ' + url);
  };
  vm.runInNewContext(code, { window: win, document: doc, CustomEvent, Map, Set, Date, Uint8Array, crypto: webcrypto,
    AbortSignal: { timeout: ms => ({ fixtureTimeout: ms }) }, fetch: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      const r = await (handler || defaults)(url, options);
      return { status: r.status || 200, ok: (r.status || 200) >= 200 && (r.status || 200) < 300,
        json: r.json || (async () => { if (r.invalidJSON) throw new Error('Unreadable response'); return r.data; }) };
    } });
  const emit = (type, detail) => win.dispatchEvent(new CustomEvent(type, { detail }));
  return { ids, calls, doc, lockEvents, emit, defaults, confirmations, confirm(value) { confirmResult = value; }, handler(fn) { handler = fn; },
    async loaded() { doc.readyState = 'complete'; for (const fn of documentEvents.DOMContentLoaded || []) fn(); await drain(); },
    text: () => ids['bluetooth-devices-mount'].textContent,
    buttons: action => ids['bluetooth-devices'].querySelectorAll('button').filter(b => !action || b.dataset.action === action),
    writes: () => calls.filter(c => ['POST', 'DELETE'].includes(c.options.method)),
    async open() { ids['panel-homeauto'].hidden = false; for (const fn of documentEvents['tli-panel-switched'] || []) fn({ detail: { panelId: 'panel-homeauto' } }); await drain(); },
    close() { ids['panel-homeauto'].hidden = true; for (const fn of documentEvents['tli-panel-switched'] || []) fn({ detail: { panelId: 'panel-chat' } }); },
    async recovery() { emit('tli-session-unlocked', { source: 'pin-verification' }); emit('tli-private-observation-ready'); await drain(); },
    async selectCandidate(selected = profile().id) { await ids['bluetooth-scan'].click(); ids['bluetooth-candidate'].value = candidateAddress; await ids['bluetooth-candidate'].fire('change'); ids['bluetooth-profile'].value = selected; await ids['bluetooth-profile'].fire('change'); ids['bluetooth-name'].value = 'Bedroom'; ids['bluetooth-confirm'].checked = true; await ids['bluetooth-confirm'].fire('change'); },
  };
}

test('current shell loads the Bluetooth mount and controller alongside existing Shelly and Home Assistant controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /id="bluetooth-devices-mount"/); assert.match(html, /src="\/js\/bluetooth-devices\.js\?v=/);
  assert.match(html, /id="shellyCards"/); assert.match(html, /id="home-assistant-mount"/);
  assert.match(html, /<summary>Experimental · Bluetooth lights<\/summary>/); assert.match(html, /exact brand and model/); assert.match(html, /href="\/bluetooth-help\.html"/);
});
test('startup and panel navigation perform only software and saved inventory reads, without radio work', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); await f.open();
  assert.deepEqual(f.calls.map(c => c.url), ['/homepower/bluetooth/status', '/homepower/devices']);
  assert.equal(f.writes().length, 0); assert.match(f.text(), /State unknown/); assert.match(f.text(), /does not confirm an adapter/);
  assert.ok(f.calls.every(c => c.options.credentials === 'same-origin' && c.options.cache === 'no-store' && c.options.signal.fixtureTimeout === 40000));
});
test('the earlier app DOMContentLoaded panel event cannot request or paint before the Bluetooth mount initializes', async () => {
  const f = fixture({ loading: true }); await f.open(); assert.equal(f.calls.length, 0); assert.equal(f.ids['bluetooth-refresh'], undefined);
  await f.loaded(); assert.deepEqual(f.calls.map(c => c.url), ['/homepower/bluetooth/status', '/homepower/devices']); assert.match(f.text(), /Desk light/);
  await f.loaded(); assert.equal(f.calls.length, 2);
});
test('initial PIN overlay blocks all reads and bare unlock cannot resume them', async () => {
  const f = fixture({ locked: true }); await f.open(); assert.equal(f.calls.length, 0);
  f.emit('tli-session-unlocked'); await drain(); assert.equal(f.calls.length, 0);
  await f.ids['bluetooth-refresh'].click(); assert.deepEqual(f.calls.map(c => c.url), ['private-access-check']);
  f.emit('tli-private-observation-ready'); await drain(); assert.equal(f.calls.length, 3); assert.equal(f.writes().length, 0);
});
test('missing optional software shows the host reason without claiming a missing adapter or enabling radio controls', async () => {
  const f = fixture({ support: { available: false, platform: 'win32', reason: 'Optional Bluetooth support is not installed.' } }); await f.open();
  assert.match(f.text(), /not installed/); assert.equal(f.ids['bluetooth-scan'].disabled, true); assert.ok(f.buttons().filter(b => b.dataset.action !== 'forget').every(b => b.disabled));
  await f.ids['bluetooth-scan'].fire('click'); assert.equal(f.writes().length, 0); assert.match(f.text(), /Desk light/);
});
test('unsupported Windows host explains software limitation without hiding saved records', async () => {
  const f = fixture({ support: { available: false, platform: 'win32', reason: 'Windows 11 build 22000 or newer is required.' } }); await f.open();
  assert.match(f.text(), /Windows 11/); assert.match(f.text(), /Desk light/); assert.equal(f.ids['bluetooth-enroll'].disabled, true);
});
test('healthy empty saved inventory is distinct from an unavailable inventory', async () => {
  const f = fixture({ devices: [] }); await f.open(); assert.match(f.text(), /No Bluetooth devices are saved/); assert.equal(f.ids['bluetooth-scan'].disabled, false);
});
for (const failure of ['503', 'network', 'json', 'shape', 'record']) test('saved inventory failure ' + failure + ' disables enrollment and never becomes an empty list', async () => {
  const f = fixture(); f.handler(async (url, opts) => {
    if (url !== '/homepower/devices') return f.defaults(url, opts);
    if (failure === 'network') throw Error('Disconnected');
    if (failure === 'json') return { invalidJSON: true };
    if (failure === '503') return { status: 503, data: { detail: 'Saved HomePower data needs review.' } };
    return { data: failure === 'shape' ? {} : { devices: [device({ extra: {} })] } };
  }); await f.open(); assert.match(f.text(), /unavailable/); assert.doesNotMatch(f.text(), /No Bluetooth devices are saved/);
  assert.equal(f.ids['bluetooth-scan'].disabled, true); assert.equal(f.writes().length, 0);
});
test('existing LAN Govee records are not changed or projected as Bluetooth devices', async () => {
  const f = fixture({ devices: [device(), { device_id: 'old', name: 'LAN light', vendor: 'govee', ip: '192.0.2.1' }] }); await f.open();
  assert.match(f.text(), /Desk light/); assert.doesNotMatch(f.text(), /LAN light/); assert.equal(f.buttons('switch.on').length, 1);
});
test('explicit scan is separate from enrollment and model checkbox must be deliberate', async () => {
  const f = fixture(); await f.open(); await f.ids['bluetooth-scan'].click();
  assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].url, '/homepower/bluetooth/discover'); assert.match(f.text(), /not model verification/);
  f.ids['bluetooth-candidate'].value = candidateAddress; await f.ids['bluetooth-candidate'].fire('change');
  f.ids['bluetooth-name'].value = 'Bedroom'; await f.ids['bluetooth-enroll'].fire('click'); assert.equal(f.writes().length, 1);
  f.ids['bluetooth-profile'].value = profile().id; await f.ids['bluetooth-profile'].fire('change');
  f.ids['bluetooth-confirm'].checked = true; await f.ids['bluetooth-confirm'].fire('change'); await f.ids['bluetooth-enroll'].click();
  assert.deepEqual(f.writes()[1].body, { address: candidateAddress, name: 'Bedroom', room: null, profile: profile().id, model: 'H6125', confirm_model: true });
  assert.equal(f.writes().length, 2); assert.match(f.text(), /H6125 saved/); assert.equal(f.calls.some(c => c.url.endsWith('/execute') || /\/devices\/.+\/status$/.test(c.url)), false);
});
test('an unidentified advertisement can be explicitly confirmed from its printed H6125 label', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => u.endsWith('/discover') ? { data: { devices: [candidate({ model: null, supported: false, profile_hints: [] })] } } : f.defaults(u, o));
  await f.selectCandidate(); assert.match(f.text(), /no installed model hint/); await f.ids['bluetooth-enroll'].click(); assert.match(f.text(), /H6125 saved/);
});
test('changing selection clears model confirmation and already saved addresses cannot be enrolled again', async () => {
  const f = fixture(); await f.open(); await f.selectCandidate(); await f.ids['bluetooth-candidate'].fire('change');
  assert.equal(f.ids['bluetooth-confirm'].checked, false); assert.equal(f.ids['bluetooth-enroll'].disabled, true);
  f.handler(async (u, o) => u.endsWith('/discover') ? { data: { devices: [candidate({ address })] } } : f.defaults(u, o));
  await f.ids['bluetooth-scan'].click(); f.ids['bluetooth-candidate'].value = address; f.ids['bluetooth-confirm'].checked = true; await f.ids['bluetooth-confirm'].fire('change');
  await f.ids['bluetooth-enroll'].fire('click'); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 0);
});
test('duplicate scan and enrollment events dispatch once while pending', async () => {
  const f = fixture(); await f.open(); let release;
  f.handler(async (u, o) => u.endsWith('/discover') ? new Promise(resolve => { release = resolve; }) : f.defaults(u, o));
  const p = f.ids['bluetooth-scan'].click(); await f.ids['bluetooth-scan'].fire('click'); assert.equal(f.writes().length, 1);
  release({ data: { devices: [candidate()] } }); await p;
  f.ids['bluetooth-candidate'].value = candidateAddress; f.ids['bluetooth-name'].value = 'Bedroom'; f.ids['bluetooth-profile'].value = profile().id; await f.ids['bluetooth-profile'].fire('change');
  f.ids['bluetooth-confirm'].checked = true; await f.ids['bluetooth-confirm'].fire('change');
  f.handler(async (u, o) => u.endsWith('/enroll') ? new Promise(resolve => { release = () => resolve(f.defaults(u, o)); }) : f.defaults(u, o));
  const e = f.ids['bluetooth-enroll'].click(); await f.ids['bluetooth-enroll'].fire('click'); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 1); release(); await e;
});
for (const failure of ['503', 'network', 'wrong-address', 'wrong-name', 'malformed']) test('unconfirmed enrollment ' + failure + ' requires saved inventory reconciliation and never retries', async () => {
  const f = fixture(); await f.open(); await f.selectCandidate(); f.handler(async (u, o) => {
    if (!u.endsWith('/enroll')) return f.defaults(u, o);
    if (failure === 'network') throw Error('Connection lost');
    if (failure === '503') return { status: 503, data: { detail: 'Save unconfirmed.' } };
    const response = await f.defaults(u, o);
    if (failure === 'wrong-address') response.data.device = device();
    if (failure === 'wrong-name') response.data.device.name = 'Different device';
    if (failure === 'malformed') response.data = { ok: true };
    return response;
  }); await f.ids['bluetooth-enroll'].click(); assert.match(f.text(), /Enrollment outcome unconfirmed/); assert.equal(f.ids['bluetooth-name'].value, 'Bedroom');
  assert.equal(f.ids['bluetooth-enroll'].disabled, true); await f.ids['bluetooth-enroll'].fire('click'); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 1);
  f.handler(f.defaults); await f.ids['bluetooth-refresh'].click(); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 1); assert.equal(f.ids['bluetooth-confirm'].checked, false);
});
test('advertisement names, saved names, room metadata and server errors are literal text', async () => {
  const markup = '<img src=x onerror=alert(1)>';
  const f = fixture({ devices: [device({ name: markup, room: markup })] }); await f.open(); assert.match(f.text(), /<img src=x/);
  f.handler(async (u, o) => u.endsWith('/discover') ? { data: { devices: [candidate({ name: markup })] } } : f.defaults(u, o)); await f.ids['bluetooth-scan'].click(); assert.match(f.text(), /<img src=x/);
  f.handler(async () => ({ status: 503, data: { detail: markup } })); await f.buttons('status')[0].click(); assert.match(f.text(), /<img src=x/);
});
test('explicit On sends one exact target and UUID, then one fresh state read without optimistic ON', async () => {
  const f = fixture(); await f.open(); await f.buttons('switch.on')[0].click();
  const write = f.calls.find(c => c.url.endsWith('/execute')); assert.equal(write.url, '/homepower/devices/govee-ble-aabbccddee01/execute');
  assert.equal(write.body.capability, 'switch.on'); assert.match(write.body.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(f.calls.filter(c => /\/devices\/.+\/status$/.test(c.url)).length, 1); assert.equal(f.writes().length, 1);
  assert.match(f.text(), /lamp did not acknowledge/); assert.match(f.text(), /State unknown/); assert.doesNotMatch(f.text(), /Device reported ON|Device reported OFF/);
});
test('verified state reading is distinct from sent acknowledgement and never synthesized from intent', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => /\/devices\/.+\/status$/.test(u) ? { data: { ok: true, on: false, verified: true } } : f.defaults(u, o));
  await f.buttons('switch.on')[0].click(); assert.match(f.text(), /Device reported OFF/); assert.match(f.text(), /not physical confirmation/); assert.equal(f.writes().length, 1);
});
test('duplicate opposite commands are blocked while one write is pending', async () => {
  const f = fixture(); await f.open(); const on = f.buttons('switch.on')[0], off = f.buttons('switch.off')[0]; let release;
  f.handler(async (u, o) => u.endsWith('/execute') ? new Promise(resolve => { release = () => resolve(f.defaults(u, o)); }) : f.defaults(u, o));
  const p = on.click(); await on.fire('click'); await off.fire('click'); assert.equal(f.writes().length, 1); release(); await p;
});
for (const failure of ['503', 'network', 'unknown', 'malformed', 'wrong-id']) test('command ' + failure + ' stays unconfirmed, requires explicit Check state and sends no automatic retry', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => {
    if (!u.endsWith('/execute')) return f.defaults(u, o);
    if (failure === 'network') throw Error('Connection lost');
    if (failure === '503') return { status: 503, data: { detail: 'Driver unavailable' } };
    if (failure === 'unknown') return { data: { ok: false, outcome: 'unknown', acknowledged: false, verified: false } };
    const value = await f.defaults(u, o); if (failure === 'malformed') value.data = {}; else value.data.request_id = 'other'; return value;
  }); await f.buttons('switch.off')[0].click(); assert.match(f.text(), /Command outcome unconfirmed/); assert.equal(f.buttons('switch.on')[0].disabled, true);
  assert.equal(f.calls.filter(c => /\/devices\/.+\/status$/.test(c.url)).length, 0); assert.equal(f.writes().length, 1);
  f.handler(f.defaults); await f.ids['bluetooth-refresh'].click(); assert.equal(f.buttons('switch.on')[0].disabled, true);
  await f.buttons('status')[0].click(); assert.equal(f.buttons('switch.on')[0].disabled, false); assert.match(f.text(), /unknown reading is not OFF/); assert.equal(f.writes().length, 1);
  await f.buttons('switch.on')[0].click(); assert.equal(f.writes().length, 2); assert.notEqual(f.writes()[0].body.request_id, f.writes()[1].body.request_id);
});
test('failed automatic state check preserves the sent outcome and requires an explicit state check', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => /\/devices\/.+\/status$/.test(u) ? { status: 503, data: { detail: 'No readback' } } : f.defaults(u, o));
  await f.buttons('switch.on')[0].click(); assert.match(f.text(), /Command sent/); assert.match(f.text(), /State check unavailable/); assert.equal(f.buttons('switch.off')[0].disabled, true); assert.equal(f.writes().length, 1);
});
test('leaving the panel before command settlement suppresses the follow-up radio read', async () => {
  const f = fixture(); await f.open(); let release; f.handler(async (u, o) => u.endsWith('/execute') ? new Promise(resolve => { release = () => resolve(f.defaults(u, o)); }) : f.defaults(u, o));
  const p = f.buttons('switch.on')[0].click(); f.close(); release(); await p; assert.equal(f.calls.some(c => /\/devices\/.+\/status$/.test(c.url)), false);
  await f.open(); assert.equal(f.buttons('switch.on')[0].disabled, true); assert.equal(f.writes().length, 1);
});
for (const status of [401, 403]) test('current ' + status + ' clears private views before reading a denied body, without resuming on bare unlock', async () => {
  const f = fixture(); await f.open(); let bodyRead = false;
  f.handler(async () => ({ status, json: async () => { bodyRead = true; return { detail: 'private' }; } }));
  await f.buttons('status')[0].click(); assert.equal(bodyRead, false); assert.equal(f.lockEvents.length, 1); assert.doesNotMatch(f.text(), /Desk light|AA:BB/);
  f.emit('tli-session-unlocked'); await drain(); const count = f.calls.length; await f.ids['bluetooth-scan'].fire('click'); assert.equal(f.calls.length, count);
  f.handler(f.defaults); f.emit('tli-private-observation-ready'); await drain(); assert.match(f.text(), /Desk light/); assert.equal(f.writes().length, 0);
});
for (const event of ['tli-session-locked', 'tli-account-changed', 'tli-user-changed']) test(event + ' clears saved names, scan candidates, typed metadata and detached actions', async () => {
  const f = fixture(); await f.open(); await f.selectCandidate(); const old = f.buttons('switch.on')[0]; f.emit(event);
  assert.doesNotMatch(f.text(), /Desk light|Govee_H6125|AA:BB/); assert.equal(f.ids['bluetooth-name'].value, '');
  await f.recovery(); const count = f.writes().length; await old.fire('click'); assert.equal(f.writes().length, count); assert.equal(f.calls.filter(c => c.url.endsWith('/discover')).length, 1);
});
for (const stage of ['headers', 'body']) for (const endpoint of ['inventory', 'scan', 'enroll', 'command', 'state']) test('late ' + endpoint + ' ' + stage + ' cannot publish or follow up across sessions', async () => {
  const f = fixture(); await f.open(); if (endpoint === 'enroll') await f.selectCandidate(); let release;
  const matches = u => endpoint === 'inventory' ? u === '/homepower/devices' : endpoint === 'scan' ? u.endsWith('/discover') : endpoint === 'enroll' ? u.endsWith('/enroll') : endpoint === 'command' ? u.endsWith('/execute') : /\/devices\/.+\/status$/.test(u);
  f.handler(async (u, o) => {
    if (!matches(u)) return f.defaults(u, o); const response = await f.defaults(u, o);
    return stage === 'headers' ? new Promise(resolve => { release = () => resolve(response); }) : { ...response, json: () => new Promise(resolve => { release = () => resolve(response.data); }) };
  });
  const pending = endpoint === 'inventory' ? f.ids['bluetooth-refresh'].click() : endpoint === 'scan' ? f.ids['bluetooth-scan'].click() : endpoint === 'enroll' ? f.ids['bluetooth-enroll'].click() : f.buttons(endpoint === 'state' ? 'status' : 'switch.on')[0].click();
  await drain(); assert.equal(typeof release, 'function'); f.emit('tli-session-locked'); f.handler(f.defaults); await f.recovery();
  const count = f.calls.length; release(); await pending; assert.equal(f.calls.length, count); assert.doesNotMatch(f.text(), /H6125 saved|Command sent|Device reported/); assert.equal(f.ids['bluetooth-scan'].disabled, false);
});
test('a late old-session denial cannot lock a newly verified session or clear its pending operation', async () => {
  const f = fixture(); await f.open(); let oldRelease, newRelease;
  f.handler(async () => new Promise(resolve => { oldRelease = () => resolve({ status: 403, data: {} }); }));
  const old = f.buttons('status')[0].click(); f.emit('tli-session-locked'); f.handler(f.defaults); await f.recovery();
  f.handler(async (u, o) => u.endsWith('/discover') ? new Promise(resolve => { newRelease = () => resolve(f.defaults(u, o)); }) : f.defaults(u, o));
  const fresh = f.ids['bluetooth-scan'].click(); oldRelease(); await old; assert.equal(f.lockEvents.length, 1); assert.equal(f.ids['bluetooth-refresh'].disabled, true);
  newRelease(); await fresh; assert.equal(f.ids['bluetooth-refresh'].disabled, false); assert.match(f.text(), /Scan complete/);
});
for (const bad of [{}, { available: 'yes', platform: 'win32', reason: '' }, { available: true, platform: null, reason: '' }]) test('malformed software availability cannot enable a radio request: ' + JSON.stringify(bad), async () => {
  const f = fixture({ support: bad }); await f.open(); assert.equal(f.ids['bluetooth-scan'].disabled, true); assert.equal(f.calls.length, 1); assert.match(f.text(), /unavailable/);
});
for (const bad of [{}, { ok: true, on: false }, { ok: true, on: null, verified: true }, { ok: false, on: true, verified: true }]) test('malformed state never becomes a verified OFF/ON reading: ' + JSON.stringify(bad), async () => {
  const f = fixture(); await f.open(); f.handler(async () => ({ data: bad })); await f.buttons('status')[0].click(); assert.match(f.text(), /State unavailable/); assert.doesNotMatch(f.text(), /Device reported/); assert.equal(f.writes().length, 0);
});
for (const [reason, message] of [['dependency_missing', /not installed/], ['windows_11_required', /Windows 11 build 22000/], ['dependency_version_unsupported', /not a supported version/], ['cleanup_pending', /not finished cleanup/]]) test('software reason ' + reason + ' is explained in plain language', async () => {
  const f = fixture({ support: { available: false, platform: 'win32', reason } }); await f.open(); assert.match(f.text(), message); assert.doesNotMatch(f.text(), new RegExp(reason)); assert.equal(f.ids['bluetooth-scan'].disabled, true);
});
test('an unknown saved profile or incompatible binding remains visible without radio controls', async () => {
  for (const value of [device({ extra: { ...device().extra, profile: 'other' } }), device({ capabilities: ['switch.on', 'switch.off', 'switch.toggle'] }), device({ device_id: 'other-id' })]) {
    const f = fixture({ devices: [value] }); await f.open(); assert.match(f.text(), /no matching installed integration/); assert.match(f.text(), /Desk light/); assert.equal(f.buttons('switch.on').length, 0); assert.equal(f.buttons('status').length, 0); assert.equal(f.buttons('forget').length, 1); assert.equal(f.writes().length, 0);
  }
});
test('saved inventory refresh drops an earlier reading instead of placing it under refreshed metadata', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => /\/devices\/.+\/status$/.test(u) ? { data: { ok: true, on: true, verified: true } } : f.defaults(u, o));
  await f.buttons('status')[0].click(); assert.match(f.text(), /Device reported ON/);
  f.handler(async (u, o) => u === '/homepower/devices' ? { data: { devices: [device({ name: 'Renamed light' })] } } : f.defaults(u, o));
  await f.ids['bluetooth-refresh'].click(); assert.match(f.text(), /Renamed light/); assert.doesNotMatch(f.text(), /Desk light|Device reported ON/); assert.match(f.text(), /State unknown/);
});
test('confirmed PIN verification without a prior lock rotates pending view authority and waits for readiness', async () => {
  const f = fixture(); await f.open(); let release;
  f.handler(async () => new Promise(resolve => { release = () => resolve({ data: { ok: true, on: true, verified: true } }); }));
  const old = f.buttons('status')[0].click(); f.emit('tli-session-unlocked', { source: 'pin-verification' }); assert.doesNotMatch(f.text(), /Desk light/);
  const count = f.calls.length; f.emit('tli-session-unlocked', { source: 'pin-verification' }); await drain(); assert.equal(f.calls.length, count);
  release(); await old; assert.doesNotMatch(f.text(), /Device reported/); f.handler(f.defaults); f.emit('tli-private-observation-ready'); await drain(); assert.match(f.text(), /Desk light/);
});
test('cleanup-pending sent outcome pauses radio work without an automatic read, while allowing saved-entry removal', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => { const value = await f.defaults(u, o); if (u.endsWith('/execute')) value.data.cleanup_pending = true; return value; });
  await f.buttons('switch.on')[0].click(); assert.equal(f.calls.some(c => /\/devices\/.+\/status$/.test(c.url)), false);
  assert.match(f.text(), /cleanup is pending/); assert.equal(f.ids['bluetooth-scan'].disabled, true); assert.equal(f.buttons('status')[0].disabled, true); assert.equal(f.buttons('forget')[0].disabled, false);
});
test('enrollment preserves Unicode code points and rejects controls or excessive input before a write', async () => {
  const f = fixture(); await f.open(); await f.selectCandidate();
  for (const value of [' ', 'x'.repeat(65), '\nBedroom', 'Bedroom\t']) { f.ids['bluetooth-name'].value = value; await f.ids['bluetooth-enroll'].click(); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 0); }
  f.ids['bluetooth-name'].value = '💡'.repeat(64); await f.ids['bluetooth-enroll'].click(); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 1); assert.match(f.text(), /H6125 saved/);
});
test('Forget device requires a separate confirmation and only deletes the exact saved TLI entry', async () => {
  const f = fixture(); await f.open(); f.confirm(false); await f.buttons('forget')[0].click(); assert.equal(f.writes().length, 0);
  assert.match(f.confirmations[0], /does not unpair Windows Bluetooth or send a light command/); f.confirm(true); await f.buttons('forget')[0].click();
  assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].options.method, 'DELETE'); assert.equal(f.writes()[0].url, '/homepower/devices/govee-ble-aabbccddee01');
  assert.match(f.text(), /Saved TLI entry removed/); assert.doesNotMatch(f.text(), /Desk light/); assert.equal(f.calls.some(c => c.url.endsWith('/execute') || /\/devices\/.+\/status$/.test(c.url) || c.url.endsWith('/discover')), false);
});
test('Forget device remains available without optional Bluetooth software and does not connect', async () => {
  const f = fixture({ support: { available: false, platform: 'win32', reason: 'dependency_missing' } }); await f.open(); await f.buttons('forget')[0].click(); assert.match(f.text(), /Saved TLI entry removed/); assert.equal(f.writes().length, 1);
});
for (const failure of ['503', 'network', 'malformed', 'false']) test('Forget device ' + failure + ' is unconfirmed and requires inventory reconciliation without another deletion', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => {
    if (o.method !== 'DELETE') return f.defaults(u, o);
    if (failure === 'network') throw Error('Disconnected');
    if (failure === '503') return { status: 503, data: { detail: 'Save unavailable' } };
    return { data: failure === 'false' ? { ok: false } : {} };
  }); await f.buttons('forget')[0].click(); assert.match(f.text(), /Removal outcome unconfirmed/); assert.doesNotMatch(f.text(), /Saved TLI entry removed/); assert.equal(f.buttons().length, 0);
  f.handler(f.defaults); await f.ids['bluetooth-refresh'].click(); assert.equal(f.writes().length, 1); assert.match(f.text(), /Desk light/);
});
test('pending Forget device blocks duplicate deletion and other light actions', async () => {
  const f = fixture(); await f.open(); let release; const remove = f.buttons('forget')[0], on = f.buttons('switch.on')[0];
  f.handler(async (u, o) => o.method === 'DELETE' ? new Promise(resolve => { release = () => resolve({ data: { ok: true } }); }) : f.defaults(u, o));
  const pending = remove.click(); await remove.fire('click'); await on.fire('click'); assert.equal(f.writes().length, 1); release(); await pending;
});
for (const stage of ['headers', 'body']) test('stale Forget device ' + stage + ' cannot clear a later session inventory or report success', async () => {
  const f = fixture(); await f.open(); let release; const oldButton = f.buttons('forget')[0];
  f.handler(async (u, o) => o.method === 'DELETE' ? stage === 'headers' ? new Promise(resolve => { release = () => resolve({ data: { ok: true } }); }) : { json: () => new Promise(resolve => { release = () => resolve({ ok: true }); }) } : f.defaults(u, o));
  const pending = oldButton.click(); await drain(); f.emit('tli-session-locked'); f.handler(f.defaults); await f.recovery(); release(); await pending;
  assert.match(f.text(), /Desk light/); assert.doesNotMatch(f.text(), /Saved TLI entry removed/); await oldButton.fire('click'); assert.equal(f.writes().length, 1);
});
for (const status of [401, 403]) test('denied Forget device ' + status + ' clears private metadata and never retries after verification', async () => {
  const f = fixture(); await f.open(); f.handler(async () => ({ status, data: { detail: 'Denied' } })); await f.buttons('forget')[0].click();
  assert.doesNotMatch(f.text(), /Desk light|Saved TLI entry removed/); f.handler(f.defaults); await f.recovery(); assert.equal(f.writes().length, 1); assert.match(f.text(), /Desk light/);
});
for (const endpoint of ['support', 'inventory', 'scan', 'enroll', 'command', 'state', 'forget']) test('lock between settled request and caller continuation blocks ' + endpoint + ' publication', async () => {
  const f = fixture(); await f.open(); if (endpoint === 'enroll') await f.selectCandidate();
  const match = (u, o) => endpoint === 'support' ? u === '/homepower/bluetooth/status' : endpoint === 'inventory' ? u === '/homepower/devices' : endpoint === 'scan' ? u.endsWith('/discover') : endpoint === 'enroll' ? u.endsWith('/enroll') : endpoint === 'command' ? u.endsWith('/execute') : endpoint === 'forget' ? o.method === 'DELETE' : /\/devices\/.+\/status$/.test(u);
  f.handler(async (u, o) => { const value = await f.defaults(u, o); if (!match(u, o)) return value;
    return { ...value, json: async () => { queueMicrotask(() => queueMicrotask(() => f.emit('tli-session-locked'))); return value.data; } };
  });
  if (['support', 'inventory'].includes(endpoint)) await f.ids['bluetooth-refresh'].click();
  else if (endpoint === 'scan') await f.ids['bluetooth-scan'].click();
  else if (endpoint === 'enroll') await f.ids['bluetooth-enroll'].click();
  else await f.buttons(endpoint === 'command' ? 'switch.on' : endpoint === 'state' ? 'status' : 'forget')[0].click();
  await drain(); assert.equal(f.lockEvents.length, 1); assert.doesNotMatch(f.text(), /Desk light|AA:BB|H6125 saved|Command sent|Device reported|Saved TLI entry removed/); assert.equal(f.buttons().length, 0);
  if (endpoint === 'command') assert.equal(f.calls.some(c => /\/devices\/.+\/status$/.test(c.url)), false);
});

// Synthetic descriptors prove extensibility; they add no real supported brand.
const secondProfile = () => profile({ id: 'fixture_b200_v1', vendor: 'fixture_ble', brand: 'Fixture Brand', model: 'B200', id_prefix: 'fixture-ble-', capabilities: ['switch.off'] });
const secondDevice = () => device({ device_id: 'fixture-ble-aabbccddee03', name: 'Other brand light', vendor: 'fixture_ble', ip: 'ble://AA:BB:CC:DD:EE:03',
  extra: { transport: 'bluetooth', profile: secondProfile().id, model: 'B200', address: 'AA:BB:CC:DD:EE:03' }, capabilities: ['switch.off'] });
test('a synthetic second brand renders from its descriptor and exposes only its declared light control', async () => {
  const f = fixture({ profiles: [profile(), secondProfile()], devices: [device(), secondDevice()] }); await f.open();
  assert.match(f.text(), /Fixture Brand B200/); assert.match(f.text(), /Govee H6125/); assert.match(f.text(), /physical-device validation is pending/);
  const buttons = f.buttons().filter(b => b.dataset.deviceId === secondDevice().device_id);
  assert.deepEqual(buttons.map(b => b.dataset.action), ['status', 'switch.off', 'forget']); assert.equal(f.writes().length, 0);
  await buttons.find(b => b.dataset.action === 'switch.off').click();
  assert.equal(f.writes()[0].url, '/homepower/devices/' + secondDevice().device_id + '/execute'); assert.equal(f.writes()[0].body.capability, 'switch.off'); assert.match(f.text(), /State unknown/);
});
test('a synthetic second brand enrollment binds profile, model, returned ID, vendor and declared capabilities', async () => {
  const f = fixture({ profiles: [profile(), secondProfile()] }); await f.open();
  f.handler(async (u, o) => u.endsWith('/discover') ? { data: { devices: [candidate({ name: 'Fixture advertisement', profile_hints: [secondProfile().id], model: null, supported: false })] } } : f.defaults(u, o));
  await f.ids['bluetooth-scan'].click(); assert.equal(f.ids['bluetooth-profile'].value, ''); assert.match(f.text(), /advertisement hint: Fixture Brand B200/);
  f.ids['bluetooth-candidate'].value = candidateAddress; f.ids['bluetooth-name'].value = 'New fixture light'; f.ids['bluetooth-confirm'].checked = true; await f.ids['bluetooth-confirm'].fire('change');
  await f.ids['bluetooth-enroll'].fire('click'); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 0);
  f.ids['bluetooth-profile'].value = secondProfile().id; await f.ids['bluetooth-profile'].fire('change'); assert.equal(f.ids['bluetooth-confirm'].checked, false); assert.match(f.ids['bluetooth-confirm-label'].textContent, /Fixture Brand B200/);
  f.ids['bluetooth-confirm'].checked = true; await f.ids['bluetooth-confirm'].fire('change'); await f.ids['bluetooth-enroll'].click();
  assert.deepEqual(f.calls.find(c => c.url.endsWith('/enroll')).body, { address: candidateAddress, name: 'New fixture light', room: null, profile: secondProfile().id, model: 'B200', confirm_model: true });
  assert.match(f.text(), /Fixture Brand B200 saved/); const id = 'fixture-ble-aabbccddee02'; assert.equal(f.buttons('switch.on').filter(b => b.dataset.deviceId === id).length, 0); assert.equal(f.buttons('switch.off').filter(b => b.dataset.deviceId === id).length, 1);
});
test('an enrollment acknowledgement for another profile cannot create a controllable card', async () => {
  const f = fixture({ profiles: [profile(), secondProfile()] }); await f.open(); await f.selectCandidate(secondProfile().id);
  f.handler(async (u, o) => u.endsWith('/enroll') ? { data: { ok: true, device: device({ name: 'Bedroom', ip: 'ble://' + candidateAddress, device_id: 'govee-ble-aabbccddee02', extra: { ...device().extra, address: candidateAddress } }) } } : f.defaults(u, o));
  await f.ids['bluetooth-enroll'].click(); assert.match(f.text(), /Enrollment outcome unconfirmed/); assert.equal(f.buttons().length, 0); assert.equal(f.calls.some(c => c.url.endsWith('/execute')), false);
});
test('unknown-profile and differently cased saved Bluetooth records stay visible without hiding supported lights', async () => {
  const unsupported = secondDevice(); unsupported.ip = 'BLE://AA:BB:CC:DD:EE:03'; unsupported.extra.transport = 'Bluetooth';
  const f = fixture({ devices: [device(), unsupported] }); await f.open();
  assert.match(f.text(), /Other brand light/); assert.match(f.text(), /no matching installed integration/); assert.match(f.text(), /Desk light/);
  assert.equal(f.buttons('switch.on').length, 1); assert.equal(f.buttons('status').length, 1); assert.equal(f.buttons('forget').length, 2); assert.equal(f.writes().length, 0);
});
test('no installed profiles still permits explicit detection but cannot enroll or control a model', async () => {
  const f = fixture({ profiles: [] }); await f.open(); assert.match(f.text(), /No supported Bluetooth model integrations/); assert.match(f.text(), /Desk light/); assert.equal(f.buttons('status').length, 0);
  await f.ids['bluetooth-scan'].click(); assert.match(f.text(), /no installed model hint/); assert.match(f.text(), /unsupported devices need an integration/); assert.equal(f.ids['bluetooth-profile'].disabled, true);
  f.ids['bluetooth-candidate'].value = candidateAddress; f.ids['bluetooth-confirm'].checked = true; f.ids['bluetooth-name'].value = 'Unlisted'; await f.ids['bluetooth-enroll'].fire('click'); assert.equal(f.calls.filter(c => c.url.endsWith('/enroll')).length, 0);
});
test('discovery legacy supported/model fields never select or authorize an installed integration', async () => {
  const f = fixture(); await f.open(); f.handler(async (u, o) => u.endsWith('/discover') ? { data: { devices: [candidate({ supported: true, model: 'H6125', profile_hints: ['not_installed_v1'] })] } } : f.defaults(u, o));
  await f.ids['bluetooth-scan'].click(); assert.match(f.text(), /no installed model hint/); assert.equal(f.ids['bluetooth-profile'].value, ''); assert.equal(f.ids['bluetooth-enroll'].disabled, true); assert.equal(f.writes().length, 1);
});
for (const [name, value] of [
  ['missing', undefined], ['null', null], ['object', {}], ['missing-id', [profile({ id: undefined })]], ['null-id', [profile({ id: null })]],
  ['array-id', [profile({ id: ['govee_h6125_v1'] })]], ['null-vendor', [profile({ vendor: null })]], ['number-vendor', [profile({ vendor: 10 })]],
  ['duplicate-id', [profile(), secondProfile(), secondProfile()]], ['duplicate-binding', [profile(), profile({ id: 'different_v1', id_prefix: 'different-' })]],
  ['duplicate-prefix', [profile(), { ...secondProfile(), id_prefix: profile().id_prefix }]],
  ['unsafe-prefix', [profile({ id_prefix: '../device-' })]], ['long-prefix', [profile({ id_prefix: 'x'.repeat(53) + '-' })]],
  ['empty-capabilities', [profile({ capabilities: [] })]], ['toggle-capability', [profile({ capabilities: ['switch.toggle'] })]],
  ['duplicate-capability', [profile({ capabilities: ['switch.on', 'switch.on'] })]], ['invalid-validation', [profile({ validation: 'trusted' })]],
  ['empty-brand', [profile({ brand: '' })]], ['model-control', [profile({ model: 'H6125\n' })]],
]) test('malformed profile catalog ' + name + ' fails closed without radio requests or empty-inventory claims', async () => {
  const f = fixture({ profiles: value }); f.handler(async (u, o) => u === '/homepower/bluetooth/status' ? { data: { available: true, platform: 'win32', reason: 'runtime_ready', ...(value === undefined ? {} : { profiles: value }) } } : f.defaults(u, o));
  await f.open(); assert.match(f.text(), /catalog/); assert.equal(f.ids['bluetooth-scan'].disabled, true); assert.equal(f.buttons().length, 0); assert.doesNotMatch(f.text(), /No Bluetooth devices are saved/); assert.equal(f.calls.length, 1); assert.equal(f.writes().length, 0);
});
for (const [label, change] of [['relay-one', { relay: 1 }], ['relay-null', { relay: null }], ['relay-bool', { relay: false }], ['reordered-capabilities', { capabilities: ['switch.off', 'switch.on'] }]]) test('saved binding ' + label + ' is unavailable without suppressing metadata or authorizing a command', async () => {
  const f = fixture({ devices: [device(change)] }); await f.open(); assert.match(f.text(), /Desk light/); assert.match(f.text(), /no matching installed integration/); assert.equal(f.buttons('switch.on').length, 0); assert.equal(f.buttons('switch.off').length, 0); assert.equal(f.buttons('status').length, 0); assert.equal(f.buttons('forget').length, 1);
});
test('a late second-brand catalog response cannot repopulate profile options after lock', async () => {
  const f = fixture({ profiles: [profile(), secondProfile()] }); await f.open(); let release;
  f.handler(async (u, o) => u === '/homepower/bluetooth/status' ? { json: () => new Promise(resolve => { release = () => resolve({ available: true, platform: 'win32', reason: 'runtime_ready', profiles: [profile(), secondProfile()] }); }) } : f.defaults(u, o));
  const p = f.ids['bluetooth-refresh'].click(); await drain(); f.emit('tli-session-locked'); release(); await p; assert.doesNotMatch(f.text(), /Govee H6125|Fixture Brand B200/); assert.equal(f.ids['bluetooth-profile'].children.length, 1);
});
test('a differently cased known vendor stays visible as an unavailable binding', async () => {
  const f = fixture({ devices: [device({ vendor: 'GOVEE_BLE' })] }); await f.open(); assert.match(f.text(), /Desk light/); assert.match(f.text(), /no matching installed integration/); assert.equal(f.buttons('status').length, 0); assert.equal(f.buttons('forget').length, 1);
});
test('a record claiming an installed profile without Bluetooth markers cannot silently vanish into an empty inventory', async () => {
  const f = fixture({ devices: [device({ vendor: 'other', ip: '192.0.2.10', extra: { profile: profile().id } })] }); await f.open(); assert.match(f.text(), /inventory is invalid/); assert.doesNotMatch(f.text(), /No Bluetooth devices are saved/); assert.equal(f.buttons().length, 0); assert.equal(f.ids['bluetooth-scan'].disabled, true);
});
