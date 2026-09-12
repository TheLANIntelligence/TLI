const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = fs.readFileSync(path.join(__dirname, '../js/screenshot-help.js'), 'utf8');
const data = () => ({ host: {id:'host',name:'Office'}, computers: [{id:'node-host',node_id:'host',name:'Office'},
  {id:'node-peer',node_id:'peer',name:'Work laptop'}], provider: {key:'a'.repeat(64),provider:'lmstudio',model:'fixture-vision',
    destination:'192.0.2.8',port:1234,note:'Advertised; vision is user-confirmed.'}, checked_at:'2026-09-06T12:00:00Z' });
const receipt = () => ({ task:'error', computer:{name:'Work laptop',node_id:'peer'}, report_id:'saved-report',
  capture:'user_shared_snapshot',actions_performed:false });
function fixture(handler = async () => data()) {
  const nodes = {}, calls = [], docHandlers = {};
  let context = {};
  function element(tag) {
    const n = {tag, children:[], handlers:{}, textContent:'', value:'', hidden:false, disabled:false, src:'', attributes:{},
      setAttribute(k,v){this.attributes[k]=v;},
      append(...items){this.children.push(...items);}, after(n){nodes.after=n;},
      replaceChildren(...items){this.children = items;},
      addEventListener(k,fn){(this.handlers[k] ||= []).push(fn);},
      fire(k){return Promise.all((this.handlers[k]||[]).map(fn=>fn({})));},
      click(){return this.fire('click');}, showModal(){this.open=true;}, close(){this.open=false;this.fire('close');} };
    Object.defineProperty(n,'id',{set(id){nodes[id]=this;},get(){return Object.keys(nodes).find(k=>nodes[k]===this);}});
    return n;
  }
  for(const id of ['chat-image-preview','chat-image-thumb','chat-image-input','actions']) nodes[id]=element('div');
  nodes['chat-image-thumb'].src='data:image/png;base64,local-only';
  const ctx = vm.createContext({console,Date,
    document:{readyState:'complete',createElement:element,getElementById:id=>nodes[id]||null,
      querySelector:()=>nodes.actions,addEventListener:(k,fn)=>(docHandlers[k]||=[]).push(fn)},
    window:{TLIIntelligence:{getContext:()=>context,clearReport:()=>{context={...context,diagnostic_id:null};}}},
    fetch:async(url,options)=>{calls.push({url,options});const body=await handler(); return {ok:!body.httpError,json:async()=>body};},
  });
  vm.runInContext(source,ctx);
  return {nodes,calls,ctx,docHandlers,api:ctx.window.TLIScreenshots,context:value=>{context=value;},element,
    attach:async()=>{await nodes['screenshot-start'].click();ctx.window.TLIScreenshots.attachmentChanged({name:'Example screenshot.png'});await tick();}};
}

test('guidance starts only with a chosen file and review never uploads it', async()=>{
  const f=fixture(); assert.equal(f.calls.length,0); assert.equal(f.nodes['screenshot-help'].hidden,true);
  await f.attach();
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].url,'/api/intelligence/screenshots/context');
  assert.equal(f.calls[0].options.body,undefined);
  assert.equal(f.nodes['screenshot-task'].value,'explain'); assert.equal(f.nodes['screenshot-computer'].value,'');
  assert.match(f.nodes['screenshot-sharing'].textContent,/lmstudio.*192.0.2.8:1234/);
  assert.match(f.nodes['screenshot-retention'].textContent,/not retain/);
  assert.match(f.api.defaultPrompt(),/Explain this screen/);
});

test('generic image questions keep their existing context',async()=>{
  const f=fixture(); f.api.chooseImage(); f.api.attachmentChanged({name:'Photo.png'}); await tick();
  const original={target_id:'printer',diagnostic_id:'report',retention_days:7};
  assert.equal(f.nodes['screenshot-task'].value,'image');
  const request=f.api.requestContext(original);
  assert.equal(request.target_id,original.target_id);assert.equal(request.diagnostic_id,original.diagnostic_id);
  assert.equal(request.retention_days,7);assert.equal(request.screenshot,undefined);
  assert.equal(request.image_provider_key,data().provider.key);
});

test('screenshot scope is explicit and never inherits a phone or printer identity',async()=>{
  const f=fixture(); await f.attach();
  const original={target_id:'printer',device_id:'phone',diagnostic_id:null,retention_days:0};
  let request=f.api.requestContext(original);
  assert.equal(request.target_id,null); assert.equal(request.screenshot.target_id,null); assert.equal(request.device_id,'phone');
  f.nodes['screenshot-computer'].value='node-peer'; f.nodes['screenshot-task'].value='next_step';
  request=f.api.requestContext(original);
  assert.equal(request.screenshot.target_id,'node-peer');assert.equal(request.screenshot.task,'next_step');
  f.nodes['screenshot-computer'].value='node-host';
  assert.equal(request.screenshot.target_id,'node-peer','A request snapshots its subject');
});

test('an unregistered computer is a bounded user label and can be left unknown',async()=>{
  const f=fixture(); await f.attach(); f.nodes['screenshot-computer'].value='other';
  await f.nodes['screenshot-computer'].fire('change');
  assert.equal(f.nodes['screenshot-other-wrap'].hidden,false);assert.equal(f.nodes['screenshot-other'].maxLength,120);
  f.nodes['screenshot-other'].value='  Work PC  ';
  const request=f.api.requestContext({}); assert.equal(request.screenshot.other_computer,'Work PC');assert.equal(request.screenshot.target_id,null);
});

test('checking, unavailable and failed sharing details block guided sends',async()=>{
  for(const handler of [async()=>({...data(),provider:null,reason:'Vision unavailable'}),async()=>{throw new Error('Offline');}]) {
    const f=fixture(handler);await f.attach();
    assert.throws(()=>f.api.requestContext({}),/Vision unavailable|Recheck/);
    assert.equal(f.calls.length,1);assert.equal(f.nodes['screenshot-recheck'].disabled,false);
  }
  let finish;
  const f=fixture(()=>new Promise(resolve=>finish=resolve));await f.attach();
  assert.throws(()=>f.api.requestContext({}),/Recheck/);finish(data());await tick();
  assert.ok(f.api.requestContext({}).screenshot.provider_key);
});

test('explicit recheck invalidates the old provider and uses the new review key',async()=>{
  let current=data();const f=fixture(async()=>current);await f.attach();
  current={...data(),provider:{...data().provider,key:'b'.repeat(64)}};
  const checking=f.nodes['screenshot-recheck'].click();
  assert.throws(()=>f.api.requestContext({}),/Recheck/);
  await checking;assert.equal(f.api.requestContext({}).screenshot.provider_key,'b'.repeat(64));
});

test('removing or replacing an attachment invalidates pending review and prior scope',async()=>{
  const finishes=[];const f=fixture(()=>new Promise(resolve=>finishes.push(resolve)));
  await f.attach();f.api.attachmentChanged(null);finishes[0](data());await tick();
  assert.equal(f.nodes['screenshot-help'].hidden,true); assert.equal(f.api.requestContext({}).screenshot,undefined);
  await f.attach();finishes[1](data());await tick();
  f.nodes['screenshot-computer'].value='node-peer'; f.api.attachmentChanged(null);
  await f.attach();finishes[2](data());await tick();
  assert.equal(f.nodes['screenshot-computer'].value,'');
});

test('report and retention choices are disclosed and an attached report can be cleared',async()=>{
  const f=fixture();f.context({diagnostic_id:'report',retention_days:7});await f.attach();
  assert.match(f.nodes['screenshot-report'].textContent,/must measure the chosen computer/);
  assert.match(f.nodes['screenshot-retention'].textContent,/7 day/);
  const clear=f.nodes['screenshot-scope'].children.find(n=>n.tag==='button');await clear.click();
  assert.match(f.nodes['screenshot-report'].textContent,/No report attached/);
});

test('enlarged preview stays local and clears its image when removed',async()=>{
  const f=fixture();await f.attach();
  const body=f.nodes['screenshot-help'].children.find(n=>n.tag==='div');
  await body.children.find(n=>n.textContent==='Enlarge preview').click();
  const dialog=f.nodes['screenshot-preview-dialog'];assert.equal(dialog.open,true);
  const image=dialog.children.find(n=>n.tag==='img');assert.match(image.src,/local-only/);
  f.api.attachmentChanged(null);assert.equal(dialog.open,false);assert.equal(image.src,'');assert.equal(f.calls.length,1);
});

test('guidance receipt keeps computer and no-action scope as inert text',()=>{
  const f=fixture(),bubble=f.element('div');
  f.api.annotateReply(bubble,{provider:'fixture',screenshot_context:{...receipt(),computer:{name:'<img onerror=alert(1)>'}}});
  assert.equal(bubble.children.length,1);assert.match(bubble.children[0].textContent,/<img.*No actions performed.*Attach the next screen/);
  assert.match(bubble.children[0].textContent,/Help with an error.*Saved report attached/);
  assert.equal(bubble.children[0].innerHTML,undefined);
});

test('legacy and malformed receipt metadata never invent a scoped confirmation',()=>{
  const f=fixture(),bubble=f.element('div');
  for(const screenshot_context of [undefined,{}, {...receipt(),actions_performed:true}, {...receipt(),computer:null},
    {...receipt(),task:'toString'}, {...receipt(),computer:{name:'x'.repeat(257)}}]) {
    assert.doesNotThrow(()=>f.api.annotateReply(bubble,{screenshot_context}));
  }
  assert.equal(bubble.children.length,0);
});

function restoredMessages() {
  return [{role:'user',content:'An earlier question'}, {role:'assistant',content:'An older answer'},
    {role:'assistant',content:'The screenshot shows an error.',provider:'lmstudio',model:'fixture-vision',screenshot_context:receipt()}];
}

test('reopening a desktop conversation renders the persisted screenshot receipt beside its original turn',async()=>{
  const f=fixture(), rendered=[], reads=[];
  f.nodes['chat-output']=f.element('div'); f.nodes['chat-input']={focus(){}};
  f.ctx.$=id=>f.nodes[id]; f.ctx.currentConversationId=null;
  f.ctx.appendMessage=(role,content)=>{const bubble=f.element('div');rendered.push({role,content,bubble});return bubble;};
  f.ctx.fetch=async url=>{reads.push(url);return {ok:true,json:async()=>({messages:restoredMessages()})};};
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const first=app.indexOf('async function loadConversation('), last=app.indexOf('function addPreviousPrompt',first);
  vm.runInContext(app.slice(first,last),f.ctx);
  await f.ctx.loadConversation('shared-photo','Screenshot question');
  assert.deepEqual(reads,['/api/ai/conversations/shared-photo']); assert.equal(f.ctx.currentConversationId,'shared-photo');
  assert.deepEqual(rendered.map(({role,content})=>({role,content})),restoredMessages().map(m=>({role:m.role==='user'?'user':'ai',content:m.content})));
  assert.equal(rendered[0].bubble.children.length,0);assert.equal(rendered[1].bubble.children.length,0);
  assert.match(rendered[2].bubble.children[0].textContent,/Help with an error.*Work laptop.*lmstudio \/ fixture-vision.*No actions performed/);
});

test('page restoration retains screenshot receipt while legacy chat context stays text only',async()=>{
  const f=fixture(),rendered=[],pending=[],reads=[];
  const output=f.element('div'); output.querySelector=()=>null; output.appendChild=n=>output.append(n);
  f.nodes['chat-output']=output;
  f.ctx.localStorage={getItem:()=> 'shared-photo',setItem(){},removeItem(){}};
  f.ctx.setTimeout=fn=>{pending.push(fn);};
  f.ctx.appendMessage=(role,content)=>{const bubble=f.element('div');rendered.push({role,content,bubble});return bubble;};
  f.ctx.fetch=async url=>{reads.push(url);return {ok:true,json:async()=>({messages:restoredMessages()})};};
  f.ctx.$=id=>f.nodes[id]; f.ctx.currentConversationId=null;
  Object.defineProperty(f.ctx,'chatHistory',{get:()=>f.ctx.window.chatHistory,set:value=>{f.ctx.window.chatHistory=value;}});
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const first=app.indexOf('async function loadConversation('),last=app.indexOf('function addPreviousPrompt',first);
  vm.runInContext(app.slice(first,last),f.ctx);f.ctx.window.loadConversation=f.ctx.loadConversation;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../chat_history.js'),'utf8'),f.ctx);
  for(const fn of f.docHandlers.DOMContentLoaded) fn();
  for(const fn of pending) await fn();
  assert.deepEqual(reads,['/api/ai/conversations/shared-photo']);
  assert.equal(rendered.length,3); assert.equal(rendered[1].bubble.children.length,0);
  assert.match(rendered[2].bubble.children[0].textContent,/Work laptop.*shared snapshot.*Attach the next screen/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.window.chatHistory)),restoredMessages().map(({role,content})=>({role,content})));
});
