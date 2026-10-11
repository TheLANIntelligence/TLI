const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/cmd-palette.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const nodes = {}, events = {}, calls = [], toasts = [], panels = [];
  const timers = new Map(); let time = 0, nextTimer = 0;
  let respond = async () => ({ data: { ok: true } });
  function element() {
    const classes = new Set();
    return { children: [], handlers: {}, attrs: {}, dataset: {}, value: '', hidden: true, html: '',
      get innerHTML() { return this.html; }, set innerHTML(value) { this.html = value; this.children = []; },
      classList: { add: value => classes.add(value), contains: value => classes.has(value) },
      setAttribute(key, value) { this.attrs[key] = value; },
      appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; this.cleared = true; },
      querySelector() { return null; }, focus() {}, scrollIntoView() { this.scrolled = true; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      fire(event, data = {}) { return this.handlers[event]?.({ preventDefault() {}, ...data }); },
    };
  }
  for (const id of ['tli-cmd-overlay', 'tli-cmd-input', 'tli-cmd-results', 'panel-visualizer', 'panel-dashboard2', 'panel-tools', 'cleanup-title', 'vault-content-area', 'vault-files-list', 'vault-secrets-list', 'vault-notes-list', 'vault-note-editor', 'tli-cmd-saved-status', 'panel-main']) nodes[id] = element();
  const ctx = vm.createContext({ console, Set, AbortController, TextDecoder,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; }, clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => fn(),
    document: { activeElement: null, querySelectorAll: () => [], getElementById: id => nodes[id] || null, createElement: element, addEventListener() {} },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    switchPanel: panel => panels.push(panel), showToast: (...value) => toasts.push(value),
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = url === '/tools/list' ? { data: { tools: [{ id: 'diagnostic', label: 'Sample diagnostic' }] } } : url === '/mesh/directory' ? { data: { devices: [] } } : await respond(url, options);
      if (response.raw) return response.raw;
      return { ok: (response.status || 200) === 200, status: response.status || 200, json: async () => { if (response.badJSON) throw new Error('Bad JSON'); return response.data; } };
    },
  });
  vm.runInContext(source, ctx);
  return { ctx, nodes, calls, toasts, panels,
    async advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } await tick(); },
    async search(query) { ctx.window.TLICmdPalette.open(); await tick(); nodes['tli-cmd-input'].value = query; nodes['tli-cmd-input'].fire('input'); await this.advance(300); },
    respond: fn => { respond = fn; },
    async choose(term) {
      ctx.window.TLICmdPalette.open(); await tick();
      nodes['tli-cmd-input'].value = term; nodes['tli-cmd-input'].fire('input');
      assert.equal(nodes['tli-cmd-results'].children.length, 1, `Expected one match for ${term}`);
      nodes['tli-cmd-input'].fire('keydown', { key: 'Enter' }); await tick();
    },
    lockEvent() { events['tli-session-locked'](); },
    actions: () => calls.filter(call => !['/tools/list', '/mesh/directory'].includes(call.url)),
  };
}

test('Phone Companion search opens its real destination without issuing a native or satellite invitation', async () => {
  const f = fixture();
  f.nodes['panel-companion'] = f.ctx.document.createElement('section');
  f.ctx.window.TLIUI = {navigation: [{id: 'panel-companion', label: 'Phone Companion', purpose: 'Connect the installed app', aliases: 'pairing QR iPhone Android'}]};
  await f.choose('pairing QR');
  assert.deepEqual(f.panels, ['panel-companion']);
  assert.equal(f.calls.filter(call => /companion|satellite/.test(call.url)).length, 0);
  assert.equal(f.calls.filter(call => call.options?.method && call.options.method !== 'GET').length, 0);
});

test('Lock TLI invokes explicit browser revocation, not the unlocked status check', async () => {
  const f = fixture(); let locks = 0;
  f.ctx.window.TLIPinLock = { lock: async () => { locks++; }, checkAndLock() { assert.fail('Status check cannot lock a browser'); } };
  await f.choose('Lock TLI'); assert.equal(locks, 1);
  f.ctx.window.TLIPinLock.lock = async () => { throw new Error('Session revocation unconfirmed'); };
  await f.choose('Lock TLI'); assert.match(f.toasts.at(-1)[0], /unconfirmed/); assert.equal(f.toasts.at(-1)[1], 'error');
});

test('Vault lock checks HTTP and handler results before clearing content or reporting success', async () => {
  for (const response of [{ status: 401, data: { detail: 'Unlock required' } }, { data: { ok: false } }, { data: {} }, { badJSON: true }]) {
    const f = fixture(); f.respond(async () => response); await f.choose('Lock Vault');
    assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0][1], 'error');
    assert.equal(f.nodes['vault-secrets-list'].cleared, undefined);
  }
  const f = fixture(); f.respond(async () => ({ data: { ok: true } })); await f.choose('Lock Vault');
  assert.equal(f.nodes['vault-secrets-list'].cleared, true);
  assert.equal(f.nodes['vault-content-area'].classList.contains('hidden'), true);
  assert.match(f.toasts[0][0], /Vault locked for this TLI account/);
});

test('Vault shortcut uses the shared lock workflow and never announces a cancelled or failed lock', async () => {
  for (const confirmed of [false, true]) {
    const f = fixture(); let locks = 0, finish;
    f.ctx.window.TLIVault = { lock: () => { locks++; return new Promise(resolve => { finish = resolve; }); } };
    await f.choose('Lock Vault'); await f.choose('Lock Vault');
    assert.equal(locks, 1); assert.equal(f.actions().length, 0); assert.equal(f.toasts.length, 0);
    finish(confirmed); await tick();
    assert.equal(f.toasts.length, confirmed ? 1 : 0);
    if (confirmed) assert.match(f.toasts[0][0], /Vault locked for this TLI account/);
    assert.equal(f.nodes['vault-secrets-list'].cleared, undefined, 'Only the Vault controller owns clearing private state');
  }
});

test('rotation distinguishes confirmed rotation, harmless no-op, nested failure and unknown result', async () => {
  for (const [result, kind, message] of [
    [{ rotated: true }, 'success', /Logs rotated/],
    [{ rotated: false, reason: 'size below threshold' }, 'info', /No rotation was needed/],
    [{ rotated: false, reason: 'log file does not exist' }, 'info', /No log file/],
    [{ rotated: false, reason: 'error during rotation: permission denied' }, 'error', /permission denied/],
    [{}, 'error', /incomplete/],
  ]) {
    const f = fixture(); f.respond(async () => ({ data: { ok: true, task_id: 'rotate_logs', result } })); await f.choose('Rotate Logs');
    assert.equal(f.toasts[0][1], kind); assert.match(f.toasts[0][0], message);
    assert.deepEqual(JSON.parse(f.actions()[0].options.body), { task_id: 'rotate_logs' });
  }
});

test('pending actions cannot execute twice after the palette is reopened and may be retried explicitly after failure', async () => {
  const f = fixture(); let reject;
  f.respond(() => new Promise((_, failure) => { reject = failure; })); await f.choose('Rotate Logs'); await f.choose('Rotate Logs');
  assert.equal(f.actions().length, 1); assert.equal(f.toasts.length, 0);
  assert.equal(f.nodes['tli-cmd-results'].children[0].attrs['aria-disabled'], 'true');
  reject(new Error('Connection lost; outcome unknown')); await tick();
  assert.equal(f.toasts[0][1], 'error'); assert.equal(f.actions().length, 1);
  f.respond(async () => ({ data: { ok: true, task_id: 'rotate_logs', result: { rotated: true } } }));
  await f.choose('Rotate Logs'); assert.equal(f.actions().length, 2); assert.equal(f.toasts.at(-1)[1], 'success');
});

test('cleanup and dashboard shortcuts open their existing panels without claiming completed work', async () => {
  const f = fixture(); let reviews = 0; f.ctx.window.TLIStorageWorkspace = { openCleanup() { reviews++; } };
  await f.choose('Review Temp Cleanup'); assert.equal(reviews, 1);
  assert.equal(f.panels[0], 'panel-visualizer'); assert.match(f.toasts[0][0], /No files were deleted/);
  assert.equal(f.nodes['cleanup-title'].scrolled, true); assert.equal(f.actions().length, 0);
  await f.choose('refresh dashboard'); assert.equal(f.panels[1], 'panel-dashboard2');
  assert.match(f.toasts.at(-1)[0], /observation times/); assert.doesNotMatch(f.toasts.at(-1)[0], /refreshed/);
  assert.equal(f.actions().length, 0);
});

test('dynamic tool selection opens Tools and never sends a run request', async () => {
  const f = fixture(); await f.choose('Sample diagnostic');
  assert.equal(f.panels[0], 'panel-tools'); assert.match(f.toasts[0][0], /has not run/);
  assert.equal(f.actions().length, 0);
});

test('late results after a session lock do not emit completion messages', async () => {
  const f = fixture(); let finish;
  f.respond(() => new Promise(resolve => { finish = resolve; })); await f.choose('Rotate Logs'); f.lockEvent();
  finish({ data: { ok: true, task_id: 'rotate_logs', result: { rotated: true } } }); await tick();
  assert.equal(f.toasts.length, 0); assert.equal(f.actions().length, 1);
});

test('a Vault completion after browser lock does not reload private Vault state', async () => {
  const f = fixture(); let finish, refreshed = 0; f.ctx.fetchVaultStatus = async () => { refreshed++; };
  f.respond(() => new Promise(resolve => { finish = resolve; })); await f.choose('Lock Vault'); f.lockEvent();
  finish({ data: { ok: true } }); await tick();
  assert.equal(refreshed, 0); assert.equal(f.toasts.length, 0);
});

const savedData = query => ({
  notes: { facts: [{ id: 'f-router', title: 'Router note', text: 'Private body ' + query, revision: 'a'.repeat(64) }] },
  chats: { ok: true, protocol: 'conversation-search-v1', query, items: [{ id: 'chat-router', title: 'Router conversation' }], coverage: { complete: true }, next_cursor: null },
  places: { ok: true, protocol: 'saved-places-v1', places: [{ id: 'b'.repeat(32), name: 'Router folder', target: 'N:\\Router', kind: 'folder' }] },
});
function savedReplies(f, data = savedData('router')) {
  f.respond(async url => ({ data: url.includes('/memory') ? data.notes : url.includes('/conversation-search') ? data.chats : data.places }));
}

test('saved search starts only while open after two characters and one 300ms debounce', async () => {
  const f = fixture(); savedReplies(f);
  f.ctx.window.TLICmdPalette.open(); await tick(); assert.equal(f.actions().length, 0);
  const input = f.nodes['tli-cmd-input'];
  input.value = 'r'; input.fire('input'); await f.advance(400); assert.equal(f.actions().length, 0);
  input.value = 'rou'; input.fire('input'); await f.advance(150);
  input.value = 'router'; input.fire('input'); await f.advance(299); assert.equal(f.actions().length, 0);
  await f.advance(1); assert.equal(f.actions().length, 3);
  assert.ok(f.actions().every(c => c.options.cache === 'no-store' && c.options.credentials === 'same-origin' && c.options.signal));
  assert.equal(f.actions()[0].url, '/api/intelligence/memory', 'No legacy device or caller-chosen owner parameter');
  assert.match(f.actions()[1].url, /limit=6$/); assert.doesNotMatch(f.actions()[1].url, /cursor/);
  assert.equal(f.nodes['tli-cmd-results'].children.length, 3);
  assert.ok(f.nodes['tli-cmd-results'].children.every(n => !n.innerHTML.includes('Private body')));
  f.ctx.window.TLICmdPalette.close(); await f.advance(20000); assert.equal(f.actions().length, 3);
  assert.equal(f.nodes['tli-cmd-results'].children.length, 0); assert.equal(f.nodes['tli-cmd-saved-status'].textContent, '');
});

test('saved results close search before opening existing views and never attach, send, check or scan', async () => {
  for (const [category, controller] of [['Note', 'note'], ['Chat', 'chat'], ['Favorite', 'favorite']]) {
    const f = fixture(); savedReplies(f); const opened = [];
    const record = (...args) => { assert.equal(f.nodes['tli-cmd-overlay'].hidden, true); opened.push(args); };
    f.ctx.window.TLINotebook = { open: record, requestContext() { assert.fail('No attachment'); } };
    f.ctx.window.loadConversation = record;
    f.ctx.window.TLIPlaces = { openFavorite: record, open() { assert.fail('Do not prefill Add favorite'); } };
    await f.search('router');
    const item = f.nodes['tli-cmd-results'].children.find(n => n.innerHTML.includes('>' + category + '</span>'));
    assert.ok(item); item.fire('mousedown'); await tick();
    assert.equal(opened.length, 1); assert.equal(f.actions().length, 3); assert.equal(f.toasts.length, 0);
    if (controller === 'note') assert.deepEqual(JSON.parse(JSON.stringify(opened[0])), [{ id: 'f-router', revision: 'a'.repeat(64) }, { source: 'search' }]);
    if (controller === 'chat') assert.deepEqual(f.panels, ['panel-main']);
    if (controller === 'favorite') assert.equal(opened[0][0], 'b'.repeat(32));
  }
});

test('query changes and lock abort reads and discard late owner results', async () => {
  const f = fixture(), waiting = []; const data = savedData('router');
  f.respond((url, options) => new Promise(resolve => waiting.push({ url, options, resolve })));
  await f.search('router'); assert.equal(waiting.length, 3);
  f.nodes['tli-cmd-input'].value = 'other'; f.nodes['tli-cmd-input'].fire('input');
  assert.ok(waiting.every(w => w.options.signal.aborted));
  waiting.forEach(w => w.resolve({ data: w.url.includes('memory') ? data.notes : w.url.includes('conversation-search') ? data.chats : data.places })); await tick();
  assert.equal(f.nodes['tli-cmd-results'].children.length, 0);
  await f.advance(300); assert.equal(waiting.length, 6); f.lockEvent();
  assert.ok(waiting.slice(3).every(w => w.options.signal.aborted));
  waiting.slice(3).forEach(w => w.resolve({ data: data.places })); await tick();
  assert.equal(f.nodes['tli-cmd-overlay'].hidden, true); assert.equal(f.nodes['tli-cmd-results'].children.length, 0);
  assert.equal(f.nodes['tli-cmd-saved-status'].textContent, ''); assert.equal(f.toasts.length, 0);
});

test('bounded results exclude legacy notes and distinguish partial or unavailable coverage', async () => {
  const f = fixture(), data = savedData('router');
  data.notes.facts = Array.from({ length: 15 }, (_, i) => ({ id: 'f-' + i, title: 'Router ' + i, revision: 'a'.repeat(64) }));
  data.notes.facts.unshift({ id: 'device-private', title: 'Router legacy', revision: 'a'.repeat(64) });
  data.chats.coverage.complete = false; data.chats.next_cursor = 'c'.repeat(32);
  savedReplies(f, data); await f.search('router');
  assert.equal(f.nodes['tli-cmd-results'].children.length, 8); assert.doesNotMatch(f.nodes['tli-cmd-results'].children.map(n => n.innerHTML).join(''), /legacy/);
  assert.match(f.nodes['tli-cmd-saved-status'].textContent, /Notes & fixes, Conversations: partial/); assert.equal(f.actions().length, 3);
  f.ctx.window.TLICmdPalette.close();
  f.respond(async url => url.includes('/memory') ? { data: { facts: [{ text: 'x'.repeat(300000) }] } } : url.includes('conversation-search') ? { status: 404, data: {} } : { data: data.places });
  await f.search('router'); assert.equal(f.nodes['tli-cmd-results'].children.length, 1);
  assert.match(f.nodes['tli-cmd-saved-status'].textContent, /Notes & fixes, Conversations unavailable or beyond the search limit/);
});

test('authentication rejection clears results without falling through to device or AI actions', async () => {
  const f = fixture(); f.respond(async () => ({ status: 401, data: { detail: 'Unlock required' } }));
  await f.search('router'); assert.equal(f.nodes['tli-cmd-overlay'].hidden, true);
  assert.equal(f.nodes['tli-cmd-results'].children.length, 0); assert.equal(f.toasts.length, 0);
});

test('shared navigation preserves old aliases and opens Saved notes without preparing chat', async () => {
  const f = fixture(); let notes = 0;
  f.ctx.window.TLIUI = { navigation: [{ id: 'panel-visualizer', label: 'Free Space', aliases: ['Storage'] }, { id: 'saved-notes', label: 'Saved notes', aliases: ['Notebook'] }] };
  f.ctx.window.TLINotebook = { open() { notes++; } };
  await f.choose('treemap'); assert.equal(f.panels[0], 'panel-visualizer');
  await f.choose('Notebook'); assert.equal(notes, 1); assert.equal(f.actions().length, 0);
});

test('streamed responses stop at the byte limit and record inspection never pages past its bound', async () => {
  const f = fixture(), data = savedData('router'); let reads = 0, cancelled = 0, released = 0;
  f.respond(async url => url.includes('/memory') ? { raw: { ok: true, status: 200, headers: { get: () => null }, body: {
    getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(1024 * 1024 + 1) }; }, cancel: async () => cancelled++, releaseLock: () => released++ }),
  } } } : { data: url.includes('conversation-search') ? data.chats : data.places });
  await f.search('router'); assert.equal(reads, 1); assert.equal(cancelled, 1); assert.equal(released, 1);
  assert.match(f.nodes['tli-cmd-saved-status'].textContent, /Notes & fixes unavailable or beyond the search limit/);
  f.ctx.window.TLICmdPalette.close();
  data.notes.facts = Array.from({ length: 1000 }, (_, i) => ({ id: 'f-' + i, title: 'Another topic', revision: 'a'.repeat(64) }));
  data.notes.facts.push({ id: 'f-beyond', title: 'Router past the bound', revision: 'a'.repeat(64) });
  savedReplies(f, data); await f.search('router');
  assert.equal(f.nodes['tli-cmd-results'].children.length, 2); assert.match(f.nodes['tli-cmd-saved-status'].textContent, /Notes & fixes: partial/);
  assert.equal(f.actions().length, 6);
});

test('search requests time out, and overlong input does not start unbounded work', async () => {
  const f = fixture();
  f.respond((_, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })));
  await f.search('router'); await f.advance(8000);
  assert.match(f.nodes['tli-cmd-saved-status'].textContent, /timed out/); assert.ok(f.actions().every(r => r.options.signal.aborted));
  f.nodes['tli-cmd-input'].value = 'x'.repeat(121); f.nodes['tli-cmd-input'].fire('input'); await f.advance(500);
  assert.equal(f.actions().length, 3); assert.match(f.nodes['tli-cmd-saved-status'].textContent, /120 characters/);
});

test('a cancelled old authentication reply cannot close a newly opened palette', async () => {
  const f = fixture(), pending = [];
  f.respond((url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
  await f.search('router'); f.ctx.window.TLICmdPalette.close();
  f.ctx.window.TLICmdPalette.open(); await tick();
  pending.forEach(p => p.resolve({ status: 401, data: {} })); await tick();
  assert.equal(f.nodes['tli-cmd-overlay'].hidden, false); assert.equal(f.nodes['tli-cmd-saved-status'].textContent, '');
});


test('hovering the active result preserves its DOM target for a subsequent pointer click', async () => {
  const f = fixture(); savedReplies(f); await f.search('router');
  const first = f.nodes['tli-cmd-results'].children[0];
  first.fire('mousemove'); assert.equal(f.nodes['tli-cmd-results'].children[0], first);
  first.fire('mousemove'); assert.equal(f.nodes['tli-cmd-results'].children[0], first);
});
