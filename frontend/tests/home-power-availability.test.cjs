const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const librarySource = fs.readFileSync(path.join(__dirname, '../js/home-power-devices.js'), 'utf8');
const companionSource = fs.readFileSync(path.join(__dirname, '../js/companion.js'), 'utf8');
const device = { device_id: 'fixture-lamp', name: 'Fixture lamp', vendor: 'shelly', ip: '192.0.2.10', capabilities: ['switch.on', 'switch.off'] };

function element() {
  let html = '', text = '';
  const node = { value: '', children: [], buttons: [], handlers: {}, dataset: {}, style: {}, disabled: false, hidden: false,
    classList: { add() {}, remove() {} },
    setAttribute() {}, appendChild(child) { this.children.push(child); },
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
    fire(name) { return Promise.all((this.handlers[name] || []).map(fn => fn())); },
    click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
    querySelectorAll(selector) { return this.buttons.filter(button => button.css.includes(selector.slice(1))); },
  };
  Object.defineProperties(node, {
    innerHTML: { get: () => html, set(value) {
      html = value; text = ''; node.children = []; node.buttons = [];
      for (const match of value.matchAll(/<button[^>]*class="([^"]*)"[^>]*data-device-id="([^"]+)"[^>]*>/g)) {
        const button = element(); button.css = match[1].split(' '); button.dataset.deviceId = match[2]; node.buttons.push(button);
      }
    } },
    textContent: { get: () => text, set(value) { text = value; html = ''; node.children = []; node.buttons = []; } },
  });
  return node;
}

function fixture({ companion = false, response = { data: { devices: [device] } } } = {}) {
  const nodes = {}, calls = [], toasts = [], timers = [], ready = [];
  let handler = async () => response;
  for (const id of ['hp-vendor-select', 'hp-add-btn', 'hp-refresh-btn', 'hp-device-list', 'hp-extra-fields', 'hp-ip-input', 'hp-name-input', 'panel-homeauto', 'scenes-list', 'scenes-refresh-btn']) nodes[id] = element();
  nodes['hp-vendor-select'].value = 'shelly';
  const ctx = vm.createContext({ console, setTimeout: fn => timers.push(fn), confirm: () => true,
    MutationObserver: class { observe() {} },
    document: { readyState: 'loading', getElementById: id => nodes[id] || null, createElement: element, addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready.push(fn); } },
    showToast: (...args) => toasts.push(args), toast: (...args) => toasts.push(args), navigator: {},
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      const result = await handler(url, options);
      return { ok: (result.status || 200) < 300, status: result.status || 200, json: async () => { if (result.invalidJSON) throw new Error('Invalid JSON'); return result.data; } };
    },
  });
  if (companion) {
    const start = companionSource.indexOf('  const SCENE_ICONS');
    const end = companionSource.indexOf('  // ── Send to desktop', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(companionSource.slice(start, end), ctx);
  } else vm.runInContext(librarySource, ctx);
  return { ctx, nodes, calls, toasts, timers, handler(fn) { handler = fn; },
    async start() { if (companion) await ctx._loadScenes(); else { for (const fn of ready) fn(); await tick(); } },
    refresh: () => companion ? nodes['scenes-refresh-btn'].click() : nodes['hp-refresh-btn'].click(),
    writes: () => calls.filter(call => call.method !== 'GET'),
    button: css => nodes['hp-device-list'].querySelectorAll('.' + css)[0],
  };
}

test('unavailable or malformed HomePower inventory never becomes an empty library or enables adding', async () => {
  for (const response of [{ status: 503, data: { detail: 'Saved devices unavailable. Preserve the existing file.' } }, { data: {} }, { data: { devices: {} } }, { invalidJSON: true }, 'network']) {
    const f = fixture({ response });
    if (response === 'network') f.handler(async () => { throw new Error('Host unreachable'); });
    await f.start();
    assert.match(f.nodes['hp-device-list'].textContent, /Device library unavailable/);
    assert.doesNotMatch(f.nodes['hp-device-list'].innerHTML, /No devices|Add one/);
    assert.equal(f.nodes['hp-add-btn'].disabled, true);
    f.nodes['hp-ip-input'].value = '192.0.2.20'; await f.nodes['hp-add-btn'].fire('click');
    assert.equal(f.writes().length, 0);
    if (response.status === 503) assert.match(f.nodes['hp-device-list'].textContent, /Preserve the existing file/);
  }
});

test('a confirmed empty inventory remains a valid new library', async () => {
  const f = fixture({ response: { data: { devices: [] } } }); await f.start();
  assert.match(f.nodes['hp-device-list'].innerHTML, /No devices in library yet/);
  assert.equal(f.nodes['hp-add-btn'].disabled, false); assert.equal(f.writes().length, 0);
});

test('failed or unconfirmed device deletion never claims success and disables stale library actions', async () => {
  for (const response of [{ status: 503, data: { ok: true, detail: 'Preserve the saved device file.' } }, { data: { ok: false } }, { invalidJSON: true }, 'network']) {
    const f = fixture(); await f.start(); const remove = f.button('hp-delete-btn');
    f.handler(async () => { if (response === 'network') throw new Error('No response'); return response; });
    await remove.click(); await tick();
    assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].method, 'DELETE');
    assert.equal(f.toasts.some(toast => toast[0] === 'Device removed.'), false);
    assert.match(f.toasts.at(-1)[0], /removal unconfirmed/);
    assert.match(f.nodes['hp-device-list'].textContent, /Device library unavailable/);
    assert.equal(f.nodes['hp-add-btn'].disabled, true); assert.equal(f.nodes['hp-device-list'].buttons.length, 0);
  }
});

test('duplicate delete clicks share one pending write without automatically retrying it', async () => {
  const f = fixture(); await f.start(); const remove = f.button('hp-delete-btn'); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const pending = remove.click(); await remove.fire('click'); assert.equal(f.writes().length, 1);
  finish({ status: 503, data: { detail: 'Saved devices unavailable.' } }); await pending;
  for (const timer of f.timers) timer(); await tick(); assert.equal(f.writes().length, 1);
});

test('confirmed deletion followed by an unavailable refresh never paints an empty inventory', async () => {
  const f = fixture(); await f.start();
  f.handler(async (url, options) => options.method === 'DELETE' ? { data: { ok: true } } : { status: 503, data: { detail: 'Saved devices unavailable.' } });
  await f.button('hp-delete-btn').click();
  assert.equal(f.toasts.at(-1)[0], 'Device removed.');
  assert.match(f.nodes['hp-device-list'].textContent, /Device library unavailable/);
  assert.doesNotMatch(f.nodes['hp-device-list'].innerHTML, /No devices/); assert.equal(f.writes().length, 1);
});

test('device save errors preserve the entered draft and never claim an addition', async () => {
  for (const response of [{ status: 503, data: { ok: true, detail: 'Preserve the saved file.' } }, { data: { ok: false } }, { invalidJSON: true }]) {
    const f = fixture(); await f.start(); f.nodes['hp-ip-input'].value = '192.0.2.20'; f.nodes['hp-name-input'].value = 'New draft';
    f.handler(async () => response); await f.nodes['hp-add-btn'].click();
    assert.equal(f.writes().length, 1); assert.equal(f.toasts.some(toast => /^Added /.test(toast[0])), false);
    assert.match(f.toasts.at(-1)[0], /save unconfirmed/); assert.equal(f.nodes['hp-ip-input'].value, '192.0.2.20');
    assert.equal(f.nodes['hp-name-input'].value, 'New draft'); assert.equal(f.nodes['hp-add-btn'].disabled, true);
  }
});

test('explicit library refresh recovers after corruption without replaying the rejected save', async () => {
  const f = fixture({ response: { status: 503, data: { detail: 'Preserve the saved file.' } } }); await f.start();
  f.handler(async () => ({ data: { devices: [device] } })); await f.refresh();
  assert.match(f.nodes['hp-device-list'].innerHTML, /Fixture lamp/); assert.equal(f.nodes['hp-add-btn'].disabled, false);
  assert.equal(f.writes().length, 0);
});

test('an older inventory read cannot erase a newer unavailable result', async () => {
  const f = fixture(); await f.start(); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; })); const old = f.refresh();
  f.handler(async () => ({ status: 503, data: { detail: 'Saved file unavailable.' } })); await f.refresh();
  finish({ data: { devices: [device] } }); await old;
  assert.match(f.nodes['hp-device-list'].textContent, /Saved file unavailable/); assert.equal(f.nodes['hp-add-btn'].disabled, true);
});

test('a failed device status read reports its server error and sends no command', async () => {
  const f = fixture(); await f.start(); const status = f.button('hp-status-btn');
  f.handler(async () => ({ status: 503, data: { detail: 'Saved device file unavailable.' } })); await status.click();
  assert.equal(status.textContent, 'Status unavailable'); assert.match(f.toasts.at(-1)[0], /Saved device file unavailable/);
  assert.equal(f.writes().length, 0);
});

test('Companion scene read failures never cache an empty scene library and allow explicit recovery', async () => {
  for (const response of [{ status: 503, data: { detail: 'Saved scenes unavailable. Preserve the original file.' } }, { data: {} }, { data: { scenes: {} } }, { invalidJSON: true }, 'network']) {
    const f = fixture({ companion: true, response });
    if (response === 'network') f.handler(async () => { throw new Error('Host unreachable'); });
    await f.start();
    assert.match(f.nodes['scenes-list'].textContent, /Could not load scenes/); assert.doesNotMatch(f.nodes['scenes-list'].innerHTML, /No phone scenes saved/);
    if (response.status === 503) assert.match(f.nodes['scenes-list'].textContent, /Preserve the original file/);
    f.handler(async () => ({ data: { scenes: [] } })); await f.ctx._loadScenes();
    assert.match(f.nodes['scenes-list'].innerHTML, /No phone scenes saved/); assert.equal(f.calls.length, 2); assert.equal(f.writes().length, 0);
  }
});

test('Companion caches only a confirmed empty list and explicit refresh invalidates it', async () => {
  const f = fixture({ companion: true, response: { data: { scenes: [] } } }); await f.start(); await f.ctx._loadScenes();
  assert.equal(f.calls.length, 1);
  f.handler(async () => ({ status: 503, data: { detail: 'Saved scenes unavailable.' } })); await f.refresh(); await tick();
  assert.match(f.nodes['scenes-list'].textContent, /Could not load scenes/); assert.equal(f.calls.length, 2);
});

test('a late Companion scene response cannot replace a newer failed refresh', async () => {
  const f = fixture({ companion: true }); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; })); const old = f.start();
  f.handler(async () => ({ status: 503, data: { detail: 'Saved scenes unavailable.' } })); await f.refresh(); await tick();
  finish({ data: { scenes: [] } }); await old;
  assert.match(f.nodes['scenes-list'].textContent, /Saved scenes unavailable/); assert.doesNotMatch(f.nodes['scenes-list'].innerHTML, /No phone scenes saved/);
});
