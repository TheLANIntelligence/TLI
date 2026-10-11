const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settingsSource = fs.readFileSync(path.join(__dirname, '../js/settings.js'), 'utf8');
const enhancedSource = fs.readFileSync(path.join(__dirname, '../settings_enhanced.js'), 'utf8');
const updateSource = fs.readFileSync(path.join(__dirname, '../js/tli-update.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function element(id = '') {
  const classes = new Set();
  const node = { id, value: '', textContent: '', tagName: 'DIV', dataset: {}, attrs: {}, style: {}, hidden: false, disabled: false, checked: false,
    handlers: {}, children: [], options: [],
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, value) { const next = value ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; } },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
    fire(name, event = {}) { return Promise.all((this.handlers[name] || []).map(fn => fn({ target: this, ...event }))); },
    click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
    appendChild(child) { this.children.push(child); this.options.push(child); return child; },
    remove() {}, closest() { return null; }, querySelector() { return null; },
  };
  return node;
}

function fixture(source = settingsSource, saved = {}) {
  const nodes = {}, docEvents = {}, observers = [], calls = [], toasts = [], theme = [], prompts = [], confirmations = [];
  const storage = new Map([['tli_settings', JSON.stringify(saved)]]);
  let fetchHandler = async url => url === '/system/pin/status' ? { enabled: false } : url === '/api/ai/models/presets' ? { presets: [] } : { ok: true };
  let writeFailure = false, accept = true;
  const node = id => nodes[id] ||= element(id);
  const ctx = vm.createContext({ console: { log() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, Blob,
    document: { readyState: 'loading', documentElement: element(), getElementById: id => nodes[id] || null, createElement: () => element(), body: element(),
      querySelectorAll: () => [], addEventListener: (name, fn) => (docEvents[name] ||= []).push(fn) },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } disconnect() {} },
    window: {}, navigator: { clipboard: { writeText: async () => {} } },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    FileReader: class { readAsText(file) { this.result = file.text; this.onload(); } },
    localStorage: { getItem: key => storage.get(key) || null, setItem(key, value) { if (writeFailure) throw new Error('Storage unavailable'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    sessionStorage: { setItem() {}, removeItem() {} },
    $: id => nodes[id] || null, DEFAULT_THEME: 'midnight', previousPromptsKey: 'tli_previous_prompts',
    applyTheme: value => theme.push(value), showToast: (...args) => toasts.push(args), debugLog() {}, loadPreviousPrompts: () => prompts.push(true),
    confirm: message => { confirmations.push(message); return accept; },
    fetch: async (url, options = {}) => { calls.push({ url, options }); const response = await fetchHandler(url, options); return { ok: (response.status || 200) < 300, status: response.status || 200, json: async () => response.data ?? response }; },
  });
  return { ctx, node, nodes, calls, storage, toasts, theme, confirmations, observers,
    handler(fn) { fetchHandler = fn; }, failWrites(value = true) { writeFailure = value; }, accept(value) { accept = value; },
    async start() { vm.runInContext(source, ctx); if (source === settingsSource) ctx.setupSettingsPanel(); for (const fn of docEvents.DOMContentLoaded || []) fn(); await tick(); },
    settings: () => JSON.parse(storage.get('tli_settings')),
  };
}

function chatControls(f) {
  for (const id of ['settings-save', 'settings-apply', 'settings-theme', 'settings-brain', 'settings-temp', 'settings-max', 'settings-teaching', 'settings-chat-status', 'settings-theme-status', 'temperature-input', 'max-tokens-input']) f.node(id);
  f.node('settings-theme').value = 'emeraldLight';
  f.node('settings-brain').value = 'qwen';
  f.node('settings-temp').value = '0.4';
  f.node('settings-max').value = '512';
}

test('chat Save and legacy Apply merge only owned fields without losing Search Assist, mode or custom metadata', async () => {
  for (const id of ['settings-save', 'settings-apply']) {
    const saved = { defaultBrain: 'custom', customBrainPrompt: 'custom prompt', defaultMode: 'coder', searchEnabled: true, searxUrl: 'http://search.local', searchRules: { always: { weather: true } }, defaultTheme: 'midnight' };
    const f = fixture(settingsSource, saved); chatControls(f); await f.start();
    await f.node(id).click(); const actual = f.settings();
    assert.deepEqual(actual, { ...saved, defaultBrain: 'qwen', teachingOn: false, defaultTemp: '0.4', defaultMax: '512' });
    assert.equal(f.node('temperature-input').value, '0.4');
    assert.match(f.node('settings-chat-status').textContent, /saved in this browser/);
  }
});

test('missing legacy brain option is retained on load and unrelated chat saves', async () => {
  const f = fixture(settingsSource, { defaultBrain: 'custom', customBrainPrompt: 'keep' }); chatControls(f); await f.start();
  f.ctx.loadSettingsPanel();
  assert.equal(f.node('settings-brain').value, 'custom');
  assert.equal(f.node('settings-brain').options.at(-1).value, 'custom');
  await f.node('settings-save').click(); assert.equal(f.settings().defaultBrain, 'custom');
});

test('theme saves independently and does not commit unsaved chat fields', async () => {
  const f = fixture(settingsSource, { defaultTemp: '0.95', searchEnabled: true }); chatControls(f); await f.start();
  await f.node('settings-theme').fire('change');
  assert.deepEqual(f.settings(), { defaultTemp: '0.95', searchEnabled: true, defaultTheme: 'emeraldLight', appearanceMode: 'theme' });
  assert.equal(f.theme.at(-1), 'emeraldLight'); assert.match(f.node('settings-theme-status').textContent, /saved/);
});

test('System appearance persists independently from the remembered colored theme and chat drafts', async () => {
  const saved = { defaultTheme: 'lavenderMidnight', defaultTemp: '0.95', searchEnabled: true };
  const f = fixture(settingsSource, saved); chatControls(f);
  const mode = f.node('settings-appearance-mode');
  const applied = [];
  f.ctx.window.TLIThemes = { applyPreference: value => applied.push({ ...value }), resolve: id => ({ id }) };
  await f.start(); assert.equal(mode.value, 'theme');
  const initialCalls = f.calls.length;
  mode.value = 'system'; await mode.fire('change');
  assert.deepEqual(f.settings(), { ...saved, appearanceMode: 'system' });
  assert.deepEqual(applied.at(-1), { ...saved, appearanceMode: 'system' });
  assert.equal(f.calls.length, initialCalls, 'Appearance does not contact a host');
  mode.value = 'theme'; await mode.fire('change');
  assert.deepEqual(f.settings(), { ...saved, appearanceMode: 'theme' });
  assert.equal(applied.at(-1).defaultTheme, 'lavenderMidnight');
});

test('failed System-mode and explicit-theme saves leave both previous preferences and appearance intact', async () => {
  for (const savedMode of ['system', 'theme']) {
    const saved = { defaultTheme: 'pacific', appearanceMode: savedMode };
    const f = fixture(settingsSource, saved); chatControls(f);
    const mode = f.node('settings-appearance-mode');
    const applied = [];
    f.ctx.window.TLIThemes = { applyPreference: value => applied.push(value) };
    f.ctx.document.documentElement.setAttribute('data-theme', savedMode === 'system' ? 'midnight' : 'pacific');
    await f.start(); f.failWrites();
    mode.value = savedMode === 'system' ? 'theme' : 'system'; await mode.fire('change');
    assert.equal(mode.value, savedMode); assert.deepEqual(f.settings(), saved); assert.equal(applied.length, 0);
    await f.node('settings-theme').fire('change');
    assert.deepEqual(f.settings(), saved); assert.equal(mode.value, savedMode); assert.equal(f.theme.length, 0);
    assert.equal(f.node('settings-theme').value, savedMode === 'system' ? 'midnight' : 'pacific');
  }
});

test('an explicit theme choice atomically leaves System without saving unsubmitted chat changes', async () => {
  const saved = { defaultTheme: 'copper', appearanceMode: 'system', defaultTemp: '0.95' };
  const f = fixture(settingsSource, saved); chatControls(f); const mode = f.node('settings-appearance-mode');
  await f.start(); assert.equal(mode.value, 'system');
  await f.node('settings-theme').fire('change');
  assert.deepEqual(f.settings(), { ...saved, defaultTheme: 'emeraldLight', appearanceMode: 'theme' });
  assert.equal(mode.value, 'theme'); assert.equal(f.theme.at(-1), 'emeraldLight');
});

test('failed browser saves report failure and do not apply unsaved values', async () => {
  for (const [id, event, feedback] of [['settings-save', 'click', 'settings-chat-status'], ['settings-theme', 'change', 'settings-theme-status']]) {
    const f = fixture(settingsSource, { defaultTheme: 'midnight' }); chatControls(f); await f.start(); f.failWrites();
    await f.node(id).fire(event);
    assert.deepEqual(f.settings(), { defaultTheme: 'midnight' }); assert.equal(f.theme.length, 0);
    if (id === 'settings-theme') assert.equal(f.node(id).value, 'midnight', 'Rejected choice returns to the prior appearance');
    assert.equal(f.node(feedback).dataset.state, 'error'); assert.equal(f.toasts.at(-1)[1], 'error');
  }
});

test('loading a host performance profile never overwrites chat drafts', async () => {
  const f = fixture(); chatControls(f); f.node('settings-system-profile'); f.node('settings-system-profile-meta');
  f.handler(async () => ({ current: 'power', profiles: { power: { label: 'Power' } }, ui_defaults: { temp: '0.8', max_tokens: '1200' } }));
  await f.start(); await f.ctx.fetchSystemProfileSettings();
  assert.equal(f.node('settings-temp').value, '0.4'); assert.equal(f.node('settings-max').value, '512');
  assert.match(f.node('settings-system-profile-meta').textContent, /chat preferences are unchanged/);
});

test('legacy history export and clear use the original keys without touching saved server-style browser state', async () => {
  const f = fixture(); f.node('settings-export'); f.node('settings-clear-history');
  f.storage.set('tli_previous_prompts', '["legacy prompt"]'); f.storage.set('tli_previous_conversations', '[{"title":"legacy conversation"}]'); f.storage.set('tli_chat_history_v1', 'keep');
  await f.start(); await f.node('settings-export').click();
  assert.equal(f.ctx.document.body.children.at(-1).download, 'tli_export.json');
  await f.node('settings-clear-history').click();
  assert.equal(f.storage.get('tli_previous_prompts'), '[]'); assert.equal(f.storage.get('tli_previous_conversations'), '[]'); assert.equal(f.storage.get('tli_chat_history_v1'), 'keep');
  assert.match(f.confirmations[0], /Saved conversations and Notebook notes.*unchanged/);
  assert.ok(f.calls.every(call => !call.options.method));
});

test('legacy imports reject invalid files before any writes and retain cancellation', async () => {
  for (const data of [[], null, {}, { tli_settings: [] }, { tli_settings: {}, tli_previous_prompts: {} }]) {
    const f = fixture(settingsSource, { searchEnabled: true }); f.node('settings-import'); await f.start(); const before = [...f.storage];
    await f.node('settings-import').fire('change', { target: { files: [{ text: JSON.stringify(data) }], value: 'file' } });
    assert.deepEqual([...f.storage], before); assert.equal(f.toasts.at(-1)[1], 'error');
  }
  const f = fixture(settingsSource, { searchEnabled: true }); f.node('settings-import'); await f.start(); f.accept(false);
  await f.node('settings-import').fire('change', { target: { files: [{ text: '{"tli_settings":{"defaultTemp":"0.4"}}' }], value: 'file' } });
  assert.deepEqual(f.settings(), { searchEnabled: true });
});

test('valid legacy imports keep format and affect only the explicitly included browser fields', async () => {
  const f = fixture(settingsSource, { searchEnabled: true }); f.node('settings-import'); f.storage.set('tli_previous_prompts', '["keep"]'); await f.start();
  await f.node('settings-import').fire('change', { target: { files: [{ text: '{"tli_previous_conversations":[{"title":"imported"}]}' }], value: 'file' } });
  assert.equal(f.storage.get('tli_previous_conversations'), '[{"title":"imported"}]'); assert.equal(f.storage.get('tli_previous_prompts'), '["keep"]');
  assert.deepEqual(f.settings(), { searchEnabled: true }); assert.equal(f.toasts.at(-1)[1], 'success');
});

test('host model and performance saves require confirmed results, and duplicate submits share the active request', async () => {
  for (const [button, select, url] of [['settings-model-save', 'settings-model-id', '/models/set-default'], ['settings-system-profile-save', 'settings-system-profile', '/system/profile']]) {
    const f = fixture(); f.node(button); f.node(select).value = 'test'; await f.start();
    f.handler(async () => ({ ok: false })); await f.node(button).click();
    assert.equal(f.toasts.at(-1)[1], 'error'); assert.equal(f.node(button).disabled, false);
    let finish; f.handler(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.node(button).click(); await f.node(button).fire('click');
    assert.equal(f.calls.filter(call => call.url === url && call.options.method === 'POST').length, 2);
    finish({ ok: false }); await pending;
  }
});

test('mesh settings reject invalid thresholds before sending and use confirmed host values in feedback', async () => {
  const f = fixture(); for (const id of ['settings-mesh-ai-save', 'settings-mesh-cpu-threshold', 'settings-mesh-ai-status', 'settings-prefer-mesh-ai']) f.node(id);
  await f.start();
  for (const value of ['', '39', '101', '80.5', 'not a number']) {
    f.node('settings-mesh-cpu-threshold').value = value; await f.node('settings-mesh-ai-save').click();
  }
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
  f.node('settings-mesh-cpu-threshold').value = '100'; f.handler(async () => ({ ok: true, prefer_mesh_ai: false, mesh_ai_cpu_threshold: 100 }));
  await f.node('settings-mesh-ai-save').click();
  assert.match(f.node('settings-mesh-ai-status').textContent, /CPU reaches 100%.*RAM pressure/);
  f.handler(async () => ({ ok: false })); await f.node('settings-mesh-ai-save').click(); assert.equal(f.toasts.at(-1)[1], 'error');
});

test('computer identity save rejects an unconfirmed handler result', async () => {
  const f = fixture(); f.node('settings-node-identity-save'); f.node('settings-node-name').value = 'Test host'; f.node('settings-node-role').value = 'standalone';
  await f.start(); f.node('settings-node-name').value = 'Test host'; f.handler(async () => ({ ok: false }));
  await f.node('settings-node-identity-save').click(); assert.equal(f.toasts.at(-1)[1], 'error'); assert.equal(f.node('settings-node-identity-save').disabled, false);
});

test('accordion controls expose current state and avoid duplicate activation', async () => {
  const f = fixture(enhancedSource); const section = element('example'), header = element(), body = element();
  section.classList.add('collapsed'); section.querySelector = () => body; header.closest = () => section;
  f.ctx.document.querySelectorAll = () => [header]; await f.start();
  assert.equal(header.attrs['aria-expanded'], 'false'); assert.equal(header.attrs['aria-controls'], body.id); assert.equal(body.hidden, true);
  let prevented = 0; await header.fire('keydown', { key: 'Enter', preventDefault() { prevented++; } });
  assert.equal(header.attrs['aria-expanded'], 'true'); assert.equal(body.hidden, false);
  await header.fire('keydown', { key: ' ', repeat: true, preventDefault() { prevented++; } }); assert.equal(header.attrs['aria-expanded'], 'true');
  f.ctx.window.TLISettingsSections.refresh(); assert.equal(header.handlers.click.length, 1);
  section.classList.add('collapsed'); f.observers.find(observer => observer.target === section).callback();
  assert.equal(header.attrs['aria-expanded'], 'false'); assert.equal(body.hidden, true); assert.equal(prevented, 2);
});

test('native button accordions rely on their single native click for keyboard activation', async () => {
  const f = fixture(enhancedSource), section = element('native'), body = element(), header = element(); header.tagName = 'BUTTON'; header.closest = () => section; section.querySelector = () => body;
  f.ctx.document.querySelectorAll = () => [header]; await f.start();
  await header.fire('keydown', { key: 'Enter', preventDefault() { assert.fail('native behavior must remain intact'); } });
  await header.click(); assert.equal(header.attrs['aria-expanded'], 'false');
});

test('license removal failure never claims the key was removed', async () => {
  for (const result of [{ status: 503, data: { detail: 'Storage unavailable' } }, { data: {} }]) {
    const f = fixture(enhancedSource); for (const id of ['tli-lic-activate-btn', 'tli-lic-deactivate-btn', 'tli-lic-key-input', 'tli-lic-msg']) f.node(id);
    await f.start(); f.handler(async () => result); await f.node('tli-lic-deactivate-btn').click();
    assert.match(f.node('tli-lic-msg').textContent, /Failed to remove license/); assert.doesNotMatch(f.node('tli-lic-msg').textContent, /Reverted to Free/); assert.equal(f.node('tli-lic-deactivate-btn').disabled, false);
  }
});

test('model status failure replaces a stale running assertion with explicit unavailability', async () => {
  const f = fixture(enhancedSource); const list = f.node('tli-model-presets-list'); f.handler(async () => ({ status: 503 })); await f.start();
  assert.match(list.children[0].textContent, /status is unavailable/); assert.equal(list.children[1].textContent, 'Open model library');
});

test('update settings require successful HTTP and confirmed save, without duplicate submission', async () => {
  const f = fixture(updateSource); f.node('settings-update-url').value = 'https://updates.example/manifest.json'; f.node('settings-update-url-save');
  f.handler(async () => ({ auto_check: false, update_url: 'https://updates.example/manifest.json', state: 'idle' }));
  await f.start();
  for (const result of [{ status: 403, data: { detail: 'Unlock TLI first' } }, { data: {} }, { data: { ok: false } }]) {
    f.handler(async () => result); await f.node('settings-update-url-save').click();
    assert.equal(f.toasts.at(-1)[1], 'error'); assert.equal(f.node('settings-update-url-save').textContent, 'Save');
  }
  let finish; f.handler(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.node('settings-update-url-save').click(); await f.node('settings-update-url-save').fire('click');
  assert.equal(f.calls.filter(call => call.url === '/update/settings').length, 4);
  finish({ ok: true }); await pending; assert.equal(f.node('settings-update-url-save').textContent, 'Saved ✓');
});

test('saved automatic update checks restore false and remain false when changing the release URL', async () => {
  const f = fixture(updateSource); for (const id of ['settings-update-url', 'settings-update-url-save', 'settings-update-auto-check', 'settings-update-save-status']) f.node(id);
  f.node('settings-update-auto-check').checked = true;
  f.handler(async () => ({ auto_check: false, update_url: 'https://old.example/manifest.json', state: 'idle' })); await f.start();
  assert.equal(f.node('settings-update-auto-check').checked, false); assert.equal(f.node('settings-update-url-save').disabled, false);
  f.node('settings-update-url').value = 'https://new.example/manifest.json'; f.handler(async () => ({ ok: true })); await f.node('settings-update-url-save').click();
  const call = f.calls.find(call => call.url === '/update/settings');
  assert.deepEqual(JSON.parse(call.options.body), { update_url: 'https://new.example/manifest.json', auto_check: false });
});

test('unknown update preferences cannot silently save the HTML default', async () => {
  for (const response of [{ update_url: 'https://updates.example/manifest.json' }, { status: 503, data: { auto_check: true, update_url: '' } }, { auto_check: null, update_url: '' }]) {
    const f = fixture(updateSource); for (const id of ['settings-update-url', 'settings-update-url-save', 'settings-update-auto-check', 'settings-update-save-status']) f.node(id);
    f.handler(async () => response); await f.start();
    assert.equal(f.node('settings-update-url-save').disabled, true); assert.equal(f.node('settings-update-auto-check').disabled, true);
    assert.match(f.node('settings-update-save-status').textContent, /unavailable|does not report/);
    await f.node('settings-update-url-save').fire('click'); assert.ok(f.calls.every(call => !call.options.method));
  }
});

test('settings version displays use the same confirmed host value and missing update support explains the required next step', async () => {
  const f = fixture(updateSource); for (const id of ['settings-tli-version', 'version-pill-settings', 'settings-update-url-save', 'settings-update-save-status']) f.node(id);
  f.handler(async () => ({ current_version: '1.3.5-beta', state: 'idle', update_url: 'https://updates.example/manifest.json' })); await f.start();
  assert.equal(f.node('settings-tli-version').textContent, 'v1.3.5-beta'); assert.equal(f.node('version-pill-settings').textContent, 'v1.3.5-beta');
  assert.match(f.node('settings-update-save-status').textContent, /does not report.*matching TLI app and host files.*if host files were updated, restart TLI normally/);
  assert.equal(f.node('settings-update-url-save').disabled, true);
});
