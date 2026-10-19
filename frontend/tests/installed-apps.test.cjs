const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/tli-apps.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const response = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const app = (overrides = {}) => ({id: 'desk-clock', name: 'Desk clock', version: '1.0', permissions: ['mesh.devices'], ...overrides});

// DOM behavior needed by the installed-app controller, including detached panels,
// iframe identity and reflected src attributes. Fetches never leave this fixture.
function fixture() {
  const calls = [], sourceLoads = [], events = [], storage = new Map(), toasts = [];
  let handler = async () => response({apps: [app()]});
  function eventTarget() {
    const listeners = new Map();
    return {
      addEventListener(type, fn) { const entries = listeners.get(type) || []; entries.push(fn); listeners.set(type, entries); },
      dispatchEvent(event) { events.push(event.type); for (const fn of listeners.get(event.type) || []) fn(event); return true; },
      emit(event) { return Promise.all((listeners.get(event.type) || []).map(fn => fn(event))); },
    };
  }
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const matches = (node, selector) => {
    if (selector === '.panel-container:not([hidden])') return node.className.split(' ').includes('panel-container') && !node.hidden;
    if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
    const appId = selector.match(/^\[data-app-id="([^"]+)"\]$/);
    return !!appId && node.dataset.appId === appId[1];
  };
  function element(tag) {
    const el = Object.assign(eventTarget(), {
      tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, style: {}, className: '', textContent: '', hidden: false, parentNode: null,
      append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } },
      appendChild(node) { this.append(node); return node; },
      after(...nodes) { this.parentNode?.append(...nodes); },
      replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key] ?? null; },
      querySelector(selector) { return descendants(this).slice(1).find(node => matches(node, selector)) || null; },
      querySelectorAll(selector) { return descendants(this).slice(1).filter(node => matches(node, selector)); },
      click() { return this.emit({type: 'click', target: this}); },
    });
    el.classList = {
      add(...names) { el.className = [...new Set(el.className.split(' ').concat(names))].join(' '); },
      remove(...names) { el.className = el.className.split(' ').filter(name => !names.includes(name)).join(' '); },
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._html || ''; },
      set(html) {
        this._html = html; this.replaceChildren();
        for (const match of html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
          const button = element('button'); button.className = match[1].match(/class="([^"]+)"/)?.[1] || ''; button.textContent = match[2];
          this.append(button);
        }
      },
    });
    if (tag === 'iframe') {
      el.messages = [];
      el.contentWindow = {postMessage: (message, origin) => el.messages.push({message, origin})};
      Object.defineProperty(el, 'src', {
        get: () => el.getAttribute('src') || '',
        set(value) { el.setAttribute('src', value); sourceLoads.push(value); },
      });
    }
    return el;
  }
  const main = element('main'); main.className = 'main-scroll';
  const home = element('section'); home.className = 'panel-container'; home.id = 'panel-dashboard2';
  const installed = element('section'); installed.className = 'panel-container'; installed.id = 'panel-installed-apps'; installed.hidden = true;
  const list = element('div'); list.id = 'installed-app-list';
  const status = element('p'); status.id = 'installed-app-status';
  installed.append(status, list); main.append(home, installed);
  const document = Object.assign(eventTarget(), {
    readyState: 'loading', createElement: element,
    getElementById: id => descendants(main).find(node => node.id === id) || null,
    querySelector: selector => descendants(main).find(node => matches(node, selector)) || null,
  });
  const window = Object.assign(eventTarget(), {
    switchPanel(id) {
      if (!document.getElementById(id)) return false;
      for (const panel of descendants(main).filter(node => matches(node, '.panel-container'))) panel.hidden = panel.id !== id;
      document.dispatchEvent(new CustomEvent('tli-panel-switched', {detail: {panelId: id}}));
      return true;
    },
  });
  const context = vm.createContext({
    window, document, AbortController, AbortSignal, CustomEvent,
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    showToast(...args) { toasts.push(args); },
    fetch(url, options = {}) { calls.push({url, options}); return handler(url, options); },
  });
  vm.runInContext(source, context);
  return {
    api: window.TLIApps, window, document, main, list, status, calls, sourceLoads, events, storage, toasts,
    handler(fn) { handler = fn; },
    event(type, detail) { window.dispatchEvent(new CustomEvent(type, {detail})); },
    frame(id = 'desk-clock') { return document.getElementById('panel-app-' + id)?.querySelector('.tli-app-frame'); },
    message(frame, method = 'mesh.devices', id = 'request-one', params = {}) { return window.emit({type: 'message', source: frame.contentWindow, data: {type: 'tli-bridge', id, method, params}}); },
    appRequests() { return calls.filter(call => call.url === '/hub/apps'); },
    async hub(installed = true) {
      const hub = element('section'); hub.className = 'panel-container'; hub.id = 'panel-hub'; hub.hidden = true;
      for (const id of ['hub-grid', 'hub-status-bar', 'hub-run-drawer', 'hub-run-output', 'hub-run-title', 'hub-run-close']) {
        const node = element('div'); node.id = id; hub.append(node);
      }
      main.append(hub);
      handler = async url => response(url === '/hub/status' ? {enabled: false} : url === '/hub/apps' ? {apps: [app()]} : {packages: [app({type: 'app', installed})]});
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/hub.js'), 'utf8'), context);
      context.setupHubPanel(); await tick(); window.switchPanel('panel-hub'); await tick();
      return document.getElementById('hub-grid').children[0];
    },
  };
}

test('listing apps loads no package code; opening an app sets its iframe source once', async () => {
  const f = fixture(); f.handler(async () => response({apps: [app({name: '<img src=x onerror=alert(1)>'})]}));
  await f.api.reload();
  const frame = f.frame();
  assert.ok(frame); assert.equal(frame.getAttribute('src'), null); assert.deepEqual(f.sourceLoads, []);
  assert.equal(f.list.children[0].children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(f.list.children[0].children[0].children[0].children.length, 0, 'Labels remain text, not app markup');
  assert.equal(f.api.open('missing'), false);
  await f.list.children[0].click();
  assert.equal(f.document.getElementById('panel-app-desk-clock').hidden, false);
  assert.deepEqual(f.sourceLoads, ['/apps/desk-clock/index.html']);
  f.api.open('desk-clock'); await f.api.reload();
  assert.equal(f.frame(), frame); assert.equal(f.sourceLoads.length, 1);
  await f.document.getElementById('panel-app-desk-clock').children[0].children[2].click();
  assert.equal(f.sourceLoads.length, 2, 'Explicit Reload app is the next iframe navigation');
});

for (const status of [200, 401, 403]) test('a stale ' + status + ' cannot change the current session or its pending load', async () => {
  const f = fixture(), old = deferred(), fresh = deferred();
  f.handler(() => old.promise); const oldLoad = f.api.reload();
  const oldSignal = f.appRequests()[0].options.signal;
  f.event('tli-session-locked'); assert.equal(oldSignal.aborted, true);
  f.event('tli-session-unlocked', {source: 'pin-verification'});
  f.handler(() => fresh.promise); f.event('tli-private-observation-ready'); const freshLoad = f.api.reload();
  assert.equal(f.appRequests().length, 2);
  old.resolve(response({apps: [app({name: 'Old account'})]}, status)); await oldLoad;
  assert.equal(f.events.filter(type => type === 'tli-session-locked').length, 1);
  const joinedLoad = f.api.reload();
  assert.equal(f.appRequests().length, 2, 'An obsolete finally must not clear the current pending load');
  fresh.resolve(response({apps: [app({name: 'Current account app'})]}));
  await Promise.all([freshLoad, joinedLoad]);
  assert.match(f.status.textContent, /1 installed app/); assert.equal(f.frame().title, 'Current account app');
  assert.equal(f.sourceLoads.length, 0, 'Session recovery only loads metadata');
});

test('unlock waits for verified private access, coalesces ready events and never reopens package code', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock');
  f.event('tli-session-locked'); assert.equal(f.list.children.length, 0); assert.equal(f.frame(), undefined);
  f.event('tli-session-unlocked'); await f.api.reload();
  assert.equal(f.appRequests().length, 1); assert.equal(f.api.open('desk-clock'), false);
  f.event('tli-session-unlocked', {source: 'pin-verification'}); await f.api.reload();
  assert.equal(f.appRequests().length, 1);
  f.event('tli-private-observation-ready'); f.event('tli-private-observation-ready'); await f.api.reload();
  assert.equal(f.appRequests().length, 2); assert.ok(f.frame()); assert.match(f.status.textContent, /1 installed app/);
  assert.equal(f.sourceLoads.length, 1); assert.equal(f.frame().getAttribute('src'), null);
  f.event('tli-session-unlocked', {source: 'pin-verification'}); f.event('tli-private-observation-ready'); await tick();
  assert.equal(f.appRequests().length, 2, 'Duplicate success signals do not destroy the recovered session');
});

test('initial PIN-off status does not disable an already authorized metadata read', async () => {
  const f = fixture(); f.event('tli-session-unlocked'); await f.api.reload();
  assert.equal(f.appRequests().length, 1); assert.ok(f.frame());
});

test('a ready signal while locked cannot restore private app labels or launchers', async () => {
  const f = fixture(), pending = deferred(); f.handler(() => pending.promise);
  const load = f.api.reload(); f.event('tli-session-locked'); f.event('tli-private-observation-ready');
  pending.resolve(response({apps: [app({name: 'Private app'})]})); await load;
  assert.equal(f.list.children.length, 0); assert.equal(f.frame(), undefined);
  assert.equal(f.api.open('desk-clock'), false); assert.equal(f.sourceLoads.length, 0);
  assert.match(f.status.textContent, /Unlock TLI/); assert.equal(f.appRequests().length, 1);
});

for (const status of [401, 403]) test('current ' + status + ' closes apps and bare PIN-off unlock cannot create a retry loop', async () => {
  const f = fixture(); await f.api.reload(); const frame = f.frame(); f.api.open('desk-clock');
  f.handler(async () => response({}, status)); await f.api.reload();
  assert.equal(f.list.children.length, 0); assert.equal(f.frame(), undefined); assert.equal(f.api.open('desk-clock'), false);
  f.event('tli-session-unlocked'); await f.api.reload();
  assert.equal(f.appRequests().length, 2);
  await f.message(frame); assert.equal(frame.messages.length, 0);
});

test('self-declared permissions and forged frame messages cannot access host APIs, storage, badges or toasts', async () => {
  const f = fixture();
  const methods = ['mesh.devices', 'settings.read', 'notifications', 'shell.badge', 'storage.local'];
  f.handler(async () => response({apps: [app({permissions: methods})]}));
  const saved = '{"keep":"original bytes"}'; f.storage.set('tli-app-storage:desk-clock:saved', saved);
  f.storage.set('tli_settings', '{"private":true}'); const before = [...f.storage];
  await f.api.reload(); const frame = f.frame();
  for (const candidate of [frame, {contentWindow: {postMessage() { throw new Error('Forged source received data'); }}}]) {
    await f.window.emit({type: 'message', source: candidate.contentWindow, data: {type: 'tli-app-ready'}});
    for (const method of methods) await f.message(candidate, method, method, {action: 'clear', key: 'saved', value: 'changed', n: 4, text: 'Untrusted notification'});
  }
  assert.equal(frame.messages.length, 0); assert.equal(f.calls.length, 1); assert.deepEqual([...f.storage], before);
  assert.deepEqual(f.toasts, []); assert.equal(f.document.querySelector('.tli-app-badge'), null);
  assert.match(f.status.textContent, /permissions are declarations, not user grants/);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts'); assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
});

test('old frame messages and detached Reload app buttons remain inert after lock and remount', async () => {
  const f = fixture(); await f.api.reload(); const oldFrame = f.frame(); f.api.open('desk-clock');
  const oldReload = f.document.getElementById('panel-app-desk-clock').children[0].children[2];
  f.event('tli-session-locked'); f.event('tli-session-unlocked', {source: 'pin-verification'});
  f.event('tli-private-observation-ready'); await f.api.reload(); assert.notEqual(f.frame(), oldFrame);
  await oldReload.click(); await f.message(oldFrame);
  assert.equal(oldFrame.messages.length, 0); assert.equal(f.calls.length, 2); assert.equal(f.sourceLoads.length, 1);
});

for (const [label, fail] of [
  ['null app list', async () => response({apps: null})],
  ['missing app list', async () => response({unexpected: []})],
  ['malformed JSON', async () => ({ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); }})],
  ['integrity failure', async () => response({detail: 'Saved app metadata needs recovery.'}, 503)],
  ['network failure', async () => { throw new Error('Network unavailable'); }],
]) test(label + ' closes a running app and never claims the registry is empty', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); f.handler(fail); await f.api.reload();
  assert.equal(f.frame(), undefined); assert.equal(f.list.children.length, 0); assert.equal(f.api.open('desk-clock'), false);
  assert.equal(f.document.getElementById('panel-installed-apps').hidden, false);
  assert.match(f.status.textContent, /Apps are closed/); assert.doesNotMatch(f.status.textContent, /No apps installed/);
  if (label === 'integrity failure') assert.match(f.status.textContent, /Saved app metadata needs recovery/);
  f.handler(async () => response({apps: [app()]})); await f.api.reload();
  assert.ok(f.frame()); assert.equal(f.frame().getAttribute('src'), null); assert.equal(f.sourceLoads.length, 1);
});

test('a verified empty list removes the active app and returns to Installed apps', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock');
  f.handler(async () => response({apps: []})); await f.api.reload();
  assert.equal(f.frame(), undefined); assert.equal(f.list.children.length, 0); assert.equal(f.api.open('desk-clock'), false);
  assert.equal(f.document.getElementById('panel-installed-apps').hidden, false); assert.match(f.status.textContent, /No apps installed/);
});

test('safe dotted IDs work but invalid, reserved and ambiguous IDs reject the whole list', async () => {
  const f = fixture(); f.handler(async () => response({apps: [app({id: 'org.example.app'})]})); await f.api.reload();
  assert.equal(f.api.open('org.example.app'), true); assert.equal(f.sourceLoads[0], '/apps/org.example.app/index.html');
  for (const apps of [[app({id: '../escape'})], [app({id: 'bad.'})], [app({id: 'CON.txt'})], [app({id: 'desk-clock'}), app({id: 'Desk-Clock'})]]) {
    f.handler(async () => response({apps})); await f.api.reload();
    assert.equal(f.list.children.length, 0); assert.match(f.status.textContent, /incomplete app list/);
  }
});

test('lock during response decoding suppresses both private data and late error messages', async () => {
  for (const status of [200, 503]) {
    const f = fixture(), body = deferred(); f.handler(async () => ({ok: status === 200, status, json: () => body.promise}));
    const load = f.api.reload(); await tick(); f.event('tli-session-locked');
    body.resolve({apps: [app({name: 'Private old app'})], detail: 'Private old error'}); await load;
    assert.equal(f.frame(), undefined); assert.match(f.status.textContent, /Unlock TLI/);
  }
});

test('confirmed Hub app removal refreshes metadata and destroys its previously running hidden frame', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const frame = f.frame();
  const card = await f.hub(); assert.equal(f.document.getElementById('panel-app-desk-clock').hidden, true);
  f.handler(async url => response(url === '/hub/apps' ? {apps: []} : {ok: true}));
  await card.querySelector('.hub-uninstall-btn').click(); await tick();
  assert.equal(f.frame(), undefined); assert.equal(f.list.children.length, 0); assert.equal(f.api.open('desk-clock'), false);
  assert.equal(frame.parentNode.parentNode, null, 'The old iframe document is detached with its panel');
  assert.equal(f.calls.filter(call => call.options.method === 'DELETE').length, 1);
  assert.equal(f.appRequests().length, 2); assert.equal(f.sourceLoads.length, 1);
  assert.match(f.toasts.at(-1)[0], /uninstalled/);
});

for (const mutation of ['install', 'uninstall']) test('current Hub ' + mutation + ' 503 rechecks metadata and closes a frame without retrying the mutation', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const card = await f.hub(mutation !== 'install');
  f.handler(async () => response({detail: 'A package change is incomplete. Saved files were preserved.'}, 503));
  await card.querySelector(mutation === 'install' ? '.hub-install-btn' : '.hub-uninstall-btn').click(); await tick();
  assert.equal(f.frame(), undefined); assert.equal(f.list.children.length, 0); assert.match(f.status.textContent, /Apps are closed/);
  assert.equal(f.calls.filter(call => call.options.method).length, 1); assert.equal(f.appRequests().length, 2);
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0][1], 'error'); assert.match(f.toasts[0][0], /incomplete/);
  assert.equal(f.sourceLoads.length, 1);
});

test('a transport-ambiguous uninstall rechecks current installed metadata without claiming removal', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const oldFrame = f.frame(), card = await f.hub();
  f.handler(async url => { if (url === '/hub/apps') return response({apps: [app()]}); throw new Error('Connection lost'); });
  await card.querySelector('.hub-uninstall-btn').click(); await tick();
  assert.ok(f.frame()); assert.equal(f.calls.filter(call => call.options.method).length, 1); assert.equal(f.appRequests().length, 2);
  assert.deepEqual(f.toasts, [['Connection lost', 'error']]);
  assert.notEqual(f.frame(), oldFrame); assert.equal(f.frame().getAttribute('src'), null); assert.equal(f.sourceLoads.length, 1);
});

for (const status of [200, 401, 503]) test('post-removal verification supersedes a pending old inventory ' + status, async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const card = await f.hub();
  const old = deferred(), fresh = deferred();
  f.handler(() => old.promise); const oldLoad = f.api.reload(), oldSignal = f.appRequests().at(-1).options.signal;
  f.handler(async url => url === '/hub/apps' ? fresh.promise : response({ok: true}));
  await card.querySelector('.hub-uninstall-btn').click();
  assert.equal(oldSignal.aborted, true); assert.equal(f.frame(), undefined); assert.equal(f.appRequests().length, 3);
  old.resolve(response({apps: [app({name: 'Old installed entry'})]}, status)); await oldLoad;
  assert.equal(f.frame(), undefined); assert.equal(f.events.includes('tli-session-locked'), false);
  const join = f.api.reload(); assert.equal(f.appRequests().length, 3);
  fresh.resolve(response({apps: []})); await join;
  assert.equal(f.frame(), undefined); assert.equal(f.list.children.length, 0); assert.match(f.status.textContent, /No apps installed/);
  assert.equal(f.calls.filter(call => call.options.method).length, 1); assert.equal(f.sourceLoads.length, 1);
});

test('confirmed app install verifies fresh launchers but never automatically reopens previous code', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const oldFrame = f.frame(), card = await f.hub(false);
  f.handler(async url => response(url === '/hub/apps' ? {apps: [app({name: 'Updated app'})]} : {ok: true}));
  await card.querySelector('.hub-install-btn').click(); await tick();
  assert.notEqual(f.frame(), oldFrame); assert.equal(f.frame().title, 'Updated app'); assert.equal(f.frame().getAttribute('src'), null);
  assert.equal(f.appRequests().length, 2); assert.equal(f.calls.filter(call => call.options.method).length, 1); assert.equal(f.sourceLoads.length, 1);
});

for (const status of [200, 503, 401, 403]) test('an old Hub uninstall ' + status + ' cannot refresh or alter the new session', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const card = await f.hub(), pending = deferred();
  f.handler(() => pending.promise); const remove = card.querySelector('.hub-uninstall-btn').click(); await tick();
  f.event('tli-session-locked'); f.event('tli-session-unlocked', {source: 'pin-verification'});
  const reads = f.appRequests().length;
  pending.resolve(response(status === 200 ? {ok: true} : {detail: 'Old session outcome'}, status)); await remove; await tick();
  assert.equal(f.appRequests().length, reads); assert.equal(f.toasts.length, 0); assert.equal(f.frame(), undefined);
  assert.equal(f.events.filter(type => type === 'tli-session-locked').length, 1);
});

for (const status of [401, 403]) test('current denied Hub uninstall ' + status + ' closes through the shared lock without refreshing metadata', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const card = await f.hub();
  f.handler(async () => response({detail: 'Unlock to review the current package state.'}, status));
  await card.querySelector('.hub-uninstall-btn').click(); await tick();
  assert.equal(f.appRequests().length, 1); assert.equal(f.frame(), undefined); assert.equal(f.toasts.length, 0);
  assert.equal(f.calls.filter(call => call.options.method).length, 1);
});
