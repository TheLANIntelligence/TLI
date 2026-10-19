const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const token='a'.repeat(16), satellite={node_id:'sat_synthetic',name:'Synthetic phone',platform:'android',online:true};
const invitation={ok:true,token,url:'https://host.example/#join=satellite&token='+token,qr:null,expires_in:600};
const license={tier:'pro',valid:true,beta:true,licensee:'Beta',expires_at:null,issued_at:null,node_bound:false,node_id:'PRIVATE HOST',features:{mesh:true,vault:true}};
function fixture({script='js/satellite.js',paired=false,intercepted=false,href='https://host.example/',handler}={}) {
  const nodes={},events={},docEvents={},calls=[],timers=new Map(),storage=new Map(),copied=[],replaced=[];let serial=0;
  if(paired){storage.set('sat_node_id',satellite.node_id);storage.set('sat_secret','synthetic-secret');storage.set('sat_name',satellite.name);}
  function element(tag='div') {
    const classes=new Set();let text='',html='';
    const node={tag,children:[],handlers:{},dataset:{},style:{},hidden:false,disabled:false,value:'',attributes:{},
      classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle(name){classes.has(name)?classes.delete(name):classes.add(name);}},
      set id(value){this._id=value;nodes[value]=this;},get id(){return this._id;},
      set textContent(value){text=String(value);html='';this.children=[];},get textContent(){return text+this.children.map(n=>n.textContent).join(' ');},
      set innerHTML(value){html=String(value);text='';this.children=[];},get innerHTML(){return html;},
      appendChild(child){child.parentElement=this;this.children.push(child);return child;},append(...children){children.forEach(child=>this.appendChild(child));},
      replaceChildren(...children){text='';html='';this.children=[];this.append(...children);},
      addEventListener(type,fn){(this.handlers[type]||=[]).push(fn);},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},
      querySelector(selector){if(selector==='.mcd-sat-remove-btn'&&html.includes('mcd-sat-remove-btn'))return this.removeButton||=element('button');return null;},querySelectorAll(){return [];},
      async fire(type,event={}){if(type==='click'&&this.onclick)await this.onclick(event);for(const fn of this.handlers[type]||[])await fn({target:this,...event});},
      click(){return this.disabled?Promise.resolve():this.fire('click');},focus(){},remove(){},
    };return node;
  }
  const ids=['mcd-add-sat-btn','mcd-satellites-section','mcd-sat-grid','mcd-sat-count','panel-mesh','tli-sat-qr-modal','tli-sat-qr-img-wrap','tli-sat-qr-url','tli-sat-qr-countdown','tli-sat-qr-close','tli-sat-qr-copy',
    'tli-sat-join','tli-sat-join-name','tli-sat-join-btn','tli-sat-join-error',
    'panel-settings','tli-lic-status-row','tli-lic-tier-badge','tli-lic-licensee','tli-lic-expiry','tli-lic-features','tli-lic-key-input','tli-lic-activate-btn','tli-lic-deactivate-btn','tli-lic-msg',
    'comp-dot','hdr-bat','panel-label','chat-output','chat-input','chat-send','devices-list','leave-btn','toast','panels','devices-refresh-btn','scenes-refresh-btn','push-msg-btn',
    'st-name','st-satid','st-bat','st-bat-bar','st-platform','st-conn','st-ai','st-devcount','st-node'];
  for(const id of ids){const node=element();node.id=id;}
  nodes['panel-mesh'].hidden=true;nodes['panel-settings'].hidden=true;nodes['tli-sat-qr-modal'].classList.add('hidden');
  const emit=(type,detail)=>{for(const fn of events[type]||[])fn(new CustomEvent(type,{detail}));};
  const location=new URL(href);location.replace=value=>replaced.push(value);
  let respond=handler||((url)=>({data:url==='/mesh/satellite/list'?{satellites:[satellite]}:url.endsWith('/generate-token')?invitation:url==='/license/details'?license:url.endsWith('/presets')?{presets:[]}:{ok:true}}));
  const ctx=vm.createContext({console:{log(){},warn(){},error(){}},Date,URL,URLSearchParams,CustomEvent,Headers,AbortController,
    location,history:{replaceState(_a,_b,value){replaced.push(value);location.href=new URL(value,location).href;}},
    navigator:{userAgent:'Synthetic Android',clipboard:{writeText:async text=>{copied.push(text);}}},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    document:{readyState:'loading',hidden:false,getElementById:id=>nodes[id]||null,createElement:element,querySelectorAll:()=>[],querySelector:()=>null,
      addEventListener:(type,fn)=>(docEvents[type]||=[]).push(fn)},
    MutationObserver:class{constructor(fn){this.fn=fn;}observe(){}},confirm:()=>true,
    addEventListener:(type,fn)=>(events[type]||=[]).push(fn),dispatchEvent:event=>emit(event.type,event.detail),
    setInterval:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearInterval:id=>timers.delete(id),
    setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimeout:id=>timers.delete(id),requestAnimationFrame(){},
    fetch:async(url,options={})=>{calls.push({url,options});const result=await respond(url,options);return {ok:(result.status||200)<300,status:result.status||200,json:async()=>result.data,clone(){return this;}};},
  });ctx.window=ctx;
  if(intercepted){ctx.TLIPinLock={checkAndLock:()=>Promise.resolve().then(()=>emit('tli-session-unlocked'))};vm.runInContext(source('js/fetch-interceptor.js'),ctx);}
  let code=source(script);
  if(script==='js/companion.js')code=code.replace(/\}\)\(\);\s*$/, 'window.__phoneTest={beat:_beat,leave:_leave,status:_loadStatus};})();');
  vm.runInContext(code,ctx);
  return {ctx,nodes,calls,timers,storage,copied,replaced,emit,handler:fn=>respond=fn,
    async boot(){for(const fn of docEvents.DOMContentLoaded||[])await fn();await tick();},
    async list(){for(const fn of docEvents['tli-panel-switched']||[])await fn({detail:{panelId:'panel-mesh'}});await tick();},
    recover(){emit('tli-session-unlocked',{source:'pin-verification'});emit('tli-private-observation-ready');},
  };
}

test('satellite names, connection text and identifiers never enter HTML as active markup',async()=>{
  const f=fixture({handler:()=>({data:{satellites:[{...satellite,name:'<img src=x onerror=alert(1)>',connection_type:'<script>private</script>',node_id:'x" onclick="bad',battery_level:'1" onerror="bad'}]}})});await f.boot();await f.list();
  const card=f.nodes['mcd-sat-grid'].children[0];assert.match(card.innerHTML,/&lt;img/);assert.match(card.innerHTML,/&lt;script/);assert.doesNotMatch(card.innerHTML,/<img|<script|onclick=/);
  await card.removeButton.click();assert.ok(f.calls.some(call=>call.url.includes('x%22%20onclick%3D%22bad')));
});

test('compatible saved satellites with missing or null display metadata remain visible',async()=>{
  const f=fixture({handler:()=>({data:{satellites:[{node_id:'sat_1234567890',name:null,platform:null,connection_type:null},{node_id:'sat_1234567891'}]}})});await f.boot();await f.list();
  assert.equal(f.nodes['mcd-sat-grid'].children.length,2);for(const card of f.nodes['mcd-sat-grid'].children)assert.match(card.innerHTML,/Phone/);
});

test('QR creation coalesces clicks and lock clears the secret, image, timer and copy callback',async()=>{
  const wait=deferred(),f=fixture({handler:()=>wait.promise});await f.boot();const pending=f.nodes['mcd-add-sat-btn'].click();await f.nodes['mcd-add-sat-btn'].fire('click');
  assert.equal(f.calls.length,1);wait.resolve({data:invitation});await pending;assert.match(f.nodes['tli-sat-qr-url'].textContent,/token=/);
  const copy=f.nodes['tli-sat-qr-copy'].onclick;f.emit('tli-session-locked');await copy();
  assert.equal(f.nodes['tli-sat-qr-url'].textContent,'');assert.equal(f.nodes['tli-sat-qr-img-wrap'].textContent,'');assert.equal(f.copied.length,0);assert.equal(f.timers.size,0);
});

for(const outcome of ['success','401','403'])test('late QR '+outcome+' cannot restore or relock a newer session',async()=>{
  const wait=deferred(),f=fixture({handler:()=>wait.promise});await f.boot();const pending=f.nodes['mcd-add-sat-btn'].click();
  f.emit('tli-session-locked');f.recover();f.handler(()=>({data:{satellites:[satellite]}}));await f.list();
  wait.resolve(outcome==='success'?{data:invitation}:{status:Number(outcome),data:{detail:'OLD FAILURE'}});await pending;
  assert.equal(f.nodes['tli-sat-qr-url'].textContent,'');assert.equal(f.nodes['mcd-sat-grid'].children.length,1);assert.equal(f.nodes['mcd-add-sat-btn'].disabled,false);
});

test('closing a pending QR prevents late display and error text is literal',async()=>{
  const wait=deferred(),f=fixture({handler:()=>wait.promise});await f.boot();const pending=f.nodes['mcd-add-sat-btn'].click();await f.nodes['tli-sat-qr-close'].click();wait.resolve({data:invitation});await pending;
  assert.equal(f.nodes['tli-sat-qr-url'].textContent,'');assert.equal(f.timers.size,0);
  f.handler(()=>({status:503,data:{detail:'<img onerror=bad>'}}));await f.nodes['mcd-add-sat-btn'].click();
  assert.match(f.nodes['tli-sat-qr-img-wrap'].textContent,/<img onerror=bad>/);assert.equal(f.nodes['tli-sat-qr-img-wrap'].innerHTML,'');
});

for(const bad of [{...invitation,url:'javascript:alert(1)'},{...invitation,qr:'https://evil.example/private'},{...invitation,expires_in:0}])test('invalid invitation never enables secret copy or a QR image',async()=>{
  const f=fixture({handler:()=>({data:bad})});await f.boot();await f.nodes['mcd-add-sat-btn'].click();assert.equal(f.nodes['tli-sat-qr-url'].textContent,'');assert.equal(f.nodes['tli-sat-qr-copy'].disabled,true);
});

for(const status of [401,403])test('satellite '+status+' clears private cards and bare unlock cannot generate or reload',async()=>{
  const f=fixture({intercepted:true});await f.boot();await f.list();f.handler(()=>({status,data:{detail:'Clear cookies or unlock this browser.'}}));
  await f.nodes['mcd-sat-grid'].children[0].removeButton.click();await tick();assert.equal(f.nodes['mcd-sat-grid'].children.length,0);assert.match(f.nodes['mcd-sat-count'].textContent,/cookies.*not confirmed/);
  let checks=0;f.ctx.EventInterpreter={retry:async()=>checks++};const count=f.calls.length;await f.list();await f.nodes['mcd-add-sat-btn'].click();
  assert.equal(checks,1);assert.equal(f.calls.length,count);f.recover();assert.equal(f.calls.length,count);
});

test('satellite removal is checked, never repeated, and old removal completion cannot reload a new session',async()=>{
  const f=fixture();await f.boot();await f.list();const wait=deferred();f.handler(()=>wait.promise);const remove=f.nodes['mcd-sat-grid'].children[0].removeButton;
  const pending=remove.click();await remove.fire('click');assert.equal(f.calls.filter(c=>c.options.method==='DELETE').length,1);
  f.emit('tli-session-locked');f.recover();wait.resolve({data:{ok:true,removed:1}});await pending;assert.equal(f.calls.length,2);
});

for(const suffix of ['#join=satellite&token='+token,'?join=satellite&token='+token])test('join '+suffix[0]+' captures and removes token before waiting for an explicit enrollment click',async()=>{
  const f=fixture({href:'https://host.example/'+suffix,handler:()=>({data:{ok:true,node_id:satellite.node_id,secret:'new-secret',name:'Phone'}})});await f.boot();
  assert.equal(f.calls.length,0);assert.equal(f.replaced[0],'/');assert.equal(f.ctx.location.href,'https://host.example/');
  await f.nodes['tli-sat-join-btn'].click();assert.equal(JSON.parse(f.calls[0].options.body).token,token);assert.equal(f.storage.get('sat_secret'),'new-secret');
});

for(const script of ['js/satellite.js','js/companion.js'])for(const status of [403,503])test(script+' heartbeat '+status+' preserves saved pairing unless credential invalidity is explicit',async()=>{
  const f=fixture({script,paired:true,handler:()=>({status,data:{detail:'Transport or store unavailable'}})});await f.boot();assert.equal(f.storage.get('sat_secret'),'synthetic-secret');
  f.handler(()=>({status:403,data:{detail:{code:'satellite_credential_invalid',message:'Unknown satellite or invalid secret.'}}}));
  if(script.includes('companion'))await f.ctx.__phoneTest.beat();else await [...f.timers.values()].find(t=>t.ms===30000).fn();
  assert.equal(f.storage.has('sat_secret'),false);
});

test('legacy phone status preserves local facts without probing or inventing private host state',async()=>{
  const f=fixture({script:'js/companion.js',paired:true});await f.boot();
  const before=new Map(f.storage),count=f.calls.length;
  for(const id of ['st-ai','st-devcount','st-node']){f.nodes[id].textContent='Old private host';f.nodes[id].className='stat-val good';}
  f.handler(()=>{throw Error('Phone status must not request host hardware');});
  await f.ctx.__phoneTest.status();await f.ctx.__phoneTest.status();
  assert.equal(f.calls.length,count);assert.equal(f.nodes['st-name'].textContent,satellite.name);
  assert.equal(f.nodes['st-satid'].textContent,satellite.node_id);assert.equal(f.nodes['st-platform'].textContent,'Android');
  assert.equal(f.nodes['st-bat'].textContent,'Not available');
  for(const id of ['st-ai','st-devcount','st-node']){assert.equal(f.nodes[id].textContent,'Not confirmed');assert.equal(f.nodes[id].className,'stat-val');}
  assert.deepEqual(f.storage,before);
  f.storage.set('sat_secret','replacement-secret');f.nodes['st-name'].textContent='Replacement phone';await f.ctx.__phoneTest.status();
  assert.equal(f.nodes['st-name'].textContent,'Replacement phone');assert.equal(f.calls.length,count);
});

test('Companion self-removal sends its own secret once and clears local pairing only after confirmation',async()=>{
  const f=fixture({script:'js/companion.js',paired:true});await f.boot();const wait=deferred();f.handler(()=>wait.promise);
  const pending=f.ctx.__phoneTest.leave();await f.ctx.__phoneTest.leave();assert.equal(f.storage.get('sat_secret'),'synthetic-secret');
  const call=f.calls.at(-1);assert.equal(call.url,'/mesh/satellite/self-remove');assert.equal(call.options.method,'POST');assert.deepEqual(JSON.parse(call.options.body),{node_id:satellite.node_id,secret:'synthetic-secret'});
  wait.resolve({data:{ok:true,removed:true}});await pending;assert.equal(f.storage.has('sat_secret'),false);assert.equal(f.calls.filter(c=>c.url.endsWith('self-remove')).length,1);
});

for(const outcome of [{status:403,data:{detail:'Transport denied'}},{status:503,data:{detail:'Store unavailable'}},{data:{ok:true}}])test('unconfirmed Companion self-removal retains pairing and never claims success',async()=>{
  const f=fixture({script:'js/companion.js',paired:true});await f.boot();f.handler(()=>outcome);await f.ctx.__phoneTest.leave();assert.equal(f.storage.get('sat_secret'),'synthetic-secret');assert.match(f.nodes.toast.textContent,/not confirmed.*retained.*No retry/);
  assert.equal(f.calls.filter(c=>c.url.endsWith('self-remove')).length,1);
});

test('old heartbeat and self-removal replies cannot clear replacement phone credentials',async()=>{
  for(const action of ['beat','leave']){
    const f=fixture({script:'js/companion.js',paired:true});await f.boot();const wait=deferred();f.handler(()=>wait.promise);const pending=f.ctx.__phoneTest[action]();
    f.storage.set('sat_secret','replacement-secret');wait.resolve(action==='beat'?{status:403,data:{detail:{code:'satellite_credential_invalid'}}}:{data:{ok:true,removed:true}});await pending;
    assert.equal(f.storage.get('sat_secret'),'replacement-secret');assert.equal(f.ctx.location.href,'https://host.example/');
  }
});

test('license details are private, BETA and features survive, and unknown feature labels are literal text',async()=>{
  const f=fixture({script:'settings_enhanced.js',handler:url=>({data:url==='/license/details'?{...license,features:{'<img onerror=bad>':true}}:{}})});await f.boot();
  assert.ok(f.calls.some(c=>c.url==='/license/details'));assert.ok(f.calls.every(c=>c.url!=='/license/status'));assert.equal(f.nodes['tli-lic-tier-badge'].textContent,'BETA');
  assert.equal(f.nodes['tli-lic-features'].children[0].textContent,'<img onerror=bad>');assert.equal(f.nodes['tli-lic-features'].innerHTML,'');
});

for(const status of [401,403])test('license '+status+' clears private details and key, retains recovery detail, and waits for verified readiness',async()=>{
  const f=fixture({script:'settings_enhanced.js',intercepted:true});await f.boot();f.nodes['tli-lic-key-input'].value='PRIVATE KEY';f.handler(()=>({status,data:{detail:'Clear cookies or unlock this browser.'}}));
  await f.nodes['tli-lic-activate-btn'].click();await tick();assert.equal(f.nodes['tli-lic-key-input'].value,'');assert.equal(f.nodes['tli-lic-licensee'].textContent,'');assert.equal(f.nodes['tli-lic-features'].children.length,0);
  assert.match(f.nodes['tli-lic-msg'].textContent,/cookies.*not confirmed.*No retry/);assert.equal(f.nodes['tli-lic-deactivate-btn'].disabled,true);
  let checks=0;f.ctx.EventInterpreter={retry:async()=>checks++};const count=f.calls.length;await f.nodes['tli-lic-refresh-btn'].click();assert.equal(checks,1);assert.equal(f.calls.length,count);
  f.recover();assert.equal(f.calls.length,count);assert.equal(f.nodes['tli-lic-deactivate-btn'].disabled,false);
});

for(const outcome of ['success','401','403'])test('old license activation '+outcome+' cannot repaint or clear the current license session',async()=>{
  const f=fixture({script:'settings_enhanced.js'});await f.boot();const wait=deferred();f.handler(()=>wait.promise);f.nodes['tli-lic-key-input'].value='PRIVATE KEY';const pending=f.nodes['tli-lic-activate-btn'].click();
  assert.equal(f.nodes['tli-lic-key-input'].value,'');f.emit('tli-session-locked');f.recover();f.handler(()=>({data:{...license,licensee:'Current owner'}}));await f.nodes['tli-lic-refresh-btn'].click();
  const count=f.calls.length;wait.resolve(outcome==='success'?{data:{valid:true,tier:'pro'}}:{status:Number(outcome),data:{detail:'OLD PRIVATE DETAIL'}});await pending;
  assert.equal(f.nodes['tli-lic-licensee'].textContent,'Current owner');assert.equal(f.nodes['tli-lic-activate-btn'].disabled,false);assert.equal(f.calls.length,count);
});

test('license activation and removal share one pending barrier and removal rereads effective BETA access',async()=>{
  const f=fixture({script:'settings_enhanced.js'});await f.boot();const wait=deferred();f.handler(url=>url==='/license/details'?{data:license}:wait.promise);
  const pending=f.nodes['tli-lic-deactivate-btn'].click();f.nodes['tli-lic-key-input'].value='OTHER';await f.nodes['tli-lic-activate-btn'].fire('click');await f.nodes['tli-lic-deactivate-btn'].fire('click');
  assert.equal(f.calls.filter(c=>c.options.method==='DELETE'||c.options.method==='POST').length,1);wait.resolve({data:{tier:'free',valid:false,message:'License removed'}});await pending;
  assert.equal(f.nodes['tli-lic-tier-badge'].textContent,'BETA');assert.equal(f.nodes['tli-lic-licensee'].textContent,'Beta');assert.match(f.nodes['tli-lic-msg'].textContent,/Saved license key removed/);
});

test('failed license details replace stale private display without inventing Free status',async()=>{
  const f=fixture({script:'settings_enhanced.js'});await f.boot();f.handler(()=>({status:503,data:{detail:'Saved license needs recovery'}}));await f.nodes['tli-lic-refresh-btn'].click();
  assert.equal(f.nodes['tli-lic-tier-badge'].textContent,'Unavailable');assert.equal(f.nodes['tli-lic-licensee'].textContent,'');assert.match(f.nodes['tli-lic-msg'].textContent,/needs recovery/);
});

test('unpaired Companion keeps a fragment invitation through its desktop handoff without a request',async()=>{
  const f=fixture({script:'js/companion.js',href:invitation.url});await f.boot();assert.deepEqual(f.replaced,['/?desktop=1#join=satellite&token='+token]);assert.equal(f.calls.length,0);
});

test('an uncertain activation clears the submitted key and sends no retry or automatic recovery read',async()=>{
  const f=fixture({script:'settings_enhanced.js'});await f.boot();f.nodes['tli-lic-key-input'].value='PRIVATE KEY';const before=f.calls.length;
  f.handler(()=>{throw new Error('Response lost');});await f.nodes['tli-lic-activate-btn'].click();
  assert.equal(f.nodes['tli-lic-key-input'].value,'');assert.match(f.nodes['tli-lic-msg'].textContent,/Activation not confirmed.*No retry/);assert.equal(f.calls.length,before+1);
});

test('verified readiness refreshes visible private lists once and never generates tokens or changes a license',async()=>{
  for(const script of ['js/satellite.js','settings_enhanced.js']){
    const f=fixture({script});await f.boot();f.nodes[script.includes('satellite')?'panel-mesh':'panel-settings'].hidden=false;
    f.emit('tli-session-locked');const count=f.calls.length;f.emit('tli-session-unlocked',{source:'pin-verification'});assert.equal(f.calls.length,count);
    f.emit('tli-private-observation-ready');f.emit('tli-private-observation-ready');await tick();
    assert.equal(f.calls.length,count+1);assert.ok(f.calls.every(call=>!call.options.method));
  }
});

test('an old satellite list cannot repopulate or erase current session cards',async()=>{
  const wait=deferred(),f=fixture({handler:()=>wait.promise});await f.boot();const old=f.list();await tick();
  f.emit('tli-session-locked');f.recover();f.handler(()=>({data:{satellites:[{...satellite,name:'Current phone'}]}}));await f.list();
  wait.resolve({data:{satellites:[{...satellite,name:'Old private phone'}]}});await old;
  assert.match(f.nodes['mcd-sat-grid'].children[0].innerHTML,/Current phone/);assert.doesNotMatch(f.nodes['mcd-sat-grid'].children[0].innerHTML,/Old private/);
});
