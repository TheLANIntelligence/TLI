const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const interpreter = fs.readFileSync(path.join(__dirname, '../js/event_interpreter.js'), 'utf8');
const feed = fs.readFileSync(path.join(__dirname, '../js/live-feed.js'), 'utf8');
const interceptor = fs.readFileSync(path.join(__dirname, '../js/fetch-interceptor.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = (data, status = 200) => ({ok:status < 300, status, json:async()=>data, clone(){return this;}});

function fixture({hidden = false, intercepted = false, pinOff = false, rendered = false, abortTimeout} = {}) {
  const sources = [], timers = new Map(), handlers = {}, dispatched = [], windowEvents = [], calls = [], nodes = {};
  let handler = async () => reply({events:[]});
  let nextTimer = 1;
  const on = (name, fn) => (handlers[name] ||= []).push(fn);
  function element() { return {children:[], dataset:{}, style:{}, handlers:{}, hidden:false, disabled:false, textContent:'',
    appendChild(child){this.children.push(child);}, insertBefore(child){this.children.unshift(child);}, replaceChildren(){this.children=[];},
    addEventListener(name,fn){this.handlers[name]=fn;}, click(){return this.handlers.click?.();}}; }
  if (rendered) for (const id of ['nd-feed','tli-feed-badge','panel-dashboard2']) nodes[id] = element();
  const document = {hidden, addEventListener:on, getElementById:id => nodes[id] || null, createElement:element,
    dispatchEvent:event => dispatched.push(event)};
  const window = {addEventListener:on, location:{href:'http://localhost/',origin:'http://localhost'},
    dispatchEvent:event => {windowEvents.push(event);for(const fn of handlers[event.type] || [])fn(event);},
    fetch:async(url,options)=>{calls.push({url,options});return handler(url,options);}};
  let alertToken = null;
  window.TLIShell = {alertOperations:{capture:()=>({}),isCurrent:()=>true,canBegin:()=>!alertToken,begin:()=>alertToken?null:(alertToken={}),current:token=>token===alertToken,settle:async token=>{if(token===alertToken)alertToken=null;}}};
  if(pinOff) window.TLIPinLock={checkAndLock:async()=>{await tick();window.dispatchEvent(new CustomEvent('tli-session-unlocked'));}};
  class Source {
    constructor(url) {this.url = url; this.closed = false; sources.push(this);}
    close() {this.closed = true;}
    emit(value) {this.onmessage({data:JSON.stringify(value)});}
  }
  const context = vm.createContext({window, document, CustomEvent, EventSource:Source, URL, Headers, AbortSignal:abortTimeout ? {timeout:abortTimeout} : AbortSignal,
    fetch:(...args)=>window.fetch(...args),
    setTimeout:(fn, delay) => {const id = nextTimer++; timers.set(id, {fn, delay}); return id;},
    clearTimeout:id => timers.delete(id)});
  if(intercepted)vm.runInContext(interceptor,context);
  vm.runInContext(interpreter, context);
  return {window, document, sources, timers, dispatched, windowEvents, nodes, calls, handler:fn=>{handler=fn;}, api:window.EventInterpreter,
    event:(name, detail) => {for (const fn of handlers[name] || []) fn(new CustomEvent(name, {detail}));},
    loadFeed:() => {vm.runInContext(feed, context); for (const fn of handlers.DOMContentLoaded || []) fn();},
    retry:() => {const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn();}};
}

test('activity and metric subscribers use one connection and retain both event contracts', () => {
  const f = fixture(), metrics = [], activity = [];
  f.api.on('state_update', value => metrics.push(value));
  f.api.on('classified_event', value => activity.push(value));
  f.api.init();
  f.loadFeed();
  f.api.init();
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].url, '/api/events/stream');
  f.sources[0].emit({type:'state_update', ts:1234, payload:{cpu_pct:37}});
  assert.equal(metrics[0].cpu_pct, 37);
  assert.equal(metrics[0].ts, 1234);
  f.sources[0].emit({id:'activity', title:'Device changed', category:'device', level:'info'});
  assert.equal(activity.length, 1);
  assert.equal(activity[0]._classified.category, 'device');
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].type, 'tli-activity-event');
  assert.equal(f.dispatched[0].detail.id, 'activity');
});

test('hidden tabs release their connection and reconnect once when visible', () => {
  const f = fixture({hidden:true}), received = [];
  f.api.on('classified_event', event => received.push(event));
  f.api.init();
  assert.equal(f.sources.length, 0);
  f.document.hidden = false; f.event('visibilitychange');
  const first = f.sources[0];
  first.emit({title:'Visible event'});
  f.document.hidden = true; f.event('visibilitychange');
  assert.equal(first.closed, true);
  first.emit({title:'Queued stale event'});
  assert.equal(received.length, 1);
  f.document.hidden = false; f.event('visibilitychange'); f.api.init();
  assert.equal(f.sources.length, 2);
  first.onerror();
  assert.equal(f.sources[1].closed, false);
  assert.equal(f.timers.size, 0);
  f.sources[1].emit({title:'Fresh event'});
  assert.equal(received.length, 2);
});

test('session lock closes the stream, cancels retries and rejects late events until checked unlock', async () => {
  const f = fixture(), received = [];
  f.api.on('classified_event', event => received.push(event)); f.api.init();
  const first = f.sources[0]; first.emit({title:'Before lock'}); first.onerror();
  assert.equal(f.timers.size, 1);
  f.event('tli-session-locked');
  assert.equal(f.timers.size, 0);
  assert.equal(f.api.getLastEvent(), null);
  f.api.init(); f.event('visibilitychange');
  assert.equal(f.sources.length, 1);
  first.emit({title:'Late private event'});
  assert.equal(received.length, 1);
  f.event('tli-session-unlocked'); f.event('tli-session-unlocked');
  await tick();
  assert.equal(f.sources.length, 2);
  f.sources[1].emit({title:'After unlock'});
  assert.equal(received.length, 2);
});

test('one retry survives repeated init and obsolete stream callbacks cannot close its replacement', async () => {
  const f = fixture(); f.api.init(); const first = f.sources[0];
  first.onerror(); first.onerror(); f.api.init();
  assert.equal(first.closed, true); assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 5000);
  assert.equal(f.sources.length, 1);
  f.retry(); await tick(); assert.equal(f.sources.length, 2); assert.equal(f.timers.size, 0);
  first.onerror(); assert.equal(f.sources[1].closed, false); assert.equal(f.timers.size, 0);
  f.sources[1].onerror(); f.document.hidden = true; f.event('visibilitychange');
  assert.equal(f.timers.size, 0);
});

test('page cache suspension releases sockets and resumes delivery on return', () => {
  const f = fixture(); f.api.init(); f.event('pagehide');
  assert.equal(f.sources[0].closed, true);
  f.api.init(); assert.equal(f.sources.length, 1);
  f.event('pageshow'); assert.equal(f.sources.length, 2);
});

test('terminal authorization frame closes the socket and clears retained and rendered events until explicit retry', async () => {
  const f=fixture({rendered:true,pinOff:true}); f.loadFeed();
  f.sources[0].emit({id:'private',title:'Private scan completed',body:'Private host detail'});
  assert.equal(f.nodes['nd-feed'].children.length,1);
  f.sources[0].emit({type:'auth_required',code:'session_changed'});
  assert.equal(f.sources[0].closed,true);assert.equal(f.api.getLastEvent(),null);
  assert.equal(f.nodes['tli-feed-badge'].style.display,'none');
  assert.match(f.nodes['nd-feed'].children[0].textContent,/Live activity paused/);
  f.sources[0].emit({title:'Late private result'});await tick();
  f.api.init();f.event('visibilitychange');f.event('pageshow');
  assert.equal(f.sources.length,1);assert.equal(f.calls.length,0);
  await f.nodes['nd-feed'].children[1].click();await tick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/events/recent?n=0');
  assert.equal(f.sources.length,2);assert.equal(f.nodes['nd-feed'].children.length,0);
});

for(const status of [401,403])test(`SSE admission ${status} clears private content and never loops after PIN-off unlock`,async()=>{
  const f=fixture({rendered:true,intercepted:true,pinOff:true});f.loadFeed();
  f.sources[0].emit({title:'Private event'});
  f.handler(async()=>reply({detail:'Clear this site’s cookies and retry on localhost.'},status));
  f.sources[0].onerror();f.retry();await tick();await tick();await tick();
  assert.equal(f.sources.length,1);assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
  assert.equal(f.api.getLastEvent(),null);assert.match(f.nodes['nd-feed'].children[0].textContent,/cookies/);
  f.event('tli-session-unlocked');f.api.init();f.event('visibilitychange');await tick();
  assert.equal(f.calls.length,1);
  f.handler(async()=>reply({events:[]}));await f.api.retry();
  assert.equal(f.sources.length,2);assert.equal(f.calls.length,2);
});

test('late authorization probe cannot open a stream after lock and a malformed probe requires explicit retry',async()=>{
  const f=fixture();f.api.init();let finish;f.handler(()=>new Promise(resolve=>{finish=resolve;}));
  f.sources[0].onerror();f.retry();f.event('tli-session-locked');finish(reply({events:[]}));await tick();
  assert.equal(f.sources.length,1);f.event('tli-session-unlocked');assert.equal(f.calls.length,1);
  f.handler(async()=>reply({}));await f.api.retry();assert.equal(f.sources.length,1);assert.equal(f.timers.size,0);
  f.handler(async()=>reply({events:[]}));await f.api.retry();assert.equal(f.sources.length,2);
});

test('locking clears feed actions and late completion cannot repaint or resubmit a detached action',async()=>{
  const f=fixture({rendered:true});f.loadFeed();let finish;
  f.handler(()=>new Promise(resolve=>{finish=resolve;}));
  f.sources[0].emit({title:'Private event',actions:[{label:'Dismiss',endpoint:'/status/alerts/example/dismiss'}]});
  const action=f.nodes['nd-feed'].children[0].children[0].children[0];
  const work=action.click();f.event('tli-session-locked');finish(reply({ok:true}));await work;
  assert.equal(f.nodes['nd-feed'].children.length,0);assert.notEqual(action.textContent,'Done');
  await action.click();assert.equal(f.calls.length,1);
});

test('an authorization probe times out and releases its pending slot for an explicit retry',async()=>{
  const timeouts=[];let controller;
  const f=fixture({rendered:true,abortTimeout:ms=>{timeouts.push(ms);controller=new AbortController();return controller.signal;}});
  f.loadFeed();f.handler((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason))));
  f.sources[0].onerror();f.retry();assert.deepEqual(timeouts,[10000]);
  controller.abort(new DOMException('Timed out','TimeoutError'));await tick();
  assert.equal(f.sources.length,1);assert.match(f.nodes['nd-feed'].children[0].textContent,/Check the host connection/);
  f.handler(async()=>reply({events:[]}));await f.api.retry();
  assert.equal(f.sources.length,2);assert.equal(f.calls.length,2);assert.deepEqual(timeouts,[10000,10000]);
});

const verifiedUnlock = f => f.event('tli-session-unlocked', {source:'pin-verification'});
const readyEvents = f => f.windowEvents.filter(event => event.type === 'tli-private-observation-ready');

test('confirmed PIN verification automatically recovers a terminal access pause through one read-only probe', async () => {
  const f = fixture({rendered:true}); const ready = [];
  f.api.on('access_ready', value => ready.push(value)); f.loadFeed();
  f.sources[0].emit({title:'Old private event'});
  f.sources[0].emit({type:'auth_required', code:'session_changed'});
  verifiedUnlock(f); await tick();
  assert.deepEqual(f.calls.map(call => call.url), ['/api/events/recent?n=0']);
  assert.ok(f.calls.every(call => !call.options.method || call.options.method === 'GET'));
  assert.equal(ready.length, 1); assert.equal(readyEvents(f).length, 1);
  assert.equal(f.sources.length, 2); assert.equal(f.sources[0].closed, true);
  assert.equal(f.nodes['nd-feed'].children.length, 0);
  f.sources[1].emit({title:'New private event'});
  assert.equal(f.nodes['nd-feed'].children.length, 1);
});

for (const status of [401, 403]) test(`confirmed PIN verification recovers an earlier ${status} admission denial without a manual Retry click`, async () => {
  const f = fixture({intercepted:true}); f.api.init();
  f.handler(async () => reply({detail:'Session required'}, status));
  f.sources[0].onerror(); f.retry(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 1);
  f.handler(async () => reply({events:[]})); verifiedUnlock(f); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.sources.length, 2); assert.equal(readyEvents(f).length, 1);
});

test('confirmed unlock waits for an old pending probe then checks the new session instead of trusting its reply', async () => {
  for (const status of [200, 401, 403]) {
    const f = fixture({intercepted:true}), denied = []; let finish;
    f.api.on('access_required', message => denied.push(message)); f.api.init();
    f.handler(() => new Promise(resolve => { finish = resolve; }));
    f.sources[0].onerror(); f.retry(); f.event('tli-session-locked'); verifiedUnlock(f); verifiedUnlock(f);
    assert.equal(f.calls.length, 1); assert.equal(readyEvents(f).length, 0);
    f.handler(async () => reply({events:[]})); finish(reply(status === 200 ? {events:[]} : {detail:'Old session denied'}, status));
    await tick(); await tick();
    assert.equal(f.calls.length, 2); assert.equal(f.sources.length, 2); assert.equal(readyEvents(f).length, 1);
    assert.equal(denied.length, 0, 'An obsolete denial must not pause or replace the new session');
    assert.equal(f.sources[1].closed, false); assert.equal(f.timers.size, 0);
  }
});

test('confirmed unlock survives an older 401 whose error body is still pending', async () => {
  const f = fixture({intercepted:true}), denied = []; let finishBody;
  f.api.on('access_required', message => denied.push(message)); f.api.init();
  f.handler(async () => ({...reply({},401), json:() => new Promise(resolve => { finishBody = resolve; })}));
  f.sources[0].onerror(); f.retry(); await tick();
  verifiedUnlock(f); f.handler(async () => reply({events:[]})); finishBody({detail:'Old rejected cookie'});
  await tick(); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.sources.length, 2); assert.equal(readyEvents(f).length, 1);
  assert.equal(denied.length, 0);
});

test('verified recovery is deferred while hidden and runs once when both page and tab are visible', async () => {
  const f = fixture(); f.api.init(); f.sources[0].emit({type:'auth_required'});
  f.document.hidden = true; f.event('visibilitychange'); f.event('pagehide');
  verifiedUnlock(f); verifiedUnlock(f); f.event('pageshow'); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.sources.length, 1);
  f.document.hidden = false; f.event('visibilitychange'); f.event('pageshow'); verifiedUnlock(f); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 2); assert.equal(readyEvents(f).length, 1);
});

test('repeated verified unlock events coalesce during and after recovery without extra streams', async () => {
  const f = fixture(); f.api.init(); f.event('tli-session-locked'); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  verifiedUnlock(f); verifiedUnlock(f); f.api.init(); f.event('pageshow');
  assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 1);
  finish(reply({events:[]})); await tick();
  verifiedUnlock(f); f.api.init(); f.event('visibilitychange'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 2); assert.equal(readyEvents(f).length, 1);
});

test('another lock cancels verified recovery queued behind a pending probe', async () => {
  const f = fixture(); f.api.init(); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  f.sources[0].onerror(); f.retry(); f.event('tli-session-locked'); verifiedUnlock(f);
  f.event('tli-session-locked'); finish(reply({events:[]})); await tick();
  f.event('tli-session-unlocked'); f.api.init(); f.event('visibilitychange'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 1); assert.equal(readyEvents(f).length, 0);
});

test('another lock cancels hidden verified recovery until a later explicit PIN verification', async () => {
  const f = fixture(); f.api.init(); f.event('tli-session-locked'); f.document.hidden = true;
  verifiedUnlock(f); f.event('tli-session-locked'); f.document.hidden = false; f.event('visibilitychange'); f.event('pageshow');
  await tick(); assert.equal(f.calls.length, 0); assert.equal(f.sources.length, 1);
  verifiedUnlock(f); await tick(); assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 2);
});

test('a denied post-verification probe does not loop through a subsequent PIN-off status unlock', async () => {
  for (const status of [401, 403]) {
    const f = fixture({intercepted:true,pinOff:true}); f.api.init(); f.event('tli-session-locked');
    f.handler(async () => reply({detail:'Use a clean local browser.'}, status)); verifiedUnlock(f);
    await tick(); await tick(); await tick();
    f.event('tli-session-unlocked'); f.event('visibilitychange'); f.event('pageshow'); f.api.init(); await tick();
    assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 1); assert.equal(f.timers.size, 0);
    assert.equal(readyEvents(f).length, 0);
  }
});

test('failed or malformed post-verification probe stays unavailable without replaying verification or effects', async () => {
  for (const failure of ['network', 'malformed']) {
    const f = fixture(), denied = []; f.api.on('access_required', message => denied.push(message)); f.api.init();
    f.event('tli-session-locked');
    f.handler(async () => { if (failure === 'network') throw new Error('Host unavailable'); return reply({}); });
    verifiedUnlock(f); await tick(); f.event('visibilitychange'); f.event('pageshow'); verifiedUnlock(f); await tick();
    assert.equal(f.calls.length, 1); assert.equal(f.sources.length, 1); assert.equal(readyEvents(f).length, 0);
    assert.equal(denied.length, 1); assert.ok(f.calls.every(call => call.url === '/api/events/recent?n=0' && !call.options.method));
  }
});
