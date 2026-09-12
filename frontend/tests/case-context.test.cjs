const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../js/case-context.js'),'utf8'), app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r)), plain=v=>JSON.parse(JSON.stringify(v));
const walk=n=>n?.children.flatMap(c=>[c,...walk(c)])||[], content=n=>[n?.textContent,...walk(n).map(c=>c.textContent)].join(' ');
const stamp='2026-09-08T12:00:00Z';
const reportScript=fs.readFileSync(path.join(__dirname,'../js/report-facts.js'),'utf8');
const reportLink=()=>({kind:'report',id:'report-one',revision:'e'.repeat(64),label:'Saved CPU report',availability:'current',linked_at:stamp});
const reportRow=()=>({...row(),evidence:[reportLink()]});
const facts=()=>({version:1,basis:'saved_report',report_id:'report-one',kind:'system',host:{id:'host',name:'Synthetic host'},target:null,process:null,recorded_at:stamp,started_at:null,finished_at:null,duration_seconds:null,requested_duration_seconds:null,status:'completed',status_label:'Check results recorded',recorded_samples:null,expected_samples:null,raw_samples_included:0,checks:[{id:'cpu',label:'Host CPU',status:'pass',detail:'25 percent at the recorded time',scope:'host'}],omitted_checks:0,measurements:[],limitations:['This is historical, not current health.']});
function reportMetadata(context){const m=metadata(context),r=m.case_context;r.evidence_links=context.case_ref.evidence_refs.map(p=>({...p,label:reportLink().label,availability:'current',message_index:null}));r.included_reports=[{id:'report-one',revision:reportLink().revision,handle:'R1',host_id:'host',target_id:null,recorded_at:stamp}];return{...m,evidence_context:{recorded_report:facts(),sources:[{handle:'R1',kind:'report',id:'report-one',revision:reportLink().revision,host_id:'host',target_id:null}]}};}
function reportFixture(){const f=fixture();vm.runInContext(reportScript,f.ctx);f.handler(async(url,options)=>url.endsWith('/capabilities')?envelope({case_context:'tli-case-context-v1',case_report_context:'tli-case-report-context-v1',max_case_reports:1}):url.endsWith('/context-review')?envelope({case_report_context:'tli-case-report-context-v1',...reportMetadata(JSON.parse(options.body))}):envelope({case:reportRow()}));return f;}
const row=()=>({id:'case-'+'a'.repeat(32),revision:'b'.repeat(64),title:'Printer case',symptom:'Pages stop halfway.',computer:null,status:'open',archived:false,updated_at:stamp,created_at:stamp,resolution:'Unconfirmed draft resolution',steps:[{id:'step-1',text:'Restart the router',status:'skipped',outcome:'Not done'},{id:'step-2',text:'Print a test',status:'tried',outcome:'Page stalled'}],evidence:[{kind:'note',id:'note-1',revision:'c'.repeat(64),label:'<script>inert link label</script>',availability:'unavailable',linked_at:stamp}]});
const envelope=extra=>({ok:true,protocol:'tli-cases-v1',actions_performed:false,checked_at:stamp,...extra});
function metadata(context){const ref=context.case_ref,r=row();return {case_context:{schema_version:1,id:r.id,revision:ref.revision,title:r.title,updated_at:stamp,computer_id:null,status:r.status,archived:false,steps:ref.step_ids.map(id=>({id,status:r.steps.find(s=>s.id===id)?.status||'planned'})),omitted_step_count:r.steps.length-ref.step_ids.length,resolution_included:ref.include_resolution,evidence_links:ref.evidence_refs.map(p=>({...p,label:r.evidence[0].label,availability:'unavailable',message_index:p.message_index??null})),omitted_link_count:r.evidence.length-ref.evidence_refs.length,linked_bodies_included:false,actions_performed:false}};}
function fixture(){
  const nodes={},events={},calls=[],dispatched=[],panels=[];let handler=async url=>envelope(url.endsWith('/capabilities')?{case_context:'tli-case-context-v1'}:{case:row()});
  function el(tag){const n={tag,children:[],handlers:{},textContent:'',value:'',checked:false,hidden:false,disabled:false,attributes:{},classList:{add(){},remove(){},toggle(){}},
    setAttribute(k,v){this.attributes[k]=v},append(...xs){this.children.push(...xs)},appendChild(x){this.append(x)},before(){},replaceChildren(...xs){this.children=xs},
    querySelector(q){return walk(this).find(n=>n.tag===q)||null},querySelectorAll(q){return walk(this).filter(n=>n.tag===q)},
    addEventListener(k,fn){(this.handlers[k]||=[]).push(fn)},fire(k){return Promise.all((this.handlers[k]||[]).map(f=>f({preventDefault(){}})))},click(){return this.disabled?Promise.resolve():this.fire('click')},focus(){},showModal(){this.open=true},close(){this.open=false}};
    Object.defineProperty(n,'id',{set(id){nodes[id]=this},get(){return Object.keys(nodes).find(k=>nodes[k]===this)}});return n;}
  for(const id of ['chat-input','new-chat-btn'])nodes[id]=el('input');
  const document={body:el('body'),readyState:'complete',hidden:false,createElement:el,getElementById:id=>nodes[id],querySelector:()=>el('div'),addEventListener:(name,fn)=>(events[name]||=[]).push(fn)};
  const window={addEventListener:(name,fn)=>(events[name]||=[]).push(fn),dispatchEvent:event=>{dispatched.push(event.type);(events[event.type]||[]).forEach(fn=>fn(event))},switchPanel:id=>panels.push(id),TLIIntelligence:{getContext:()=>({})}};
  const ctx=vm.createContext({window,document,console,Date,CustomEvent,AbortController,TextEncoder,TextDecoder,currentDeviceId:'fixture-browser',localStorage:{setItem(){assert.fail('No persistence')}},sessionStorage:{setItem(){assert.fail('No persistence')}},
    fetch:async(url,options={})=>{calls.push({url,options});const data=await handler(url,options);return{ok:!data._status,status:data._status||200,json:async()=>data}}});vm.runInContext(script,ctx);
  const api=window.TLICaseContext;
  return {ctx,window,document,nodes,calls,dispatched,panels,el,api,handler:f=>handler=f,
    button(text){const b=walk(document.body).find(n=>n.tag==='button'&&n.textContent===text);assert.ok(b,text);return b},
    async choose(label,checked=true){const wrap=walk(nodes['case-context-preview']).find(n=>n.tag==='label'&&content(n).includes(label));assert.ok(wrap,label);const input=wrap.querySelector('input');input.checked=checked;await input.fire('change')},
    async use(){nodes['case-context-ack'].checked=true;await nodes['case-context-ack'].fire('change');await nodes['case-context-use'].click()},
    async select(){await api.open(row());await this.choose('skipped:');await this.choose('inert link label');await this.use()},
    emit(name){window.dispatchEvent(new CustomEvent(name))}};
}

test('review performs only bounded authenticated reads; explicit choices attach no bodies or message',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.api.open(row());assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>!c.options.method&&!c.options.body));
  assert.throws(()=>f.api.requestContext({}),/Finish or cancel/);assert.equal(f.nodes['case-context-use'].disabled,true);
  assert.deepEqual(plain(f.api.describeContext()),[]);await f.choose('skipped:');await f.choose('inert link label');await f.use();
  const context=f.api.requestContext({});assert.deepEqual(plain(context.case_ref.step_ids),['step-1']);assert.equal(context.case_ref.include_resolution,false);assert.equal(context.case_ref.evidence_refs.length,1);
  assert.doesNotMatch(JSON.stringify(context),/symptom|Pages stop|Restart the router|Not done|resolution.*Unconfirmed/);assert.equal(f.calls.length,2);assert.deepEqual(f.panels,['panel-main']);
  assert.ok(walk(f.document.body).every(n=>n.innerHTML===undefined));
});

test('choosing another item invalidates acknowledgement and limits whole steps to eight',async()=>{
  const f=fixture(),r=row();r.steps=Array.from({length:10},(_,i)=>({id:'s'+i,text:'Step '+i,status:'planned',outcome:''}));f.handler(async url=>envelope(url.endsWith('/capabilities')?{case_context:'tli-case-context-v1'}:{case:r}));
  await f.api.open(r);for(let i=0;i<8;i++)await f.choose('planned: Step '+i);f.nodes['case-context-ack'].checked=true;await f.nodes['case-context-ack'].fire('change');
  await f.choose('planned: Step 8');assert.match(f.nodes['case-context-status'].textContent,/eight steps/);
  await f.choose('planned: Step 0',false);assert.equal(f.nodes['case-context-ack'].checked,false);assert.equal(f.nodes['case-context-use'].disabled,true);
});

test('failed refresh preserves review choices but cannot approve stale unverified data',async()=>{
  const f=fixture();await f.api.open(row());await f.choose('skipped:');f.handler(async()=>({_status:503}));await f.button('Reload saved case').click();
  f.nodes['case-context-ack'].checked=true;await f.nodes['case-context-ack'].fire('change');await f.nodes['case-context-use'].fire('click');assert.equal(f.nodes['case-context-use'].disabled,true);assert.deepEqual(plain(f.api.describeContext()),[]);
  assert.match(content(f.nodes['case-context-preview']),/Restart the router/);f.handler(async url=>envelope(url.endsWith('/capabilities')?{case_context:'tli-case-context-v1'}:{case:{...row(),revision:'d'.repeat(64)}}));
  await f.button('Reload saved case').click();assert.match(f.nodes['case-context-status'].textContent,/case changed/i);assert.equal(f.nodes['case-context-ack'].checked,false);await f.use();assert.equal(f.api.requestContext({}).case_ref.revision,'d'.repeat(64));
});

test('cancelled review cannot be attached by a queued hidden control event',async()=>{
  const f=fixture();await f.api.open(row());await f.choose('skipped:');f.nodes['case-context-ack'].checked=true;await f.nodes['case-context-ack'].fire('change');
  f.api.close();await f.nodes['case-context-use'].fire('click');assert.deepEqual(plain(f.api.describeContext()),[]);assert.equal(f.panels.length,0);
  await f.api.open(row());assert.equal(f.nodes['case-context-ack'].checked,false);await f.use();assert.deepEqual(plain(f.api.requestContext({}).case_ref.step_ids),['step-1']);
});

for(const field of [{note_refs:[{}]},{documents:[{}]},{target_id:'host'},{diagnostic_id:'report'},{screenshot:{}},{include_vault_secrets:true},{script_request:true}])test('selected cases reject other context without deleting it: '+Object.keys(field)[0],async()=>{
  const f=fixture();await f.select();assert.throws(()=>f.api.requestContext(field),/on its own/);assert.equal(f.api.describeContext().length,1);assert.ok(Object.values(field)[0]);
});

test('fresh capability is required for every send and late 401 cannot lock a replaced session',async()=>{
  const f=fixture();await f.select();const context=f.api.requestContext({});await f.api.ensureAvailable(context);assert.equal(f.calls.length,3);
  f.handler(async()=>envelope({case_context:'older'}));await assert.rejects(f.api.ensureAvailable(context),/does not support/);assert.equal(f.api.describeContext().length,1);
  let release;f.handler(()=>new Promise(r=>release=r));const pending=f.api.ensureAvailable(context);await tick();f.api.clear();release({_status:401});await assert.rejects(pending,/no longer current/);assert.equal(f.dispatched.includes('tli-session-locked'),false);
});

for(const mode of ['close','lock','background'])test('late review cannot repopulate after '+mode,async()=>{
  const f=fixture();let release;f.handler(()=>new Promise(r=>release=r));const pending=f.api.open(row());await tick();
  if(mode==='close')f.api.close();else if(mode==='lock')f.emit('tli-session-locked');else{f.document.hidden=true;f.emit('visibilitychange')}
  release(envelope({case_context:'tli-case-context-v1'}));await pending;assert.equal(f.calls.length,1);assert.deepEqual(plain(f.api.describeContext()),[]);assert.equal(f.nodes['case-context-dialog'].open,false);
});

test('malformed or mismatched confirmation retains selection; completed confirmation stays current for button cleanup',async()=>{
  const f=fixture();await f.select();const request=f.api.requestContext({}),meta=metadata(request);
  assert.throws(()=>f.api.sent(request,{case_context:{...meta.case_context,revision:'d'.repeat(64)}}),/did not confirm/);assert.equal(f.api.describeContext().length,1);
  f.api.sent(request,meta);assert.equal(f.api.describeContext().length,0);assert.equal(f.api.isCurrent(request),true);f.api.clear();assert.equal(f.api.isCurrent(request),false);
});

test('receipt shows omitted scope and unavailable links without source bodies or automatic requests',async()=>{
  const f=fixture();await f.select();const request=f.api.requestContext({}),meta=metadata(request),bubble=f.el('div'),count=f.calls.length;
  f.api.decorateReply(bubble,meta);f.api.decorateReply(bubble,meta);assert.equal(bubble.children.length,1);assert.match(content(bubble),/1 steps included, 1 omitted.*resolution excluded/s);assert.match(content(bubble),/unavailable when prepared.*body not supplied/s);assert.equal(f.calls.length,count);assert.ok(walk(bubble).every(n=>n.innerHTML===undefined));
});

for(const provider of ['bundled','lmstudio'])for(const failure of [false,true])test(`actual sendChat ${provider} ${failure?'retains conflict draft':'clears confirmed selection'} without search, mesh or duplicate send`,async()=>{
  const f=fixture();await f.select();const nodes=f.nodes,requests=[],bubbles=[];nodes['chat-input'].value='What should I consider next?';
  for(const id of ['chat-send-btn','abort-chat-btn','mode-select','temperature-input','max-tokens-input'])nodes[id]=f.el('input');nodes['mode-select'].value='default';nodes['temperature-input'].value='0.2';nodes['max-tokens-input'].value='512';let release;
  Object.assign(f.ctx,{_chatImageB64:null,_chatImageMime:null,_chatImageReadVersion:0,_chatImageReading:false,$:id=>nodes[id],showToast(){},tliSearchIsEnabled:()=>true,tliShouldGateForSearch:()=>assert.fail('No case search shortcut'),appendMessage:()=>{const b=f.el('div');bubbles.push(b);return b},
    resolveIntelligenceRoute:()=>new Promise(r=>release=r),IntelligenceSource:{LAN_LLM:'lan',NONE:'none'},lanAiChat:()=>assert.fail('No case mesh shortcut'),lastSendTs:0,readSettings:()=>({defaultBrain:provider}),isTeachingMode:()=>false,setModelStatus(){},debugLog(){},inFlightController:null,
    AIStatus:{local:{},lan:{available:true}},tliFetchBundledStatus:async()=>({ok:true}),currentConversationId:null,_currentPanelId:'panel-chat',buildContextWrappedMessage:({latestUserMessage})=>latestUserMessage,formatModelOutput:text=>text,
    tliBundledChatStream:async request=>{assert.equal(provider,'bundled');requests.push(request);if(failure)throw new Error('Case changed after review');request.onDelta('Selected case answer');request.onMeta(metadata(request));},
    fetch:async(url,options)=>{if(url==='/api/intelligence/cases/capabilities')return{ok:true,status:200,json:async()=>envelope({case_context:'tli-case-context-v1'})};assert.equal(url,'/chat');assert.equal(provider,'lmstudio');const body=JSON.parse(options.body);requests.push(body);return{ok:!failure,status:failure?409:200,json:async()=>failure?{detail:'Case changed after review'}:{reply:'Selected case answer',...metadata(body)}}},
    renderAssistantHTML:text=>text,_attachSpeakBtn(){},chatHistoryAdd(){},tliSpeak(){},saveConversation(){},addPreviousPrompt(){}});
  const first=app.indexOf('async function sendChat()'),last=app.indexOf('// Shelly Chat Helpers',first);vm.runInContext(app.slice(first,last),f.ctx);
  const running=f.ctx.sendChat();await f.ctx.sendChat();release({source:'lan',node:{}});await running;assert.equal(requests.length,1);assert.equal(nodes['chat-send-btn'].disabled,false);
  assert.equal(nodes['chat-input'].value,failure?'What should I consider next?':'');assert.equal(f.api.describeContext().length,failure?1:0);assert.equal(requests[0].case_ref.id,row().id);
  if(!failure)assert.match(content(bubbles[1]),/Case selection for this answer/);
});


test('report facts require explicit selection, backend preview and acknowledgement; no source bodies sent',async()=>{
  const f=reportFixture();await f.api.open(reportRow());assert.equal(f.calls.length,2);
  await f.choose('Recorded facts:');await tick();assert.equal(f.calls.length,3);assert.equal(f.nodes['case-context-ack'].checked,false);
  assert.match(content(f.nodes['case-context-preview']),/25 percent/);await f.use();
  const context=f.api.requestContext({});assert.deepEqual(plain(context.case_ref.report_refs),[{kind:'report',id:'report-one',revision:reportLink().revision}]);
  assert.doesNotMatch(JSON.stringify(context),/25 percent|measurements|checks|symptom/);
  f.api.sent(context,reportMetadata(context));assert.equal(f.api.describeContext().length,0);
});

test('report choice cannot attach until its exact identified facts are confirmed',async()=>{
  const f=reportFixture();await f.api.open(reportRow());f.handler(async()=>envelope({case_report_context:'tli-case-report-context-v1',case_context:metadata({case_ref:{...row(),step_ids:[],include_resolution:false,evidence_refs:[]}}).case_context,evidence_context:{recorded_report:facts()}}));
  await f.choose('Recorded facts:');await tick();await f.use();assert.equal(f.api.describeContext().length,0);assert.match(f.nodes['case-context-status'].textContent,/could not be confirmed/);
});

for(const end of ['close','lock','background'])test('late selected-report preview cannot restore after '+end,async()=>{
  const f=reportFixture();await f.api.open(reportRow());let release;f.handler(()=>new Promise(r=>release=r));const pending=f.choose('Recorded facts:');await tick();
  if(end==='close')f.api.close();else if(end==='lock')f.emit('tli-session-locked');else{f.document.hidden=true;f.emit('visibilitychange');}
  release(envelope({case_report_context:'tli-case-report-context-v1',...reportMetadata({case_ref:{...row(),step_ids:[],include_resolution:false,evidence_refs:[reportLink()],report_refs:[reportLink()]}})}));await pending;await tick();await f.use();assert.equal(f.api.describeContext().length,0);assert.equal(f.nodes['case-context-dialog'].open,false);
});

test('selection changes invalidate reviewed facts; mismatched final report keeps the selected context',async()=>{
  const f=reportFixture();await f.api.open(reportRow());await f.choose('Recorded facts:');await tick();await f.choose('skipped:');await f.use();assert.equal(f.api.describeContext().length,0);
  await f.button('Review selected report facts').click();await f.use();const request=f.api.requestContext({}),meta=reportMetadata(request);meta.evidence_context.recorded_report.host.id='another-host';
  assert.throws(()=>f.api.sent(request,meta),/did not confirm/);assert.equal(f.api.describeContext().length,1);
});

test('next-check purpose reuses explicit selections without attaching Chat or changing panel',async()=>{
  const f=fixture(),received=[];f.handler(async url=>envelope(url.endsWith('/capabilities')?{case_context:'tli-case-context-v1',next_check:'tli-case-next-check-v1'}:{case:row()}));
  await f.api.open(row(),{purpose:'next_check',current:()=>true,onReview:r=>received.push(plain(r))});
  assert.equal(f.nodes['case-context-use'].textContent,'Review next check');assert.match(f.nodes['case-context-purpose'].textContent,/does not run a check/);
  await f.choose('skipped:');await f.use();assert.equal(received.length,1);assert.deepEqual(received[0].step_ids,['step-1']);assert.deepEqual(plain(f.api.describeContext()),[]);assert.equal(f.panels.length,0);assert.equal(f.calls.length,2);
});

test('next-check purpose fails closed on old host and never invokes its callback after cancellation',async()=>{
  const f=fixture();let callbacks=0;await f.api.open(row(),{purpose:'next_check',onReview:()=>callbacks++});await f.use();
  assert.equal(f.calls.length,1);assert.match(f.nodes['case-context-status'].textContent,/does not support reviewed next-check/);assert.equal(callbacks,0);
  f.api.close();f.handler(async url=>envelope(url.endsWith('/capabilities')?{case_context:'tli-case-context-v1',next_check:'tli-case-next-check-v1'}:{case:row()}));
  await f.api.open(row(),{purpose:'next_check',onReview:()=>callbacks++});await f.choose('skipped:');f.nodes['case-context-ack'].checked=true;f.api.close();await f.nodes['case-context-use'].fire('click');assert.equal(callbacks,0);
});
