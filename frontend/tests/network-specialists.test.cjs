const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const nodes = {}, events = {}, calls = [];
  let handler = async () => ({ ok: true });
  function element(tag = 'div') {
    const classes = new Set();
    const el = { tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, handlers: {}, textContent: '', value: '', hidden: false, disabled: false, checked: false, _html: '',
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle(name, force) { const value = force ?? !classes.has(name); value ? classes.add(name) : classes.delete(name); return value; } },
      append(...items) { items.forEach(item => { item.parentNode = item.parentElement = this; this.children.push(item); }); }, appendChild(item) { this.append(item); return item; },
      replaceChildren(...items) { this.children = []; this._html = ''; this.textContent = ''; this.append(...items); },
      before(...items) { if (this.parentNode) this.parentNode.append(...items); }, after(...items) { if (this.parentNode) this.parentNode.append(...items); },
      setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; }, removeAttribute(key) { delete this.attrs[key]; },
      addEventListener(key, fn) { (this.handlers[key] ||= []).push(fn); }, fire(key) { return Promise.all((this.handlers[key] || []).map(fn => fn({ target: this, preventDefault() {} }))); }, click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }, querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return all.filter(child => selector === '*' || selector.startsWith('.') ? selector === '*' || child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase()); },
      get options() { return this.children.flatMap(child => child.tagName === 'OPTGROUP' ? child.children : [child]).filter(child => child.tagName === 'OPTION'); },
      get selectedIndex() { return this.options.findIndex(option => option.value === this.value); },
      focus() {}, select() {}, remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
    };
    Object.defineProperty(el, 'id', { set(id) { nodes[id] = el; el._id = id; }, get() { return el._id; } });
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(html) {
      this._html = html; this.children = [];
      for (const match of html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
        const button = element('button'); button.textContent = match[2];
        button.className = match[1].match(/class="([^"]+)"/)?.[1] || '';
        this.append(button);
      }
    } });
    return el;
  }
  const window = { addEventListener: (type, fn) => (events[type] ||= []).push(fn), confirm: () => false, location: { origin: 'https://synthetic.invalid' } };
  const ctx = vm.createContext({ window, document: { readyState: 'complete', getElementById: id => nodes[id] || null, createElement: element, createTextNode: text => Object.assign(element('#text'), { textContent: text }), querySelectorAll: () => [], querySelector: () => null, addEventListener: (type, fn) => (events[type] ||= []).push(fn) },
    Date, Set, Map, AbortController, TextDecoder, TextEncoder, console: { warn() {}, error() {}, log() {} }, setInterval() { return 1; }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options = {}) => { calls.push({ url, options }); return handler(url, options); },
    $: id => nodes[id], currentDeviceId: 'synthetic-host', debugLog() {}, showToast() {}, confirm: () => true,
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  function add(id, tag, value = '') { const el = element(tag); el.id = id; el.value = value; return el; }
  const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  return { nodes, events, calls, ctx, window, element, add, json, handler(fn) { handler = fn; }, load(file, transform = s => s) { vm.runInContext(transform(read(file)), ctx); } };
}

test('Mesh retains distinct same-name computers and uses stable identity for duplicates', () => {
  const f = fixture(); f.load('mesh-control.js', s => s.replace('  function boot() {', '  window.testMesh = {uniqueNodes, buildNodeCard, refresh};\n  function boot() {'));
  const rows = [{ peer_id: 'a', node_name: 'Office' }, { peer_id: 'b', node_name: 'Office' }, { peer_id: 'a', node_name: 'Renamed' }];
  assert.deepEqual(Array.from(f.window.testMesh.uniqueNodes(rows), row => row.peer_id), ['a', 'b']);
  const unknown = f.window.testMesh.buildNodeCard({ node_name: 'Unknown' });
  assert.ok(unknown.children.some(child => /health is unavailable/.test(child.textContent)));
  const missingAI = f.window.testMesh.buildNodeCard({ online: true, node_name: '<img onerror=alert(1)>' });
  assert.ok(missingAI.children.some(child => child.textContent === 'AI availability unknown'));
  assert.ok(missingAI.innerHTML.includes('&lt;img'));
});

test('Computer details bind to raw registry identity even when offline and never fall back to an address', async () => {
  const f=fixture(), opened=[]; f.window.TLIDeviceDetails={open:id=>opened.push(id)};
  f.load('mesh-control.js',s=>s.replace('  function boot() {','  window.testMesh = {buildNodeCard};\n  function boot() {'));
  for(const id of ['peer-one','peer-two']){const card=f.window.testMesh.buildNodeCard({peer_id:id,node_name:'Same name',ip:'192.0.2.1',online:false});await card.children.find(e=>e.textContent==='Device details').click();}
  const unknown=f.window.testMesh.buildNodeCard({node_name:'Same name',ip:'192.0.2.1',online:true});
  assert.deepEqual(opened,['node-peer-one','node-peer-two']);assert.equal(unknown.children.some(e=>e.textContent==='Device details'),false);assert.equal(f.calls.length,0);
});

for (const profile of [{ peer_profile: 'inference_node' }, { connection_state: 'inference_only' }]) {
  test('Compute-only Node health cards have no full-host controls or invented availability: ' + JSON.stringify(profile), () => {
    const f = fixture();
    f.load('mesh-control.js', s => s.replace('  function boot() {', '  window.testMesh = {buildNodeCard};\n  function boot() {'));
    for (const online of [null, false, true]) {
      const card = f.window.testMesh.buildNodeCard({ peer_id: 'compute-node', node_name: '<img src=x>', online,
        cpu_percent: 90, ram_percent: 75, uptime_seconds: 99, has_ai: true, ai_healthy: true, ...profile });
      assert.match(card.innerHTML, /Compute-only Node/); assert.match(card.innerHTML, /&lt;img src=x&gt;/);
      assert.doesNotMatch(card.className, /offline/); assert.doesNotMatch(card.innerHTML, /mcd-status-dot|Reported online|Not reachable|Status unavailable/);
      assert.equal(card.querySelectorAll('button').length, 0);
      assert.equal(card.querySelectorAll('.mcd-metrics').length, 0); assert.equal(card.querySelectorAll('.mcd-uptime').length, 0);
      assert.match(card.children.map(child => child.textContent).join(' '), /Check models in Ask TLI/);
      assert.doesNotMatch(card.children.map(child => child.textContent).join(' '), /health is unavailable|AI Running|Model files reported/);
    }
    assert.equal(f.calls.length, 0);
  });
}

test('full-host health cards retain details, messages and reported metrics alongside compute-only Nodes', () => {
  const f = fixture();
  f.load('mesh-control.js', s => s.replace('  function boot() {', '  window.testMesh = {buildNodeCard};\n  function boot() {'));
  const card = f.window.testMesh.buildNodeCard({ peer_id: 'full-host', node_name: 'Office', online: true, cpu_percent: 12 });
  assert.deepEqual(card.querySelectorAll('button').map(child => child.textContent), ['Device details', 'Messages & files', 'Review connection']);
  assert.equal(card.querySelectorAll('.mcd-metrics').length, 1); assert.match(card.innerHTML, /Reported online/);
  assert.doesNotMatch(card.innerHTML, /Compute-only Node/); assert.equal(f.calls.length, 0);
});

test('Mesh failed refresh preserves the previous cards and marks them out of date', async () => {
  const f = fixture(); f.add('mcd-grid'); f.add('mcd-last-updated');
  f.load('mesh-control.js', s => s.replace('  function boot() {', '  window.testMesh = {refresh};\n  function boot() {'));
  f.handler(async () => f.json({ nodes: [{ peer_id: 'a', online: true, node_name: 'Office' }] })); await f.window.testMesh.refresh();
  const previous = f.nodes['mcd-grid'].children[0];
  f.handler(async () => f.json({ detail: 'Unavailable' }, 503)); await f.window.testMesh.refresh();
  assert.equal(f.nodes['mcd-grid'].children[0], previous);
  assert.match(f.nodes['mcd-last-updated'].textContent, /Previous results.*out of date/);
});

test('Automations delegates panel lifecycle to one routine controller without making requests', async () => {
  const f=fixture(), seen=[];f.window.TLIManualRoutines={onOpen:()=>seen.push('open'),onClose:()=>seen.push('close')};
  f.load('automations.js');assert.equal(f.calls.length,0);await f.window.TLIAutomations.onOpen();await f.window.TLIAutomations.onClose();
  assert.deepEqual(seen,['open','close']);assert.equal(f.calls.length,0);
});
test('Home action compatibility refreshes delegate instead of creating a competing lifecycle owner', async () => {
  const f=fixture(), seen=[];f.window.TLIManualRoutines={refresh:()=>seen.push('refresh')};f.load('action-engine.js');
  await f.window.TLIHomeAutoActions.refreshActions();await f.window.TLIHomeAutoActions.refreshReceipts();
  assert.deepEqual(seen,['refresh','refresh']);assert.equal(f.calls.length,0);
});
test('Home routine entry opens navigation without a trigger, action or device request', async () => {
  const f=fixture(), seen=[];f.window.switchPanel=id=>seen.push(id);f.load('action-engine.js');
  f.window.TLIHomeAutoActions.loadDevices();assert.deepEqual(seen,['panel-automations']);assert.equal(f.calls.length,0);
});

test('Tool outcome distinguishes script failure, embedded builtin errors, failed probes and unknown execution', () => {
  const f = fixture(); f.load('tools.js');
  for (const data of [{ exit_code: 2, output: 'Failed' }, { exit_code: 0, output: '{"error":"Missing provider"}' }]) assert.equal(f.ctx.toolOutcome(data).state, 'error');
  assert.equal(f.ctx.toolOutcome({ exit_code: 0, output: '{"tests":[{"host":"x","ok":false}]}' }).state, 'warning');
  assert.equal(f.ctx.toolOutcome({ output: 'received' }).state, 'unknown');
});

test('Tools execute one request and only interpret output after an explicit separate click', async () => {
  const f = fixture(), parent = f.element('div');
  const select = f.add('tools-select', 'select', 'sys_top_processes'); const option = f.element('option'); option.value = 'sys_top_processes'; option.textContent = 'Top Processes'; select.append(option);
  const params = f.add('tools-params', 'textarea'); parent.append(params);
  parent.append(f.add('tools-run-btn', 'button'), f.add('tools-explain-box'));
  const output = f.add('tools-output'); const pre = f.element('pre'); output.append(pre);
  f.load('tools.js'); f.ctx.setupToolsPanel();
  let finish; f.handler(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.nodes['tools-run-btn'].click(); await tick(); await f.nodes['tools-run-btn'].click();
  assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(f.calls[0].options.body).params, { limit: 10 });
  finish(f.json({ exit_code: 0, output: '{"top_processes":[]}' })); await pending;
  assert.equal(f.calls.length, 1); assert.match(f.nodes['tools-explain-box'].textContent, /optional/);
  f.handler(async () => f.json({ reply: 'No processes were reported.' })); await f.nodes['tools-explain-btn'].click();
  assert.equal(f.calls[1].url, '/chat');
});

function gameFixture() {
  const f = fixture(), root = f.element('div');
  for (const id of ['go-game-input', 'go-question', 'go-output-title', 'go-output-source', 'go-output', 'go-output-wrap', 'go-ask-btn', 'go-copy-btn', 'go-clear-btn']) root.append(f.add(id, id.includes('input') ? 'input' : 'div'));
  f.nodes['go-game-input'].value = 'Test Game'; f.nodes['go-question'].value = 'Explain settings';
  f.load('tli-games.js'); f.window.TLIGames.setup(); return f;
}
function stream(text) {
  let used = false;
  return { ok: true, body: { getReader: () => ({ async read() { if (used) return { done: true }; used = true; return { done: false, value: new TextEncoder().encode(text) }; }, async cancel() {} }) } };
}
test('Game advice retains prior text on failure and does not claim truncated replies are complete', async () => {
  const f = gameFixture(); f.handler(async () => stream('data: {"t":"Previous advice"}\n\ndata: [DONE]\n\n'));
  await f.nodes['go-ask-btn'].click(); assert.match(f.nodes['go-request-status'].textContent, /Advice received/);
  const previous = f.nodes['go-output'].innerHTML;
  const previousTitle = f.nodes['go-output-title'].textContent;
  f.nodes['go-game-input'].value = 'Different Game';
  f.handler(async () => ({ ok: false, status: 503 })); await f.nodes['go-ask-btn'].click();
  assert.equal(f.nodes['go-output'].innerHTML, previous); assert.match(f.nodes['go-request-status'].textContent, /previous advice is unchanged/);
  assert.equal(f.nodes['go-output-title'].textContent, previousTitle);
  f.handler(async () => stream('data: {"t":"Partial suggestion"}\n\n')); await f.nodes['go-ask-btn'].click();
  assert.match(f.nodes['go-request-status'].textContent, /partial reply.*incomplete/);
  assert.match(f.nodes['go-previous-output'].textContent, /Previous advice/);
});

test('Game Stop aborts one pending request without replaying it', async () => {
  const f = gameFixture();
  f.handler((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const pending = f.nodes['go-ask-btn'].click(); await tick(); await f.nodes['go-ask-btn'].click();
  await f.nodes['go-stop-btn'].click(); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.signal.aborted, true);
  assert.match(f.nodes['go-request-status'].textContent, /Stopped/); assert.equal(f.nodes['go-ask-btn'].disabled, false);
});

test('Hub failed setting writes cannot appear saved or change the confirmed connection toggle', async () => {
  const f = fixture(); ['hub-grid', 'hub-status-bar', 'hub-url-input', 'hub-url-save', 'hub-enabled-toggle'].forEach(id => f.add(id));
  f.handler(async () => f.json({ enabled: false, packages: [] })); f.load('hub.js'); f.ctx.setupHubPanel(); await tick();
  f.nodes['hub-url-input'].value = 'https://registry.invalid'; f.handler(async () => f.json({ detail: 'Rejected' }, 403));
  await f.nodes['hub-url-save'].click(); assert.notEqual(f.nodes['hub-url-save'].textContent, 'Saved ✓'); assert.match(f.nodes['hub-status-bar'].textContent, /save failed/);
  f.nodes['hub-enabled-toggle'].checked = true; await f.nodes['hub-enabled-toggle'].fire('change');
  assert.equal(f.nodes['hub-enabled-toggle'].checked, false); assert.match(f.nodes['hub-status-bar'].textContent, /change failed/);
});

test('Hub installs a theme without applying it and retains an installed card after rejected removal', async () => {
  const f = fixture(); ['hub-grid', 'hub-status-bar'].forEach(id => f.add(id));
  const applied = []; f.ctx.document.head = { appendChild: el => applied.push(el) };
  const pkg = { id: 'theme-1', type: 'theme', name: '<img src=x onerror=alert(1)>', description: 'Synthetic theme', preview_css: ':root{--bg:#000;--accent:#fff;}' };
  f.handler(async url => f.json(url === '/hub/status' ? { enabled: false } : { packages: [pkg] }));
  f.load('hub.js'); f.ctx.setupHubPanel(); await tick();
  const card = f.nodes['hub-grid'].children[0];
  assert.ok(card.innerHTML.includes('&lt;img')); assert.ok(!card.innerHTML.includes('<img'));
  f.handler(async () => f.json({ ok: true })); await card.querySelector('.hub-install-btn').click();
  assert.equal(applied.length, 0); assert.equal(f.calls.filter(call => call.url === '/hub/install').length, 1);
  const installed = f.nodes['hub-grid'].children[0];
  assert.equal(installed.querySelector('.hub-preview-btn').textContent, 'Apply for this session');
  f.handler(async () => f.json({ ok: false })); await installed.querySelector('.hub-uninstall-btn').click();
  assert.equal(f.nodes['hub-grid'].children[0], installed);
  assert.equal(installed.querySelector('.hub-uninstall-btn').disabled, false);
});
