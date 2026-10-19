const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/system-state-bar.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (state = {}, ts = 1000) => ({ ok: true, ts, state: { cpu_pct: 37, ram_pct: 46, disk_pct_by_drive: { 'C:\\': 96 }, device_count: 2, last_event_ts: 999, probed_ts: ts, ...state } });

function fixture(initial = snapshot(), {narrator,intercepted=false,idle=false} = {}) {
  let now = idle ? 3000000 : 1000000, respond = async () => ({ data: initial });
  const nodes = {}, intervals = [], requests = [], events = {};
  function element() {
    const classes = new Set(), values = [];
    const n = { dataset: {}, attrs: {}, children: [], values,
      classList: { toggle(key, enabled) { enabled ? classes.add(key) : classes.delete(key); }, contains: key => classes.has(key) },
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); },
      get textContent() { return values.at(-1) || ''; }, set textContent(text) { values.push(String(text)); },
      querySelector(selector) { const metric = selector.match(/data-metric='(\w+)'/); return metric ? nodes[metric[1]] : nodes.diskMetric; },
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = this; } }); return n;
  }
  for (const id of ['tli-state-bar', 'cpu', 'ram', 'disk', 'dev', 'ts', 'diskMetric']) nodes[id] = element();
  const Interpreter = { init() {}, on: (key, fn) => { events[key] = fn; } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const window = {EventInterpreter: Interpreter, location:{href:'http://localhost/',origin:'http://localhost'},
    addEventListener:(name,fn)=>(events[name] ||= []).push(fn),
    dispatchEvent:event=>{for(const fn of events[event.type] || [])fn(event);}};
  const ctx = vm.createContext({ console, Date: Clock, AbortSignal, EventInterpreter: Interpreter, URL, Headers, CustomEvent,
    window,
    document: { readyState: 'complete', getElementById: id => nodes[id] || null, createElement: element, addEventListener() {} },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {}, setTimeout() {},
    localStorage: { getItem: () => idle ? '1' : null, setItem() { assert.fail('No persistence during metric checks'); } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const reply = url.includes('/dashboard/narrator') ? narrator ? await narrator() : { data: null } : await respond(url, options);
      return { ok: !reply.status || reply.status === 200, status: reply.status || 200, json: async () => reply.data, clone(){return this;} };
    },
  });
  if(intercepted){
    window.fetch=ctx.fetch;window.TLIPinLock={checkAndLock:async()=>{await tick();window.dispatchEvent(new CustomEvent('tli-session-unlocked'));}};
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/fetch-interceptor.js'),'utf8'),ctx);
    ctx.fetch=(...args)=>window.fetch(...args);
  }
  vm.runInContext(source, ctx);
  return { nodes, events, requests, presence:ctx.window.TLIPresence, context:ctx, respond: fn => { respond = fn; },
    event:name=>window.dispatchEvent(new CustomEvent(name)),
    status: () => nodes['ssb-monitoring-status'].textContent,
    async poll() { intervals.find(t => t.ms === 10000).fn(); await tick(); },
    advance(ms) { now += ms; intervals.filter(t => t.ms === 1000).forEach(t => t.fn()); },
  };
}

test('first observation renders actual values immediately, without fabricated count-up readings', async () => {
  const f = fixture(); assert.equal(f.nodes.cpu.textContent, '--'); await tick();
  assert.equal(f.nodes.cpu.textContent, '37%'); assert.equal(f.nodes.ram.textContent, '46%');
  assert.deepEqual(f.nodes.cpu.values, ['--', '37%']); assert.equal(f.status(), 'Metrics current');
  assert.equal(f.nodes.diskMetric.classList.contains('ssb-critical'), true);
});

test('metric-only SSE cannot replace the registered inventory with its placeholder zero', async () => {
  const initial = {...snapshot(), smart_home:{count:2, names:['External HDD', 'PSVR 2']}};
  const f=fixture(initial); await tick();
  assert.equal(f.nodes.dev.textContent, '2');
  f.events.state_update({...snapshot({device_count:0, cpu_pct:55},1005).state});
  assert.equal(f.nodes.cpu.textContent,'55%'); assert.equal(f.nodes.dev.textContent,'2');
  assert.equal(f.presence.getObservation().devCount,2);
  f.presence.acceptSnapshot({...snapshot({},1006), smart_home:{count:0,names:[]}});
  assert.equal(f.nodes.dev.textContent,'0');
});

test('shared Dashboard observation uses the same clock skew and failed-probe facts as the header', async () => {
  const {observation}=require('../js/ui-health.js');
  const f=fixture(snapshot({},2000)); await tick();
  assert.equal(observation(f.presence.getObservation(),1000000).freshness,'fresh');
  f.advance(30000);
  assert.equal(observation(f.presence.getObservation(),1030000).freshness,'stale');
  assert.match(f.status(),/Readings stale/);
  f.events.state_update({...snapshot({probe_error:'Probe failed'},2030).state});
  assert.equal(observation(f.presence.getObservation(),1030000).freshness,'unavailable');
  assert.match(f.status(),/Monitoring unavailable/);
});

test('real SSE envelopes preserve the host clock through EventInterpreter and Presence',async()=>{
  const f=fixture(snapshot({},2000));await tick();let stream;
  const interpreterSource=fs.readFileSync(path.join(__dirname,'../js/event_interpreter.js'),'utf8');
  const window={};
  const context=vm.createContext({window,Number,Set,Map,JSON,EventSource:class {constructor(){stream=this;}close(){}},setTimeout(){},clearTimeout(){}});
  vm.runInContext(interpreterSource,context);
  window.EventInterpreter.on('state_update',f.events.state_update);window.EventInterpreter.init();
  f.advance(1000);
  stream.onmessage({data:JSON.stringify({type:'state_update',ts:2001,payload:{...snapshot({cpu_pct:52},2001).state}})});
  assert.equal(f.status(),'Metrics current');assert.equal(f.nodes.cpu.textContent,'52%');
  const observed=require('../js/ui-health.js').observation(f.presence.getObservation(),1001000);
  assert.equal(observed.freshness,'fresh');assert.equal(observed.stamp,2001000);
  f.advance(30000);assert.match(f.status(),/^Readings stale/);
});

test('a failed storage refresh keeps previous capacity with its observation time',async()=>{
  const storage={ok:true,system:{drive:'C:',mount:'C:\\',pct:74,free_gb:26,total_gb:100}};
  const f=fixture({...snapshot(),storage});await tick();
  const original=f.presence.getObservation();
  f.advance(10000);f.presence.acceptSnapshot({...snapshot({},1010),storage:{ok:false,error:'Drive not ready'}});
  const failed=f.presence.getObservation();
  assert.equal(failed.storage.system.pct,74);assert.equal(failed.storageCheckedAt,original.storageCheckedAt);
  assert.equal(failed.storageUnavailable,true);
});

test('missing probes, metrics and device counts stay unknown instead of becoming healthy zeros', async () => {
  const f = fixture(snapshot({ cpu_pct: null, ram_pct: NaN, disk_pct_by_drive: {}, device_count: null })); await tick();
  for (const id of ['cpu', 'ram', 'disk', 'dev']) assert.equal(f.nodes[id].textContent, '--');
  assert.equal(f.status(), 'Some readings unavailable');
  f.events.state_update({ cpu_pct: 10, ram_pct: 20, disk_pct_by_drive: { '/': 50 } });
  assert.equal(f.nodes.cpu.textContent, '--'); assert.equal(f.status(), 'Monitoring freshness unknown');
  assert.equal(f.nodes.diskMetric.classList.contains('ssb-critical'), false);
});

test('readings become explicitly stale at 30 seconds even without a new poll or band change', async () => {
  const f = fixture(); await tick(); f.advance(29999); assert.equal(f.status(), 'Metrics current');
  f.advance(1); assert.match(f.status(), /^Readings stale · last check/);
  assert.equal(f.nodes.cpu.textContent, '37%'); assert.equal(f.nodes['tli-state-bar'].dataset.freshness, 'stale');
  assert.equal(f.requests.filter(r => r.url === '/dashboard/command-center').length, 1);
  f.events.state_update(snapshot({ cpu_pct: 37 }, 1030)); assert.equal(f.status(), 'Metrics current');
});

test('failed monitoring keeps explicitly labelled last readings and recovers on a confirmed probe', async () => {
  const f = fixture(); await tick();
  f.respond(async () => ({ status: 503 })); await f.poll();
  assert.match(f.status(), /^Monitoring unavailable/); assert.equal(f.nodes.cpu.textContent, '37%');
  f.advance(10000); f.respond(async () => ({ data: snapshot({ cpu_pct: 0, device_count: 0 }, 1010) })); await f.poll();
  assert.equal(f.status(), 'Metrics current'); assert.equal(f.nodes.cpu.textContent, '0%'); assert.equal(f.nodes.dev.textContent, '0');
});

test('legacy fallback retains its contract but cannot imply fresh metrics, and auth never falls back', async () => {
  const f = fixture(); await tick();
  f.respond(async url => url === '/dashboard/command-center' ? { status: 404 } : { data: { cpu_pct: 40, ram_pct: 60, device_count: 2 } });
  await f.poll(); assert.equal(f.status(), 'Monitoring freshness unknown'); assert.equal(f.nodes.cpu.textContent, '--');
  const fallbacks = f.requests.filter(r => r.url === '/dashboard/state').length;
  f.respond(async () => ({ status: 401 })); await f.poll(); assert.match(f.status(), /Monitoring paused.*Unlock TLI/);
  assert.equal(f.requests.filter(r => r.url === '/dashboard/state').length, fallbacks);
  assert.ok(f.requests.every(r => !r.options.method || r.options.method === 'GET'));
});

for(const status of [401,403])test(`monitoring ${status} clears private observations and pauses polling until a guarded access check succeeds`,async()=>{
  const f=fixture({...snapshot(),smart_home:{count:1,names:['Private printer']}});await tick();
  f.respond(async()=>({status,data:{detail:'Use an authorized browser on localhost.'}}));await f.poll();
  assert.equal(f.presence.getObservation().devNames.length,0);assert.equal(f.nodes.cpu.textContent,'--');
  assert.match(f.status(),/authorized browser/);const count=f.requests.length;
  f.event('tli-session-unlocked');await f.poll();await f.presence.fetchActionCurrent();assert.equal(f.requests.length,count);
  f.respond(async url=>({data:url.endsWith('/action/current')?null:snapshot()}));f.events.access_ready();await tick();
  assert.equal(f.status(),'Metrics current');assert.equal(f.requests.length,count+2);
});

test('the real global 401 interceptor and PIN-off unlock cannot restart monitoring or action reads',async()=>{
  const f=fixture(snapshot(),{intercepted:true});await tick();
  f.respond(async()=>({status:401,data:{detail:'Clear cookies.'}}));await f.poll();await tick();
  const count=f.requests.length;await f.poll();await f.presence.fetchActionCurrent();
  assert.equal(f.requests.length,count);assert.equal(f.nodes.cpu.textContent,'--');
  assert.match(f.status(),/paused/);
});

test('initial narrator result from an old session cannot populate the unlocked dashboard',async()=>{
  let finish;const f=fixture(snapshot(),{narrator:()=>new Promise(resolve=>{finish=resolve;})});const messages=[];
  f.context.window.TLIDash2={setEventMessage:message=>messages.push(message)};
  f.event('tli-session-locked');f.event('tli-session-unlocked');
  finish({data:{text:'Private old narrator',type:'status'}});await tick();assert.deepEqual(messages,[]);
  f.events.narrator_update({text:'Queued narrator'});assert.deepEqual(messages,[]);
  f.events.access_ready();await tick();f.events.narrator_update({text:'Fresh narrator'});assert.equal(messages.length,1);
});

test('pending return-visit narrator cannot paint after locking and entering a new session',async()=>{
  let reads=0,finish;const f=fixture(snapshot(),{idle:true,narrator:()=>++reads===1?{data:null}:new Promise(resolve=>{finish=resolve;})});
  const messages=[];f.context.window.TLIDash2={setEventMessage:message=>messages.push(message)};
  assert.equal(reads,2);f.event('tli-session-locked');f.event('tli-session-unlocked');f.events.access_ready();
  finish({data:{text:'Private old return-visit narrator'}});await tick();assert.deepEqual(messages,[]);
});

for(const status of [401,403])test(`return-visit narrator ${status} pauses monitoring without automatic retries`,async()=>{
  let reads=0,finish;const f=fixture(snapshot(),{idle:true,narrator:()=>++reads===1?{data:null}:new Promise(resolve=>{finish=resolve;})});
  await tick();finish({status,data:{detail:'Unlock the authorized browser before returning.'}});await tick();
  assert.match(f.status(),/authorized browser/);assert.equal(f.nodes.cpu.textContent,'--');
  const count=f.requests.length;f.event('tli-session-unlocked');await f.poll();await f.presence.fetchActionCurrent();
  assert.equal(f.requests.length,count);
});

test('server timestamps handle browser clock skew and late fetches cannot replace a newer SSE observation', async () => {
  const f = fixture(snapshot({}, 2000)); await tick(); assert.equal(f.status(), 'Metrics current');
  let finish; f.respond(() => new Promise(resolve => { finish = resolve; })); await f.poll();
  f.events.state_update(snapshot({ cpu_pct: 65 }, 2001));
  finish({ data: snapshot({ cpu_pct: 3 }, 2000) }); await tick();
  assert.equal(f.nodes.cpu.textContent, '65%'); assert.equal(f.status(), 'Metrics current');
  f.events.state_update(snapshot({ cpu_pct: 4 }, 1999)); assert.equal(f.nodes.cpu.textContent, '65%');
});

test('invalid percentages and invalid future probe times are never presented as current readings', async () => {
  const f = fixture(snapshot({ cpu_pct: -1, ram_pct: Infinity, disk_pct_by_drive: { '/': 101 }, last_event_ts: NaN })); await tick();
  for (const id of ['cpu', 'ram', 'disk', 'ts']) assert.equal(f.nodes[id].textContent, '--');
  assert.equal(f.status(), 'Some readings unavailable');
  f.events.state_update({ ...snapshot().state, probed_ts: 5000 });
  assert.equal(f.status(), 'Monitoring freshness unknown'); assert.equal(f.nodes.cpu.textContent, '--');
});
