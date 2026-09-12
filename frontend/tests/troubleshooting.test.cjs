const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../js/troubleshooting.js'), 'utf8');
const stamp = '2026-09-08T12:00:00Z';
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = () => ({ id:'case-'+'a'.repeat(32),title:'Printer queue',symptom:'Stalled yesterday',computer:null,status:'open',archived:false,
  steps:[],evidence:[],resolution:'',created_at:stamp,updated_at:stamp,revision:'b'.repeat(64) });
const reply = data => ({ok:true,protocol:'tli-cases-v1',checked_at:stamp,actions_performed:false,...data});
function walk(n) { return n.children.flatMap(c=>[c,...walk(c)]); }
function fixture() {
  const nodes={},events={},calls=[]; let handler=async(url)=> url==='/api/intelligence/devices' ? {devices:[]} : reply({items:[row()],total:1});
  function el(tag) {
    const n={tag,children:[],textContent:'',value:'',hidden:false,disabled:false,dataset:{},handlers:{},attrs:{},className:'',
      append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},contains(n){return this===n||walk(this).includes(n)},setAttribute(k,v){this.attrs[k]=v},focus(){},
      addEventListener(k,f){(this.handlers[k]||=[]).push(f)},fire(k,e={}){return Promise.all((this.handlers[k]||[]).map(f=>f(e)))},click(){return this.disabled?Promise.resolve():this.fire('click')},
      querySelectorAll(selector){return walk(this).filter(n=>selector.split(',').map(s=>s.trim()).includes(n.tag))},
      querySelector(selector){return selector==='[data-case-chat-link]'?walk(this).find(n=>n.dataset.caseChatLink):null},
      classList:{toggle(){},contains(){return false}}};
    Object.defineProperty(n,'id',{get(){return this.ident},set(id){this.ident=id;nodes[id]=this}});return n;
  }
  nodes['troubleshooting-workspace']=el('section');nodes['panel-troubleshooting']=el('section');
  const doc={readyState:'complete',hidden:false,createElement:el,getElementById:id=>nodes[id],addEventListener:(k,f)=>(events[k]||=[]).push(f)};
  const win={addEventListener:(k,f)=>(events[k]||=[]).push(f),dispatchEvent:e=>(events[e.type]||[]).forEach(f=>f(e)),switchPanel:()=>{},TLINotebook:{open(){throw new Error('Unexpected note navigation')}}};
  const context=vm.createContext({document:doc,window:win,Date,URLSearchParams,crypto:webcrypto,CustomEvent:class{constructor(type){this.type=type}},
    fetch:async(url,options={})=>{calls.push({url,options});const data=await handler(url,options);return{ok:!data._status,status:data._status||200,json:async()=>data}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/guided-checks.js'),'utf8'),context);
  vm.runInContext(source,context);
  return {nodes,events,calls,doc,win,el,context,api:win.TLITroubleshooting,handler:f=>handler=f,
    button(text){return walk(nodes['troubleshooting-workspace']).find(n=>n.tag==='button'&&n.textContent===text)},
    fire:event=>Promise.all((events[event]||[]).map(f=>f()))};
}
async function fill(f) { await f.nodes['troubleshooting-new'].click(); for(const[key,value]of[['title','Wi-Fi stalls'],['symptom','Slow earlier today']]){f.nodes['troubleshooting-'+key].value=value;await f.nodes['troubleshooting-'+key].fire('input')} }

test('initialization and navigation perform only explicit bounded reads, never actions or attachments',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.api.onOpen();assert.equal(f.calls.length,2);
  assert.ok(f.calls.every(c=>!c.options.method||c.options.method==='GET'));
  assert.match(f.calls[0].url,/limit=50/);assert.equal(f.nodes['troubleshooting-list-time'].textContent.includes('Last completed load'),true);
  assert.equal(f.nodes['troubleshooting-symptom'].value,'');assert.equal(f.nodes['troubleshooting-computer'].value,'');
  assert.match(f.nodes['troubleshooting-save-state'].textContent,/not been saved/);
  const grid=walk(f.nodes['troubleshooting-workspace']).find(n=>n.className==='troubleshooting-grid');assert.equal(grid.children[0],f.nodes['troubleshooting-editor']);assert.equal(grid.children[1].className,'troubleshooting-browser');
  const privacy=walk(f.nodes['troubleshooting-workspace']).find(n=>n.className==='troubleshooting-privacy');assert.equal(privacy.tag,'details');assert.notEqual(privacy.open,true);assert.equal(privacy.children[0].textContent,'Privacy & account scope');assert.match(walk(privacy).map(n=>n.textContent).join(' '),/with the access PIN off, browser visitors share the local account/);

  const disclosure=walk(f.nodes['troubleshooting-workspace']).find(n=>n.className==='troubleshooting-find');assert.equal(disclosure.tag,'details');assert.equal(disclosure.children[0].textContent,'Find a saved problem');assert.ok(walk(disclosure).includes(f.nodes['troubleshooting-search']));assert.ok(!walk(disclosure).includes(f.nodes['troubleshooting-list']));
});

test('export hook requires a saved clean case and invalidates when the case view closes',async()=>{
  const f=fixture();await f.api.onOpen();f.handler(()=>reply({case:row()}));await f.api.open({id:row().id});let offered;
  f.win.TLICaseExport={open:(r,o)=>offered={r,o},close(){}};
  await f.button('Export…').click();assert.equal(offered.r.id,row().id);assert.equal(offered.o.current(),true);
  offered=null;f.nodes['troubleshooting-title'].value='Unsaved private draft';await f.nodes['troubleshooting-title'].fire('input');await f.button('Export…').click();
  assert.equal(offered,null);assert.match(f.nodes['troubleshooting-status'].textContent,/Save or discard/);assert.equal(f.nodes['troubleshooting-title'].value,'Unsaved private draft');
});

const checkHost={id:'host',name:'Studio',node_id:'synthetic-host'};
const checkOptions=()=>({ok:true,protocol:'tli-guided-checks-v1',checked_at:stamp,actions_performed:false,host:checkHost,computer_id:'host',options:[{
  id:'system',kind:'system',title:'Check host resources',detail:'A host sample only.',available:true,reason:'',target_id:null,internet:false,
  execution_host:checkHost,measured_target:checkHost,scope_revision:'c'.repeat(64)}]});
const checkReport=()=>({id:'report-one',kind:'system',created_at:stamp,host:checkHost,target:null,internet_checks:false,scope:'Measured on Studio; no repair.',checks:[{id:'cpu',label:'CPU',status:'pass',detail:'CPU was 0% in this sample.'}]});
async function chooseHost(f){f.nodes['troubleshooting-computer'].value='host';await f.nodes['troubleshooting-computer'].fire('change');}
async function settle(){for(let i=0;i<5;i++)await tick();}
test('guided navigation and review never run checks; forced duplicate run sends one reviewed request',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await chooseHost(f);let resolve;
  f.handler((url,o)=>url.includes('/diagnostics/options')?checkOptions():o.method==='POST'?new Promise(r=>resolve=r):reply({}));
  await f.button('Review available checks').click();await settle();assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  await f.button('Review this check').click();await settle();assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  const start=f.button('Run this check');await start.click();await settle();await start.fire('click');await settle();
  const runs=f.calls.filter(c=>c.url==='/api/intelligence/diagnostics'&&c.options.method==='POST');assert.equal(runs.length,1);
  const body=JSON.parse(runs[0].options.body);assert.equal(body.expected_host_id,'host');assert.equal(body.expected_scope,'c'.repeat(64));assert.equal(body.internet,false);
  resolve(checkReport());await settle();assert.ok(f.button('Add report link to this draft'));assert.equal(f.calls.filter(c=>c.url.includes('/evidence/review')).length,0);
});
test('failed replacement check preserves report and interrupted request never replays',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await chooseHost(f);let fail=false;
  f.handler((url,o)=>url.includes('/diagnostics/options')?checkOptions():url==='/api/intelligence/diagnostics'?(fail?{_status:503,detail:'Probe unavailable'}:checkReport()):reply({}));
  for(let i=0;i<2;i++){await f.button('Review available checks').click();await settle();await f.button('Review this check').click();await f.button('Run this check').click();await settle();fail=true;}
  assert.ok(f.button('Add report link to this draft'));assert.ok(walk(f.nodes['troubleshooting-workspace']).some(n=>n.textContent.includes('CPU was 0%')));
  const before=f.calls.filter(c=>c.options.method==='POST').length;f.api.onClose();await f.api.onOpen();await settle();assert.equal(f.calls.filter(c=>c.options.method==='POST').length,before);
});
test('late check result after lock cannot repopulate private report or draft',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await chooseHost(f);let resolve;
  f.handler((url)=>url.includes('/diagnostics/options')?checkOptions():new Promise(r=>resolve=r));
  await f.button('Review available checks').click();await settle();await f.button('Review this check').click();await f.button('Run this check').click();await settle();
  await f.fire('tli-session-locked');resolve(checkReport());await settle();assert.equal(f.button('Add report link to this draft'),undefined);
  assert.equal(walk(f.nodes['troubleshooting-editor']).some(n=>n.textContent.includes('CPU was 0%')),false);
});
test('successful check followed by failed case save says the report remains saved',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await chooseHost(f);
  f.handler((url,o)=>url.includes('/diagnostics/options')?checkOptions():url==='/api/intelligence/diagnostics'?checkReport():url.endsWith('/evidence/review')?reply({evidence:{kind:'report',id:'report-one',revision:'d'.repeat(64),label:'Synthetic observation'}}):{_status:409,detail:'Changed in another view'});
  await f.button('Review available checks').click();await settle();await f.button('Review this check').click();await f.button('Run this check').click();await settle();
  await f.button('Add report link to this draft').click();await settle();await f.nodes['troubleshooting-save'].click();
  assert.match(f.nodes['troubleshooting-status'].textContent,/Report saved; problem link not saved/);assert.equal(f.nodes['troubleshooting-title'].value,'Wi-Fi stalls');
  assert.equal(f.calls.filter(c=>c.url==='/api/intelligence/diagnostics'&&c.options.method==='POST').length,1);
});
test('one save for forced duplicate clicks and strict payload excludes display metadata',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);let done;
  f.handler(()=>new Promise(resolve=>done=resolve));
  const save=f.nodes['troubleshooting-save'].fire('click');await tick();await f.nodes['troubleshooting-save'].fire('click');
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
  const body=JSON.parse(f.calls.at(-1).options.body);assert.equal(body.title,'Wi-Fi stalls');assert.equal(body.computer_id,null);assert.deepEqual(body.evidence,[]);assert.ok(body.request_id);
  done(reply({case:row()}));await save;assert.match(f.nodes['troubleshooting-status'].textContent,/Problem saved/);
});
test('failed save and conflict retain the exact draft and require deliberate reload',async()=>{
  const f=fixture();await f.api.onOpen();f.handler(()=>reply({case:row()}));await f.api.open({id:row().id});
  f.nodes['troubleshooting-title'].value='Keep this unsaved idea';await f.nodes['troubleshooting-title'].fire('input');
  f.handler(()=>({_status:409,detail:'This problem changed in another view.'}));await f.nodes['troubleshooting-save'].click();
  assert.equal(f.nodes['troubleshooting-title'].value,'Keep this unsaved idea');assert.match(f.nodes['troubleshooting-status'].textContent,/draft remains/);
  const n=f.calls.length;await f.button('Reload saved version').click();assert.equal(f.calls.length,n);assert.match(f.nodes['troubleshooting-status'].textContent,/Discard your draft explicitly/);
});
test('closing and reopening keeps in-memory draft; lock clears it and ignores late saved response',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);f.api.onClose();await f.api.onOpen();assert.equal(f.nodes['troubleshooting-title'].value,'Wi-Fi stalls');
  let done;f.handler(()=>new Promise(resolve=>done=resolve));const save=f.nodes['troubleshooting-save'].click();await tick();await f.fire('tli-session-locked');done(reply({case:row()}));await save;
  assert.match(f.nodes['troubleshooting-status'].textContent,/Unsaved drafts were cleared/);assert.ok(!walk(f.nodes['troubleshooting-editor']).some(n=>n.value==='Wi-Fi stalls'));
});
test('stale failed or malformed list keeps earlier displayed records',async()=>{
  const f=fixture();await f.api.onOpen();f.handler(()=>({_status:503,detail:'Unavailable'}));await f.nodes['troubleshooting-refresh'].click();
  assert.ok(walk(f.nodes['troubleshooting-list']).some(n=>n.textContent==='Printer queue'));assert.match(f.nodes['troubleshooting-status'].textContent,/Previous results remain/);
  f.handler(()=>reply({items:[{title:'bogus'}],total:1}));await f.nodes['troubleshooting-refresh'].click();assert.ok(walk(f.nodes['troubleshooting-list']).some(n=>n.textContent==='Printer queue'));
});
test('a delayed problem open cannot replace a newly edited draft',async()=>{
  const f=fixture();await f.api.onOpen();await f.nodes['troubleshooting-new'].click();let done;f.handler(()=>new Promise(resolve=>done=resolve));
  const opening=f.api.open({id:row().id});await tick();f.nodes['troubleshooting-title'].value='Started writing';await f.nodes['troubleshooting-title'].fire('input');
  done(reply({case:row()}));await opening;assert.equal(f.nodes['troubleshooting-title'].value,'Started writing');assert.match(f.nodes['troubleshooting-status'].textContent,/draft changed while/);
});
test('link entry point reviews only its explicit owned source; save remains separate',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);
  f.handler(()=>reply({evidence:{kind:'note',id:'note-one',revision:'c'.repeat(64),label:'My setup'}}));
  await f.api.offerEvidence({kind:'note',id:'note-one'});
  const posts=f.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/intelligence/cases/evidence/review');
  assert.deepEqual(JSON.parse(posts[0].options.body),{kind:'note',id:'note-one'});assert.equal(f.nodes['troubleshooting-title'].value,'Wi-Fi stalls');
  assert.ok(walk(f.nodes['troubleshooting-evidence']).some(n=>n.textContent==='My setup'));
  assert.match(f.nodes['troubleshooting-status'].textContent,/Nothing was sent to AI/);
});
test('old evidence read after close cannot add a link on reopening',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);let done;f.handler(()=>new Promise(resolve=>done=resolve));
  const offer=f.api.offerEvidence({kind:'report',id:'report-one'});await tick();f.api.onClose();done(reply({evidence:{kind:'report',id:'report-one',revision:'d'.repeat(64),label:'Old result'}}));await offer;
  assert.ok(!walk(f.nodes['troubleshooting-evidence']).some(n=>n.textContent==='Old result'));
});
test('resolved needs user account of improvement and does not run a check',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);f.nodes['troubleshooting-state'].value='resolved';await f.nodes['troubleshooting-state'].fire('change');const before=f.calls.length;await f.nodes['troubleshooting-save'].click();
  assert.equal(f.calls.length,before);assert.match(f.nodes['troubleshooting-status'].textContent,/improvement you confirmed/);
});
test('completed chat decoration has no request until user explicitly links it and duplicates no button',async()=>{
  const f=fixture(),bubble=f.el('div'),metadata={source_ref:{conversation_id:'chat-one',message_index:1,revision:'e'.repeat(64)}};
  f.api.decorateMessage(bubble,metadata);f.api.decorateMessage(bubble,metadata);assert.equal(bubble.children.length,1);assert.equal(f.calls.length,0);
});

test('reusable guide prepares only an unsaved problem with fresh step IDs and no target or outcome',async()=>{
  const f=fixture(),guides=require('../js/case-guides.js');f.win.TLICaseGuides=guides;
  await f.api.onOpen();const before=f.calls.length,guide=guides.catalogue()[0];
  assert.equal(f.api.prepareGuide(guide),true);assert.equal(f.calls.length,before);
  assert.equal(f.nodes['troubleshooting-title'].value,guide.title);
  assert.equal(f.nodes['troubleshooting-state'].value,'open');assert.equal(f.nodes['troubleshooting-resolution'].value,'');
  assert.match(f.nodes['troubleshooting-save-state'].textContent,/Unsaved/);
  assert.equal(f.api.prepareGuide(guides.catalogue()[1]),false);assert.equal(f.nodes['troubleshooting-title'].value,guide.title);
  let sent;f.handler((url,o)=>{sent=JSON.parse(o.body);return reply({case:{...row(),title:sent.title,symptom:sent.symptom,steps:sent.steps}})});
  await f.nodes['troubleshooting-save'].click();assert.equal(sent.computer_id,null);assert.deepEqual(sent.evidence,[]);assert.equal(sent.resolution,'');
  assert(sent.steps.every(s=>s.status==='planned' && s.outcome===''));assert.equal(new Set(sent.steps.map(s=>s.id)).size,guide.steps.length);
});

test('guide entry and export do not overwrite an unsaved case or run actions',async()=>{
  const f=fixture();await f.api.onOpen();let count=0;f.win.TLICaseGuides={open:()=>count++,close:()=>{},validate:require('../js/case-guides.js').validate};
  await f.button('Start from a guide…').click();assert.equal(count,1);await fill(f);await f.button('Start from a guide…').click();assert.equal(count,1);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  await f.fire('tli-session-locked');assert.equal(f.api.prepareGuide(require('../js/case-guides.js').catalogue()[0]),false);
});
test('a guide draft invalidates an already pending saved-problem open',async()=>{const f=fixture(),guides=require('../js/case-guides.js');f.win.TLICaseGuides=guides;await f.api.onOpen();let done;f.handler(()=>new Promise(r=>done=r));const opening=f.api.open({id:row().id});await tick();assert.equal(f.api.prepareGuide(guides.catalogue()[2]),true);done(reply({case:row()}));await opening;assert.equal(f.nodes['troubleshooting-title'].value,guides.catalogue()[2].title);assert.match(f.nodes['troubleshooting-save-state'].textContent,/Unsaved/);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0)});
test('guide preparation cannot replace a draft while backgrounded or accept malformed data',async()=>{const f=fixture(),guides=require('../js/case-guides.js');f.win.TLICaseGuides=guides;await f.api.onOpen();await f.nodes['troubleshooting-new'].click();f.doc.hidden=true;assert.equal(f.api.prepareGuide(guides.catalogue()[0]),false);assert.equal(f.nodes['troubleshooting-title'].value,'');f.doc.hidden=false;assert.throws(()=>f.api.prepareGuide({...guides.catalogue()[0],execute:'unexpected'}));assert.equal(f.nodes['troubleshooting-title'].value,'');assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0)});


const nativePeer={id:'native-peer-id',name:'Other TLI computer',identity_fingerprint:'a'.repeat(64)};
const peerTarget={id:'mesh-inventory-peer',name:'Selected peer'};
const peerOptions=()=>({...checkOptions(),computer_id:peerTarget.id,options:[{id:'peer_system',kind:'peer_system',title:'Observe peer resources',detail:'Native CPU and RAM only; no host fallback.',available:true,reason:'',target_id:peerTarget.id,internet:false,execution_host:nativePeer,measured_target:peerTarget,scope_revision:'f'.repeat(64)}]});
const nativeReport=()=>({...checkReport(),host:nativePeer,target:peerTarget,execution:{kind:'peer_system',identity_fingerprint:nativePeer.identity_fingerprint,peer_revision:'b'.repeat(64),requesting_host:checkHost},peer_observation:{protocol:'tli-peer-observation-v1',host:nativePeer,peer_revision:'b'.repeat(64),observed_at:stamp}});
async function choosePeer(f){f.nodes['troubleshooting-computer'].value=peerTarget.id;await f.nodes['troubleshooting-computer'].fire('change');}

test('guided peer review sends selected inventory target and native execution host once; link remains separate',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await choosePeer(f);
  f.handler(url=>url.includes('/diagnostics/options')?peerOptions():nativeReport());
  await f.button('Review available checks').click();await settle();await f.button('Review this check').click();assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  await f.button('Run this check').click();await settle();const sent=f.calls.filter(c=>c.url==='/api/intelligence/diagnostics');assert.equal(sent.length,1);
  const request=JSON.parse(sent[0].options.body);assert.equal(request.kind,'peer_system');assert.equal(request.target_id,peerTarget.id);assert.equal(request.expected_host_id,nativePeer.id);assert.equal(request.internet,false);
  assert.ok(f.button('Add report link to this draft'));assert.equal(f.calls.filter(c=>c.url.endsWith('/evidence/review')).length,0);
});

for(const changed of ['host','target','identity','timestamp'])test('peer result '+changed+' mismatch cannot replace retained report',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await choosePeer(f);let broken=false;
  f.handler(url=>{if(url.includes('/diagnostics/options'))return peerOptions();const r=nativeReport();if(broken){if(changed==='host')r.host=checkHost;if(changed==='target')r.target={id:'other',name:'Wrong'};if(changed==='identity')r.execution={...r.execution,identity_fingerprint:'c'.repeat(64)};if(changed==='timestamp')r.peer_observation={...r.peer_observation,observed_at:'2020-01-01T00:00:00Z'};}return r;});
  for(let i=0;i<2;i++){await f.button('Review available checks').click();await settle();await f.button('Review this check').click();await f.button('Run this check').click();await settle();broken=true;}
  assert.ok(f.button('Add report link to this draft'));assert.ok(walk(f.nodes['troubleshooting-workspace']).some(n=>n.textContent.includes('could not be confirmed')));
  assert.equal(f.calls.filter(c=>c.url==='/api/intelligence/diagnostics').length,2);
});

test('unsupported peer stays unavailable and an old401 cannot lock a reopened guided view',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await choosePeer(f);
  let release;f.handler(()=>new Promise(r=>release=r));await f.button('Review available checks').click();await settle();f.api.onClose();let locks=0;f.win.addEventListener('tli-session-locked',()=>locks++);
  release({_status:401});await settle();assert.equal(locks,0);
  const g=fixture();await g.api.onOpen();await fill(g);await choosePeer(g);
  g.handler(()=>({...peerOptions(),options:[{...peerOptions().options[0],available:false,reason:'Identity not reviewed'}]}));
  await g.button('Review available checks').click();await settle();assert.equal(g.button('Review this check').disabled,true);assert.equal(g.calls.filter(c=>c.options.method==='POST').length,0);
});

const nextCheckFixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/next-check.json'),'utf8'));
const freshNext=()=>structuredClone(nextCheckFixture);
function guidanceFixture(){
  const f=fixture(),data=freshNext();f.doc.querySelector=()=>null;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/report-facts.js'),'utf8'),f.context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/case-context.js'),'utf8'),f.context);
  const controller=f.win.TLIGuidedChecks.create(),box=f.el('section');f.nodes['troubleshooting-workspace'].append(box);let alive=true,dirty=false,linkFails=false,links=0;
  controller.render(box,{key:{},computerId:data.case.computer.id,current:()=>alive,guidanceCurrent:()=>alive&&!dirty,onLink:async()=>{links++;if(linkFails)throw new Error('Case changed; keep report');}});
  const report={...checkReport(),host:data.response.guidance.check_options.host};
  f.handler(url=>url.endsWith('/next-check')?structuredClone(data.response):structuredClone(report));
  return {...f,data,controller,box,report,stop(clear=false){alive=false;controller.suspend(clear)},edit(){dirty=true;controller.invalidateGuidance()},failLink(){linkFails=true},links:()=>links,
    async review(){await controller.reviewSelection(data.request.case_ref);await settle()},
    async ready(){await this.review();assert.ok(f.button('Run this check'));assert.equal(f.button('Review suggested check'),undefined)}};
}

test('actual next-check envelope validates exact selection/facts and remains outside Chat',async()=>{
  const f=guidanceFixture();assert.equal(f.calls.length,0);assert.equal(f.win.TLIGuidedChecks.validGuidance(f.data.response,f.data.request.case_ref,f.data.case.computer.id),true);
  await f.review();assert.ok(f.button('Run this check'));assert.equal(f.button('Review suggested check'),undefined);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/intelligence/cases/next-check');
  const text=walk(f.box).map(n=>n.textContent).join(' ');assert.match(text,/Known.*Missing.*Already tried/s);assert.match(text,/Stutter continued\./);assert.match(text,/Skipped — not recorded as attempted/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.win.TLICaseContext.describeContext())),[]);assert.equal(f.calls.some(c=>c.url==='/api/intelligence/diagnostics'),false);
});

for(const field of ['selection','case_revision','report_host','computer','scope_option','prior_action','source_time'])test('guidance rejects mismatched real-envelope '+field,()=>{
  const f=guidanceFixture(),broken=structuredClone(f.data.response);
  if(field==='selection')broken.guidance.selection.step_ids=[];
  if(field==='case_revision')broken.case_context.revision='0'.repeat(64);
  if(field==='report_host')broken.evidence_context.recorded_report.host.id='other';
  if(field==='computer')broken.guidance.check_options.computer_id='other';
  if(field==='scope_option')broken.guidance.suggestion.option_id='performance';
  if(field==='prior_action')broken.guidance.steps[0].status='tried';
  if(field==='source_time')broken.guidance.known[0].recorded_at='2020-01-01T00:00:00Z';
  assert.equal(f.win.TLIGuidedChecks.validGuidance(broken,f.data.request.case_ref,f.data.case.computer.id),false);
});

test('suggested Run revalidates then sends one existing diagnostic request with bound sources; failed link never reruns',async()=>{
  const f=guidanceFixture();await f.ready();let release;
  f.handler(url=>url.endsWith('/next-check')?structuredClone(f.data.response):new Promise(r=>release=r));
  const run=f.button('Run this check');await run.click();await settle();await run.fire('click');await settle();
  const sends=f.calls.filter(c=>c.url==='/api/intelligence/diagnostics');assert.equal(sends.length,1);
  const body=JSON.parse(sends[0].options.body);assert.deepEqual(body.next_check_ref,f.data.diagnostic_request.next_check_ref);assert.equal(body.internet,false);
  release(f.report);await settle();f.failLink();await f.button('Add report link to this draft').click();await settle();
  assert.equal(f.links(),1);assert.match(walk(f.box).map(n=>n.textContent).join(' '),/Report saved; problem link not saved/);assert.equal(f.calls.filter(c=>c.url==='/api/intelligence/diagnostics').length,1);
});

for(const end of ['case_edit','scope_change','lock','background'])test('stale suggested run after '+end+' cannot execute or replay',async()=>{
  const f=guidanceFixture();await f.ready();let release;f.handler(()=>new Promise(r=>release=r));await f.button('Run this check').click();await settle();
  const response=structuredClone(f.data.response);
  if(end==='case_edit')f.edit();
  if(end==='scope_change')response.guidance.check_options.options[0].scope_revision='0'.repeat(64);
  if(end==='lock')f.stop(true);if(end==='background')f.stop();
  release(response);await settle();assert.equal(f.calls.some(c=>c.url==='/api/intelligence/diagnostics'),false);
  if(end==='lock')assert.equal(walk(f.box).some(n=>n.textContent==='Stutter continued.'),false);
});

test('failed guidance replacement retains previous evidence but disables its suggestion',async()=>{
  const f=guidanceFixture();await f.review();f.handler(()=>({_status:409,detail:'Source changed after review'}));await f.controller.reviewSelection(f.data.request.case_ref);await settle();
  assert.match(walk(f.box).map(n=>n.textContent).join(' '),/Stutter continued/);assert.equal(f.button('Run this check').disabled,true);
});

test('suggested review stays primary while native alternative disclosure never fetches or runs',async()=>{
  const f=guidanceFixture();await f.ready();
  const alternative=()=>walk(f.box).find(n=>n.className==='troubleshooting-check-alternatives');
  assert.equal(alternative().tag,'details');assert.equal(alternative().children[0].textContent,'Other available checks');assert.equal(alternative().open,false);
  assert.ok(f.box.children.indexOf(walk(f.box).find(n=>n.className==='troubleshooting-check-review'))<f.box.children.indexOf(alternative()));
  const count=f.calls.length;alternative().open=true;await alternative().fire('toggle');assert.equal(f.calls.length,count);
  f.handler(url=>{assert.ok(url.includes('/diagnostics/options'));return structuredClone(f.data.response.guidance.check_options)});
  await f.button('Review available checks').click();await settle();assert.equal(alternative().open,true);assert.equal(f.calls.length,count+1);
  await f.button('Review this check').click();await settle();assert.equal(alternative().open,false);assert.ok(f.button('Run this check'));assert.equal(f.calls.length,count+1);
});

for(const asynchronous of [false,true])test('guided controls report '+(asynchronous?'async':'synchronous')+' callback errors without losing the view',async()=>{
  const f=fixture(),box=f.el('section');f.nodes['troubleshooting-workspace'].append(box);
  f.win.TLIGuidedChecks.create().render(box,{key:{},current:()=>true,onGuidance:asynchronous?async()=>{throw new Error('Keep this draft');}:()=>{throw new Error('Keep this draft');}});
  await f.button('Review evidence for a next check').click();await settle();
  assert.match(walk(box).map(n=>n.textContent).join(' '),/Keep this draft/);assert.equal(f.calls.length,0);
});

async function inlineFixture(){
  const f=fixture(),data=freshNext();f.doc.querySelector=()=>null;
  for(const file of ['report-facts.js','case-context.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),f.context);
  f.handler((url,o)=>url==='/api/intelligence/devices'?{devices:[{...data.case.computer,kind:'computer'}]}:url.endsWith('/next-check')?structuredClone(data.response):url===('/api/intelligence/cases/'+data.case.id)?reply({case:structuredClone(data.case)}):reply({items:[data.case],total:1}));
  await f.api.onOpen();await f.api.open({id:data.case.id});
  const choose=async label=>{const wrap=walk(f.nodes['troubleshooting-editor']).find(n=>n.tag==='label'&&n.children.some(c=>c.textContent===label));assert.ok(wrap,label);const input=wrap.children.find(c=>c.tag==='input');input.checked=true;await input.fire('change');};
  for(const id of data.request.case_ref.step_ids){const step=data.case.steps.find(s=>s.id===id);await choose(step.status+': '+step.text);}
  if(data.request.case_ref.include_resolution)await choose('Include my recorded resolution');
  for(const ref of data.request.case_ref.evidence_refs){const e=data.case.evidence.find(e=>e.id===ref.id);await choose(`${e.label} · ${e.availability} · description only`);}
  for(const ref of data.request.case_ref.report_refs||[]){const e=data.case.evidence.find(e=>e.id===ref.id);await choose('Recorded facts: '+e.label);}
  return {...f,data};
}

test('inline selection saves explicitly then finds one scoped check without modal, acknowledgement or diagnostic',async()=>{
  const f=await inlineFixture();assert.equal(f.calls.some(c=>c.options.method==='POST'),false);
  await f.nodes['troubleshooting-symptom'].fire('input');
  assert.equal(f.nodes['troubleshooting-next'].textContent,'Save & find next check');
  await f.nodes['troubleshooting-next'].click();await settle();
  const writes=f.calls.filter(c=>c.options.method==='PUT'||c.options.method==='POST');
  assert.deepEqual(writes.map(c=>c.options.method),['PUT','POST']);
  assert.deepEqual(JSON.parse(writes[1].options.body),f.data.request);
  assert.ok(f.button('Run this check'));assert.equal(f.button('Review suggested check'),undefined);
  assert.equal(f.nodes['case-context-dialog'],undefined);assert.equal(f.calls.some(c=>c.url==='/api/intelligence/diagnostics'),false);
});

test('Save and find conflict preserves the draft and never requests guidance or a check',async()=>{
  const f=await inlineFixture();f.nodes['troubleshooting-symptom'].value='Keep my exact changed symptom';await f.nodes['troubleshooting-symptom'].fire('input');
  f.handler(()=>({_status:409,detail:'Case revision changed'}));const count=f.calls.length;
  await f.nodes['troubleshooting-next'].click();await settle();
  assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1).options.method,'PUT');assert.equal(f.nodes['troubleshooting-symptom'].value,'Keep my exact changed symptom');assert.match(f.nodes['troubleshooting-status'].textContent,/draft remains/);
});

test('late Save and find after lock never reads selected reports or requests a check',async()=>{
  const f=await inlineFixture();await f.nodes['troubleshooting-symptom'].fire('input');let finish;f.handler(()=>new Promise(r=>finish=r));
  const pending=f.nodes['troubleshooting-next'].click();await tick();await f.fire('tli-session-locked');finish(reply({case:f.data.case}));await pending;await settle();
  assert.equal(f.calls.some(c=>c.url.endsWith('/next-check')),false);assert.equal(f.button('Run this check'),undefined);
});

test('symptom-only explicit Save generates a bounded title and keeps administrative controls secondary',async()=>{
  const f=fixture();await f.api.onOpen();await f.nodes['troubleshooting-new'].click();f.nodes['troubleshooting-symptom'].value='Browser pauses\nOnly while recording';await f.nodes['troubleshooting-symptom'].fire('input');
  f.handler((url,o)=>{const body=JSON.parse(o.body);return reply({case:{...row(),title:body.title,symptom:body.symptom}})});
  await f.nodes['troubleshooting-save'].click();assert.equal(JSON.parse(f.calls.at(-1).options.body).title,'Browser pauses');
  for(const cls of ['troubleshooting-record','troubleshooting-admin']){const details=walk(f.nodes['troubleshooting-editor']).find(n=>n.className===cls);assert.equal(details.tag,'details');assert.equal(details.open,false);}
});

test('Performance handoff requires an available host scope and never samples on review or navigation',async()=>{
  const f=fixture();await f.api.onOpen();await fill(f);await chooseHost(f);let navigated;
  f.win.switchPanel=p=>navigated=p;const opts=checkOptions();opts.options.push({...opts.options[0],id:'performance',kind:'performance',panel:'panel-games',title:'Observe an app'});
  f.handler(()=>opts);await f.button('Review app performance').click();await settle();assert.equal(navigated,undefined);
  assert.ok(f.button('Open Performance & apps'));await f.button('Open Performance & apps').click();await settle();assert.equal(navigated,'panel-games');assert.equal(f.calls.some(c=>c.options.method==='POST'),false);
});
