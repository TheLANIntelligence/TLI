const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/settings.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; };
const json = (data, status = 200) => ({ok: status < 400, status, json: async () => data});
const profile = current => ({current, profiles: {lite: {label: 'Lite'}, balanced: {label: 'Balanced'}, power: {label: 'Power'}}});
const models = {models: [{id: 'saved-model', label: 'Saved model'}], current: {default_key: 'retained-preset', models: {'retained-preset': {id: 'saved-model'}}}};

async function fixture() {
  const nodes = {}, events = {}, calls = [], toasts = [], storage = new Map([['tli_settings', '{"defaultTemp":"0.4","customDraft":"keep"}']]);
  function element() {
    const classes = new Set();
    const n = {value: '', textContent: '', disabled: false, dataset: {}, handlers: {}, children: [], options: [],
      classList: {contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key)},
      setAttribute() {}, addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      appendChild(child) { this.children.push(child); this.options.push(child); },
      async fire(name) { for (const fn of this.handlers[name] || []) await fn({target: this}); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); }};
    Object.defineProperty(n, 'innerHTML', {get() { return ''; }, set() { this.children = []; this.options = []; this.value = ''; }});
    return n;
  }
  for (const id of ['settings-system-profile', 'settings-system-profile-meta', 'settings-system-profile-save', 'settings-system-profile-refresh',
    'settings-model-id', 'settings-model-status', 'settings-model-url', 'settings-model-compat', 'settings-model-save', 'settings-model-refresh', 'chat-input']) nodes[id] = element();
  nodes['chat-input'].value = 'Unsent ordinary question';
  let handler = async url => json(url === '/system/profile' ? profile('balanced') : url === '/models/available' ? models : {cpu_cores: 8, cpu_threads: 16, ram_total_gb: 32, suggested_profile: 'power'});
  let retries = 0;
  const window = {addEventListener: (name, fn) => (events[name] ||= []).push(fn), dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); }, EventInterpreter: {retry() { retries++; }}};
  const ctx = vm.createContext({window, AbortSignal, CustomEvent: class {constructor(type) { this.type = type; }},
    document: {hidden: false, getElementById: id => nodes[id] || null, createElement: element, querySelectorAll: () => []},
    $: id => nodes[id] || null, localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    console: {log() {}}, debugLog() {}, showToast: (...args) => toasts.push(args),
    fetch: async (url, options = {}) => { calls.push({url, options}); return handler(url, options); }});
  vm.runInContext(source, ctx); ctx.setupSettingsPanel(); await tick(); calls.length = 0;
  return {ctx, nodes, calls, toasts, storage, window,
    respond(fn) { handler = fn; }, emit(type) { window.dispatchEvent({type}); },
    recover() { this.emit('tli-session-unlocked'); this.emit('tli-private-observation-ready'); },
    get retries() { return retries; },
    async choose(name = 'power') { nodes['settings-system-profile'].value = name; return nodes['settings-system-profile-save'].click(); },
    posts: () => calls.filter(call => call.options.method === 'POST'),
    addPanel() { nodes['panel-settings'] = element(); return nodes['panel-settings']; }};
}

test('profile save uses the selected value once and requires its exact acknowledgement before refreshing', async () => {
  const f = await fixture(), pending = deferred();
  f.respond(async (url, options) => options.method === 'POST' ? pending.promise : json(profile('power')));
  const save = f.choose(); await f.nodes['settings-system-profile-save'].fire('click'); assert.equal(f.posts().length, 1);
  assert.deepEqual(JSON.parse(f.posts()[0].options.body), {profile: 'power'});
  pending.resolve(json({ok: true, current: 'power'})); await save;
  assert.equal(f.nodes['settings-system-profile'].value, 'power'); assert.equal(f.nodes['settings-system-profile-save'].disabled, false);
  assert.equal(f.nodes['settings-system-profile-meta'].dataset.state, 'saved');
  assert.equal(f.calls.filter(call => call.options.method !== 'POST').length, 1);
  assert.match(f.toasts.at(-1)[0], /System profile saved: power/);
  assert.equal(f.nodes['chat-input'].value, 'Unsent ordinary question'); assert.equal(f.storage.get('tli_settings'), '{"defaultTemp":"0.4","customDraft":"keep"}');
});

for (const status of [401, 403]) test(`profile read ${status} clears private choice and bare unlock cannot read or save`, async () => {
  const f = await fixture(); f.respond(async () => json({detail: 'Unlock required'}, status)); await f.ctx.fetchSystemProfileSettings();
  assert.equal(f.nodes['settings-system-profile'].value, ''); assert.equal(f.nodes['settings-system-profile-save'].disabled, true);
  const count = f.calls.length; f.emit('tli-session-unlocked'); await f.nodes['settings-system-profile-refresh'].click();
  assert.equal(f.retries, 1); assert.equal(f.calls.length, count); await f.nodes['settings-system-profile-save'].fire('click'); assert.equal(f.posts().length, 0);
  f.emit('tli-private-observation-ready'); assert.equal(f.calls.length, count);
  f.respond(async () => json(profile('lite'))); await f.nodes['settings-system-profile-refresh'].click(); await tick();
  assert.equal(f.nodes['settings-system-profile'].value, 'lite'); assert.equal(f.nodes['settings-system-profile-save'].disabled, false);
});

for (const status of [200, 401, 403]) test(`profile read ${status} from an old session cannot repaint or relock a new selection`, async () => {
  const f = await fixture(), pending = deferred(); f.respond(() => pending.promise); const read = f.ctx.fetchSystemProfileSettings();
  f.emit('tli-session-locked'); f.recover(); f.respond(async () => json(profile('lite'))); await f.ctx.fetchSystemProfileSettings();
  pending.resolve(json(profile('power'), status)); await read;
  assert.equal(f.nodes['settings-system-profile'].value, 'lite'); assert.equal(f.nodes['settings-system-profile-save'].disabled, false);
});

for (const failure of ['503', 'malformed', 'network']) test(`profile ${failure} read is unavailable and cannot leave a writable prior choice`, async () => {
  const f = await fixture(); f.respond(async () => {
    if (failure === 'network') throw Error('Disconnected');
    return failure === '503' ? json({detail: 'Saved profile unreadable'}, 503) : json({current: 'power'});
  });
  await f.ctx.fetchSystemProfileSettings(); assert.equal(f.nodes['settings-system-profile'].value, '');
  assert.equal(f.nodes['settings-system-profile-save'].disabled, true); assert.match(f.nodes['settings-system-profile-meta'].textContent, /unavailable/);
});

for (const failure of ['503', 'network', 'wrong-ack', 'empty-ack']) test(`unconfirmed profile ${failure} save requires explicit read and is never replayed`, async () => {
  const f = await fixture(); f.respond(async () => {
    if (failure === 'network') throw Error('Disconnected');
    return failure === '503' ? json({detail: 'Commit unconfirmed'}, 503) : json(failure === 'wrong-ack' ? {ok: true, current: 'lite'} : {ok: true});
  });
  await f.choose(); assert.equal(f.posts().length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.nodes['settings-system-profile-save'].disabled, true); assert.match(f.nodes['settings-system-profile-meta'].textContent, /save unconfirmed/);
  await f.nodes['settings-system-profile-save'].fire('click'); assert.equal(f.posts().length, 1);
  f.respond(async () => json(profile('power'))); await f.nodes['settings-system-profile-refresh'].click(); await tick();
  assert.equal(f.posts().length, 1); assert.equal(f.nodes['settings-system-profile'].value, 'power'); assert.equal(f.nodes['settings-system-profile-save'].disabled, false);
});

for (const status of [200, 401, 403, 503]) test(`late profile save ${status} cannot publish success or trigger a follow-up read`, async () => {
  const f = await fixture(), pending = deferred(); f.respond(() => pending.promise); const save = f.choose();
  f.emit('tli-session-locked'); f.recover(); pending.resolve(json({ok: true, current: 'power'}, status)); await save;
  assert.equal(f.calls.length, 1); assert.equal(f.toasts.length, 0); assert.equal(f.nodes['settings-system-profile-save'].disabled, true);
  assert.match(f.nodes['settings-system-profile-meta'].textContent, /save is unconfirmed/);
});

test('profile reads supersede older reads and a fresh read during a save preserves the newer result', async () => {
  const f = await fixture(), old = deferred(); f.respond(() => old.promise); const first = f.ctx.fetchSystemProfileSettings();
  assert.equal(f.nodes['settings-system-profile-meta'].dataset.state, 'loading');
  f.respond(async () => json(profile('lite'))); await f.ctx.fetchSystemProfileSettings(); old.resolve(json(profile('balanced'))); await first;
  assert.equal(f.nodes['settings-system-profile'].value, 'lite');
  const pending = deferred(); f.respond(() => pending.promise); const save = f.choose();
  f.respond(async () => json(profile('balanced'))); await f.ctx.fetchSystemProfileSettings();
  pending.resolve(json({ok: true, current: 'power'})); await save;
  assert.equal(f.nodes['settings-system-profile'].value, 'balanced'); assert.equal(f.toasts.length, 0);
  assert.equal(f.nodes['settings-system-profile-save'].disabled, false);
});

test('verified readiness refreshes a visible profile once without hardware probes or mutation replay', async () => {
  const f = await fixture(); f.addPanel(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); assert.equal(f.calls.length, 0);
  f.respond(async url => json(url === '/system/profile' ? profile('balanced') : models));
  f.emit('tli-private-observation-ready'); f.emit('tli-private-observation-ready'); await tick();
  assert.equal(f.calls.filter(call => call.url === '/system/profile').length, 1);
  assert.equal(f.calls.filter(call => call.url === '/system/probe').length, 0); assert.equal(f.posts().length, 0);
});

for (const transition of ['lock', 'profile-read', 'profile-save']) test(`late hardware advice cannot overwrite profile metadata after ${transition}`, async () => {
  const f = await fixture(), pending = deferred(); f.respond(() => pending.promise); const probe = f.ctx.fetchHardwareProbe();
  if (transition === 'lock') { f.emit('tli-session-locked'); f.recover(); }
  f.respond(async (url, options) => options.method === 'POST' ? json({ok: true, current: 'power'}) : json(profile('power')));
  if (transition === 'profile-save') await f.choose(); else await f.ctx.fetchSystemProfileSettings();
  const current = f.nodes['settings-system-profile-meta'].textContent;
  pending.resolve(json({cpu_cores: 99, cpu_threads: 99, ram_total_gb: 999, suggested_profile: 'old'})); await probe;
  assert.equal(f.nodes['settings-system-profile-meta'].textContent, current); assert.doesNotMatch(current, /999|OLD/);
});

for (const status of [401, 403]) test(`profile save ${status} immediately clears private selection without claiming no write occurred`, async () => {
  const f = await fixture(); f.respond(async () => json({detail: 'Access revoked'}, status)); await f.choose();
  assert.equal(f.nodes['settings-system-profile'].value, ''); assert.match(f.nodes['settings-system-profile-meta'].textContent, /save is unconfirmed/);
  assert.equal(f.calls.length, 1); assert.equal(f.toasts.length, 0);
});

for (const failure of ['503', 'network', 'wrong-ack']) test(`default-model ${failure} save remains unconfirmed until a fresh deliberate read`, async () => {
  const f = await fixture(); f.respond(async () => json(models)); await f.ctx.fetchModelSettings();
  f.nodes['settings-model-id'].value = 'saved-model'; const before = f.calls.length;
  f.respond(async () => { if (failure === 'network') throw Error('Disconnected'); return failure === '503' ? json({detail: 'Commit unconfirmed'}, 503) : json({ok: true, model: {id: 'other'}}); });
  await f.nodes['settings-model-save'].click(); assert.equal(f.calls.length, before + 1); assert.equal(f.posts().length, 1);
  assert.equal(f.nodes['settings-model-save'].disabled, true); assert.match(f.nodes['settings-model-status'].textContent, /save unconfirmed/);
  f.respond(async () => json(models)); await f.nodes['settings-model-refresh'].click(); await tick();
  assert.equal(f.nodes['settings-model-save'].disabled, false); assert.equal(f.posts().length, 1);
});

test('default-model success accepts the returned preserved preset key and keeps browser chat preferences intact', async () => {
  const f = await fixture(); f.respond(async () => json(models)); await f.ctx.fetchModelSettings();
  f.nodes['settings-model-id'].value = 'saved-model';
  f.respond(async () => json({ok: true, default_key: 'retained-preset', model: {id: 'saved-model', label: 'Saved model'}}));
  await f.nodes['settings-model-save'].click(); assert.match(f.toasts.at(-1)[0], /Saved default model/);
  assert.equal(f.storage.get('tli_settings'), '{"defaultTemp":"0.4","customDraft":"keep"}');
  assert.equal(f.nodes['chat-input'].value, 'Unsent ordinary question');
});

for (const code of [401,403]) test(`current hardware ${code} clears access even if a newer profile read changed its display`, async () => {
  const f=await fixture(),pending=deferred();f.respond(()=>pending.promise);const hardware=f.ctx.fetchHardwareProbe();
  f.respond(async()=>json(profile('power')));await f.ctx.fetchSystemProfileSettings();pending.resolve(json({detail:'Denied'},code));await hardware;
  assert.equal(f.nodes['settings-system-profile'].value,'');assert.equal(f.nodes['settings-system-profile-save'].disabled,true);
  assert.match(f.nodes['settings-system-profile-meta'].textContent,/Unlock/);const count=f.calls.length;f.recover();await tick();assert.equal(f.calls.length,count);
});

for (const code of [401,403]) test(`old hardware ${code} cannot relock a new Settings session`, async () => {
  const f=await fixture(),pending=deferred();f.respond(()=>pending.promise);const hardware=f.ctx.fetchHardwareProbe();
  f.emit('tli-session-locked');f.recover();f.respond(async()=>json(profile('power')));await f.ctx.fetchSystemProfileSettings();
  pending.resolve(json({detail:'Old denial'},code));await hardware;
  assert.equal(f.nodes['settings-system-profile'].value,'power');assert.equal(f.nodes['settings-system-profile-save'].disabled,false);
});

for (const value of [{},{detail:'Unexpected success'}, {cpu_cores:8,cpu_threads:16,ram_total_gb:32,suggested_profile:'unknown'},
  {cpu_cores:8,cpu_threads:16,ram_total_gb:'32',suggested_profile:'balanced'}]) test('malformed Settings hardware success never publishes invented advice', async () => {
  const f=await fixture();f.respond(async()=>json(value));await f.ctx.fetchHardwareProbe();
  assert.match(f.nodes['settings-system-profile-meta'].textContent,/unavailable/);assert.doesNotMatch(f.nodes['settings-system-profile-meta'].textContent,/undefined|UNDEFINED|Hardware:/);
  assert.equal(f.nodes['settings-system-profile'].value,'balanced');assert.equal(f.nodes['settings-system-profile-save'].disabled,false);
});

test('valid hardware advice preserves saved profile and chat draft, with a bounded read',async()=>{
  const f=await fixture();f.respond(async()=>json({cpu_cores:8,cpu_threads:16,ram_total_gb:32,suggested_profile:'power'}));await f.ctx.fetchHardwareProbe();
  assert.match(f.nodes['settings-system-profile-meta'].textContent,/8C\/16T.*32 GB RAM.*POWER/);
  assert.equal(f.nodes['settings-system-profile'].value,'balanced');assert.equal(f.nodes['chat-input'].value,'Unsent ordinary question');
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);assert.equal(f.calls[0].options.cache,'no-store');assert.equal(f.posts().length,0);
});
