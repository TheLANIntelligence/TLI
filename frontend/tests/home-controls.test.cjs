const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../js/home-auto.js'),'utf8');
const IP='192.0.2.10';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(handler=async()=>({devices:[]})) {
  const nodes={}, calls=[], toasts=[], health=[], stored=new Map(), timers=new Map(), events=new Map();
  let clock=100000, timer=0;
  function element() {
    const node={value:'', children:[], handlers:{}, dataset:{}, disabled:false, hidden:false,
      classList:{add(){},remove(){},contains(){return false;}}, style:{},
      addEventListener(name,fn){(this.handlers[name] ||= []).push(fn);},
      appendChild(node){this.children.push(node);},
      querySelector(){return null;},querySelectorAll(){return [];},
      click(){return Promise.all((this.handlers.click||[]).map(fn=>fn({stopPropagation(){},preventDefault(){}})));}};
    for (const property of ['textContent','innerHTML']) Object.defineProperty(node, property, {
      get(){return this['_'+property]||'';},set(value){this['_'+property]=value;this['_'+(property==='innerHTML'?'textContent':'innerHTML')]='';this.children=[];},
    });
    return node;
  }
  ['shellyCards','shelly-ip-input','shelly-relay-input','shelly-name-input','shelly-add-device-btn','shelly-refresh-all-btn',
   'shelly-discover-btn','shelly-status-btn','shelly-on-btn','shelly-off-btn','shelly-import-cache-btn','shelly-status-raw',
   'shelly-status-pill','shelly-status-summary'].forEach(id=>nodes[id]=element());
  nodes['shelly-relay-input'].value='0';
  const emit=(type,detail)=>{for(const fn of events.get(type)||[]) fn(new CustomEvent(type,{detail}));};
  const ctx=vm.createContext({console,AbortSignal,CustomEvent,crypto:require('node:crypto').webcrypto,Uint8Array,
    Date:class extends Date { static now(){return clock;} },
    shellyDevices:{}, shellyIpStorageKey:'old-ip', shellyNameStorageKey:'old-name',
    $:id=>nodes[id]||null, document:{querySelector:()=>null,createElement:element},
    localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    window:{setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
      addEventListener:(type,fn)=>events.set(type,[...(events.get(type)||[]),fn]),dispatchEvent:event=>emit(event.type,event.detail)},
    showToast:(...args)=>toasts.push(args),setHomeAutoHealth:(...args)=>health.push(args),
    fetch:async(url,options={})=>{
      const body=options.body?JSON.parse(options.body):null; calls.push({url,body});
      const data=await handler(url,body); return {ok:!data.httpError,status:data.httpError||200,json:async()=>data};
    }});
  vm.runInContext(source,ctx);
  // Most unit cases start from an already verified host inventory. setup() and
  // explicit registry reads exercise the real pending/unavailable admission.
  vm.runInContext('shellyRegistryReady = true;',ctx);
  return {ctx,nodes,calls,toasts,health,stored,timers,emit,handler:fn=>handler=fn,time:value=>clock=value,
    add:(relay,name='Lamp')=>{vm.runInContext('shellyRegistryReady = true; shellyControlAccess();',ctx);return ctx.upsertShellyDevice(IP,{relay,name});}};
}
const status=(on=true,relay=1)=>({ok:true,raw:{[`switch:${relay}`]:{output:on,apower:on?12:0}}});

test('legacy browser cache and explicit relay entries load without stale ON claims',()=>{
  const f=fixture();
  f.stored.set('tli_shelly_devices_v1',JSON.stringify({[IP]:{name:'Old',status:{isOn:true}},second:{ip:IP,relay:1,name:'Right',aliases:['desk']}}));
  f.ctx.loadShellyDevicesFromStorage();
  assert.equal(Object.keys(f.ctx.shellyDevices).length,2);
  assert.equal(f.ctx.shellyDevices[IP+'#0'].name,'Old');
  assert.equal(f.ctx.shellyDevices[IP+'#1'].aliases[0],'desk');
  assert.ok(Object.values(f.ctx.shellyDevices).every(d=>d.status===null));
  assert.equal(f.calls.length,0); assert.equal(f.health.length,0);
});

test('requested relay and missing state never fall back to relay zero or OFF',()=>{
  const f=fixture();
  const data={ok:true,raw:{'switch:0':{output:false,apower:0},'switch:1':{output:true,apower:25}}};
  assert.equal(f.ctx.buildShellySnapshotFromPayload(IP,data,1).power,25);
  for(const bad of [{raw:{}},{ok:false,raw:data.raw},{raw:{'switch:1':{output:'false'}}}])
    assert.equal(f.ctx.buildShellySnapshotFromPayload(IP,bad,1).isOn,null);
});

test('shared address without explicit relay executes nothing',async()=>{
  const f=fixture(); f.add(0);f.add(1);
  const result=await f.ctx.sendShellyAction('on',IP);
  assert.equal(result.ok,false);assert.equal(f.calls.length,0);assert.match(result.summary,/multiple relays/);
});

test('explicit target survives duplicate clicks and ack is followed by the same relay status',async()=>{
  let finish;
  const f=fixture(async(url)=>url==='/shelly/relay'?new Promise(resolve=>finish=()=>resolve({ok:true})):status(true));
  f.add(0,'Left');f.add(1,'Right');
  const first=f.ctx.sendShellyAction('on',IP,1);
  await f.ctx.sendShellyAction('off',IP,1);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.relay,1);
  assert.match(f.calls[0].body.request_id,/^[0-9a-f]{32}$/);
  finish(); const result=await first;
  assert.equal(result.state_verified,true);assert.equal(result.on,true);
  assert.match(f.calls[1].url,/relay=1$/);
  assert.equal(f.ctx.shellyDevices[IP+'#0'].status,null);
  assert.match(f.ctx.shellyDevices[IP+'#1'].commandResult,/reports ON/);
});

test('handler failure and lost response show failure without retry or optimistic state',async()=>{
  for(const fail of [async()=>({ok:false,summary:'Device refused'}),async()=>{throw new Error('response lost');}]) {
    const f=fixture(fail);f.add(1);
    const result=await f.ctx.sendShellyAction('toggle',IP,1);
    assert.equal(result.ok,false);assert.equal(f.calls.length,1);
    assert.ok(f.toasts.every(t=>t[1]!=='ok'));
    assert.equal(f.ctx.shellyDevices[IP+'#1'].status,null);
  }
});

test('acknowledged command and failed status remain separate in the receipt',async()=>{
  const f=fixture(async url=>url==='/shelly/relay'?{ok:true}:{ok:false,summary:'No reading'});f.add(1);
  const result=await f.ctx.sendShellyAction('on',IP,1);
  assert.equal(result.ok,true);assert.equal(result.state_verified,false);assert.equal(result.on,null);
  assert.match(result.summary,/acknowledged; current relay state could not be verified/);
  assert.equal(f.calls.filter(c=>c.url==='/shelly/relay').length,1);
});

test('old status response cannot overwrite a newer command observation',async()=>{
  let finishRead, reads=0;
  const f=fixture(async url=>{
    if(url==='/shelly/relay') return {ok:true};
    reads++;return reads===1?new Promise(resolve=>finishRead=()=>resolve(status(false))):status(true);
  });f.add(1);
  const old=f.ctx.fetchShellyStatusForIp(IP,true,1);
  const action=f.ctx.sendShellyAction('on',IP,1);
  await tick();finishRead();await old;await action;
  assert.equal(reads,2);assert.equal(f.ctx.shellyDevices[IP+'#1'].status.isOn,true);
});

test('poll cycles and per-target requests share pending reads',async()=>{
  let finish;
  const f=fixture(async()=>new Promise(resolve=>finish=()=>resolve(status())));f.add(1);
  const first=f.ctx.fetchAllShellyStatuses(true);const second=f.ctx.fetchAllShellyStatuses(true);
  const third=f.ctx.fetchShellyStatusForIp(IP,true,1);
  assert.equal(f.calls.length,1);finish();await Promise.all([first,second,third]);
  assert.equal(f.calls.length,1);
});

test('stale and failed readings do not produce a healthy card or current metrics',async()=>{
  let fail=false;
  const f=fixture(async()=>fail?{ok:false,summary:'No reply'}:status());f.add(1);
  await f.ctx.fetchShellyStatusForIp(IP,true,1);
  assert.equal(f.health.at(-1)[0],'ok');
  f.time(131001);f.nodes.shellyCards.children=[];f.ctx.renderAllShellyCards();
  assert.equal(f.health.at(-1)[0],'degraded');
  assert.match(f.nodes.shellyCards.children[0].children[1].children[0].innerHTML,/Stale reading/);
  assert.doesNotMatch(f.nodes.shellyCards.children[0].children[1].children[0].innerHTML,/12\.0 W/);
  fail=true;await f.ctx.fetchShellyStatusForIp(IP,true,1);
  assert.equal(f.health.at(-1)[0],'degraded');
  assert.match(f.nodes.shellyCards.children.at(-1).children[1].children[0].innerHTML,/Status unavailable/);
});

test('a healthy relay cannot hide another unknown relay',async()=>{
  const f=fixture(async()=>status());f.add(0);f.add(1);
  await f.ctx.fetchShellyStatusForIp(IP,true,1);
  assert.equal(f.health.at(-1)[0],'degraded');
});

test('setup binds once, loads host targets without writes and retains browser import data',async()=>{
  const f=fixture(async()=>({devices:[{ip:IP,relay:1,name:'Host',id:'stable',aliases:['desk']}]}));
  f.stored.set('tli_shelly_devices_v1',JSON.stringify({'192.0.2.20':{name:'Browser lamp'}}));
  f.ctx.setupHomeAutomationPanel();f.ctx.setupHomeAutomationPanel();await tick();
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.body===null));
  assert.deepEqual(f.calls.map(call=>call.url).sort(),['/api/intelligence/devices','/homeauto/devices']);
  assert.equal(f.nodes['shelly-add-device-btn'].handlers.click.length,1);
  assert.match(f.stored.get('tli_shelly_browser_import_v1'),/Browser lamp/);
  assert.equal(f.nodes['shelly-import-cache-btn'].hidden,false);
  assert.equal(f.ctx.shellyDevices[IP+'#1'].id,'stable');
});

test('registry writes contain explicit relay and merge flag, and failed writes do not claim saved',async()=>{
  const f=fixture(async()=>({ok:false}));f.add(1);
  await assert.rejects(f.ctx.syncShellyRegistry(),/save unconfirmed/);
  assert.equal(f.calls[0].body.merge,true);assert.equal(f.calls[0].body.devices[0].relay,1);
  assert.equal(f.toasts.length,0);
});

test('polling stop prevents an unfinished cycle from scheduling another',async()=>{
  let finish;
  const f=fixture(async()=>new Promise(resolve=>finish=()=>resolve(status())));f.add(1);
  f.ctx.startShellyAutoRefresh();const run=[...f.timers.values()].at(-1);f.timers.clear();
  const pending=run();f.ctx.stopShellyAutoRefresh();finish();await pending;
  assert.equal(f.timers.size,0);
});


function companionFixture(handler) {
  const all=[],calls=[],toasts=[];
  function element(){ const node={children:[],handlers:{},textContent:'',innerHTML:'',disabled:false,checked:false,
    appendChild(e){this.children.push(e);},setAttribute(){},addEventListener(n,fn){this.handlers[n]=fn;},
    querySelector(selector){this.parts ||= {};return this.parts[selector] ||= element();}};all.push(node);return node; }
  const devList=element();
  const ctx=vm.createContext({devList,document:{createElement:element},AbortSignal,Uint8Array,crypto:require('node:crypto').webcrypto,
    _vendorClass:()=>'',toast:msg=>toasts.push(msg),fetch:async(url,opts={})=>{
      calls.push({url,body:opts.body?JSON.parse(opts.body):null});
      const result=await handler(url,opts);return {ok:!result.httpError,json:async()=>result};}});
  const code=fs.readFileSync(path.join(__dirname,'../js/companion.js'),'utf8');
  const start=code.indexOf('  async function _loadDevices()');
  const end=code.indexOf('\n  document.getElementById("devices-refresh-btn")',start);
  vm.runInContext(code.slice(start,end),ctx);
  return {ctx,devList,calls,toasts};
}
const phoneDevice={device_id:'right',name:'Desk <lamp>',relay:1,vendor:'shelly',capabilities:['switch.on','switch.off']};
test('companion unavailable state is indeterminate and cannot issue a guessed toggle',async()=>{
  const f=companionFixture(async url=>url==='/homepower/devices'?{devices:[phoneDevice]}:{ok:false,on:false});
  await f.ctx._loadDevices();await tick();
  const row=f.devList.children[0], cb=row.querySelector('input');
  assert.equal(cb.disabled,true);assert.equal(cb.indeterminate,true);
  await cb.handlers.change();assert.equal(f.calls.filter(c=>c.body).length,0);
  assert.match(row.innerHTML,/Desk &lt;lamp&gt;/);
});
test('companion sends one exact device command and verifies reported state afterward',async()=>{
  let finish,reads=0;
  const f=companionFixture(async url=>url==='/homepower/devices'?{devices:[phoneDevice]}:
    url.endsWith('/execute')?new Promise(resolve=>finish=()=>resolve({ok:true})):{ok:true,on:++reads===1});
  await f.ctx._loadDevices();await tick();
  const cb=f.devList.children[0].querySelector('input');cb.checked=false;
  const request=cb.handlers.change();await cb.handlers.change();
  assert.equal(f.calls.filter(c=>c.body).length,1);assert.equal(f.calls.at(-1).body.capability,'switch.off');
  assert.match(f.calls.at(-1).url,/right\/execute$/);finish();await request;
  assert.equal(cb.checked,false);assert.equal(cb.disabled,false);assert.equal(reads,2);
});
test('companion does not roll an unconfirmed command back to a guessed ON/OFF state',async()=>{
  const f=companionFixture(async url=>url==='/homepower/devices'?{devices:[phoneDevice]}:
    url.endsWith('/execute')?{ok:false,summary:'Outcome unconfirmed'}:{ok:true,on:false});
  await f.ctx._loadDevices();await tick();
  const cb=f.devList.children[0].querySelector('input');cb.checked=true;await cb.handlers.change();
  assert.equal(cb.indeterminate,true);assert.equal(cb.disabled,true);
  assert.equal(f.calls.filter(c=>c.body).length,1);assert.doesNotMatch(f.toasts.join(' '),/acknowledged/);
});
test('companion device-list failure never claims there are no devices',async()=>{
  const f=companionFixture(async()=>({httpError:503}));await f.ctx._loadDevices();
  assert.match(f.devList.innerHTML,/Could not load devices/);assert.doesNotMatch(f.devList.innerHTML,/No devices yet/);
});
test('host registry refresh retains a failed reading and command result',async()=>{
  const f=fixture(async()=>({devices:[{ip:IP,relay:1,name:'Saved'}]}));
  f.ctx.upsertShellyDevice(IP,{relay:1,status:{isOn:true,checkedAt:100000},statusError:'No reply',commandResult:'Unconfirmed'});
  await f.ctx.loadShellyHostRegistry();
  assert.equal(f.ctx.shellyDevices[IP+'#1'].statusError,'No reply');
  assert.equal(f.ctx.shellyDevices[IP+'#1'].commandResult,'Unconfirmed');assert.equal(f.health.at(-1)[0],'degraded');
});

test('room grouping uses only explicit metadata, keeps unknown devices last, and never implies live state',async()=>{
  const f=fixture(async url=>url==='/homeauto/devices'?{devices:[
    {ip:IP,relay:0,name:'Desk lamp'}, {ip:IP,relay:1,name:'Hall light'}, {ip:'192.0.2.11',relay:0,name:'Fan'},
  ]}:{devices:[
    {kind:'smart_device',vendor:'shelly',address:IP,relay:0,room:'Study'},
    {kind:'smart_device',vendor:'shelly',address:IP,relay:1,room:'Hall'},
  ]});
  await f.ctx.loadShellyHostRegistry();
  assert.deepEqual(f.nodes.shellyCards.children.map(group=>group.children[0].textContent),['Hall','Study','Not assigned to a room']);
  assert.equal(f.health.at(-1)[0],'degraded');
  assert.ok(f.calls.every(call=>call.body===null));
  const card=f.nodes.shellyCards.children[0].children[1].children[0];
  assert.match(card.innerHTML,/Check state/);assert.doesNotMatch(card.innerHTML,/On · verified/);
});

test('session lock clears private cards, selections and live output, preserving saved browser bytes',async()=>{
  const f=fixture(async()=>status());f.add(1,'Private lamp');await f.ctx.fetchShellyStatusForIp(IP,true,1);
  f.ctx.setSelectedShellyIp(IP,1);f.ctx.startShellyAutoRefresh();const saved=[...f.stored];
  f.emit('tli-session-locked');
  assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.equal(f.nodes.shellyCards.children.length,0);
  for(const id of ['shelly-status-raw','shelly-status-summary']) assert.equal(f.nodes[id].textContent,'');
  for(const id of ['shelly-ip-input','shelly-name-input','shelly-relay-input']) assert.equal(f.nodes[id].value,'');
  assert.equal(f.timers.size,0);assert.deepEqual([...f.stored],saved);assert.equal(f.nodes['shelly-on-btn'].disabled,true);
  const count=f.calls.length;await f.ctx.sendShellyAction('on',IP,1);await f.ctx.fetchAllShellyStatuses();await f.ctx.discoverShellyDevices();
  assert.equal(f.calls.length,count);
});

for(const httpError of [401,403]) test('status '+httpError+' pauses access and bare unlock cannot loop; explicit retry only checks authority',async()=>{
  const f=fixture(async()=>({devices:[{ip:IP,relay:1,name:'Private lamp'}]}));
  f.ctx.setupHomeAutomationPanel();await tick();f.handler(async()=>({httpError,detail:'Unlock, then check the current relay state.'}));
  await f.ctx.fetchShellyStatusForIp(IP,true,1);assert.equal(Object.keys(f.ctx.shellyDevices).length,0);
  f.emit('tli-session-unlocked');const count=f.calls.length;let retries=0;f.ctx.window.EventInterpreter={retry:async()=>{retries++;}};
  f.ctx.startShellyAutoRefresh();await f.ctx.fetchAllShellyStatuses();await f.nodes['shelly-on-btn'].click();await f.nodes['shelly-refresh-all-btn'].click();
  assert.equal(retries,1);assert.equal(f.calls.length,count);assert.equal(f.timers.size,0);
});

test('verified-ready recovers host inventory once without discovery, saved writes or command replay',async()=>{
  const f=fixture(async()=>({devices:[{ip:IP,relay:1,name:'Host lamp'}]}));f.ctx.setupHomeAutomationPanel();await tick();
  f.emit('tli-session-locked');f.emit('tli-session-unlocked',{source:'pin-verification'});const count=f.calls.length;await tick();
  assert.equal(f.calls.length,count);
  f.emit('tli-private-observation-ready');f.emit('tli-private-observation-ready');await tick();
  assert.equal(f.calls.length,count+2);assert.equal(f.ctx.shellyDevices[IP+'#1'].name,'Host lamp');
  assert.ok(f.calls.every(call=>call.body===null));assert.equal(f.calls.some(call=>call.url==='/shelly/discover'),false);
  f.emit('tli-session-unlocked',{source:'pin-verification'});await tick();assert.equal(f.calls.length,count+2);
});

for(const httpError of [undefined,401,403]) test('old status '+(httpError||200)+' cannot overwrite or relock a newly verified session',async()=>{
  const old=deferred(),f=fixture(()=>old.promise);f.add(1);const read=f.ctx.fetchShellyStatusForIp(IP,true,1);
  f.emit('tli-session-locked');f.emit('tli-session-unlocked',{source:'pin-verification'});f.emit('tli-private-observation-ready');
  f.add(1,'Current lamp');f.handler(async()=>status(true));await f.ctx.fetchShellyStatusForIp(IP,true,1);
  old.resolve(httpError?{httpError,detail:'Old denied session'}:status(false));await read;
  assert.equal(f.ctx.shellyDevices[IP+'#1'].status.isOn,true);assert.equal(f.ctx.shellyDevices[IP+'#1'].name,'Current lamp');
  assert.equal(f.nodes['shelly-on-btn'].disabled,false);
});

for(const httpError of [undefined,401,403]) test('late command '+(httpError||200)+' never paints a private receipt or starts a followup after lock',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);f.add(1);const action=f.ctx.sendShellyAction('on',IP,1);
  f.emit('tli-session-locked');f.emit('tli-session-unlocked',{source:'pin-verification'});f.emit('tli-private-observation-ready');
  f.toasts.length=0;pending.resolve(httpError?{httpError,detail:'Old denied session'}:{ok:true,summary:'PRIVATE RECEIPT'});
  const result=await action;assert.equal(result.ok,false);assert.equal(result.outcome,'unknown');
  assert.equal(f.calls.length,1);assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.equal(f.toasts.length,0);
});

for(const httpError of [undefined,401,403]) test('late discovery '+(httpError||200)+' cannot persist or submit devices in a new session',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);const discovery=f.ctx.discoverShellyDevices();
  f.emit('tli-session-locked');f.emit('tli-session-unlocked',{source:'pin-verification'});f.emit('tli-private-observation-ready');
  const saved=[...f.stored];f.toasts.length=0;pending.resolve(httpError?{httpError,detail:'Old denied session'}:{found:[{ip:IP,name:'PRIVATE FOUND LAMP'}]});
  await discovery;assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/shelly/discover');
  assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.deepEqual([...f.stored],saved);assert.equal(f.toasts.length,0);assert.equal(f.timers.size,0);
});

test('lock after discovery registry submission suppresses later status reads and private results',async()=>{
  const pending=deferred(),f=fixture(async url=>url==='/shelly/discover'?{found:[{ip:IP,name:'Discovered lamp'}]}:pending.promise);
  const discovery=f.ctx.discoverShellyDevices();await tick();assert.equal(f.calls.filter(call=>call.body).length,1);
  f.emit('tli-session-locked');f.toasts.length=0;pending.resolve({ok:true});await discovery;
  assert.equal(f.calls.length,2);assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.equal(f.toasts.length,0);
});

test('a queued Add Device click cannot submit after its pending host read crosses a lock',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);f.ctx.setupHomeAutomationPanel();
  f.nodes['shelly-ip-input'].value=IP;f.nodes['shelly-relay-input'].value='1';
  const add=f.nodes['shelly-add-device-btn'].click();f.emit('tli-session-locked');f.emit('tli-session-unlocked',{source:'pin-verification'});
  pending.resolve({devices:[{ip:IP,relay:1,name:'OLD PRIVATE NAME'}]});await add;await tick();
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.body===null));assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.equal(f.toasts.length,0);
});

test('an old registry result cannot replace the current account inventory',async()=>{
  const old=deferred(),f=fixture(()=>old.promise);const load=f.ctx.loadShellyHostRegistry();
  f.emit('tli-session-locked');f.emit('tli-session-unlocked');f.emit('tli-private-observation-ready');
  f.handler(async()=>({devices:[{ip:IP,relay:1,name:'CURRENT PRIVATE NAME'}]}));await f.ctx.loadShellyHostRegistry();
  old.resolve({devices:[{ip:'192.0.2.20',relay:0,name:'OLD PRIVATE NAME'}]});await assert.rejects(load,/access changed/);
  assert.equal(Object.keys(f.ctx.shellyDevices).length,1);assert.equal(f.ctx.shellyDevices[IP+'#1'].name,'CURRENT PRIVATE NAME');
});

test('healthy explicit discovery retains GET, exact registry merge and read-only verification',async()=>{
  const f=fixture(async(url,body)=>url==='/shelly/discover'?{found:[{ip:IP,name:'Found lamp'}],subnet:'192.0.2.0/24'}:
    body?{ok:true,count:body.devices.length,devices:body.devices}:status(true,0));await f.ctx.discoverShellyDevices();
  assert.equal(f.calls[0].url,'/shelly/discover');assert.equal(f.calls[0].body,null);
  assert.equal(f.calls.filter(call=>call.body).length,1);assert.equal(f.calls[1].body.merge,true);
  assert.equal(f.ctx.shellyDevices[IP+'#0'].status.isOn,true);assert.match(f.toasts.at(-1)[0],/Found and saved 1 Shelly device/);
});

test('setup behind the lock preserves browser-only import records without displaying or writing them to the host',async()=>{
  const f=fixture(async()=>({devices:[]}));const browserBytes=JSON.stringify({[IP]:{name:'Browser-only private lamp'}});
  f.stored.set('tli_shelly_devices_v1',browserBytes);f.emit('tli-session-locked');f.ctx.setupHomeAutomationPanel();await tick();
  assert.equal(f.calls.length,0);assert.equal(Object.keys(f.ctx.shellyDevices).length,0);
  assert.equal(f.stored.get('tli_shelly_devices_v1'),browserBytes);assert.match(f.stored.get('tli_shelly_browser_import_v1'),/Browser-only private lamp/);
  assert.doesNotMatch(f.nodes.shellyCards.textContent,/Browser-only private lamp/);
  f.emit('tli-session-unlocked',{source:'pin-verification'});f.emit('tli-private-observation-ready');await tick();
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.body===null));assert.match(f.stored.get('tli_shelly_browser_import_v1'),/Browser-only private lamp/);
  assert.equal(f.nodes['shelly-import-cache-btn'].hidden,false);
});

for(const failure of [
  {httpError:503,detail:'Saved registry needs recovery.'}, {devices:null}, {devices:[{ip:IP,relay:'one'}]},
  {devices:[{ip:IP,relay:1},{ip:IP,relay:1}]},
]) test('unavailable or malformed host inventory preserves browser bytes and blocks registry writes',async()=>{
  const f=fixture(async()=>failure);const saved=JSON.stringify({[IP]:{name:'Original browser lamp'}});
  f.stored.set('tli_shelly_devices_v1',saved);f.stored.set('tli_shelly_browser_import_v1','[{"ip":"192.0.2.80","relay":0,"name":"Import me"}]');
  const before=[...f.stored];f.ctx.setupHomeAutomationPanel();await tick();
  assert.match(f.nodes.shellyCards.textContent,/registry unavailable/i);assert.doesNotMatch(f.nodes.shellyCards.innerHTML,/No devices yet/);
  assert.deepEqual([...f.stored],before);assert.equal(f.nodes['shelly-add-device-btn'].disabled,true);assert.equal(f.nodes['shelly-import-cache-btn'].disabled,true);
  const count=f.calls.length;await f.nodes['shelly-add-device-btn'].click();await f.nodes['shelly-import-cache-btn'].click();await f.ctx.discoverShellyDevices();
  await assert.rejects(f.ctx.syncShellyRegistry([{ip:IP,relay:0,name:'Overwrite'}]),/Host registry unavailable/);
  assert.equal(f.calls.length,count);assert.equal((await f.ctx.sendShellyAction('on',IP,0)).ok,false);
});

test('a healthy empty registry is distinct from failure and permits an explicit merge',async()=>{
  const f=fixture(async(url,body)=>body?{ok:true,count:body.devices.length,devices:body.devices}:{devices:[]});
  f.ctx.setupHomeAutomationPanel();await tick();assert.match(f.nodes.shellyCards.innerHTML,/No devices yet/);
  assert.equal(f.nodes['shelly-add-device-btn'].disabled,false);
  const result=await f.ctx.syncShellyRegistry([{ip:IP,relay:1,name:'New lamp'}]);
  assert.equal(result.ok,true);assert.equal(f.calls.filter(call=>call.body).length,1);
});

test('a slow successful inventory cannot reenable writes after a newer read fails',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);const old=f.ctx.loadShellyHostRegistry();
  f.handler(async()=>({httpError:503,detail:'Current registry damaged'}));await assert.rejects(f.ctx.loadShellyHostRegistry(),/damaged/);
  pending.resolve({devices:[{ip:IP,relay:1,name:'Old saved row'}]});await assert.rejects(old,/newer registry check/i);
  assert.match(f.nodes.shellyCards.textContent,/Current registry damaged/);assert.equal(f.nodes['shelly-add-device-btn'].disabled,true);
  assert.equal(f.stored.has('tli_shelly_devices_v1'),false);const count=f.calls.length;
  await assert.rejects(f.ctx.syncShellyRegistry([{ip:IP,relay:1,name:'Do not write'}]),/unavailable/);assert.equal(f.calls.length,count);
});

test('a slow failed inventory cannot disable a newer healthy registry',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);const old=f.ctx.loadShellyHostRegistry();
  f.handler(async()=>({devices:[{ip:IP,relay:1,name:'Current row'}]}));await f.ctx.loadShellyHostRegistry();
  pending.resolve({httpError:503,detail:'Obsolete failure'});await assert.rejects(old,/Obsolete failure/);
  assert.equal(f.nodes['shelly-add-device-btn'].disabled,false);assert.equal(f.ctx.shellyDevices[IP+'#1'].name,'Current row');
  assert.doesNotMatch(f.nodes.shellyCards.textContent,/unavailable/i);
});

for(const outcome of ['503','lost-response','incomplete-success','wrong-target']) test('discovery '+outcome+' keeps original cache and requires a fresh inventory read before another save',async()=>{
  const f=fixture(async(url,body)=>{
    if(url==='/shelly/discover') return {found:[{ip:'192.0.2.80',name:'Unconfirmed discovery'}]};
    if(outcome==='lost-response') throw new Error('Response lost');
    if(outcome==='incomplete-success') return {ok:true};
    if(outcome==='wrong-target') return {ok:true,count:0,devices:[]};
    return {httpError:503,detail:'Save completion unconfirmed.'};
  });f.add(1,'Original');f.stored.set('tli_shelly_browser_import_v1','PRESERVED ORIGINAL IMPORT BYTES');const before=[...f.stored];
  const originalConsole=f.ctx.console;f.ctx.console={...console,error(){}};await f.ctx.discoverShellyDevices();f.ctx.console=originalConsole;
  assert.deepEqual([...f.stored],before);assert.equal(f.ctx.shellyDevices['192.0.2.80#0'],undefined);
  assert.match(f.nodes.shellyCards.textContent,/save unconfirmed/i);assert.equal(f.nodes['shelly-discover-btn'].disabled,true);
  assert.equal(f.calls.filter(call=>call.body).length,1);assert.equal(f.calls.some(call=>call.url.startsWith('/shelly/status')),false);
  assert.ok(f.toasts.every(toast=>toast[1]!=='ok'));const count=f.calls.length;await f.ctx.discoverShellyDevices();assert.equal(f.calls.length,count);
  f.handler(async()=>({devices:[{ip:IP,relay:1,name:'Original'}]}));await f.ctx.loadShellyHostRegistry();assert.equal(f.nodes['shelly-discover-btn'].disabled,false);
  assert.equal(f.calls.filter(call=>call.body).length,1,'Read recovery must never replay the failed merge');
});

for(const action of ['add','import','rename']) test(action+' registry save failure is unconfirmed and preserves names/import/cache',async()=>{
  const f=fixture(async()=>({devices:[{ip:IP,relay:1,name:'Original'}]}));
  f.stored.set('tli_shelly_browser_import_v1',JSON.stringify([{ip:'192.0.2.80',relay:0,name:'Original import'}]));
  f.ctx.setupHomeAutomationPanel();await tick();const before=[...f.stored];f.handler(async()=>({httpError:503,detail:'Durable save was not confirmed.'}));
  if(action==='add') {f.nodes['shelly-ip-input'].value=IP;f.nodes['shelly-relay-input'].value='1';f.nodes['shelly-name-input'].value='Renamed';await f.nodes['shelly-add-device-btn'].click();}
  else if(action==='import') await f.nodes['shelly-import-cache-btn'].click();
  else {const card={dataset:{},querySelector:()=>({value:'Renamed'}),classList:{remove(){}}};await f.ctx.commitShellyInlineRename(card,IP,1);}
  assert.deepEqual([...f.stored],before);assert.equal(f.ctx.shellyDevices[IP+'#1'].name,'Original');
  assert.equal(f.calls.filter(call=>call.body).length,1);assert.ok(f.toasts.every(toast=>toast[1]!=='ok'));
  assert.match(f.toasts.at(-1)[0],/unconfirmed/i);assert.doesNotMatch(f.toasts.at(-1)[0],/was not saved/);
  assert.equal(f.nodes['shelly-add-device-btn'].disabled,true);
});

test('inventory refresh during discovery prevents a later scan result from queuing a merge',async()=>{
  const pending=deferred(),f=fixture(url=>url==='/shelly/discover'?pending.promise:Promise.resolve({devices:[]}));
  const scan=f.ctx.discoverShellyDevices();await f.ctx.loadShellyHostRegistry();
  f.ctx.console={...console,error(){}};pending.resolve({found:[{ip:IP,name:'Stale scan'}]});await scan;
  assert.equal(f.calls.filter(call=>call.body).length,0);assert.equal(Object.keys(f.ctx.shellyDevices).length,0);
});

test('a pending registry save blocks duplicate writes and inventory replacement until it settles',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);f.add(1);const save=f.ctx.syncShellyRegistry([{ip:IP,relay:1,name:'Saved'}]);
  await assert.rejects(f.ctx.syncShellyRegistry([{ip:IP,relay:1,name:'Second'}]),/pending/);
  await assert.rejects(f.ctx.loadShellyHostRegistry(),/pending/);assert.equal(f.calls.length,1);
  pending.resolve({ok:true,count:1,devices:[{ip:IP,relay:1,name:'Saved'}]});await save;
  assert.equal(f.nodes['shelly-add-device-btn'].disabled,false);
});

test('manual status remains readable during registry failure without replacing saved inventory bytes',async()=>{
  const f=fixture(async()=>({httpError:503,detail:'Damaged registry'}));f.add(1);const before=[...f.stored];
  await assert.rejects(f.ctx.loadShellyHostRegistry(),/Damaged registry/);f.handler(async()=>status(true));
  assert.equal(await f.ctx.fetchShellyStatusForIp(IP,true,1),true);assert.match(f.nodes['shelly-status-pill'].textContent,/ON/);
  assert.deepEqual([...f.stored],before);assert.match(f.nodes.shellyCards.textContent,/registry unavailable/i);
});

test('a status read started before registry refresh cannot refill a newly confirmed empty inventory',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);f.add(1);const read=f.ctx.fetchShellyStatusForIp(IP,true,1);
  f.handler(async()=>({devices:[]}));await f.ctx.loadShellyHostRegistry();const before=[...f.stored];
  pending.resolve(status(true));assert.equal(await read,false);assert.equal(Object.keys(f.ctx.shellyDevices).length,0);
  assert.deepEqual([...f.stored],before);assert.match(f.nodes.shellyCards.innerHTML,/No devices yet/);
});

test('a late command receipt cannot refill refreshed inventory or start a followup status read',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);f.add(1);const action=f.ctx.sendShellyAction('on',IP,1);
  f.handler(async()=>({devices:[]}));await f.ctx.loadShellyHostRegistry();const before=[...f.stored];f.toasts.length=0;
  pending.resolve({ok:true,summary:'Old command receipt'});const result=await action;
  assert.equal(result.outcome,'unknown');assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.deepEqual([...f.stored],before);
  assert.equal(f.calls.some(call=>call.url.startsWith('/shelly/status')),false);assert.equal(f.toasts.length,0);
  assert.equal(vm.runInContext('shellyCommands.size',f.ctx),0);
});

test('a polling cycle stops before its next target when the host registry is refreshed',async()=>{
  const pending=deferred(),f=fixture(()=>pending.promise);f.add(0);f.add(1);const cycle=f.ctx.fetchAllShellyStatuses();
  f.handler(async()=>({devices:[]}));await f.ctx.loadShellyHostRegistry();const before=[...f.stored];f.toasts.length=0;
  pending.resolve(status(true,0));await cycle;
  assert.equal(f.calls.filter(call=>call.url.startsWith('/shelly/status')).length,1);
  assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.deepEqual([...f.stored],before);assert.equal(f.toasts.length,0);
});

test('legacy host-only inventory uses a view alias and preserves nullable fields and unknown metadata without a host write',async()=>{
  const rows=[{host:IP,name:null,relay:null,id:'legacy-id',vendor_meta:{label:'Preserved'}},{host:'192.0.2.80',name:'Other legacy'}];
  const original=JSON.stringify(rows),f=fixture(async()=>({devices:rows}));await f.ctx.loadShellyHostRegistry();
  assert.equal(f.ctx.shellyDevices[IP+'#0'].ip,IP);assert.equal(f.ctx.shellyDevices[IP+'#0'].host,IP);
  assert.equal(f.ctx.shellyDevices[IP+'#0'].name,null);assert.equal(f.ctx.shellyDevices[IP+'#0'].id,'legacy-id');
  assert.equal(f.ctx.shellyDevices[IP+'#0'].vendor_meta.label,'Preserved');assert.ok(f.ctx.shellyDevices['192.0.2.80#0']);
  assert.equal(f.nodes['shelly-add-device-btn'].disabled,false);assert.equal(JSON.stringify(rows),original);
  assert.ok(f.calls.every(call=>call.body===null));assert.match(f.stored.get('tli_shelly_devices_v1'),/Preserved/);
});

test('registry acknowledgement accepts a legacy host address and preserves the exact submitted name',async()=>{
  const f=fixture(async(url,body)=>({ok:true,count:1,devices:[{host:body.devices[0].ip,name:body.devices[0].name}]}));
  const result=await f.ctx.syncShellyRegistry([{ip:IP,name:'  Original legacy name  '}]);
  assert.equal(result.ok,true);assert.equal(f.calls[0].body.devices[0].name,'  Original legacy name  ');
  assert.equal(f.nodes['shelly-add-device-btn'].disabled,false);assert.equal(f.calls.length,1);
});

for(const action of ['add','rename','discovery','import']) for(const unavailable of [false,true]) test(action+' save continuation cannot overwrite a newer '+(unavailable?'unavailable':'empty')+' inventory',async()=>{
  const f=fixture(async()=>({devices:[{ip:IP,relay:1,name:'Original'}]}));
  f.stored.set('tli_shelly_browser_import_v1',JSON.stringify([{ip:IP,relay:1,name:'Imported'}]));
  f.ctx.setupHomeAutomationPanel();await tick();
  f.handler(async(url,body)=>body?{ok:true,count:body.devices.length,devices:body.devices}:
    url==='/shelly/discover'?{found:[{ip:IP,name:'Discovered'}]}:{devices:[]});
  const sync=f.ctx.syncShellyRegistry;let afterRead,afterReadCalls;
  f.ctx.syncShellyRegistry=async(...args)=>{
    const result=await sync(...args);
    f.handler(async()=>unavailable?{httpError:503,detail:'New registry unavailable'}:{devices:[]});
    try {await f.ctx.loadShellyHostRegistry();} catch(error) {assert.equal(unavailable,true);}
    afterRead=[...f.stored];afterReadCalls=f.calls.length;return result;
  };
  f.toasts.length=0;f.ctx.console={...console,error(){}};
  if(action==='add') {f.nodes['shelly-ip-input'].value=IP;f.nodes['shelly-relay-input'].value='1';f.nodes['shelly-name-input'].value='Changed';await f.nodes['shelly-add-device-btn'].click();}
  else if(action==='rename') {const card={dataset:{},querySelector:()=>({value:'Changed'}),classList:{remove(){}}};await f.ctx.commitShellyInlineRename(card,IP,1);}
  else if(action==='discovery') await f.ctx.discoverShellyDevices();
  else await f.nodes['shelly-import-cache-btn'].click();
  assert.deepEqual([...f.stored],afterRead);assert.equal(f.calls.length,afterReadCalls);
  assert.ok(f.toasts.every(toast=>toast[1]!=='ok'));assert.equal(f.calls.filter(call=>call.body).length,1);
  if(unavailable) {assert.match(f.nodes.shellyCards.textContent,/New registry unavailable/);assert.equal(f.nodes['shelly-add-device-btn'].disabled,true);}
  else {assert.equal(Object.keys(f.ctx.shellyDevices).length,0);assert.match(f.nodes.shellyCards.innerHTML,/No devices yet/);}
});
