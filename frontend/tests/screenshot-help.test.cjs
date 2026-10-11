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
  const nodes = {}, calls = [], docHandlers = {}, windowHandlers = {};
  let context = {};
  function element(tag) {
    const n = {tag, children:[], handlers:{}, value:'', hidden:false, disabled:false, src:'', attributes:{}, isConnected:true,
      setAttribute(k,v){this.attributes[k]=v;},
      append(...items){this.children.push(...items);}, after(n){nodes.after=n;},
      replaceChildren(...items){this.children = items;},
      addEventListener(k,fn){(this.handlers[k] ||= []).push(fn);},
      fire(k){return Promise.all((this.handlers[k]||[]).map(fn=>fn({})));},
      click(){return this.fire('click');}, showModal(){this.open=true;}, close(){this.open=false;this.fire('close');}, focus(){ctx.document.activeElement=this;} };
    let ownText='';
    Object.defineProperty(n,'textContent',{get(){return ownText+this.children.map(c=>c.textContent||'').join('');},set(value){ownText=String(value);this.children=[];}});
    Object.defineProperty(n,'id',{set(id){nodes[id]=this;},get(){return Object.keys(nodes).find(k=>nodes[k]===this);}});
    return n;
  }
  for(const id of ['chat-image-preview','chat-image-thumb','chat-image-input','actions']) nodes[id]=element('div');
  nodes['chat-image-thumb'].src='data:image/png;base64,local-only';
  const ctx = vm.createContext({console,Date,AbortController,TextDecoder,setTimeout,clearTimeout,
    document:{readyState:'complete',createElement:element,getElementById:id=>nodes[id]||null,
      querySelector:()=>nodes.actions,addEventListener:(k,fn)=>(docHandlers[k]||=[]).push(fn)},
    window:{addEventListener:(k,fn)=>(windowHandlers[k]||=[]).push(fn),TLIIntelligence:{getContext:()=>context,clearReport:()=>{context={...context,diagnostic_id:null};}}},
    fetch:async(url,options)=>{calls.push({url,options});const body=await handler(); return {ok:!body.httpError,json:async()=>body};},
  });
  vm.runInContext(source,ctx);
  return {nodes,calls,ctx,docHandlers,windowHandlers,emit:name=>(windowHandlers[name]||[]).forEach(fn=>fn()),api:ctx.window.TLIScreenshots,context:value=>{context=value;},element,
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
  await f.nodes['screenshot-enlarge'].click();
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

test('reader task token belongs to the successful attachment; failed replacement keeps prior scope',async()=>{
  const f=fixture();await f.attach();f.nodes['screenshot-computer'].value='node-peer';
  f.api.chooseImage();const token=f.api.attachmentReadStarted();assert.equal(token,'image');
  f.api.attachmentReadFailed();assert.equal(f.nodes['screenshot-task'].value,'explain');
  assert.equal(f.api.requestContext({}).screenshot.target_id,'node-peer');
  f.api.prepareTask('error');const errorToken=f.api.attachmentReadStarted();
  f.api.prepareTask('next_step');f.api.attachmentChanged({name:'Second.png'},errorToken);await tick();
  assert.equal(f.nodes['screenshot-task'].value,'error');assert.equal(f.api.requestContext({}).screenshot.target_id,null);
});

test('cancelled picker does not change current guidance or next ordinary attachment mode',async()=>{
  const f=fixture();await f.attach();f.api.chooseScreenshot('next_step');await f.nodes['chat-image-input'].fire('cancel');
  assert.equal(f.nodes['screenshot-task'].value,'explain');assert.equal(f.api.attachmentReadStarted(),'image');
});

test('duplicate sharing review clicks create only one pending request',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>finish=resolve));await f.attach();
  await f.nodes['screenshot-recheck'].click();await f.nodes['screenshot-recheck'].click();assert.equal(f.calls.length,1);
  finish(data());await tick();assert.equal(f.nodes['screenshot-recheck'].disabled,false);
});

for(const event of ['tli-session-locked','pagehide'])test(event+' invalidates a late provider response and clears private review',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>finish=resolve));await f.attach();f.emit(event);
  assert.equal(f.calls[0].options.signal.aborted,true);finish(data());await tick();
  assert.equal(f.nodes['screenshot-help'].hidden,true);assert.equal(f.nodes['screenshot-filename'].textContent,'');
  assert.equal(f.nodes['screenshot-sharing'].textContent,'');assert.equal(f.nodes['screenshot-computer'].children.length,1);
  assert.throws(()=>f.api.requestContext({}),/Unlock/);f.emit('tli-session-unlocked');assert.equal(f.calls.length,1);
  assert.equal(f.api.requestContext({}).screenshot,undefined);
});

test('lock closes preview without restoring private focus; ordinary close restores preview invoker',async()=>{
  const f=fixture();await f.attach();await f.nodes['screenshot-enlarge'].click();f.nodes['screenshot-preview-dialog'].close();
  assert.equal(f.ctx.document.activeElement,f.nodes['screenshot-enlarge']);
  await f.nodes['screenshot-enlarge'].click();f.ctx.document.activeElement=null;f.emit('tli-session-locked');
  assert.equal(f.nodes['screenshot-preview-dialog'].open,false);assert.equal(f.nodes['screenshot-preview-image'].src,'');assert.equal(f.ctx.document.activeElement,null);
});

test('background closes preview and invalidates pending review without replacing an attachment',async()=>{
  let finish;const f=fixture();await f.attach();await f.nodes['screenshot-enlarge'].click();
  f.ctx.document.hidden=true;for(const fn of f.docHandlers.visibilitychange)fn();
  assert.equal(f.nodes['screenshot-preview-dialog'].open,false);assert.equal(f.nodes['screenshot-help'].hidden,false);
  assert.ok(f.api.requestContext({}).screenshot.provider_key);
  const delayed=fixture(()=>new Promise(resolve=>finish=resolve));await delayed.attach();delayed.ctx.document.hidden=true;
  for(const fn of delayed.docHandlers.visibilitychange)fn();finish(data());await tick();
  assert.match(delayed.nodes['screenshot-sharing'].textContent,/paused/);assert.throws(()=>delayed.api.requestContext({}),/Recheck/);
});

test('disappeared selected computer is retained as unavailable until an explicit alternative is chosen',async()=>{
  let current=data();const f=fixture(async()=>current);await f.attach();f.nodes['screenshot-computer'].value='node-peer';
  current={...data(),computers:[data().computers[0]]};await f.nodes['screenshot-recheck'].click();
  assert.equal(f.nodes['screenshot-computer'].value,'node-peer');assert.match(f.nodes['screenshot-scope-summary'].textContent,/Work laptop.*unavailable/);
  assert.throws(()=>f.api.requestContext({}),/no longer available/);
  f.nodes['screenshot-computer'].value='';await f.nodes['screenshot-computer'].fire('change');assert.equal(f.api.requestContext({}).screenshot.target_id,null);
});

test('duplicate names expose distinct computer identities and malformed duplicate IDs are rejected',async()=>{
  const value=data();value.computers.forEach(c=>c.name='Computer');const f=fixture(async()=>value);await f.attach();
  const choices=f.nodes['screenshot-computer'].children.filter(n=>n.value.startsWith('node-'));
  assert.match(choices[0].textContent,/node-host/);assert.match(choices[1].textContent,/node-peer/);
  value.computers.push({...value.computers[0]});await f.nodes['screenshot-recheck'].click();assert.throws(()=>f.api.requestContext({}),/Recheck/);
});

test('malformed and oversized sharing fields cannot become a ready provider',async()=>{
  for(const mutate of [d=>({...d,computers:{}}),d=>({...d,computers:Array(513).fill(d.computers[0])}),d=>({...d,host:null}),d=>({...d,checked_at:'invalid'}),
    d=>({...d,provider:{...d.provider,key:'wrong'}}),d=>({...d,provider:{...d.provider,port:70000}}),d=>({...d,provider:{...d.provider,destination:'x'.repeat(254)}}),d=>({...d,provider:null,reason:null})]) {
    const f=fixture(async()=>mutate(data()));await f.attach();assert.throws(()=>f.api.requestContext({}),/Recheck/);assert.match(f.nodes['screenshot-sharing'].textContent,/incomplete/);
  }
});

test('unavailable vision offers model-library navigation without changing model or sending image',async()=>{
  const f=fixture(async()=>({...data(),provider:null,reason:'No image-capable provider is configured.'}));let opens=0;f.ctx.window.tliOpenModelManagerModal=()=>opens++;
  await f.attach();assert.equal(f.nodes['screenshot-models'].hidden,false);await f.nodes['screenshot-models'].click();
  assert.equal(opens,1);assert.equal(f.calls.length,1);assert.match(f.nodes['screenshot-sharing'].textContent,/unavailable/);assert.throws(()=>f.api.requestContext({}),/No image-capable/);
});

test('scope summary follows explicit report changes even while details are collapsed',async()=>{
  const f=fixture();await f.attach();assert.equal(f.nodes['screenshot-details'].open,false);
  f.context({diagnostic_id:'report',retention_days:7});f.emit('tli-chat-context-changed');
  assert.match(f.nodes['screenshot-scope-summary'].textContent,/Saved report attached/);assert.match(f.nodes['screenshot-retention'].textContent,/7 day/);
  assert.match(f.nodes['screenshot-boundary'].textContent,/Saved notes and earlier chat are not shared/);
});

test('valid next-screen receipt action opens only the picker and leaves the written draft untouched',async()=>{
  const f=fixture(),bubble=f.element('div');let picks=0;f.nodes['chat-image-input'].handlers.click=[()=>picks++];f.nodes['chat-input']={value:'Keep this exact draft'};
  f.api.annotateReply(bubble,{screenshot_context:receipt()});const button=bubble.children[0].children.find(n=>n.tag==='button');
  assert.equal(button.textContent,'Share the next screen');await button.click();assert.equal(picks,1);assert.equal(f.calls.length,0);assert.equal(f.nodes['chat-input'].value,'Keep this exact draft');assert.equal(f.api.attachmentReadStarted(),'error');
  f.emit('tli-session-locked');await button.click();assert.equal(picks,1);
});

test('bounded review timeout enables explicit retry and ignores a later completion',async()=>{
  let finish,timeout;const f=fixture(()=>new Promise(resolve=>finish=resolve));f.ctx.setTimeout=(fn,ms)=>{assert.equal(ms,15000);timeout=fn;return 1;};f.ctx.clearTimeout=()=>{};
  await f.attach();timeout();assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.nodes['screenshot-recheck'].disabled,false);
  assert.match(f.nodes['screenshot-sharing'].textContent,/timed out/);finish(data());await tick();assert.throws(()=>f.api.requestContext({}),/Recheck/);
});

test('oversized streamed review is cancelled and cannot make a provider ready',async()=>{
  const f=fixture();let reads=0,cancelled=0,released=0;
  f.ctx.fetch=async()=>({ok:true,body:{getReader:()=>({read:async()=>{reads++;return{done:false,value:new Uint8Array(300000)};},cancel:async()=>cancelled++,releaseLock:()=>released++})}});
  await f.attach();assert.equal(reads,2);assert.equal(cancelled,1);assert.equal(released,1);assert.match(f.nodes['screenshot-sharing'].textContent,/too large/);assert.throws(()=>f.api.requestContext({}),/Recheck/);
});

test('chunked UTF-8 review preserves names; malformed JSON stays unavailable',async()=>{
  const f=fixture();let index=0;const value=data();value.computers[0].name='Écran';const bytes=new TextEncoder().encode(JSON.stringify(value)),split=bytes.indexOf(195)+1;
  f.ctx.fetch=async()=>({ok:true,body:{getReader:()=>({read:async()=>index++===0?{done:false,value:bytes.slice(0,split)}:index===2?{done:false,value:bytes.slice(split)}:{done:true},releaseLock(){}})}});
  await f.attach();assert.match(f.nodes['screenshot-computer'].children[1].textContent,/Écran/);
  f.ctx.fetch=async()=>({ok:true,text:async()=>'{bad JSON'});await f.nodes['screenshot-recheck'].click();assert.match(f.nodes['screenshot-sharing'].textContent,/incomplete/);assert.throws(()=>f.api.requestContext({}),/Recheck/);
});

test('recheck preserves a later explicit computer or Unknown choice instead of restoring its initial scope',async()=>{
  for(const selected of ['node-peer','']) {
    let finish,wait=false;const f=fixture(()=>wait?new Promise(resolve=>finish=resolve):Promise.resolve(data()));await f.attach();
    f.nodes['screenshot-computer'].value='node-host';wait=true;const pending=f.nodes['screenshot-recheck'].click();
    f.nodes['screenshot-computer'].value=selected;await f.nodes['screenshot-computer'].fire('change');
    finish(data());await pending;assert.equal(f.nodes['screenshot-computer'].value,selected);assert.equal(f.api.requestContext({}).screenshot.target_id,selected||null);
  }
});
