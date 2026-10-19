const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../js/pihole.js'), 'utf8');
const helpers = require('../js/pihole.js');
const PROTOCOL = 'tli-pihole-v1';
const FUTURE = '2099-10-16T12:00:00Z', NOW = '2026-10-16T12:00:00Z';
const connection = () => ({id: 'session-1', origin: 'https://192.168.1.2', expires_at: FUTURE});
const groups = () => [
  {id: 0, name: 'Default', enabled: true, description: null, date_added: 1, date_modified: 1},
  {id: 1, name: 'Kids', enabled: true, description: 'Family devices', date_added: 1, date_modified: 1},
  {id: 2, name: 'Lab', enabled: false, description: null, date_added: 1, date_modified: 1}
];
const clients = () => [
  {id: 1, client: '192.168.1.24', comment: 'Media server', groups: [0], date_added: 1, date_modified: 1, editable: true},
  {id: 2, client: '192.168.1.25', comment: 'Laptop', groups: [0, 1], date_added: 1, date_modified: 1, editable: true},
  {id: 3, client: 'aa:bb:cc:dd:ee:ff', comment: 'MAC selector', groups: [0], date_added: 1, date_modified: 1, editable: false},
  {id: 4, client: '192.168.1.0/24', comment: 'Subnet selector', groups: [0], date_added: 1, date_modified: 1, editable: false}
];
const inventory = () => ({protocol: PROTOCOL, clients: clients(), groups: groups(), checked_at: NOW});
const reviewResponse = body => ({protocol: PROTOCOL, review_id: 'review-1', expires_at: FUTURE, target: {client: body.client, origin: connection().origin},
  before_groups: clients().find(row => row.client === body.client).groups, after_groups: body.action === 'restore' ? [0] : body.groups,
  action: body.action, group_names: groups().map(({id, name}) => ({id, name})), scope: 'Changes only this exact Pi-hole client record.'});
const saved = (action = 'pause') => ({id: 'receipt-1', origin: connection().origin, client: '192.168.1.24', action, created_at: NOW,
  before: {clientrecord: clients()[0], groups: [groups()[0]]}, after_groups: action === 'pause' ? [] : [1],
  outcome: {outcome: 'confirmed', attempted: true, acknowledged: true, membership_verified: true, summary: 'Group membership verified after the change.', checked_at: NOW}});
function fixture() {
  const events = {}, documentEvents = {}, calls = [], timers = new Map(); let timerId = 0;
  function make(tag) {
    const el = {tagName: tag.toUpperCase(), children: [], parentNode: null, textContent: '', value: '', id: '', hidden: false, disabled: false, checked: false, attributes: {}, handlers: {},
      append(...items) { for (const child of items) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(row => row !== child); child.parentNode = this; this.children.push(child); } },
      replaceChildren(...items) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...items); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      async fire(name = 'click') { await Promise.all((this.handlers[name] || []).map(fn => fn({preventDefault() {}}))); }
    };
    Object.defineProperty(el, 'innerHTML', {set() {assert.fail('Pi-hole data must be rendered as text');}});
    return el;
  }
  const body = make('body'), mount = make('div'); mount.id = 'pihole-mount'; body.append(mount);
  function find(id, el = body) { return el.id === id ? el : el.children.map(child => find(id, child)).find(Boolean); }
  const document = {readyState: 'complete', createElement: make, getElementById: find, addEventListener: (name, fn) => (documentEvents[name] ||= []).push(fn)};
  const window = {document, addEventListener: (name, fn) => (events[name] ||= []).push(fn), dispatchEvent: event => {for (const fn of events[event.type] || []) fn(event);}};
  const f = {calls, window, document, find, timers, receipt: saved(),
    handler: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.endsWith('/connect')) return {protocol: PROTOCOL, connection: connection()};
      if (url.endsWith('/inventory')) return inventory();
      if (url.endsWith('/status')) return {protocol: PROTOCOL, connections: [connection()], receipts: [f.receipt]};
      if (url.endsWith('/review')) return reviewResponse(body);
      if (url.endsWith('/execute')) return {protocol: PROTOCOL, receipt: f.receipt};
      if (url.endsWith('/disconnect')) return {protocol: PROTOCOL, disconnected: true};
      if (url.endsWith('/activity')) return {protocol: PROTOCOL, client: body.client, items: [{time: 1792152000, domain: '<img src=x onerror=alert(1)>', type: 'A', status: 'blocked'}], from: 1792151100, until: 1792152000, checked_at: NOW};
      assert.fail('Unexpected endpoint ' + url);
    }
  };
  const context = vm.createContext({window, document, console, Date, URL, AbortController, TextDecoder, TextEncoder,
    CustomEvent: class {constructor(type, props) {this.type = type; this.detail = props?.detail;}},
    setTimeout(fn, delay) {const id = ++timerId; timers.set(id, {fn, delay}); return id;}, clearTimeout: id => timers.delete(id),
    localStorage: {getItem() {assert.fail('No browser storage');}, setItem() {assert.fail('No browser storage');}},
    sessionStorage: {getItem() {assert.fail('No browser storage');}, setItem() {assert.fail('No browser storage');}},
    fetch: async (url, options) => {calls.push({url, options, body: options.body ? JSON.parse(options.body) : null}); const result = await f.handler(url, options); return {ok: !result._status || result._status < 400, status: result._status || 200, body: null, text: result._text || (async () => JSON.stringify(result))};}
  });
  vm.runInContext(code, context);
  f.emit = async (name, detail) => {await Promise.all([...(events[name] || []), ...(documentEvents[name] || [])].map(fn => fn({detail})));};
  const collect = el => [el.textContent, ...el.children.flatMap(collect)];
  f.text = id => collect(find(id)).join(' ');
  f.buttons = id => {const walk = el => [...(el.tagName === 'BUTTON' ? [el] : []), ...el.children.flatMap(walk)]; return walk(find(id));};
  f.click = async id => {const el = find(id); if (!el.disabled) await el.fire();};
  f.credentials = () => {find('pihole-origin').value = connection().origin; find('pihole-password').value = 'sensitive-password'; find('pihole-pin').value = 'a'.repeat(64);};
  f.connect = async () => {f.credentials(); await find('pihole-form').fire('submit');};
  f.select = async (value = '192.168.1.24') => {find('pihole-client').value = value; await find('pihole-client').fire('change');};
  f.ready = async () => {await f.connect(); await f.click('pihole-inventory-read'); await f.select();};
  f.inputs = () => find('pihole-groups').children.map(label => label.children[0]);
  f.confirm = async () => {find('pihole-confirm').checked = true; await find('pihole-confirm').fire('change');};
  return f;
}

test('mount and panel navigation make no request; all forms use mounted references', async () => {
  const f = fixture(); await f.emit('tli-panel-switched', {panelId: 'panel-homelab'});
  assert.equal(f.calls.length, 0); assert.equal(f.find('pihole-origin').required, true); assert.equal(f.find('pihole-password').type, 'password');
  assert.equal(f.find('pihole-apply').disabled, true); assert.equal(f.find('pihole-inventory-read').disabled, true);
  assert.match(f.text('pihole-workspace'), /PIN set and be unlocked/); assert.match(f.text('pihole-workspace'), /no timer/);
});

test('explicit connection clears password immediately and prevents duplicate requests', async () => {
  const f = fixture(); let finish; f.handler = () => new Promise(resolve => finish = resolve); f.credentials();
  const pending = f.find('pihole-form').fire('submit'); assert.equal(f.find('pihole-password').value, ''); await f.find('pihole-form').fire('submit');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body, {origin: connection().origin, password: 'sensitive-password', certificate_sha256: 'a'.repeat(64)});
  finish({protocol: PROTOCOL, connection: connection()}); await pending;
  assert.equal(f.find('pihole-inventory-read').disabled, false); assert.equal(f.calls[0].options.credentials, 'same-origin'); assert.equal(f.calls[0].options.cache, 'no-store');
});

test('invalid destinations clear entered passwords without a request', async () => {
  for (const bad of ['http://192.168.1.2', 'https://pihole.local', 'https://password@192.168.1.2', 'https://192.168.1.2/api', 'https://192.168.1.2?secret=yes']) {
    const f = fixture(); f.credentials(); f.find('pihole-origin').value = bad; await f.find('pihole-form').fire('submit');
    assert.equal(f.calls.length, 0); assert.equal(f.find('pihole-password').value, '');
  }
});

test('PIN-off backend rejection explains the prerequisite and never proceeds', async () => {
  const f = fixture(); f.handler = async () => ({_status: 409, detail: 'Set and unlock the TLI PIN before connecting Pi-hole.'}); await f.connect();
  assert.match(f.text('pihole-status'), /Set and unlock the TLI PIN/); assert.equal(f.find('pihole-inventory-read').disabled, true); assert.equal(f.calls.length, 1);
});

test('inventory selectors and text rendering preserve read-only MAC and subnet records', async () => {
  const f = fixture(); await f.ready(); assert.equal(f.find('pihole-pause-review').disabled, false);
  await f.select('aa:bb:cc:dd:ee:ff'); assert.equal(f.find('pihole-pause-review').disabled, true); assert.equal(f.find('pihole-activity-read').disabled, true);
  assert.match(f.text('pihole-selected'), /read only/); await f.select('192.168.1.0/24'); await f.window.TLIPiHole.review('pause');
  assert.equal(f.calls.length, 2); assert.equal(f.find('pihole-groups-review').disabled, true);
});

test('a server editable flag cannot authorize a nonliteral selector in the UI', async () => {
  const f = fixture(), original = f.handler; f.handler = async (url, opts) => {const value = await original(url, opts); if (value.clients) value.clients[2].editable = true; return value;};
  await f.ready(); await f.select('aa:bb:cc:dd:ee:ff'); assert.equal(f.find('pihole-pause-review').disabled, true);
});

test('pause review shows exact before and after, stays unapplied without explicit confirmation', async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-pause-review');
  assert.deepEqual(f.calls[2].body, {connection_id: 'session-1', client: '192.168.1.24', action: 'pause', groups: [], receipt_id: null});
  assert.match(f.text('pihole-review'), /https:\/\/192.168.1.2/); assert.match(f.text('pihole-review'), /192.168.1.24/);
  assert.match(f.text('pihole-review'), /Default \(#0\)/); assert.match(f.text('pihole-review'), /No groups/); assert.match(f.text('pihole-review'), /even if TLI closes/);
  assert.equal(f.find('pihole-apply').disabled, true); await f.window.TLIPiHole.execute(); assert.equal(f.calls.length, 3);
  await f.confirm(); await f.click('pihole-apply');
  assert.deepEqual(f.calls[3].body, {connection_id: 'session-1', review_id: 'review-1', reviewed: true});
  assert.match(f.text('pihole-receipts'), /Group membership verified/); assert.equal(f.find('pihole-apply').disabled, true);
  assert.equal(f.find('pihole-pause-review').disabled, true); assert.match(f.text('pihole-status'), /Read devices again/);
});

test('group assignment submits explicit nonempty existing groups and invalidates on checkbox edits', async () => {
  const f = fixture(); await f.ready(); const inputs = f.inputs(); inputs[0].checked = false; inputs[1].checked = true; await inputs[1].fire('change');
  await f.click('pihole-groups-review'); assert.deepEqual(f.calls[2].body.groups, [1]); await f.confirm();
  inputs[2].checked = true; await inputs[2].fire('change'); assert.equal(f.find('pihole-apply').disabled, true); assert.equal(f.text('pihole-review'), '');
  for (const input of inputs) input.checked = false; await inputs[0].fire('change'); await f.window.TLIPiHole.review('groups'); assert.equal(f.calls.length, 3);
});

test('selected client and filter changes clear prior review and DNS activity', async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-activity-read'); await f.click('pihole-pause-review'); await f.confirm();
  await f.select('192.168.1.25'); assert.equal(f.text('pihole-review'), ''); assert.doesNotMatch(f.text('pihole-activity'), /<img/); assert.equal(f.find('pihole-apply').disabled, true);
  await f.click('pihole-pause-review'); assert.equal(f.calls.at(-1).body.client, '192.168.1.25');
  f.find('pihole-search').value = 'Media'; await f.find('pihole-search').fire('input');
  assert.equal(f.find('pihole-client').value, ''); assert.equal(f.text('pihole-review'), ''); assert.equal(f.find('pihole-apply').disabled, true);
});

test('changing the visible form address discards an existing review', async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-pause-review'); await f.confirm();
  f.find('pihole-origin').value = 'https://192.168.1.3'; await f.find('pihole-origin').fire('input');
  assert.equal(f.text('pihole-review'), ''); assert.equal(f.find('pihole-apply').disabled, true);
});

test('pending review cannot revive after checkbox changes', async () => {
  const f = fixture(); await f.ready(); let finish; f.handler = (url, options) => new Promise(resolve => finish = () => resolve(reviewResponse(JSON.parse(options.body))));
  const pending = f.click('pihole-pause-review'); f.inputs()[1].checked = true; await f.inputs()[1].fire('change'); finish(); await pending;
  assert.equal(f.text('pihole-review'), ''); assert.equal(f.find('pihole-apply').disabled, true);
});

test('exact review mismatch is rejected instead of applying a different target', async () => {
  for (const change of [value => value.target.client = '192.168.1.99', value => value.target.origin = 'https://192.168.1.3', value => value.before_groups = [2], value => value.after_groups = [1], value => value.action = 'groups']) {
    const f = fixture(); await f.ready(); f.handler = async (url, options) => {const value = reviewResponse(JSON.parse(options.body)); change(value); return value;};
    await f.click('pihole-pause-review'); assert.equal(f.text('pihole-review'), ''); assert.match(f.text('pihole-status'), /not confirmed/); assert.equal(f.find('pihole-apply').disabled, true);
  }
});

test('DNS request snapshot is explicit, bounded, and not represented as page visits', async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-activity-read');
  assert.deepEqual(f.calls[2].body, {connection_id: 'session-1', client: '192.168.1.24'}); assert.match(f.text('pihole-activity'), /<img src=x onerror=alert\(1\)>/);
  assert.match(f.text('pihole-workspace'), /not page visits/); assert.equal(f.calls.length, 3);
  f.handler = async () => ({protocol: PROTOCOL, client: '192.168.1.24', items: [], from: 1000, until: 1900, checked_at: NOW}); await f.click('pihole-activity-read');
  assert.match(f.text('pihole-activity'), /does not prove the device was inactive/);
});

test('malformed activity never populates a successful snapshot', async () => {
  const f = fixture(); await f.ready(); f.handler = async () => ({protocol: PROTOCOL, client: '192.168.1.99', items: [], checked_at: NOW});
  await f.click('pihole-activity-read'); assert.match(f.text('pihole-status'), /not confirmed/); assert.doesNotMatch(f.text('pihole-activity'), /No DNS requests/);
});

test('nullable DNS status remains unknown instead of rejecting legitimate activity', async () => {
  const f = fixture(); await f.ready(); f.handler = async () => ({protocol: PROTOCOL, client: '192.168.1.24',
    items: [{time: 1792152000, domain: 'example.test', type: 'A', status: null}], from: 1792151100, until: 1792152000, checked_at: NOW});
  await f.click('pihole-activity-read'); assert.match(f.text('pihole-activity'), /example.test/); assert.match(f.text('pihole-activity'), /Not reported/);
});

test('status restores saved changes without implicitly reading devices or submitting mutations', async () => {
  const f = fixture(); await f.click('pihole-check'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, 'GET');
  assert.match(f.text('pihole-receipts'), /192.168.1.24/); const restore = f.buttons('pihole-receipts')[0]; assert.equal(restore.disabled, true);
  await f.click('pihole-inventory-read'); await f.select(); const currentRestore = f.buttons('pihole-receipts')[0]; assert.equal(currentRestore.disabled, false); await currentRestore.fire();
  assert.equal(f.calls.at(-1).url, '/api/homelab/pihole/review'); assert.deepEqual(f.calls.at(-1).body, {connection_id: 'session-1', client: '192.168.1.24', action: 'restore', groups: [], receipt_id: 'receipt-1'});
  assert.equal(f.find('pihole-apply').disabled, true); assert.match(f.text('pihole-review'), /restore previous groups/);
});

test('prepared receipt is displayed as unverified and remains available on a failed read', async () => {
  const f = fixture(); f.receipt.outcome = {outcome: 'prepared', attempted: false, acknowledged: false, membership_verified: false, summary: 'Outcome not yet recorded; check saved state before another change.', checked_at: NOW};
  await f.click('pihole-check'); assert.match(f.text('pihole-receipts'), /Outcome: prepared/); assert.match(f.text('pihole-receipts'), /Group membership not verified/);
  const previous = f.text('pihole-receipts'); f.handler = async () => ({_status: 502, detail: 'Connection read failed.'}); await f.click('pihole-check');
  assert.equal(f.text('pihole-receipts'), previous); assert.match(f.text('pihole-status'), /Earlier saved changes remain/); assert.equal(f.calls.length, 2);
});

test('an unconfirmed execute cannot be replayed and requires explicit receipt recovery', async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-pause-review'); await f.confirm();
  const original = f.handler; f.handler = async () => ({_status: 502, detail: 'Upstream response was lost.'}); await f.click('pihole-apply');
  assert.match(f.text('pihole-status'), /change is unconfirmed/); assert.equal(f.find('pihole-apply').disabled, true); await f.window.TLIPiHole.execute(); assert.equal(f.calls.length, 4);
  f.handler = original; await f.click('pihole-inventory-read'); await f.select(); assert.equal(f.find('pihole-pause-review').disabled, true);
  await f.click('pihole-check'); assert.equal(f.find('pihole-pause-review').disabled, false); assert.match(f.text('pihole-receipts'), /192.168.1.24/);
});

test('malformed execution receipt never becomes successful and invalidates the consumed review', async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-pause-review'); await f.confirm(); f.handler = async () => ({protocol: PROTOCOL, receipt: {...saved(), client: '192.168.1.99'}});
  await f.click('pihole-apply'); assert.match(f.text('pihole-status'), /change is unconfirmed/); assert.equal(f.text('pihole-review'), ''); assert.equal(f.find('pihole-apply').disabled, true);
});

for (const boundary of ['tli-session-locked', 'tli-user-changed', 'tli-account-changed', 'pagehide']) test(`${boundary} clears all private data and discards pending response`, async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-check'); f.credentials(); let finish;
  f.handler = () => new Promise(resolve => finish = resolve); const pending = f.click('pihole-activity-read'); await f.emit(boundary);
  finish({protocol: PROTOCOL, client: '192.168.1.24', items: [], from: 1000, until: 1900, checked_at: NOW}); await pending;
  assert.doesNotMatch(f.text('pihole-workspace'), /Media server|https:\/\/192.168.1.2|192.168.1.24/);
  assert.equal(f.find('pihole-password').value, ''); assert.equal(f.find('pihole-origin').value, ''); assert.equal(f.find('pihole-pin').value, ''); assert.equal(f.find('pihole-apply').disabled, true);
});

for (const status of [401, 403]) test(`${status} clears private receipts and never reveals response body`, async () => {
  const f = fixture(); await f.click('pihole-check'); f.handler = async () => ({_status: status, detail: 'private secret response'}); await f.click('pihole-check');
  assert.equal(f.find('pihole-check').disabled, true); assert.equal(f.find('pihole-unlock').hidden, false); assert.doesNotMatch(f.text('pihole-workspace'), /private secret response|192.168.1.24/);
});

test('late body cannot cross lock and unlock, and old finally cannot release a new operation', async () => {
  const f = fixture(); let finishOld, bodyStarted, finishNew; const started = new Promise(resolve => bodyStarted = resolve);
  f.handler = async () => ({_text: () => {bodyStarted(); return new Promise(resolve => finishOld = resolve);}});
  const old = f.click('pihole-check'); await started; await f.emit('tli-session-locked'); await f.emit('tli-session-unlocked');
  f.handler = () => new Promise(resolve => finishNew = resolve); const fresh = f.click('pihole-check');
  finishOld(JSON.stringify({protocol: PROTOCOL, connections: [connection()], receipts: [saved()]})); await old;
  assert.equal(f.find('pihole-check').disabled, true); assert.doesNotMatch(f.text('pihole-receipts'), /192.168.1.24/);
  finishNew({protocol: PROTOCOL, connections: [], receipts: []}); await fresh; assert.equal(f.find('pihole-check').disabled, false); assert.equal(f.calls.length, 2);
});

test('leaving the panel aborts pending review, clears credentials, and never retries on return', async () => {
  const f = fixture(); await f.ready(); f.credentials(); let finish; f.handler = (url, options) => new Promise(resolve => finish = () => resolve(reviewResponse(JSON.parse(options.body))));
  const pending = f.click('pihole-pause-review'); await f.emit('tli-panel-switched', {panelId: 'panel-main'}); finish(); await pending;
  await f.emit('tli-panel-switched', {panelId: 'panel-homelab'}); assert.equal(f.text('pihole-review'), ''); assert.equal(f.find('pihole-password').value, ''); assert.equal(f.calls.length, 3);
});

test('detached restore buttons cannot act in a later session', async () => {
  const f = fixture(); await f.click('pihole-check'); await f.click('pihole-inventory-read'); await f.select(); const old = f.buttons('pihole-receipts')[0];
  await f.emit('tli-session-locked'); await f.emit('tli-session-unlocked'); await f.click('pihole-check'); await f.click('pihole-inventory-read'); await f.select();
  const count = f.calls.length; await old.fire(); assert.equal(f.calls.length, count); assert.equal(f.text('pihole-review'), '');
});

test('review and connection expiration timers only invalidate, never perform network work', async () => {
  const f = fixture(); await f.ready(); await f.click('pihole-pause-review'); await f.confirm();
  const timers = [...f.timers.values()]; assert.equal(timers.length, 2); timers[1].fn(); assert.equal(f.find('pihole-apply').disabled, true); assert.equal(f.calls.length, 3);
  timers[0].fn(); assert.equal(f.find('pihole-activity-read').disabled, true); assert.equal(f.calls.length, 3); assert.match(f.text('pihole-status'), /expired/);
});

test('disconnect cannot silently restore an existing pause', async () => {
  const f = fixture(); await f.click('pihole-check'); await f.click('pihole-disconnect');
  assert.deepEqual(f.calls[1].body, {connection_id: 'session-1'}); assert.match(f.text('pihole-status'), /does not restore/); assert.match(f.text('pihole-receipts'), /192.168.1.24/);
  assert.equal(f.find('pihole-inventory-read').disabled, true); assert.equal(f.calls.length, 2);
});

test('malformed inventory and protocol never populate actionable controls', async () => {
  for (const transform of [value => value.protocol = 'unknown', value => value.clients[0].groups = 'all', value => value.groups.push(value.groups[0]), value => value.clients.push(value.clients[0])]) {
    const f = fixture(); await f.connect(); f.handler = async () => {const value = inventory(); transform(value); return value;}; await f.click('pihole-inventory-read');
    assert.equal(f.find('pihole-client').disabled, true); assert.equal(f.find('pihole-pause-review').disabled, true); assert.doesNotMatch(f.text('pihole-client'), /Media server/);
  }
});

test('literal client eligibility excludes aliases, networks, malformed IPs and DNS names', () => {
  for (const value of ['192.168.1.24', 'fd00::1234', '::ffff:192.168.1.24']) assert.equal(helpers.literalIP(value), true);
  for (const value of ['device.local', '192.168.1.0/24', 'aa:bb:cc:dd:ee:ff', '192.168.01.2', '999.1.1.1', 'fe80::1%4', '[fd00::1]']) assert.equal(helpers.literalIP(value), false);
  assert.equal(helpers.same([0, 1], [1, 0]), true); assert.equal(helpers.same([0, 0], [0, 0]), false);
});
