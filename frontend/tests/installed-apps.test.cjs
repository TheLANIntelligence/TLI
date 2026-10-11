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
  const calls = [], sourceLoads = [], events = [], storage = new Map();
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
      tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, className: '', textContent: '', hidden: false, parentNode: null,
      append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } },
      appendChild(node) { this.append(node); return node; },
      replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key] ?? null; },
      querySelector(selector) { return descendants(this).slice(1).find(node => matches(node, selector)) || null; },
      click() { return this.emit({type: 'click', target: this}); },
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
  vm.runInNewContext(source, {
    window, document, AbortController, AbortSignal, CustomEvent,
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    fetch(url, options = {}) { calls.push({url, options}); return handler(url, options); },
  });
  return {
    api: window.TLIApps, window, document, main, list, status, calls, sourceLoads, events,
    handler(fn) { handler = fn; },
    event(type) { window.dispatchEvent(new CustomEvent(type)); },
    frame(id = 'desk-clock') { return document.getElementById('panel-app-' + id)?.querySelector('.tli-app-frame'); },
    message(frame, method = 'mesh.devices', id = 'request-one') { return window.emit({type: 'message', source: frame.contentWindow, data: {type: 'tli-bridge', id, method, params: {}}}); },
    appRequests() { return calls.filter(call => call.url === '/hub/apps'); },
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

test('lock/unlock starts a fresh load and an old 401 neither locks it nor clears its pending request', async () => {
  const f = fixture(), old = deferred(), fresh = deferred();
  f.handler(() => old.promise); const oldLoad = f.api.reload();
  const oldSignal = f.appRequests()[0].options.signal;
  f.event('tli-session-locked'); assert.equal(oldSignal.aborted, true);
  f.event('tli-session-unlocked');
  f.handler(() => fresh.promise); const freshLoad = f.api.reload();
  assert.equal(f.appRequests().length, 2);
  old.resolve(response({}, 401)); await oldLoad;
  assert.equal(f.events.filter(type => type === 'tli-session-locked').length, 1);
  const joinedLoad = f.api.reload();
  assert.equal(f.appRequests().length, 2, 'An obsolete finally must not clear the current pending load');
  fresh.resolve(response({apps: [app({name: 'Current account app'})]}));
  await Promise.all([freshLoad, joinedLoad]);
  assert.match(f.status.textContent, /1 installed app/); assert.equal(f.frame().title, 'Current account app');
  assert.equal(f.api.open('desk-clock'), true);
});

test('unlock refreshes an already visible Installed apps page automatically', async () => {
  const f = fixture(); await f.api.reload(); f.window.switchPanel('panel-installed-apps');
  f.event('tli-session-locked'); assert.equal(f.list.children.length, 0); assert.equal(f.frame(), undefined);
  f.event('tli-session-unlocked'); await f.api.reload();
  assert.equal(f.appRequests().length, 2); assert.ok(f.frame()); assert.match(f.status.textContent, /1 installed app/);
  assert.equal(f.sourceLoads.length, 0);
});

test('a late successful read cannot restore app labels or launchers while locked', async () => {
  const f = fixture(), pending = deferred(); f.handler(() => pending.promise);
  const load = f.api.reload(); f.event('tli-session-locked');
  pending.resolve(response({apps: [app({name: 'Private app'})]})); await load;
  assert.equal(f.list.children.length, 0); assert.equal(f.frame(), undefined);
  assert.equal(f.api.open('desk-clock'), false); assert.equal(f.sourceLoads.length, 0);
  assert.match(f.status.textContent, /Unlock TLI/);
});

test('a current 401 clears mounted apps and prevents subsequent launch', async () => {
  const f = fixture(); await f.api.reload(); const frame = f.frame(); f.api.open('desk-clock');
  f.handler(async () => response({}, 401)); await f.api.reload();
  assert.equal(f.list.children.length, 0); assert.equal(f.frame(), undefined); assert.equal(f.api.open('desk-clock'), false);
  await f.message(frame); assert.equal(frame.messages.length, 0);
});

test('revoking a bridge grant suppresses its pending result and denies further calls', async () => {
  const f = fixture(), mesh = deferred(); await f.api.reload(); const frame = f.frame();
  f.handler(url => url === '/mesh/directory' ? mesh.promise : Promise.resolve(response({apps: [app({permissions: []})]})));
  const pending = f.message(frame); assert.equal(f.calls.filter(call => call.url === '/mesh/directory').length, 1);
  await f.api.reload(); assert.equal(f.frame(), frame);
  mesh.resolve(response({devices: [{name: 'Private device'}]})); await pending;
  assert.equal(frame.messages.length, 0, 'Previously granted data is not delivered after revocation');
  await f.message(frame, 'mesh.devices', 'after-revocation');
  assert.equal(frame.messages.length, 1); assert.match(frame.messages[0].message.error, /Permission denied/);
  assert.equal(f.calls.filter(call => call.url === '/mesh/directory').length, 1);
});

test('an old frame cannot receive pending bridge data after lock/unlock and remount', async () => {
  const f = fixture(), mesh = deferred(); await f.api.reload(); const oldFrame = f.frame();
  f.handler(url => url === '/mesh/directory' ? mesh.promise : Promise.resolve(response({apps: [app()]})));
  const pending = f.message(oldFrame); f.event('tli-session-locked'); f.event('tli-session-unlocked'); await f.api.reload();
  assert.notEqual(f.frame(), oldFrame);
  mesh.resolve(response({devices: [{name: 'Old account device'}]})); await pending;
  assert.equal(oldFrame.messages.length, 0); await f.message(oldFrame); assert.equal(oldFrame.messages.length, 0);
  assert.equal(f.calls.filter(call => call.url === '/mesh/directory').length, 1);
});

test('malformed and failed app lists retain the last loaded app; a valid empty list removes it', async () => {
  const f = fixture(); await f.api.reload(); f.api.open('desk-clock'); const frame = f.frame();
  for (const fail of [
    async () => response({apps: null}),
    async () => response({unexpected: []}),
    async () => ({ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); }}),
    async () => response({}, 503),
    async () => { throw new Error('Network unavailable'); },
  ]) {
    f.handler(fail); await f.api.reload();
    assert.equal(f.frame(), frame); assert.equal(f.list.children.length, 1);
    assert.equal(f.document.getElementById('panel-app-desk-clock').hidden, false);
    assert.match(f.status.textContent, /Previously loaded apps are retained/); assert.equal(f.sourceLoads.length, 1);
  }
  f.handler(async () => response({apps: []})); await f.api.reload();
  assert.equal(f.frame(), undefined); assert.equal(f.list.children.length, 0); assert.equal(f.api.open('desk-clock'), false);
  assert.equal(f.document.getElementById('panel-installed-apps').hidden, false); assert.match(f.status.textContent, /No apps installed/);
  await tick(); assert.equal(f.sourceLoads.length, 1);
});
