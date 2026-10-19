const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ok: status < 400, status, json: async () => data});
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; };

function fixture() {
  const nodes = {}, events = {}, calls = [], timers = [], toasts = [], stored = new Map();
  function node(tag = 'div') {
    const classes = new Set();
    const n = {tag, children: [], handlers: {}, attrs: {}, style: {}, value: '', disabled: false,
      classList: {add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
        toggle(x, on = !classes.has(x)) { if (on) classes.add(x); else classes.delete(x); }},
      setAttribute(key, value) { this.attrs[key] = String(value); }, getAttribute(key) { return this.attrs[key] ?? null; },
      removeAttribute(key) { delete this.attrs[key]; },
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      async fire(name, event = {target: this, stopPropagation() {}}) { for (const fn of this.handlers[name] || []) await fn(event); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      appendChild(child) { this.children.push(child); return child; }, replaceChildren(...children) { this.textContent = ''; this.children = children; },
      focus() {}, querySelector() { return null; }, querySelectorAll(selector) {
        if (selector !== '.mm2-saveto-option') return [];
        if (!this.options) this.options = [...this.innerHTML.matchAll(/data-saveto-path="([^"]*)"/g)].map(match => {
          const b = node('button'); b.attrs['data-saveto-path'] = match[1]; return b;
        });
        return this.options;
      }};
    Object.defineProperty(n, 'innerHTML', {get() { return this.html || ''; }, set(value) { this.html = value; this.text = ''; this.children = []; this.options = null; }});
    Object.defineProperty(n, 'textContent', {get() { return this.text || ''; }, set(value) { this.text = value; this.html = ''; this.children = []; this.options = null; }});
    return n;
  }
  let handler = async () => { throw Error('Unexpected request'); }, retries = 0;
  const document = {readyState: 'complete', hidden: false, getElementById: id => nodes[id] || null, createElement: node,
    createDocumentFragment: () => node('fragment'), querySelectorAll: () => [], addEventListener() {}};
  const window = {addEventListener: (name, fn) => (events[name] ||= []).push(fn),
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); },
    EventInterpreter: {retry() { retries++; }}};
  const ctx = vm.createContext({window, document, console: {error() {}, warn() {}}, URL, AbortSignal, Date,
    performance: {now: () => 1}, CustomEvent: class {constructor(type, options = {}) { this.type = type; this.detail = options.detail; }},
    location: {origin: 'https://tli.test'}, localStorage: {getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value)},
    readSettings: () => ({searchEnabled: true, searxUrl: 'http://localhost:8080'}), writeSettings() {},
    showToast: text => toasts.push(text), debugLog() {}, $: id => nodes[id],
    getUsbStorageInfo: d => ({isMassStorage: !!d.is_storage, mountPath: d.mount_path}),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    fetch: async (url, options = {}) => { calls.push([url, options]); return handler(url, options); }});
  return {nodes, window, ctx, calls, stored, timers, toasts, node, document,
    add(...ids) { for (const id of ids) nodes[id] = node(); },
    respond(fn) { handler = fn; }, emit(type) { window.dispatchEvent({type}); },
    get retries() { return retries; }, load(file) { vm.runInContext(source(file), ctx); },
    recover() { this.emit('tli-session-unlocked'); this.emit('tli-private-observation-ready'); }};
}

function searchFixture() {
  const f = fixture();
  f.add('search-suggest-banner', 'search-suggest-sub', 'search-suggest-run', 'search-suggest-offline',
    'search-suggest-dismiss', 'chat-input', 'chat-send-btn', 'settings-search-receipts', 'settings-search-export');
  f.load('tli-search.js');
  f.nodes['chat-input'].value = 'latest telescope news';
  let sends = 0; f.nodes['chat-send-btn'].addEventListener('click', () => sends++);
  f.prepare = text => f.window.tliShowSearchBannerFor(text || f.nodes['chat-input'].value);
  f.run = () => f.nodes['search-suggest-run'].click();
  Object.defineProperty(f, 'sends', {get: () => sends});
  return f;
}

test('search is explicit and a successful current response sends one augmented answer and receipt', async () => {
  const f = searchFixture(); f.prepare(); assert.equal(f.calls.length, 0);
  const pending = deferred(); f.respond(() => pending.promise);
  const run = f.run(); await f.run(); assert.equal(f.calls.length, 1);
  pending.resolve(response({results: [{title: 'Observatory', url: 'https://example.test', snippet: 'New result'}], ms: 8}));
  await run; assert.equal(f.sends, 1); assert.match(f.window.__tliInjectedUserMessage, /latest telescope news.*\n[\s\S]*New result/);
  assert.equal(f.window.__tliSearchGateBypassOnce, true);
  assert.equal(JSON.parse(f.stored.get('tli_search_receipts_v1')).length, 1);
  const url = new URL(f.calls[0][0]); assert.equal(url.pathname, '/search/query'); assert.equal(url.searchParams.get('endpoint'), 'http://localhost:8080');
});

for (const status of [401, 403]) test(`search ${status} clears private state and cannot send, save, or retry on unlock`, async () => {
  const f = searchFixture(); f.stored.set('tli_search_receipts_v1', JSON.stringify([{query: 'old private query'}]));
  f.prepare(); f.respond(async () => response({detail: 'Unlock this browser.'}, status)); await f.run();
  assert.equal(f.sends, 0); assert.equal(f.window.__tliSearchGateBypassOnce, false);
  assert.equal(f.window.__tliInjectedUserMessage, undefined); assert.doesNotMatch(f.nodes['settings-search-receipts'].innerHTML, /old private query/);
  assert.equal(JSON.parse(f.stored.get('tli_search_receipts_v1')).length, 1, 'stored receipts are preserved');
  f.emit('tli-session-unlocked'); f.prepare(); await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.retries, 1);
  f.emit('tli-private-observation-ready'); assert.equal(f.calls.length, 1); assert.equal(f.sends, 0);
});

for (const status of [200, 401, 403]) test(`old search ${status} after verified unlock cannot inject or relock`, async () => {
  const f = searchFixture(), pending = deferred(); f.prepare(); f.respond(() => pending.promise); const run = f.run();
  f.emit('tli-session-locked'); f.recover(); f.prepare('new question');
  pending.resolve(response({results: [{title: 'old result', url: 'https://old.test'}]}, status)); await run;
  assert.equal(f.sends, 0); assert.equal(f.stored.size, 0); assert.equal(f.window.__tliInjectedUserMessage, undefined);
  f.respond(async () => response({results: []})); await f.run(); assert.equal(f.sends, 1);
});

for (const kind of ['network', 'malformed', '503']) test(`search ${kind} failure needs an explicit offline choice`, async () => {
  const f = searchFixture(); f.prepare(); f.respond(async () => {
    if (kind === 'network') throw Error('Disconnected');
    return response(kind === 'malformed' ? {} : {detail: 'Search provider unavailable'}, kind === '503' ? 503 : 200);
  });
  await f.run(); assert.equal(f.sends, 0); assert.equal(f.calls.length, 1); assert.match(f.nodes['search-suggest-sub'].textContent, /Choose Answer Offline/);
  await f.nodes['search-suggest-offline'].click(); assert.equal(f.sends, 1); assert.equal(f.calls.length, 1);
});

test('a replaced search question ignores the previous response and stored result links cannot execute code', async () => {
  const f = searchFixture(), pending = deferred(); f.prepare(); f.respond(() => pending.promise); const run = f.run();
  f.prepare('new topic'); pending.resolve(response({results: []})); await run; assert.equal(f.sends, 0);
  f.respond(async () => response({results: [{title: '<img src=x>', url: 'javascript:alert(1)'}]})); await f.run();
  assert.doesNotMatch(f.nodes['settings-search-receipts'].innerHTML, /href="javascript:|<img/);
  assert.match(f.nodes['settings-search-receipts'].innerHTML, /&lt;img/);
});

function devicesFixture() {
  const f = fixture(); f.add('devices-usb-list', 'devices-usb-other', 'devices-usb-status', 'devices-usb-summary',
    'devices-usb-raw', 'devices-usb-raw-pre', 'lan-devices-status', 'lan-devices-summary', 'lan-devices-interfaces', 'lan-devices-arp');
  const mesh = source('mesh.js'); vm.runInContext(mesh.slice(mesh.indexOf('// One-time wiring for USB buttons'), mesh.indexOf('function openReviewedPeerConsole')), f.ctx);
  f.run = name => f.ctx[{usb: 'refreshUsbDevices', raw: 'loadUsbRawOutput', lan: 'refreshLanDevices'}[name]]();
  f.button = (action = 'ai-storage') => {
    const html = f.nodes['devices-usb-list'].innerHTML;
    const btn = f.node('button'); btn.attrs = {'data-usb-path': 'E:\\', 'data-usb-action': action,
      'data-usb-epoch': html.match(/data-usb-epoch="(\d+)"/)[1], 'data-usb-read': html.match(/data-usb-read="(\d+)"/)[1]};
    btn.closest = () => btn; return btn;
  };
  f.action = btn => f.nodes['devices-usb-list'].fire('click', {target: btn});
  return f;
}
const inventory = {devices: [{name: 'Private USB', is_storage: true, mount_path: 'E:\\'}]};
const deviceData = kind => kind === 'usb' ? inventory : kind === 'raw' ? {ok: true, stdout: 'private serial'} : {arp_table: [{ip: '192.168.1.20', mac: '00:00:00:00:00:00'}]};
const textOf = node => node.textContent + node.innerHTML + node.children.map(textOf).join('');
const deviceText = f => Object.values(f.nodes).map(textOf).join('');

for (const kind of ['usb', 'raw', 'lan']) for (const status of [401, 403]) test(`${kind} ${status} clears private device output and waits for verified readiness`, async () => {
  const f = devicesFixture(); f.respond(async () => response(deviceData(kind))); await f.run(kind);
  f.respond(async () => response({detail: 'Unlock required'}, status)); await f.run(kind);
  assert.doesNotMatch(deviceText(f), /Private USB|private serial|192\.168\.1\.20/);
  const before = f.calls.length; f.emit('tli-session-unlocked'); await f.run(kind); assert.equal(f.calls.length, before);
  f.emit('tli-private-observation-ready'); assert.equal(f.calls.length, before);
  f.respond(async () => response(deviceData(kind))); await f.run(kind); assert.equal(f.calls.length, before + 1);
});

for (const kind of ['usb', 'raw', 'lan']) for (const status of [200, 403]) test(`late ${kind} ${status} cannot repaint or pause the new session`, async () => {
  const f = devicesFixture(), pending = deferred(); f.respond(() => pending.promise); const read = f.run(kind);
  f.emit('tli-session-locked'); f.recover(); f.respond(async () => response(kind === 'usb' ? {devices: []} : kind === 'raw' ? {ok: true, stdout: 'new output'} : {arp_table: []}));
  await f.run(kind); const current = deviceText(f); pending.resolve(response(deviceData(kind), status)); await read;
  assert.equal(deviceText(f), current);
});

test('newer USB read wins and detached drive controls cannot dispatch after refresh or lock', async () => {
  const f = devicesFixture(); f.respond(async () => response(inventory)); await f.run('usb'); const old = f.button();
  const pending = deferred(); f.respond(() => pending.promise); const first = f.run('usb');
  f.respond(async () => response({devices: []})); await f.run('usb'); pending.resolve(response(inventory)); await first;
  assert.match(deviceText(f), /No USB storage detected/); await f.action(old); assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 0);
  f.respond(async () => response(inventory)); await f.run('usb'); const current = f.button();
  f.emit('tli-session-locked'); f.recover(); await f.action(current); assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 0);
});

test('USB storage acknowledgement cannot open or refresh model UI after a lock, including queued timers', async () => {
  for (const late of [true, false]) {
    const f = devicesFixture(); let opens = 0; f.window.tliOpenModelManagerModal = () => opens++;
    f.respond(async () => response(inventory)); await f.run('usb'); const btn = f.button(), pending = deferred();
    f.respond(() => pending.promise); const save = f.action(btn); await f.action(btn);
    assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 1);
    if (late) { f.emit('tli-session-locked'); f.recover(); }
    pending.resolve(response({ok: true, path: 'E:\\TLI_Models'})); await save;
    if (!late) { f.emit('tli-session-locked'); f.recover(); }
    for (const timer of f.timers) timer(); assert.equal(opens, 0);
  }
});

test('malformed USB response is unavailable rather than empty, and LAN strings stay literal', async () => {
  const f = devicesFixture(); f.respond(async () => response({})); await f.run('usb');
  assert.match(deviceText(f), /unreadable/); assert.doesNotMatch(deviceText(f), /No USB storage detected/);
  f.respond(async () => response({arp_table: [{ip: '<img src=x>', mac: '<script>', vendor: '<svg>', mesh_device: {display_name: '<b>name'}}]}));
  await f.run('lan'); assert.match(deviceText(f), /&lt;img/); assert.doesNotMatch(deviceText(f), /<img|<script>|<svg>|<b>name/);
});

function pickerFixture() {
  const f = fixture(); f.add('mm2-saveto-path', 'mm2-saveto-free', 'mm2-saveto-picker', 'mm2-saveto-change-btn', 'model-manager-progress');
  f.load('ai-model-manager.js'); f.run = () => f.window._tliRefreshSaveToPicker();
  f.options = () => f.nodes['mm2-saveto-picker'].querySelectorAll('.mm2-saveto-option');
  f.respond(async url => response(url === '/devices/usb' ? inventory : {path: 'C:\\TLI\\models', free_gb: 42}));
  return f;
}

for (const status of [401, 403]) test(`picker USB ${status} clears destinations and never treats denied inventory as empty`, async () => {
  const f = pickerFixture(); await f.run(); assert.equal(f.options().length, 2);
  f.respond(async url => response(url === '/devices/usb' ? {detail: 'Unlock required'} : {path: 'C:\\TLI\\models'}, url === '/devices/usb' ? status : 200));
  await f.run(); assert.equal(f.options().length, 0); assert.doesNotMatch(f.nodes['mm2-saveto-path'].textContent, /C:\\TLI/);
  const before = f.calls.length; f.emit('tli-session-unlocked'); await f.run(); assert.equal(f.calls.length, before);
  f.emit('tli-private-observation-ready'); assert.equal(f.calls.length, before);
});

for (const stage of ['location', 'usb']) test(`late picker ${stage} response cannot disclose paths or issue followup reads after lock`, async () => {
  const f = pickerFixture(), pending = deferred();
  f.respond(async url => stage === 'location' || url === '/devices/usb' ? pending.promise : response({path: 'C:\\private'}));
  const read = f.run(); await tick(); f.emit('tli-session-locked'); f.recover(); const before = f.calls.length;
  pending.resolve(response(stage === 'location' ? {path: 'C:\\private'} : inventory)); await read;
  assert.equal(f.calls.length, before); assert.equal(f.options().length, 0); assert.doesNotMatch(f.nodes['mm2-saveto-path'].textContent, /private/);
});

test('picker USB failure retains the verified current destination and explicitly marks alternatives unavailable', async () => {
  const f = pickerFixture(); f.respond(async url => response(url === '/devices/usb' ? {detail: 'Device reads unavailable'} : {path: 'C:\\TLI\\models'}, url === '/devices/usb' ? 503 : 200));
  await f.run(); assert.equal(f.options().length, 1); assert.match(f.nodes['model-manager-progress'].textContent, /USB destinations unavailable/);
  assert.equal(f.nodes['mm2-saveto-path'].textContent, 'C:\\TLI\\models');
});

test('picker detached selection and stale storage completion cannot write or repaint across sessions', async () => {
  const f = pickerFixture(); await f.run(); const btn = f.options()[1], pending = deferred();
  f.respond(() => pending.promise); const save = btn.click(); await btn.click();
  assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 1);
  f.emit('tli-session-locked'); f.recover(); pending.resolve(response({ok: true, path: 'E:\\TLI_Models'})); await save;
  for (const timer of f.timers) timer(); await btn.fire('click');
  assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 1); assert.equal(f.options().length, 0);
  assert.doesNotMatch(f.nodes['mm2-saveto-path'].textContent, /E:/);
});

test('picker uncertain save has no refresh or mutation retry', async () => {
  const f = pickerFixture(); await f.run(); f.respond(async () => response({detail: 'Save unconfirmed'}, 503));
  await f.options()[1].click(); assert.match(f.nodes['model-manager-progress'].textContent, /Storage change unconfirmed/);
  assert.equal(f.timers.length, 0); assert.equal(f.calls.length, 3);
});

for (const status of [401, 403, 503]) test(`picker first location ${status} still wires explicit recovery without replay`, async () => {
  const f = pickerFixture(); f.respond(async () => response({detail: 'Destination unavailable'}, status));
  await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.options().length, 0);
  if (status !== 503) {
    f.emit('tli-session-unlocked'); await f.nodes['mm2-saveto-change-btn'].click();
    assert.equal(f.retries, 1); assert.equal(f.calls.length, 1);
    f.emit('tli-private-observation-ready'); assert.equal(f.calls.length, 1);
  }
  f.respond(async url => response(url === '/devices/usb' ? inventory : {path: 'C:\\current', free_gb: 19}));
  await f.nodes['mm2-saveto-change-btn'].click(); assert.equal(f.calls.length, 3); assert.equal(f.options().length, 2);
  assert.equal(f.nodes['mm2-saveto-path'].textContent, 'C:\\current');
  assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 0);
});

test('picker first opened while paused wires Change and a failed fresh read clears old free-space values', async () => {
  const f = pickerFixture(); f.emit('tli-session-locked'); await f.run(); assert.equal(f.calls.length, 0);
  f.recover(); assert.equal(f.calls.length, 0); await f.nodes['mm2-saveto-change-btn'].click();
  assert.equal(f.nodes['mm2-saveto-free'].textContent, '42 GB free');
  f.respond(async () => response({detail: 'Storage unavailable'}, 503)); await f.run();
  assert.equal(f.nodes['mm2-saveto-path'].textContent, 'Unknown'); assert.equal(f.nodes['mm2-saveto-free'].textContent, '');
  assert.equal(f.options().length, 0);
});
