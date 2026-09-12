const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/pin-lock.js'), 'utf8');
const settings = fs.readFileSync(path.join(__dirname, '../js/settings.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ response = { data: { enabled: true } }, unlocked = false } = {}) {
  const nodes = {}, events = {}, docEvents = {}, storage = new Map(unlocked ? [['tli_session_unlocked', '1']] : []), calls = [];
  let handler = async () => response;
  function element() {
    const classes = new Set(['hidden']);
    const n = { textContent: '', value: '', style: {}, attrs: {}, hidden: false, disabled: false, handlers: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(event, fn) { (this.handlers[event] ||= []).push(fn); }, fire(event, data = {}) { return Promise.all((this.handlers[event] || []).map(fn => fn(data))); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); }, focus() {}, after(n) { this.afterNode = n; },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      querySelector: () => nodes['recovery-copy'],
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = n; } }); return n;
  }
  for (const id of ['tli-lock-screen', 'tli-lock-input', 'tli-lock-error', 'tli-lock-btn', 'tli-lock-submit', 'tli-lock-forgot', 'tli-lock-reset-panel', 'tli-lock-reset-confirm-btn', 'tli-lock-reset-cancel-btn', 'recovery-copy', 'settings-pin-status-desc', 'settings-pin-action-label', 'settings-pin-current', 'settings-pin-save', 'settings-pin-remove', 'settings-pin-callout']) nodes[id] = element();
  const ctx = vm.createContext({ console, setTimeout() {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: { body: { style: {} }, getElementById: id => nodes[id] || null, createElement: element, addEventListener: (event, fn) => (docEvents[event] ||= []).push(fn) },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: () => 'dismissed', removeItem() {} },
    window: { addEventListener: (event, fn) => (events[event] ||= []).push(fn), dispatchEvent: event => { for (const fn of events[event.type] || []) fn(event); } },
    fetch: async (url, options) => { calls.push({ url, options }); const result = await handler(url, options); return { ok: (result.status || 200) === 200, status: result.status || 200, json: async () => { if (result.invalidJSON) throw new Error('Bad JSON'); return result.data; } }; },
  });
  vm.runInContext(source, ctx);
  return { ctx, nodes, calls, storage, events, handler(fn) { handler = fn; },
    async init() { for (const fn of docEvents.DOMContentLoaded) fn(); await ctx.window.TLIPinLock.checkAndLock(); },
    locked: () => !nodes['tli-lock-screen'].classList.contains('hidden'),
    refresh: () => ctx.window.TLIPinLock.checkAndLock(),
  };
}

test('unavailable or malformed access status stays locked and clears the cached unlocked hint', async () => {
  for (const response of [{ status: 503, data: { detail: 'Saved PIN files unavailable. Preserve the installation.' } }, { data: {} }, { data: null }, { data: { enabled: 'false' } }, { invalidJSON: true }]) {
    const f = fixture({ response, unlocked: true }); await f.init();
    assert.equal(f.locked(), true); assert.equal(f.nodes['tli-lock-screen'].attrs['aria-hidden'], 'false');
    assert.equal(f.storage.has('tli_session_unlocked'), false); assert.equal(f.nodes['tli-lock-recheck'].hidden, false);
    assert.match(f.nodes['tli-lock-error'].textContent, /Access remains locked/); assert.equal(f.calls.length, 1);
  }
});

test('only an explicit disabled status permits the open-access UI, and enabled status asks for PIN', async () => {
  const f = fixture(); await f.init(); assert.equal(f.locked(), true);
  f.handler(async () => ({ data: { enabled: false } })); await f.refresh();
  assert.equal(f.locked(), false); assert.equal(f.nodes['tli-lock-screen'].attrs['aria-hidden'], 'true'); assert.equal(f.nodes['tli-lock-btn'].hidden, true);
  assert.equal(f.nodes['tli-lock-recheck'].hidden, true);
});

test('connection failures offer explicit recheck without automatic retries', async () => {
  const f = fixture(); f.handler(async () => { throw new Error('TLI host is offline.'); }); await f.init();
  assert.equal(f.locked(), true); assert.match(f.nodes['tli-lock-error'].textContent, /offline.*Access remains locked/);
  await tick(); assert.equal(f.calls.length, 1);
  f.handler(async () => ({ data: { enabled: true } })); await f.nodes['tli-lock-recheck'].click(); assert.equal(f.calls.length, 2); assert.equal(f.locked(), true);
});

test('a late disabled status cannot undo a user-requested lock', async () => {
  const f = fixture({ unlocked: true }); let finish;
  f.handler(url => url.endsWith('/lock') ? { data: { ok: true, locked: true } } : new Promise(resolve => { finish = resolve; })); const pending = f.init(); await tick();
  await f.nodes['tli-lock-btn'].click(); finish({ data: { enabled: false } }); await pending;
  assert.equal(f.locked(), true); assert.equal(f.storage.has('tli_session_unlocked'), false);
});

test('concurrent status consumers share one read and a session lock invalidates the cached hint', async () => {
  const f = fixture({ unlocked: true }); await f.init(); assert.equal(f.locked(), false);
  for (const listener of f.events['tli-session-locked']) listener(); assert.equal(f.storage.has('tli_session_unlocked'), false);
  let finish; f.handler(() => new Promise(resolve => { finish = resolve; }));
  const first = f.refresh(), second = f.refresh(); await tick(); assert.equal(f.calls.length, 2);
  finish({ data: { enabled: true } }); await Promise.all([first, second]); assert.equal(f.locked(), true);
});

test('PIN verification requires confirmed success and retains readable security-state errors', async () => {
  for (const response of [{ data: {} }, { data: { ok: false } }, { status: 503, data: { detail: 'Saved security files are unavailable; preserve the original files.' } }]) {
    const f = fixture(); await f.init(); f.handler(async () => response); f.nodes['tli-lock-input'].value = '1234';
    await f.nodes['tli-lock-submit'].click(); assert.equal(f.locked(), true); assert.equal(f.storage.has('tli_session_unlocked'), false);
    assert.match(f.nodes['tli-lock-error'].textContent, /Access remains locked/); assert.equal(f.nodes['tli-lock-submit'].disabled, false);
    if (response.status === 503) assert.match(f.nodes['tli-lock-error'].textContent, /preserve the original files/);
  }
});

test('duplicate PIN submits execute once and confirmed verification unlocks access', async () => {
  const f = fixture(); let resumed=0; f.ctx.window.addEventListener('tli-session-unlocked',()=>resumed++);
  await f.init(); let finish; f.handler(() => new Promise(resolve => { finish = resolve; })); f.nodes['tli-lock-input'].value = '1234';
  const first = f.nodes['tli-lock-submit'].click(); await f.nodes['tli-lock-input'].fire('keydown', { key: 'Enter' }); await f.nodes['tli-lock-submit'].click();
  assert.equal(f.calls.filter(c => c.url.endsWith('/verify')).length, 1);
  assert.equal(resumed,0,'Pending verification cannot resume private views');
  finish({ data: { ok: true } }); await first;
  assert.equal(f.locked(), false); assert.equal(f.storage.get('tli_session_unlocked'), '1'); assert.equal(f.nodes['tli-lock-input'].value, '');
  assert.equal(resumed,1,'A confirmed unlock resumes subscribed views exactly once');
});

test('a late verification success cannot reopen a manually locked view', async () => {
  const f = fixture(); let resumed=0; f.ctx.window.addEventListener('tli-session-unlocked',()=>resumed++);
  await f.init(); let finish; f.handler(url => url.endsWith('/lock') ? { data: { ok: true, locked: true } } : new Promise(resolve => { finish = resolve; })); f.nodes['tli-lock-input'].value = '1234';
  const pending = f.nodes['tli-lock-submit'].click(); const locking = f.nodes['tli-lock-btn'].click();
  assert.equal(f.calls.filter(c => c.url.endsWith('/lock')).length, 0);
  finish({ data: { ok: true } }); await Promise.all([pending, locking]);
  assert.equal(f.locked(), true); assert.equal(f.storage.has('tli_session_unlocked'), false); assert.equal(f.nodes['tli-lock-submit'].disabled, false);
  assert.equal(f.calls.filter(c => c.url.endsWith('/lock')).length, 1);
  assert.equal(resumed,0,'A stale authentication response must not resume any views');
});

test('header and shortcut lock share one request and clear a previously unlocked hint immediately', async () => {
  const f = fixture({ unlocked: true }); await f.init(); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const first = f.ctx.window.TLIPinLock.lock(); const second = f.nodes['tli-lock-btn'].click();
  assert.equal(f.locked(), true); assert.equal(f.storage.has('tli_session_unlocked'), false);
  assert.equal(f.calls.filter(c => c.url.endsWith('/lock')).length, 1);
  finish({ data: { ok: true, locked: true } }); await Promise.all([first, second]);
  assert.match(f.nodes['tli-lock-error'].textContent, /Browser session locked/);
});

test('unconfirmed server lock stays locally locked and offers explicit retry without claiming success', async () => {
  for (const response of [{ status: 503, data: { detail: 'Saved PIN unavailable.' } }, { data: { ok: true } }, { invalidJSON: true }]) {
    const f = fixture({ unlocked: true }); await f.init(); f.handler(async () => response);
    await assert.rejects(f.ctx.window.TLIPinLock.lock());
    assert.equal(f.locked(), true); assert.equal(f.storage.has('tli_session_unlocked'), false);
    assert.match(f.nodes['tli-lock-error'].textContent, /server session may still be active/);
    assert.equal(f.nodes['tli-lock-retry'].hidden, false); assert.equal(f.calls.filter(c => c.url.endsWith('/lock')).length, 1);
    f.handler(async () => ({ data: { ok: true, locked: true } })); await f.nodes['tli-lock-retry'].click();
    assert.equal(f.nodes['tli-lock-retry'].hidden, true); assert.equal(f.calls.filter(c => c.url.endsWith('/lock')).length, 2);
  }
});

test('Forgot PIN presents preservation guidance and only performs a read-only status check', async () => {
  const f = fixture(); await f.init(); await f.nodes['tli-lock-forgot'].click();
  assert.match(f.nodes['recovery-copy'].textContent, /cannot remove or bypass.*preserve.*matching backup.*original operating-system account/);
  assert.equal(f.nodes['tli-lock-reset-confirm-btn'].textContent, 'Recheck access status');
  await f.nodes['tli-lock-reset-confirm-btn'].click(); await f.nodes['tli-lock-reset-cancel-btn'].click();
  assert.equal(f.locked(), true); assert.ok(f.calls.every(c => c.url === '/system/pin/status' && !c.options.method));
  assert.doesNotMatch(source, /emergency-reset/);
});

test('Settings never presents missing or unavailable PIN status as a fresh setup', async () => {
  const first = settings.indexOf('async function _refreshPinUI()'), last = settings.indexOf('  const pinSaveBtn', first);
  for (const response of [{ status: 503, data: { detail: 'Saved security files unavailable' } }, { data: {} }, { data: { enabled: null } }]) {
    const f = fixture(); await f.init(); f.ctx.$ = id => f.nodes[id]; vm.runInContext(settings.slice(first, last), f.ctx); f.handler(async () => response);
    await f.ctx._refreshPinUI();
    assert.match(f.nodes['settings-pin-status-desc'].textContent, /PIN status unavailable/); assert.doesNotMatch(f.nodes['settings-pin-status-desc'].textContent, /No PIN set/);
    assert.equal(f.nodes['settings-pin-save'].disabled, true); assert.equal(f.nodes['settings-pin-remove'].disabled, true); assert.equal(f.nodes['settings-pin-callout'].style.display, 'none'); assert.equal(f.locked(), true);
    f.handler(async () => ({ data: { enabled: true } })); await f.ctx._refreshPinUI(); assert.equal(f.nodes['settings-pin-save'].disabled, false); assert.match(f.nodes['settings-pin-status-desc'].textContent, /PIN is set/);
  }
});
