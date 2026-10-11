const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/intelligence.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const report={id:'report-one',kind:'system',created_at:'2026-09-07T12:00:00Z',host:{id:'host',name:'Office'},target:{id:'printer-one',name:'Studio printer'},scope:'Private scope',checks:[],findings:[{certainty:'observed',text:'Private finding'}],next_steps:[]};
function fixture(){
  const nodes={},all=[],calls=[],events={}; let respond;
  function element(tag){const n={tag,children:[],handlers:{},dataset:{},value:'',textContent:'',disabled:false,classList:{toggle(){}},
    append(...c){this.children.push(...c);},before(){},replaceChildren(...c){this.children=c;},setAttribute(){},focus(){this.focused=true;},
    addEventListener(type,fn){(this.handlers[type]||=[]).push(fn);},fire(type){return Promise.all((this.handlers[type]||[]).map(fn=>fn({})));}};
    Object.defineProperty(n,'id',{set(value){nodes[value]=this;}});all.push(n);return n;}
  for(const id of ['panel-reports','panel-settings','new-chat-btn','chat-input','chat-send-btn'])nodes[id]=element('div');
  const row=element('div');
  const ctx=vm.createContext({CustomEvent,Date,switchPanel(){},
    document:{readyState:'complete',createElement:element,getElementById:id=>nodes[id],querySelector:()=>row,
      querySelectorAll:selector=>all.filter(n=>selector==='[data-int-target]'?n.dataset.intTarget:(n.className||'').includes('tli-int-status'))},
    window:{addEventListener(type,fn){(events[type]||=[]).push(fn);},dispatchEvent(event){for(const fn of events[event.type]||[])fn(event);}},
    fetch:async(url,options)=>{calls.push({url,options});const result=respond?await respond(url,options):null;
      return{ok:!result?.status||result.status<400,status:result?.status||200,json:async()=>result?.body||result|| (url.endsWith('/devices')?{devices:[{id:'printer-one',name:'Studio printer',kind:'printer'}],node:{name:'Office'},scope:'Host'}:url.endsWith('/diagnostics')&&options.method==='GET'?{reports:[report]}:report)};},
  });
  vm.runInContext(source,ctx);
  const api=ctx.window.TLIIntelligence;
  const button=text=>[...all].reverse().find(n=>n.tag==='button'&&n.textContent===text);
  const open=async()=>{const d=nodes['panel-reports'].children[0];d.open=true;await d.fire('toggle');};
  const selectReport=async(attach=true)=>{await open();await all.find(n=>n.tag==='button'&&n.textContent.startsWith('Studio printer ·')).fire('click');if(attach)await button('Discuss this report in chat').fire('click');};
  return{ctx,api,nodes,all,calls,button,open,selectReport,respond:fn=>respond=fn,emit:type=>ctx.window.dispatchEvent(new CustomEvent(type))};
}
function reportDialogFixture(){
 const f=fixture(),create=f.ctx.document.createElement;
 f.ctx.document.body=create('body');f.ctx.document.activeElement=f.nodes['chat-input'];
 f.ctx.document.createElement=tag=>{const n=create(tag);if(tag==='dialog'){n.open=false;n.showModal=()=>{n.open=true;};n.close=()=>{n.open=false;n.fire('close');};}return n;};
 return f;
}
test('Discuss saved report requires explicit inclusion, one read, and preserves the written draft',async()=>{
 const f=reportDialogFixture();f.nodes['chat-input'].value='Keep this draft';
 await f.api.discussReport('report-one','New suggested question');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'GET');assert.equal(f.api.getContext().diagnostic_id,null);
 await f.button('Include report in Chat').fire('click');assert.equal(f.api.getContext().diagnostic_id,'report-one');assert.equal(f.nodes['chat-input'].value,'Keep this draft');assert.equal(f.calls.length,1);
});

test('a different returned report cannot replace the requested saved source or current reviewed dialog',async()=>{
 const f=reportDialogFixture();await f.api.openSavedReport('report-one');const dialog=f.nodes['tli-saved-report-dialog'],old=dialog.children;
 f.respond(()=>({...report,id:'different-report'}));
 await assert.rejects(f.api.openSavedReport('report-one'),/does not match the requested source/);
 assert.equal(dialog.children,old);assert.equal(f.api.getContext().diagnostic_id,null);assert.ok(f.calls.every(c=>c.options.method==='GET'));
});

test('diagnostic history navigation leaves a written draft and Chat evidence untouched until Discuss',async()=>{
  const f=fixture();f.nodes['chat-input'].value='Keep this question';const initial=JSON.stringify(f.api.getContext());
  await f.selectReport(false);
  assert.equal(JSON.stringify(f.api.getContext()),initial);assert.equal(f.nodes['chat-input'].value,'Keep this question');
  assert.ok(f.calls.every(c=>c.options.method==='GET'));
  const count=f.calls.length;await f.button('Discuss this report in chat').fire('click');
  assert.equal(f.api.getContext().diagnostic_id,'report-one');assert.equal(f.api.getContext().target_id,'printer-one');
  assert.equal(f.nodes['chat-input'].value,'Keep this question');assert.equal(f.calls.length,count);
});
test('Legacy host diagnostics never inherit the selected device and external probes require network kind',async()=>{
 const f=fixture();await f.selectReport();
 const kind=f.all.find(n=>n.tag==='select'&&n.children.some(c=>c.value==='system'));
 const external=f.all.find(n=>n.tag==='input'&&n.type==='checkbox');external.checked=true;
 for(const value of ['system','network','device']){kind.value=value;await f.button('Run read-only checks').fire('click');const body=JSON.parse(f.calls.filter(c=>c.options.method==='POST').at(-1).options.body);assert.equal(body.target_id,value==='device'?'printer-one':null);assert.equal(body.internet,value==='network');}
});
test('Dismissed or locked report review cannot attach a late saved report',async()=>{
 const f=reportDialogFixture();await f.api.discussReport('report-one');const include=f.button('Include report in Chat');f.nodes['tli-saved-report-dialog'].close();await include.fire('click');assert.equal(f.api.getContext().diagnostic_id,null);
 const pending=deferred();f.respond(()=>pending.promise);const loading=f.api.discussReport('report-one');f.emit('tli-session-locked');pending.resolve(report);await assert.rejects(loading,{name:'ContextExpiredError'});assert.equal(f.api.getContext().diagnostic_id,null);
});
test('lock clears diagnostic content, target, report and pending checks without claiming cancellation',async()=>{
  const f=fixture();await f.selectReport();const ticket=f.api.capture();const pending=deferred();
  f.respond((url,options)=>url.endsWith('/diagnostics')&&options.method==='POST'?pending.promise:null);
  const run=f.button('Run read-only checks').fire('click');
  f.emit('tli-session-locked');pending.resolve(report);await run;
  assert.equal(f.api.getContext().target_id,null);assert.equal(f.api.getContext().diagnostic_id,null);assert.equal(f.api.isCurrent(ticket),false);
  for(const n of f.all.filter(n=>['tli-int-report','tli-int-history'].includes(n.className)))assert.deepEqual(n.children,[]);
  const count=f.calls.length;await f.button('Run read-only checks').fire('click');assert.equal(f.calls.length,count);
  f.emit('tli-session-unlocked');assert.equal(f.api.isCurrent(ticket),false);assert.equal(f.api.describeContext().length,0);
});
test('a late inventory response cannot repopulate context after lock or start another history read',async()=>{
  const f=fixture(),pending=deferred();f.respond(url=>url.endsWith('/devices')?pending.promise:null);
  const loading=f.open();f.emit('tli-session-locked');pending.resolve({devices:[{id:'late',name:'Private late device'}],node:{name:'Private host'}});await loading;
  assert.equal(f.calls.length,1);assert.equal(f.api.describeContext().length,0);
  for(const n of f.all.filter(n=>n.dataset.intTarget))assert.equal(n.children.length,1);
});
for(const code of [401,403])test(`intelligence ${code} ${code===401?'expires and clears private context':'retains context because permission refusal is not session expiry'}`,async()=>{
  const f=fixture();await f.selectReport();const ticket=f.api.capture();f.respond(()=>({status:code,body:{detail:'Access refused'}}));
  await f.open();
  assert.equal(f.api.isCurrent(ticket),code!==401);assert.equal(f.api.getContext().diagnostic_id,code===401?null:'report-one');
});
test('a stale 401 cannot lock a newer unlocked context',async()=>{
  const f=fixture(),pending=deferred();f.respond(()=>pending.promise);const loading=f.open();
  f.emit('tli-session-locked');f.emit('tli-session-unlocked');const ticket=f.api.capture();
  pending.resolve({status:401,body:{detail:'Old session'}});await loading;
  assert.equal(f.api.isCurrent(ticket),true);
});
test('conversation replacement invalidates pending diagnostic results while leaving the server request alone',async()=>{
  const f=fixture();await f.selectReport();const pending=deferred();
  f.respond((url,options)=>options.method==='POST'?pending.promise:null);
  const run=f.button('Run read-only checks').fire('click');f.api.clearContext();pending.resolve(report);await run;
  assert.equal(f.api.getContext().diagnostic_id,null);assert.equal(f.api.getContext().target_id,null);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
  assert.equal(f.calls.filter(c=>c.options.method==='DELETE').length,0);
});
test('discussing a report preserves a newer draft and never sends a message',async()=>{
  const f=fixture();await f.selectReport();f.api.clearContext();f.nodes['chat-input'].value='Keep my typed question';
  await f.button('Discuss this report in chat').fire('click');
  assert.equal(f.nodes['chat-input'].value,'Keep my typed question');assert.equal(f.api.getContext().diagnostic_id,'report-one');
  assert.equal(f.calls.filter(c=>c.options.method!=='GET').length,0);
});
test('New chat clears target, report and image-retention choice but changes to next-question context do not invalidate an active answer',async()=>{
  const f=fixture();await f.selectReport();f.nodes['tli-image-retention'].value='7';const ticket=f.api.capture();
  f.api.removeContext('report:report-one');assert.equal(f.api.isCurrent(ticket),true);
  await f.nodes['new-chat-btn'].fire('click');assert.equal(f.api.isCurrent(ticket),false);
  assert.equal(f.api.getContext().target_id,null);assert.equal(f.api.getContext().diagnostic_id,null);assert.equal(f.api.getContext().retention_days,0);
});
for(const success of [true,false])test(`conversation ${success?'replacement clears':'load failure retains'} target/report after the history result is known`,async()=>{
  const pending=deferred(),input={value:'My unsent draft',focus(){}},send={disabled:false};let clears=0;
  const ctx=vm.createContext({window:{TLIConversationLoad:{generation:0},TLIIntelligence:{clearContext(){clears++;}},TLIMemory:{clear(){},decorateReply(){}},TLIDocuments:{clear(){}}},
    $:id=>id==='chat-input'?input:id==='chat-send-btn'?send:null,currentConversationId:'old',chatHistory:[],
    fetch:()=>pending.promise,showToast(){}});
  const start=app.indexOf('async function loadConversation('),end=app.indexOf('function addPreviousPrompt',start);vm.runInContext(app.slice(start,end),ctx);
  const loading=ctx.loadConversation('new','New');assert.equal(clears,0);pending.resolve({ok:success,status:503,json:async()=>({messages:[]})});
  assert.equal(await loading,success);assert.equal(clears,success?1:0);assert.equal(input.value,'My unsent draft');
});
