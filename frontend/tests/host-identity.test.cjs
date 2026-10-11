const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../js/host-identity.js');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const appSource=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const uiSource=fs.readFileSync(path.join(__dirname,'../js/ui-foundation.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const response=data=>({ok:true,status:200,json:async()=>data});

function integration(){
 let now=100000,respond=async()=>response({});
 const events=new Map(),nodes=new Map(),requests=[];
 function element(){return{textContent:'',value:'',hidden:false,disabled:false,dataset:{},listeners:{},
  addEventListener(event,fn){this.listeners[event]=fn;},focus(){},select(){},replaceChildren(){},
  querySelector(){return element();},classList:{contains:()=>false,toggle(){}}};}
 for(const id of ['device-name-chip','footer-device','ndv-node-val','node-switcher-label','rename-device-btn',
  'tli-rename-form','tli-rename-input','tli-rename-error','tli-rename-cancel','tli-device-popover','panel-dashboard2','dashboard-access'])nodes.set(id,element());
 const window={addEventListener:(name,fn)=>{if(!events.has(name))events.set(name,[]);events.get(name).push(fn);},
  dispatchEvent:event=>{for(const fn of events.get(event.type)||[])fn(event);}};
 const identity=create(state=>window.dispatchEvent({type:'tli:host-identity',detail:state}),()=>now);
 window.TLIHostIdentity=identity;
 const document={readyState:'loading',getElementById:id=>nodes.get(id)||null,querySelectorAll:()=>[],addEventListener(){}};
 class Clock extends Date{static now(){return now;}}
 const context=vm.createContext({window,document,Date:Clock,console,AbortSignal,CustomEvent:function(type,options){this.type=type;this.detail=options?.detail;},
  $:id=>nodes.get(id)||null,fetch:async(url,options)=>{requests.push({url,options});return respond(url,options);},
  _viewEpoch:0,_sessionLocked:false,_open:true,_lastData:null,_lastRefreshFailed:false,_serverNarrator:null,_seenFeedIds:new Set(),
  _el:id=>nodes.get(id)||null,_seedFeed(){},_refreshMeshStrip(){},_renderObservationSummary(){},_renderActions(){},
  _renderQuickRead(){},_renderSuggestions(){},_feedLog(){},setEventMessage(){},onClose(){context._viewEpoch++;},
  _setVital(name,value){if(name==='node')nodes.get('ndv-node-val').textContent=value;}});
 vm.runInContext(uiSource,context); // definitions/listeners only: DOMContentLoaded never fires
 function load(start,end,name){const a=appSource.indexOf(start),b=appSource.indexOf(end,a);assert.ok(a>=0&&b>a);vm.runInContext(appSource.slice(a,b)+(name?'\nthis.subject='+name+';':''),context);}
 return{identity,nodes,requests,context,window,now:()=>now,setTime:t=>{now=t;},respond:fn=>{respond=fn;},
  lock(){window.dispatchEvent({type:'tli-session-locked'});},
  refresh(){load('  async function _refreshOnce()','\n  function _renderObservationSummary()','_refreshOnce');return context.subject();},
  setupRename(){load('function setupDeviceRename()','// ---------- hamburger ----------','setupDeviceRename');context.subject();},
  loadDashboardLock(){load("  window.addEventListener('tli-session-locked', () => {\n    _sessionLocked", "  window.addEventListener('tli-session-unlocked'",null);},
 };
}

test('a delayed Dashboard snapshot does not replace a newer authoritative host observation',async()=>{
 const f=integration(),pending=deferred();f.respond(()=>pending.promise);
 const refresh=f.refresh();
 f.identity.observe({id:'host-a',name:'New name',source:'dashboard/command-center',observedAt:95000});
 pending.resolve(response({ok:true,ts:90,node:{id:'host-a',name:'Old name'},nickname:'Old name'}));
 await refresh;
 assert.equal(f.identity.get().name,'New name');
 assert.equal(f.nodes.get('device-name-chip').textContent,'New name');
 assert.equal(f.nodes.get('ndv-node-val').textContent,'New name');
});

test('a rejected placeholder cannot reappear through the Dashboard raw-name fallback',async()=>{
 const f=integration();f.respond(()=>response({ok:true,ts:100,node:{id:'host-a',name:'TLI Node'},nickname:'TLI Node'}));
 await f.refresh();
 assert.equal(f.identity.get().status,'unknown');
 assert.equal(f.nodes.get('ndv-node-val').textContent,'Not confirmed');
});

test('the actual lock listener ordering leaves all host labels under the shared identity owner',()=>{
 const f=integration();f.loadDashboardLock();
 f.identity.observe({id:'host-a',name:'Studio',source:'dashboard/command-center'});
 f.lock();
 assert.equal(f.identity.get().status,'locked');
 for(const id of ['device-name-chip','footer-device','ndv-node-val','node-switcher-label'])assert.equal(f.nodes.get(id).textContent,'Not confirmed',id);
});

test('successful explicit rename updates shared identity and every host label together',async()=>{
 const f=integration();f.identity.observe({id:'host-a',name:'Before',source:'dashboard/command-center'});f.setupRename();
 f.nodes.get('tli-rename-input').value='Renamed';
 f.respond(()=>response({status:'ok',nickname:'Renamed',node_name:'Renamed',node_id:'host-a'}));
 await f.nodes.get('tli-rename-form').listeners.submit({preventDefault(){}});
 assert.equal(f.identity.get().name,'Renamed');
 for(const id of ['device-name-chip','footer-device','ndv-node-val','node-switcher-label'])assert.equal(f.nodes.get(id).textContent,'Renamed',id);
});

test('a rename response after lock cannot repaint identity or issue a second mutation',async()=>{
 const f=integration(),pending=deferred();f.identity.observe({id:'host-a',name:'Before',source:'dashboard/command-center'});f.setupRename();
 f.nodes.get('tli-rename-input').value='Private renamed host';
 f.respond((url)=>url==='/device/nickname'?pending.promise:response({ok:true}));
 const rename=f.nodes.get('tli-rename-form').listeners.submit({preventDefault(){}});
 f.lock();pending.resolve(response({status:'ok',nickname:'Private renamed host'}));await rename;
 assert.equal(f.identity.get().status,'locked');
 assert.equal(f.requests.length,1,'No second rename operation after session invalidation');
 for(const id of ['device-name-chip','footer-device','ndv-node-val','node-switcher-label'])assert.equal(f.nodes.get(id).textContent,'Not confirmed',id);
});
test('connected host identity can be established without the general status request',()=>{
 const emitted=[],store=create(s=>emitted.push(s),()=>100000);
 assert.equal(store.get().status,'unknown');
 assert.equal(store.observe({id:'host-a',name:'Studio',source:'dashboard/command-center'}),true);
 assert.equal(store.get().id,'host-a');assert.equal(emitted[0].name,'Studio');
 assert.equal(store.observe({name:'TLI Node',source:'status'}),false);
 assert.equal(store.observe({id:'host-b',name:'Study',source:'status'}),false);
 assert.equal(store.get().name,'Studio');
});
test('renamed hosts require current authoritative identity and stale responses cannot roll back the name',()=>{
 const store=create(()=>{},()=>100000);
 store.observe({id:'host-a',name:'Before',source:'status',observedAt:90000});
 store.observe({id:'host-a',name:'Studio',source:'dashboard/command-center',observedAt:95000});
 assert.equal(store.observe({id:'host-a',name:'Before',source:'dashboard/command-center',observedAt:94000}),false);
 assert.equal(store.get().name,'Studio');
 assert.equal(store.observe({id:'host-a',name:'After',source:'dashboard/command-center',observedAt:99000}),true);
});
test('lock and unlock invalidate pending identity lookups instead of repainting old host data',()=>{
 const store=create(()=>{},()=>100000),generation=store.get().generation;
 store.observe({id:'a',name:'Studio',source:'status',generation});
 store.setLocked(true);
 assert.equal(store.get().status,'locked');assert.equal(store.get().name,null);
 assert.equal(store.observe({name:'Studio',source:'status'}),false);
 store.setLocked(false);
 assert.equal(store.observe({name:'Studio',source:'status',generation}),false);
 assert.equal(store.get().status,'unknown');
 assert.equal(store.observe({name:'Study',source:'status',generation:store.get().generation}),true);
});
test('invalid identities never establish host availability or turn placeholders into targets',()=>{
 const store=create(()=>{},()=>100000);
 for(const name of ['', '—', 'unknown', 'Checking…', 'x\nInjected', 'x'.repeat(161)])assert.equal(store.observe({name,source:'status'}),false);
 assert.equal(store.observe({name:'Studio',source:'device-selection'}),false);
 assert.equal(store.observe({name:'Studio',source:'status',observedAt:Infinity}),false);
 assert.equal(store.observe({name:'Studio',source:'status',observedAt:150000}),false);
 assert.equal(store.get().status,'unknown');
});
