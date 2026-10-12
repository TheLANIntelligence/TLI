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
  windows: { url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_Windows.zip', sha256: 'a'.repeat(64) },
  macos: { url: 'https://github.com/TheLANIntelligence/TLI/releases/download/v1.4.0-beta/TLI_1.4.0-beta_macOS.zip', sha256: 'b'.repeat(64) },
};
const email = 'synthetic-reader@example.test';
const companion = { version: '0.1.0-beta.10', label: 'TLI Companion Beta 0.1.0 (10)',
  url: 'https://expo.dev/artifacts/eas/synthetic-companion.apk', filename: 'companion-beta.apk',
  sha256: 'c'.repeat(64), minimumAndroid: 7, size_bytes: 124703045 };
const token = 'a1'.repeat(32);
const config = { enabled: true, turnstileSiteKey: 'synthetic-public-sitekey' };
const selectedRelease = platform => platform === 'android' ? companion : { ...release[platform], version: release.version };
const verified = platform => ({ status: 'verified', platform, version: selectedRelease(platform).version, url: selectedRelease(platform).url });
const flush = async () => { for (let count = 0; count < 16; count++) await Promise.resolve(); };

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
    .map(match => [match[1], match[2] ?? match[3] ?? match[4] ?? '']));
}
function tagWithId(id) {
  return [...html.matchAll(/<[a-z][^>]*>/gi)].map(match => ({ tag: match[0], attrs: attributes(match[0]) }))
    .find(value => value.attrs.id === id);
}
function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fixture(options = {}) {
  const nodes = {}, calls = [], autoClicks = [], timers = new Map(), privateSideEffects = [], historyCalls = [], timeline = [], scripts = [], scrolls = [];
  let nextTimer = 0, widgetOptions, resetCount = 0;
  const handlers = {
    '/api/download/config': options.configHandler || (async () => reply(config)),
    '/api/download/request': async () => reply({ status: 'check_email' }, 202),
    '/api/download/verify': async () => reply(verified('windows')),
  };
  const document = { activeElement: null };
  function element(id, initial = {}) {
    const attrs = { ...(tagWithId(id)?.attrs || {}), ...initial }, listeners = new Map();
    const node = {
      id, attrs, dataset: {}, value: attrs.value || '', href: attrs.href || '', hidden: 'hidden' in attrs,
      disabled: 'disabled' in attrs, required: 'required' in attrs, type: attrs.type || '', name: attrs.name || '',
      textContent: '', innerHTML: '', style: {},
      addEventListener(type, callback) { const group = listeners.get(type) || []; group.push(callback); listeners.set(type, group); },
      async fire(type, extra = {}) {
        const event = { target: this, currentTarget: this, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; }, ...extra };
        await Promise.all((listeners.get(type) || []).map(callback => callback(event)));
        return event;
      },
      click() { autoClicks.push(id); return this.fire('click'); },
      focus() { document.activeElement = this; }, scrollIntoView(settings) { scrolls.push({ id, settings }); },
      setAttribute(name, value) { attrs[name] = String(value); if (name === 'href') this.href = String(value); },
      getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
      removeAttribute(name) { delete attrs[name]; if (name === 'href') this.href = ''; },
      checkValidity() { return !(this.required && !this.value) && (this.type !== 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value.trim())); },
      reportValidity() { return this.checkValidity(); },
    };
    nodes[id] = node;
    return node;
  }
  for (const id of ['download-email-form', 'download-email', 'download-platform', 'download-website', 'download-submit', 'email-status',
    'download-ready', 'download-file', 'mac-installer', 'copy-status', 'windows-sha256', 'macos-sha256', 'access',
    'email-verification', 'verify-email', 'verify-status', 'challenge-status', 'download-challenge',
    'companion-download', 'companion-file', 'companion-version', 'android-sha256', 'download-description']) element(id);
  const form = nodes['download-email-form'];
  form.reportValidity = () => nodes['download-email'].reportValidity() && nodes['download-platform'].reportValidity();
  const anchors = ['windows', 'macos', 'android'].flatMap(platform => [0, 1].map(index => {
    const anchor = element(`${platform}-${index}`, { href: '#access' });
    return Object.assign(anchor, { platform });
  }));
  document.getElementById = id => nodes[id] || null;
  document.querySelectorAll = selector => selector === '[data-copy]' ? []
    : anchors.filter(anchor => selector.includes(`[data-${anchor.platform}-download]`));
  document.createElement = tag => element(`${tag}-${scripts.length}`);
  document.head = { append(script) {
    scripts.push(script); timeline.push('script');
    if (options.scriptLoad !== false) queueMicrotask(() => script.fire(options.scriptError ? 'error' : 'load'));
  } };
  const forbid = kind => (...values) => { privateSideEffects.push({ kind, values }); throw new Error(`Forbidden ${kind}`); };
  let hash = options.hash || '';
  const location = { pathname: '/download/', search: '', origin: 'https://thelanintelligence.com', assign: forbid('location.assign'), replace: forbid('location.replace') };
  Object.defineProperty(location, 'hash', { get: () => hash, set: forbid('location.hash') });
  Object.defineProperty(location, 'href', { get: () => location.origin + location.pathname + hash, set: forbid('location.href') });
  const storage = { getItem: forbid('storage.read'), setItem: forbid('storage.write'), removeItem: forbid('storage.remove') };
  const window = {
    isSecureContext: true, location, localStorage: storage, sessionStorage: storage, open: forbid('window.open'),
    history: { replaceState(state, title, url) {
      if (options.historyFails) throw new Error('Synthetic history error');
      historyCalls.push({ state, title, url }); timeline.push('scrub'); hash = '';
    }, pushState: forbid('history.pushState') },
    turnstile: {
      render(selector, settings) { widgetOptions = settings; return 'synthetic-widget'; },
      reset() { resetCount++; },
    },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const fetch = async (url, request) => {
    calls.push({ url, options: request }); timeline.push(url);
    assert.ok(Object.hasOwn(handlers, url), 'Only the documented same-origin APIs may be fetched');
    return handlers[url](url, request);
  };
  const context = vm.createContext({ document, window, navigator: {}, fetch, PUBLIC_RELEASE: release, COMPANION_RELEASE: companion, AbortController,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, forbid(`console.${name}`)])),
  });
  vm.runInContext(source.replace(/^\s*import\s+\{\s*(?:PUBLIC_RELEASE|COMPANION_RELEASE)\s*\}\s+from\s+['"][^'"]+['"];?\s*/gm, ''), context);
  return { nodes, anchors, calls, timers, privateSideEffects, autoClicks, document, historyCalls, timeline, scripts, location, scrolls,
    get widgetOptions() { return widgetOptions; }, get resetCount() { return resetCount; },
    respond(api, callback) { handlers[`/api/download/${api}`] = callback; },
    fill(platform = 'windows', address = email) { nodes['download-email'].value = address; nodes['download-platform'].value = platform; },
    solve(value = 'synthetic-challenge') { widgetOptions.callback(value); },
    submit: () => form.fire('submit'), verify: () => nodes['verify-email'].fire('click'),
    async change(id, value, event = id === 'download-email' ? 'input' : 'change') { nodes[id].value = value; await nodes[id].fire(event); },
  };
}

function assertLocked(f) {
  assert.equal(f.nodes['download-ready'].hidden, true);
  assert.equal(f.nodes['mac-installer'].hidden, true);
  assert.equal(f.nodes['download-file'].href, '');
  assert.equal(f.nodes['companion-file'].href, '');
  assert.equal(f.nodes['companion-download'].hidden, true);
  assert.ok(f.anchors.every(anchor => anchor.href === '#access'));
  assert.equal(f.autoClicks.length, 0);
  assert.deepEqual(f.privateSideEffects, [], 'No email or token in browser storage, navigation or logs');
}
const posts = f => f.calls.filter(call => call.options.method === 'POST');
async function usable(options) { const f = fixture(options); await flush(); f.fill(); f.solve(); return f; }

test('static page is gated, accessible and has no third-party form fallback', () => {
  const links = [...html.matchAll(/<a\b[^>]*>/gi)].map(match => attributes(match[0]));
  const downloads = links.filter(attrs => 'data-windows-download' in attrs || 'data-macos-download' in attrs || 'data-android-download' in attrs);
  assert.equal(downloads.length, 5);
  assert.ok(downloads.every(attrs => attrs.href === '#access'));
  assert.ok(!links.some(attrs => /\/releases\/download\//.test(attrs.href || '')));
  assert.ok(!links.some(attrs => /\.apk(?:$|\?)/i.test(attrs.href || '')));
  assert.equal(tagWithId('download-email-form').attrs.action, '/api/download/request');
  assert.doesNotMatch(html + source, /formspree/i);
  for (const id of ['download-email', 'download-platform']) assert.ok('required' in tagWithId(id).attrs);
  assert.equal(tagWithId('download-email').attrs.type, 'email');
  assert.ok('disabled' in tagWithId('download-submit').attrs);
  assert.ok('disabled' in tagWithId('verify-email').attrs);
  assert.equal(tagWithId('verify-email').attrs.type, 'button');
  const select = html.match(/<select\b[^>]*id="download-platform"[^>]*>([\s\S]*?)<\/select>/i);
  assert.deepEqual([...select[1].matchAll(/<option\b[^>]*>/gi)].map(match => attributes(match[0]).value).filter(Boolean).sort(), ['android', 'macos', 'windows']);
  assert.equal(tagWithId('download-website').attrs.tabindex, '-1');
  assert.equal(tagWithId('download-website').attrs.autocomplete, 'off');
  assert.match(html, /class="email-honeypot" aria-hidden="true"/);
  for (const id of ['download-ready', 'mac-installer', 'email-verification', 'companion-download', 'companion-file']) assert.ok('hidden' in tagWithId(id).attrs);
  assert.ok(!('href' in tagWithId('download-file').attrs));
  assert.ok(!('href' in tagWithId('companion-file').attrs));
  assert.match(html, /<noscript>/);
});

test('configuration and a Cloudflare token are required; platform controls retain focus behavior', async () => {
  const f = fixture();
  assertLocked(f); assert.equal(f.nodes['download-submit'].disabled, true);
  await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/download/config');
  assert.equal(f.scripts[0].src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  assert.equal(f.widgetOptions.action, 'download_email');
  assert.equal(f.widgetOptions.sitekey, config.turnstileSiteKey);
  assert.equal(f.nodes['download-submit'].disabled, true);
  f.solve(); assert.equal(f.nodes['download-submit'].disabled, false);
  for (const anchor of f.anchors) {
    await anchor.fire('click');
    assert.equal(f.nodes['download-platform'].value, anchor.platform);
    assert.equal(f.document.activeElement, f.nodes['download-email']);
    assertLocked(f);
  }
});

test('disabled, missing or failed config never loads Turnstile, sends email or permits verification', async () => {
  for (const configHandler of [async () => reply({ enabled: false }), async () => reply({ enabled: true }),
    async () => reply({ enabled: true, turnstileSiteKey: ' ' }), async () => reply({ error: 'unavailable' }, 503),
    async () => { throw new Error('offline'); }, async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } })]) {
    const f = fixture({ configHandler, hash: '#verify=' + token }); await flush(); f.fill();
    await f.submit(); await f.verify();
    assert.equal(posts(f).length, 0); assert.equal(f.scripts.length, 0);
    assert.equal(f.nodes['download-submit'].disabled, true); assert.equal(f.nodes['verify-email'].disabled, true);
    assert.match(f.nodes['email-status'].textContent, /unavailable/); assertLocked(f);
  }
});

test('challenge load error or expiration stays gated and clears any previously accepted challenge token', async () => {
  const broken = fixture({ scriptError: true }); await flush(); broken.fill();
  await broken.submit(); assert.equal(posts(broken).length, 0); assertLocked(broken);
  for (const callback of ['expired-callback', 'error-callback']) {
    const f = await usable(); f.widgetOptions[callback](); await f.submit();
    assert.equal(f.nodes['download-submit'].disabled, true); assert.equal(posts(f).length, 0);
    assertLocked(f); f.solve(); await f.submit(); assert.equal(posts(f).length, 1);
  }
});

test('invalid email, missing challenge and unsupported platform cannot request a link', async () => {
  for (const [address, platform] of [['', 'windows'], ['not-an-email', 'macos'], [email, ''], [email, 'linux'], [email, '__proto__']]) {
    const f = await usable(); f.fill(platform, address); await f.submit();
    assert.equal(posts(f).length, 0); assertLocked(f);
  }
  const f = fixture(); await flush(); f.fill(); await f.submit(); assert.equal(posts(f).length, 0);
});

test('request acknowledgement only says check inbox; never reveals or starts a package download', async () => {
  for (const platform of ['windows', 'macos']) {
    const f = await usable(); f.fill(platform, '  ' + email + '  '); await f.submit();
    assert.equal(posts(f).length, 1);
    const { url, options } = posts(f)[0];
    assert.equal(url, '/api/download/request');
    assert.deepEqual(JSON.parse(options.body), { email, platform, turnstileToken: 'synthetic-challenge', website: '' });
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.match(f.nodes['email-status'].textContent, /Check your inbox/);
    assert.equal(f.resetCount, 1); assert.equal(f.nodes['download-submit'].disabled, true); assertLocked(f);
  }
});

test('request rejection, unexpected success body and transport errors never imply a sent email', async () => {
  for (const handler of [async () => reply({ error: 'disposable_email' }, 400), async () => reply({ error: 'rate_limited' }, 429),
    async () => reply({ error: 'delivery_failed' }, 503), async () => reply({ status: 'verified', url: release.windows.url }, 202),
    async () => reply({ status: 'check_email' }, 200), async () => { throw new Error('network'); }]) {
    const f = await usable(); f.respond('request', handler); await f.submit();
    assert.doesNotMatch(f.nodes['email-status'].textContent, /Check your inbox/);
    assert.equal(f.nodes['download-email'].value, email); assertLocked(f);
  }
});

test('honeypot value is sent to the server for rejection and never treated as verification', async () => {
  const f = await usable(); f.nodes['download-website'].value = 'synthetic-bot'; await f.submit();
  assert.equal(JSON.parse(posts(f)[0].options.body).website, 'synthetic-bot'); assertLocked(f);
});

test('email token is scrubbed before config or widget load and requires an explicit verification press', async () => {
  const f = fixture({ hash: '#verify=' + token });
  assert.deepEqual(f.historyCalls, [{ state: null, title: '', url: '/download/' }]);
  assert.equal(f.timeline[0], 'scrub'); assert.equal(f.location.hash, '');
  await flush(); assert.equal(posts(f).length, 0); assertLocked(f);
  assert.equal(f.nodes['email-verification'].hidden, false); assert.equal(f.nodes['verify-email'].disabled, false);
  assert.ok(!Object.values(f.nodes).some(node => (node.textContent + node.innerHTML + node.value).includes(token)));
  await f.verify(); assert.deepEqual(JSON.parse(posts(f)[0].options.body), { token });
});

test('only documented token fragments are accepted; malformed verification fragments are scrubbed', async () => {
  for (const hash of ['#verify=short', '#verify=' + token + '&platform=macos', '#verify=' + token + '0', '#verify=%61'.repeat(8)]) {
    const f = fixture({ hash }); await flush(); await f.verify();
    assert.equal(f.location.hash, ''); assert.equal(posts(f).length, 0); assertLocked(f);
    assert.match(f.nodes['verify-status'].textContent, /invalid/);
  }
  const other = fixture({ hash: '#windows' }); await flush();
  assert.equal(other.historyCalls.length, 0); assert.equal(other.nodes['email-verification'].hidden, true);
  const failed = fixture({ hash: '#verify=' + token, historyFails: true }); await flush(); await failed.verify();
  assert.equal(posts(failed).length, 0); assertLocked(failed);
});

test('email links reveal their verification panel and platform shortcuts preserve the pending token', async () => {
  let configure;
  const f = fixture({ hash: '#verify=' + token.toUpperCase(),
    configHandler: () => new Promise(resolve => { configure = resolve; }) });
  assert.equal(f.scrolls.at(-1).id, 'email-verification');
  for (const anchor of f.anchors) {
    await anchor.fire('click');
    assert.equal(f.nodes['email-verification'].hidden, false);
    assert.equal(f.nodes['download-platform'].value, '', 'Shortcut does not replace the emailed platform');
    assertLocked(f);
  }
  configure(reply(config)); await flush();
  assert.equal(f.document.activeElement, f.nodes['verify-email']);
  assert.equal(f.scrolls.at(-1).id, 'email-verification');
  for (const anchor of f.anchors) {
    await anchor.fire('click');
    assert.equal(f.document.activeElement, f.nodes['verify-email']);
    assert.equal(f.nodes['download-platform'].value, '');
    assert.equal(posts(f).length, 0, 'Shortcuts do not consume the token');
  }
  f.respond('verify', async () => reply(verified('macos')));
  await f.verify();
  assert.deepEqual(JSON.parse(posts(f)[0].options.body), { token });
  assert.equal(f.nodes['download-file'].href, release.macos.url);
});

test('platform shortcuts during verification do not invalidate an in-flight email confirmation', async () => {
  const f = fixture({ hash: '#verify=' + token }); await flush(); let confirm;
  f.respond('verify', () => new Promise(resolve => { confirm = resolve; }));
  const running = f.verify(); await flush();
  for (const anchor of f.anchors) await anchor.fire('click');
  assert.equal(posts(f).length, 1); assert.equal(f.nodes['email-verification'].hidden, false);
  confirm(reply(verified('windows'))); await running;
  assert.equal(f.nodes['download-file'].href, release.windows.url);
  assert.equal(f.nodes['download-ready'].hidden, false);
});

test('successful verification reveals the matching platform and a companion option only after verification', async () => {
  for (const platform of ['windows', 'macos', 'android']) {
    const f = fixture({ hash: '#verify=' + token }); await flush();
    f.respond('verify', async () => reply(verified(platform))); await f.verify();
    assert.equal(f.nodes['download-file'].href, selectedRelease(platform).url);
    assert.equal(f.nodes['companion-download'].hidden, false);
    assert.equal(f.nodes['companion-file'].hidden, platform === 'android');
    assert.equal(f.nodes['companion-file'].href, platform === 'android' ? '' : companion.url);
    assert.match(f.nodes['companion-version'].textContent, /Companion Beta/);
    assert.equal(f.nodes['android-sha256'].textContent, companion.sha256);
    assert.match(f.nodes['download-description'].textContent, platform === 'android' ? /APK/ : /ZIP/);
    assert.equal(f.nodes['download-ready'].hidden, false);
    assert.equal(f.nodes['mac-installer'].hidden, platform !== 'macos');
    assert.equal(f.nodes['download-platform'].value, platform);
    assert.equal(f.nodes['email-verification'].hidden, true);
    assert.equal(f.document.activeElement, f.nodes['download-file']);
    assert.equal(f.autoClicks.length, 0); assert.deepEqual(f.privateSideEffects, []);
    await f.verify(); assert.equal(posts(f).length, 1, 'Consumed in-memory token cannot be resubmitted');
    await f.change('download-email', email); assertLocked(f);
  }
});

test('verification rejects arbitrary URLs, mismatched platform/version, malformed JSON and failures', async () => {
  const invalid = [
    { ...verified('windows'), url: 'https://untrusted.example/file.zip' },
    { ...verified('windows'), url: release.macos.url },
    { ...verified('windows'), platform: '__proto__' },
    { ...verified('windows'), version: '0.0.0' },
    { ...verified('android'), url: 'https://untrusted.example/app.apk' },
    { ...verified('android'), version: release.version },
    { ...verified('windows'), url: companion.url },
    { ...verified('windows'), status: 'check_email' }, null,
  ];
  const handlers = invalid.map(body => async () => reply(body));
  handlers.push(async () => reply({ error: 'invalid_token' }, 400), async () => reply({ error: 'expired_token' }, 410),
    async () => reply({ error: 'unavailable' }, 503), async () => { throw new Error('offline'); },
    async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } }));
  for (const handler of handlers) {
    const f = fixture({ hash: '#verify=' + token }); await flush(); f.respond('verify', handler); await f.verify();
    assertLocked(f); assert.ok(f.nodes['verify-status'].textContent);
  }
});

test('duplicate requests are coalesced and edited forms cannot accept late acknowledgement', async () => {
  const f = await usable(); let complete;
  f.respond('request', () => new Promise(resolve => { complete = resolve; }));
  const running = f.submit(); await flush(); await f.submit(); assert.equal(posts(f).length, 1);
  assert.equal(f.nodes['download-submit'].disabled, true);
  await f.change('download-email', 'changed@example.test'); await f.change('download-email', email);
  complete(reply({ status: 'check_email' }, 202)); await running;
  assert.doesNotMatch(f.nodes['email-status'].textContent, /Check your inbox/); assertLocked(f);
});

test('duplicate verification is coalesced and changes during response decoding invalidate old tokens', async () => {
  const f = fixture({ hash: '#verify=' + token }); await flush(); let decoded;
  f.respond('verify', async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { decoded = resolve; }) }));
  const running = f.verify(); await flush(); await f.verify(); assert.equal(posts(f).length, 1);
  await f.change('download-platform', 'macos'); decoded(verified('windows')); await running;
  assertLocked(f); assert.equal(f.nodes['verify-email'].disabled, true);
});

test('request timeout aborts, stays locked and needs a fresh challenge before retry', async () => {
  const f = await usable();
  f.respond('request', (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')));
  }));
  const running = f.submit(); await flush();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0].callback(); await running;
  assert.match(f.nodes['email-status'].textContent, /could not confirm/);
  assert.equal(f.nodes['download-submit'].disabled, true); assertLocked(f);
});

test('valid email links can still be verified when the separate request challenge is unavailable', async () => {
  const f = fixture({ hash: '#verify=' + token, scriptError: true }); await flush();
  assert.equal(f.nodes['download-submit'].disabled, true); assert.equal(f.nodes['verify-email'].disabled, false);
  await f.verify(); assert.equal(f.nodes['download-file'].href, release.windows.url);
});
