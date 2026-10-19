const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

// Synthetic DOM, fetch, clipboard and AI only. No host script, network or state access.
function fixture() {
  const nodes = {}, events = {}, calls = [], copied = [], toasts = [], created = [];
  let handler = async () => json({}), stream = async () => {};
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  function element(tag = 'div') {
    const classes = new Set();
    const el = {tagName:tag.toUpperCase(), children:[], handlers:{}, dataset:{}, style:{}, value:'', textContent:'', disabled:false, hidden:false, checked:false,
      classList:{contains:name => classes.has(name), add:(...names) => names.forEach(name => classes.add(name)), remove:(...names) => names.forEach(name => classes.delete(name))},
      append(...items) { for (const item of items) { item.parentNode = item.parentElement = this; this.children.push(item); } },
      appendChild(item) { this.append(item); return item; },
      replaceChildren(...items) { this.children = []; this.textContent = ''; this._html = ''; this.append(...items); },
      before(...items) { this.parentNode?.append(...items); }, after(...items) { this.parentNode?.append(...items); },
      insertBefore(item) { this.append(item); }, remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); },
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      fire(type) { return Promise.all((this.handlers[type] || []).map(fn => fn({target:this, preventDefault() {}}))); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); }, focus() {},
      querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return all.filter(child => selector === '*' || (selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase())); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      get options() { return this.children.filter(child => child.tagName === 'OPTION'); },
      get selectedIndex() { return this.options.findIndex(option => option.value === this.value); },
    };
    Object.defineProperty(el, 'id', {get() { return this._id; }, set(id) { this._id = id; nodes[id] = this; }});
    Object.defineProperty(el, 'innerHTML', {get() { return this._html || ''; }, set(html) {
      this._html = html; this.children = [];
      for (const match of html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
        const button = element('button'); button.className = match[1].match(/class="([^"]+)"/)?.[1] || ''; button.textContent = match[2];
        button.disabled = /\bdisabled\b/.test(match[1]); this.append(button);
      }
    }});
    created.push(el); return el;
  }
  const add = (id, tag = 'div') => { const el = element(tag); el.id = id; return el; };
  const emit = (type, detail) => { for (const fn of events[type] || []) fn(new CustomEvent(type, {detail})); };
  const window = {addEventListener:(type, fn) => (events[type] ||= []).push(fn), dispatchEvent:event => emit(event.type, event.detail), location:{origin:'https://synthetic.invalid'}, TLIPinLock:{checkAndLock() {}}, confirm:() => { throw new Error('No execution confirmation expected'); }};
  const document = {readyState:'complete', getElementById:id => nodes[id] || null, createElement:element, createTextNode:text => Object.assign(element('#text'), {textContent:text}), addEventListener:window.addEventListener, querySelectorAll:() => []};
  const context = vm.createContext({window, document, CustomEvent, Map, Set, Object, JSON, Date, AbortSignal,
    fetch:async (url, options = {}) => { calls.push({url, options}); return handler(url, options); },
    navigator:{clipboard:{writeText:async text => { copied.push(text); }}},
    $:id => nodes[id], currentDeviceId:'synthetic', filesLastScanBuckets:null, debugLog() {}, showToast:(...args) => toasts.push(args),
    setTimeout() {}, clearTimeout() {}, tliBundledChatStream:options => stream(options),
    localStorage:{getItem:() => '{}', setItem() {}}, console:{log() {}, warn() {}, error() {}},
  });
  function load(file) { vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context, {filename:file}); }
  async function tools(rows = [builtin, legacy]) {
    const parent = element(); parent.append(add('tools-select', 'select'), add('tools-params', 'textarea'), add('tools-run-btn', 'button'), add('tools-explain-box'));
    add('tools-output').append(element('pre')); handler = async () => json({tools:rows});
    load('tools.js'); context.setupToolsPanel(); await context.refreshToolsList();
  }
  async function hub(rows = [pkg]) {
    const parent = element(); for (const id of ['hub-grid', 'hub-status-bar', 'hub-run-drawer', 'hub-run-output', 'hub-run-title', 'hub-run-close']) parent.append(add(id));
    add('hub-publish-form'); add('hub-search-row');
    const tabs = add('hub-tabs'); for (const type of ['all', 'installed']) { const tab = element('button'); tab.className = 'hub-tab'; tab.dataset.type = type; tabs.append(tab); }
    handler = async url => json(url === '/hub/status' ? {enabled:false} : {packages:rows});
    load('hub.js'); context.setupHubPanel(); await tick();
  }
  async function select(id) { nodes['tools-select'].value = id; await nodes['tools-select'].fire('change'); }
  function scripts() { const parent = element(); parent.append(add('scripts-generate-btn', 'button'), add('scripts-prompt', 'textarea'), add('scripts-output', 'textarea')); load('tools.js'); context.setupScriptsPanel(); }
  return {nodes, calls, copied, toasts, created, context, window, add, emit, load, tools, hub, scripts, select,
    handler(fn) { handler = fn; }, stream(fn) { stream = fn; }, sourceButton:() => nodes['hub-grid'].children[0].querySelector('.hub-source-btn'),
    installed:async () => { await nodes['hub-tabs'].children.find(button => button.dataset.type === 'installed').click(); await tick(); }};
}
function json(data, status = 200) { return {ok:status >= 200 && status < 300, status, json:async () => data}; }
const builtin = {id:'sys_top_processes', label:'Processes', kind:'builtin', executable:true};
const legacy = {id:'saved-script', label:'Saved script', kind:'script', executable:false, unavailable_reason:'Host script execution is unavailable pending reviewed containment.'};
const pkg = {id:'installed-script', name:'Installed script', type:'script', installed:true};
const source = (id, changes = {}) => ({id, name:'Stored source', language:'ps1', shell:'powershell', contents:'<script>untrusted source text</script>', execution_allowed:false, ...changes});

test('stored Tools script is source-only even if its disabled run handler is invoked', async () => {
  const f = fixture(); await f.tools(); await f.select(legacy.id);
  assert.equal(f.nodes['tools-run-btn'].disabled, true); assert.match(f.nodes['tools-description'].textContent, /execution is unavailable/);
  const count = f.calls.length; await f.nodes['tools-run-btn'].fire('click'); assert.equal(f.calls.length, count);
  f.handler(async () => json(source(legacy.id))); await f.nodes['tools-view-source'].click();
  assert.equal(f.calls.at(-1).url, '/tools/scripts/saved-script/source'); assert.equal(f.calls.at(-1).options.method, undefined);
  assert.equal(f.nodes['tools-source-text'].textContent, source(legacy.id).contents); assert.equal(f.nodes['tools-source-text'].innerHTML, '');
  await f.nodes['tools-copy-source'].click(); assert.deepEqual(f.copied, [source(legacy.id).contents]);
  assert.equal(f.calls.some(call => call.url === '/tools/run'), false);
});

test('unknown or contradictory tool metadata cannot enable host script execution', async () => {
  for (const row of [{...legacy, kind:'builtin', executable:true}, {...builtin, kind:'script', executable:false}]) {
    const f = fixture(); await f.tools([row]); await f.select(row.id); await f.nodes['tools-run-btn'].fire('click');
    assert.equal(f.nodes['tools-run-btn'].disabled, true); assert.equal(f.calls.some(call => call.url === '/tools/run'), false);
  }
});

test('built-in utility keeps a single explicit run and retains actionable failure detail', async () => {
  const f = fixture(); await f.tools(); await f.select(builtin.id); const pending = deferred(); f.handler(() => pending.promise);
  const run = f.nodes['tools-run-btn'].click(); await tick(); await f.nodes['tools-run-btn'].fire('click');
  assert.equal(f.calls.filter(call => call.url === '/tools/run').length, 1);
  pending.resolve(json({detail:'The measured check is unavailable.'}, 503)); await run;
  assert.match(f.nodes['tools-explain-box'].textContent, /The measured check is unavailable/); assert.equal(f.nodes['tools-run-btn'].disabled, false);
});

test('failed Tools catalogue is unavailable rather than empty or executable stale rows', async () => {
  const f = fixture(); await f.tools(); await f.select(builtin.id);
  f.handler(async () => json({detail:'Stored tool inventory needs recovery.'}, 503)); await f.context.refreshToolsList();
  assert.match(f.nodes['tools-explain-box'].textContent, /needs recovery/); assert.equal(f.nodes['tools-run-btn'].disabled, true);
  await f.nodes['tools-run-btn'].fire('click'); assert.equal(f.calls.some(call => call.url === '/tools/run'), false);
});

test('Tools source rejects missing identity, nontext, or execution-enabled responses', async () => {
  for (const changes of [{id:'other'}, {contents:null}, {execution_allowed:true}, {execution_allowed:undefined}]) {
    const f = fixture(); await f.tools(); await f.select(legacy.id); f.handler(async () => json(source(legacy.id, changes)));
    await f.nodes['tools-view-source'].click(); assert.equal(f.nodes['tools-source-text'].textContent, '');
    assert.equal(f.nodes['tools-copy-source'].disabled, true); assert.match(f.nodes['tools-source-status'].textContent, /Source unavailable/);
  }
});

for (const status of [401, 403]) test(`Tools source ${status} clears private results without retry`, async () => {
  const f = fixture(); await f.tools(); await f.select(legacy.id); f.handler(async () => json(source(legacy.id))); await f.nodes['tools-view-source'].click();
  f.handler(async () => json({detail:'Session revoked.'}, status)); await f.nodes['tools-view-source'].click();
  assert.equal(f.nodes['tools-source-text'].textContent, ''); assert.equal(f.nodes['tools-copy-source'].disabled, true);
  const count = f.calls.length; f.emit('tli-session-unlocked'); await tick(); assert.equal(f.calls.length, count);
});

test('Tools ignores source from another selection and results from an older locked session', async () => {
  const f = fixture(); await f.tools(); await f.select(legacy.id); const read = deferred(); f.handler(() => read.promise);
  const pending = f.nodes['tools-view-source'].click(); await tick(); await f.select(builtin.id); read.resolve(json(source(legacy.id))); await pending;
  assert.equal(f.nodes['tools-source-text'].textContent, '');
  const result = deferred(); f.handler(() => result.promise); const run = f.nodes['tools-run-btn'].click(); await tick();
  f.emit('tli-session-locked'); f.emit('tli-session-unlocked', {source:'pin-verification'}); result.resolve(json({exit_code:0, output:'OLD PRIVATE OUTPUT'})); await run;
  assert.equal(f.nodes['tools-output'].querySelector('pre').textContent, ''); assert.doesNotMatch(f.nodes['tools-explain-box'].textContent, /OLD PRIVATE/);
});

for (const status of [401, 403]) test(`old Tools source ${status} cannot clear source from the newly unlocked session`, async () => {
  const f = fixture(); await f.tools(); await f.select(legacy.id); const old = deferred(); f.handler(() => old.promise);
  const pending = f.nodes['tools-view-source'].click(); await tick(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  f.handler(async url => json(url === '/tools/list' ? {tools:[builtin, legacy]} : source(legacy.id, {contents:'NEW SESSION SOURCE'})));
  f.emit('tli-private-observation-ready'); await tick(); await f.select(legacy.id); await f.nodes['tools-view-source'].click();
  old.resolve(json({detail:'Old session revoked.'}, status)); await pending;
  assert.equal(f.nodes['tools-source-text'].textContent, 'NEW SESSION SOURCE'); assert.equal(f.nodes['tools-copy-source'].disabled, false);
});

test('Hub installed script offers read-only stored source and copy with no run action', async () => {
  const f = fixture(); await f.hub(); const card = f.nodes['hub-grid'].children[0];
  assert.equal(card.querySelector('.hub-run-btn'), null); assert.match(card.innerHTML, /execution is unavailable/);
  f.handler(async () => json(source(pkg.id))); await f.sourceButton().click();
  assert.equal(f.calls.at(-1).url, '/hub/packages/installed-script/source'); assert.equal(f.calls.at(-1).options.method, undefined);
  assert.equal(f.nodes['hub-run-output'].textContent, source(pkg.id).contents); assert.equal(f.nodes['hub-run-output'].innerHTML, '');
  await f.nodes['hub-copy-source'].click(); assert.deepEqual(f.copied, [source(pkg.id).contents]);
  assert.equal(f.calls.some(call => call.url.endsWith('/run')), false);
});

test('Installed tab merges orphaned saved scripts by ID and reads their stored source without an install action', async () => {
  const f = fixture(); await f.hub();
  const orphan = {...pkg, id:'absent-from-catalogue', name:'Saved orphan'};
  f.handler(async url => json(url === '/hub/installed' ? {installed:[pkg, {...pkg}, orphan]} : source(orphan.id, {contents:'EXACT STORED ORPHAN SOURCE'})));
  await f.installed(); assert.equal(f.nodes['hub-grid'].children.length, 2);
  const card = f.nodes['hub-grid'].children.find(row => row.innerHTML.includes('Saved orphan'));
  assert.match(card.innerHTML, /Saved installed metadata; no matching script in this catalogue/);
  assert.doesNotMatch(card.innerHTML, /Bundled sample catalogue|Configured host registry/);
  assert.equal(card.querySelector('.hub-install-btn'), null); assert.equal(card.querySelector('.hub-run-btn'), null);
  await card.querySelector('.hub-source-btn').click();
  assert.equal(f.calls.at(-1).url, '/hub/packages/absent-from-catalogue/source'); assert.equal(f.nodes['hub-run-output'].textContent, 'EXACT STORED ORPHAN SOURCE');
  assert.equal(f.calls.some(call => call.options.method), false);
});

test('failed installed metadata read is unavailable rather than an empty installed library', async () => {
  const f = fixture(); await f.hub(); f.handler(async () => json({detail:'Installed metadata needs recovery.'}, 503));
  await f.installed(); assert.equal(f.nodes['hub-grid'].children.length, 0);
  assert.match(f.nodes['hub-status-bar'].textContent, /Installed packages unavailable: Installed metadata needs recovery/);
});

test('Hub source validates identity and text; failed refresh clears previous source', async () => {
  const f = fixture(); await f.hub(); f.handler(async () => json(source(pkg.id))); await f.sourceButton().click();
  for (const value of [source('wrong'), source(pkg.id, {contents:{code:'bad'}}), source(pkg.id, {execution_allowed:true})]) {
    f.handler(async () => json(value)); await f.sourceButton().click(); assert.equal(f.nodes['hub-run-output'].textContent, ''); assert.equal(f.nodes['hub-copy-source'].disabled, true);
  }
  f.handler(async () => json({detail:'Stored script cannot be read.'}, 503)); await f.sourceButton().click();
  assert.match(f.nodes['hub-source-status'].textContent, /Stored script cannot be read/); assert.equal(f.calls.some(call => call.url.endsWith('/run')), false);
});

for (const status of [401, 403]) test(`Hub source ${status} clears private cards and source without retry`, async () => {
  const f = fixture(); await f.hub(); f.handler(async () => json(source(pkg.id))); await f.sourceButton().click();
  f.handler(async () => json({detail:'Session revoked.'}, status)); await f.sourceButton().click();
  assert.equal(f.nodes['hub-grid'].children.length, 0); assert.equal(f.nodes['hub-run-output'].textContent, ''); assert.equal(f.nodes['hub-run-drawer'].hidden, true);
  const count = f.calls.length; f.emit('tli-session-unlocked'); await tick(); assert.equal(f.calls.length, count);
});

test('Hub ignores a late source after drawer close or session lock', async () => {
  for (const end of ['close', 'lock']) {
    const f = fixture(); await f.hub(); const read = deferred(); f.handler(() => read.promise);
    const pending = f.sourceButton().click(); await tick();
    if (end === 'close') await f.nodes['hub-run-close'].click(); else { f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); }
    read.resolve(json(source(pkg.id))); await pending;
    assert.equal(f.nodes['hub-run-output'].textContent, ''); assert.equal(f.nodes['hub-copy-source'].disabled, true); assert.equal(f.nodes['hub-run-drawer'].hidden, true);
  }
});

for (const status of [401, 403]) test(`old Hub source ${status} cannot clear source from the newly unlocked session`, async () => {
  const f = fixture(); await f.hub(); const old = deferred(); f.handler(() => old.promise);
  const pending = f.sourceButton().click(); await tick(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  f.handler(async url => json(url === '/hub/status' ? {enabled:false} : url === '/hub/sample' ? {packages:[pkg]} : source(pkg.id, {contents:'NEW SESSION SOURCE'})));
  f.emit('tli-private-observation-ready'); await tick(); await f.sourceButton().click();
  old.resolve(json({detail:'Old session revoked.'}, status)); await pending;
  assert.equal(f.nodes['hub-run-output'].textContent, 'NEW SESSION SOURCE'); assert.equal(f.nodes['hub-copy-source'].disabled, false);
});

test('Hub duplicate install stays single and a late success cannot repaint after lock', async () => {
  const f = fixture(); await f.hub([{...pkg, installed:false}]); const button = f.nodes['hub-grid'].children[0].querySelector('.hub-install-btn');
  const install = deferred(); f.handler(() => install.promise); const pending = button.click(); await tick(); await button.fire('click');
  assert.equal(f.calls.filter(call => call.url === '/hub/install').length, 1);
  f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); install.resolve(json({ok:true})); await pending;
  assert.equal(f.nodes['hub-grid'].children.length, 0); assert.equal(f.toasts.length, 0);
});

test('Scripts generation retains editable source without calling execution or legacy generation routes', async () => {
  const f = fixture(); f.scripts(); f.nodes['scripts-prompt'].value = 'Write a read-only example';
  f.stream(async options => options.onDelta('Write-Output "Draft only"')); await f.nodes['scripts-generate-btn'].click();
  assert.equal(f.nodes['scripts-output'].value, 'Write-Output "Draft only"'); assert.equal(f.calls.length, 0);
  f.nodes['scripts-output'].value += '\n# Edited'; assert.match(f.nodes['scripts-output'].value, /Edited/);
});

test('Scripts generation cannot repaint or fall back after session lock', async () => {
  const f = fixture(); f.scripts(); f.nodes['scripts-prompt'].value = 'Private request'; const generation = deferred(); let delta;
  f.stream(options => { delta = options.onDelta; return generation.promise; }); const pending = f.nodes['scripts-generate-btn'].click(); await tick();
  delta('Private draft'); f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); delta('LATE PRIVATE DRAFT'); generation.reject(new Error('old stream failed')); await pending;
  assert.equal(f.nodes['scripts-output'].value, ''); assert.equal(f.nodes['scripts-prompt'].value, ''); assert.equal(f.calls.length, 0);
});
