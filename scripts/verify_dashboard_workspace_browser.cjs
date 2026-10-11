/* The real Dashboard in an isolated browser. All network traffic is intercepted. */
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.argv.includes('--label')) process.argv.push('--label', 'dashboard-workspace');
const {makePage, layout, fixtures, fingerprintFiles, source} = require('./verify_anniversary_ui_browser.cjs');
const {contrast, textScale, measuredLayout} = require('./verify_anniversary_themes_browser.cjs');
const baseline = process.argv.includes('--before');
const output = path.resolve(__dirname, '../build_work/dashboard-rebuild', `${baseline ? 'before' : 'after'}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, {recursive:true});
const report = {source, output, baseline, synthetic:true, hashesAtStart:fingerprintFiles(source), themes:[], views:[], layouts:[], contrast:[], behaviors:[], requests:[], errors:[], limitations:[
  'All host, model, device, storage and activity responses are synthetic and intercepted. No live TLI instance is started or restarted.',
  'Browser sizes and doubled text simulate small screens and enlargement; they are not physical-phone or screen-reader acceptance.',
  'Computed contrast covers solid backgrounds; complex backgrounds are listed for visual review.'
]};
const stamp = () => Math.floor(Date.now()/1000);
function activity(empty = false) {
  const now = stamp();
  const events = empty ? [] : [
    {id:'fixture-scan', sequence:7, ts:now-1800, first_ts:now-3600, count:3, level:'warning', title:'Storage scan partially completed', body:'12,804 files inspected. One protected folder could not be read. No files were changed.', category:'storage', node:'Studio'},
    {id:'fixture-note', sequence:6, ts:now-7200, count:1, level:'info', title:'Saved note updated', body:'A private setup note was saved.', category:'notes', node:'Studio'},
    {id:'fixture-network', sequence:5, ts:now-10800, count:1, level:'info', title:'Den computer reconnected', body:'The computer reported online. Its AI status is unknown.', category:'network', node:'Den'}
  ];
  return {ok:true,checked_at:now,total:empty?0:5,warning_count:empty?0:3,group_count:events.length,groups:events,events,retained_events:events,cursor:{stream_id:'synthetic-dashboard',sequence:7},coverage:empty?'complete':'retained',coverage_note:empty?'No newer retained events.':'Showing retained activity. No previous review has been saved.',reviewed_at:null,retention_limit:200,history:{limit:500,days:30,status:'recording'}};
}
function command(view='healthy') {
  const now = stamp(), old = view==='stale';
  const data = structuredClone(fixtures['/dashboard/command-center']);
  Object.assign(data, {ts:now,observed_at:now,aiOk:true,lmOnline:false,metrics_checked_at:new Date(now*1000).toISOString()});
  Object.assign(data.state, {probed_ts:now-(old?120:0),cpu_pct:18,ram_pct:43,disk_pct_by_drive:{'C:\\':74},device_count:2});
  data.narrator = {type:'status',text:'No issues detected in the latest system checks.',severity:'info',timestamp:now};
  data.current_action = null;
  data.storage = {...data.diskData,drives:[{drive:'C:',mount:'C:\\',pct:74,used_gb:370,total_gb:500,free_gb:130}]};
  if (view==='critical') {
    Object.assign(data.diskData.system,{pct:99.1,used_gb:495.5,free_gb:4.5});
    Object.assign(data.storage.system,data.diskData.system); data.storage.drives[0]={...data.diskData.system};
    data.state.disk_pct_by_drive={'C:\\':99.1};
    data.activeAlerts=[{id:'disk-pressure',severity:'critical',title:'Drive C:\\ is nearly full',body:'4.5 GB available on this host.',message:'4.5 GB available on drive C:\\.'}];
    data.narrator={type:'alert',text:'Drive C:\\ is critically full (99%). Open Free Space to review large files and folders.',severity:'critical',timestamp:now};
    data.current_action={id:'fixture-review-storage',handler:'open_visualizer',title:'Review storage on C:\\',context:'4.5 GB free. Review files before making changes.',confirm_label:'Open Free Space',dismiss_label:'Not now',secondary_label:'Review details'};
  }
  if (old) data.narrator={type:'status',text:'System readings are stale. The last successful check was two minutes ago.',severity:'warning',timestamp:now};
  if (view==='unknown') {
    data.state={cpu_pct:null,ram_pct:null,disk_pct_by_drive:{},device_count:null,probed_ts:null}; data.diskData=null; data.storage=null;data.aiOk=null;data.lmOnline=null;data.devCount=null;data.smart_home={count:null};data.devNames=[];
    data.narrator={type:'status',text:'System monitoring is unavailable. Waiting for a successful check.',severity:'info',timestamp:now};
  }
  if(view==='empty') {data.devCount=0;data.devNames=[];data.smart_home={count:0};data.state.device_count=0;}
  return data;
}
async function dashboardPage(browser,width=1440,theme='emeraldLight',view='healthy') {
  const run=await makePage(browser,width,theme), {page,context}=run;
  const state={view,command:command(view),summary:activity(view==='empty'),places:fixtures['/api/intelligence/places'].places.map((p,i)=>({...p,id:(i+1).toString(16).padStart(32,'0')})),calls:[],unexpected:[],faults:new Map(),gates:new Map(),allGates:new Set(),failAll:view==='unavailable',locked:false};
  state.fail=(method,p,status=503,body={ok:false,detail:'Synthetic refresh failed. Previous results retained.'})=>state.faults.set(`${method} ${p}`,{status,body});
  state.defer=(method,p)=>{let release;const promise=new Promise(r=>release=r);const gate={promise,release};state.gates.set(`${method} ${p}`,gate);state.allGates.add(gate);return gate;};
  state.set=view=>{state.view=view;state.command=command(view);state.summary=activity(view==='empty');state.failAll=view==='unavailable';};
  if(view==='loading'){let release;const promise=new Promise(r=>release=r);state.loadingGate={promise,release};state.allGates.add(state.loadingGate);}
  const controlled = new Set(['/dashboard/command-center','/dashboard/state','/dashboard/presence','/dashboard/action/current','/dashboard/action/confirm','/dashboard/action/dismiss','/dashboard/action/secondary','/dashboard/narrator/current','/dashboard/narrator/settings','/dashboard/activity-summary','/dashboard/activity-summary/review','/status','/homeauto/devices','/api/ai/bundled/status','/api/ai/status','/api/ai/model/info','/api/system/disk','/status/alerts','/api/mesh/health','/api/intelligence/places','/system/pin/lock','/system/pin/verify']);
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),p=url.pathname,method=request.method(),key=`${method} ${p}`;
    if(url.hostname!=='tli-ui.test'||!controlled.has(p))return route.fallback();
    let body=null;try{body=request.postDataJSON();}catch{}
    state.calls.push({method,path:p,body});
    // Freeze each response before delaying it, to expose stale response races honestly.
    const data=structuredClone(state.command),summary=structuredClone(state.summary),wasLocked=state.locked,unavailable=state.failAll;
    if(state.loadingGate)await state.loadingGate.promise;
    const gate=state.gates.get(key);if(gate){state.gates.delete(key);await gate.promise;}
    const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    const fault=state.faults.get(key);if(fault){state.faults.delete(key);return respond(fault.body,fault.status);}
    if(p==='/system/pin/lock'){state.locked=true;return respond({ok:true,locked:true});}
    if(p==='/system/pin/verify'){if(body?.pin!=='2468')return respond({ok:false,detail:'Synthetic PIN mismatch'},401);state.locked=false;return respond({ok:true});}
    if(wasLocked)return respond({detail:'Synthetic session locked'},401);
    if(unavailable)return respond({detail:'Synthetic host unavailable'},503);
    if(['/dashboard/command-center','/dashboard/state','/dashboard/presence'].includes(p))return respond(data);
    if(p==='/dashboard/action/current')return respond(data.current_action);
    if(p==='/dashboard/narrator/current')return respond(data.narrator);
    if(p==='/dashboard/narrator/settings')return respond({ok:true,scope:'host',mode:body?.mode||'balanced',narrator:{...data.narrator,explanations:[]}});
    if(p==='/dashboard/activity-summary')return respond(summary);
    if(p==='/dashboard/activity-summary/review'){state.summary=activity(true);state.summary.reviewed_at=stamp();return respond({ok:true});}
    if(p==='/dashboard/action/confirm'){state.command.current_action=null;return respond({ok:true,receipt:{ok:true,narrator_msg:'Free Space opened. No files were changed.',navigate_to:'panel-visualizer'}});}
    if(p==='/dashboard/action/secondary')return respond({ok:true,receipt:{ok:true,narrator_msg:'Storage details opened. No files were changed.',navigate_to:'panel-visualizer'}});
    if(p==='/dashboard/action/dismiss'){state.command.current_action=null;return respond({ok:true});}
    if(p==='/status')return respond({...fixtures[p],cpu_usage:data.state.cpu_pct,ram_usage:data.state.ram_pct,model_online:data.aiOk===true});
    if(p==='/homeauto/devices')return respond({devices:data.devCount===0?[]:fixtures[p].devices});
    if(p==='/api/system/disk')return respond(data.diskData||{ok:false});
    if(p==='/status/alerts')return respond({alerts:data.activeAlerts});
    if(p==='/api/mesh/health')return respond({ok:true,nodes:[{node_id:'fixture-studio',node_name:'Studio',is_self:true,online:true,ai_healthy:data.aiOk,cpu_percent:data.state.cpu_pct,ram_percent:data.state.ram_pct},{node_id:'fixture-den',node_name:'Den',online:true,ai_healthy:null,cpu_percent:9,ram_percent:31}]});
    if(p==='/api/intelligence/places')return respond({...fixtures[p],places:state.view==='empty'?[]:state.places});
    if(p.includes('/ai/'))return data.aiOk===null?respond({detail:'Synthetic AI status unknown'},503):respond(fixtures[p]);
    state.unexpected.push({method,path:p});return respond({detail:'Unexpected fixture operation refused'},409);
  });
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(()=>typeof window.TLIDash2?.onOpen==='function');
  await page.evaluate(()=>switchPanel('panel-dashboard2'));
  await page.waitForTimeout(1100);
  await page.evaluate(()=>{window.__themeAuditVisible=el=>{
    if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;
    for(let ancestor=el;ancestor;ancestor=ancestor.parentElement){if(Number(getComputedStyle(ancestor).opacity)===0)return false;if(ancestor!==el&&ancestor.tagName==='DETAILS'&&!ancestor.open&&!ancestor.querySelector(':scope > summary')?.contains(el))return false;}return true;
  };});
  return {...run,state};
}
async function refresh(run,view) {
  run.state.set(view);
  await run.page.evaluate(async()=>{await window.TLIPresence?.fetchActionCurrent();await window.TLIActivitySummary?.refresh();if(window.TLIDash2.refresh)await window.TLIDash2.refresh();else{window.TLIDash2.onClose();window.TLIDash2.onOpen();}});
  await run.page.waitForTimeout(950);
}
async function record(run) {
  report.requests.push(...run.state.calls);report.errors.push(...run.errors);report.errors.push(...run.state.unexpected.map(x=>JSON.stringify(x)));
  const unexpected=run.calls.filter(x=>!['GET','HEAD'].includes(x.method));
  if(unexpected.length)report.errors.push('Uncontrolled mutations: '+JSON.stringify(unexpected));
  for(const gate of run.state.allGates)gate.release();
  await run.context.close();
}
async function capture(run,name,{full=false}={}) {
  const {page}=run,viewport=page.viewportSize();
  const pointerTarget=page.locator('#panel-dashboard2 .dashboard-page-header .dashboard-eyebrow');
  if(await pointerTarget.count()&&!await page.locator('#tli-lock-screen').isVisible())await pointerTarget.click();
  if(full){const height=await page.evaluate(()=>{const p=document.getElementById('panel-dashboard2');return Math.min(3400,Math.max(innerHeight,p.scrollHeight+180));});await page.setViewportSize({width:viewport.width,height});await page.evaluate(()=>{document.querySelector('.main-scroll')?.scrollTo(0,0);window.scrollTo(0,0);});}
  await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
  if(full)await page.setViewportSize(viewport);
}
async function visuals(browser) {
  const early=process.argv.includes('--early');
  for(const width of early?[1440,390]:[1440,1024,390,320])for(const theme of ['emeraldLight','midnight']){
    const run=await dashboardPage(browser,width,theme),{page}=run;
    for(const view of early?['healthy','critical']:['healthy','critical','stale','unknown','empty','unavailable']){
      await refresh(run,view);
      report.views.push({width,theme,view,narrator:await page.locator('#nd-statement-text').innerText(),meta:await page.locator('#nd-meta-line').innerText(),ai:await page.locator('#ndv-ai-val').innerText()});
      report.layouts.push({width,theme,view,...await measuredLayout(page,'panel-dashboard2')});
      report.contrast.push({width,theme,view,...await contrast(page,'panel-dashboard2')});
      if(width===1440&&['healthy','critical'].includes(view))await capture(run,`${view}-viewport-${width}-${theme}`);
      if([1440,390].includes(width))await capture(run,`${view}-${width}-${theme}`,{full:true});
    }
    await refresh(run,'critical');
    if(width===320){await page.locator('#narrator-preferences,.nd-shortcuts').evaluateAll(es=>es.forEach(e=>e.open=true));await page.waitForTimeout(50);await textScale(page,'panel-dashboard2',true);report.layouts.push({width,theme,view:'critical-text200',...await measuredLayout(page,'panel-dashboard2')});await capture(run,`text200-${width}-${theme}`,{full:true});await textScale(page,'panel-dashboard2',false);}
    await record(run);
  }
  if(early)return;
  for(const width of [1440,1024,390,320])for(const theme of ['emeraldLight','midnight']){
    const run=await dashboardPage(browser,width,theme,'loading');
    report.views.push({width,theme,view:'loading',narrator:await run.page.locator('#nd-statement-text').innerText()});
    report.layouts.push({width,theme,view:'loading',...await measuredLayout(run.page,'panel-dashboard2')});
    if([1440,390].includes(width))await capture(run,`loading-${width}-${theme}`,{full:true});
    run.state.loadingGate.release();run.state.loadingGate=null;
    await record(run);
  }
  for(const width of [1440,320]){
    const run=await dashboardPage(browser,width,'emeraldLight','critical'),{page}=run;
    await page.locator('.nd-shortcuts').evaluate(e=>e.open=true);
    const themes=await page.locator('#settings-theme option').evaluateAll(opts=>opts.filter(o=>o.value&&!o.disabled).map(o=>({value:o.value,label:o.textContent})));
    report.themes=themes;
    for(const theme of themes){await page.evaluate(t=>applyTheme(t),theme.value);report.layouts.push({width,theme:theme.value,view:'all-theme-critical',...await measuredLayout(page,'panel-dashboard2')});report.contrast.push({width,theme:theme.value,view:'all-theme-critical',...await contrast(page,'panel-dashboard2')});if(width===1440)await capture(run,`theme-${theme.value}`,{full:true});}
    await record(run);
  }
  for(const width of [1440,320]){
    const run=await dashboardPage(browser,width,'emeraldLight','critical'),{page,state}=run;
    const longPath='C:\\Users\\Synthetic\\'+('Long_project_archive_folder_'.repeat(20))+'\\notes.txt';
    state.summary.retained_events=Array.from({length:120},(_,i)=>({...state.summary.events[i%3],id:'fixture-large-'+i,title:i===0?longPath:state.summary.events[i%3].title}));
    state.summary.groups[0].title=longPath;state.places[0].target=longPath;
    await page.evaluate(async()=>{await TLIActivitySummary.refresh();await window.TLIPlaces?.refreshHome?.();});
    await page.locator('#activity-history-details summary').click();
    assert.equal(await page.locator('#activity-history > li').count(),120);
    report.layouts.push({width,theme:'emeraldLight',view:'120-events-long-paths',...await measuredLayout(page,'panel-dashboard2')});
    await capture(run,`long-paths-${width}-emeraldLight`);
    await record(run);
  }
}
async function waitCall(page,state,path,count=1,method='POST'){await page.waitForTimeout(80);assert.equal(state.calls.filter(c=>c.path===path&&c.method===method).length,count,`${method} ${path} count`);}
async function behaviors(browser){
  async function check(name,fn,{view='healthy'}={}){const run=await dashboardPage(browser,1440,'emeraldLight',view);try{await fn(run);report.behaviors.push({name,passed:true});}catch(e){report.behaviors.push({name,passed:false,error:e.stack});await capture(run,'failure-'+name.replace(/[^a-z0-9]+/gi,'-'));}finally{await record(run);}}
  await check('Opening Dashboard and its disclosures never executes or acknowledges',async({page,state,calls})=>{
    await page.locator('#narrator-preferences summary').click();await page.waitForTimeout(80);
    await page.locator('#activity-history-details summary').click();
    assert.equal(state.calls.filter(c=>!['GET','HEAD'].includes(c.method)).length,0);assert.equal(calls.filter(c=>!['GET','HEAD'].includes(c.method)).length,0);
    assert.match(await page.locator('#activity-groups').innerText(),/Storage scan partially completed/);
  });
  await check('Activity review is explicit and duplicate activation sends one request',async({page,state})=>{
    state.calls.length=0;const gate=state.defer('POST','/dashboard/activity-summary/review');await page.evaluate(()=>{const b=document.getElementById('activity-review');b.click();b.click();});await waitCall(page,state,'/dashboard/activity-summary/review');gate.release();await page.waitForFunction(()=>document.getElementById('activity-count').textContent.includes('No new'));assert.equal(state.calls.filter(c=>c.method==='POST').length,1);
  });
  await check('Failed activity refresh retains prior observations and prevents review',async({page,state})=>{
    const text=await page.locator('#activity-groups').innerText();state.fail('GET','/dashboard/activity-summary');await page.locator('#activity-refresh').click();await page.waitForFunction(()=>document.getElementById('activity-error').textContent.includes('Previous'));assert.equal(await page.locator('#activity-groups').innerText(),text);assert.equal(await page.locator('#activity-review').isDisabled(),true);
  });
  await check('Duplicate action confirmation sends one request and says panel opened',async({page,state})=>{
    state.calls.length=0;const gate=state.defer('POST','/dashboard/action/confirm');await page.evaluate(()=>{const b=document.getElementById('ac-confirm-btn');b.dispatchEvent(new MouseEvent('click',{bubbles:true}));b.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await waitCall(page,state,'/dashboard/action/confirm');await capture({page},'pending-action-1440-emeraldLight');gate.release();await page.waitForFunction(()=>!document.getElementById('panel-visualizer').hidden);assert.equal(state.calls.filter(c=>c.path==='/dashboard/action/confirm').length,1);assert.equal(state.calls.filter(c=>/cleanup.*execute/.test(c.path)).length,0);
  },{view:'critical'});
  await check('Failed action stays available for explicit retry without navigation',async({page,state})=>{
    state.calls.length=0;state.fail('POST','/dashboard/action/confirm',200,{ok:false,receipt:{ok:false,narrator_msg:'Storage review failed. No files were changed.'}});await page.locator('#ac-confirm-btn').click();await page.waitForTimeout(850);assert.equal(await page.locator('#panel-dashboard2').isVisible(),true);assert.equal(await page.locator('#ac-confirm-btn').isEnabled(),true);assert.match(await page.locator('body').innerText(),/Storage review failed/);await capture({page},'failed-action-1440-emeraldLight');assert.equal(state.calls.filter(c=>c.path==='/dashboard/action/confirm').length,1);
  },{view:'critical'});
  await check('Failed dismiss retains the pending action',async({page,state})=>{
    state.fail('POST','/dashboard/action/dismiss',503,{ok:false,detail:'Action could not be dismissed.'});await page.locator('#ac-dismiss-btn').click();await page.waitForTimeout(700);assert.equal(await page.locator('#ac-confirm-btn').isVisible(),true);assert.match(await page.locator('body').innerText(),/could not be dismissed/);
  },{view:'critical'});
  await check('Partial completion remains a failed result with the requested step details',async({page,state})=>{
    state.fail('POST','/dashboard/action/confirm',200,{ok:false,receipt:{ok:false,narrator_msg:'1 of 2 cleanup steps completed; 1 failed. Review before retrying.',results:[{ok:true,step:'Synthetic cache one'},{ok:false,step:'Synthetic cache two',error:'Permission denied'}]}});await page.locator('#ac-confirm-btn').click();await page.waitForFunction(()=>document.getElementById('ac-result')?.textContent.includes('1 of 2'));assert.equal(await page.locator('#ac-confirm-btn').isEnabled(),true);assert.equal(await page.locator('#panel-dashboard2').isVisible(),true);await capture({page},'partial-action-1440-emeraldLight');
  },{view:'critical'});
  await check('Failed secondary action reports failure and does not navigate',async({page,state})=>{
    state.fail('POST','/dashboard/action/secondary',200,{ok:false,receipt:{error:'Synthetic details could not be opened.'}});await page.locator('#ac-secondary-btn').click();await page.waitForFunction(()=>document.getElementById('ac-result')?.textContent.includes('could not be opened'));assert.equal(await page.locator('#ac-secondary-btn').isEnabled(),true);assert.equal(await page.locator('#panel-dashboard2').isVisible(),true);
  },{view:'critical'});
  await check('Delayed command-center response cannot resurrect a dismissed action',async({page,state})=>{
    state.calls.length=0;const gate=state.defer('GET','/dashboard/command-center');await page.evaluate(()=>{window.__fixtureRefresh=TLIDash2.refresh();});await waitCall(page,state,'/dashboard/command-center',1,'GET');await page.locator('#ac-dismiss-btn').click();await page.waitForFunction(()=>!document.getElementById('ac-confirm-btn'));await page.waitForTimeout(700);gate.release();await page.evaluate(()=>window.__fixtureRefresh);await page.waitForTimeout(80);assert.equal(await page.locator('#ac-confirm-btn').count(),0);
  },{view:'critical'});
  await check('Legacy health fallback does not clear a retained action',async({page,state})=>{
    state.fail('GET','/dashboard/command-center');await page.evaluate(()=>TLIDash2.refresh());assert.equal(await page.locator('#ac-confirm-btn').isVisible(),true);assert.match(await page.locator('#nd-action-card').innerText(),/Review storage/);
  },{view:'critical'});
  await check('Late activity response cannot repopulate a locked session',async({page,state})=>{
    const gate=state.defer('GET','/dashboard/activity-summary');await page.locator('#activity-refresh').click();await page.waitForTimeout(60);state.locked=true;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));gate.release();await page.waitForTimeout(120);assert.equal(await page.locator('#activity-groups').innerText(),'');assert.equal(await page.locator('#activity-history').innerText(),'');assert.match(await page.locator('#activity-error').innerText(),/Unlock TLI/);
  });
  await check('Locked session clears pending action and refuses delayed action results',async({page,state})=>{
    const gate=state.defer('POST','/dashboard/action/confirm');await page.locator('#ac-confirm-btn').click();await page.waitForTimeout(80);state.locked=true;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));gate.release();await page.waitForTimeout(650);assert.equal(await page.locator('#panel-visualizer').isVisible(),false);assert.equal(await page.locator('#ac-confirm-btn').count(),0);
  },{view:'critical'});
  await check('Unknown measurements are not zero or a confirmed AI outage',async({page})=>{assert.doesNotMatch(await page.locator('#ndv-storage-val').innerText(),/^0(?:\.|%)/);assert.match(await page.locator('#ndv-ai-val').innerText(),/unknown|not confirmed|unavailable/i);assert.match(await page.locator('#nd-meta-line').innerText(),/unknown|unavailable|incomplete/i);},{view:'unknown'});
  await check('An unavailable first read is not described as previous measured results',async({page})=>{assert.doesNotMatch(await page.locator('#nd-meta-line').innerText(),/previous|last check|last successful/i);assert.match(await page.locator('#ndv-ai-val').innerText(),/unknown|not confirmed|unavailable/i);assert.doesNotMatch(await page.locator('#ndv-storage-val').innerText(),/^0(?:\.|%)/);},{view:'unavailable'});
  await check('Stale observation time remains visible',async({page})=>{assert.match(await page.locator('#nd-meta-line').innerText(),/stale/i);assert.match(await page.locator('#nd-meta-line').innerText(),/\d{1,2}:\d{2}/);},{view:'stale'});
  await check('Narrator severity escalation updates even when the wording stays the same',async({page})=>{
    await page.evaluate(()=>TLIDash2.setEventMessage({type:'alert',text:'Synthetic warning with unchanged wording.',severity:'warning',timestamp:Date.now()/1000+1}));await page.waitForTimeout(450);
    await page.evaluate(()=>TLIDash2.setEventMessage({type:'alert',text:'Synthetic warning with unchanged wording.',severity:'critical',timestamp:Date.now()/1000+2}));await page.waitForTimeout(450);assert.equal(await page.locator('#nd-msg-severity').getAttribute('data-severity'),'critical');
  });
  await check('New activity offers refresh without acknowledging or replacing the summary',async({page,state})=>{
    const text=await page.locator('#activity-groups').innerText();state.calls.length=0;await page.evaluate(()=>document.dispatchEvent(new CustomEvent('tli-activity-event',{detail:{stream_id:'synthetic-dashboard',sequence:8}})));assert.equal(await page.locator('#activity-new').isVisible(),true);assert.equal(await page.locator('#activity-groups').innerText(),text);assert.equal(state.calls.filter(c=>c.path.includes('activity-summary')).length,0);
  });
  await check('Saved places opens privately and Escape returns focus without action',async({page,state})=>{
    const button=page.getByRole('button',{name:/Open saved places|Manage saved places|Browse saved places/i}).first();await button.click();await page.waitForFunction(()=>document.getElementById('places-dialog').open);assert.equal(state.calls.filter(c=>!['GET','HEAD'].includes(c.method)).length,0);await page.keyboard.press('Escape');assert.equal(await page.locator('#places-dialog').evaluate(e=>e.open),false);await page.waitForTimeout(120);assert.equal(await button.evaluate(e=>e===document.activeElement),true);
  });
  await check('Real PIN lock clears the Dashboard and successful unlock resumes observations',async({page,state})=>{
    await page.locator('#tli-lock-btn').click();await page.waitForFunction(()=>!document.getElementById('tli-lock-screen').classList.contains('hidden'));
    await waitCall(page,state,'/system/pin/lock');assert.equal(await page.locator('#activity-groups').innerText(),'');await capture({page},'locked-1440-emeraldLight');
    await page.locator('#tli-lock-input').fill('2468');await page.locator('#tli-lock-submit').click();await page.waitForFunction(()=>document.getElementById('tli-lock-screen').classList.contains('hidden'));
    await page.waitForFunction(()=>document.getElementById('ndv-node-val').textContent==='Studio',undefined,{timeout:5000});assert.equal(state.calls.filter(c=>c.path==='/dashboard/activity-summary/review').length,0);
  });
  await check('Ask TLI and storage navigation open views without sending or scanning',async({page,state,calls})=>{
    state.calls.length=0;calls.length=0;await page.locator('#home-launchpad .home-ask').click();assert.equal(await page.locator('#panel-main').isVisible(),true);assert.equal(await page.locator('#chat-input').inputValue(),'');await page.evaluate(()=>switchPanel('panel-dashboard2'));await page.waitForTimeout(100);
    if(await page.locator('#premium-status-storage').isVisible()) { await page.locator('#premium-status-storage').click();await page.locator('#premium-status-dialog > button').click(); }
    else await page.locator('#nd-storage-vital-tile').click();
    assert.equal(await page.locator('#panel-visualizer').isVisible(),true);assert.equal(await page.locator('#visualizerPathInput').inputValue(),'C:\\');assert.equal([...state.calls,...calls].filter(c=>!['GET','HEAD'].includes(c.method)||/^\/visualizer\/(scan|large-files|duplicates)$/.test(c.path)).length,0);
  },{view:'critical'});
  await check('Dashboard favorite opens its review without checking or scanning the location',async({page,state,calls})=>{
    state.calls.length=0;calls.length=0;await page.locator('.places-home-entry').first().click();await page.waitForFunction(()=>document.getElementById('places-dialog').open);await page.waitForFunction(()=>document.getElementById('places-status').textContent.includes('has not been checked'));assert.equal([...state.calls,...calls].filter(c=>!['GET','HEAD'].includes(c.method)||/^\/visualizer\/(scan|large-files|duplicates)$/.test(c.path)).length,0);
  });
  await check('More shortcuts reveals useful navigation without running the suggestion',async({page,state,calls})=>{
    await page.locator('.nd-shortcuts summary').click();assert.ok(await page.locator('#nd-actions button:visible').count());const suggestion=page.locator('#nd-suggestions button').filter({hasText:/Free Space|storage/i}).first();assert.equal(await suggestion.isVisible(),true);state.calls.length=0;calls.length=0;await suggestion.click();assert.equal(await page.locator('#panel-visualizer').isVisible(),true);assert.equal([...state.calls,...calls].filter(c=>!['GET','HEAD'].includes(c.method)||/^\/visualizer\/(scan|large-files|duplicates)$/.test(c.path)).length,0);
  },{view:'critical'});
}
function gallery() {
 const before='before-2026-09-07T23-01-16-620Z',after=path.basename(output);
 const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TLI Dashboard — before & after</title><style>
 *{box-sizing:border-box}body{margin:0;background:#f2f5f4;color:#17332c;font:15px/1.6 system-ui,sans-serif}header,main,footer{max-width:1700px;margin:auto;padding:30px}header{padding-top:55px}h1{font-size:clamp(28px,4vw,44px);line-height:1.15;letter-spacing:-.045em;margin:12px 0}p{max-width:850px;color:#49635b}.eyebrow{font-size:11px;letter-spacing:.17em;font-weight:650;color:#157b5e}.toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:14px;margin-top:28px}label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:600}select{min-height:42px;background:white;border:1px solid #bbcfc7;border-radius:9px;padding:7px 13px;color:#17332c;font:inherit}a{color:#096b50}select:focus-visible,a:focus-visible{outline:3px solid #087957;outline-offset:4px}.badge{border-radius:8px;background:#e0ede7;padding:10px 14px;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}.shot{min-width:0;background:white;border:1px solid #d0ded7;border-radius:15px;overflow:hidden}.shot h2{font-size:16px;margin:0;padding:15px 20px;border-bottom:1px solid #d0ded7}.shot img{display:block;width:100%;height:auto;margin:auto}.shot.phone img{max-width:390px}.links{display:flex;flex-wrap:wrap;gap:20px;font-size:13px}footer{font-size:13px;color:#49635b}details{margin-top:20px}summary{cursor:pointer}code{overflow-wrap:anywhere}button,select,a{touch-action:manipulation}@media(max-width:750px){header,main,footer{padding:20px}.grid{grid-template-columns:1fr}header{padding-top:35px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
 </style><header><div class="eyebrow">TLI · ANNIVERSARY WORKSPACE</div><h1>Your home, brought into focus.</h1><p>A single place for the Narrator and its next useful action. Clearer observed health, readable activity and the places you choose to save.</p><div class="toolbar"><label>Situation<select id="situation"><option value="critical">Storage needs attention</option><option value="healthy">Latest checks received</option><option value="stale">Stale measurements</option><option value="unknown">Unknown monitoring</option><option value="unavailable">Refresh unavailable</option></select></label><label>Appearance<select id="appearance"><option value="emeraldLight">Emerald Light</option><option value="midnight">Midnight</option></select></label><label>Browser width<select id="width"><option value="1440">Desktop · 1440px</option><option value="390">Phone fixture · 390px</option></select></label><span class="badge">${report.themes.length} themes · ${report.layouts.length} layout checks · ${report.behaviors.length} behavior checks passed</span></div></header><main><div class="grid"><section class="shot" id="before-shot"><h2>Before</h2><a id="before-link"><img id="before-image" alt="Previous TLI Dashboard with synthetic data"></a></section><section class="shot" id="after-shot"><h2>After</h2><a id="after-link"><img id="after-image" alt="Updated TLI Dashboard with synthetic data"></a></section></div></main><footer><p>Every host, model, file, device and activity response in these images is synthetic. This review did not restart TLI or access household data.</p><div class="links"><a href="${after}/critical-viewport-1440-emeraldLight.png">Compact desktop preview</a><a href="${after}/text200-320-emeraldLight.png">320px with enlarged text</a><a href="${after}/report.json">Complete candidate coverage and source hashes</a><a href="${before}/report.json">Baseline findings</a></div><details><summary>What this verifies</summary><p>Headless Edge browser fixtures verify rendering, keyboard dialogs, truthful failure and partial receipts, explicit review, duplicate requests, lock races and safe navigation. Physical phones, screen readers and native-platform installation are not part of this browser acceptance.</p></details></footer><script>
 const controls=['situation','appearance','width'].map(id=>document.getElementById(id));function show(){const[state,theme,width]=controls.map(e=>e.value);for(const[side,dir]of[['before','${before}'],['after','${after}']]){const src=dir+'/'+state+'-'+width+'-'+theme+'.png';document.getElementById(side+'-image').src=src;document.getElementById(side+'-link').href=src;document.getElementById(side+'-shot').classList.toggle('phone',width==='390')}}controls.forEach(e=>e.addEventListener('change',show));show();</script></html>`;
 fs.writeFileSync(path.resolve(output,'../review.html'),html);
}
async function main(){const browser=await chromium.launch({channel:'msedge',headless:true});report.browser={engine:'Microsoft Edge / Chromium',version:browser.version(),reducedMotion:true};try{if(!process.argv.includes('--behaviors-only'))await visuals(browser);if(!process.argv.includes('--visuals-only'))await behaviors(browser);}finally{await browser.close();}
 report.hashesAtEnd=fingerprintFiles(source);report.sourceUnchanged=JSON.stringify(report.hashesAtStart)===JSON.stringify(report.hashesAtEnd);
 report.summary={views:report.views.length,themeCount:report.themes.length,layouts:report.layouts.length,overflow:report.layouts.filter(r=>r.overflow.length||r.documentWidth>r.width+2).length,contrastFailures:report.contrast.reduce((n,r)=>n+r.findings.length,0),visualReview:report.contrast.reduce((n,r)=>n+r.review.length,0),behaviors:report.behaviors.length,failedBehaviors:report.behaviors.filter(r=>!r.passed).length,errors:report.errors.length,sourceUnchanged:report.sourceUnchanged};
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report.summary}));
 if(!baseline){assert.equal(report.summary.overflow,0,'Dashboard overflow');assert.equal(report.summary.failedBehaviors,0,'Dashboard behavioral failures');assert.equal(report.errors.length,0,'Browser errors or unintended operations');assert.equal(report.sourceUnchanged,true,'Source changed during verification');assert.equal(report.summary.contrastFailures,0,'Text contrast failures');if(report.themes.length&&report.behaviors.length&&!process.argv.includes('--no-gallery'))gallery();}}
module.exports = {dashboardPage, command, activity};
if(require.main===module) main().catch(error=>{fs.writeFileSync(path.join(output,'error.txt'),error.stack);console.error(error);process.exitCode=1;});
