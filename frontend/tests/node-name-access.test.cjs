const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {create}=require('../js/host-identity.js');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const app=read('app.js'),settings=read('js/settings.js'),onboarding=read('js/onboarding.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const reply=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body,clone:()=>reply(body,status)});
const snapshot=(name='Saved host',role='standalone')=>({device_id:'host-a',device_nickname:name,node_role:role});
function events(target={}){const map=new Map();target.addEventListener=(name,fn)=>{if(!map.has(name))map.set(name,[]);map.get(name).push(fn);};target.dispatchEvent=event=>{for(const fn of map.get(event.type)||[])fn(event);};target.fire=(type,detail)=>target.dispatchEvent({type,detail});target.fireAsync=(type,event={})=>Promise.all((map.get(type)||[]).map(fn=>fn({type,preventDefault(){},...event})));return target;}
function fixture(kind,{handler,draft,interceptor=false}={}){
  const nodes=new Map(),calls=[],toasts=[],timers=new Map(),storage=new Map(),session=new Map(),effects=[];let nextTimer=0;
  if(draft)session.set('tli_onboard_progress_v3',JSON.stringify(draft));
  function element(id=''){
    const classes=new Set(),children=[];const el=events({id,value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,dataset:{},style:{},attrs:{},children,tagName:'DIV',inert:false,
      classList:{add:n=>classes.add(n),remove:n=>classes.delete(n),contains:n=>classes.has(n),toggle(n,v){v=v??!classes.has(n);v?classes.add(n):classes.delete(n);}},
      setAttribute(n,v){this.attrs[n]=String(v);},getAttribute(n){return this.attrs[n]??null;},removeAttribute(n){delete this.attrs[n];},
      replaceChildren(...items){this.children=items;this.innerHTML='';this.textContent='';},append(...items){this.children.push(...items);},appendChild(item){this.append(item);return item;},
      querySelector(selector){return node(id+':'+selector);},querySelectorAll(){return[];},focus(){},select(){},contains(){return true;},getClientRects(){return[{}];},
      click(){return this.disabled?Promise.resolve():this.fireAsync('click');}});
    return el;
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);};
  node('tli-lock-screen').setAttribute('aria-hidden','true');
  const document=events({readyState:'complete',hidden:false,getElementById:id=>id==='onboard-music-audio'?null:node(id),createElement:()=>element(),querySelectorAll:()=>[],documentElement:element(),body:element(),activeElement:element()});
  const window=events({});
  const identity=create(state=>{node('device-name-chip').textContent=state.name||'Not confirmed';});
  identity.observe({id:'host-a',name:'Saved host',source:'status'});window.TLIUI={hostIdentity:identity};window.TLIHostIdentity=identity;
  window.addEventListener('tli-session-locked',()=>identity.setLocked(true));window.addEventListener('tli-session-unlocked',()=>identity.setLocked(false));
  window.EventInterpreter={retry:()=>effects.push('access-check')};window.switchPanel=panel=>effects.push(panel);
  window.TLIPinLock={checkAndLock:()=>window.fire('tli-session-unlocked')};
  let respond=handler|| (async(url,options)=>{
    if(url==='/system/onboarding/status')return reply({complete:false,started:true});
    if(url==='/system/pin/status')return reply({enabled:false});
    if(url==='/agent/ping')return reply({node_name:'Saved host'});
    if(url==='/status')return reply(snapshot());
    const body=JSON.parse(options.body||'{}');
    if(url==='/device/nickname')return reply({status:'ok',device_id:'default-device',node_id:'host-a',nickname:body.nickname});
    if(url==='/system/node/name')return reply({ok:true,node_id:'host-a',node_name:body.name});
    if(url==='/mesh/node/identity')return reply({ok:true,node_id:'host-a',node_name:body.node_name||'Saved host',role:body.role});
    return reply({ok:true});
  });
  window.fetch=async(url,options={})=>{calls.push({url,options});return respond(url,options);};
  const store=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
  const ctx=vm.createContext({window,document,localStorage:store(storage),sessionStorage:store(session),AbortController,AbortSignal,Date,console,
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},Event:class{constructor(type){this.type=type;}},
    $:id=>node(id),fetch:(...args)=>window.fetch(...args),showToast:(...args)=>toasts.push(args),
    setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  if(interceptor)vm.runInContext(read('js/fetch-interceptor.js'),ctx);
  if(kind==='header'){vm.runInContext(app.slice(app.indexOf('function setupDeviceRename()'),app.indexOf('// ---------- hamburger ----------'))+'\nsetupDeviceRename();',ctx);}
  if(kind==='settings'){vm.runInContext(settings.slice(settings.indexOf('  // ── Node Identity'),settings.indexOf('  // ── Cryptographic Identity')),ctx);}
  if(kind==='onboarding'){
    vm.runInContext(onboarding.replace("  if (document.readyState === 'loading')", "  window.testOnboard={next,initialize,personalize:(value)=>{step=1;name=value;render();},state:()=>({step,name,savedName,nameUnconfirmed,nameReady,busy,initializing,locked,open}),};\n  if (document.readyState === 'loading')"),ctx);
  }
  return{kind,window,document,node,nodes,calls,toasts,effects,identity,session,ctx,respond:fn=>{respond=fn;},
    async settled(){await tick();await tick();},
    lock:()=>window.fire('tli-session-locked'),unlock:()=>window.fire('tli-session-unlocked'),ready:()=>window.fire('tli-private-observation-ready'),
    async recover(){this.unlock();this.ready();await this.settled();},
    async save(name='New host',role='host'){
      if(kind==='header'){node('tli-rename-input').value=name;return node('tli-rename-form').fireAsync('submit');}
      if(kind==='settings'){node('settings-node-name').value=name;node('settings-node-role').value=role;return node('settings-node-identity-save').click();}
      window.testOnboard.personalize(name);return window.testOnboard.next();
    },
    submit(){return kind==='header'?node('tli-rename-form').fireAsync('submit'):kind==='settings'?node('settings-node-identity-save').click():window.testOnboard.next();},
    mutations(){return calls.filter(c=>c.options.method==='POST');},
    text(){return kind==='header'?node('tli-rename-error').textContent:kind==='settings'?toasts.at(-1)?.[0]||'':node('tli-onboard-status').textContent;},
  };
}

for(const kind of ['header','settings','onboarding'])test(`${kind} confirmed name change uses one canonical write and actual host identity`,async()=>{
  const f=fixture(kind);await f.settled();await f.save();
  assert.equal(f.mutations().length,1);assert.equal(f.identity.get().name,'New host');assert.equal(f.identity.get().id,'host-a');
  assert.equal(f.calls.some(c=>c.url==='/mesh/node'),false);assert.equal(f.mutations()[0].options.credentials,'same-origin');
  assert.ok(f.mutations()[0].options.signal instanceof AbortSignal);
  if(kind==='header')assert.equal(f.mutations()[0].url,'/device/nickname');
  if(kind==='onboarding')assert.equal(f.window.testOnboard.state().step,2);
});

for(const kind of ['header','settings','onboarding'])for(const code of [401,403])test(`${kind} ${code} clears private names and cannot repeat on bare or verified unlock`,async()=>{
  const f=fixture(kind);await f.settled();f.respond(async()=>reply({detail:'PRIVATE denial'},code));await f.save('Private requested name');
  assert.equal(f.identity.get().status,'locked');assert.equal(f.mutations().length,1);assert.doesNotMatch(f.text(),/PRIVATE denial/);
  const field=f.node(kind==='header'?'tli-rename-input':kind==='settings'?'settings-node-name':'onboard-node-name');assert.equal(field.value,'');
  f.unlock();await f.submit();assert.equal(f.mutations().length,1);
  f.respond(async()=>reply(snapshot()));f.ready();await f.settled();assert.equal(f.mutations().length,1);
});

for(const kind of ['header','settings','onboarding'])for(const code of [200,401,403,503])test(`${kind} old ${code} cannot overwrite or relock a renewed session`,async()=>{
  const f=fixture(kind),pending=deferred();await f.settled();f.respond(()=>pending.promise);const old=f.save('Old private name');
  f.lock();f.respond(async()=>reply(snapshot('Fresh host')));await f.recover();f.identity.observe({id:'host-a',name:'Fresh host',source:'host-rename'});
  const count=f.calls.length;pending.resolve(reply({ok:true,status:'ok',node_id:'host-a',node_name:'Old private name',nickname:'Old private name',role:'host'},code));await old;
  assert.equal(f.identity.get().name,'Fresh host');assert.equal(f.identity.get().status,'known');assert.equal(f.calls.length,count);assert.equal(f.mutations().length,1);
});

for(const kind of ['header','settings','onboarding'])test(`${kind} duplicate submit cannot duplicate an in-flight mutation`,async()=>{
  const f=fixture(kind),pending=deferred();await f.settled();f.respond(()=>pending.promise);const first=f.save();await f.submit();assert.equal(f.mutations().length,1);
  pending.resolve(reply({ok:true,status:'ok',node_id:'host-a',node_name:'New host',nickname:'New host',role:'host'}));await first;assert.equal(f.mutations().length,1);
});

for(const kind of ['header','settings','onboarding'])for(const failure of ['network','503','unconfirmed','wrong-name','missing-id'])test(`${kind} ${failure} save requires a separate read, never an automatic retry`,async()=>{
  const f=fixture(kind);await f.settled();f.respond(async()=>{if(failure==='network')throw Error('Connection interrupted');return reply(failure==='unconfirmed'?{ok:true,status:'ok'}:
    {ok:true,status:'ok',node_id:failure==='missing-id'?null:'host-a',node_name:failure==='wrong-name'?'Other':'New host',nickname:failure==='wrong-name'?'Other':'New host',role:'host'},failure==='503'?503:200);});
  await f.save();assert.equal(f.mutations().length,1);assert.match(f.text(),/not confirmed|may have completed/);assert.equal(f.identity.get().name,'Saved host');
  f.respond(async()=>reply(snapshot('Actually saved host')));await f.submit();assert.equal(f.mutations().length,1);assert.equal(f.calls.at(-1).url,'/status');
  if(kind==='onboarding'){assert.equal(f.window.testOnboard.state().step,1);assert.equal(f.window.testOnboard.state().savedName,'Actually saved host');}
});

for(const kind of ['header','settings','onboarding'])test(`${kind} body parsing after lock cannot publish a saved name`,async()=>{
  const f=fixture(kind),body=deferred();await f.settled();f.respond(async()=>({ok:true,status:200,json:()=>body.promise}));const saving=f.save();await tick();f.lock();
  body.resolve({ok:true,status:'ok',node_id:'host-a',node_name:'New host',nickname:'New host',role:'host'});await saving;
  assert.equal(f.identity.get().status,'locked');assert.equal(f.mutations().length,1);
});

for(const kind of ['header','settings','onboarding'])test(`${kind} accepts 64 Unicode code points without truncating the write`,async()=>{
  const f=fixture(kind);await f.settled();const name='🎶'.repeat(64);await f.save(name);
  assert.equal(f.mutations().length,1);const body=JSON.parse(f.mutations()[0].options.body);assert.equal(body.nickname||body.node_name||body.name,name);
  if(kind==='onboarding')assert.equal(f.window.testOnboard.state().savedName,name);
});

test('browser name inputs leave Unicode and longer saved names intact for save-time validation',()=>{
  const html=read('index.html');
  for(const [source,id] of [[html,'tli-rename-input'],[html,'settings-node-name'],[onboarding,'onboard-node-name']]){
    const input=source.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(input,`Missing ${id} input`);
    assert.doesNotMatch(input[0],/\bmaxlength\s*=/i,`${id} must not truncate Unicode or existing saved names`);
  }
});

for(const kind of ['header','settings','onboarding'])for(const name of ['\nSaved host','Saved host\t','A\u0085B','🎶'.repeat(65)])test(`${kind} rejects control or overlength input before a write: ${JSON.stringify(name.slice(0,18))}`,async()=>{
  const f=fixture(kind);await f.settled();await f.save(name);assert.equal(f.mutations().length,0);assert.match(f.text(),/control|64/);
});

test('Settings preserves a longer existing name and omits it during a role-only edit',async()=>{
  const name='L'.repeat(120),f=fixture('settings',{handler:async(url,options)=>url==='/status'?reply(snapshot(name)):reply({ok:true,node_id:'host-a',node_name:name,role:'host'})});
  await f.settled();assert.equal(f.node('settings-node-name').value,name);await f.save(name,'host');
  assert.deepEqual(JSON.parse(f.mutations()[0].options.body),{role:'host'});assert.equal(f.identity.get().name,name);
});

for(const kind of ['header','onboarding'])test(`${kind} recovers a longer existing saved name without trapping recovery`,async()=>{
  const f=fixture(kind);await f.settled();f.respond(async()=>reply({},503));await f.save();const name='L'.repeat(120);
  f.respond(async()=>reply(snapshot(name)));await f.submit();assert.equal(f.mutations().length,1);
  if(kind==='header')assert.equal(f.node('tli-rename-input').value,name);else assert.equal(f.window.testOnboard.state().savedName,name);
});

for(const bad of [{device_id:null}, {node_role:null}, {node_role:'invented'}, {device_nickname:{private:'name'}}])test(`Settings rejects incomplete identity read ${JSON.stringify(bad)}`,async()=>{
  const f=fixture('settings',{handler:async()=>reply({...snapshot(),...bad})});await f.settled();
  assert.equal(f.node('settings-node-name').value,'');assert.equal(f.node('settings-node-name').disabled,true);assert.equal(f.node('settings-node-identity-save').textContent,'Check saved name & role');
});

test('Settings old identity read cannot repaint after lock or release a fresh save',async()=>{
  const old=deferred(),f=fixture('settings',{handler:()=>old.promise});f.lock();f.respond(async()=>reply(snapshot('New session')));await f.recover();
  const write=deferred();f.respond(()=>write.promise);const saving=f.save('New choice');old.resolve(reply(snapshot('Old private name')));await f.settled();
  assert.equal(f.node('settings-node-name').value,'New choice');assert.equal(f.node('settings-node-identity-save').disabled,true);
  write.resolve(reply({ok:true,node_id:'host-a',node_name:'New choice',role:'host'}));await saving;
});

test('onboarding keeps the general-purpose welcome and restores a longer draft without truncation',async()=>{
  const name='D'.repeat(90),f=fixture('onboarding',{draft:{step:1,name}});await f.settled();
  assert.equal(f.window.testOnboard.state().name,name);assert.match(onboarding,/think, learn, write and create/);assert.match(onboarding,/Start a conversation, write or explore an idea/);
  assert.equal(f.mutations().length,0);
});

for(const phase of ['status','pin','ping'])test(`onboarding initialization ${phase} from a prior session cannot paint or continue requests`,async()=>{
  const pending=deferred(),target={status:'/system/onboarding/status',pin:'/system/pin/status',ping:'/agent/ping'}[phase];
  const f=fixture('onboarding',{handler:async url=>url===target?pending.promise:reply(url==='/system/onboarding/status'?{complete:false,started:true}:{enabled:false})});await tick();f.lock();
  const count=f.calls.length;pending.resolve(reply(phase==='status'?{complete:false,started:true}:phase==='pin'?{enabled:false}:{node_name:'Old private name'}));await f.settled();
  assert.equal(f.calls.length,count);assert.equal(f.window.testOnboard.state().savedName,'');assert.equal(f.window.testOnboard.state().locked,true);assert.equal(f.mutations().length,0);
});

test('onboarding cancelled initialization resumes only reads after verified readiness',async()=>{
  const pending=deferred(),f=fixture('onboarding',{handler:()=>pending.promise});f.lock();f.unlock();await f.settled();assert.equal(f.calls.length,1);
  f.respond(async url=>reply(url==='/system/onboarding/status'?{complete:false,started:true}:url==='/system/pin/status'?{enabled:false}:{node_name:'Current host'}));f.ready();await f.settled();
  pending.resolve(reply({complete:false,started:true}));await f.settled();assert.equal(f.window.testOnboard.state().savedName,'Current host');assert.equal(f.mutations().length,0);
});

test('onboarding lock between setup-start and name-save prevents the second mutation',async()=>{
  const f=fixture('onboarding',{handler:async url=>reply(url==='/system/onboarding/status'?{complete:false,started:false}:url==='/system/pin/status'?{enabled:false}:{node_name:'Saved host'})});
  await f.settled();const pending=deferred();f.respond(()=>pending.promise);const saving=f.save();assert.equal(f.mutations()[0].url,'/system/onboarding/start');
  f.lock();pending.resolve(reply({ok:true}));await saving;assert.equal(f.mutations().length,1);assert.equal(f.window.testOnboard.state().step,1);
});

for(const kind of ['header','settings','onboarding'])test(`${kind} real interceptor PIN-off handling never repeats an uncertain name write`,async()=>{
  const f=fixture(kind,{interceptor:true});await f.settled();f.respond(async()=>reply({},401));await f.save();await f.submit();
  assert.equal(f.mutations().length,1);f.ready();await f.settled();assert.equal(f.mutations().length,1);
});
