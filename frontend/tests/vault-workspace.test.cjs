const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/vault.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const nodes = {}, events = {}, calls = [], toasts = [], confirmations = [], clipboard = [], urls = [], anchors = [];
  let handler = null, confirmation = true, now = Date.now(), timerId = 0;
  const timers = new Map();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  function element(tag = 'div') {
    let value = '', html = '', classes = new Set();
    const node = { tagName: tag.toUpperCase(), attrs: {}, dataset: {}, style: {}, children: [], handlers: {}, textContent: '', files: [], disabled: false, hidden: false, parentElement: null, root: false,
      get value() { return value; }, set value(next) { value = next; if (tag === 'input' && next === '') this.files = []; },
      get innerHTML() { return html; }, set innerHTML(next) { html = next; for (const child of this.children) child.parentElement = null; this.children = []; this.textContent = ''; },
      get className() { return [...classes].join(' '); }, set className(next) { classes = new Set(next.split(/\s+/)); },
      get isConnected() { return this.root || !!this.parentElement?.isConnected; },
      classList: { add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, contains(name) { return classes.has(name); }, toggle(name, force) { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; } },
      setAttribute(name, text) { this.attrs[name] = String(text); },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      async fire(name, data = {}) { return Promise.all((this.handlers[name] || []).map(fn => fn({ preventDefault() {}, ...data }))); },
      click() { if (tag === 'a') anchors.push({ href: this.href, filename: this.download }); return this.fire('click'); },
      focus() { this.focused = true; }, remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; },
    }; return node;
  }
  const ids = [...new Set([...source.matchAll(/\$\("([a-z0-9-]+)"\)/g)].map(match => match[1]))];
  ids.push('vault-setup-section', 'vault-auth-section', 'vault-status-pill', 'vault-state-message', 'vault-gate-title', 'vault-secret-status', 'vault-note-status', 'vault-message', 'vault-open-security', 'vault-add-file', 'vault-add-secret', 'vault-reset-confirm-input', 'sv-status-desc', 'sv-reset-confirm', 'sv-reset-password', 'sv-reset-btn', 'sv-export-btn');
  for (const kind of ['files', 'secrets', 'notes']) for (const suffix of ['list', 'search', 'status', 'count']) ids.push(`vault-${kind}-${suffix}`);
  for (const id of ids) { nodes[id] = element(id.includes('input') || id.includes('password') || id.includes('passphrase') ? 'input' : 'div'); nodes[id].id = id; nodes[id].root = true; }
  nodes['vault-password'].type = 'password'; nodes['vault-note-editor'].classList.add('hidden'); nodes['vault-files-sort'].value = 'name';
  const tabs = ['files', 'secrets', 'notes'].map((kind, index) => { const tab = element('button'); tab.dataset.vaultTab = kind; if (!index) tab.classList.add('is-active'); nodes[`vault-tab-${kind}`] = element(); nodes[`vault-tab-${kind}`].id = `vault-tab-${kind}`; return tab; });
  const body = element('body'); body.root = true; const authCard = element(), tabBar = element();
  const document = { body, createElement: element, querySelector: selector => selector === '.vault-auth-card' ? authCard : selector === '.vault-tab-bar' ? tabBar : null,
    querySelectorAll: selector => selector === '.vault-tab' ? tabs : selector === '.vault-tab-pane' ? tabs.map(tab => nodes['vault-tab-' + tab.dataset.vaultTab]) : [], addEventListener(name, fn) { (events[name] ||= []).push(fn); } };
  const responses = { '/vault/status': { initialized: true, unlocked: true }, '/vault/list': { files: [{ id: 'small_txt', name: 'small_txt', size: 42, size_display: '42 B' }, { id: 'large_txt', name: 'large_txt', size: 800, size_display: '800 B' }] }, '/vault/secrets': { keys: ['wifi'] }, '/vault/notes': { notes: [{ id: '__note_First', title: 'First' }, { id: '__note_Second', title: 'Second' }] } };
  const context = vm.createContext({ console, Date: Clock, Map, Set, $: id => nodes[id] || null, document,
    window: { addEventListener(name, fn) { (events[name] ||= []).push(fn); }, dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    FormData: class { append() {} }, navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    URL: { createObjectURL: blob => { const url = 'blob:' + urls.length; urls.push({ url, blob }); return url; }, revokeObjectURL: url => { const record = urls.find(item => item.url === url); if (record) record.revoked = true; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    showToast: (...args) => toasts.push(args), debugLog() {}, confirm: text => { confirmations.push(text); return confirmation; },
    fetch: async (url, options = {}) => { calls.push({ url, options }); const custom = handler ? await handler(url, options) : undefined; if (custom instanceof Error) throw custom;
      const response = custom || { data: responses[url] || (url.startsWith('/vault/note/') ? { id: url.split('/').at(-1), title: url.split('/').at(-1).replace('__note_', ''), content: 'Private content' } : url.startsWith('/vault/secret/') ? { key: 'wifi', value: 'private-password' } : { ok: true }) };
      return { ok: !response.status || response.status < 400, status: response.status || 200, json: async () => { if (response.badJSON) throw new Error('Invalid JSON'); return response.data; }, blob: async () => response.blob || { synthetic: true } };
    },
  });
  vm.runInContext(source, context); context.setupVaultPanel(); context.setupSettingsVault();
  const api = { context, nodes, events, calls, toasts, confirmations, clipboard, urls, anchors, tabs, responses,
    handler(fn) { handler = fn; }, confirm(value) { confirmation = value; },
    now: () => now,
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await tick(); },
    async init() { await context.fetchVaultStatus(); calls.length = 0; },
    emit(name, detail) { for (const fn of events[name] || []) fn({ detail, preventDefault() {} }); },
    edit(id, value) { nodes[id].value = value; return nodes[id].fire('input'); },
    row(kind, index = 0) { return nodes[`vault-${kind}-list`].children[index]; },
  }; return api;
}

test('unlock uses the existing success result, prevents duplicate Enter/click, and refreshes each collection once', async () => {
  const f = fixture(), wait = deferred(); f.context.updateVaultUIFromStatus({ initialized: true, unlocked: false }); f.context.setupVaultPanel();
  f.handler(url => url === '/vault/unlock' ? wait.promise : undefined); f.nodes['vault-password'].value = ' exact passphrase ';
  const first = f.nodes['vault-unlock-btn'].click(); await tick(); const second = f.nodes['vault-password'].fire('keydown', { key: 'Enter' });
  assert.equal(f.calls.filter(call => call.url === '/vault/unlock').length, 1); assert.equal(JSON.parse(f.calls[0].options.body).password, ' exact passphrase ');
  wait.resolve({ data: { success: true } }); await Promise.all([first, second]);
  for (const url of ['/vault/status', '/vault/list', '/vault/secrets', '/vault/notes']) assert.equal(f.calls.filter(call => call.url === url).length, 1, url);
  assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unlocked'); assert.equal(f.nodes['vault-password'].value, '');
});

test('10-attempt lockout uses UTC timestamps, blocks Enter, and never shows negative minutes', async () => {
  const f = fixture(); f.context.updateVaultUIFromStatus({ initialized: true, unlocked: false, locked_until: new Date(Date.now() + 600000).toISOString().replace('Z', '') });
  f.nodes['vault-password'].value = 'test'; await f.nodes['vault-password'].fire('keydown', { key: 'Enter' }); assert.equal(f.calls.length, 0); assert.equal(f.nodes['vault-unlock-btn'].disabled, true);
  f.context.updateVaultUIFromStatus({ initialized: true, unlocked: false, failed_attempts: 3, locked_until: new Date(Date.now() - 60000).toISOString() });
  assert.match(f.nodes['vault-auth-hint'].textContent, /7 attempts/); assert.equal(f.nodes['vault-unlock-btn'].disabled, false);
});

test('failed deletes require HTTP and handler confirmation and preserve the listed file and note draft', async () => {
  for (const failure of [{ status: 500, data: { detail: 'Disk busy' } }, { data: { ok: false } }, { data: {} }]) {
    const f = fixture(); await f.init(); f.handler((url, options) => options.method === 'POST' || options.method === 'DELETE' ? failure : undefined);
    await f.row('files').children[2].children[1].click(); assert.equal(f.nodes['vault-files-list'].children.length, 2); assert.match(f.nodes['vault-message'].textContent, /failed/i);
    await f.context.loadVaultNote('__note_First'); await f.edit('vault-note-body', 'Keep my edits'); await f.nodes['vault-note-delete-btn'].click();
    assert.equal(f.nodes['vault-note-body'].value, 'Keep my edits'); assert.equal(f.nodes['vault-note-editor'].dataset.noteId, '__note_First'); assert.match(f.nodes['vault-note-status'].textContent, /failed/i);
  }
});

test('duplicate file deletion sends one request and an already-absent result does not invent deletion', async () => {
  const f = fixture(), wait = deferred(); await f.init(); f.handler(url => url === '/vault/delete_file' ? wait.promise : undefined);
  const button = f.row('files').children[2].children[1], first = button.click(); await tick(); const second = button.click();
  assert.equal(f.calls.filter(call => call.url === '/vault/delete_file').length, 1); wait.resolve({ data: { ok: true, deleted: false } }); await Promise.all([first, second]);
  assert.match(f.nodes['vault-message'].textContent, /already absent/);
});

test('failed replacement loads retain observed lists and newest response wins', async () => {
  const f = fixture(); await f.init(); f.handler(url => url === '/vault/list' ? { status: 503, data: {} } : undefined); await f.context.refreshVaultFiles();
  assert.equal(f.nodes['vault-files-list'].children.length, 2); assert.match(f.nodes['vault-files-status'].textContent, /Previous list from/);
  const first = deferred(); let count = 0; f.handler(url => url === '/vault/list' ? (++count === 1 ? first.promise : { data: { files: [{ id: 'new', name: 'New' }] } }) : undefined);
  const pending = f.context.refreshVaultFiles(); await f.context.refreshVaultFiles(); first.resolve({ data: { files: [{ id: 'old', name: 'Old' }] } }); await pending;
  assert.equal(f.row('files').children[0].textContent, 'New');
});

test('search and size sorting are bounded local reads and clear results are truthful', async () => {
  const f = fixture(); await f.init(); f.nodes['vault-files-sort'].value = 'size'; await f.nodes['vault-files-sort'].fire('change'); assert.equal(f.row('files').children[0].textContent, 'large_txt');
  await f.edit('vault-files-search', 'small'); assert.equal(f.nodes['vault-files-list'].children.length, 1); assert.equal(f.row('files').children[0].textContent, 'small_txt');
  await f.edit('vault-secrets-search', 'none'); assert.match(f.row('secrets').textContent, /No matches/); assert.equal(f.calls.length, 0);
});

test('failed upload retains selection, concurrent submission is deduplicated, and collisions require review', async () => {
  const f = fixture(), wait = deferred(); await f.init(); const file = { name: 'small.txt', size: 100 }; f.nodes['vault-file-input'].files = [file]; f.confirm(false);
  await f.nodes['vault-upload-btn'].click(); assert.equal(f.calls.filter(call => call.url === '/vault/upload').length, 0); assert.equal(f.nodes['vault-file-input'].files[0], file);
  f.confirm(true); f.handler(url => url === '/vault/upload' ? wait.promise : undefined);
  const first = f.nodes['vault-upload-btn'].click(); await tick(); const second = f.nodes['vault-upload-btn'].click(); assert.equal(f.calls.filter(call => call.url === '/vault/upload').length, 1);
  wait.resolve({ status: 500, data: {} }); await Promise.all([first, second]); assert.equal(f.nodes['vault-file-input'].files[0], file); assert.match(f.nodes['vault-message'].textContent, /Upload failed/);
});

test('failed saves keep drafts; changed-title saves are explicit copies and update the delete target', async () => {
  const f = fixture(); await f.init(); await f.context.loadVaultNote('__note_First'); await f.edit('vault-note-title-input', 'Different'); await f.edit('vault-note-body', 'Draft text');
  assert.equal(f.nodes['vault-note-save-btn'].textContent, 'Save as new note'); f.handler(url => url === '/vault/note' ? { status: 500, data: {} } : undefined);
  await f.nodes['vault-note-save-btn'].click(); assert.equal(f.nodes['vault-note-title-input'].value, 'Different'); assert.equal(f.nodes['vault-note-body'].value, 'Draft text'); assert.match(f.nodes['vault-note-status'].textContent, /draft is still here/);
  f.handler(url => url === '/vault/note' ? { data: { ok: true, id: '__note_Different', title: 'Different' } } : undefined); await f.nodes['vault-note-save-btn'].click();
  assert.equal(f.nodes['vault-note-editor'].dataset.noteId, '__note_Different'); assert.match(f.nodes['vault-note-status'].textContent, /original note is unchanged/);
});

test('existing title replacement can be cancelled without writes and new note switching respects dirty drafts', async () => {
  const f = fixture(); await f.init(); await f.context.loadVaultNote('__note_First'); await f.edit('vault-note-title-input', 'Second'); await f.edit('vault-note-body', 'Keep this'); f.confirm(false);
  await f.nodes['vault-note-save-btn'].click(); assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0); assert.equal(f.nodes['vault-note-body'].value, 'Keep this');
  const count = f.calls.length; await f.context.loadVaultNote('__note_Second'); f.context._vaultOpenNewNote(); assert.equal(f.calls.length, count); assert.equal(f.nodes['vault-note-body'].value, 'Keep this');
});

test('failed note opening and typing during a pending opening preserve the current draft', async () => {
  const f = fixture(); await f.init(); await f.context.loadVaultNote('__note_First'); await f.edit('vault-note-body', 'Keep me'); f.handler(url => url.includes('__note_Second') ? { status: 500, data: {} } : undefined);
  await f.context.loadVaultNote('__note_Second'); assert.equal(f.nodes['vault-note-body'].value, 'Keep me'); assert.equal(f.nodes['vault-note-editor'].dataset.noteId, '__note_First');
  const wait = deferred(); f.handler(url => url.includes('__note_Second') ? wait.promise : undefined); const pending = f.context.loadVaultNote('__note_Second'); await f.edit('vault-note-body', 'Newer typing');
  wait.resolve({ data: { id: '__note_Second', title: 'Second', content: 'Replace me' } }); await pending; assert.equal(f.nodes['vault-note-body'].value, 'Newer typing');
});

test('save preserves typing entered during the request and does not imply newer edits were saved', async () => {
  const f = fixture(), wait = deferred(); await f.init(); await f.context.loadVaultNote('__note_First'); await f.edit('vault-note-body', 'Submitted'); f.handler(url => url === '/vault/note' ? wait.promise : undefined);
  const first = f.nodes['vault-note-save-btn'].click(); await tick(); const second = f.nodes['vault-note-save-btn'].click(); await f.edit('vault-note-body', 'Newer text');
  wait.resolve({ data: { ok: true, id: '__note_First', title: 'First' } }); await Promise.all([first, second]); assert.equal(f.calls.filter(call => call.url === '/vault/note').length, 1); assert.equal(f.nodes['vault-note-body'].value, 'Newer text'); assert.match(f.nodes['vault-note-status'].textContent, /newer edits are not saved/);
});

test('reveal/hide and copy are deliberate, failed clipboard does not report copied, leaving Secrets hides values', async () => {
  const f = fixture(); await f.init(); let row = f.row('secrets'); await row.children[2].children[0].click(); assert.equal(row.children[1].textContent, 'private-password');
  await row.children[2].children[0].click(); assert.equal(row.children[1].textContent, '••••••••'); await row.children[2].children[1].click(); assert.deepEqual(f.clipboard, ['private-password']); assert.match(f.toasts.at(-1)[0], /clipboard is outside/);
  f.context.navigator.clipboard.writeText = async () => { throw new Error('Permission denied'); }; await row.children[2].children[1].click(); assert.match(f.toasts.at(-1)[0], /Could not copy/);
  await row.children[2].children[0].click(); await f.tabs[0].click(); assert.equal(f.row('secrets').children[1].textContent, '••••••••');
});

test('session lock clears private DOM and ignores late note, secret and status responses', async () => {
  const f = fixture(); await f.init(); await f.context.loadVaultNote('__note_First'); const waitNote = deferred(), waitSecret = deferred(), waitStatus = deferred();
  f.handler(url => url === '/vault/status' ? waitStatus.promise : url.includes('__note_Second') ? waitNote.promise : url === '/vault/secret/wifi' ? waitSecret.promise : undefined);
  const pending = [f.context.loadVaultNote('__note_Second'), f.row('secrets').children[2].children[0].click(), f.context.fetchVaultStatus()]; await tick(); f.emit('tli-session-locked');
  waitNote.resolve({ data: { id: '__note_Second', title: 'Second', content: 'Late private note' } }); waitSecret.resolve({ data: { value: 'Late private secret' } }); waitStatus.resolve({ data: { initialized: true, unlocked: true } }); await Promise.all(pending);
  assert.equal(f.nodes['vault-note-body'].value, ''); assert.equal(f.nodes['vault-note-title-input'].value, ''); for (const kind of ['files', 'notes', 'secrets']) assert.equal(f.nodes[`vault-${kind}-list`].children.length, 0);
  assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable');
});

test('401 and403 clear private data rather than retaining apparently available content', async () => {
  for (const status of [401, 403]) { const f = fixture(); await f.init(); await f.context.loadVaultNote('__note_First'); f.handler(url => url === '/vault/secrets' ? { status, data: {} } : undefined); await f.context.refreshVaultSecrets(); assert.equal(f.nodes['vault-note-body'].value, ''); assert.equal(f.nodes['vault-secrets-list'].children.length, 0); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable'); }
});

test('explicit lock clears content immediately; unconfirmed durable lock remains unavailable and retry is deliberate', async () => {
  const f = fixture(), wait = deferred(); await f.init(); await f.context.loadVaultNote('__note_First'); f.handler(url => url === '/vault/lock' ? wait.promise : undefined);
  const first = f.context.window.TLIVault.lock(); assert.equal(f.nodes['vault-note-body'].value, ''); const second = f.context.window.TLIVault.lock(); await tick(); assert.equal(f.calls.filter(call => call.url === '/vault/lock').length, 1);
  wait.resolve({ status: 503, data: { detail: 'Saved unlock session could not be removed.' } }); assert.equal(await first, false); await second; assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable'); assert.match(f.nodes['vault-state-message'].textContent, /did not confirm/);
  f.handler(url => url === '/vault/lock' ? { data: { ok: true } } : undefined); assert.equal(await f.context.window.TLIVault.lock(), true); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'locked');
});

test('locking waits for a pending unlock so its late completion cannot reopen the server after lock', async () => {
  const f = fixture(), wait = deferred(); f.context.updateVaultUIFromStatus({ initialized: true, unlocked: false });
  f.handler(url => url === '/vault/unlock' ? wait.promise : url === '/vault/lock' ? { data: { ok: true } } : undefined);
  const unlocking = f.context._vaultUnlock('passphrase'); await tick(); const locking = f.context.window.TLIVault.lock(); await tick(); assert.equal(f.calls.filter(call => call.url === '/vault/lock').length, 0);
  wait.resolve({ data: { success: true } }); await Promise.all([unlocking, locking]); assert.equal(f.calls.at(-1).url, '/vault/lock'); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'locked');
});

test('download failures stay in TLI and late decrypted downloads are discarded after lock', async () => {
  const f = fixture(); await f.init(); f.handler(url => url.startsWith('/vault/get_file') ? { status: 500, data: {} } : undefined); await f.row('files').children[2].children[0].click(); assert.equal(f.anchors.length, 0); assert.match(f.toasts.at(-1)[0], /Download failed/);
  const wait = deferred(); f.handler(url => url.startsWith('/vault/get_file') ? wait.promise : undefined); const pending = f.row('files').children[2].children[0].click(); await tick(); f.emit('tli-session-locked'); wait.resolve({ blob: { synthetic: true } }); await pending; assert.equal(f.urls.length, 0);
});

test('background access checks use status only, preserve drafts while available, and clear private data on failure', async () => {
  const f = fixture(); await f.init(); await f.context.loadVaultNote('__note_First'); await f.edit('vault-note-body', 'Unsaved private draft'); f.calls.length = 0;
  await f.advance(30000); assert.deepEqual(f.calls.map(call => call.url), ['/vault/status']); assert.equal(f.nodes['vault-note-body'].value, 'Unsaved private draft');
  f.handler(url => url === '/vault/status' ? { status: 503, data: {} } : undefined); await f.advance(30000);
  assert.equal(f.nodes['vault-note-body'].value, ''); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable'); assert.equal(f.calls.length, 2);
});

test('confirmed unlock deadline clears private content without another decrypting request', async () => {
  const f = fixture(); f.context.updateVaultUIFromStatus({ initialized: true, unlocked: false });
  f.handler(url => url === '/vault/unlock' ? { data: { success: true, unlocked_until: new Date(f.now() + 45000).toISOString().replace('Z', '') } } : undefined);
  await f.context._vaultUnlock('passphrase'); await f.context.loadVaultNote('__note_First'); f.calls.length = 0;
  await f.advance(30000); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unlocked'); await f.advance(15000);
  assert.equal(f.nodes['vault-note-body'].value, ''); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable'); assert.match(f.nodes['vault-state-message'].textContent, /unlock window has ended/);
  assert.deepEqual(f.calls.map(call => call.url), ['/vault/status']);
});

test('late status-only poll after manual lock cannot reopen the Vault or recreate decrypted rows', async () => {
  const f = fixture(), wait = deferred(); await f.init(); f.handler(url => url === '/vault/status' ? wait.promise : url === '/vault/lock' ? { data: { ok: true } } : undefined);
  await f.advance(30000); await f.context.window.TLIVault.lock(); wait.resolve({ data: { initialized: true, unlocked: true } }); await tick();
  assert.equal(f.nodes['vault-status-pill'].dataset.state, 'locked'); assert.equal(f.nodes['vault-files-list'].children.length, 0);
  const count = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, count);
});

test('unlock deadline clears the view even if its background status request never returns', async () => {
  const f = fixture(), wait = deferred(); f.context.updateVaultUIFromStatus({ initialized: true, unlocked: false });
  f.handler(url => url === '/vault/unlock' ? { data: { success: true, unlocked_until: new Date(f.now() + 45000).toISOString() } } : undefined);
  await f.context._vaultUnlock('passphrase'); await f.context.loadVaultNote('__note_First'); f.handler(url => url === '/vault/status' ? wait.promise : undefined);
  await f.advance(30000); assert.equal(f.nodes['vault-note-body'].value, 'Private content'); await f.advance(15000);
  assert.equal(f.nodes['vault-note-body'].value, ''); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable');
  wait.resolve({ data: { initialized: true, unlocked: true } }); await tick(); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable');
});

test('Forgot disclosure tracks expanded state and locking clears confirmation and visible passphrase', async () => {
  const f = fixture(); f.context.updateVaultUIFromStatus({ initialized: true, unlocked: false }); await f.nodes['vault-forgot-btn'].click(); assert.equal(f.nodes['vault-forgot-btn'].attrs['aria-expanded'], 'true');
  f.nodes['vault-password'].value = 'private'; await f.nodes['vault-passphrase-toggle'].click(); assert.equal(f.nodes['vault-password'].type, 'text');
  f.nodes['vault-reset-confirm-input'].value = 'RESET VAULT'; f.emit('tli-session-locked'); assert.equal(f.nodes['vault-password'].type, 'password'); assert.equal(f.nodes['vault-password'].value, ''); assert.equal(f.nodes['vault-reset-confirm-input'].value, ''); assert.equal(f.nodes['vault-forgot-btn'].attrs['aria-expanded'], 'false');
});

test('a missing unlock deadline still clears private data when a status-only probe times out', async () => {
  const f = fixture(), wait = deferred(); await f.init(); await f.context.loadVaultNote('__note_First'); f.handler(url => url === '/vault/status' ? wait.promise : undefined);
  await f.advance(30000); await f.advance(15000); assert.equal(f.nodes['vault-note-body'].value, ''); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable');
  wait.resolve({ data: { initialized: true, unlocked: true } }); await tick(); assert.equal(f.nodes['vault-status-pill'].dataset.state, 'unavailable');
});

test('explicit Refresh coalesces with a status-only probe while still refreshing the three lists once', async () => {
  const f = fixture(), wait = deferred(); await f.init(); await f.context.loadVaultNote('__note_First'); await f.edit('vault-note-body', 'Current draft'); f.calls.length = 0;
  f.handler(url => url === '/vault/status' ? wait.promise : undefined); f.emit('focus'); await tick(); const explicit = f.context.fetchVaultStatus();
  wait.resolve({ data: { initialized: true, unlocked: true } }); await explicit;
  for (const url of ['/vault/status', '/vault/list', '/vault/secrets', '/vault/notes']) assert.equal(f.calls.filter(call => call.url === url).length, 1, url);
  assert.equal(f.nodes['vault-note-body'].value, 'Current draft');
});
