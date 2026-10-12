const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/mesh-service.js'),'utf8'),tick=()=>new Promise(setImmediate);
function fixture(){
 const events=()=>{const handlers=new Map();return {addEventListener:(type,fn)=>{const list=handlers.get(type)||[];list.push(fn);handlers.set(type,list);},emit:type=>{for(const fn of handlers.get(type)||[])fn();}};};
 const window=events(),document={...events(),hidden:false},streams=[],timers=new Map(),intervals=new Map(),calls=[];let serial=0,now=Date.now(),respond=async()=>({peers:[{id:'one',name:'Saved computer'}]});
 class Clock extends Date{static now(){return now;}}
 class EventSource{constructor(){Object.assign(this,events());streams.push(this);}close(){this.closed=true;}}
 const context=vm.createContext({window,document,EventSource,AbortController,console,Date:Clock,URL,currentNodeConfig:null,meshDirectoryCache:null,
  setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{intervals.set(++serial,{fn,ms});return serial;},clearInterval:id=>intervals.delete(id),
  fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:()=>respond()};}});
 vm.runInContext(source,context);
 return {api:window.MeshService,context,window,document,streams,timers,intervals,calls,now:()=>now,advance:ms=>{now+=ms;},respond:fn=>{respond=fn;},async interval(ms){for(const t of [...intervals.values()])if(t.ms===ms)await t.fn();await tick();},async timer(ms){for(const[id,t]of [...timers])if(t.ms===ms){timers.delete(id);await t.fn();}await tick();}};
}
test('connection views share one cached roster and one live stream; updates are read-only',async()=>{
 const f=fixture(),first=[],second=[];const off1=f.api.subscribePeers(value=>first.push(value));await tick();
 assert.equal(first[0].peers[0].id,'one');assert.equal(f.streams.filter(s=>!s.closed).length,1);
 const off2=f.api.subscribePeers(value=>second.push(value));assert.equal(second[0].peers[0].id,'one');await tick();
 f.respond(async()=>({peers:[{id:'two',name:'New arrival'}]}));f.streams[0].emit('message');f.streams[0].emit('message');await f.timer(180);
 assert.equal(second.at(-1).peers[0].id,'two');assert.equal(first.at(-1).peers[0].id,'two');
 assert.ok(f.calls.every(c=>c.url==='/api/lan/peers'&&!c.options.method));
 off1();assert.equal(f.streams[0].closed,undefined);off2();assert.equal(f.streams[0].closed,true);assert.equal(f.intervals.size,0);
});
test('account change rejects an obsolete roster response and removes saved identities',async()=>{
 const f=fixture(),seen=[];let complete;f.respond(()=>new Promise(resolve=>{complete=resolve;}));f.api.subscribePeers(value=>seen.push(value));await tick();
 f.window.emit('tli-account-changed');complete({peers:[{id:'previous-owner'}]});await tick();
 assert.equal(f.api.getPeers(),null);assert.equal(seen.at(-1),null);assert.equal(seen.some(value=>value?.peers?.some(peer=>peer.id==='previous-owner')),false);
 assert.ok(f.streams.every(s=>s.closed));assert.equal(f.intervals.size,0);
});
test('hidden connection views stop streaming and resume with a fresh snapshot',async()=>{
 const f=fixture();f.api.subscribePeers(()=>{});await tick();f.document.hidden=true;f.document.emit('visibilitychange');assert.equal(f.streams[0].closed,true);assert.equal(f.intervals.size,0);
 f.document.hidden=false;f.document.emit('visibilitychange');await tick();assert.equal(f.streams.filter(s=>!s.closed).length,1);assert.equal(f.calls.length,2);
});

function connected(f){return {state:'connected',fresh:true,online:true,checked_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+90000).toISOString(),ready_grants:['messages','inference'],capabilities:{messages:{state:'ready'},inference:{state:'no_model',models:0},observe:{state:'permission_required'}}};}
test('expired cached verification is projected on reads and failed fetches without changing saved grants or the receipt',async()=>{
 const f=fixture(),receipt=connected(f),saved={id:'one',name:'Saved computer',status:'allowed',trust_state:'verified',reviewed_grants:['messages','inference'],messaging:{available:true},connection:receipt};
 f.respond(async()=>({peers:[saved]}));await f.api.refreshPeers();assert.equal(f.api.getPeers().peers[0].online,true);
 f.context.meshDirectoryCache={devices:[{device_id:'one',ip:'192.168.1.7',last_seen:new Date(f.now()).toISOString(),status:'allowed',trust_state:'verified'}]};
 assert.equal(f.api.getRoster()[0].presence,'online');
 f.advance(90000);const read=f.api.getPeers().peers[0];assert.equal(read.connection.state,'unknown');assert.equal(read.online,null);assert.equal(read.messaging.available,false);assert.equal(read.connection.reason.code,'connection_expired');assert.equal(read.ready_grants.length,0);
 assert.equal(read.connection.capabilities.inference.state,'not_checked');assert.equal(read.connection.capabilities.inference.models,undefined);assert.equal(read.connection.capabilities.observe.state,'permission_required');
 assert.deepEqual(Array.from(read.reviewed_grants),['messages','inference']);assert.equal(receipt.fresh,true);assert.equal(receipt.online,true);
 assert.equal(f.api.getRoster()[0].presence,'unknown');assert.equal(f.api.getRoster()[0].ready_grants.length,0);
 f.respond(async()=>{throw Error('Host unreachable');});const failed=await f.api.refreshPeers();assert.equal(failed.peers[0].online,null);assert.equal(failed.peers[0].messaging.available,false);
});
test('visible expiry publishes without another request, stops hidden, and expires immediately on resume',async()=>{
 const f=fixture(),seen=[],receipt=connected(f);f.respond(async()=>({peers:[{id:'one',connection:receipt,reviewed_grants:['messages']}]}));const off=f.api.subscribePeers(value=>seen.push(value));await tick();const calls=f.calls.length;
 f.advance(90000);await f.interval(1000);assert.equal(seen.at(-1).peers[0].connection.fresh,false);assert.equal(f.calls.length,calls);
 assert.deepEqual(Array.from(seen.at(-1).peers[0].reviewed_grants),['messages']);
 let expiries=0;const offExpiry=f.api.subscribeExpiry(()=>expiries++);await f.interval(1000);assert.equal(expiries,1);
 f.document.hidden=true;f.document.emit('visibilitychange');assert.equal(f.intervals.size,0);
 f.respond(()=>new Promise(()=>{}));f.document.hidden=false;f.document.emit('visibilitychange');assert.equal(f.api.getPeers().peers[0].online,null);assert.ok(expiries>1);
 off();offExpiry();assert.equal(f.intervals.size,0);
});
test('missing or invalid expiry and discovery timestamps cannot confer connection readiness',()=>{
 const f=fixture();for(const expires_at of [undefined,'not-a-date','2026-10-13T10:30:00']){const value=f.api.projectConnection({...connected(f),expires_at});assert.equal(value.online,null);assert.equal(value.fresh,false);assert.equal(value.ready_grants.length,0);}
 const checking=f.api.projectConnection({...connected(f),state:'checking'});assert.equal(checking.online,null);assert.equal(checking.ready_grants.length,0);assert.equal(checking.capabilities.messages.state,'not_checked');
 f.context.meshDirectoryCache={devices:[{device_id:'one',ip:'192.168.1.7',last_seen:new Date(f.now()).toISOString(),status:'allowed',trust_state:'verified',online:true}]};assert.equal(f.api.getRoster()[0].presence,'unknown');assert.equal(f.api.getRoster()[0].online,null);
});
