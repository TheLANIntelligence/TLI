const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/builder-web-apps.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {resolve, promise}; };
function project(id='app_0123456789abcdef', revisions=1) {
  return {id, name:'Counter', status:'ready_for_preview', brief:'Build a counter', last_error:'', revisions:Array.from({length:revisions}, (_,index) => ({
    revision:index+1, summary:'A counter', backend:'local-fixture', validation:{checks:['Local files']},
    files:{'index.html':'<body>Counter</body>','style.css':'body {color: black}','app.js':"document.querySelector('button').onclick=()=>{};"},
    preview_html:'<html><head><title>Counter</title></head><body><button>Add</button><output>0</output></body></html>',
    checks:[{name:'Add works',steps:[{action:'click',selector:'button'},{action:'text',selector:'output',contains:'1'}]}], manual_checks:['Try Add twice.'],
  }))};
}
function fixture() {
  const ids = {}, events = {}, calls = [], frames = []; let handle;
  function element(tag='div') {
    let content='';
    const item={tag, children:[], parent:null, value:'', hidden:false, disabled:false, checked:false, attrs:{}, handlers:{},
      setAttribute(k,v){this.attrs[k]=v;}, getAttribute(k){return this.attrs[k];},
      append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}},
      insertBefore(n,before){n.parent=this;const i=this.children.indexOf(before);i<0?this.children.push(n):this.children.splice(i,0,n);},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);},
      addEventListener(type,fn){(this.handlers[type] ||= []).push(fn);},
      async fire(type){return Promise.all((this.handlers[type]||[]).map(fn=>fn({target:this})));},
      click(){return this.disabled?Promise.resolve():this.fire('click');}, focus(){}, scrollIntoView(){},
      querySelector(selector){return selector==='.builder-hero'?hero:null;},
    };
    Object.defineProperty(item,'id',{get(){return this._id;},set(v){this._id=v;ids[v]=this;}});
    Object.defineProperty(item,'textContent',{get(){return content+this.children.map(n=>n.textContent).join('');},set(v){content=String(v);this.children=[];}});
    if(tag==='iframe'){item.contentWindow={};frames.push(item);}
    return item;
  }
  const shell=element(),hero=element();shell.append(hero);
  let selected={peer_id:'peer',trust_revision:'t',resource_id:'r',resource_revision:'v'},generation=1;
  const ctx=vm.createContext({console,JSON,Set,Error,String,Number,Object,crypto:{randomUUID:()=> '12345678-abcd-1234-abcd-123456789012'},setTimeout,clearTimeout,
    document:{createElement:element,querySelector:()=>shell},
    window:{addEventListener:(name,fn)=>(events[name] ||= new Set()).add(fn),removeEventListener:(name,fn)=>events[name]?.delete(fn),
      TLILanInference:{capture:()=>({generation,selection:selected}),request:ticket=>ticket.selection,isCurrent:ticket=>ticket.generation===generation,display:()=>selected?{peer_name:'Gaming PC',label:'Loaded model'}:null}},
    fetch:async(url,options={})=>{calls.push({url,options});const result=handle?await handle(url,options):undefined;const value=result||{projects:[]};return {status:value.status||200,ok:!value.status||value.status<400,json:async()=>value.body||value};},
  });
  vm.runInContext(source,ctx);ctx.window.TLIWebApps.setup();
  function all(n=shell){return [n,...n.children.flatMap(child=>all(child))];}
  return {ids,calls,frames,ctx,api:ctx.window.TLIWebApps,shell,
    button:text=>all().find(n=>n.tag==='button'&&n.textContent===text),
    byClass:cls=>all().find(n=>n.className===cls),
    handle:fn=>handle=fn,
    event:async(name,event)=>Promise.all([...events[name]||[]].map(fn=>fn(event))),
    select:value=>{selected=value;},
    generation:()=>generation++,
    posts:()=>calls.filter(c=>c.options.method==='POST'),
  };
}

test('opening and preparing a brief never starts inference and never replaces an existing draft',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);
  assert.equal(f.api.prepareRequest('Build my timer'),true);
  assert.equal(f.api.prepareRequest('Replace it'),false);
  assert.equal(f.ids['builder-app-brief'].value,'Build my timer');
  await f.api.open();assert.equal(f.posts().length,0);
  assert.equal(f.ids['builder-app-brief'].value,'Build my timer');
});

test('workspace changes retain the same brief and app controllers without issuing requests',async()=>{
  const f=fixture(),brief=f.ids['builder-app-brief'];brief.value='Keep this design';
  await f.ids['builder-repository-mode'].click();
  assert.equal(f.shell.attrs['data-builder-workspace'],'repository');
  await f.ids['builder-small-app-mode'].click();
  assert.equal(f.shell.attrs['data-builder-workspace'],'apps');
  assert.equal(f.ids['builder-app-brief'],brief);assert.equal(brief.value,'Keep this design');
  assert.equal(f.calls.length,0);
});

test('build persists a displayed project, retains newer draft and requires an explicit preview',async()=>{
  const f=fixture(),pending=deferred();f.handle((url,options)=>options.method==='POST'?pending.promise:undefined);
  f.ids['builder-app-brief'].value='Original brief';
  const request=f.button('Build with local AI').click();await tick();
  f.ids['builder-app-brief'].value='Next app draft';pending.resolve({project:project()});await request;
  assert.equal(f.ids['builder-app-brief'].value,'Next app draft');
  assert.equal(f.frames.length,0);assert.match(f.byClass('builder-app-workspace').textContent,/Counter/);
  assert.equal(f.posts().length,1);assert.deepEqual(JSON.parse(f.posts()[0].options.body),{brief:'Original brief'});
  assert.equal(f.api.prepareRequest('Another app'),false);
});

test('failed generation preserves draft and saved recovery, then explicit retry carries revision',async()=>{
  const f=fixture();const failed={...project(),status:'needs_retry',last_error:'AI offline',revisions:[]};
  f.handle((url,options)=>options.method==='POST'?{project:failed}:undefined);
  f.ids['builder-app-brief'].value='Keep this';await f.button('Build with local AI').click();
  assert.equal(f.ids['builder-app-brief'].value,'Keep this');
  assert.match(f.byClass('builder-app-status').textContent,/AI offline/);
  f.handle((url,options)=>options.method==='POST'?{project:project()}:undefined);
  await f.button('Retry with local AI').click();
  assert.equal(JSON.parse(f.posts()[1].options.body).expected_revision,0);
  assert.equal(f.posts().length,2);
});

test('late older library selection cannot replace a newer selected app',async()=>{
  const f=fixture(),a=deferred(),b=deferred();
  f.handle(url=>url.endsWith('/a')?a.promise:url.endsWith('/b')?b.promise:undefined);
  f.ids['builder-app-library'].value='a';const first=f.ids['builder-app-library'].fire('change');await tick();
  f.ids['builder-app-library'].value='b';const second=f.ids['builder-app-library'].fire('change');await tick();
  b.resolve({project:{...project(),name:'Second app'}});await second;
  a.resolve({project:{...project(),name:'First app'}});await first;
  assert.match(f.byClass('builder-app-workspace').textContent,/Second app/);
  assert.doesNotMatch(f.byClass('builder-app-workspace').textContent,/First app/);
});

test('older displayed revisions cannot repair a newer revision implicitly',async()=>{
  const f=fixture();f.handle((url,options)=>options.method==='POST'?{project:project(undefined,2)}:undefined);
  f.ids['builder-app-brief'].value='Counter';await f.button('Build with local AI').click();
  const versions=f.byClass('builder-app-workspace').children[1].children[0];versions.value='1';await versions.fire('change');
  f.ids['builder-app-feedback'].value='Repair old behavior';await f.button('Repair / improve with local AI').click();
  assert.equal(f.posts().length,1);assert.match(f.byClass('builder-app-status').textContent,/latest saved version/);
});

test('sandbox preview loads only an owned immutable preview URL, without srcdoc inherited policy',async()=>{
  const f=fixture();f.handle((url,options)=>options.method==='POST'?{project:project()}:undefined);
  f.ids['builder-app-brief'].value='Counter';await f.button('Build with local AI').click();await f.button('Open isolated preview').click();
  const frame=f.frames[0];assert.equal(frame.attrs.sandbox,'allow-scripts');assert.equal(frame.attrs.referrerpolicy,'no-referrer');
  assert.match(frame.src,/^\/api\/builder\/web-apps\/app_0123456789abcdef\/preview\?revision=1&token=tli[a-f0-9]{32}$/);
  assert.equal(frame.srcdoc,undefined);
  assert.match(f.shell.textContent,/cannot guarantee zero network traffic/);
});

test('browser check ignores other windows and carries observed failures to repair',async()=>{
  const f=fixture();f.handle((url,options)=>options.method==='POST'?{project:project()}:undefined);
  f.ids['builder-app-brief'].value='Counter';await f.button('Build with local AI').click();
  const testing=f.button('Run browser checks').click();await tick();const frame=f.frames[0];
  const token=frame.src.match(/token=([^&]+)/)[1];assert.match(frame.src,/&check_index=0$/);
  await f.event('message',{source:{},data:{tliAppPreview:token,passed:true}});
  await f.event('message',{source:frame.contentWindow,data:{tliAppPreview:token,passed:false,error:'Expected 1, found 0'}});await testing;
  assert.match(f.byClass('builder-app-checks').textContent,/FAIL.*Expected 1, found 0/);
  await f.button('Repair / improve with local AI').click();
  assert.match(JSON.parse(f.posts()[1].options.body).feedback,/Observed browser check failures.*\nAdd works: Expected 1, found 0/);
});

for(const event of ['tli-session-locked','tli-user-changed','tli-account-changed','pagehide'])test(event+' clears private app state and ignores late generation',async()=>{
  const f=fixture(),pending=deferred();f.handle((url,options)=>options.method==='POST'?pending.promise:undefined);
  f.ids['builder-app-brief'].value='Private brief';const running=f.button('Build with local AI').click();await tick();
  await f.event(event);pending.resolve({project:project()});await running;
  assert.equal(f.ids['builder-app-brief'].value,'');assert.equal(f.byClass('builder-app-workspace').hidden,true);
  assert.equal(f.api.prepareRequest('Must not appear'),false);
});

test('LAN is opt-in and missing selection sends nothing',async()=>{
  const f=fixture();assert.equal(f.ids['builder-app-use-lan'].checked,false);
  f.ids['builder-app-use-lan'].checked=true;await f.ids['builder-app-use-lan'].fire('change');f.select(null);
  f.ids['builder-app-brief'].value='Counter';await f.button('Build with selected LAN model').click();
  assert.equal(f.posts().length,0);assert.match(f.byClass('builder-app-status').textContent,/Nothing was sent/);
});

test('LAN generation sends only explicitly selected resource and app content; stale selection result ignored',async()=>{
  const f=fixture(),pending=deferred();f.handle((url,options)=>options.method==='POST'?pending.promise:undefined);
  f.ids['builder-app-use-lan'].checked=true;await f.ids['builder-app-use-lan'].fire('change');
  f.ids['builder-app-brief'].value='Counter';const running=f.button('Build with selected LAN model').click();await tick();
  const sent=JSON.parse(f.posts()[0].options.body);assert.deepEqual(Object.keys(sent).sort(),['brief','lan_inference']);
  assert.equal(sent.lan_inference.peer_id,'peer');f.select({...sent.lan_inference,resource_id:'different'});
  pending.resolve({project:project()});await running;
  assert.equal(f.byClass('builder-app-workspace').hidden,true);assert.equal(f.ids['builder-app-brief'].value,'Counter');
  assert.match(f.byClass('builder-app-status').textContent,/selected computer or model changed/);
});
