const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mesh = fs.readFileSync(path.join(__dirname, '../js/mesh.js'), 'utf8');
const source = mesh.slice(mesh.indexOf('window.TLIPeerTrust=(()=>{'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const hostCapabilities = ['system_observation_v1', 'coordination_v1', 'messages_v1'];
const card = (capabilities = ['inference_v1'], values = {}) => ({
  protocol: 'tli-peer-trust-v1', node_id: 'synthetic-node', name: 'GPU computer', origin: 'https://192.168.1.42:8443',
  public_key: 'synthetic-key', identity_fingerprint: 'synthetic-fingerprint', certificate_der: 'synthetic-certificate',
  certificate_sha256: 'a'.repeat(64), issued_at: 1, signature: 'synthetic-signature', capabilities, ...values,
});

function fixture() {
  const ids = {}, events = {}, calls = [], created = [];
  const document = { hidden: false, activeElement: null };
  const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
  function node(tag) {
    const el = { tag, children: [], handlers: {}, attrs: {}, style: {}, textContent: '', value: '', checked: false, disabled: false, open: false,
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      fire(name, event = { preventDefault() {} }) { for (const fn of this.handlers[name] || []) fn(event); },
      async click() { if (!this.disabled) this.fire('click'); await tick(); },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() { document.activeElement = this; },
      querySelector(selector) { return walk(this).find(child => child.tag === selector); },
    };
    Object.defineProperty(el, 'id', { get() { return Object.keys(ids).find(key => ids[key] === el); }, set(value) { ids[value] = el; } });
    created.push(el); return el;
  }
  document.body = node('body'); document.createElement = node; document.getElementById = id => ids[id];
  const emit = name => { for (const fn of events[name] || []) fn({ type: name }); };
  const window = { addEventListener: (name, fn) => (events[name] ||= []).push(fn), dispatchEvent: event => emit(event.type),
    TLIRelease: { async requireCapability() {} } };
  let respond = async call => ({ card: call.body.card, grants: call.body.grants, review_id: 'review-synthetic' });
  const context = vm.createContext({ window, document, meshUiLocked: false, meshUiEpoch: 0, meshDirectoryCache: null,
    CustomEvent: class { constructor(type) { this.type = type; } }, refreshMeshNodeAndMaybeDirectory: async () => {},
    fetch: async (url, options) => { const call = { url, body: JSON.parse(options.body) }; calls.push(call); const data = await respond(call);
      return { ok: !data.status || data.status < 400, status: data.status || 200, json: async () => data }; },
  });
  vm.runInContext(source, context); window.TLIPeerTrust.open();
  const find = (tag, text) => walk(document.body).find(el => el.tag === tag && el.textContent === text);
  const input = () => walk(document.body).find(el => el.tag === 'label' && el.children[0]?.textContent === 'Paste the other computer’s public card')?.children[1];
  return { ids, calls, created, document, window, context, emit, input,
    respond: fn => { respond = fn; }, button: text => find('button', text),
    checks: () => walk(document.body).filter(el => el.tag === 'input' && el.type === 'checkbox'),
    text: () => walk(document.body).map(el => el.textContent).join('\n'),
    paste(value) { const el = input(); el.value = typeof value === 'string' ? value : JSON.stringify(value); el.fire('input'); },
    check(value) { this.checks().find(el => el.value === value).checked = true; },
    async review(value = card(), grants = ['inference']) { this.paste(value); for (const grant of grants) this.check(grant); await this.button('Review selected permissions').click(); },
  };
}

test('opening and pasting a Node card never probes and offers only unchecked inference', () => {
  const f = fixture(); assert(f.checks().every(el => el.disabled && !el.checked));
  f.paste(card());
  assert.deepEqual(f.checks().map(el => [el.value, el.disabled, el.checked]), [
    ['observe', true, false], ['coordinate', true, false], ['messages', true, false], ['inference', false, false],
  ]);
  assert.match(f.text(), /AI compute only/); assert.equal(f.calls.length, 0);
});

test('changing profiles or a card identity clears every previously selected permission', () => {
  const f = fixture(); f.paste(card(hostCapabilities)); f.check('messages'); f.check('inference');
  assert(f.checks().every(el => !el.disabled));
  f.paste(card()); assert(f.checks().every(el => !el.checked));
  f.check('inference'); f.paste(card(hostCapabilities)); assert(f.checks().every(el => !el.disabled && !el.checked));
  f.check('observe'); f.paste(card(hostCapabilities, { node_id: 'other-node' })); assert(f.checks().every(el => !el.checked));
  assert.equal(f.calls.length, 0);
});

test('unknown and malformed capability profiles disable authority without network requests', async () => {
  const f = fixture();
  for (const value of ['{', 'null', '[]', card([]), card('inference_v1'), card(['inference_v1', 'messages_v1']), card([...hostCapabilities].reverse())]) {
    f.paste(card()); f.check('inference'); f.paste(value);
    assert(f.checks().every(el => !el.checked && el.disabled));
    await f.button('Review selected permissions').click(); assert.equal(f.calls.length, 0);
    assert.equal(f.button('Trust these exact details'), undefined);
  }
});

test('Node review sends only selected inference and renders untrusted names as text', async () => {
  const f = fixture(), value = card(['inference_v1'], { name: '<img src=x onerror=alert(1)>' });
  f.paste(value); for (const input of f.checks()) input.checked = true;
  await f.button('Review selected permissions').click();
  assert.deepEqual(f.calls, [{ url: '/mesh/trust/preview', body: { card: value, grants: ['inference'] } }]);
  assert.match(f.text(), /<img src=x onerror=alert\(1\)>/); assert(!f.created.some(el => ['img', 'script'].includes(el.tag)));
  assert.match(f.text(), /AI compute only/); assert.match(f.text(), /Complete pairing on the Node/);
  assert.doesNotMatch(f.text(), /File offers require|Allow short CPU|coordination\/ping/);
});

test('an unchecked Node inference permission cannot initiate a trust review', async () => {
  const f = fixture(); f.paste(card()); await f.button('Review selected permissions').click();
  assert.equal(f.calls.length, 0); assert.match(f.text(), /Select at least one permission/);
});

test('backend signature validation remains authoritative for locally recognized profiles', async () => {
  const f = fixture(); f.respond(async () => ({ status: 422, detail: { message: 'Invalid signed public card.' } }));
  await f.review({ capabilities: ['inference_v1'] });
  assert.equal(f.calls.length, 1); assert.match(f.text(), /Invalid signed public card/);
  assert.equal(f.button('Trust these exact details'), undefined);
});

test('full-host review preserves file consent wording and returning to input clears grants', async () => {
  const f = fixture(); await f.review(card(hostCapabilities), ['messages']);
  assert.match(f.text(), /File offers require a separate receiver review/);
  await f.button('Back to card').click(); assert(f.checks().every(el => !el.checked && el.disabled));
  assert.equal(f.input().value, '');
});

test('editing a card during capability verification cannot dispatch the older review', async () => {
  const f = fixture(); let release;
  f.window.TLIRelease.requireCapability = () => new Promise(resolve => { release = resolve; });
  await f.review(); f.paste(card(hostCapabilities)); release(); await tick();
  assert.equal(f.calls.length, 0); assert.match(f.text(), /card changed/); assert(f.checks().every(el => !el.checked));
});

test('a late review after a card edit cannot become an approval', async () => {
  const f = fixture(); let release; f.respond(call => new Promise(resolve => { release = () => resolve({ card: call.body.card, grants: call.body.grants, review_id: 'old-review' }); }));
  await f.review(); f.paste(card(hostCapabilities)); release(); await tick();
  assert.equal(f.button('Trust these exact details'), undefined); assert.match(f.text(), /card changed/);
  assert(f.checks().every(el => !el.checked));
});

for (const event of ['tli-session-locked', 'pagehide']) test(event + ' rejects a late Node trust response', async () => {
  const f = fixture(); let release; f.respond(call => new Promise(resolve => { release = () => resolve({ card: call.body.card, grants: call.body.grants, review_id: 'old-review' }); }));
  await f.review(); f.emit(event); release(); await tick();
  assert.equal(f.ids['tli-peer-trust-dialog'].open, false); assert.equal(f.button('Trust these exact details'), undefined);
  assert.equal(f.calls.filter(call => call.url === '/mesh/trust/approve').length, 0);
});

function directoryRow(values = {}) {
  return { device_id: 'synthetic-node', display_name: 'GPU Node', ip: '192.168.1.42', origin: 'https://192.168.1.42:8443',
    status: 'allowed', trust_state: 'verified', peer_profile: 'inference_node', last_seen: '2000-01-01T00:00:00Z', ...values };
}
function renderDirectory(rows) {
  const elements = {};
  const context = vm.createContext({ window: {}, currentNodeConfig: { role: 'host' }, console,
    $: id => elements[id] ||= { style: {}, textContent: '', innerHTML: '' },
    fetch() { throw Error('Directory rendering must not probe peers.'); },
  });
  vm.runInContext(mesh.slice(mesh.indexOf('const meshEscape ='), mesh.indexOf('const meshUiCurrent =')) +
    mesh.slice(mesh.indexOf('function renderMeshDirectory('), mesh.indexOf('async function refreshMeshDirectory(')), context);
  context.renderMeshDirectory({ devices: rows }); return elements['mesh-directory-list'].innerHTML;
}

test('Node directory rows report on-demand availability without full-host actions or invented offline status', () => {
  const html = renderDirectory([directoryRow({ display_name: '<img src=x>' })]);
  assert.match(html, /Compute only/); assert.match(html, /Checked when you check models in Ask TLI/);
  assert.doesNotMatch(html, /Offline|Online|Trust review required|data-mesh-(info|ping|maint|open)=/);
  assert.match(html, /Revoke trust/); assert.match(html, /&lt;img src=x&gt;/); assert.doesNotMatch(html, /<img src=x>/);
});

test('full-host directory controls and revoked Node status remain visible', () => {
  const host = renderDirectory([directoryRow({ peer_profile: undefined, last_seen: new Date().toISOString() })]);
  for (const action of ['info', 'ping', 'maint', 'open']) assert.match(host, new RegExp('data-mesh-' + action + '='));
  assert.match(host, /Online/); assert.doesNotMatch(host, /Compute only/);
  const revoked = renderDirectory([directoryRow({ status: 'blocked' })]);
  assert.match(revoked, /Blocked/); assert.match(revoked, /Review trust/);
  assert.doesNotMatch(revoked, /data-mesh-(info|ping|maint|open)=/);
});

test('console deep links reject inference Nodes even if invoked outside directory controls', () => {
  const opened = [], notices = [];
  const context = vm.createContext({ meshUiLocked: false, meshDirectoryCache: { devices: [directoryRow()] }, URL,
    window: { open: (...args) => opened.push(args) }, showToast: text => notices.push(text) });
  vm.runInContext(mesh.slice(mesh.indexOf('function openReviewedPeerConsole('), mesh.indexOf('window.TLIPeerTrust=')), context);
  assert.equal(context.openReviewedPeerConsole('synthetic-node', 'tools'), false);
  assert.equal(opened.length, 0); assert.match(notices[0], /AI compute only/);
  context.meshDirectoryCache.devices[0].peer_profile = undefined;
  assert.equal(context.openReviewedPeerConsole('synthetic-node', 'tools'), true);
  assert.deepEqual(opened[0], ['https://192.168.1.42:8443/?panel=tools', '_blank', 'noopener,noreferrer']);
});

for (const action of ['ping', 'refresh']) test('bulk ' + action + ' excludes inference-only Nodes', async () => {
  const calls = []; let click, pending;
  const context = vm.createContext({ console, multiRunBtn: { addEventListener: (_event, fn) => { click = fn; } },
    multiSelect: { value: action }, multiStatus: {}, meshDirectoryCache: { devices: [directoryRow(), directoryRow({ device_id: 'full-host', peer_profile: undefined })] },
    showToast() {}, withButtonBusy: (_button, _label, fn) => { pending = fn(); },
    performMeshPing: async id => { calls.push(id); }, performMeshMaintenanceRefresh: async id => { calls.push(id); },
  });
  vm.runInContext(mesh.slice(mesh.indexOf('if (multiRunBtn && multiSelect)'), mesh.indexOf('  // Host directory button actions')), context);
  click(); await pending; assert.deepEqual(calls, ['full-host']);
});
