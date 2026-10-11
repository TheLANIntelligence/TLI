const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../js/native-companion.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../native-companion.css'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const config = (host = '127.0.0.1', port = 8000, https = false) => ({ host, port, https });
const snapshot = (extra = {}) => ({ ok: true, configured: false, saved: config(), running: config(), effective_next: config(), restart_required: false, environment_overrides: [], ...extra });
const setup = { pairing_ready: false, pin_enabled: true, tls_enabled: false, lan_enabled: false, certificate_ready: false, origins: [] };
function descendants(n) { return n.children.flatMap(c => [c, ...descendants(c)]); }
const text = n => [n.textContent, ...descendants(n).map(c => c.textContent)].join(' ');
function fixture(initial = snapshot()) {
  const nodes = {}, events = {}, calls = [];
  let current = initial, handler;
  function element(tag) {
    const n = { tag, children: [], textContent: '', attrs: {}, dataset:{}, handlers: {}, value: '', hidden: false, disabled: false, checked: false, classList: { toggle() {}, contains(){return false;} },
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); },
      fire(k) { return Promise.all((this.handlers[k] || []).map(fn => fn({}))); }, click() { return this.disabled ? Promise.resolve() : this.fire('click'); }, select() {},focus(){},scrollIntoView(){},querySelectorAll(selector){return descendants(this).filter(n=>n.tag===selector);},
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = n; }, get() { return Object.keys(nodes).find(key => nodes[key] === n); } });
    return n;
  }
  nodes['panel-companion'] = element('section');
  const ctx = vm.createContext({ Date, AbortController, clearTimeout() {}, setTimeout() {},
    document: { readyState: 'complete', hidden: false, getElementById: id => nodes[id] || null, createElement: element, addEventListener() {} },
    window: { location: { origin: 'https://desktop.example.test:9443' }, addEventListener: (event, fn) => (events[event] ||= []).push(fn) },
    fetch: async (url, options) => {
      calls.push({ url, options }); let response = handler ? await handler(url, options) : undefined;
      if (response === undefined) response = { data: url.endsWith('/startup') ? current : url.endsWith('/setup') ? setup : { devices: [] } };
      return { ok: (response.status || 200) === 200, status: response.status || 200, json: async () => response.data };
    },
  });
  vm.runInContext(script, ctx);
  const root = nodes['native-companion-settings'];
  return { nodes, events, calls, root, handler(fn) { handler = fn; }, snapshot(value) { current = value; },
    async open() { await ctx.window.TLICompanion.onOpen(); await tick(); },
    async refresh() { await descendants(root).find(n => n.tag === 'button' && n.textContent === 'Refresh connection setup').click(); },
    async edit(mode = 'lan', port = '8443') { nodes['native-startup-mode'].value = mode; await nodes['native-startup-mode'].fire('change'); nodes['native-startup-port'].value = port; await nodes['native-startup-port'].fire('input'); },
    review: () => nodes['native-startup-review'].click(), save: () => nodes['native-startup-save'].click(),
  };
}

test('Companion startup settings load on opening without saving or restarting anything', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); await f.open();
  assert.equal(f.calls.filter(c => c.url.endsWith('/startup')).length, 1); assert.ok(f.calls.every(c => c.options.method === 'GET'));
  assert.match(text(f.nodes['native-startup-summary']), /Running now: HTTP.*Default startup.*Effective next startup/);
  assert.match(f.nodes['native-startup-current'].textContent, /https:\/\/desktop.example.test:9443/);
  assert.match(text(f.root), /Saving alone does not enable pairing/);
});

test('secure LAN choices need explicit review before save and preserve the current origin', async () => {
  const f = fixture(); await f.open(); await f.edit();
  assert.equal(f.nodes['native-startup-https'].checked, true); await f.save(); assert.ok(f.calls.every(c => c.options.method === 'GET'));
  await f.review();
  assert.equal(f.nodes['native-startup-review-box'].hidden, false);
  assert.match(f.nodes['native-startup-review-text'].textContent, /HTTPS.*0.0.0.0.*8443.*desktop.example.test:9443.*until you stop TLI/);
  assert.ok(f.calls.every(c => c.options.method === 'GET'));
});

test('a confirmed save changes only the saved display and performs one PUT with no restart or pairing call', async () => {
  const f = fixture(); await f.open(); await f.edit(); await f.review();
  let finish;
  f.handler((url, options) => options.method === 'PUT' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const saving = f.save(); await tick(); await f.save();
  const writes = f.calls.filter(c => c.options.method === 'PUT'); assert.equal(writes.length, 1);
  const requested = JSON.parse(writes[0].options.body); assert.deepEqual(requested, config('0.0.0.0', 8443, true));
  finish({ data: snapshot({ configured: true, saved: requested, effective_next: requested, restart_required: true }) }); await saving;
  assert.match(text(f.nodes['native-startup-summary']), /Running now: HTTP.*127.0.0.1.*8000.*Saved startup: HTTPS.*8443/);
  assert.match(f.nodes['native-startup-status'].textContent, /settings saved.*has not been restarted/);
  assert.equal(f.nodes['native-startup-review-box'].hidden, true); assert.equal(f.nodes['native-startup-save'].disabled, false);
  assert.ok(f.calls.every(c => c.options.method === 'GET' || c.url.endsWith('/startup') && c.options.method === 'PUT'));
});

test('failed saves retain previous saved state and reviewed choices without retrying', async () => {
  const f = fixture(); await f.open(); const previous = text(f.nodes['native-startup-summary']); await f.edit(); await f.review();
  f.handler((url, options) => options.method === 'PUT' ? { status: 409, data: { detail: 'Secure LAN access requires a valid owner PIN.' } } : undefined);
  await f.save();
  assert.equal(text(f.nodes['native-startup-summary']), previous); assert.equal(f.nodes['native-startup-port'].value, '8443');
  assert.equal(f.nodes['native-startup-review-box'].hidden, false); assert.match(f.nodes['native-startup-status'].textContent, /valid owner PIN.*not confirmed/);
  assert.equal(f.calls.filter(c => c.options.method === 'PUT').length, 1);
});

test('malformed or mismatched success cannot claim a saved startup change', async () => {
  for (const result of [{ ok: true }, snapshot(), snapshot({ saved: config('0.0.0.0', 8443, false) })]) {
    const f = fixture(); await f.open(); const previous = text(f.nodes['native-startup-summary']); await f.edit(); await f.review();
    f.handler((url, options) => options.method === 'PUT' ? { data: result } : undefined); await f.save();
    assert.equal(text(f.nodes['native-startup-summary']), previous); assert.match(f.nodes['native-startup-status'].textContent, /did not confirm/);
    assert.equal(f.nodes['native-startup-review-box'].hidden, false); assert.equal(f.nodes['native-startup-port'].value, '8443');
  }
});

test('environment overrides and an unconfirmed running bind stay explicit', async () => {
  const f = fixture(snapshot({ running: config(null, 9443, true), effective_next: config('192.0.2.8', 9443, true), restart_required: null, environment_overrides: ['TLI_HOST', 'TLI_PORT', 'TLI_ENABLE_TLS'] }));
  await f.open(); assert.match(text(f.nodes['native-startup-summary']), /bind address unconfirmed.*Environment overrides: TLI_HOST, TLI_PORT, TLI_ENABLE_TLS.*take precedence/);
  await f.edit(); await f.review(); assert.match(f.nodes['native-startup-review-text'].textContent, /effective next startup may differ/);
});

test('switching from secure LAN to local retains HTTPS until explicitly changed', async () => {
  const secure = config('0.0.0.0', 8443, true), f = fixture(snapshot({ configured: true, saved: secure, running: secure, effective_next: secure }));
  await f.open(); await f.edit('local'); await f.review(); assert.match(f.nodes['native-startup-review-text'].textContent, /HTTPS.*127.0.0.1/);
  f.nodes['native-startup-https'].checked = false; await f.nodes['native-startup-https'].fire('change');
  assert.equal(f.nodes['native-startup-review-box'].hidden, true); await f.review(); assert.match(f.nodes['native-startup-review-text'].textContent, /HTTP · 127.0.0.1/);
});

test('a loopback IPv6 host and local HTTPS survive a port-only change', async () => {
  const local = config('::1', 8443, true), f = fixture(snapshot({ configured: true, saved: local, running: local, effective_next: local }));
  await f.open(); f.nodes['native-startup-port'].value = '9443'; await f.nodes['native-startup-port'].fire('input'); await f.review();
  f.handler((url, options) => {
    if (options.method !== 'PUT') return;
    const saved = JSON.parse(options.body); assert.deepEqual(saved, config('::1', 9443, true));
    return { data: snapshot({ configured: true, saved, effective_next: saved, restart_required: true, running: local }) };
  }); await f.save(); assert.match(f.nodes['native-startup-status'].textContent, /settings saved/);
});

test('invalid ports cannot reach the save request', async () => {
  const f = fixture(); await f.open();
  for (const invalid of ['0', '65536', '-1', '1.5', '1e3', '']) {
    await f.edit('lan', invalid); await f.review(); await f.save();
    assert.equal(f.nodes['native-startup-review-box'].hidden, true); assert.match(f.nodes['native-startup-status'].textContent, /whole-number port/);
  }
  assert.ok(f.calls.every(c => c.options.method === 'GET'));
});

test('refresh retains unsaved form choices and requires another review', async () => {
  const f = fixture(); await f.open(); await f.edit(); await f.review();
  f.snapshot(snapshot({ configured: true, saved: config('localhost', 8080, true) })); await f.refresh();
  assert.equal(f.nodes['native-startup-mode'].value, 'lan'); assert.equal(f.nodes['native-startup-port'].value, '8443');
  assert.equal(f.nodes['native-startup-review-box'].hidden, true); assert.match(f.nodes['native-startup-status'].textContent, /unsaved choices/);
  assert.match(text(f.nodes['native-startup-summary']), /Saved startup: HTTPS.*localhost.*8080/);
});

test('authentication change ignores a pending startup mutation response', async () => {
  const f = fixture(); await f.open(); await f.edit(); await f.review(); let finish;
  f.handler((url, options) => options.method === 'PUT' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const saving = f.save(); await tick(); for (const clear of f.events['tli-session-locked']) clear();
  finish({ data: snapshot({ configured: true, saved: config('0.0.0.0', 8443, true), effective_next: config('0.0.0.0', 8443, true), restart_required: true }) }); await saving;
  assert.equal(f.nodes['native-startup-summary'].children.length, 0); assert.equal(f.nodes['native-startup-port'].value, '');
  assert.match(f.nodes['native-startup-status'].textContent, /Unlock TLI/);
});

test('unknown startup response leaves controls unavailable without inventing saved settings', async () => {
  const f = fixture(); f.handler((url) => url.endsWith('/startup') ? { data: { ok: true, saved: config() } } : undefined); await f.open();
  assert.equal(f.nodes['native-startup-summary'].children.length, 0); assert.match(f.nodes['native-startup-status'].textContent, /incomplete startup settings.*unavailable/);
  await f.review(); await f.save(); assert.ok(f.calls.every(c => c.options.method === 'GET'));
});

test('missing startup endpoint explains host support without prescribing a page-refresh retry loop', async () => {
  const f = fixture();
  f.handler(url => url.endsWith('/startup') ? { status: 404, data: { detail: 'Not Found' } } : undefined);
  await f.open();
  const message = f.nodes['native-startup-status'].textContent;
  assert.match(message, /running TLI server does not provide startup settings/);
  assert.match(message, /matching TLI installation.*If its files were updated/);
  assert.match(message, /Refreshing this page alone cannot add this feature/);
  assert.doesNotMatch(message, /Not Found|Refresh to try again/);
  assert.equal(f.nodes['native-startup-summary'].children.length, 0);
  assert.equal(f.nodes['native-startup-review'].disabled, true);
  assert.doesNotMatch(text(f.root), /review and save Secure home-network access below/);
  await f.review(); await f.save();
  assert.equal(f.calls.filter(call => call.url.endsWith('/startup')).length, 1);
  assert.ok(f.calls.every(call => call.options.method === 'GET'));
});

test('a failed refresh preserves the draft but blocks edits until current settings can be read', async () => {
  const f = fixture(); await f.open(); await f.edit(); await f.review();
  const previous = text(f.nodes['native-startup-summary']);
  f.handler(url => url.endsWith('/startup') ? { status: 404, data: { detail: 'Not Found' } } : undefined);
  await f.refresh();
  assert.equal(text(f.nodes['native-startup-summary']), previous);
  assert.equal(f.nodes['native-startup-port'].value, '8443');
  assert.equal(f.nodes['native-startup-port'].disabled, true);
  assert.equal(f.nodes['native-startup-review-box'].hidden, true);
  assert.match(f.nodes['native-startup-status'].textContent, /Previous startup details may be out of date/);
  await f.review(); await f.save(); assert.ok(f.calls.every(call => call.options.method === 'GET'));
  f.handler(undefined); await f.refresh();
  assert.equal(f.nodes['native-startup-port'].disabled, false);
  assert.equal(f.nodes['native-startup-port'].value, '8443');
  assert.equal(f.nodes['native-startup-review-box'].hidden, true);
});

test('startup authentication, permission and transport errors provide appropriate next steps', async () => {
  for (const [status, detail, expected] of [
    [401, 'Unauthorized', /Unlock TLI with your owner PIN/],
    [403, 'Pair devices from the TLI desktop page.', /browser page on the host.*owner PIN/],
    [403, 'Companion credentials require HTTPS.', /HTTPS address/],
    [0, '', /TLI could not be reached.*Check that the host is running/],
  ]) {
    const f = fixture();
    f.handler(url => {
      if (!url.endsWith('/startup')) return;
      if (!status) throw new TypeError('Failed to fetch');
      return { status, data: { detail } };
    });
    await f.open(); assert.match(f.nodes['native-startup-status'].textContent, expected);
    assert.doesNotMatch(f.nodes['native-startup-status'].textContent, /Unauthorized|Failed to fetch/);
    await f.review(); await f.save();
    assert.equal(f.calls.filter(call => call.url.endsWith('/startup')).length, 1);
    assert.ok(f.calls.every(call => call.options.method === 'GET'));
  }
});

test('missing phone setup endpoint clears previous readiness and never creates a pairing', async () => {
  const f = fixture(); await f.open();
  f.handler(url => url.endsWith('/setup') ? { status: 404, data: { detail: 'Not Found' } } : undefined);
  await f.refresh();
  assert.match(text(f.root), /running TLI server does not provide phone pairing setup/);
  assert.doesNotMatch(text(f.root), /Complete connection setup to pair|Ready to pair securely/);
  assert.ok(f.calls.every(call => call.options.method === 'GET'));
});

test('startup form provides phone-sized controls and a single-column phone layout', async () => {
  const f = fixture(); await f.open();
  assert.equal(f.nodes['native-startup-port'].inputMode, 'numeric'); assert.equal(f.nodes['native-startup-port'].min, '1'); assert.equal(f.nodes['native-startup-port'].max, '65535');
  assert.match(css, /\.native-companion button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /font-size:16px/); assert.match(css, /\.native-companion-startup-review button \{ width:100%/);
});
