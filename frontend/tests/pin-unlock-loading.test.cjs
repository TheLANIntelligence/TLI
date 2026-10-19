const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scripts = ['pin-lock.js', 'fetch-interceptor.js', 'event_interpreter.js', 'system-state-bar.js']
  .map(name => [name, fs.readFileSync(path.join(__dirname, '../js', name), 'utf8')]);
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = (data, status = 200) => ({ok:status >= 200 && status < 300, status,
  json:async () => data, clone() { return this; }});
function pending() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
const snapshot = () => ({ok:true, ts:1000, state:{cpu_pct:37, ram_pct:46,
  disk_pct_by_drive:{'C:\\':68}, device_count:2, probed_ts:1000, last_event_ts:999}});

// Browser globals and script order match index.html. Only DOM, network, clock,
// and timers are synthetic; PIN lifecycle, 401 handling, bus, and metrics are real.
function fixture() {
  const nodes = {}, documentEvents = {}, windowEvents = {}, events = [], calls = [], sources = [];
  const timers = new Map(), intervals = new Map(), storage = new Map(), status = pending();
  let nextTimer = 0, firstStatus = true, authorized = false;
  let verify = async () => { authorized = true; return reply({ok:true}); };
  let probe = async () => reply({detail:'Unlock TLI to read private activity.'}, 401);
  let action = null, actionResponse = async () => reply({detail:'Browser access changed.'}, 401);
  function element(id) {
    const classes = new Set();
    const handlers = {};
    const node = {style:{}, dataset:{}, attrs:{}, children:[], hidden:false, disabled:false,
      textContent:'', value:'', innerHTML:'',
      classList:{add:key => classes.add(key), remove:key => classes.delete(key), contains:key => classes.has(key),
        toggle(key, force) { if (force === undefined ? !classes.has(key) : force) classes.add(key); else classes.delete(key); }},
      setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
      appendChild(child) { this.children.push(child); }, after() {}, remove() {}, focus() {},
      addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
      click() { return this.disabled ? Promise.resolve() : Promise.all((handlers.click || []).map(fn => fn({}))); },
      querySelector(selector) { const metric = selector.match(/data-metric='(\w+)'/); return metric ? nodes[metric[1]] : nodes.diskMetric; },
    };
    Object.defineProperty(node, 'id', {set(value) { nodes[value] = node; }});
    if (id) nodes[id] = node;
    return node;
  }
  for (const id of ['tli-lock-screen', 'tli-lock-input', 'tli-lock-error', 'tli-lock-btn', 'tli-lock-submit',
    'tli-state-bar', 'cpu', 'ram', 'disk', 'dev', 'ts', 'diskMetric', 'nd-action-card']) element(id);
  nodes['tli-lock-screen'].classList.add('hidden');
  Object.defineProperty(nodes['nd-action-card'], 'innerHTML', {set(html) {
    this.html = html;
    for (const id of ['ac-confirm-btn', 'ac-secondary-btn', 'ac-dismiss-btn', 'ac-result']) delete nodes[id];
    for (const match of html.matchAll(/id="([^"]+)"/g)) element(match[1]);
  }});
  const document = {readyState:'loading', hidden:false, body:element(),
    getElementById:id => nodes[id] || null, createElement:() => element(), querySelectorAll:() => [],
    addEventListener:(name, fn) => (documentEvents[name] ||= []).push(fn)};
  class Source {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
    emit(data) { this.onmessage?.({data:JSON.stringify(data)}); }
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [1000000])); } static now() { return 1000000; } }
  const context = vm.createContext({console, document, CustomEvent, Headers, Request, URL, AbortSignal, Date:Clock,
    EventSource:Source, location:{href:'http://localhost/', origin:'http://localhost', reload() { assert.fail('Unlock must not reload the page'); }},
    addEventListener:(name, fn) => (windowEvents[name] ||= []).push(fn),
    dispatchEvent(event) { events.push(event); for (const fn of windowEvents[event.type] || []) fn(event); },
    sessionStorage:{getItem:key => storage.get(key), setItem:(key, value) => storage.set(key, value), removeItem:key => storage.delete(key)},
    localStorage:{getItem:key => key === 'tli_pin_nudge_v1' ? 'dismissed' : null, setItem() {}},
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; },
    clearTimeout:id => timers.delete(id),
    setInterval(fn, delay) { const id = ++nextTimer; intervals.set(id, {fn, delay}); return id; },
    clearInterval:id => intervals.delete(id),
    async fetch(url, options = {}) {
      calls.push({url, options});
      if (url === '/system/pin/status') {
        if (firstStatus) { firstStatus = false; return status.promise; }
        return reply({enabled:true});
      }
      if (url === '/system/pin/verify') return verify();
      if (url === '/system/pin/lock') { authorized = false; return reply({ok:true, locked:true}); }
      if (url === '/api/events/recent?n=0') return probe();
      if (url.startsWith('/dashboard/action/') && options.method === 'POST') return actionResponse();
      if (!authorized) return reply({detail:'Private dashboard access is locked.'}, 403);
      if (url === '/dashboard/command-center') return reply(snapshot());
      if (url === '/dashboard/narrator/current') return reply(null);
      if (url === '/dashboard/action/current') return reply(action);
      assert.fail('Unexpected request: ' + url);
    },
  });
  context.window = context;
  for (const [name, source] of scripts) vm.runInContext(source, context, {filename:name});
  for (const fn of documentEvents.DOMContentLoaded || []) fn();
  document.readyState = 'complete';
  return {context, nodes, calls, events, sources, timers, storage,
    locked:() => !nodes['tli-lock-screen'].classList.contains('hidden'),
    activeSources:() => sources.filter(source => !source.closed),
    probe:fn => { probe = fn; }, verify:fn => { verify = fn; },
    setAction(value) { action = value; }, actionResponse:fn => { actionResponse = fn; },
    resolveStatus() { status.resolve(reply({enabled:true})); },
    async submit(pin = '2468') { nodes['tli-lock-input'].value = pin; await nodes['tli-lock-submit'].click(); await tick(); },
    async startProbe() {
      sources[0].onerror();
      const [id, timer] = [...timers].find(([, value]) => value.delay === 5000);
      timers.delete(id); timer.fn(); await tick();
    },
    async poll() { for (const timer of intervals.values()) if (timer.delay === 10000) timer.fn(); await tick(); },
    async backgroundEvents() {
      for (const fn of documentEvents.visibilitychange || []) fn();
      context.dispatchEvent(new CustomEvent('pageshow')); context.EventInterpreter.init(); await this.poll();
    },
  };
}

const count = (f, url) => f.calls.filter(call => call.url === url).length;
const mutations = f => f.calls.filter(call => (call.options.method || 'GET') !== 'GET');
async function deniedStartup(f) {
  await tick();
  await f.startProbe(); f.resolveStatus(); await tick();
  assert.equal(f.locked(), true);
  assert.equal(f.nodes.cpu.textContent, '--');
  assert.equal(f.activeSources().length, 0);
  assert.equal(count(f, '/api/events/recent?n=0'), 1);
}
function assertLoaded(f) {
  assert.equal(f.locked(), false);
  assert.equal(f.nodes.cpu.textContent, '37%');
  assert.equal(f.nodes.ram.textContent, '46%');
  assert.equal(f.nodes['ssb-monitoring-status'].textContent, 'Metrics current');
  assert.equal(f.activeSources().length, 1);
  assert.equal(f.activeSources()[0].url, '/api/events/stream');
}

for (const setup of [false, true]) test(`${setup ? 'setup' : 'regular'} PIN verification resumes protected metrics and one shared stream after denied startup`, async () => {
  const f = fixture(); await deniedStartup(f);
  const guarded = pending(); f.probe(() => guarded.promise);
  const reads = count(f, '/dashboard/command-center');
  if (setup) await f.context.TLIPinLock.verifyForSetup('2468'); else await f.submit();
  assert.equal(f.events.filter(event => event.type === 'tli-session-unlocked').at(-1).detail.source, 'pin-verification');
  assert.equal(count(f, '/api/events/recent?n=0'), 2);
  assert.equal(count(f, '/dashboard/command-center'), reads, 'Verification alone cannot resume private reads');
  assert.equal(f.nodes.cpu.textContent, '--'); assert.equal(f.activeSources().length, 0);
  guarded.resolve(reply({events:[]})); await tick();
  assertLoaded(f);
  assert.equal(count(f, '/dashboard/command-center'), reads + 1);
  assert.equal(count(f, '/dashboard/action/current'), 1);
  assert.deepEqual(mutations(f).map(call => call.url), ['/system/pin/verify']);
  const stream = f.activeSources()[0];
  stream.emit({type:'state_update', ts:1001, payload:{...snapshot().state, cpu_pct:52, probed_ts:1001}});
  assert.equal(f.nodes.cpu.textContent, '52%');
  await f.backgroundEvents();
  assert.equal(f.activeSources().length, 1); assert.equal(f.sources.length, 2);
  assert.equal(count(f, '/api/events/recent?n=0'), 2);
});

for (const status of [403, 429]) test(`failed PIN (${status}) leaves private views paused without automatic verification or mutation replay`, async () => {
  const f = fixture(); await deniedStartup(f);
  const reads = count(f, '/dashboard/command-center');
  f.verify(async () => reply({detail:status === 429 ? 'Wait before trying again.' : 'Incorrect PIN.'}, status));
  await f.submit('wrong'); await f.backgroundEvents();
  assert.equal(f.locked(), true); assert.equal(f.nodes.cpu.textContent, '--');
  assert.equal(f.activeSources().length, 0); assert.equal(count(f, '/api/events/recent?n=0'), 1);
  assert.equal(count(f, '/dashboard/command-center'), reads);
  assert.equal(f.events.some(event => event.type === 'tli-session-unlocked'), false);
  assert.deepEqual(mutations(f).map(call => call.url), ['/system/pin/verify']);
});

for (const status of [401, 403, 503, 200]) test(`failed guarded recovery (${status === 200 ? 'malformed 200' : status}) does not resume metrics or SSE`, async () => {
  const f = fixture(); await deniedStartup(f);
  const reads = count(f, '/dashboard/command-center');
  f.probe(async () => reply({detail:'Access could not be confirmed.'}, status));
  await f.submit(); await f.backgroundEvents();
  assert.equal(f.nodes.cpu.textContent, '--'); assert.equal(f.activeSources().length, 0);
  assert.equal(count(f, '/api/events/recent?n=0'), 2);
  assert.equal(count(f, '/dashboard/command-center'), reads);
  assert.equal(f.events.some(event => event.type === 'tli-private-observation-ready'), false);
  assert.deepEqual(mutations(f).map(call => call.url), ['/system/pin/verify']);
});

for (const staleStatus of [200, 401]) test(`an older pending probe (${staleStatus}) cannot replace the fresh post-PIN check`, async () => {
  const f = fixture(), old = pending(), fresh = pending();
  f.probe(() => old.promise); await tick(); await f.startProbe();
  f.resolveStatus(); await tick(); assert.equal(f.locked(), true);
  f.probe(() => fresh.promise); await f.submit();
  const reads = count(f, '/dashboard/command-center');
  assert.equal(count(f, '/api/events/recent?n=0'), 1);
  old.resolve(reply(staleStatus === 200 ? {events:[]} : {detail:'Old cookie expired.'}, staleStatus));
  await tick();
  assert.equal(f.locked(), false, 'A stale 401 cannot relock confirmed newer verification');
  assert.equal(count(f, '/api/events/recent?n=0'), 2);
  assert.equal(count(f, '/dashboard/command-center'), reads);
  assert.equal(f.nodes.cpu.textContent, '--'); assert.equal(f.activeSources().length, 0);
  fresh.resolve(reply({events:[]})); await tick(); assertLoaded(f);
  assert.equal(count(f, '/dashboard/command-center'), reads + 1);
  assert.equal(f.sources.length, 2);
});

test('unlock after a denied submitted dashboard action refreshes reads but never repeats that action', async () => {
  const f = fixture(); await deniedStartup(f);
  f.probe(async () => reply({events:[]}));
  f.setAction({id:'reviewed-action', title:'Run reviewed scene', handler:'run_scene:example', confirm_label:'Run scene'});
  await f.submit(); assertLoaded(f);
  const oldButton = f.nodes['ac-confirm-btn'];
  await oldButton.click(); await tick();
  assert.equal(f.locked(), true); assert.equal(f.nodes.cpu.textContent, '--');
  assert.equal(count(f, '/dashboard/action/confirm'), 1);
  f.setAction(null); await f.submit(); assertLoaded(f); await f.backgroundEvents();
  await oldButton.click();
  assert.equal(count(f, '/dashboard/action/confirm'), 1, 'Detached controls must not replay a denied action');
  assert.deepEqual(mutations(f).map(call => call.url), ['/system/pin/verify', '/dashboard/action/confirm', '/system/pin/verify']);
});
