const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/tli-update.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const flush = () => new Promise(setImmediate);
const available = { state: 'available', current_version: '1.3.4', latest_version: '1.3.5', platform: 'windows',
  update_method: 'guided', can_prepare: true, can_open: false, progress: 0, checked_at: '2026-10-11T15:30:00Z',
  auto_check: false, update_url: 'https://thelanintelligence.com/downloads.json', notes: 'A useful release.' };
const ready = { ...available, state: 'ready', can_prepare: false, can_open: true, ready_path: 'C:\\TLI\\updates\\1.3.5', progress: 100 };

function fixture(initial = available, options = {}) {
  const nodes = {}, calls = [], timers = new Map(), documentEvents = {}, windowEvents = {}, lifecycle = [], toasts = [];
  let serial = 0, handler = null, current = initial;
  class Element {
    constructor(id, markup = '') { this.id = id; this.handlers = {}; this.textContent = ''; this.value = ''; this.attrs = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.hidden = /\shidden(?:\s|>)/.test(markup); this.disabled = /\sdisabled(?:\s|>)/.test(markup); this.checked = false; }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    emit(name) { return Promise.all((this.handlers[name] || []).map(fn => fn({ target: this, currentTarget: this }))); }
    click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
  }
  for (const match of html.matchAll(/<[^>]+\bid="((?:tli-update-|settings-update-|settings-check-update-|settings-tli-version|version-pill-settings)[^"]*)"[^>]*>/g)) nodes[match[1]] = new Element(match[1], match[0]);
  const document = { readyState: 'loading', hidden: false, getElementById: id => nodes[id] || null, createElement: () => new Element(),
    addEventListener(name, fn) { (documentEvents[name] ||= []).push(fn); } };
  const window = { location: { href: options.url || 'http://127.0.0.1:8000/', reload() { assert.fail('Preparing an update must never reload'); } },
    TLIHostLifecycle: { open: (...args) => lifecycle.push(args) }, addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); } };
  const context = vm.createContext({ document, window, navigator: { userAgent: options.mobile ? 'iPhone Mobile' : 'Desktop', userAgentData: { mobile: !!options.mobile } }, URL, Date,
    setTimeout(fn, ms) { timers.set(++serial, { fn, ms }); return serial; }, clearTimeout(id) { timers.delete(id); },
    showToast: (...args) => toasts.push(args), fetch: async (url, request = {}) => {
      calls.push({ url, ...request });
      let result = handler ? await handler(url, request) : undefined;
      if (result === undefined) result = url === '/update/status' || url === '/update/check' ? current : { ok: true };
      return result && typeof result.json === 'function' ? result : { ok: true, status: 200, json: async () => result };
    } });
  vm.runInContext(source, context);
  return { nodes, calls, timers, lifecycle, toasts, document, setStatus(value) { current = value; }, handler(fn) { handler = fn; },
    async start() { for (const fn of documentEvents.DOMContentLoaded || []) await fn(); await flush(); },
    async poll(ms) { const timer = [...timers].find(([, value]) => !ms || value.ms === ms); assert.ok(timer, 'Expected a scheduled poll'); timers.delete(timer[0]); await timer[1].fn(); await flush(); },
    async visibility(hidden) { document.hidden = hidden; for (const fn of documentEvents.visibilitychange || []) await fn(); await flush(); },
    async event(name) { for (const fn of windowEvents[name] || []) await fn(); await flush(); } };
}

test('a dismissed banner leaves Settings download, release notes and current version available', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.nodes['tli-update-banner'].hidden, false);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
  assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.4');
  assert.match(f.nodes['settings-update-platform'].textContent, /Windows/);
  assert.doesNotMatch(f.nodes['settings-update-checked'].textContent, /not yet/);
  await f.nodes['tli-update-dismiss-btn'].click();
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  assert.equal(f.nodes['settings-update-action-btn'].hidden, false);
  await f.nodes['settings-update-notes-btn'].click();
  assert.equal(f.nodes['tli-update-notes-body'].textContent, available.notes);
  assert.equal(f.nodes['tli-update-notes-pop'].hidden, false);
  assert.equal(f.calls.length, 1, 'Release notes use the checked result');
});

test('idle startup discovers a delayed background result and keeps polling visible status without automatic POST checks', async () => {
  const f = fixture({ ...available, state: 'idle', latest_version: '' }); await f.start();
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [15000]);
  f.setStatus(available); await f.poll(15000);
  assert.equal(f.nodes['tli-update-banner'].hidden, false);
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [60000]);
  await f.poll(60000); assert.ok(f.calls.every(call => call.url === '/update/status' && !call.method));
  await f.visibility(true); assert.equal(f.timers.size, 0);
  const before = f.calls.length; await f.visibility(false); assert.equal(f.calls.length, before + 1);
  await f.event('pagehide'); assert.equal(f.timers.size, 0);
});

test('download submits JSON once, shows Settings progress and exposes pending installation without changing the running version', async () => {
  const f = fixture(); await f.start(); await f.nodes['tli-update-dismiss-btn'].click();
  let finish;
  f.handler(url => url === '/update/apply' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const pending = f.nodes['settings-update-action-btn'].click(); await flush();
  await f.nodes['tli-update-apply-btn'].emit('click');
  assert.equal(f.calls.filter(call => call.url === '/update/apply').length, 1);
  const call = f.calls.find(call => call.url === '/update/apply');
  assert.equal(call.method, 'POST'); assert.equal(call.headers['Content-Type'], 'application/json'); assert.equal(call.body, '{}');
  f.setStatus({ ...available, state: 'downloading', progress: 46 }); finish({ ok: true }); await pending;
  assert.equal(f.nodes['settings-update-progress-wrap'].hidden, false);
  assert.equal(f.nodes['settings-update-progress'].value, 46);
  assert.equal(f.nodes['tli-update-progress-bar'].style['--w'], '46%');
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  f.setStatus({ ...available, state: 'verifying' }); await f.poll(1500);
  f.setStatus({ ...available, state: 'preparing' }); await f.poll(1500);
  f.setStatus(ready); await f.poll(1500);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Open update folder');
  assert.match(f.nodes['settings-update-state'].textContent, /installation pending/);
  assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.4');
  assert.equal(f.nodes['settings-update-ready'].hidden, false);
  assert.match(f.nodes['settings-update-installer'].textContent, /TLI_Update\.bat/);
  assert.equal(f.nodes['settings-update-action-btn'].handlers.click.length, 1);
  assert.equal(f.nodes['tli-update-apply-btn'].handlers.click.length, 1);
  assert.equal(f.lifecycle.length, 0);
  await f.nodes['settings-update-quit-btn'].click();
  assert.equal(f.lifecycle.length, 1); assert.equal(f.lifecycle[0][0], 'quit');
  assert.equal(f.calls.some(call => /restart|quit|host-control/.test(call.url)), false);
});

test('preparation errors offer a fresh check instead of resubmitting apply, then restore download on success', async () => {
  const f = fixture(); await f.start();
  f.handler(url => url === '/update/apply' ? { ok: false, status: 503, json: async () => ({ detail: 'Download interrupted' }) } : undefined);
  await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Retry check');
  assert.match(f.nodes['settings-update-message'].textContent, /Download interrupted.*Retry/);
  await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.calls.filter(call => call.url === '/update/apply').length, 1);
  assert.equal(f.calls.filter(call => call.url === '/update/check').length, 1);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
});

test('opening a verified folder is retriable without losing ready state or automatically quitting TLI', async () => {
  const f = fixture(ready); await f.start();
  f.handler(url => url === '/update/open' ? { ok: false, status: 503, json: async () => ({ detail: 'File browser unavailable' }) } : undefined);
  await f.nodes['settings-update-action-btn'].click();
  assert.match(f.nodes['settings-update-message'].textContent, /Could not open.*File browser unavailable/);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Open update folder');
  assert.equal(f.nodes['settings-update-ready'].hidden, false);
  assert.match(f.nodes['settings-update-path'].textContent, /1\.3\.5/);
  f.handler(() => undefined); await f.nodes['tli-update-apply-btn'].click();
  const opens = f.calls.filter(call => call.url === '/update/open'); assert.equal(opens.length, 2);
  assert.ok(opens.every(call => call.body === '{}' && call.headers['Content-Type'] === 'application/json'));
  assert.match(f.nodes['settings-update-message'].textContent, /Update folder opened/);
  assert.equal(f.lifecycle.length, 0);
  assert.equal(f.calls.some(call => call.url === '/update/apply'), false);
});

test('remote browsers and phones cannot open host folders or quit; Mac ready instructions select the command updater', async () => {
  for (const options of [{ url: 'https://192.168.1.4:8000/' }, { mobile: true }]) {
    const unprepared = fixture(available, options); await unprepared.start();
    assert.equal(unprepared.nodes['settings-update-action-btn'].hidden, true);
    await unprepared.nodes['settings-update-action-btn'].emit('click'); assert.equal(unprepared.calls.length, 1);
    assert.match(unprepared.nodes['settings-update-message'].textContent, /local desktop browser/);
    const f = fixture(ready, options); await f.start();
    assert.equal(f.nodes['settings-update-action-btn'].hidden, true);
    assert.equal(f.nodes['settings-update-quit-btn'].hidden, true);
    await f.nodes['settings-update-action-btn'].emit('click'); await f.nodes['settings-update-quit-btn'].emit('click');
    assert.equal(f.calls.length, 1); assert.equal(f.lifecycle.length, 0);
    assert.match(f.nodes['settings-update-message'].textContent, /local desktop browser on the host/);
  }
  const mac = fixture({ ...ready, platform: 'macos' }); await mac.start();
  assert.match(mac.nodes['settings-update-installer'].textContent, /TLI_Update\.command/);
  assert.match(mac.nodes['settings-update-stop'].textContent, /Control\+C.*Host Start helper/);
  assert.equal(mac.nodes['settings-update-quit-btn'].hidden, true);
});

test('unsupported release packages use the official download page and never send apply', async () => {
  const f = fixture({ ...available, can_prepare: false, message: 'This release uses the website installer.' }); await f.start();
  assert.equal(f.nodes['settings-update-action-btn'].hidden, true);
  assert.equal(f.nodes['settings-update-manual-link'].hidden, false);
  assert.equal(f.nodes['settings-update-manual-link'].href, 'https://github.com/TheLANIntelligence/TLI/releases');
  assert.match(f.nodes['settings-update-message'].textContent, /website installer/);
  await f.nodes['settings-update-action-btn'].emit('click'); assert.equal(f.calls.length, 1);
});

test('HTTP failures, unreadable JSON and unsupported legacy done states never report success', async () => {
  for (const result of [{ ok: false, status: 403, json: async () => ({ detail: 'Unlock TLI first' }) },
    { ok: true, json: async () => { throw Error('Invalid JSON'); } }, {}, { ...ready, state: 'done' }]) {
    const f = fixture(); await f.start(); f.handler(url => url === '/update/check' ? result : undefined);
    await f.nodes['settings-check-update-btn'].click();
    assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Retry check');
    assert.equal(f.nodes['settings-update-action-btn'].disabled, false);
    assert.doesNotMatch(f.nodes['settings-update-state'].textContent, /Up to date|installation pending/);
    assert.equal(f.toasts.at(-1)[1], 'error');
    assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.4');
  }
});

test('status refresh failure can retry while preparation was previously active', async () => {
  const f = fixture({ ...available, state: 'verifying' }); await f.start();
  f.handler(url => url === '/update/status' ? { ok: false, status: 503, json: async () => ({ detail: 'Host unavailable' }) } : undefined);
  await f.poll(1500);
  assert.match(f.nodes['settings-update-message'].textContent, /Host unavailable/);
  assert.equal(f.nodes['settings-update-action-btn'].disabled, false);
  f.handler(() => undefined); f.setStatus(available); await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
});

test('an older passive GET cannot overwrite a newer user check', async () => {
  const f = fixture(); await f.start();
  let finish;
  f.handler(url => url === '/update/status' ? new Promise(resolve => { finish = resolve; }) : { ...available, state: 'up_to_date' });
  const pending = f.poll(15000); await flush();
  await f.nodes['settings-check-update-btn'].click(); finish(available); await pending;
  assert.equal(f.nodes['settings-update-state'].textContent, 'Up to date');
  assert.equal(f.nodes['settings-update-action-btn'].hidden, true);
});

test('reconnecting recovers unknown saved preferences without overwriting later unsaved edits', async () => {
  const f = fixture({ ...available, auto_check: null }); await f.start();
  assert.equal(f.nodes['settings-update-url-save'].disabled, true);
  f.setStatus(available); await f.nodes['settings-check-update-btn'].click();
  assert.equal(f.nodes['settings-update-url-save'].disabled, false);
  assert.equal(f.nodes['settings-update-auto-check'].checked, false);
  f.nodes['settings-update-url'].value = 'https://custom.example/releases.json';
  f.nodes['settings-update-auto-check'].checked = true;
  await f.nodes['settings-check-update-btn'].click();
  assert.equal(f.nodes['settings-update-url'].value, 'https://custom.example/releases.json');
  assert.equal(f.nodes['settings-update-auto-check'].checked, true);
});
