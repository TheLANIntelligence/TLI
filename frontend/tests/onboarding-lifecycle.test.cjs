const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/onboarding.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,clone:()=>reply(data,status)});
const DRAFT='tli_onboard_progress_v3',SEEN='tli_onboard_seen_v1';

// All network, DOM, media and timer effects are synthetic; run the actual module.
function fixture({started=false,complete=false,statusBody,ping={node_name:'Saved host'},interceptor=false,locked=false}={}){
  const nodes=new Map(),calls=[],effects=[],emitted=[],local=new Map(),session=new Map(),timers=new Map();let timerId=0;
  const eventTarget=(target={})=>{const listeners=new Map();target.addEventListener=(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);};target.dispatchEvent=e=>{for(const fn of listeners.get(e.type)||[])fn(e);};target.fire=(type,detail)=>target.dispatchEvent({type,detail});target.fireAsync=(type,e={})=>Promise.all((listeners.get(type)||[]).map(fn=>fn({type,preventDefault(){},...e})));return target;};
  const element=(id='')=>{
    const classes=new Set();return eventTarget({id,value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,inert:false,attrs:{},style:{},dataset:{},children:[],tagName:'DIV',
      classList:{add:n=>classes.add(n),remove:n=>classes.delete(n),contains:n=>classes.has(n),toggle(n,force){const on=force??!classes.has(n);on?classes.add(n):classes.delete(n);}},
      setAttribute(n,v){this.attrs[n]=String(v);},getAttribute(n){return this.attrs[n]??null;},removeAttribute(n){delete this.attrs[n];},
      append(...items){this.children.push(...items);},appendChild(item){this.append(item);return item;},replaceChildren(...items){this.children=items;this.textContent='';this.innerHTML='';},
      querySelector:selector=>node(id+':'+selector),querySelectorAll:()=>[],contains:()=>true,focus(){},select(){},getClientRects:()=>[{}],
      click(){return this.disabled?Promise.resolve():this.fireAsync('click');}});
  };
  const node=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);};
  node('tli-lock-screen').setAttribute('aria-hidden',locked?'false':'true');
  const document=eventTarget({readyState:'complete',hidden:false,getElementById:id=>id==='onboard-music-audio'?null:node(id),createElement:()=>element(),body:element(),documentElement:element(),activeElement:element()});
  const window=eventTarget({});
  const originalDispatch=window.dispatchEvent;window.dispatchEvent=e=>{emitted.push(e);originalDispatch(e);};
  window.switchPanel=panel=>effects.push(panel);window.EventInterpreter={retry:()=>effects.push('access-check')};
  window.TLIPinLock={checkAndLock:()=>window.fire('tli-session-unlocked'),verifyForSetup:async()=>{window.fire('tli-session-unlocked',{source:'pin-verification'});return true;}};
  let saved={complete,started},respond=null;
  const normal=async(url,options={})=>{
    if(url==='/system/onboarding/status')return reply(statusBody===undefined?saved:statusBody);
    if(url==='/system/onboarding/start'){saved={complete:false,started:true};return reply({ok:true,...saved});}
    if(url==='/system/onboarding/complete'){saved={complete:true,started:false};return reply({ok:true});}
    if(url==='/system/pin/status')return reply({enabled:false});
    if(url==='/system/pin/set')return reply({ok:true,locked:true});
    if(url==='/agent/ping')return reply(ping);
    if(url==='/status')return reply({device_id:'host-a',device_nickname:'Checked host',node_role:'standalone'});
    if(url==='/system/node/name')return reply({ok:true,node_id:'host-a',node_name:JSON.parse(options.body).name});
    return reply({ok:true});
  };
  window.fetch=async(url,options={})=>{calls.push({url,options});return respond?respond(url,options,normal):normal(url,options);};
  const store=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
  const context=vm.createContext({window,document,localStorage:store(local),sessionStorage:store(session),AbortController,AbortSignal,Date,console,
    fetch:(...args)=>window.fetch(...args),CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  if(interceptor)vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/fetch-interceptor.js'),'utf8'),context);
  vm.runInContext(source.replace("  if (document.readyState === 'loading')", "  window.testSetup={next,initialize,setStep:(n,changes={})=>{step=n;if(changes.name!==undefined)name=changes.name;if(changes.security)security=changes.security;if(changes.destination)destination=changes.destination;render();},uncertainName:()=>{nameUnconfirmed=true;},state:()=>({step,started,completed,open,busy,initializing,locked,name,nameReady,setupUnconfirmed,setupCompletionReady,nameUnconfirmed}),};\n  if (document.readyState === 'loading')"),context);
  return{window,document,node,calls,effects,emitted,local,session,timers,api:window.testSetup,normal,
    respond(fn){respond=fn;},async settled(){await tick();await tick();},next:()=>window.testSetup.next(),
    lock:()=>window.fire('tli-session-locked'),unlock:()=>window.fire('tli-session-unlocked'),ready:()=>window.fire('tli-private-observation-ready'),
    async recover(){this.unlock();this.ready();await this.settled();},
    writes:()=>calls.filter(c=>c.options.method==='POST'),
    setupWrites:()=>calls.filter(c=>c.options.method==='POST'&&/^\/system\/onboarding\//.test(c.url)),
    statusReads:()=>calls.filter(c=>c.url==='/system/onboarding/status'),
  };
}
async function at(phase,options={}){const f=fixture({started:phase==='complete',...options});await f.settled();if(phase==='complete')f.api.setStep(4,{destination:'chat'});await f.settled();return f;}
const endpoint=phase=>'/system/onboarding/'+phase;
const ack=phase=>phase==='start'?{ok:true,complete:false,started:true}:{ok:true};

for(const phase of ['start','complete'])test(phase+' has one guarded explicit write and confirms its existing response',async()=>{
  const f=await at(phase);assert.equal(f.setupWrites().length,0);await f.next();
  assert.equal(f.setupWrites().length,1);assert.equal(f.setupWrites()[0].url,endpoint(phase));
  assert.equal(f.setupWrites()[0].options.credentials,'same-origin');assert.ok(f.setupWrites()[0].options.signal instanceof AbortSignal);
  assert.equal(f.api.state().setupUnconfirmed,null);
  if(phase==='start'){assert.equal(f.api.state().started,true);assert.equal(f.api.state().step,1);assert.equal(f.local.has(SEEN),false);}
  else{assert.equal(f.api.state().open,false);assert.equal(f.local.get(SEEN),'1');assert.equal(f.session.has(DRAFT),false);assert.deepEqual(f.effects,['panel-main']);}
});

for(const phase of ['start','complete'])for(const code of [401,403])test(phase+' current '+code+' clears private state and never repeats after unlock',async()=>{
  const f=await at(phase);let parsed=false;f.respond(async(url,options,normal)=>url===endpoint(phase)?{ok:false,status:code,json:async()=>{parsed=true;return{detail:'Private stale name'};}}:normal(url,options));
  await f.next();assert.equal(parsed,false);assert.equal(f.api.state().locked,true);assert.equal(f.api.state().name,'');
  assert.doesNotMatch(f.node('tli-onboard-status').textContent,/Private stale name/);assert.equal(f.local.has(SEEN),false);
  const writes=f.setupWrites().length;f.unlock();await f.next();assert.equal(f.setupWrites().length,writes);f.ready();await f.settled();assert.equal(f.setupWrites().length,writes);
  assert.equal(f.node('tli-onboard-next').textContent,'Check saved setup');
});

for(const phase of ['start','complete'])for(const code of [200,401,403,503])test(phase+' old '+code+' cannot affect a renewed session or release its pending check',async()=>{
  const f=await at(phase),old=deferred();f.respond((url,options,normal)=>url===endpoint(phase)?old.promise:normal(url,options));const saving=f.next();
  f.lock();await f.recover();const check=deferred();f.respond((url,options,normal)=>url==='/system/onboarding/status'?check.promise:normal(url,options));const checking=f.next();
  old.resolve(reply(ack(phase),code));await saving;assert.equal(f.api.state().locked,false);assert.equal(f.api.state().busy,true);assert.equal(f.node('tli-onboard-next').disabled,true);
  assert.equal(f.setupWrites().length,1);assert.equal(f.local.has(SEEN),false);assert.deepEqual(f.effects,[]);
  check.resolve(reply({complete:false,started:true}));await checking;assert.equal(f.api.state().setupUnconfirmed,null);assert.equal(f.api.state().busy,false);
});

for(const phase of ['start','complete'])test(phase+' response body resolving after lock cannot publish completion or advance',async()=>{
  const f=await at(phase),body=deferred();f.respond((url,options,normal)=>url===endpoint(phase)?Promise.resolve({ok:true,status:200,json:()=>body.promise}):normal(url,options));
  const saving=f.next();await tick();f.lock();body.resolve(ack(phase));await saving;
  assert.equal(f.api.state().locked,true);assert.equal(f.api.state().step,phase==='start'?0:4);assert.equal(f.local.has(SEEN),false);assert.deepEqual(f.effects,[]);
});

for(const phase of ['start','complete'])test(phase+' duplicate clicks cannot duplicate a pending write',async()=>{
  const f=await at(phase),pending=deferred();f.respond((url,options,normal)=>url===endpoint(phase)?pending.promise:normal(url,options));
  const saving=f.next();await f.next();assert.equal(f.setupWrites().length,1);pending.resolve(reply(ack(phase)));await saving;assert.equal(f.setupWrites().length,1);
});

for(const phase of ['start','complete'])for(const failure of ['network','timeout','503','invalid-json','unconfirmed'])test(phase+' '+failure+' preserves draft and requires an explicit read before any second write',async()=>{
  const f=await at(phase),draft=f.session.get(DRAFT),beforeStep=f.api.state().step;
  f.respond(async(url,options,normal)=>{if(url!==endpoint(phase))return normal(url,options);if(failure==='network')throw Error('Disconnected');if(failure==='timeout'){const e=Error('Timeout');e.name='AbortError';throw e;}if(failure==='invalid-json')return{ok:true,status:200,json:async()=>{throw Error('Invalid JSON');}};return reply({ok:false},failure==='503'?503:200);});
  await f.next();assert.equal(f.setupWrites().length,1);assert.equal(f.api.state().step,beforeStep);assert.equal(f.session.get(DRAFT),draft);assert.equal(f.local.has(SEEN),false);assert.match(f.node('tli-onboard-status').textContent,/not confirmed.*may have completed/);
  f.respond(async(url,options,normal)=>url==='/system/onboarding/status'?reply({complete:false,started:phase==='complete'}):normal(url,options));
  const reads=f.statusReads().length;await f.next();assert.equal(f.statusReads().length,reads+1);assert.equal(f.setupWrites().length,1);assert.equal(f.api.state().step,beforeStep);assert.equal(f.session.get(DRAFT),draft);assert.deepEqual(f.effects,[]);
  await f.next();assert.equal(f.setupWrites().length,2);assert.equal(f.api.state().setupUnconfirmed,null);
});

for(const phase of ['start','complete'])test(phase+' recovery that finds completion waits for an explicit local finish',async()=>{
  const f=await at(phase);f.respond((url,options,normal)=>url===endpoint(phase)?Promise.reject(Error('Uncertain')):normal(url,options));await f.next();
  const draft=f.session.get(DRAFT);f.respond(async(url,options,normal)=>url==='/system/onboarding/status'?reply({complete:true,started:false}):normal(url,options));
  await f.next();assert.equal(f.api.state().open,true);assert.equal(f.api.state().setupCompletionReady,true);assert.equal(f.local.has(SEEN),false);assert.equal(f.session.get(DRAFT),draft);assert.deepEqual(f.effects,[]);assert.equal(f.setupWrites().length,1);
  await f.next();assert.equal(f.api.state().open,false);assert.equal(f.local.get(SEEN),'1');assert.equal(f.session.has(DRAFT),false);assert.equal(f.setupWrites().length,1);assert.equal(f.emitted.filter(e=>e.type==='tli:onboarding-complete').length,1);
});

const invalidStates=[{}, {complete:false}, {complete:'false',started:true}, {complete:false,started:null}, {complete:true,started:true}, null];
for(const phase of ['start','complete'])for(const state of invalidStates)test(phase+' rejects malformed recovery status '+JSON.stringify(state),async()=>{
  const f=await at(phase);f.respond((url,options,normal)=>url===endpoint(phase)?Promise.resolve(reply({},503)):normal(url,options));await f.next();
  f.respond(async(url,options,normal)=>url==='/system/onboarding/status'?reply(state):normal(url,options));await f.next();
  assert.equal(f.api.state().setupUnconfirmed,phase);assert.equal(f.api.state().open,true);assert.equal(f.setupWrites().length,1);assert.equal(f.local.has(SEEN),false);assert.equal(f.node('tli-onboard-next').textContent,'Check saved setup');
});

for(const state of invalidStates)test('initialization rejects malformed public setup state '+JSON.stringify(state),async()=>{
  const f=fixture({statusBody:state});await f.settled();assert.equal(f.writes().length,0);assert.equal(f.calls.length,1);assert.equal(f.local.has(SEEN),false);assert.match(f.node('tli-onboard-status').textContent,/could not (?:be confirmed|confirm this request)/);
});

for(const body of [{ok:true},{ok:true,complete:false,started:false},{ok:true,complete:true,started:true}])test('start requires confirmed started or completed acknowledgement '+JSON.stringify(body),async()=>{
  const f=await at('start');f.respond(async()=>reply(body));await f.next();assert.equal(f.api.state().setupUnconfirmed,'start');assert.equal(f.api.state().step,0);assert.equal(f.local.has(SEEN),false);
});

test('setup uncertainty is checked before retained name uncertainty without chaining either save',async()=>{
  const f=await at('start');f.api.setStep(1,{name:'Draft name'});f.api.uncertainName();f.respond((url,options,normal)=>url==='/system/onboarding/start'?Promise.resolve(reply({},503)):normal(url,options));await f.next();
  f.respond(async(url,options,normal)=>url==='/system/onboarding/status'?reply({complete:false,started:true}):normal(url,options));await f.next();assert.equal(f.api.state().nameUnconfirmed,true);assert.equal(f.node('tli-onboard-next').textContent,'Check saved name');assert.equal(f.writes().length,1);
  await f.next();assert.equal(f.calls.at(-1).url,'/status');assert.equal(f.api.state().nameUnconfirmed,false);assert.equal(f.writes().length,1);
});

test('confirmed setup PIN verification retains its intentional session handoff',async()=>{
  const f=await at('start');f.api.setStep(2,{security:'pin'});f.node('onboard-pin').value='123456';f.node('onboard-pin2').value='123456';
  f.window.TLIPinLock.verifyForSetup=async()=>{f.lock();f.unlock();f.ready();return true;};
  await f.next();assert.equal(f.api.state().step,3);assert.deepEqual(f.writes().map(c=>c.url),['/system/onboarding/start','/system/pin/set']);assert.equal(f.api.state().setupUnconfirmed,null);
});

test('uncertain setup start cannot chain PIN creation or verification before explicit reconciliation',async()=>{
  const f=await at('start');f.api.setStep(2,{security:'pin'});f.node('onboard-pin').value='123456';f.node('onboard-pin2').value='123456';let verified=0;
  f.window.TLIPinLock.verifyForSetup=async()=>{verified++;return true;};
  f.respond((url,options,normal)=>url==='/system/onboarding/start'?Promise.resolve(reply({},503)):normal(url,options));await f.next();
  assert.deepEqual(f.writes().map(c=>c.url),['/system/onboarding/start']);assert.equal(verified,0);
  f.respond((url,options,normal)=>url==='/system/onboarding/status'?Promise.resolve(reply({complete:false,started:true})):normal(url,options));await f.next();
  assert.equal(f.writes().length,1);assert.equal(verified,0);assert.equal(f.api.state().step,2);
  f.node('onboard-pin').value='123456';f.node('onboard-pin2').value='123456';await f.next();
  assert.deepEqual(f.writes().map(c=>c.url),['/system/onboarding/start','/system/pin/set']);assert.equal(verified,1);assert.equal(f.api.state().step,3);
});

for(const confirmedBy of ['initial status','start acknowledgement'])test('completed installation replay confirmed by '+confirmedBy+' never posts start each step or completion again',async()=>{
  const f=fixture({complete:confirmedBy==='initial status'});await f.settled();
  if(confirmedBy==='initial status')await f.api.initialize(true);
  else f.respond((url,options,normal)=>url==='/system/onboarding/start'?Promise.resolve(reply({ok:true,complete:true,started:false})):normal(url,options));
  await f.next();assert.equal(f.api.state().step,1);assert.equal(f.api.state().started,false);assert.equal(f.api.state().completed,true);
  await f.next();assert.equal(f.api.state().step,2);f.api.setStep(2,{security:'open'});await f.next();await f.next();await f.next();
  assert.equal(f.api.state().open,false);assert.equal(f.setupWrites().length,confirmedBy==='initial status'?0:1);assert.equal(f.calls.some(c=>c.url==='/system/onboarding/complete'),false);
});

for(const phase of ['start','complete'])test(phase+' interrupted save keeps stored draft bytes through lock and explicit recovery',async()=>{
  const f=await at(phase),pending=deferred(),draft=f.session.get(DRAFT);f.respond((url,options,normal)=>url===endpoint(phase)?pending.promise:normal(url,options));const saving=f.next();
  f.lock();await f.recover();assert.equal(f.session.get(DRAFT),draft);
  f.respond((url,options,normal)=>url==='/system/onboarding/status'?Promise.resolve(reply({complete:false,started:true})):normal(url,options));await f.next();
  assert.equal(f.session.get(DRAFT),draft);pending.resolve(reply(ack(phase)));await saving;assert.equal(f.session.get(DRAFT),draft);assert.equal(f.local.has(SEEN),false);
});

for(const phase of ['start','complete'])for(const code of [401,403])test(phase+' recovery status '+code+' clears private view without releasing the uncertainty gate',async()=>{
  const f=await at(phase);f.respond((url,options,normal)=>url===endpoint(phase)?Promise.resolve(reply({},503)):normal(url,options));await f.next();
  let parsed=false;f.respond((url,options,normal)=>url==='/system/onboarding/status'?Promise.resolve({ok:false,status:code,json:async()=>{parsed=true;return{detail:'private'};}}):normal(url,options));await f.next();
  assert.equal(parsed,false);assert.equal(f.api.state().locked,true);assert.equal(f.api.state().setupUnconfirmed,phase);assert.equal(f.setupWrites().length,1);assert.equal(f.local.has(SEEN),false);
});

for(const phase of ['start','complete'])for(const failure of ['503','network','invalid-json'])test(phase+' unreadable recovery '+failure+' cannot enable another write',async()=>{
  const f=await at(phase);f.respond((url,options,normal)=>url===endpoint(phase)?Promise.resolve(reply({},503)):normal(url,options));await f.next();
  const draft=f.session.get(DRAFT),reads=f.statusReads().length;
  f.respond(async(url,options,normal)=>{if(url!=='/system/onboarding/status')return normal(url,options);if(failure==='network')throw Error('Disconnected');if(failure==='invalid-json')return{ok:true,status:200,json:async()=>{throw Error('Invalid JSON');}};return reply({detail:'Saved setup requires review.'},503);});
  await f.next();await f.next();assert.equal(f.statusReads().length,reads+2);assert.equal(f.setupWrites().length,1);assert.equal(f.api.state().setupUnconfirmed,phase);assert.equal(f.session.get(DRAFT),draft);assert.equal(f.local.has(SEEN),false);assert.equal(f.node('tli-onboard-next').textContent,'Check saved setup');
});

for(const phase of ['start','complete'])for(const code of [200,401,403,503])test(phase+' old recovery '+code+' cannot replace a later saved-state check',async()=>{
  const f=await at(phase);f.respond((url,options,normal)=>url===endpoint(phase)?Promise.resolve(reply({},503)):normal(url,options));await f.next();
  const old=deferred();f.respond((url,options,normal)=>url==='/system/onboarding/status'?old.promise:normal(url,options));const reading=f.next();f.lock();await f.recover();
  f.respond((url,options,normal)=>url==='/system/onboarding/status'?Promise.resolve(reply({complete:false,started:true})):normal(url,options));await f.next();
  old.resolve(reply({complete:true,started:false},code));await reading;
  assert.equal(f.api.state().locked,false);assert.equal(f.api.state().completed,false);assert.equal(f.api.state().setupCompletionReady,false);assert.equal(f.api.state().setupUnconfirmed,null);assert.equal(f.local.has(SEEN),false);assert.equal(f.setupWrites().length,1);
});

test('optional PIN setup still advances without a PIN mutation',async()=>{
  const f=await at('complete');f.api.setStep(2,{security:'open'});await f.next();assert.equal(f.api.state().step,3);assert.equal(f.writes().length,0);
});

test('an initially locked welcome waits for verified readiness before any start write',async()=>{
  const f=fixture({locked:true});await f.settled();assert.equal(f.calls.length,0);f.unlock();await f.next();assert.equal(f.writes().length,0);assert.equal(f.calls.length,0);
  f.ready();await f.settled();assert.equal(f.writes().length,0);assert.equal(f.api.state().nameReady,true);await f.next();assert.equal(f.setupWrites().length,1);assert.equal(f.api.state().step,1);
});

for(const ping of [{},{node_name:null},{node_name:{value:'Private'}},{node_name:'Bad\nname'}])test('public ping hint '+JSON.stringify(ping)+' cannot block general-purpose welcome',async()=>{
  const f=fixture({ping});await f.settled();assert.equal(f.api.state().open,true);assert.equal(f.api.state().name,'');assert.equal(f.writes().length,0);assert.match(source,/think, learn, write and create/);
});

for(const phase of ['start','complete'])test(phase+' real PIN-off interceptor denial remains blocked without a retry loop',async()=>{
  const f=await at(phase,{interceptor:true});f.respond((url,options,normal)=>url===endpoint(phase)?Promise.resolve(reply({},401)):normal(url,options));await f.next();await f.next();f.ready();await f.settled();
  assert.equal(f.setupWrites().length,1);assert.equal(f.api.state().setupUnconfirmed,phase);assert.equal(f.local.has(SEEN),false);
});
