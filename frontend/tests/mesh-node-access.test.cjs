const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../js',name),'utf8');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,clone(){return this;}});
const identity=(name='Saved host',id='host-a')=>({node_id:id,display_name:name,role:'standalone',join_mode:'standalone',is_host:false,host_address:null,created_at:'2025-01-01',last_seen:'2025-02-01'});
const directory=(id='host-a')=>({mode:'standalone',this_device_id:id,host_device_id:null,devices:[]});
function events(target={}){
  const handlers=new Map();target.addEventListener=(type,fn)=>{if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn);};
  target.dispatchEvent=event=>{for(const fn of handlers.get(event.type)||[])fn(event);};
  target.emit=(type,detail)=>target.dispatchEvent({type,detail});
  target.fire=async(type,event={})=>{for(const fn of handlers.get(type)||[])await fn({type,preventDefault(){},stopPropagation(){},...event});};return target;
}
function fixture({mesh=false,lan=false,locked=false,intercepted=false}={}){
  const nodes=new Map(),calls=[],streams=[],timers=new Map(),intervals=new Map(),logs=[];let serial=0;
  function element(tag='div'){
    const classes=new Set();const n=events({tagName:tag.toUpperCase(),children:[],style:{},dataset:{},attrs:{},value:'',textContent:'',disabled:false,hidden:false,
      setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]??null;},removeAttribute(k){delete this.attrs[k];},
      classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){on?classes.add(x):classes.delete(x);}},
      append(...children){for(const child of children){this.children.push(child);child.parentNode=child.parentElement=this;}},appendChild(child){this.append(child);return child;},
      insertBefore(child){this.children.unshift(child);child.parentNode=child.parentElement=this;},replaceChildren(...children){this.children=[];this.textContent='';this._html='';this.append(...children);},
      querySelector:()=>null,querySelectorAll:()=>[],getClientRects:()=>[{}],remove(){},focus(){},close(){},
      click(){return this.disabled?Promise.resolve():this.fire('click');}});
    Object.defineProperty(n,'innerHTML',{get(){return this._html||'';},set(value){this._html=value;this.children=[];}});
    Object.defineProperty(n,'id',{get(){return this._id;},set(id){this._id=id;nodes.set(id,this);}});return n;
  }
  const node=id=>{if(!nodes.has(id)){const n=element();n.id=id;}return nodes.get(id);};
  node('tli-lock-screen').setAttribute('aria-hidden',locked?'false':'true');
  element().appendChild(node('tli-chat-thread-output'));
  const document=events({hidden:false,getElementById:node,createElement:element,querySelector:()=>null,querySelectorAll:()=>[],body:element('body')});
  const window=events({innerWidth:1200,location:{origin:'http://localhost',href:'http://localhost/'},showToast(){}});
  const normal=url=>reply(url==='/mesh/node'?identity():url==='/mesh/directory'?directory():url==='/api/lan/peers'?{peers:[]}:{messages:[]});let respond=normal;
  window.fetch=async(url,options={})=>{calls.push({url,options});return respond(url,options);};
  window.TLIPinLock={checkAndLock:async()=>window.emit('tli-session-unlocked')};
  window.EventInterpreter={retry:()=>calls.push({url:'access-check',options:{}})};
  class Source {constructor(url){this.url=url;this.closed=false;events(this);streams.push(this);}close(){this.closed=true;}}
  const context=vm.createContext({window,document,URL,Headers,AbortSignal,AbortController,EventSource:Source,Date,console:{error(){},warn(){}},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},crypto:{randomUUID:()=>String(++serial)},
    currentNodeConfig:null,meshDirectoryCache:null,meshJoinPollTimer:null,currentDeviceId:null,$:node,debugLog:(...args)=>logs.push(args),syncMeshContextTags(){},showToast(){},
    setInlineStatus:(id,message)=>{node(id).textContent=message;},
    setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{intervals.set(++serial,{fn,ms});return serial;},clearInterval:id=>intervals.delete(id),
    fetch:(...args)=>window.fetch(...args)});
  if(intercepted)vm.runInContext(read('fetch-interceptor.js'),context);
  // Actual index order: Mesh panel, LAN messenger, then the shared service.
  if(mesh)vm.runInContext(read('mesh.js'),context);
  if(lan)vm.runInContext(read('tli-chat.js').replace('  // Public API','  window.testLAN = {state,loadLocalNodeIdentity,sendCurrentMessage,refreshNodes,openThread};\n  // Public API'),context);
  vm.runInContext(read('mesh-service.js'),context);
  return {window,document,context,node,calls,streams,timers,intervals,logs,api:window.MeshService,lan:window.testLAN,
    normal,respond:fn=>{respond=fn;},lock:()=>window.emit('tli-session-locked'),unlock:()=>window.emit('tli-session-unlocked'),ready:()=>window.emit('tli-private-observation-ready'),
    async settle(){for(let i=0;i<4;i++)await tick();},async recover(){this.unlock();this.ready();await this.settle();},
    nodeRead:()=>window.MeshService.fetchNode({force:true}),directoryRead:()=>window.MeshService.fetchDirectory({force:true}),meshRead:()=>context.refreshMeshNodeAndMaybeDirectory(),lanRead:()=>window.TLIChat.onOpen(),
    posts:()=>calls.filter(c=>c.options.method==='POST')};
}

test('saved identity fields and timestamps remain literal observations; reads never issue a mutation',async()=>{
  const f=fixture({mesh:true}),saved={...identity('<img src=x>'),host_address:'saved:8000'};f.respond(url=>url==='/mesh/node'?reply(saved):f.normal(url));
  assert.equal(await f.meshRead(),true);assert.equal(f.node('mesh-node-name').textContent,'<img src=x>');assert.equal(f.node('mesh-node-host-address').textContent,'saved:8000');assert.equal(f.node('mesh-node-last-seen').textContent,'2025-02-01');
  assert.equal(f.posts().length,0);assert.deepEqual(f.calls.map(c=>c.url),['/mesh/node','/mesh/directory']);
  assert.ok(f.calls.every(c=>c.options.credentials==='same-origin'&&c.options.cache==='no-store'&&c.options.signal instanceof AbortSignal));
});
test('legacy saved identity names and IDs are not subjected to new-edit limits',async()=>{
  const f=fixture({mesh:true,lan:true}),saved=identity('Old '.repeat(1500),'id'.repeat(120));
  f.respond(url=>url==='/mesh/node'?reply(saved):url==='/mesh/directory'?reply(directory(saved.node_id)):f.normal(url));
  assert.equal(await f.meshRead(),true);await f.lanRead();assert.equal(f.lan.state.localNodeId,saved.node_id);assert.equal(f.lan.state.localNodeName,saved.display_name);assert.equal(f.node('mesh-node-name').textContent,saved.display_name);
});

for(const method of ['nodeRead','directoryRead','meshRead','lanRead'])for(const status of [401,403])test(method+' '+status+' clears private state and bare unlock cannot restart it',async()=>{
  const f=fixture({mesh:method==='meshRead',lan:method==='lanRead'});await f.nodeRead();let parsed=false;
  f.respond(async()=>({ok:false,status,json:async()=>{parsed=true;return{detail:'private'};}}));await f[method]().catch(()=>{});
  assert.equal(parsed,false);assert.equal(f.api.getThisNode(),null);assert.equal(f.context.currentNodeConfig,null);
  const count=f.calls.length;f.unlock();await f[method]().catch(()=>{});await f.settle();assert.equal(f.calls.length,count);assert.equal(f.streams.filter(s=>!s.closed).length,0);
  f.respond(f.normal);await f.recover();await f[method]();assert.equal(f.posts().length,0);
});

for(const method of ['nodeRead','directoryRead','meshRead','lanRead'])for(const stage of ['headers','body'])for(const status of stage==='headers'?[200,401,403]:[200])test('old '+method+' '+stage+' '+status+' cannot repaint or relock after a new session',async()=>{
  const f=fixture({mesh:method==='meshRead',lan:method==='lanRead'});await f.nodeRead();const pending=deferred();
  const route=method==='directoryRead'?'/mesh/directory':'/mesh/node';
  f.respond(url=>url===route?(stage==='headers'?pending.promise:{ok:true,status:200,json:()=>pending.promise}):f.normal(url));
  const work=f[method]().catch(()=>{});await tick();f.lock();f.respond(url=>url==='/mesh/node'?reply(identity('New session')):f.normal(url));await f.recover();await f[method]();
  const count=f.calls.length;const stale=method==='directoryRead'?directory():identity('OLD PRIVATE');pending.resolve(stage==='headers'?reply(stale,status):stale);await work;
  assert.equal(f.calls.length,count);assert.equal(f.api.getThisNode()?.display_name,method==='lanRead'?undefined:'New session');
  if(method==='lanRead')assert.equal(f.lan.state.localNodeName,'New session');if(method==='meshRead')assert.equal(f.node('mesh-node-name').textContent,'New session');
  assert.equal(f.posts().length,0);
});

for(const value of [null,{},[],{...identity(),node_id:null},{...identity(),display_name:27},{...identity(),role:'unknown'},{...identity(),join_mode:'host'},{...identity(),is_host:true},{...identity(),host_address:{}}])test('malformed node '+JSON.stringify(value)+' cannot enable dependent directory reads',async()=>{
  const f=fixture({mesh:true});f.respond(()=>reply(value));assert.equal(await f.meshRead(),false);assert.equal(f.api.getThisNode(),null);assert.equal(f.calls.length,1);assert.equal(f.node('mesh-join-btn').disabled,true);assert.match(f.node('mesh-directory-status').textContent,/unavailable/);
});
for(const value of [null,{},[],{...directory(),devices:null},{...directory(),this_device_id:'other'},{...directory(),devices:[null]},{...directory(),devices:[{device_id:'peer',display_name:'Peer'},{device_id:'peer',display_name:'Duplicate'}]}])test('malformed directory '+JSON.stringify(value)+' never reports a successful empty inventory',async()=>{
  const f=fixture({mesh:true});await f.meshRead();const old=f.context.meshDirectoryCache;f.respond(url=>url==='/mesh/directory'?reply(value):f.normal(url));
  assert.equal(await f.meshRead(),false);assert.equal(f.context.meshDirectoryCache,old);assert.match(f.node('mesh-directory-status').textContent,/unavailable.*retained/);assert.equal(f.posts().length,0);
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])test(event+' removes node, directory and LAN identity details',async()=>{
  const f=fixture({mesh:true,lan:true});await f.meshRead();await f.lanRead();f.node('mesh-directory-list').textContent='Private peer';f.node('tli-chat-thread-title').textContent='Private friend';f.window.emit(event);
  for(const id of ['mesh-node-id','mesh-node-name','mesh-node-host-address','mesh-node-created','mesh-node-last-seen'])assert.equal(f.node(id).textContent,'—');
  assert.equal(f.node('mesh-directory-list').textContent,'');assert.equal(f.node('tli-chat-thread-title').textContent,'');assert.equal(f.lan.state.localNodeId,null);assert.equal(f.streams.filter(s=>!s.closed).length,0);assert.equal(f.node('mesh-join-btn').disabled,true);
});
test('initial PIN overlay sends no private identity request until verified readiness in actual script order',async()=>{
  const f=fixture({mesh:true,lan:true,locked:true});await f.meshRead();await f.lanRead();assert.equal(f.calls.length,0);f.unlock();await f.meshRead();await f.lanRead();assert.equal(f.calls.length,0);
  f.ready();await f.settle();assert.equal(f.node('mesh-node-name').textContent,'Saved host');assert.equal(f.lan.state.localNodeId,'host-a');assert.equal(f.streams.filter(s=>!s.closed&&s.url==='/mesh/presence/stream').length,1);assert.equal(f.posts().length,0);
});
test('coalesced node reads and old finalizers cannot release a new pending request',async()=>{
  const f=fixture(),old=deferred(),fresh=deferred();f.respond(()=>old.promise);const a=f.nodeRead().catch(()=>{}),b=f.nodeRead().catch(()=>{});assert.equal(f.calls.length,1);f.lock();await f.recover();f.respond(()=>fresh.promise);const c=f.nodeRead();old.resolve(reply(identity('Old')));await Promise.all([a,b]);const d=f.nodeRead();assert.equal(f.calls.length,2);fresh.resolve(reply(identity('Fresh')));await Promise.all([c,d]);assert.equal(f.api.getThisNode().display_name,'Fresh');
});

for(const failure of ['503','network','malformed'])test('LAN '+failure+' identity failure starts no directory/SSE/send and preserves an editable draft for explicit read recovery',async()=>{
  const f=fixture({lan:true});await f.lanRead();f.lan.state.selectedNodeId='peer';f.node('tli-chat-input').value='Keep my draft';
  f.respond(async()=>{if(failure==='network')throw Error('Unavailable');return reply(failure==='malformed'?{}:{detail:'Unavailable'},failure==='503'?503:200);});const before=f.calls.length;await f.lanRead();await f.lan.sendCurrentMessage();
  assert.deepEqual(f.calls.slice(before).map(c=>c.url),['/mesh/node']);assert.equal(f.streams.filter(s=>!s.closed).length,0);assert.equal(f.lan.state.localNodeId,null);assert.equal(f.node('tli-chat-input').value,'Keep my draft');assert.equal(f.node('tli-chat-send-btn').disabled,true);assert.equal(f.posts().length,0);
  f.respond(f.normal);await f.node('tli-chat-buddies-list').children[1].click();assert.equal(f.lan.state.localNodeId,'host-a');assert.equal(f.node('tli-chat-input').value,'Keep my draft');assert.equal(f.posts().length,0);
});
for(const status of [401,403])test('PIN-off '+status+' denial cannot auto-loop through identity reads or unlock effects',async()=>{
  const f=fixture({mesh:true,lan:true,intercepted:true});f.respond(async()=>reply({},status));await f.lanRead();await f.settle();const count=f.calls.length;f.unlock();await f.meshRead();await f.lanRead();await f.settle();assert.equal(f.calls.length,count);assert.equal(f.posts().length,0);
});
test('hidden LAN recovery waits for visible observation and never sends a retained action',async()=>{
  const f=fixture({lan:true});await f.lanRead();f.lock();f.document.hidden=true;const count=f.calls.length;await f.recover();assert.equal(f.calls.length,count);f.document.hidden=false;f.document.emit('visibilitychange');await f.settle();assert.equal(f.lan.state.localNodeId,'host-a');assert.equal(f.posts().length,0);
});


test('bare unlock enables only an explicit LAN access check, without an identity retry',async()=>{
  const f=fixture({lan:true});await f.lanRead();f.lock();const count=f.calls.length;f.unlock();const check=f.node('tli-chat-buddies-list').children[1];assert.equal(check.textContent,'Check access');assert.equal(check.disabled,false);await check.click();assert.deepEqual(f.calls.slice(count).map(c=>c.url),['access-check']);assert.equal(f.posts().length,0);
});

test('Mesh refresh offers an access check while paused and ignores a detached success after lock',async()=>{
  const f=fixture({mesh:true});let task;
  Object.assign(f.context,{refreshBtn:f.node('mesh-node-refresh-btn'),withButtonBusy:(_button,_label,fn)=>{task=fn();}});
  const source=read('mesh.js'),start=source.indexOf('if (refreshBtn) {'),end=source.indexOf('  // Join host flow',start);assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),f.context);
  f.lock();f.unlock();const count=f.calls.length;await f.node('mesh-node-refresh-btn').click();assert.deepEqual(f.calls.slice(count).map(c=>c.url),['access-check']);
  f.ready();await f.settle();f.context.refreshMeshNodeAndMaybeDirectory=()=>Promise.resolve(true).then(value=>{f.lock();return value;});await f.node('mesh-node-refresh-btn').click();await task;assert.doesNotMatch(f.node('mesh-directory-status').textContent,/up to date/);
});


test('failed identity refresh preserves prior display as unavailable but cannot supply a cached authority hint',async()=>{
  const f=fixture({mesh:true});await f.meshRead();f.respond(async()=>reply({},503));assert.equal(await f.meshRead(),false);assert.equal(f.node('mesh-node-name').textContent,'Saved host');assert.match(f.node('mesh-directory-status').textContent,/unavailable.*retained/);assert.equal(f.node('mesh-join-btn').disabled,true);assert.equal(f.api.getThisNode(),null);assert.equal(f.api.isHost(),false);const count=f.calls.length;await assert.rejects(f.directoryRead());assert.deepEqual(f.calls.slice(count).map(c=>c.url),['/mesh/node']);
});

test('a deliberate LAN send uses confirmed identity and is never replayed after verified access recovery',async()=>{
  const f=fixture({lan:true});await f.lanRead();f.lan.state.rawNodes=[{id:'peer',name:'Other host',ip:'192.168.1.2',connection:{state:'connected',fresh:true,online:true,expires_at:new Date(Date.now()+60000).toISOString(),ready_grants:['messages']}}];f.lan.state.selectedNodeId='peer';f.lan.state.lastDirectoryOk=true;f.node('tli-chat-input').value='Hello';
  f.respond((url,options)=>url==='/mesh/chat/send'?reply({delivery:'acknowledged'}):f.normal(url));await f.lan.sendCurrentMessage();assert.equal(f.posts().length,1);const payload=JSON.parse(f.posts()[0].options.body);assert.equal(payload.from_id,'host-a');assert.equal(payload.from_name,'Saved host');assert.equal(payload.thread_id,'host-a--peer');assert.equal(f.node('tli-chat-input').value,'');f.lock();await f.recover();assert.equal(f.posts().length,1);
});
