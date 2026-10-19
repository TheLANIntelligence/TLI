const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8').replace(/\r\n/g,'\n');
const app=read('app.js'),shell=read('js/shell-refinement.js'),feed=read('js/live-feed.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const reply=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body,clone:()=>reply(body,status)});
const row=(id='alert-a',message='Private alert')=>({id,message,detail:'Private detail',severity:'warn',dismissed:false});
function events(target={}){
  const handlers=new Map();target.handlers=handlers;
  target.addEventListener=(type,fn)=>{if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn);};
  target.dispatchEvent=e=>{for(const fn of handlers.get(e.type)||[])fn(e);};
  target.emit=(type,detail)=>target.dispatchEvent({type,detail});
  target.fireAsync=(type,e={})=>Promise.all((handlers.get(type)||[]).map(fn=>fn({type,preventDefault(){},stopPropagation(){},...e})));
  return target;
}
function element(tag='div'){
  const classes=new Set();return events({tagName:tag.toUpperCase(),className:'',textContent:'',innerHTML:'',children:[],parentNode:null,hidden:false,disabled:false,dataset:{},style:{},attrs:{},
    setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]??null;},removeAttribute(k){delete this.attrs[k];},
    classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){on??=!classes.has(x);on?classes.add(x):classes.delete(x);}},
    append(...nodes){for(const n of nodes){this.children.push(n);n.parentNode=this;}},appendChild(n){this.append(n);return n;},
    insertBefore(n){this.children.unshift(n);n.parentNode=this;},removeChild(n){this.children=this.children.filter(x=>x!==n);},
    replaceChildren(...nodes){this.children=[];this.textContent='';this.innerHTML='';this.append(...nodes);},
    before(){},after(n){if(this.parentNode)this.parentNode.append(n);},querySelector(){return element();},querySelectorAll(){return[];},closest(){return this;},contains(){return true;},focus(){},
    click(){return this.disabled?Promise.resolve():this.fireAsync('click');}});
}
const allText=node=>[node.textContent,node.innerHTML,...node.children.map(allText)].join(' ');
function shellFixture({locked=false,loadFeed=false,intercepted=false}={}){
  const nodes=new Map(),calls=[],timers=[],created=[],toasts=[],bus=new Map();let savedAlerts=[row()];let respond=async(url,options)=>{if(options.method==='POST'){const id=url.endsWith('dismiss-all')?null:decodeURIComponent(url.split('/')[3]);const count=savedAlerts.length;savedAlerts=id?savedAlerts.filter(a=>a.id!==id):[];return reply({ok:true,dismissed:id||count});}return reply({alerts:savedAlerts,count:savedAlerts.length});};
  const node=id=>{if(!nodes.has(id)){const n=element();n.id=id;nodes.set(id,n);}return nodes.get(id);};
  node('tli-lock-screen').setAttribute('aria-hidden',locked?'false':'true');node('tli-activity-panel').hidden=true;node('tli-device-popover').hidden=true;
  node('tli-alerts-tab').setAttribute('aria-controls','tli-alerts-content');node('tli-events-tab').setAttribute('aria-controls','tli-events-content');
  node('nd-feed').parentNode=element();
  const document=events({hidden:false,readyState:'loading',getElementById:node,createElement:tag=>{const n=element(tag);created.push(n);return n;},createComment:()=>element(),querySelectorAll:()=>[],querySelector:()=>null});
  const window=events({location:{origin:'http://tli.test',href:'http://tli.test/'},showToast:(...x)=>toasts.push(x)});
  window.EventInterpreter={on:(name,fn)=>{if(!bus.has(name))bus.set(name,[]);bus.get(name).push(fn);},init(){},retry(){calls.push({url:'access-check',options:{}});}};
  window.TLIPinLock={checkAndLock:async()=>window.emit('tli-session-unlocked')};
  window.fetch=async(url,options={})=>{calls.push({url,options});return respond(url,options);};
  const context=vm.createContext({window,document,navigator:{platform:'Windows'},AbortSignal,URL,Headers,Date,
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},MutationObserver:class{observe(){}},
    fetch:(...args)=>window.fetch(...args),setTimeout:(fn,delay)=>timers.push({fn,delay}),setInterval:(fn,delay)=>timers.push({fn,delay})});
  if(intercepted)vm.runInContext(read('js/fetch-interceptor.js'),context);
  if(loadFeed)vm.runInContext(feed,context);vm.runInContext(shell,context);document.emit('DOMContentLoaded');
  return{window,document,node,nodes,calls,timers,created,toasts,context,respond:fn=>{respond=fn;},poll:()=>timers.find(t=>t.delay===2000).fn(),
    async settled(){await tick();await tick();},lock:()=>window.emit('tli-session-locked'),unlock:()=>window.emit('tli-session-unlocked'),ready:()=>window.emit('tli-private-observation-ready'),
    async recover(){this.unlock();this.ready();await this.settled();},
    rows:(mobile=false)=>node(mobile?'tli-drawer-alert-list':'tli-alert-list').children.filter(n=>n.className==='tli-alert-row'),
    dismiss(mobile=false){return this.rows(mobile)[0].children[2].click();},
    all:(mobile=false)=>node(mobile?'tli-drawer-dismiss-all':'tli-alert-dismiss-all').click(),
    writes:()=>calls.filter(c=>c.options.method==='POST'),
    emit:(name,value)=>{for(const fn of bus.get(name)||[])fn(value);},
    feedAction(endpoint='/status/alerts/alert-a/dismiss') {this.emit('classified_event',{id:'event-'+created.length,title:'Private event',body:'Private event detail',actions:[{label:'Dismiss',endpoint}]});return node('nd-feed').children[0]?.children[0]?.children[0];},
  };
}

test('shell renders desktop and mobile alerts as literal text and acknowledges exact dismissal',async()=>{
  const f=shellFixture(),message='<img src=x onerror=bad()>',detail='<script>private</script>';
  let saved=true;f.respond(async(url,options)=>{if(options.method==='POST'){saved=false;return reply({ok:true,dismissed:'alert-a'});}return reply({alerts:saved?[{...row('alert-a',message),detail}]:[]});});await f.poll();
  assert.equal(f.rows().length,1);assert.equal(f.rows(true).length,1);assert.match(allText(f.node('tli-alert-list')),/<img/);assert.equal(f.created.some(n=>['IMG','SCRIPT'].includes(n.tagName)),false);
  await f.dismiss();assert.equal(f.writes().length,1);assert.equal(f.rows().length,0);assert.equal(f.rows(true).length,0);assert.match(allText(f.node('tli-alert-list')),/No alerts need attention/);
  assert.equal(f.writes()[0].options.credentials,'same-origin');assert.ok(f.writes()[0].options.signal instanceof AbortSignal);
});
test('shell dismiss-all requires a numeric acknowledgement and updates both views',async()=>{const f=shellFixture();await f.poll();await f.all(true);assert.equal(f.writes()[0].url,'/status/alerts/dismiss-all');assert.equal(f.rows().length,0);assert.equal(f.node('tli-alert-badge').hidden,true);});
test('legacy alert rows without ID or message stay visible with only dismiss-all available',async()=>{
  const f=shellFixture();let saved=true;f.respond(async(url,options)=>{if(options.method==='POST'){saved=false;return reply({ok:true,dismissed:2});}return reply({alerts:saved?[{kind:'legacy'},{detail:'Saved warning'}]:[]});});await f.poll();
  assert.equal(f.rows().length,2);assert.equal(f.rows(true).length,2);assert.equal(f.rows()[0].children[1].textContent,'System alert');assert.ok(f.rows().every(r=>r.children[2].disabled));await f.rows()[0].children[2].fireAsync('click');assert.equal(f.writes().length,0);
  await f.all();assert.equal(f.writes().length,1);assert.equal(f.writes()[0].url,'/status/alerts/dismiss-all');assert.equal(f.rows().length,0);
});

for(const target of ['read','single','all'])for(const code of [401,403])test('shell '+target+' '+code+' clears private rows and parses no denied body',async()=>{
  const f=shellFixture();await f.poll();let parsed=false;f.respond(async()=>({ok:false,status:code,json:async()=>{parsed=true;return{detail:'Private denial'};}}));
  await (target==='read'?f.poll():target==='single'?f.dismiss():f.all());
  assert.equal(parsed,false);assert.equal(f.rows().length,0);assert.equal(f.rows(true).length,0);assert.equal(f.node('tli-alert-badge').hidden,true);assert.equal(f.node('tli-bn-alert-dot').hidden,true);assert.doesNotMatch(allText(f.node('tli-alert-list')),/Private/);
  const before=f.calls.length;f.unlock();await f.poll();await f.all();await f.settled();assert.equal(f.calls.length,before);
  f.respond(async()=>reply({alerts:[row('fresh','New session')]}));await f.recover();assert.equal(f.rows()[0].children[1].textContent,'New session');assert.equal(f.writes().length,target==='read'?0:1);
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])test(event+' clears shell and feed private views together',async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();const button=f.feedAction();assert.ok(button);f.window.emit(event);assert.equal(f.rows().length,0);assert.equal(f.node('nd-feed').children.length,0);assert.equal(f.node('tli-feed-badge').style.display,'none');await button.fireAsync('click');assert.equal(f.writes().length,0);
});

for(const target of ['read','single','all'])for(const code of [200,401,403,503])test('old shell '+target+' '+code+' cannot repaint or relock a renewed session',async()=>{
  const f=shellFixture(),pending=deferred();await f.poll();f.respond(()=>pending.promise);const old=target==='read'?f.poll():target==='single'?f.dismiss():f.all();f.lock();
  f.respond(async()=>reply({alerts:[row('fresh','New session')]}));await f.recover();const count=f.calls.length;
  pending.resolve(reply(target==='read'?{alerts:[row('old','Old private')]}:{ok:true,dismissed:target==='single'?'alert-a':1},code));await old;
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0].children[1].textContent,'New session');assert.equal(f.calls.length,count);assert.equal(f.node('tli-alert-dismiss-all').disabled,false);
});

for(const target of ['read','single','all'])test('shell '+target+' body after lock cannot publish or report success',async()=>{
  const f=shellFixture(),body=deferred();await f.poll();f.respond(async()=>({ok:true,status:200,json:()=>body.promise}));const old=target==='read'?f.poll():target==='single'?f.dismiss():f.all();await tick();f.lock();body.resolve(target==='read'?{alerts:[row()]}:{ok:true,dismissed:target==='single'?'alert-a':1});await old;
  assert.equal(f.rows().length,0);assert.equal(f.node('tli-drawer-alerts').hidden,true);assert.equal(f.toasts.length,0);
});

for(const mobile of [false,true])test('detached '+(mobile?'mobile':'desktop')+' button cannot dismiss alerts in another session or inventory generation',async()=>{
  const f=shellFixture();await f.poll();const old=f.rows(mobile)[0].children[2];f.lock();await f.recover();await old.fireAsync('click');assert.equal(f.writes().length,0);
  const beforeRefresh=f.rows(mobile)[0].children[2];await f.poll();await beforeRefresh.fireAsync('click');assert.equal(f.writes().length,0);
});

for(const target of ['single','all'])for(const failure of ['network','503','invalid-json','missing-ack','wrong-ack'])test('shell '+target+' '+failure+' requires a saved-alert read before another dismissal',async()=>{
  const f=shellFixture();await f.poll();f.respond(async()=>{if(failure==='network')throw Error('Private failure');if(failure==='invalid-json')return{ok:true,status:200,json:async()=>{throw Error('Bad JSON');}};return reply(failure==='wrong-ack'?{ok:true,dismissed:target==='single'?'other':'1'}:{ok:true},failure==='503'?503:200);});
  await (target==='single'?f.dismiss():f.all());assert.equal(f.rows().length,1);assert.equal(f.rows()[0].children[2].disabled,true);assert.equal(f.node('tli-alert-dismiss-all').textContent,'Check saved alerts');assert.match(f.node('tli-alert-error').textContent,/not confirmed.*may have completed/);
  const count=f.calls.length;await f.poll();assert.equal(f.calls.length,count,'Periodic reads do not silently release uncertain dismissals');
  f.respond(async(url,options)=>options.method==='POST'?reply({ok:true,dismissed:'alert-a'}):reply({alerts:[row()]}));await f.all(true);assert.equal(f.writes().length,1);assert.equal(f.calls.at(-1).options.method,undefined);await f.dismiss();assert.equal(f.writes().length,2);
});

for(const body of [null,{}, {alerts:null},{alerts:[null]},{alerts:[{id:null}]},{alerts:[row(),row()]},{alerts:[{...row(),message:17}]}])test('malformed alert read '+JSON.stringify(body)+' is unavailable instead of confirmed empty',async()=>{
  const f=shellFixture();await f.poll();f.respond(async()=>reply(body));await f.poll();assert.equal(f.rows().length,0);assert.doesNotMatch(allText(f.node('tli-alert-list')),/No alerts need attention/);assert.match(allText(f.node('tli-drawer-alert-list')),/unavailable/);assert.equal(f.node('tli-drawer-dismiss-all').textContent,'Check alerts');
});

for(const failure of ['503','network'])test('failed alert read '+failure+' cannot enable dismissal or claim an empty inventory',async()=>{
  const f=shellFixture();await f.poll();f.respond(async()=>{if(failure==='network')throw Error('Private path');return reply({},503);});await f.poll();assert.equal(f.rows().length,0);assert.match(f.node('tli-alert-error').textContent,/Could not refresh/);await f.all();assert.equal(f.writes().length,0);
});

test('initial PIN lock and bare unlock start no shell reads or feed actions',async()=>{
  const f=shellFixture({locked:true,loadFeed:true});await f.poll();assert.equal(f.feedAction(),undefined);f.unlock();await f.poll();assert.equal(f.feedAction(),undefined);assert.equal(f.calls.length,0);f.ready();await f.settled();assert.equal(f.calls.length,1);assert.equal(f.rows().length,1);assert.ok(f.feedAction());
});
test('shell read and dismissal each coalesce duplicate requests without stale finally releasing newer work',async()=>{
  const f=shellFixture(),old=deferred();f.respond(()=>old.promise);const reading=f.poll();await f.poll();assert.equal(f.calls.length,1);f.lock();const fresh=deferred();f.respond(()=>fresh.promise);f.unlock();f.ready();old.resolve(reply({alerts:[row('old')]}));await reading;assert.equal(f.node('tli-alert-dismiss-all').disabled,true);fresh.resolve(reply({alerts:[row()]}));await f.settled();
  const saving=deferred();f.respond(()=>saving.promise);const work=f.dismiss();await f.all();assert.equal(f.writes().length,1);saving.resolve(reply({ok:true,dismissed:'alert-a'}));await work;
});

for(const endpoint of ['/status/alerts/alert-a/dismiss','/status/alerts/dismiss-all'])test('feed validates exact '+endpoint+' acknowledgement and suppresses duplicates',async()=>{
  const f=shellFixture({loadFeed:true}),pending=deferred();await f.poll();f.respond(()=>pending.promise);const button=f.feedAction(endpoint),work=button.click();await button.click();assert.equal(f.writes().length,1);pending.resolve(reply({ok:true,dismissed:endpoint.endsWith('dismiss-all')?1:'alert-a'}));await work;assert.equal(button.textContent,'Done');assert.equal(button.disabled,true);
});
for(const code of [401,403])test('feed '+code+' closes private views before reading a denied body',async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();let parsed=false;f.respond(async()=>({ok:false,status:code,json:async()=>{parsed=true;return{};}}));const button=f.feedAction();await button.click();assert.equal(parsed,false);assert.equal(f.node('nd-feed').children.length,0);assert.equal(f.rows().length,0);f.unlock();f.ready();await f.settled();await button.fireAsync('click');assert.equal(f.writes().length,1);
});
for(const code of [200,401,403,503])test('late feed '+code+' cannot paint or relock after recovery',async()=>{
  const f=shellFixture({loadFeed:true}),pending=deferred();await f.poll();f.respond(()=>pending.promise);const button=f.feedAction(),work=button.click();f.lock();f.respond(async()=>reply({alerts:[]}));await f.recover();const fresh=f.feedAction();pending.resolve(reply({ok:true,dismissed:'alert-a'},code));await work;assert.notEqual(button.textContent,'Done');assert.equal(f.node('nd-feed').children.length,1);assert.ok(fresh);await button.fireAsync('click');assert.equal(f.writes().length,1);
});
for(const body of [{ok:false},{ok:true},{ok:true,dismissed:'wrong'}])test('feed uncertain acknowledgement '+JSON.stringify(body)+' stays review-only',async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();f.respond(async()=>reply(body));const button=f.feedAction();await button.click();assert.match(button.textContent,/Not confirmed.*review Alerts/);assert.equal(button.disabled,true);await button.fireAsync('click');assert.equal(f.writes().length,1);
});
test('feed action created before lock cannot dispatch even after renewed access',async()=>{const f=shellFixture({loadFeed:true});const button=f.feedAction();f.lock();await f.recover();await button.fireAsync('click');assert.equal(f.writes().length,0);});
test('feed body resolution after lock cannot report dismissal success',async()=>{const f=shellFixture({loadFeed:true}),body=deferred();await f.poll();f.respond(async()=>({ok:true,status:200,json:()=>body.promise}));const button=f.feedAction(),work=button.click();await tick();f.lock();body.resolve({ok:true,dismissed:'alert-a'});await work;assert.notEqual(button.textContent,'Done');assert.equal(f.node('nd-feed').children.length,0);});
test('real PIN-off interceptor denial cannot loop shell reads or repeat a dismissal',async()=>{const f=shellFixture({intercepted:true});await f.poll();f.respond(async()=>reply({},401));await f.dismiss();await f.poll();await f.all();await f.settled();assert.equal(f.writes().length,1);assert.equal(f.calls.length,2);});

function dashboardFixture(){
  const nodes=new Map(),calls=[],effects=[],projected=[],window=events({});const node=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const normal=async url=>reply(url==='/dashboard/command-center'?null:url==='/status'?{model_online:false,node_role:'standalone',mesh_status:'unpaired',device_id:'host-a',device_nickname:'Host'}:url==='/api/system/disk'?{ok:true}:url==='/status/alerts'?{alerts:[row()]}:{});let respond=normal;
  window.TLINarrator={observeContext:data=>projected.push(data),clear(){},unavailable:()=>effects.push('unavailable')};window.TLIPresence={fetchActionCurrent:()=>effects.push('actions')};
  const context=vm.createContext({window,document:{getElementById:node},AbortSignal,Date,CustomEvent:class{constructor(type){this.type=type;}},
    _viewEpoch:0,_sessionLocked:false,_open:true,_accessBlocked:false,_lastData:{nickname:'Private prior host'},_lastRefreshFailed:false,_serverNarrator:null,_narratorTransition:null,_seenFeedIds:new Set(),_el:()=>null,_setVital(){},
    _pauseDashboard(){context._viewEpoch++;context._open=false;},onClose(){context._viewEpoch++;context._open=false;},_clearPrivateDashboard(){context._lastData=null;effects.push('clear');},_showAccessPrompt:()=>effects.push('prompt'),
    _seedFeed:()=>effects.push('feed'),_refreshMeshStrip:()=>effects.push('mesh'),_renderObservationSummary(){},_renderActions(){},_renderQuickRead(){},_renderSuggestions(){},_feedLog(){},setEventMessage(){},
    fetch:async(url,options)=>{calls.push({url,options});return respond(url,options);}});
  window.addEventListener('tli-session-locked',()=>{context._sessionLocked=true;context._viewEpoch++;});
  const start=app.indexOf('  async function _refreshOnce()'),end=app.indexOf('  function _renderObservationSummary()',start);assert.ok(start>=0&&end>start);vm.runInContext(app.slice(start,end),context);
  const account=app.indexOf("  for (const event of ['tli-account-changed','tli-user-changed'])"),unlock=app.indexOf("  window.addEventListener('tli-session-unlocked'",account);assert.ok(account>=0&&unlock>account);vm.runInContext(app.slice(account,unlock),context);
  return{context,calls,effects,projected,window,normal,respond:fn=>{respond=fn;},refresh:()=>context._refreshOnce(),renew(){context._viewEpoch++;context._sessionLocked=false;context._open=true;context._accessBlocked=false;}};
}
for(const code of [401,403])test('Dashboard alert '+code+' clears private fallback without manufacturing an empty alert snapshot',async()=>{
  const f=dashboardFixture();let parsed=false;f.respond(async url=>url==='/dashboard/command-center'?reply(null,503):url==='/status'?reply({model_online:false,node_role:'standalone',mesh_status:'unpaired'}):url==='/api/system/disk'?reply({ok:true}):url==='/status/alerts'?{ok:false,status:code,json:async()=>{parsed=true;return{};}}:reply({}));await f.refresh();assert.equal(parsed,false);assert.equal(f.context._accessBlocked,true);assert.equal(f.context._lastData,null);assert.equal(f.projected.length,0);assert.deepEqual(f.effects,['clear','prompt']);
});
for(const failure of ['503','network','malformed'])test('Dashboard '+failure+' alert read is unavailable rather than healthy empty',async()=>{
  const f=dashboardFixture();f.respond(async url=>{if(url==='/dashboard/command-center')return reply(null,503);if(url==='/status')return reply({model_online:false,node_role:'standalone',mesh_status:'unpaired'});if(url==='/api/system/disk')return reply({ok:true});if(url==='/status/alerts'){if(failure==='network')throw Error('Private');return reply({},failure==='503'?503:200);}return reply({});});await f.refresh();assert.equal(f.projected.length,0);assert.equal(f.context._lastRefreshFailed,true);assert.equal(f.context._lastData.nickname,'Private prior host');assert.deepEqual(f.effects,['unavailable']);
});
for(const code of [200,401,403,503])test('old Dashboard alerts '+code+' cannot replace a new snapshot',async()=>{
  const f=dashboardFixture(),pending=deferred();f.respond(async url=>url==='/dashboard/command-center'?reply(null,503):url==='/status'?reply({model_online:false,node_role:'standalone',mesh_status:'unpaired'}):url==='/api/system/disk'?reply({ok:true}):url==='/status/alerts'?pending.promise:reply({}));const old=f.refresh();await tick();f.renew();f.respond(async()=>reply({ok:true,nickname:'New host',node:{id:'new',name:'New host'},activeAlerts:[]}));await f.refresh();const effects=f.effects.length;pending.resolve(reply({alerts:[row('old','Old private')]},code));await old;assert.equal(f.context._lastData.nickname,'New host');assert.equal(f.context._sessionLocked,false);assert.equal(f.effects.length,effects);
});
test('Dashboard valid alerts preserve the fallback projection',async()=>{const f=dashboardFixture();await f.refresh();assert.equal(f.projected.length,1);assert.equal(f.context._lastData.activeAlerts[0].id,'alert-a');assert.equal(f.calls.find(c=>c.url==='/status/alerts').options.credentials,'same-origin');});
test('Dashboard preserves displayable legacy alert rows without inventing identifiers',async()=>{const f=dashboardFixture();f.respond(async url=>url==='/status/alerts'?reply({alerts:[{}, {detail:'Legacy warning'}]}):f.normal(url));await f.refresh();assert.equal(f.projected.length,1);assert.equal(f.context._lastData.activeAlerts.length,2);assert.equal(Object.hasOwn(f.context._lastData.activeAlerts[0],'id'),false);});
for(const event of ['tli-account-changed','tli-user-changed'])test('Dashboard '+event+' clears alert observations and ignores an in-flight fallback body',async()=>{
  const f=dashboardFixture(),body=deferred();f.respond(async url=>url==='/status/alerts'?{ok:true,status:200,json:()=>body.promise}:f.normal(url));const work=f.refresh();await tick();f.window.emit(event);body.resolve({alerts:[row('old','Old private alert')]});await work;
  assert.equal(f.context._lastData,null);assert.equal(f.context._sessionLocked,true);assert.equal(f.context._open,false);assert.equal(f.projected.length,0);assert.deepEqual(f.effects,['clear']);
});


test('feed loaded before the shell still requires its checked inventory; a missing coordinator never dispatches',async()=>{
  const f=shellFixture({loadFeed:true});const initial=f.feedAction();assert.equal(initial.disabled,true);await initial.fireAsync('click');assert.equal(f.writes().length,0);
  await f.poll();assert.equal(initial.disabled,false);delete f.window.TLIShell;const absent=f.feedAction();assert.equal(absent.disabled,true);await absent.fireAsync('click');assert.equal(f.writes().length,0);
});

for(const initiator of ['shell','feed'])test(initiator+' dismissal gates both views and all reconciliation reads until settlement',async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();const oldFeed=f.feedAction(),oldRow=f.rows()[0].children[2],pending=deferred();
  f.respond((url,options)=>options.method==='POST'?pending.promise:reply({alerts:[row()]}));
  const work=initiator==='shell'?f.dismiss():oldFeed.click();await tick();
  const count=f.calls.length;await oldFeed.fireAsync('click');await oldRow.fireAsync('click');await f.all(true);await f.poll();const during=f.feedAction();await during.fireAsync('click');
  assert.equal(f.writes().length,1);assert.equal(f.calls.length,count);assert.equal(during.disabled,true);
  pending.resolve(reply({ok:true,dismissed:'alert-a'}));await work;assert.equal(f.calls.length,count+1,'Confirmed writes permit one fresh saved-state read');
  assert.equal(oldFeed.disabled,true);await oldFeed.fireAsync('click');await oldRow.fireAsync('click');assert.equal(f.writes().length,1);
  assert.equal(during.disabled,false,'An action created in the new generation can be used only after a saved-state read');
  assert.equal(during.textContent,'Dismiss','An enabled button must describe its actual mutation');
});

for(const stage of ['headers','body'])test('feed dispatch invalidates a shell alert read pending at '+stage,async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();const button=f.feedAction(),read=deferred(),write=deferred();
  f.respond((url,options)=>options.method==='POST'?write.promise:stage==='headers'?read.promise:replyWithBody(read.promise));
  const reading=f.poll();await tick();const saving=button.click();assert.equal(f.writes().length,1);
  read.resolve(stage==='headers'?reply({alerts:[row('stale','Stale read')]}):{alerts:[row('stale','Stale read')]});await reading;
  assert.doesNotMatch(allText(f.node('tli-alert-list')),/Stale read/);assert.equal(f.node('tli-alert-dismiss-all').disabled,true);
  write.resolve(reply({},503));await saving;assert.equal(f.node('tli-alert-dismiss-all').textContent,'Check saved alerts');
});
const replyWithBody=promise=>({ok:true,status:200,json:()=>promise});

for(const initiator of ['shell','feed'])test(initiator+' uncertain dismissal retires old cross-view actions until an explicit saved-state check',async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();const feedButton=f.feedAction();
  f.respond(async(url,options)=>options.method==='POST'?reply({},503):reply({alerts:[row()]}));
  await (initiator==='shell'?f.dismiss():feedButton.click());const count=f.calls.length;await f.poll();const fresh=f.feedAction();await fresh.fireAsync('click');assert.equal(f.calls.length,count);assert.equal(f.writes().length,1);
  await f.all();assert.equal(f.calls.length,count+1);assert.equal(f.writes().length,1);assert.equal(fresh.disabled,false);await feedButton.fireAsync('click');assert.equal(f.writes().length,1);
  await fresh.click();assert.equal(f.writes().length,2,'Another write requires a deliberate action after checked saved state');
});

for(const initiator of ['shell','feed'])test('late old-session '+initiator+' settlement cannot release a new pending dismissal',async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();const old=deferred();f.respond(()=>old.promise);
  const prior=initiator==='shell'?f.dismiss():f.feedAction().click();f.lock();f.respond(async()=>reply({alerts:[row()]}));await f.recover();
  const pending=deferred();f.respond(()=>pending.promise);const current=f.dismiss();const count=f.calls.length;
  old.resolve(reply({ok:true,dismissed:'alert-a'}));await prior;await f.all();await f.poll();const button=f.feedAction();await button.fireAsync('click');assert.equal(f.calls.length,count);assert.equal(f.node('tli-alert-dismiss-all').disabled,true);
  pending.resolve(reply({},503));await current;assert.equal(f.node('tli-alert-dismiss-all').disabled,false);assert.equal(f.node('tli-alert-dismiss-all').textContent,'Check saved alerts');
});

for(const stage of ['headers','body'])test('stream access_required during feed '+stage+' retires UI but releases only its own uncertain shell token',async()=>{
  const f=shellFixture({loadFeed:true});await f.poll();const pending=deferred();f.respond(()=>stage==='headers'?pending.promise:replyWithBody(pending.promise));
  const button=f.feedAction(),work=button.click();await tick();f.emit('access_required',{message:'Read access unavailable'});
  pending.resolve(stage==='headers'?reply({ok:true,dismissed:'alert-a'}):{ok:true,dismissed:'alert-a'});await work;assert.notEqual(button.textContent,'Done');
  const count=f.calls.length;assert.equal(f.node('tli-alert-dismiss-all').disabled,false);assert.equal(f.node('tli-alert-dismiss-all').textContent,'Check saved alerts');
  f.emit('access_ready');f.ready();await f.settled();assert.equal(f.calls.length,count,'Readiness alone does not replay or confirm the detached dismissal');
  f.respond(async()=>reply({alerts:[row()]}));await f.all();assert.equal(f.calls.length,count+1);assert.equal(f.writes().length,1);assert.equal(f.feedAction().disabled,false);
});

function connectDashboard(f,d){d.window.TLIShell=f.window.TLIShell;f.window.addEventListener('tli-alert-operation',event=>d.window.emit(event.type,event.detail));}
for(const source of ['command-center','fallback'])for(const stage of ['headers','body'])test('alert dispatch invalidates pending Dashboard '+source+' '+stage+' before disclosure',async()=>{
  const f=shellFixture({loadFeed:true}),d=dashboardFixture();await f.poll();connectDashboard(f,d);const stale=deferred(),write=deferred();let parsed=false;
  d.respond(async url=>url===(source==='command-center'?'/dashboard/command-center':'/status/alerts')?(stage==='headers'?stale.promise:{ok:true,status:200,json:()=>stale.promise}):d.normal(url));
  const reading=d.refresh();await tick();f.respond(()=>write.promise);const saving=f.dismiss();
  const oldData=source==='command-center'?{ok:true,nickname:'Old host',activeAlerts:[row('stale')]}:{alerts:[row('stale')]};
  stale.resolve(stage==='headers'?{ok:true,status:200,json:async()=>{parsed=true;return oldData;}}:oldData);await reading;
  assert.equal(parsed,false);assert.equal(d.projected.length,0);assert.equal(d.context._lastRefreshFailed,true);assert.equal(d.context._lastData.nickname,'Private prior host');
  write.resolve(reply({},503));await saving;
});

test('Dashboard starts no alert snapshot during pending or uncertain dismissal and resumes only after a checked saved-state read',async()=>{
  const f=shellFixture({loadFeed:true}),d=dashboardFixture();await f.poll();connectDashboard(f,d);const write=deferred();f.respond(()=>write.promise);const work=f.dismiss();
  await d.refresh();assert.equal(d.calls.length,0);write.resolve(reply({},503));await work;await d.refresh();assert.equal(d.calls.length,0);assert.equal(d.context._lastRefreshFailed,true);
  f.respond(async()=>reply({alerts:[]}));await f.all();assert.equal(f.writes().length,1);await d.refresh();assert.equal(d.projected.length,1);assert.equal(d.context._lastRefreshFailed,false);
});


test('queued and newly delivered narrator briefings cannot replace alert uncertainty before a checked read',async()=>{
  const f=shellFixture(),d=dashboardFixture();await f.poll();connectDashboard(f,d);const timers=new Map(),painted=[],accepted=[];let next=0;
  d.window.TLINarrator.accept=msg=>{accepted.push(msg.text);return true;};d.window.TLINarrator.tick=()=>{};
  Object.assign(d.context,{setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),_typeText:text=>painted.push(text),_setNarratorCard(){}});
  const start=app.indexOf('  function setEventMessage(msg'),end=app.indexOf("  window.addEventListener('tli-system-observation'",start);assert.ok(start>=0&&end>start);vm.runInContext(app.slice(start,end),d.context);
  d.context.setEventMessage({type:'alert',text:'Old private alert briefing'});assert.equal(timers.size,1);
  const pending=deferred();f.respond(()=>pending.promise);const work=f.dismiss();assert.equal(timers.size,1,'Starting a dismissal cancels the older narrator transition');
  d.context.setEventMessage({type:'alert',text:'Queued old briefing',briefing:{version:1,summary:'Stale alert summary'}});
  for(const fn of timers.values())fn();timers.clear();assert.equal(painted.length,1);assert.match(painted[0],/needs a fresh check/);assert.doesNotMatch(painted[0],/private|Stale/);
  pending.resolve(reply({},503));await work;d.context.setEventMessage({type:'alert',text:'Still uncertain'});assert.equal(timers.size,0);assert.equal(accepted.length,2);
  f.respond(async()=>reply({alerts:[]}));await f.all();assert.equal(f.writes().length,1);d.context.setEventMessage({type:'status',text:'Fresh observed briefing'});for(const fn of timers.values())fn();assert.equal(painted.at(-1),'Fresh observed briefing');
});
