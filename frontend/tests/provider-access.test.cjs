const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const settings = fs.readFileSync(path.join(__dirname, '../js/settings.js'), 'utf8');
const aiSource = fs.readFileSync(path.join(__dirname, '../js/ai-source.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; };
const json = (data, status = 200) => ({ok: status < 400, status, json: async () => data});

function fixture() {
  const nodes = {}, events = {}, calls = [], pills = [], toasts = [], timers = new Map(); let retry = 0, timerID = 0;
  const node = () => {
    const classes = new Set();
    const n = {children: [], value: '', textContent: '', disabled: false, dataset: {}, style: {}, handlers: {},
      classList: {add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x), toggle(x, on = !classes.has(x)) { if (on) classes.add(x); else classes.delete(x); }},
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }, setAttribute() {},
      appendChild(child) { this.children.push(child); this.options = this.children; },
      querySelector(selector) { return this.parts?.[selector] || null; },
      async fire(type) { for (const fn of this.handlers[type] || []) await fn({target: this}); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); }};
    Object.defineProperty(n, 'innerHTML', {get() { return this.html || ''; }, set(v) { this.html = v; this.children = []; this.options = []; this.value = ''; }});
    return n;
  };
  let handler = async () => { throw Error('Unexpected request'); };
  const window = {addEventListener: (type, fn) => (events[type] ||= []).push(fn),
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); },
    EventInterpreter: {retry() { retry++; }}, setInterval() {}};
  const ctx = vm.createContext({window, document: {readyState: 'loading', hidden: false, getElementById: id => nodes[id] || null,
    createElement: node, querySelectorAll: () => [], addEventListener() {}},
    $: id => nodes[id] || null, console: {log() {}}, AbortSignal, AbortController, Date, CustomEvent: class {constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; }},
    setTimeout: (fn, ms) => { const id = ++timerID; timers.set(id, {fn, ms}); return id; }, clearTimeout: id => timers.delete(id),
    _setPill: (...args) => pills.push(args), setAIRoutePill: (...args) => pills.push(args), showToast: (...args) => toasts.push(args), debugLog() {},
    localStorage: {getItem() { return null; }, setItem() {}},
    AIStatus: {local: {available: false, provider: 'lmstudio', health: 'unknown', lastCheckedMs: 0}, lan: {nodes: [], available: false, lastCheckedMs: 0}},
    AI_POLICY: 'AUTO', AI_LAN_PREFERRED: 'AUTO', AIUserPolicy: {}, IntelligenceSource: {NONE: 'none', LOCAL_LLM: 'local_llm', LAN_LLM: 'lan_llm'},
    fetch: async (url, options = {}) => { calls.push([url, options]); return handler(url, options); }});
  const f = {ctx, window, nodes, events, calls, pills, toasts, timers,
    add(...ids) { for (const id of ids) nodes[id] = node(); }, respond(fn) { handler = fn; },
    emit(type) { window.dispatchEvent({type}); }, recover() { this.emit('tli-session-unlocked'); this.emit('tli-private-observation-ready'); },
    get retries() { return retry; }, run(code) { return vm.runInContext(code, ctx); }};
  return f;
}

function appFixture() {
  const f = fixture();
  f.add('tli-no-ai-banner', 'tli-no-ai-download-btn', 'banner-title', 'banner-sub');
  f.nodes['tli-no-ai-banner'].classList.add('hidden');
  f.nodes['tli-no-ai-banner'].parts = {'.tli-no-ai-banner-title': f.nodes['banner-title'], '.tli-no-ai-banner-sub': f.nodes['banner-sub']};
  f.run(app.slice(app.indexOf('const _LMSTUDIO_REPORT_CACHE'), app.indexOf('async function tliFetchBundledStatus')));
  f.run(app.slice(app.indexOf('async function refreshLocalAI()'), app.indexOf('async function lanAiChat()')));
  f.run(app.slice(app.indexOf('async function refreshBrainHealthFromReport()'), app.indexOf('// Home Automation pill helpers')));
  f.run(app.slice(app.indexOf('async function _refreshNoAiBanner()'), app.indexOf('// ── Image attach state')));
  return f;
}

test('provider reports share one request and current successful checks retain their cache', async () => {
  const f = appFixture(), pending = deferred(); f.respond(() => pending.promise);
  const a = f.ctx.tliFetchLMStudioReport(), b = f.ctx.tliFetchLMStudioReport(); await tick(); assert.equal(f.calls.length, 1);
  pending.resolve(json({ok: true, schema_ok: true, models: ['private-model']})); await Promise.all([a, b]);
  await f.ctx.refreshLocalAI(); assert.equal(f.calls.length, 1); assert.equal(f.ctx.AIStatus.local.available, true);
  assert.equal(f.ctx.AIStatus.local.health, 'ok');
});

test('locking before a queued report starts prevents the provider request entirely', async () => {
  const f = appFixture(); const pending = f.ctx.tliFetchLMStudioReport(); f.emit('tli-session-locked');
  assert.equal((await pending).access_paused, true); assert.equal(f.calls.length, 0);
});

for (const status of [401, 403]) test(`provider report ${status} clears cache and keeps bare-unlock polls paused`, async () => {
  const f = appFixture(); f.respond(async () => json({detail: 'Unlock required', private: 'must not retain'}, status));
  await f.ctx.refreshLocalAI(); assert.equal(f.run('_LMSTUDIO_REPORT_CACHE.payload'), null);
  assert.equal(f.ctx.AIStatus.local.health, 'unknown');
  const count = f.calls.length; f.emit('tli-session-unlocked'); await f.ctx.refreshLocalAI(); await f.ctx.refreshBrainHealthFromReport();
  assert.equal(f.calls.length, count); assert.equal((await f.ctx.resolveIntelligenceRoute()).source, 'none');
  f.emit('tli-private-observation-ready'); assert.equal(f.calls.length, count);
  f.respond(async () => json({ok: true})); await f.ctx.refreshLocalAI(); assert.equal(f.ctx.AIStatus.local.available, true);
});

for (const status of [200, 401, 403]) test(`old report ${status} cannot replace a new cache or relock renewed access`, async () => {
  const f = appFixture(), pending = deferred(); f.respond(() => pending.promise);
  const old = f.ctx.refreshLocalAI(); await tick(); f.emit('tli-session-locked'); f.recover();
  f.respond(async () => json({ok: true, model: 'new'})); await f.ctx.refreshLocalAI();
  pending.resolve(json({ok: true, model: 'old'}, status)); await old;
  assert.equal(f.ctx.AIStatus.local.available, true); assert.equal(f.run('_LMSTUDIO_REPORT_CACHE.payload.model'), 'new');
});

test('old report completion cannot clear a newer in-flight check or repaint the legacy Brain pill', async () => {
  const f = appFixture(), old = deferred(), newer = deferred(); f.respond(() => old.promise);
  const painting = f.ctx.refreshBrainHealthFromReport(); await tick(); f.emit('tli-session-locked'); f.recover();
  f.respond(() => newer.promise); const check = f.ctx.tliFetchLMStudioReport(); await tick(); const count = f.pills.length;
  old.resolve(json({ok: true, model: 'private old'})); await painting; assert.equal(f.pills.length, count);
  const duplicate = f.ctx.tliFetchLMStudioReport(); await tick(); assert.equal(f.calls.length, 2);
  newer.resolve(json({ok: true})); await Promise.all([check, duplicate]);
});

test('an older general-status response cannot repaint provider health or launch a report in a renewed session', async () => {
  const f = appFixture(), pending = deferred(); f.ctx.setMeshModelStatus = () => {};
  f.run(app.slice(app.indexOf('// ---------- status ----------'), app.indexOf('// ---------- device rename')));
  f.respond(() => pending.promise); const old = f.ctx.refreshStatus();
  f.emit('tli-session-locked');
  f.respond(async () => json({model_online:true,node_role:'standalone',mesh_status:'unpaired'}));
  f.recover(); await tick(); const count = f.pills.length;
  pending.resolve(json({model_online: false})); await old;
  assert.equal(f.pills.length, count); assert.deepEqual(f.calls.map(([url]) => url), ['/status', '/status']);
});

for (const response of [json(null), json({}), json({ok: true, available: true}, 503)]) test('unreadable or failed reports cannot claim a healthy provider', async () => {
  const f = appFixture(); f.respond(async () => response); await f.ctx.refreshLocalAI();
  assert.equal(f.ctx.AIStatus.local.available, false); assert.equal(f.ctx.AIStatus.local.health, 'unknown');
});

test('bundled mode still skips LM Studio probing', async () => {
  const f = appFixture(); f.ctx.AIStatus.local.provider = 'bundled';
  assert.equal((await f.ctx.tliFetchLMStudioReport()).reason, 'bundled_mode'); assert.equal(f.calls.length, 0);
});

for (const status of [401, 403]) test(`no-AI banner ${status} stops before a mesh read and hides old private text`, async () => {
  const f = appFixture(); f.nodes['banner-sub'].textContent = 'Private peer'; f.nodes['tli-no-ai-banner'].classList.remove('hidden');
  f.respond(async url => url.endsWith('/model/info') ? json({exists: false}) : json({detail: 'Unlock required'}, status));
  await f.ctx._refreshNoAiBanner(); assert.deepEqual(f.calls.map(([url]) => url), ['/api/ai/model/info', '/health/llm']);
  assert.equal(f.nodes['tli-no-ai-banner'].classList.contains('hidden'), true); assert.equal(f.nodes['banner-sub'].textContent, '');
  f.emit('tli-session-unlocked'); await f.ctx._refreshNoAiBanner(); assert.equal(f.calls.length, 2);
});

for (const data of [{ok: true}, {healthy: true}]) test('no-AI banner accepts actual boolean health without looking for another provider', async () => {
  const f = appFixture(); f.respond(async url => json(url.endsWith('/model/info') ? {exists: false} : data));
  await f.ctx._refreshNoAiBanner(); assert.equal(f.calls.length, 2); assert.equal(f.nodes['tli-no-ai-banner'].classList.contains('hidden'), true);
});

for (const status of [200, 403, 503]) test(`late no-AI health ${status} cannot trigger peer checks after lock`, async () => {
  const f = appFixture(), pending = deferred(); f.respond(async url => url.endsWith('/model/info') ? json({exists: false}) : pending.promise);
  const read = f.ctx._refreshNoAiBanner(); await tick(); f.emit('tli-session-locked'); f.recover();
  pending.resolve(json({ok: false}, status)); await read; assert.equal(f.calls.length, 2);
  assert.equal(f.nodes['tli-no-ai-banner'].classList.contains('hidden'), true);
});

test('unknown no-AI health remains hidden while confirmed absent providers allow existing library advice', async () => {
  const f = appFixture(); f.respond(async url => json(url.endsWith('/model/info') ? {exists: false} : {}));
  await f.ctx._refreshNoAiBanner(); assert.equal(f.calls.length, 2); assert.equal(f.nodes['tli-no-ai-banner'].classList.contains('hidden'), true);
  f.respond(async url => json(url.endsWith('/model/info') ? {exists: false} : url === '/health/llm' ? {ok: false} : {available: false}));
  await f.ctx._refreshNoAiBanner(); assert.equal(f.nodes['tli-no-ai-banner'].classList.contains('hidden'), false);
  assert.match(f.nodes['banner-title'].textContent, /Selected model files are unavailable/);
});

function settingsFixture() {
  const f = fixture(); f.add('settings-model-url', 'settings-model-status', 'settings-model-id', 'settings-model-compat', 'settings-model-refresh', 'settings-model-save');
  f.run(settings); f.ctx.setupSettingsPanel(); return f;
}
const models = name => ({server_url: 'http://private-provider/v1/models', compat: {ok: true}, models: [{id: name, label: name}], current: {}});

for (const status of [401, 403]) test(`model inventory ${status} clears names and cannot replay a save on unlock`, async () => {
  const f = settingsFixture(); f.respond(async () => json(models('Private model'))); await f.ctx.fetchModelSettings();
  f.respond(async () => json({detail: 'Unlock required'}, status)); await f.ctx.fetchModelSettings();
  assert.equal(f.nodes['settings-model-id'].options.length, 0); assert.equal(f.nodes['settings-model-url'].textContent, '');
  assert.equal(f.nodes['settings-model-save'].disabled, true); const count = f.calls.length;
  f.emit('tli-session-unlocked'); await f.nodes['settings-model-refresh'].click(); assert.equal(f.retries, 1); assert.equal(f.calls.length, count);
  f.emit('tli-private-observation-ready'); assert.equal(f.calls.length, count);
  f.respond(async () => json(models('Current model'))); await f.nodes['settings-model-refresh'].click(); await tick();
  assert.equal(f.nodes['settings-model-id'].options[0].textContent, 'Current model');
  assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 0);
});

for (const status of [200, 403]) test(`old model inventory ${status} cannot replace a new session's model list`, async () => {
  const f = settingsFixture(), pending = deferred(); f.respond(() => pending.promise); const read = f.ctx.fetchModelSettings();
  f.emit('tli-session-locked'); f.recover(); f.respond(async () => json(models('Current'))); await f.ctx.fetchModelSettings();
  pending.resolve(json(models('Old'), status)); await read;
  assert.equal(f.nodes['settings-model-id'].options[0].textContent, 'Current'); assert.equal(f.nodes['settings-model-save'].disabled, false);
});

test('newer empty model inventory wins; failures are unavailable and keep stale save controls disabled', async () => {
  const f = settingsFixture(), pending = deferred(); f.respond(() => pending.promise); const old = f.ctx.fetchModelSettings();
  f.respond(async () => json({models: []})); await f.ctx.fetchModelSettings(); pending.resolve(json(models('Old'))); await old;
  assert.equal(f.nodes['settings-model-id'].options[0].textContent, 'No models reported by server'); assert.equal(f.nodes['settings-model-save'].disabled, true);
  f.respond(async () => json({detail: 'Provider unavailable'}, 503)); await f.ctx.fetchModelSettings();
  assert.match(f.nodes['settings-model-status'].textContent, /unavailable/); assert.equal(f.nodes['settings-model-id'].options.length, 0);
});

for (const status of [200, 403]) test(`late default-model save ${status} cannot toast private selection or reenable controls`, async () => {
  const f = settingsFixture(); f.respond(async () => json(models('Private model'))); await f.ctx.fetchModelSettings();
  f.nodes['settings-model-id'].value = 'Private model'; const pending = deferred(); f.respond(() => pending.promise);
  const save = f.nodes['settings-model-save'].click(); await f.nodes['settings-model-save'].fire('click');
  f.emit('tli-session-locked'); f.recover(); pending.resolve(json({ok: true, model: {label: 'Private model'}}, status)); await save;
  assert.equal(f.toasts.length, 0); assert.equal(f.nodes['settings-model-save'].disabled, true);
  assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 1);
});

test('a fresh model read during a save cannot replay it or leave valid new controls permanently busy', async () => {
  const f = settingsFixture(); f.respond(async () => json(models('First'))); await f.ctx.fetchModelSettings();
  f.nodes['settings-model-id'].value = 'First'; const pending = deferred(); f.respond(() => pending.promise);
  const save = f.nodes['settings-model-save'].click();
  f.respond(async () => json(models('Current'))); await f.ctx.fetchModelSettings();
  assert.equal(f.nodes['settings-model-save'].disabled, true);
  pending.resolve(json({ok: true, model: {label: 'First'}})); await save;
  assert.equal(f.nodes['settings-model-save'].disabled, false); assert.equal(f.toasts.length, 0);
  assert.equal(f.nodes['settings-model-id'].options[0].textContent, 'Current');
  assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 1);
});

function sourceFixture() {
  const f = fixture(); f.add('ai-source-pill', 'ai-source-text', 'ai-source-badge', 'ai-manage-btn');
  f.ctx.resolveIntelligenceRoute = async () => ({source: 'none'}); f.run(aiSource);
  f.respond(async url => json(url.endsWith('/model/info') ? {exists: true, healthy: true} : url.endsWith('/mesh/status') ? {available: false} : {healthy: true}));
  return f;
}

test('AI source polling remains paused through bare unlock and resumes once after verified readiness', async () => {
  const f = sourceFixture(); await f.window.TLIAISource.refresh(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  const count = f.calls.length; await f.window.TLIAISource.refresh({force: true}); assert.equal(f.calls.length, count);
  assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Check access');
  f.emit('tli-private-observation-ready'); f.emit('tli-private-observation-ready'); await tick();
  assert.equal(f.calls.length, count + 3); assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Integrated');
});

test('old AI source probes cannot launch fallback, clear a new poll, or repaint after renewal', async () => {
  const f = sourceFixture(), old = deferred(), newer = deferred(); f.respond(() => old.promise);
  const first = f.window.TLIAISource.refresh(); await tick(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  f.respond(() => newer.promise); f.emit('tli-private-observation-ready'); await tick();
  old.resolve(json({})); await first; assert.equal(f.calls.length, 6);
  const active = f.window.TLIAISource.refresh(); assert.equal(f.calls.length, 6);
  newer.resolve(json({healthy: true, exists: true})); await active; assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Integrated');
});

test('current AI source denial pauses later intervals without a bare-unlock retry loop', async () => {
  const f = sourceFixture(); f.respond(async () => json({}, 403)); await f.window.TLIAISource.refresh();
  const count = f.calls.length; f.emit('tli-session-unlocked'); await f.window.TLIAISource.refresh();
  assert.equal(f.calls.length, count); assert.equal(f.window.__tliBundledStatus, null);
});
