const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{webcrypto}=require('node:crypto');
const code=fs.readFileSync(path.join(__dirname,'../js/routine-workspace.js'),'utf8'),tick=()=>new Promise(r=>setImmediate(r));
const hash='a'.repeat(64),now='2026-09-08T16:00:00Z';
const caps=()=>({review_protocol:'tli-action-review-v1',trigger_engine:{available:false},devices:[{id:'relay-a',name:'Desk',ip:'192.0.2.10',relay:0},{id:null,name:'Desk',ip:'192.0.2.10',relay:1}],hp_devices:[{device_id:'hp-a',name:'Outlet',ip:'192.0.2.20',relay:0,capabilities:['switch.on','switch.off']}]});
const action=(name='Desk routine')=>({id:'act_1234567890',name,steps:[{type:'shelly.switch',device:'relay-a',value:'on'}],updated_at:now});
function review(p,run=false){return{ok:true,protocol:'tli-action-review-v1',actions_performed:false,checked_at:now,name:p.name,scope:'Registered target review. No action ran.',target_revision:hash,...(run?{action_id:p.id,revision:hash}:{draft_revision:hash}),available:true,trigger_active:false,errors:{},steps:p.steps.map((s,i)=>({index:i,step_type:s.type,effect:s.value||s.capability,target:{id:s.device==='relay-a'?'relay-a':s.device_id||null,name:'Desk',address:s.device_id?'192.0.2.20':'192.0.2.10',relay:s.device?.endsWith('relay 1')?1:0}}))};}
function fixture(){const ids={},events={},calls=[];let handler=null,snapshot=caps();const document={hidden:false,addEventListener:(k,fn)=>(events[k]||=[]).push(fn),getElementById:id=>ids[id]};
function element(tag){const e={tagName:tag.toUpperCase(),children:[],handlers:{},attrs:{},value:'',textContent:'',disabled:false,checked:false,parentNode:null,append(...nodes){nodes.forEach(n=>{n.parentNode=this;this.children.push(n)})},replaceChildren(...nodes){this.children=[];this.textContent='';this.append(...nodes)},setAttribute(k,v){this.attrs[k]=v},addEventListener(k,fn){(this.handlers[k]||=[]).push(fn)},fire(k){return Promise.all((this.handlers[k]||[]).map(fn=>fn({target:this,preventDefault(){}})))},click(){return this.disabled?Promise.resolve():this.fire('click')},focus(){},remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this)}};Object.defineProperty(e,'id',{set(v){ids[v]=e;e._id=v},get(){return e._id}});return e;}
document.createElement=element;const mount=element('main');mount.id='routine-workspace';const window={addEventListener:(k,fn)=>(events[k]||=[]).push(fn),dispatchEvent:e=>(events[e.type]||[]).forEach(fn=>fn(e))};
const defaultHandler=async(url,opts)=>{const p=opts.body?JSON.parse(opts.body):null;if(url.endsWith('/capabilities'))return snapshot;if(url.endsWith('/list'))return{actions:[action()],triggers:[{type:'schedule.time',time:'20:00',enabled:true,action_id:action().id}]};if(url.includes('/receipts'))return{items:[]};if(url.endsWith('/preview'))return review(p);if(url.endsWith('/approve'))return{ok:true,action:{...action(p.name),steps:p.steps},receipt_saved:true,trigger_active:false};if(url.endsWith('/review'))return review(action(),true);if(url.includes('/run/'))return{ok:true,results:[{ok:true,device:'Desk',relay:0}],summary:'One reported success.',receipt_saved:true};throw Error('Unexpected '+url);};
vm.runInNewContext(code,{window,document,Date,Set,Map,Uint8Array,AbortController,CustomEvent,crypto:{getRandomValues:b=>webcrypto.getRandomValues(b)},fetch:async(url,options)=>{calls.push({url,options});const value=await(handler||defaultHandler)(url,options);return{ok:!value?.http,status:value?.http||200,json:async()=>value?.data||value};}});
const descendants=n=>[n,...n.children.flatMap(descendants)],nodes=()=>descendants(mount),find=label=>nodes().find(n=>n.tagName==='BUTTON'&&n.textContent===label),input=label=>nodes().find(n=>n.attrs['aria-label']===label);
return{api:window.TLIManualRoutines,ids,calls,events,document,find,input,text:()=>nodes().map(n=>n.textContent).join('\n'),handler:fn=>handler=fn,defaults:defaultHandler,caps:v=>snapshot=v,event:type=>window.dispatchEvent(new CustomEvent(type)),click:async label=>{const b=find(label);assert.ok(b,label);await b.click();await tick();},set:async(label,value,event='change')=>{const e=input(label);assert.ok(e,label);e.value=value;await e.fire(event);await tick();}};}
async function opened(f){f.api.onOpen();await tick();await tick();}
async function draft(f,target='shelly:relay-a'){await f.click('Switch devices on');await f.set('Routine name','Evening lights','input');await f.set('Step 1 target',target);}
async function readyRun(f){await f.click('Review run: Desk routine');f.input('I reviewed every target and effect').checked=true;await f.input('I reviewed every target and effect').fire('change');}

test('opening and templates perform no writes, AI calls or target probes; legacy definitions are inert',async()=>{const f=fixture();await opened(f);assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.options.method==='GET'));await draft(f);assert.equal(f.calls.length,3);assert.match(f.text(),/not an activation or execution status/);assert.equal(f.find('Enable'),undefined);assert.equal(f.find('Run reviewed routine'),undefined);});
test('unique legacy address and relay remains usable, duplicate bindings are excluded, explicit IDs preserved',async()=>{const f=fixture(),c=caps();c.devices.push({name:'Ambiguous one',ip:'192.0.2.30',relay:1},{name:'Ambiguous two',ip:'192.0.2.30',relay:1});f.caps(c);await opened(f);await draft(f,'shelly:192.0.2.10:1');assert.match(f.text(),/physical identity unverified/);assert.equal(f.input('Step 1 target').children.some(o=>o.textContent.includes('Ambiguous')),false);await f.click('Preview routine');assert.equal(JSON.parse(f.calls.at(-1).options.body).steps[0].device,'192.0.2.10 relay 1');assert.ok(f.find('Save reviewed routine'));});
test('preview checks exact targets and saving is one distinct idempotent request, never a run',async()=>{const f=fixture();await opened(f);await draft(f);await f.click('Preview routine');assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);let done;f.handler((url,opts)=>url.endsWith('/approve')?new Promise(r=>done=()=>r({ok:true,action:{...action('Evening lights'),steps:JSON.parse(opts.body).steps},receipt_saved:true,trigger_active:false})):f.defaults(url,opts));const b=f.find('Save reviewed routine'),pending=b.click();await b.click();await tick();assert.equal(f.calls.filter(c=>c.url.endsWith('/approve')).length,1);const p=JSON.parse(f.calls.at(-1).options.body);assert.match(p.request_id,/^[a-f0-9]{32}$/);assert.equal(p.trigger,undefined);done();await pending;assert.match(f.text(),/Routine saved/);assert.equal(f.calls.some(c=>c.url.includes('/run/')),false);});
test('editing a preview invalidates save without replacing or losing the input draft',async()=>{const f=fixture();await opened(f);await draft(f);await f.click('Preview routine');await f.set('Routine name','Changed title','input');assert.equal(f.find('Save reviewed routine'),undefined);assert.equal(f.input('Routine name').value,'Changed title');assert.equal(f.calls.filter(c=>c.url.endsWith('/approve')).length,0);});
test('malformed or differently bound previews cannot enable Save',async()=>{for(const change of[v=>v.actions_performed=true,v=>v.steps[0].target.id='foreign',v=>v.steps[0].target.relay=1,v=>v.steps[0].effect='off']){const f=fixture();await opened(f);await draft(f);f.handler(async(u,o)=>{const v=await f.defaults(u,o);change(v);return v});await f.click('Preview routine');assert.equal(f.find('Save reviewed routine'),undefined);assert.match(f.text(),/did not confirm/);}});
test('failed save preserves exact request ID for deliberate retry, with no automatic replay',async()=>{const f=fixture();await opened(f);await draft(f);await f.click('Preview routine');f.handler(async()=>{throw Error('Connection lost')});await f.click('Save reviewed routine');const first=f.calls.at(-1).options.body;assert.match(f.text(),/Save outcome is unconfirmed/);assert.equal(f.input('Routine name').value,'Evening lights');await tick();assert.equal(f.calls.filter(c=>c.url.endsWith('/approve')).length,1);f.handler(f.defaults);await f.click('Retry same reviewed save');assert.equal(f.calls.at(-1).options.body,first);assert.match(f.text(),/Routine saved/);});
test('save receipt failure is not misreported as unsaved and an incorrect saved payload cannot claim success',async()=>{for(const mode of['receipt','wrong']){const f=fixture();await opened(f);await draft(f);await f.click('Preview routine');f.handler(async(u,o)=>{const v=await f.defaults(u,o);if(mode==='receipt')v.receipt_saved=false;else v.action.steps[0].value='off';return v});await f.click('Save reviewed routine');assert.match(f.text(),mode==='receipt'?/Routine saved.*receipt could not be saved/:/Save outcome is unconfirmed/);}});
test('review and acknowledgement precede one Run with exact revision and target binding',async()=>{const f=fixture();await opened(f);await f.click('Review run: Desk routine');assert.equal(f.find('Run reviewed routine').disabled,true);assert.equal(f.calls.some(c=>c.url.includes('/run/')),false);await readyRun(f);let finish;f.handler(()=>new Promise(r=>finish=r));const b=f.find('Run reviewed routine'),pending=b.click();await b.click();await tick();assert.equal(f.calls.filter(c=>c.url.includes('/run/')).length,1);const p=JSON.parse(f.calls.at(-1).options.body);assert.equal(p.expected_revision,hash);assert.equal(p.expected_targets,hash);finish({ok:true,results:[{ok:true,device:'Desk',relay:0}],summary:'Driver accepted.',receipt_saved:true});await pending;assert.match(f.text(),/not a new physical-state measurement/);assert.equal(f.find('Run reviewed routine'),undefined);});
test('failed and partial runs retain explicit results and unsaved receipts, never silently retry',async()=>{const f=fixture();await opened(f);await readyRun(f);f.handler(async()=>({ok:false,results:[{ok:false,device:'Desk',error:'Relay unavailable'}],summary:'No successful step.',receipt_saved:false}));await f.click('Run reviewed routine');assert.match(f.text(),/Failed or partial execution/);assert.match(f.text(),/History receipt not saved/);assert.match(f.text(),/Relay unavailable/);assert.equal(f.calls.filter(c=>c.url.includes('/run/')).length,1);});

// Preserve the original anniversary action-outcome regressions through the new
// explicit review and acknowledgement lifecycle, including the recorded history.
for (const [successes, summary] of [
  [2, 'Completed Office: 2 step(s) succeeded.'],
  [1, 'Partially completed Office: 1 of 2 step(s) succeeded.'],
  [0, 'Failed to complete Office: no steps succeeded.'],
]) test('saved routine outcome and recorded receipt: ' + summary, async () => {
  const f = fixture(), office = { ...action('Office'), steps: [
    { type: 'shelly.switch', device: 'relay-a', value: 'on' },
    { type: 'shelly.switch', device: '192.0.2.10 relay 1', value: 'off' },
  ] }; let executions = 0;
  f.handler(async (url, opts) => {
    if (url.endsWith('/list')) return { actions: [office], triggers: [] };
    if (url.endsWith('/review')) return review(office, true);
    if (url.includes('/run/')) { executions++; return { ok: successes === 2, summary, receipt_saved: true,
      results: office.steps.map((step, i) => ({ ok: i < successes, device: 'Desk', relay: i,
        ...(i < successes ? {} : { error: 'Synthetic relay failure ' + i }) })) }; }
    if (url.includes('/receipts')) return { items: executions ? [{ kind: 'action_run', ts: now, summary, ok: successes === 2 }] : [] };
    return f.defaults(url, opts);
  });
  await opened(f); await f.click('Review run: Office');
  assert.equal(executions, 0); assert.equal(f.find('Run reviewed routine').disabled, true);
  const acknowledgement = f.input('I reviewed every target and effect');
  acknowledgement.checked = true; await acknowledgement.fire('change');
  await f.click('Run reviewed routine');
  assert.equal(executions, 1); assert.ok(f.text().includes(summary));
  assert.match(f.text(), successes === 2 ? /Driver-reported completion/ : /Failed or partial execution/);
  assert.equal(f.find('Run reviewed routine'), undefined);
  if (successes === 2) assert.match(f.text(), /not a new physical-state measurement/);
  else assert.doesNotMatch(f.text(), /Driver-reported completion/);
  if (successes < 2) assert.match(f.text(), /Synthetic relay failure/);
  await f.click('Refresh saved state');
  assert.equal(executions, 1);
  assert.match(f.text(), /Run result recorded/);
  assert.equal(f.text().split(summary).length - 1, 2, 'Visible outcome and saved history retain the exact summary');
});
test('transport failure or incomplete Run response keeps earlier result and requires a new explicit review',async()=>{const f=fixture();await opened(f);await readyRun(f);await f.click('Run reviewed routine');for(const problem of['network','malformed','conflict']){f.handler(f.defaults);await readyRun(f);f.handler(async()=>{if(problem==='network')throw Error('Lost response');return problem==='conflict'?{http:409,data:{detail:'Targets changed; no steps ran'}}:{ok:true,results:[],summary:'Wrong count',receipt_saved:true}});await f.click('Run reviewed routine');assert.match(f.text(),/Run outcome is unconfirmed/);assert.match(f.text(),/Last received run result/);assert.equal(f.find('Run reviewed routine'),undefined);}assert.equal(f.calls.filter(c=>c.url.includes('/run/')).length,4);});
test('lock before queued click prevents mutation; late reads and actions cannot reopen private state',async()=>{const f=fixture();await opened(f);await readyRun(f);const pending=f.find('Run reviewed routine').click();f.event('tli-session-locked');await pending;assert.equal(f.calls.some(c=>c.url.includes('/run/')),false);assert.equal(f.text(),'');f.event('tli-session-unlocked'); f.event('tli-private-observation-ready');await opened(f);await readyRun(f);let finish;f.handler(()=>new Promise(r=>finish=r));const running=f.find('Run reviewed routine').click();await tick();f.event('tli-session-locked');finish({ok:true,results:[{ok:true}],summary:'Accepted',receipt_saved:true});await running;assert.equal(f.text(),'');});
test('close during Run retains global reservation and displays uncertainty on return until settlement',async()=>{const f=fixture();await opened(f);await readyRun(f);let finish;f.handler(()=>new Promise(r=>finish=r));const running=f.find('Run reviewed routine').click();await tick();f.api.onClose();f.api.onOpen();assert.match(f.text(),/earlier request may have completed/);assert.equal(f.find('Refresh saved state').disabled,true);finish({ok:true,results:[{ok:true}],summary:'Accepted',receipt_saved:true});await running;assert.equal(f.find('Refresh saved state').disabled,false);assert.equal(f.calls.filter(c=>c.url.includes('/run/')).length,1);assert.doesNotMatch(f.text(),/Driver-reported completion/);});
test('failed refresh retains saved list, results and draft and never turns unavailable into empty',async()=>{const f=fixture();await opened(f);await draft(f);f.handler(async()=>({http:503,data:{detail:'Unreadable store'}}));await f.click('Refresh saved state');assert.match(f.text(),/Previous results and your draft are retained/);assert.ok(f.find('Review run: Desk routine'));assert.equal(f.input('Routine name').value,'Evening lights');assert.doesNotMatch(f.text(),/No saved routines yet/);});
test('new templates guard dirty drafts, and background clears private drafts with explicit reload only',async()=>{const f=fixture();await opened(f);await draft(f);await f.click('Discard draft');await f.click('Keep editing');assert.equal(f.input('Routine name').value,'Evening lights');f.document.hidden=true;for(const fn of f.events.visibilitychange)fn();assert.equal(f.text(),'');f.document.hidden=false;for(const fn of f.events.visibilitychange)fn();assert.match(f.text(),/Private drafts and reviews were cleared/);assert.ok(f.find('Reload saved routines'));assert.equal(f.calls.length,3);});
test('untrusted names are rendered as text and unavailable reviews cannot run',async()=>{const f=fixture();f.handler(async(u,o)=>{const v=await f.defaults(u,o);if(u.endsWith('/list'))v.actions[0].name='<img src=x onerror=alert(1)>';if(u.endsWith('/review')){v.available=false;v.steps[0].target=null;v.errors={0:'Missing target'}}return v});await opened(f);assert.match(f.text(),/<img src=x/);await f.click('Review run: <img src=x onerror=alert(1)>');assert.match(f.text(),/Missing target/);assert.equal(f.find('Run reviewed routine'),undefined);});

test('a stale access rejection from an earlier view cannot lock a freshly authorized routine view', async () => {
  const f = fixture(); let rejectOld;
  f.handler((url, opts) => url.endsWith('/list') ? new Promise(resolve => { rejectOld = () => resolve({ http: 401, data: { detail: 'Old session expired' } }); }) : f.defaults(url, opts));
  f.api.onOpen(); await tick(); f.api.onClose();
  f.event('tli-session-locked'); f.event('tli-session-unlocked'); f.event('tli-private-observation-ready');
  f.handler(f.defaults); await opened(f);
  assert.ok(f.find('Review run: Desk routine'));
  rejectOld(); await tick(); await tick();
  assert.ok(f.find('Review run: Desk routine'), 'Late old 401 must not clear the current view');
  await f.click('Review run: Desk routine');
  assert.ok(f.input('I reviewed every target and effect'));
  assert.equal(f.calls.some(c => c.url.includes('/run/')), false);
});

for (const status of [401, 403]) test('current routine denial ' + status + ' clears private state and waits for checked recovery', async () => {
  const f = fixture(); await opened(f); await draft(f);
  f.handler(async () => ({http: status, data: {detail: 'Synthetic access ended'}}));
  await f.click('Refresh saved state');
  assert.equal(f.text(), '');
  const before = f.calls.length;
  f.handler(f.defaults);
  f.event('tli-session-unlocked'); await opened(f);
  assert.equal(f.calls.length, before, 'Bare unlock does not reopen private reads');
  assert.equal(f.text(), '');
  f.event('tli-private-observation-ready'); await tick(); await tick();
  assert.ok(f.find('Review run: Desk routine'));
  assert.equal(f.input('Routine name'), undefined, 'Private draft is not silently restored');
  assert.equal(f.calls.length, before + 3);
  f.event('tli-private-observation-ready'); await tick();
  assert.equal(f.calls.length, before + 3, 'Repeated ready does not duplicate refresh');
  assert.ok(f.calls.every(call => call.options.method === 'GET'));
});

test('an old Run button cannot dispatch into a newly verified session', async () => {
  const f = fixture(); await opened(f); await readyRun(f);
  const old = f.find('Run reviewed routine');
  f.event('tli-session-locked'); f.event('tli-session-unlocked');
  f.event('tli-private-observation-ready'); await tick(); await tick();
  await old.click(); await tick();
  assert.equal(f.calls.some(call => call.url.includes('/run/')), false);
  assert.ok(f.find('Review run: Desk routine'));
});

for (const status of [401, 403]) test('late Run denial ' + status + ' cannot disclose outcomes or replay a physical request', async () => {
  const f = fixture(); await opened(f); await readyRun(f);
  let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.find('Run reviewed routine').click(); await tick();
  finish({http: status, data: {detail: 'Session ended'}}); await pending;
  assert.equal(f.text(), '');
  assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 1);
  f.handler(f.defaults); f.event('tli-session-unlocked');
  f.event('tli-private-observation-ready'); await tick(); await tick();
  assert.equal(f.calls.filter(call => call.url.includes('/run/')).length, 1);
  assert.match(f.text(), /earlier request may have completed/);
  assert.equal(f.find('Run reviewed routine'), undefined);
});

test('leaving the routine panel while locked prevents automatic reopening after verification', async () => {
  const f = fixture(); await opened(f);
  f.event('tli-session-locked'); f.api.onClose();
  const before = f.calls.length;
  f.event('tli-session-unlocked'); f.event('tli-private-observation-ready');
  await tick(); await tick();
  assert.equal(f.text(), ''); assert.equal(f.calls.length, before);
});
