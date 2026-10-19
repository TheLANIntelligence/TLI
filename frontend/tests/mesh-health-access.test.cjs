const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const meshSource = fs.readFileSync(path.join(__dirname, '../js/mesh-control.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; };
const reply = (data, status=200) => ({ok:status>=200&&status<300,status,json:async()=>data,clone:()=>reply(data,status)});
const health = name => ({nodes:[{is_self:true,node_name:name||'Private host',online:true,ai_healthy:null,has_ai:null,ai_status:'unavailable'},
  {peer_id:'saved-peer',node_name:'Private peer',online:null,connection:{state:'unknown',fresh:false,ready_grants:[]}}]});
const events = target => {
  const handlers=new Map();
  target.addEventListener=(type,fn)=>{if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn);};
  target.dispatchEvent=e=>{for(const fn of handlers.get(e.type)||[])fn(e);return true;};
  target.emit=(type,detail)=>target.dispatchEvent({type,detail}); return target;
};
class CustomEvent {constructor(type, options={}) {this.type=type;this.detail=options.detail;}}
function element(tag='div') {
  const classes=new Set(); let html='',text='';
  const el=events({tagName:tag.toUpperCase(),children:[],dataset:{},style:{},hidden:false,disabled:false,
    classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),contains:n=>classes.has(n)},
    append(...items){this.children.push(...items);},appendChild(item){this.append(item);return item;},
    replaceChildren(...items){this.children=[];html='';text='';this.append(...items);},
    querySelector(selector){return this.children.find(x=>x.className?.split(' ').includes(selector.slice(1)))||null;},
    click(){if(!this.disabled)this.emit('click');}});
  Object.defineProperty(el,'innerHTML',{get:()=>html,set:value=>{html=value;text='';el.children=[];}});
  Object.defineProperty(el,'textContent',{get:()=>text,set:value=>{text=value;html='';el.children=[];}});
  return el;
}
const contents = el => el.textContent+el.innerHTML+el.children.map(contents).join(' ');

function meshFixture({interceptor=false}={}) {
  const nodes=new Map(['panel-mesh','mcd-grid','mcd-refresh-btn','mcd-last-updated'].map(id=>[id,element()]));
  nodes.get('panel-mesh').hidden=true;
  const calls=[],effects=[],timers=new Map(),observers=[];let timerId=0;
  const window=events({}), document=events({hidden:false,readyState:'complete',getElementById:id=>nodes.get(id)||null,createElement:element});
  let respond=async()=>reply(health());
  window.EventInterpreter={retry:()=>effects.push('access-check')};
  window.TLIPinLock={checkAndLock:()=>window.emit('tli-session-unlocked')};
  window.TLIDeviceDetails={open:id=>effects.push(['details',id])};
  window.TLIConnectDevice={open:record=>effects.push(['connect',record.deviceId])};
  window.TLIChat={openPeer:id=>effects.push(['message',id])};
  window.MeshService={projectPeer:n=>n.is_self?n:{...n,connection:n.connection||{state:'unknown',fresh:false,ready_grants:[]}},getPeers:()=>({peers:[]}),
    subscribePeers(fn){effects.push('subscribe');observers.push(fn);return()=>effects.push('unsubscribe');},
    subscribeExpiry(fn){observers.push(fn);return()=>{};}};
  window.fetch=async(url,options)=>{calls.push({url,options});return respond(url,options);};
  const ctx=vm.createContext({window,document,CustomEvent,Date,AbortController,AbortSignal,
    setInterval(fn){const id=++timerId;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),
    fetch:(...args)=>window.fetch(...args)});
  if(interceptor)vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/fetch-interceptor.js'),'utf8'),ctx);
  vm.runInContext(meshSource.replace('  function boot() {',
    '  window.testMesh={refresh,start,stop,buildNodeCard,state:()=>({ready:_ready,locked:_locked,pending:!!_request,last:_lastSuccess,nodes:_lastNodes})};\n  function boot() {'),ctx);
  return {window,document,nodes,calls,effects,timers,observers,api:window.testMesh,respond:fn=>{respond=fn;},
    open(){nodes.get('panel-mesh').hidden=false;document.emit('tli-panel-switched',{panelId:'panel-mesh'});},
    close(){nodes.get('panel-mesh').hidden=true;document.emit('tli-panel-switched',{panelId:'panel-chat'});},
    lock:()=>window.emit('tli-session-locked'),unlock:()=>window.emit('tli-session-unlocked'),ready:()=>window.emit('tli-private-observation-ready'),
    async recover(){this.unlock();this.ready();await tick();},
    async hide(hidden){document.hidden=hidden;document.emit('visibilitychange');await tick();}};
}

test('Mesh health keeps unknown AI facts, bounded same-origin reads and one active poll',async()=>{
  const f=meshFixture();f.open();f.open();await tick();
  assert.equal(f.calls.length,1);assert.equal(f.timers.size,1);assert.deepEqual(f.effects,['subscribe']);
  assert.equal(f.calls[0].url,'/api/mesh/health');assert.equal(f.calls[0].options.cache,'no-store');assert.equal(f.calls[0].options.credentials,'same-origin');
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.match(contents(f.nodes.get('mcd-grid')),/AI availability unknown/);assert.doesNotMatch(contents(f.nodes.get('mcd-grid')),/No bundled model reported|AI Running/);
});

for(const status of [401,403])test(`Mesh ${status} clears private cards and blocks polls, subscriptions and bare-unlock retries`,async()=>{
  const f=meshFixture();f.open();await tick();f.respond(async()=>reply({detail:'PRIVATE denial'},status));await f.api.refresh();
  assert.equal(f.api.state().nodes.length,0);assert.equal(f.api.state().last,null);assert.equal(f.timers.size,0);
  assert.doesNotMatch(contents(f.nodes.get('mcd-grid')),/Private host|Private peer|PRIVATE denial/);assert.equal(f.nodes.get('mcd-last-updated').textContent,'');
  const count=f.calls.length,subscriptions=f.effects.filter(x=>x==='subscribe').length;f.unlock();f.open();await f.api.refresh();f.window.emit('tli-peer-trust-changed');await f.hide(true);await f.hide(false);
  assert.equal(f.calls.length,count);assert.equal(f.effects.filter(x=>x==='subscribe').length,subscriptions);
  f.nodes.get('mcd-refresh-btn').click();assert.equal(f.effects.at(-1),'access-check');assert.equal(f.calls.length,count);
  f.respond(async()=>reply(health('Recovered host')));f.ready();f.ready();await tick();
  assert.equal(f.calls.length,count+1);assert.match(contents(f.nodes.get('mcd-grid')),/Recovered host/);assert.equal(f.timers.size,1);
  assert.ok(f.calls.every(c=>!c.options.method||c.options.method==='GET'));
});

test('initial denied Mesh read does not subscribe to other private peer views',async()=>{
  const f=meshFixture();f.respond(async()=>reply({},403));f.open();await tick();assert.equal(f.calls.length,1);assert.deepEqual(f.effects,[]);assert.equal(f.timers.size,0);
});

test('real 401 interceptor PIN-off unlock leaves Mesh paused until a verified read succeeds',async()=>{
  const f=meshFixture({interceptor:true});f.respond(async()=>reply({},401));f.open();await tick();
  assert.equal(f.api.state().locked,false);assert.equal(f.api.state().ready,false);assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
  f.open();await f.api.refresh();await f.hide(true);await f.hide(false);assert.equal(f.calls.length,1);
  f.respond(async()=>reply(health('Recovered host')));f.ready();await tick();assert.equal(f.calls.length,2);assert.match(contents(f.nodes.get('mcd-grid')),/Recovered host/);
});

for(const code of [200,401,403,503])test(`old Mesh ${code} cannot paint or deny a recovered session`,async()=>{
  const f=meshFixture(),pending=deferred();f.respond(()=>pending.promise);f.open();f.lock();
  f.respond(async()=>reply(health('New session host')));await f.recover();pending.resolve(reply(health('Old secret'),code));await tick();
  assert.equal(f.calls.length,2);assert.equal(f.api.state().locked,false);assert.match(contents(f.nodes.get('mcd-grid')),/New session host/);assert.doesNotMatch(contents(f.nodes.get('mcd-grid')),/Old secret/);
});

test('old Mesh completion cannot clear a newer pending request or its spinner',async()=>{
  const f=meshFixture(),old=deferred(),fresh=deferred();f.respond(()=>old.promise);f.open();f.lock();f.respond(()=>fresh.promise);f.unlock();f.ready();
  old.resolve(reply(health()));await tick();await f.api.refresh();assert.equal(f.calls.length,2);assert.equal(f.api.state().pending,true);assert.equal(f.nodes.get('mcd-refresh-btn').classList.contains('spinning'),true);
  fresh.resolve(reply(health('Fresh host')));await tick();assert.equal(f.api.state().pending,false);assert.match(contents(f.nodes.get('mcd-grid')),/Fresh host/);
});

test('Mesh body parsing and detached card actions retain the initiating session',async()=>{
  const f=meshFixture();f.open();await tick();const card=f.nodes.get('mcd-grid').children[1];const buttons=card.children.filter(x=>x.tagName==='BUTTON');
  const body=deferred();f.respond(async()=>({ok:true,status:200,json:()=>body.promise}));const pending=f.api.refresh();await tick();f.lock();
  f.respond(async()=>reply(health('Fresh host')));await f.recover();const effects=f.effects.length;buttons.forEach(x=>x.click());body.resolve(health('Old secret'));await pending;
  assert.equal(f.effects.length,effects);assert.match(contents(f.nodes.get('mcd-grid')),/Fresh host/);assert.doesNotMatch(contents(f.nodes.get('mcd-grid')),/Old secret/);
});

test('current Mesh card navigation remains explicit and uses the exact registry identity',async()=>{
  const f=meshFixture();const card=f.api.buildNodeCard({peer_id:'exact-id',node_name:'Same name',online:true,connection:{state:'connected',fresh:true,ready_grants:['messages']}});
  card.children.filter(x=>x.tagName==='BUTTON').forEach(x=>x.click());
  assert.deepEqual(f.effects,[['details','node-exact-id'],['message','exact-id'],['connect','exact-id']]);assert.equal(f.calls.length,0);
});

test('Mesh verified recovery while hidden defers health and subscriptions until visible',async()=>{
  const f=meshFixture();f.open();await tick();f.lock();await f.hide(true);await f.recover();const count=f.calls.length;
  assert.equal(count,1);assert.equal(f.timers.size,0);await f.hide(false);assert.equal(f.calls.length,count+1);assert.equal(f.timers.size,1);
});

test('Mesh navigation and pagehide invalidate pending health without reopening or retaining private rows',async()=>{
  const f=meshFixture(),pending=deferred();f.respond(()=>pending.promise);f.open();f.close();assert.equal(f.calls[0].options.signal.aborted,true);
  pending.resolve(reply(health()));await tick();assert.equal(f.api.state().nodes.length,0);assert.equal(f.timers.size,0);assert.deepEqual(f.effects,[]);
  f.respond(async()=>reply(health()));f.open();await tick();f.window.emit('pagehide');assert.equal(contents(f.nodes.get('mcd-grid')),'');assert.equal(f.api.state().nodes.length,0);assert.equal(f.timers.size,0);
});

test('returning to Mesh recreates current-session navigation on explicitly historical cards',async()=>{
  const f=meshFixture();f.open();await tick();const old=f.nodes.get('mcd-grid').children[1].children.find(x=>x.textContent==='Device details');f.close();
  f.respond(async()=>reply({},503));f.open();await tick();const current=f.nodes.get('mcd-grid').children[1].children.find(x=>x.textContent==='Device details');
  const before=f.effects.length;old.click();assert.equal(f.effects.length,before);current.click();assert.deepEqual(f.effects.at(-1),['details','node-saved-peer']);
  assert.match(f.nodes.get('mcd-last-updated').textContent,/Previous results.*out of date/);
});

for(const kind of ['503','network','null','missing-nodes','null-row','array-row','reported-failure'])test(`Mesh ${kind} preserves only explicitly historical readings and permits a later deliberate refresh`,async()=>{
  const f=meshFixture();await f.api.refresh();const before=f.nodes.get('mcd-grid').children[0];
  f.respond(async()=>{if(kind==='network')throw Error('PRIVATE upstream');return reply(kind==='null'?null:kind==='missing-nodes'?{}:kind==='null-row'?{nodes:[null]}:kind==='array-row'?{nodes:[[]]}:kind==='reported-failure'?{ok:false,nodes:[]}:health(),kind==='503'?503:200);});
  await f.api.refresh();assert.equal(f.nodes.get('mcd-grid').children[0],before);assert.match(f.nodes.get('mcd-last-updated').textContent,/Previous results.*out of date/);assert.equal(f.api.state().locked,false);
  f.respond(async()=>reply({nodes:[]}));await f.api.refresh();assert.match(contents(f.nodes.get('mcd-grid')),/No TLI computers were returned/);assert.equal(f.nodes.get('mcd-grid').classList.contains('mcd-stale'),false);
});

for(const code of [401,403])test(`optional legacy directory ${code} cannot publish health or silently suppress access loss`,async()=>{
  const f=meshFixture();f.respond(async url=>url==='/api/mesh/health'?reply({nodes:['one','two'].map(peer_id=>({peer_id,ip:'192.0.2.1',pairing_available:true}))}):reply({},code));
  f.open();await tick();assert.deepEqual(f.calls.map(c=>c.url),['/api/mesh/health','/mesh/directory']);assert.equal(f.api.state().locked,true);assert.equal(f.api.state().nodes.length,0);assert.deepEqual(f.effects,[]);
});

test('legacy directory body from a prior session cannot overwrite a new health snapshot',async()=>{
  const f=meshFixture(),body=deferred();f.respond(async url=>url==='/api/mesh/health'?reply({nodes:['one','two'].map(peer_id=>({peer_id,ip:'192.0.2.1',pairing_available:true}))}):{ok:true,status:200,json:()=>body.promise});
  f.open();await tick();f.lock();f.respond(async()=>reply(health('New host')));await f.recover();body.resolve({devices:[]});await tick();assert.match(contents(f.nodes.get('mcd-grid')),/New host/);assert.equal(f.calls.length,3);
});

function dashFixture() {
  const nodes=new Map(['nd-mesh-strip','nd-mesh-nodes','nd-feed','nd-statement-text','nd-meta-line','nd-actions','nd-suggestions','nd-quickread'].map(id=>[id,element()]));
  const calls=[],effects=[];let respond=async()=>reply(health());
  const window=events({TLIUIHealth:require('../js/ui-health.js'),TLINarrator:{clear:()=>effects.push('clear')}});
  const document={hidden:false,getElementById:id=>nodes.get(id)||null,createElement:element};
  const ctx=vm.createContext({window,document,CustomEvent,AbortSignal,Date,_viewEpoch:0,_sessionLocked:false,_accessBlocked:false,_open:true,
    _meshObservedAt:null,_meshHealthRequest:null,_lastData:null,_serverNarrator:null,_seenFeedIds:new Set(),
    _el:id=>nodes.get(id)||null,_setVital(){},_dashEsc:v=>String(v||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    _pauseDashboard(){ctx._viewEpoch++;ctx._open=false;effects.push('pause');},_showAccessPrompt:()=>effects.push('prompt'),
    fetch:async(url,options)=>{calls.push({url,options});return respond(url,options);}});
  vm.runInContext(app.slice(app.indexOf('  function _validMeshHealth('),app.indexOf('  // ── Public API',app.indexOf('  function _renderMeshStrip('))),ctx);
  vm.runInContext(app.slice(app.indexOf('  function _clearPrivateDashboard()'),app.indexOf('  function _showAccessPrompt()')),ctx);
  window.addEventListener('tli-session-locked',()=>{ctx._sessionLocked=true;ctx._accessBlocked=true;ctx._viewEpoch++;ctx._open=false;ctx._clearPrivateDashboard();});
  return {ctx,window,document,nodes,calls,effects,respond:fn=>{respond=fn;},refresh:()=>ctx._refreshMeshStrip(),
    renew(){ctx._viewEpoch++;ctx._sessionLocked=false;ctx._accessBlocked=false;ctx._open=true;}};
}

test('Dashboard health uses one bounded same-origin read and distinguishes unknown AI',async()=>{
  const f=dashFixture(),pending=deferred();f.respond(()=>pending.promise);const first=f.refresh();await f.refresh();assert.equal(f.calls.length,1);
  pending.resolve(reply(health()));await first;const rendered=contents(f.nodes.get('nd-mesh-nodes'));assert.match(rendered,/AI status unknown/);assert.doesNotMatch(rendered,/AI ready|No bundled model/);
  assert.equal(f.calls[0].options.cache,'no-store');assert.equal(f.calls[0].options.credentials,'same-origin');assert.ok(f.calls[0].options.signal instanceof AbortSignal);
});

for(const status of [401,403])test(`Dashboard health ${status} clears private rows and freshness, then pauses all reads`,async()=>{
  const f=dashFixture();await f.refresh();f.respond(async()=>reply({detail:'PRIVATE denial'},status));await f.refresh();
  assert.equal(f.ctx._sessionLocked,true);assert.equal(f.ctx._accessBlocked,true);assert.equal(f.ctx._meshObservedAt,null);assert.equal(f.ctx._meshHealthRequest,null);
  assert.equal(contents(f.nodes.get('nd-mesh-nodes')),'');assert.equal(contents(f.nodes.get('nd-mesh-strip')),'');assert.equal(f.nodes.get('nd-mesh-strip').hidden,true);
  const count=f.calls.length;await f.refresh();assert.equal(f.calls.length,count);
});

for(const code of [200,401,403,503])test(`old Dashboard health ${code} cannot paint, clear or relock a newer view`,async()=>{
  const f=dashFixture(),pending=deferred();f.respond(()=>pending.promise);const old=f.refresh();f.window.emit('tli-session-locked');f.renew();
  f.respond(async()=>reply(health('Fresh host')));await f.refresh();pending.resolve(reply(health('Old private host'),code));await old;
  assert.match(contents(f.nodes.get('nd-mesh-nodes')),/Fresh host/);assert.doesNotMatch(contents(f.nodes.get('nd-mesh-nodes')),/Old private host/);assert.equal(f.ctx._sessionLocked,false);
});

test('old Dashboard completion cannot release the new pending health read',async()=>{
  const f=dashFixture(),old=deferred(),fresh=deferred();f.respond(()=>old.promise);const first=f.refresh();f.renew();f.respond(()=>fresh.promise);const second=f.refresh();
  old.resolve(reply(health()));await first;await f.refresh();assert.equal(f.calls.length,2);assert.notEqual(f.ctx._meshHealthRequest,null);fresh.resolve(reply(health()));await second;assert.equal(f.ctx._meshHealthRequest,null);
});

test('Dashboard JSON completion after lock cannot restore private computer readings or freshness',async()=>{
  const f=dashFixture(),body=deferred();f.respond(async()=>({ok:true,status:200,json:()=>body.promise}));const pending=f.refresh();await tick();f.window.emit('tli-session-locked');body.resolve(health());await pending;
  assert.equal(contents(f.nodes.get('nd-mesh-nodes')),'');assert.equal(f.ctx._meshObservedAt,null);
});

for(const kind of ['503','network','null','missing-nodes','null-row','array-row','reported-failure'])test(`Dashboard ${kind} health is unavailable and does not replace previous readings with empty success`,async()=>{
  const f=dashFixture();await f.refresh();const before=contents(f.nodes.get('nd-mesh-nodes')),stamp=f.ctx._meshObservedAt;
  f.respond(async()=>{if(kind==='network')throw Error('PRIVATE upstream');return reply(kind==='null'?null:kind==='missing-nodes'?{}:kind==='null-row'?{nodes:[null]}:kind==='array-row'?{nodes:[[]]}:kind==='reported-failure'?{ok:false,nodes:[]}:health(),kind==='503'?503:200);});
  await f.refresh();assert.equal(contents(f.nodes.get('nd-mesh-nodes')),before);assert.equal(f.ctx._meshObservedAt,stamp);assert.match(contents(f.nodes.get('nd-mesh-strip')),/refresh unavailable.*Previous results/);assert.equal(f.ctx._sessionLocked,false);
});

test('Dashboard valid empty health clears old private rows and hides the strip',async()=>{
  const f=dashFixture();await f.refresh();f.respond(async()=>reply({nodes:[]}));await f.refresh();assert.equal(contents(f.nodes.get('nd-mesh-nodes')),'');assert.equal(f.nodes.get('nd-mesh-strip').hidden,true);
});

test('Dashboard hidden or closed views start no health read and ignore an in-flight result',async()=>{
  const f=dashFixture(),pending=deferred();f.respond(()=>pending.promise);const first=f.refresh();f.document.hidden=true;pending.resolve(reply(health()));await first;await f.refresh();
  assert.equal(f.calls.length,1);assert.equal(contents(f.nodes.get('nd-mesh-nodes')),'');f.document.hidden=false;f.ctx._open=false;await f.refresh();assert.equal(f.calls.length,1);
});

const malformedRows = [
  ['empty',{}], ['empty identity',{node_name:' ',node_id:null}], ['self flag',{is_self:'true',node_name:'Host'}],
  ['name type',{peer_id:'peer',node_name:{private:'name'}}], ['identity type',{peer_id:123,node_name:'Host'}],
  ['metric type',{node_name:'Host',ram_total_gb:'64'}], ['nonfinite metric',{node_name:'Host',cpu_percent:Infinity}],
  ['health flag',{node_name:'Host',ai_healthy:'false'}],
];
for(const [label,row] of malformedRows)for(const client of ['Mesh','Dashboard'])test(`${client} rejects malformed ${label} rows without claiming a fresh or empty snapshot`,async()=>{
  const f=client==='Mesh'?meshFixture():dashFixture();f.respond(async()=>reply({nodes:[row]}));await (client==='Mesh'?f.api.refresh():f.refresh());
  if(client==='Mesh') {assert.equal(f.api.state().last,null);assert.equal(f.api.state().nodes.length,0);assert.match(contents(f.nodes.get('mcd-grid')),/unavailable/);}
  else {assert.equal(f.ctx._meshObservedAt,null);assert.equal(contents(f.nodes.get('nd-mesh-nodes')),'');assert.match(contents(f.nodes.get('nd-mesh-strip')),/unavailable/);}
});

for(const client of ['Mesh','Dashboard'])test(`${client} accepts legacy identity and null observations without fabricating offline or metrics`,async()=>{
  const f=client==='Mesh'?meshFixture():dashFixture();f.respond(async()=>reply({nodes:[{is_self:true,node_id:null,hostname:'Legacy host',online:true,has_ai:null,ai_healthy:null,cpu_percent:null},
    {peer_id:'legacy-peer',node_name:null,online:null,ram_percent:null}]}));await (client==='Mesh'?f.api.refresh():f.refresh());
  if(client==='Mesh')assert.notEqual(f.api.state().last,null);else assert.notEqual(f.ctx._meshObservedAt,null);
  const output=contents(f.nodes.get(client==='Mesh'?'mcd-grid':'nd-mesh-nodes'));assert.match(output,/Legacy host/);assert.doesNotMatch(output,/AI Running|AI ready|No bundled model reported|CPU 0%|RAM 0%/);
});

for(const client of ['Mesh','Dashboard'])test(`${client} invalid body resolved late cannot overwrite a newer verified health snapshot`,async()=>{
  const f=client==='Mesh'?meshFixture():dashFixture(),body=deferred();f.respond(async()=>({ok:true,status:200,json:()=>body.promise}));
  const pending=client==='Mesh'?f.api.refresh():f.refresh();await tick();
  if(client==='Mesh'){f.open();f.lock();f.respond(async()=>reply(health('New valid host')));await f.recover();}
  else {f.window.emit('tli-session-locked');f.renew();f.respond(async()=>reply(health('New valid host')));await f.refresh();}
  body.resolve({nodes:[{}]});await pending;assert.match(contents(f.nodes.get(client==='Mesh'?'mcd-grid':'nd-mesh-nodes')),/New valid host/);
});
