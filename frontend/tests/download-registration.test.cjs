const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const landing = path.join(__dirname, '../../landing');
const html = fs.readFileSync(path.join(landing, 'download/index.html'), 'utf8');
const source = fs.readFileSync(path.join(landing, 'js/download.js'), 'utf8');
const release = {
  version: '1.4.0-beta',
  windows: { url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_Windows.zip', filename: 'TLI_1.4.0-beta_Windows.zip', sha256: 'a'.repeat(64) },
  macos: { url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_macOS.zip', filename: 'TLI_1.4.0-beta_macOS.zip', sha256: 'b'.repeat(64), command: 'curl -fsSL https://thelanintelligence.com/install_mac.sh | bash', installerUrl: 'https://thelanintelligence.com/install_mac.sh' },
};
const email = 'synthetic-reader@example.test';

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    result[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

function tagWithId(id) {
  return [...html.matchAll(/<[a-z][^>]*>/gi)].map(match => ({ tag: match[0], attrs: attributes(match[0]) }))
    .find(value => value.attrs.id === id);
}

function reply({ status = 200, body = { next: '/thanks' }, badJSON = false } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => {
    if (badJSON) throw new SyntaxError('Synthetic malformed response');
    return body;
  } };
}

function fixture() {
  const nodes = {}, calls = [], autoClicks = [], timers = new Map(), privateSideEffects = [];
  let nextTimer = 0, handler = async () => reply();
  const document = { activeElement: null };
  function element(id, initial = {}) {
    const attrs = { ...(tagWithId(id)?.attrs || {}), ...initial };
    const listeners = new Map();
    const node = {
      id, attrs, dataset: {}, value: attrs.value || '', href: attrs.href || '', hidden: 'hidden' in attrs,
      disabled: 'disabled' in attrs, required: 'required' in attrs, type: attrs.type || '',
      name: attrs.name || '', textContent: '', innerHTML: '', style: {}, customValidity: '',
      addEventListener(type, callback) { const group = listeners.get(type) || []; group.push(callback); listeners.set(type, group); },
      async fire(type, extra = {}) {
        const event = { target: this, currentTarget: this, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; }, ...extra };
        await Promise.all((listeners.get(type) || []).map(callback => callback(event)));
        return event;
      },
      click() { autoClicks.push(id); return this.fire('click'); },
      focus() { document.activeElement = this; }, scrollIntoView() {},
      setAttribute(name, value) { attrs[name] = String(value); if (name === 'href') this.href = String(value); if (name === 'hidden') this.hidden = true; },
      getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
      removeAttribute(name) { delete attrs[name]; if (name === 'href') this.href = ''; if (name === 'hidden') this.hidden = false; },
      setCustomValidity(value) { this.customValidity = value; },
      checkValidity() {
        if (this.customValidity || this.required && !this.value) return false;
        return this.type !== 'email' || !this.value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value.trim());
      },
      reportValidity() { return this.checkValidity(); },
      querySelector(selector) { return selector.includes('submit') ? nodes['download-submit'] : null; },
    };
    Object.defineProperty(node, 'validity', { get() { return { valid: this.checkValidity() }; } });
    nodes[id] = node;
    return node;
  }
  for (const id of ['download-email-form', 'download-email', 'download-platform', 'download-submit', 'email-status',
    'download-ready', 'download-file', 'mac-installer', 'copy-status', 'windows-sha256', 'macos-sha256', 'access']) element(id);
  Object.assign(nodes['download-email'], { type: 'email', name: 'email', required: true });
  Object.assign(nodes['download-platform'], { name: 'platform', required: true });
  const form = nodes['download-email-form'];
  form.action = tagWithId('download-email-form')?.attrs.action || 'https://formspree.io/f/xlgarvnq';
  form.elements = { email: nodes['download-email'], platform: nodes['download-platform'] };
  form.reportValidity = () => nodes['download-email'].reportValidity() && nodes['download-platform'].reportValidity();
  form.reset = () => { nodes['download-email'].value = ''; nodes['download-platform'].value = ''; };
  const anchors = ['windows', 'macos'].flatMap(platform => [0, 1].map(index => {
    const anchor = element(`${platform}-${index}`, { href: '#access' });
    anchor.dataset[`${platform}Download`] = '';
    return Object.assign(anchor, { platform });
  }));
  document.getElementById = id => nodes[id] || null;
  document.querySelectorAll = selector => {
    if (selector === '[data-copy]') return [];
    return anchors.filter(anchor => selector.includes(`[data-${anchor.platform}-download]`));
  };
  document.querySelector = selector => selector.startsWith('#') ? nodes[selector.slice(1)] : document.querySelectorAll(selector)[0] || null;
  const forbid = kind => (...values) => { privateSideEffects.push({ kind, values }); throw new Error(`Forbidden ${kind}`); };
  const location = {};
  for (const name of ['href', 'search', 'hash']) Object.defineProperty(location, name, {
    get: () => name === 'href' ? 'https://thelanintelligence.com/download/' : '', set: forbid(`location.${name}`),
  });
  Object.assign(location, { pathname: '/download/', origin: 'https://thelanintelligence.com', assign: forbid('location.assign'), replace: forbid('location.replace') });
  const storage = { getItem: forbid('storage.read'), setItem: forbid('storage.write'), removeItem: forbid('storage.remove') };
  const window = {
    isSecureContext: true, location, localStorage: storage, sessionStorage: storage,
    open: forbid('window.open'), history: { pushState: forbid('history'), replaceState: forbid('history') },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  class FakeFormData extends Map {
    constructor(currentForm) {
      super();
      if (currentForm) {
        this.set('email', nodes['download-email'].value);
        this.set('platform', nodes['download-platform'].value);
        this.set('_subject', 'TLI public beta download registration');
      }
    }
    set(key, value) { return super.set(String(key), String(value)); }
    append(key, value) { return this.set(key, value); }
  }
  const fetch = async (url, options) => { calls.push({ url, options }); return handler(url, options); };
  const ctx = vm.createContext({ document, window, location, navigator: {}, fetch, PUBLIC_RELEASE: release,
    FormData: FakeFormData, AbortController, URL, URLSearchParams,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    localStorage: storage, sessionStorage: storage,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, forbid(`console.${name}`)])),
  });
  vm.runInContext(source.replace(/^\s*import\s+\{\s*PUBLIC_RELEASE\s*\}\s+from\s+['"][^'"]+['"];?\s*/m, ''), ctx);
  return { nodes, anchors, calls, timers, privateSideEffects, autoClicks, document,
    respond(callback) { handler = callback; },
    fill(platform = 'windows', address = email) { nodes['download-email'].value = address; nodes['download-platform'].value = platform; },
    submit: () => form.fire('submit'),
    async change(id, value, event = id === 'download-email' ? 'input' : 'change') { nodes[id].value = value; await nodes[id].fire(event); },
  };
}

function assertLocked(f) {
  assert.equal(f.nodes['download-ready'].hidden, true, 'The ready panel must remain hidden');
  assert.equal(f.nodes['mac-installer'].hidden, true, 'The installer command must remain hidden');
  assert.ok(!Object.values(release).some(asset => asset.url && asset.url === f.nodes['download-file'].href), 'No package href may remain usable');
  assert.ok(f.anchors.every(anchor => anchor.href === '#access'), 'Platform links must continue to lead to registration');
  assert.equal(f.autoClicks.length, 0, 'No automatic package click');
  assert.deepEqual(f.privateSideEffects, [], 'Registration does not write PII to storage, URLs or logs');
}

test('static HTML requires email and platform while all four package links lead to registration', () => {
  const links = [...html.matchAll(/<a\b[^>]*>/gi)].map(match => attributes(match[0]));
  const downloads = links.filter(attrs => 'data-windows-download' in attrs || 'data-macos-download' in attrs);
  assert.equal(downloads.length, 4);
  assert.ok(downloads.every(attrs => attrs.href === '#access'));
  assert.ok(!links.some(attrs => /\/releases\/download\//.test(attrs.href || '')), 'No static ZIP link bypasses the form');
  const form = tagWithId('download-email-form');
  assert.ok(form);
  assert.equal(form.attrs.method.toLowerCase(), 'post');
  assert.match(form.attrs.action, /^https:\/\/formspree\.io\/f\/[a-z0-9]+$/i);
  for (const id of ['download-email', 'download-platform']) {
    assert.ok(Object.hasOwn(tagWithId(id)?.attrs || {}, 'required'), `${id} must be required`);
  }
  assert.equal(tagWithId('download-email').attrs.type, 'email');
  assert.equal(tagWithId('download-submit').attrs.type, 'submit');
  const select = html.match(/<select\b[^>]*id="download-platform"[^>]*>([\s\S]*?)<\/select>/i);
  assert.ok(select, 'Platform must be an explicit select');
  assert.deepEqual([...select[1].matchAll(/<option\b[^>]*>/gi)].map(match => attributes(match[0]).value).filter(Boolean).sort(), ['macos', 'windows']);
  for (const id of ['download-ready', 'mac-installer']) assert.ok(Object.hasOwn(tagWithId(id)?.attrs || {}, 'hidden'));
  assert.ok(!/\.zip(?:\?|$)/.test(tagWithId('download-file')?.attrs.href || ''));
});

test('page load is locked and each platform link selects its form value and focuses email', async () => {
  const f = fixture();
  assertLocked(f);
  assert.equal(f.calls.length, 0);
  for (const anchor of f.anchors) {
    await anchor.fire('click');
    assert.equal(f.nodes['download-platform'].value, anchor.platform);
    assert.equal(f.document.activeElement, f.nodes['download-email']);
    assertLocked(f);
  }
});

test('invalid email and unapproved platform never submit or unlock', async () => {
  for (const [address, platform] of [['', 'windows'], ['not-an-email', 'macos'], [email, ''], [email, 'linux'], [email, '__proto__']]) {
    const f = fixture(); f.fill(platform, address);
    await f.submit();
    assert.equal(f.calls.length, 0, `${address || 'empty email'} / ${platform || 'empty platform'}`);
    assertLocked(f);
  }
});

test('confirmed registration sends the selected release metadata and reveals only an explicit download link', async () => {
  for (const platform of ['windows', 'macos']) {
    const f = fixture(); f.fill(platform);
    await f.submit();
    assert.equal(f.calls.length, 1);
    const { url, options } = f.calls[0];
    assert.equal(url, f.nodes['download-email-form'].action);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.credentials, 'omit');
    for (const [key, expected] of Object.entries({ email, platform, release_version: release.version,
      asset_filename: release[platform].filename, request_kind: 'desktop_download_request', source_page: '/download/' })) {
      assert.equal(options.body.get(key), expected, key);
    }
    assert.ok(options.body.get('_subject'));
    assert.deepEqual([...options.body.keys()].sort(), ['_subject', 'asset_filename', 'email', 'platform', 'release_version', 'request_kind', 'source_page']);
    assert.equal(f.nodes['download-ready'].hidden, false);
    assert.equal(f.nodes['download-file'].href, release[platform].url);
    assert.equal(f.nodes['mac-installer'].hidden, platform !== 'macos');
    assert.equal(f.nodes['download-submit'].disabled, false);
    assert.equal(f.autoClicks.length, 0);
    assert.ok(f.anchors.every(anchor => anchor.href === '#access'));
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.privateSideEffects, []);
    assert.ok(!String(url).includes(email) && !f.nodes['download-file'].href.includes(email));
  }
});

test('non-2xx, malformed JSON, network failure and unacknowledged responses preserve input and remain locked', async () => {
  const responses = [() => reply({ status: 400 }), () => reply({ status: 503 }), () => reply({ badJSON: true }),
    ...[{}, null, [], 'accepted', { ok: true }, { next: '' }, { next: 1 },
      { next: '/thanks', error: null }, { next: '/thanks', errors: [] }].map(body => () => reply({ body })),
    () => { throw new Error('Synthetic network failure'); }];
  for (const respond of responses) {
    const f = fixture(); f.fill('macos'); f.respond(respond);
    await f.submit();
    assertLocked(f);
    assert.equal(f.nodes['download-email'].value, email);
    assert.equal(f.nodes['download-platform'].value, 'macos');
    assert.equal(f.nodes['download-submit'].disabled, false);
    assert.ok(f.nodes['email-status'].textContent.trim(), 'Failure must be visible');
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.privateSideEffects, []);
  }
});

test('acknowledged next URL is never followed and cannot choose a different download', async () => {
  const f = fixture(); f.fill('macos');
  f.respond(() => reply({ status: 201, body: { next: `https://untrusted.example/redirect?email=${email}` } }));
  await f.submit();
  assert.equal(f.nodes['download-ready'].hidden, false);
  assert.equal(f.nodes['download-file'].href, release.macos.url);
  assert.equal(f.autoClicks.length, 0);
  assert.deepEqual(f.privateSideEffects, []);
  assert.equal(f.calls.length, 1);
});

test('an in-flight duplicate submission is coalesced and never unlocks before acknowledgement', async () => {
  const f = fixture(); f.fill();
  let finish;
  f.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.submit();
  await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes['download-submit'].disabled, true);
  assertLocked(f);
  finish(reply()); await pending;
  assert.equal(f.nodes['download-ready'].hidden, false);
  assert.equal(f.nodes['download-submit'].disabled, false);
});

test('timeout aborts the bounded request, retains values, and requires an explicit retry', async () => {
  const f = fixture(); f.fill();
  f.respond((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Synthetic timeout')), { once: true });
  }));
  const pending = f.submit();
  assert.equal(f.timers.size, 1);
  const timer = [...f.timers.values()][0];
  assert.ok(timer.delay > 0 && timer.delay <= 30000);
  timer.callback(); await pending;
  assert.equal(f.calls[0].options.signal.aborted, true);
  assertLocked(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes['download-email'].value, email);
  assert.equal(f.nodes['download-platform'].value, 'windows');
  assert.equal(f.nodes['download-submit'].disabled, false);
  f.respond(() => reply()); await f.submit();
  assert.equal(f.calls.length, 2);
  assert.equal(f.nodes['download-ready'].hidden, false);
});

test('editing email or changing platform revokes a previously confirmed link and installer', async () => {
  for (const [id, value] of [['download-email', 'second-reader@example.test'], ['download-platform', 'windows']]) {
    const f = fixture(); f.fill('macos'); await f.submit();
    assert.equal(f.nodes['download-ready'].hidden, false);
    await f.change(id, value);
    assertLocked(f);
    assert.equal(f.calls.length, 1, 'Changing input does not send a registration automatically');
  }
});

test('late success cannot unlock after input changes, even when changed back before the response', async () => {
  for (const [id, changed, restored] of [['download-email', 'second-reader@example.test', email], ['download-platform', 'macos', 'windows']]) {
    for (const changeBack of [false, true]) {
      const f = fixture(); f.fill(); let finish;
      f.respond(() => new Promise(resolve => { finish = resolve; }));
      const pending = f.submit();
      await f.change(id, changed);
      if (changeBack) await f.change(id, restored);
      finish(reply()); await pending;
      assertLocked(f);
      assert.equal(f.nodes[id].value, changeBack ? restored : changed);
      assert.equal(f.calls.length, 1);
      assert.equal(f.nodes['download-submit'].disabled, false);
    }
  }
});

test('a platform-link click during a request invalidates the old selected-package response', async () => {
  const f = fixture(); f.fill('windows'); let finish;
  f.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.submit();
  await f.anchors.find(anchor => anchor.platform === 'macos').fire('click');
  finish(reply()); await pending;
  assert.equal(f.nodes['download-platform'].value, 'macos');
  assertLocked(f);
});

test('input changes during JSON decoding cannot expose a stale acknowledged link', async () => {
  const f = fixture(); f.fill(); let finishJSON;
  f.respond(() => ({ ok: true, status: 200, json: () => new Promise(resolve => { finishJSON = resolve; }) }));
  const pending = f.submit();
  await new Promise(setImmediate);
  assert.equal(typeof finishJSON, 'function');
  await f.change('download-email', 'second-reader@example.test');
  finishJSON({ next: '/thanks' }); await pending;
  assertLocked(f);
});
