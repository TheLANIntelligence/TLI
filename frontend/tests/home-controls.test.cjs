const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../js/home-auto.js'),'utf8');
const IP='192.0.2.10';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handler=async()=>({devices:[]})) {
  const nodes={}, calls=[], toasts=[], health=[], stored=new Map(), timers=new Map();
  let clock=100000, timer=0;
  function element() {
    return {value:'', textContent:'', innerHTML:'', children:[], handlers:{}, dataset:{}, disabled:false, hidden:false,
      classList:{add(){},remove(){},contains(){return false;}}, style:{},
      addEventListener(name,fn){(this.handlers[name] ||= []).push(fn);},
      appendChild(node){this.children.push(node);},
      querySelector(){return null;},querySelectorAll(){return [];},
      click(){return Promise.all((this.handlers.click||[]).map(fn=>fn({stopPropagation(){},preventDefault(){}})));}};
  }
  ['shellyCards','shelly-ip-input','shelly-relay-input','shelly-name-input','shelly-add-device-btn','shelly-refresh-all-btn',
   'shelly-discover-btn','shelly-status-btn','shelly-on-btn','shelly-off-btn','shelly-import-cache-btn','shelly-status-raw',
   'shelly-status-pill','shelly-status-summary'].forEach(id=>nodes[id]=element());
  nodes['shelly-relay-input'].value='0';
  const ctx=vm.createContext({console,AbortSignal,crypto:require('node:crypto').webcrypto,Uint8Array,
    Date:class extends Date { static now(){return clock;} },
    shellyDevices:{}, shellyIpStorageKey:'old-ip', shellyNameStorageKey:'old-name',
    $:id=>nodes[id]||null, document:{querySelector:()=>null,createElement:element},
    localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    window:{setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)},
    showToast:(...args)=>toasts.push(args),setHomeAutoHealth:(...args)=>health.push(args),
    fetch:async(url,options={})=>{
      const body=options.body?JSON.parse(options.body):null; calls.push({url,body});
      const data=await handler(url,body); return {ok:!data.httpError,status:data.httpError||200,json:async()=>data};
    }});
  vm.runInContext(source,ctx);
  return {ctx,nodes,calls,toasts,health,stored,timers,time:value=>clock=value,
    add:(relay,name='Lamp')=>ctx.upsertShellyDevice(IP,{relay,name})};
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
  await assert.rejects(f.ctx.syncShellyRegistry(),/not saved/);
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
