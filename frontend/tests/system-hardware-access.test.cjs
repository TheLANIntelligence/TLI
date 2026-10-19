const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/tli-system.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const reply = (data,status=200) => ({ok:status>=200&&status<300,status,json:async()=>data});
const summary = (name='Private CPU') => ({timestamp:'2026-10-16T12:00:00Z',cpu:{model:name,cores:8,threads:16},gpu:{model:'Private GPU'},memory:{total_gb:32},storage:{drives:[]}});
function events(target={}) {
  const handlers={}; target.addEventListener=(name,fn)=>(handlers[name]||=[]).push(fn);
  target.dispatchEvent=event=>{for(const fn of handlers[event.type]||[])fn(event);};
  target.emit=(type,detail)=>target.dispatchEvent({type,detail}); return target;
}
function fixture() {
  const nodes={},calls=[],copies=[],toasts=[],legacy=[],logs=[]; let retries=0;
  const element=()=>({innerHTML:'',textContent:'',disabled:false,handlers:{},
    addEventListener(name,fn){(this.handlers[name]||=[]).push(fn);},
    async fire(name){for(const fn of this.handlers[name]||[])await fn();},
    click(){return this.disabled?Promise.resolve():this.fire('click');}, select(){}});
  for(const id of ['system-snapshot-time','btn-copy-system-text','btn-copy-system-json'])nodes[id]=element();
  for(const id of ['card-cpu','card-gpu','card-memory','card-display','card-storage','card-board']) {
    const body=element();nodes[id]={body,querySelector:()=>body};
  }
  let handler=async()=>reply(summary()),clipboard=async text=>copies.push(text);
  const window=events({EventInterpreter:{retry(){retries++;}}});
  const document=events({hidden:false,getElementById:id=>nodes[id]||null,createElement:element,
    body:{appendChild:node=>legacy.push(node.value),removeChild(){}},execCommand:()=>{legacy.push('copy');return true;}});
  const context=vm.createContext({window,document,Date,AbortController,AbortSignal,
    CustomEvent:class{constructor(type){this.type=type;}},
    navigator:{clipboard:{writeText:text=>clipboard(text)}},showToast:(...args)=>toasts.push(args),debugLog:(...args)=>logs.push(args),
    fetch:async(url,options)=>{calls.push({url,options});return handler(url,options);}});
  vm.runInContext(source,context);window.TLISystem.setup();
  return {window,document,nodes,calls,copies,toasts,legacy,logs,api:window.TLISystem,
    respond:fn=>{handler=fn;},clipboard:fn=>{clipboard=fn;},get retries(){return retries;},
    lock:()=>window.emit('tli-session-locked'),unlock:()=>window.emit('tli-session-unlocked'),ready:()=>window.emit('tli-private-observation-ready'),
    async recover(){this.unlock();this.ready();await tick();}};
}

test('System module accepts current hardware schema, copies deliberately and bounds its observation',async()=>{
  const f=fixture();await f.api.onOpen();
  assert.match(f.nodes['card-cpu'].body.innerHTML,/Private CPU/);assert.match(f.nodes['card-gpu'].body.innerHTML,/Private GPU/);
  await f.nodes['btn-copy-system-text'].click();await f.nodes['btn-copy-system-json'].click();
  assert.match(f.copies[0],/CPU: Private CPU/);assert.match(f.copies[0],/2026-10-16T12:00:00Z/);assert.equal(JSON.parse(f.copies[1]).cpu.model,'Private CPU');
  assert.equal(f.calls[0].options.cache,'no-store');assert.equal(f.calls[0].options.credentials,'same-origin');assert.ok(f.calls[0].options.signal instanceof AbortSignal);
});

test('System pending reads coalesce, cache visits reuse the result, explicit refresh reads again',async()=>{
  const f=fixture(),pending=deferred();f.respond(()=>pending.promise);
  const first=f.api.onOpen(),second=f.api.onOpen();assert.equal(f.calls.length,1);
  pending.resolve(reply(summary()));await Promise.all([first,second]);await f.api.onOpen();assert.equal(f.calls.length,1);
  await f.api.refresh();assert.equal(f.calls.length,2);
});

for(const status of [401,403])test(`System ${status} clears retained cache/copy and cannot fall back or retry on bare unlock`,async()=>{
  const f=fixture();await f.api.onOpen();f.respond(async()=>reply({detail:'PRIVATE DENIAL'},status));await f.api.refresh();
  assert.equal(f.api.getCache(),null);assert.equal(f.nodes['btn-copy-system-json'].disabled,true);
  assert.doesNotMatch(f.nodes['card-cpu'].body.innerHTML,/Private CPU/);assert.match(f.nodes['system-snapshot-time'].textContent,/Unlock/);
  await f.nodes['btn-copy-system-json'].fire('click');await f.nodes['btn-copy-system-text'].fire('click');assert.equal(f.copies.length,0);
  const count=f.calls.length;f.unlock();await f.api.onOpen();await f.api.refresh();assert.equal(f.calls.length,count);assert.equal(f.retries,1);
  f.respond(async()=>reply(summary('Recovered CPU')));f.ready();f.ready();await tick();
  assert.equal(f.calls.length,count+1);assert.equal(f.api.getCache().cpu.model,'Recovered CPU');assert.ok(f.calls.every(x=>x.url==='/system/summary'));
});

for(const kind of ['503','network','malformed','error-object'])test(`System ${kind} is unavailable rather than a second probe or cached successful export`,async()=>{
  const f=fixture();await f.api.onOpen();
  f.respond(async()=>{if(kind==='network')throw Error('PRIVATE source failure');return reply(kind==='malformed'?null:kind==='error-object'?{error:'PRIVATE unavailable'}:summary(),kind==='503'?503:200);});
  await f.api.refresh();assert.equal(f.api.getCache(),null);assert.equal(f.nodes['btn-copy-system-text'].disabled,true);
  assert.match(f.nodes['system-snapshot-time'].textContent,/unavailable/);assert.equal(f.calls.length,2);assert.ok(f.calls.every(x=>x.url==='/system/summary'));
  assert.doesNotMatch(JSON.stringify(f.logs),/PRIVATE/);
});

for(const status of [404,405])test(`System keeps the legacy minimal probe only for missing summary ${status}`,async()=>{
  const f=fixture();f.respond(async url=>url==='/system/summary'?reply({},status):reply({cpu_cores:4,cpu_threads:8,ram_total_gb:16}));await f.api.onOpen();
  assert.deepEqual(f.calls.map(x=>x.url),['/system/summary','/system/probe']);assert.equal(f.api.getCache().memory.total_gb,16);
  assert.equal(f.api.getCache()._source,'fallback:/system/probe');
});

for(const status of [401,403])test(`System legacy probe ${status} stops and clears without a successful normalized snapshot`,async()=>{
  const f=fixture();f.respond(async url=>reply({},url==='/system/summary'?404:status));await f.api.onOpen();
  assert.equal(f.api.getCache(),null);assert.match(f.nodes['system-snapshot-time'].textContent,/Unlock/);assert.equal(f.calls.length,2);
});

for(const status of [200,401,403])test(`late System ${status} cannot repaint or relock a newer verified session`,async()=>{
  const f=fixture(),pending=deferred();f.respond(()=>pending.promise);const old=f.api.onOpen();f.lock();
  f.respond(async()=>reply(summary('New CPU')));await f.recover();pending.resolve(reply(summary('Old CPU'),status));await old;
  assert.equal(f.api.getCache().cpu.model,'New CPU');assert.match(f.nodes['card-cpu'].body.innerHTML,/New CPU/);assert.doesNotMatch(f.nodes['card-cpu'].body.innerHTML,/Old CPU/);
});

test('System JSON body after lock/recovery is discarded and cannot replace current cache',async()=>{
  const f=fixture(),body=deferred();f.respond(async()=>({ok:true,status:200,json:()=>body.promise}));const old=f.api.onOpen();await tick();f.lock();
  f.respond(async()=>reply(summary('New CPU')));await f.recover();body.resolve(summary('Old CPU'));await old;assert.equal(f.api.getCache().cpu.model,'New CPU');
});

test('old System request cleanup does not clear a newer pending recovery',async()=>{
  const f=fixture(),old=deferred(),fresh=deferred();f.respond(()=>old.promise);const first=f.api.onOpen();f.lock();f.respond(()=>fresh.promise);f.unlock();f.ready();
  old.resolve(reply(summary('Old CPU')));await first;const duplicate=f.api.onOpen();assert.equal(f.calls.length,2);
  fresh.resolve(reply(summary('New CPU')));await duplicate;assert.equal(f.api.getCache().cpu.model,'New CPU');
});

test('clipboard rejection after lock never starts fallback copying or reports success',async()=>{
  const f=fixture(),copy=deferred();await f.api.onOpen();f.clipboard(()=>copy.promise);const pending=f.nodes['btn-copy-system-text'].click();
  f.lock();copy.reject(Error('Clipboard refused'));await pending;assert.deepEqual(f.legacy,[]);assert.equal(f.toasts.length,0);assert.equal(f.api.getCache(),null);
});

test('System hardware strings render literally rather than executable markup',async()=>{
  const f=fixture();const markup='<img src=x onerror=evil()>';
  f.respond(async()=>reply({...summary(markup),gpu:{model:markup},display:{width:markup,height:1080,hz:markup},storage:{drives:[{model:markup,size_tb:markup,interface:markup}]},board:{model:markup,bios_version:markup,bios_date:markup}}));
  await f.api.onOpen();for(const id of ['card-cpu','card-gpu','card-display','card-storage','card-board']){
    assert.doesNotMatch(f.nodes[id].body.innerHTML,/<img/);assert.match(f.nodes[id].body.innerHTML,/&lt;img/);
  }
});

test('System navigation away aborts pending reads and does not repaint or auto-reopen',async()=>{
  const f=fixture(),pending=deferred();f.respond(()=>pending.promise);const read=f.api.onOpen();f.document.emit('tli-panel-switched',{panelId:'panel-main'});
  assert.equal(f.calls[0].options.signal.aborted,true);pending.resolve(reply(summary()));await read;assert.equal(f.api.getCache(),null);
  f.lock();await f.recover();assert.equal(f.calls.length,1);
});

test('System verified recovery while hidden waits for visibility and pagehide clears exports',async()=>{
  const f=fixture();f.lock();await f.api.onOpen();f.document.hidden=true;await f.recover();assert.equal(f.calls.length,0);
  f.document.hidden=false;f.document.emit('visibilitychange');await tick();assert.equal(f.calls.length,1);
  f.window.emit('pagehide');await f.nodes['btn-copy-system-json'].fire('click');assert.equal(f.api.getCache(),null);assert.equal(f.copies.length,0);
});
