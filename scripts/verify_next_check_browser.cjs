/* Full current SPA against real-handler synthetic envelopes; no live services. */
'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {makePage,layout,fingerprintFiles,source}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),index=process.argv.indexOf('--output');
const output=path.resolve(index<0?path.join(root,'build_work/workspace-cohesion/next-check-browser-'+new Date().toISOString().replace(/[:.]/g,'-')):process.argv[index+1]);
fs.mkdirSync(output,{recursive:true});
const fixturePath=path.join(root,'frontend/tests/fixtures/next-check.json'),fixture=JSON.parse(fs.readFileSync(fixturePath));
assert.equal(fixture.synthetic_only,true);
const clone=v=>structuredClone(v),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const record={schema_version:1,synthetic_only:true,source,source_before:fingerprintFiles(source),fixture:{path:fixturePath,sha256:hash(fixturePath)},checks:[],layouts:[],screens:[],errors:[],limitations:['All TLI endpoints intercepted on tli-ui.test. No real account, store, network diagnostic, model or peer used.','The fixture is an actual isolated backend response. Browser interception does not replace backend source/revision/run tests.']};
const pass=name=>{record.checks.push({name,passed:true});console.log(JSON.stringify({check:name,passed:true}));};
const envelope=data=>({ok:true,protocol:'tli-cases-v1',checked_at:fixture.response.checked_at,actions_performed:false,...data});
const normalized=ref=>({id:ref.id,revision:ref.revision,step_ids:ref.step_ids||[],include_resolution:ref.include_resolution||false,evidence_refs:ref.evidence_refs||[],report_refs:ref.report_refs||[]});
async function setup(browser,{openCase=true}={}){
 const run=await makePage(browser,1440,'emeraldLight'),calls=[],state={guidance:'ok',check:'ok',link:'fail',release:null};
 const report={id:'fixture-new-report',kind:'system',host:fixture.response.guidance.check_options.host,target:null,created_at:fixture.response.checked_at,internet_checks:false,scope:'A synthetic host CPU/RAM observation; no repair.',checks:[{id:'cpu',label:'Host CPU',status:'pass',detail:'0 percent recorded; not current health.'}]};
 await run.page.route('**/api/intelligence/**',async route=>{
  const request=route.request(),url=new URL(request.url()),p=url.pathname,method=request.method(),body=method==='GET'?null:request.postDataJSON();
  if(!p.startsWith('/api/intelligence/cases')&&!p.startsWith('/api/intelligence/diagnostics')&&p!=='/api/intelligence/devices')return route.fallback();
  calls.push({path:p,method,body});const send=(data,status=200)=>route.fulfill({status,json:data});
  if(p==='/api/intelligence/devices')return send({devices:[{id:fixture.case.computer.id,name:fixture.case.computer.name,kind:'computer',source:'local_node',source_id:fixture.response.guidance.check_options.host.id}]});
  if(p.endsWith('/cases/capabilities'))return send(envelope({case_context:'tli-case-context-v1',case_report_context:'tli-case-report-context-v1',max_case_reports:1,next_check:'tli-case-next-check-v1'}));
  if(p==='/api/intelligence/cases'&&method==='GET')return send(envelope({items:[fixture.case],total:1}));
  if(p==='/api/intelligence/cases/'+fixture.case.id&&method==='GET')return send(envelope({case:fixture.case}));
  if(p==='/api/intelligence/cases/context-review')return send(envelope({case_report_context:'tli-case-report-context-v1',case_context:fixture.response.case_context,evidence_context:fixture.response.evidence_context}));
  if(p==='/api/intelligence/cases/next-check'){
   assert.deepEqual(normalized(body.case_ref),normalized(fixture.request.case_ref));const mode=state.guidance;
   if(mode==='hold')await new Promise(resolve=>state.release=resolve);
   if(mode==='conflict')return send({detail:'The selected case or report changed. Review again; nothing ran.'},409);
   const data=clone(fixture.response);if(mode==='scope')data.guidance.check_options.options[0].scope_revision='f'.repeat(64);
   return send(data);
  }
  if(p==='/api/intelligence/diagnostics'&&method==='POST'){
   for(const key of ['kind','target_id','internet','expected_host_id','expected_scope','next_check_ref'])assert.deepEqual(body[key],fixture.diagnostic_request[key]);assert.ok(body.request_id);
   const mode=state.check;if(mode==='hold')await new Promise(resolve=>state.release=resolve);
   if(mode==='fail')return send({detail:'Synthetic unavailable observation; no retry.'},503);return send(report);
  }
  if(p==='/api/intelligence/cases/evidence/review')return send({detail:'Synthetic link conflict; report remains saved.'},409);
  if(p==='/api/intelligence/diagnostics/options')return send(fixture.response.guidance.check_options);
  throw new Error('Unreviewed fixture operation: '+method+' '+p);
 });
 await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});run.page.setDefaultTimeout(8000);
 await run.page.waitForFunction(()=>window.TLITroubleshooting&&window.TLICaseContext&&window.TLIInterface);
 await run.page.evaluate(()=>switchPanel('panel-troubleshooting'));
 await run.page.locator('#troubleshooting-symptom').waitFor();if(openCase)await run.page.getByRole('button',{name:fixture.case.title,exact:true}).click();
 await run.page.locator('#troubleshooting-next').waitFor();
 return {...run,calls,state,report};
}
async function prepare(run){
 const p=run.page;await p.locator('.troubleshooting-selection>summary').click();
 for(const id of fixture.request.case_ref.step_ids){const step=fixture.case.steps.find(s=>s.id===id);await p.locator('.troubleshooting-selection').getByLabel(step.status+': '+step.text,{exact:true}).check();}
 if(fixture.request.case_ref.include_resolution)await p.getByLabel('Include my recorded resolution',{exact:true}).check();
 for(const ref of fixture.request.case_ref.evidence_refs){const item=fixture.case.evidence.find(e=>e.id===ref.id);await p.locator('.troubleshooting-selection').getByLabel(`${item.label} · ${item.availability} · description only`,{exact:true}).check();}
 for(const ref of fixture.request.case_ref.report_refs||[]){const item=fixture.case.evidence.find(e=>e.id===ref.id);await p.locator('.troubleshooting-selection').getByLabel('Recorded facts: '+item.label,{exact:true}).check();}
 assert.equal(run.calls.filter(c=>c.method!=='GET').length,0);
 await p.locator('#troubleshooting-next').click();await p.locator('.troubleshooting-next-check').waitFor();
 assert.equal(await p.locator('#case-context-dialog').evaluate(e=>e.open),false);
 assert.equal(await p.evaluate(()=>TLICaseContext.describeContext().length),0);
 await p.locator('.troubleshooting-selection>summary').click();
}

const runs=run=>run.calls.filter(c=>c.path==='/api/intelligence/diagnostics'&&c.method==='POST').length;
async function checkLayout(run,meta){
 const result=await layout(run.page,'troubleshooting-editor');
 const extra=await run.page.evaluate(()=>{
  const box=document.getElementById('troubleshooting-editor'),controls=[...box.querySelectorAll('button,input,select,textarea')].filter(e=>e.checkVisibility({visibilityProperty:true}));
  const overlaps=[];for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){const a=controls[i].getBoundingClientRect(),b=controls[j].getBoundingClientRect();if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>3&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>3)overlaps.push([controls[i].textContent,controls[j].textContent]);}
  return{theme:document.documentElement.dataset.theme,interface:document.documentElement.dataset.interface,overlaps,scroll:box.scrollWidth,width:box.clientWidth};
 });
 assert.equal(extra.theme,meta.theme);assert.equal(extra.interface,meta.interface);assert.deepEqual(extra.overlaps,[]);assert.deepEqual(result.overflow,[]);assert.deepEqual(result.duplicateIds,[]);assert.ok(result.documentWidth<=result.width+2);assert.ok(extra.scroll<=extra.width+2);
 record.layouts.push({...meta,...result,...extra});
}
async function screenshot(run,name,anchor='#troubleshooting-editor'){
 if(anchor)await run.page.locator(anchor).first().evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));const file=name+'.png';await run.page.screenshot({path:path.join(output,file)});record.screens.push({path:file,sha256:hash(path.join(output,file)),anchor});
}
async function matrix(run){
 const themes=await run.page.locator('#settings-theme option').evaluateAll(rows=>rows.map(r=>r.value).filter(Boolean));assert.equal(themes.length,23);record.themes=themes;
 for(const style of ['modern','classic'])for(const theme of themes)for(const width of [2500,1440,768,390,320]){
  await run.page.setViewportSize({width,height:1000});await run.page.evaluate(({style,theme})=>{TLIInterface.set(style);applyTheme(theme);},{style,theme});
  await checkLayout(run,{theme,interface:style,width,enlarged:false});
  if(['emeraldLight','midnight'].includes(theme)){
   await screenshot(run,`guidance-${style}-${theme}-${width}`);
   if([1440,320].includes(width)){
    await screenshot(run,`guidance-${style}-${theme}-${width}-missing`,'.troubleshooting-next-check h5:has-text("Missing")');
    await screenshot(run,`guidance-${style}-${theme}-${width}-suggestion`,'.troubleshooting-check-review');
   }
  }
 }
 for(const style of ['modern','classic'])for(const theme of ['emeraldLight','midnight']){
  await run.page.setViewportSize({width:320,height:1000});await run.page.emulateMedia({reducedMotion:'reduce'});
  await run.page.evaluate(({style,theme})=>{TLIInterface.set(style);applyTheme(theme);const root=document.getElementById('troubleshooting-guided-checks');window.__nextScale=[root,...root.querySelectorAll('*')].map(e=>({e,old:e.getAttribute('style'),size:parseFloat(getComputedStyle(e).fontSize)}));window.__nextScale.forEach(({e,size})=>e.style.fontSize=(2*size)+'px');},{style,theme});
  await checkLayout(run,{theme,interface:style,width:320,enlarged:true,textScale:2,reducedMotion:true});await screenshot(run,`guidance-${style}-${theme}-320-enlarged`);
  await run.page.evaluate(()=>{window.__nextScale.forEach(({e,old})=>old===null?e.removeAttribute('style'):e.setAttribute('style',old));delete window.__nextScale;});
 }
 pass('Known/Missing/attempts and suggested scope fit both interfaces, 23 themes, five widths and enlarged text');
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const first=await setup(browser,{openCase:false});assert.equal(await first.page.locator('#troubleshooting-symptom').inputValue(),'');assert.equal(await first.page.locator('#troubleshooting-computer').inputValue(),'');assert.equal(first.calls.filter(c=>c.method!=='GET').length,0);assert.equal(await first.page.locator('.troubleshooting-find').evaluate(e=>e.open),false);
  for(const style of ['modern','classic'])for(const theme of ['emeraldLight','midnight'])for(const width of [2500,1440,768,390,320]){await first.page.setViewportSize({width,height:1000});await first.page.evaluate(({style,theme})=>{TLIInterface.set(style);applyTheme(theme);},{style,theme});await checkLayout(first,{theme,interface:style,width,first_open:true});
   const firstView=await first.page.evaluate(()=>{document.querySelector('.main-scroll').scrollTo({top:0,left:0,behavior:'instant'});const box=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right};};return{symptom:box(document.getElementById('troubleshooting-symptom')),editor:box(document.getElementById('troubleshooting-editor')),browser:box(document.querySelector('.troubleshooting-browser')),height:innerHeight,privacyOpen:document.querySelector('.troubleshooting-privacy').open,editorFirst:document.querySelector('.troubleshooting-grid').firstElementChild.id==='troubleshooting-editor'};});
   assert.equal(firstView.privacyOpen,false);assert.equal(firstView.editorFirst,true);assert.ok(firstView.symptom.top>=0&&firstView.symptom.bottom<=firstView.height,'Initial symptom must be visible before scrolling');
   if(width<=768)assert.ok(firstView.editor.bottom<=firstView.browser.top,'Mobile editor precedes saved browser');else assert.ok(firstView.browser.right<=firstView.editor.left,'Desktop retains saved browser on left');
   await screenshot(first,`start-${style}-${theme}-${width}`,null);}
  assert.equal(first.calls.filter(c=>c.method!=='GET').length,0);pass('First open shows an empty unsaved symptom and computer form; saved search is secondary and no mutation or check runs');record.errors.push(...first.errors);await first.context.close();
  let run=await setup(browser);assert.equal(run.calls.filter(c=>c.method!=='GET').length,0);
  await run.page.evaluate(()=>document.getElementById('chat-input').value='Keep my unsent question.');await prepare(run);
  assert.equal(runs(run),0);assert.equal(await run.page.locator('#chat-input').inputValue(),'Keep my unsent question.');
  assert.ok((await run.page.locator('.troubleshooting-next-check').innerText()).includes('Stutter continued.'));pass('Explicit reviewed selection produces guidance without Chat, execution, save or draft loss');
  assert.equal(await run.page.getByRole('button',{name:'Review suggested check',exact:true}).count(),0);await run.page.getByRole('button',{name:'Run this check',exact:true}).waitFor();assert.equal(runs(run),0);
  const other=run.page.locator('.troubleshooting-check-alternatives'),beforeDisclosure=run.calls.length;
  assert.equal(await other.evaluate(e=>e.open),false);assert.equal(await other.getByRole('button',{name:'Review this check'}).first().isVisible(),false);
  await other.locator('summary').focus();await run.page.keyboard.press('Enter');assert.equal(await other.evaluate(e=>e.open),true);assert.equal(run.calls.length,beforeDisclosure);
  await run.page.keyboard.press('Enter');assert.equal(await other.evaluate(e=>e.open),false);assert.equal(run.calls.length,beforeDisclosure);
  pass('Suggested Run review is primary; keyboard disclosure of alternatives performs no request');
  await run.page.getByRole('button',{name:'Run this check',exact:true}).click();await run.page.locator('.troubleshooting-check-report').waitFor();assert.equal(runs(run),1);
  await run.page.getByRole('button',{name:'Add report link to this draft',exact:true}).click();await run.page.waitForFunction(()=>document.querySelector('.troubleshooting-check-status').textContent.includes('link not saved'));assert.equal(runs(run),1);pass('Suggested observation uses one existing bound request; failed separate link retains report and never reruns');
  record.errors.push(...run.errors);await run.context.close();
  for(const mode of ['conflict','scope','lock']){
   run=await setup(browser);await prepare(run);assert.equal(await run.page.getByRole('button',{name:'Review suggested check',exact:true}).count(),0);await run.page.getByRole('button',{name:'Run this check',exact:true}).waitFor();
   run.state.guidance=mode==='lock'?'hold':mode;await run.page.getByRole('button',{name:'Run this check',exact:true}).click();
   if(mode==='lock'){await run.page.waitForTimeout(30);assert.ok(run.state.release);await run.page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));run.state.release();await run.page.waitForTimeout(60);assert.equal(await run.page.locator('.troubleshooting-next-check').count(),0);}
   else{await run.page.waitForFunction(()=>document.querySelector('.troubleshooting-check-status').textContent.includes('No check was requested'));assert.ok(await run.page.locator('.troubleshooting-next-check').isVisible());}
   assert.equal(runs(run),0);pass(mode+': final preflight prevents stale execution and preserves/clears the correct private state');record.errors.push(...run.errors);await run.context.close();
  }
  run=await setup(browser);await prepare(run);assert.equal(await run.page.getByRole('button',{name:'Review suggested check',exact:true}).count(),0);await run.page.getByRole('button',{name:'Run this check',exact:true}).waitFor();
  await run.page.setViewportSize({width:320,height:1000});await run.page.locator('.troubleshooting-next-check>details>summary').click();const table=run.page.locator('.troubleshooting-next-check .report-facts-table-scroll');await table.focus();await table.evaluate(e=>e.scrollLeft=0);await run.page.keyboard.press('ArrowRight');await run.page.waitForFunction(()=>document.querySelector('.troubleshooting-next-check .report-facts-table-scroll').scrollLeft>0);pass('Full report columns remain reachable with keyboard on a narrow phone');
  await run.page.locator('.troubleshooting-next-check>details>summary').click();await matrix(run);record.errors.push(...run.errors);await run.context.close();assert.deepEqual(record.errors,[]);record.passed=true;
 }catch(error){record.passed=false;record.failure=String(error.stack||error);process.exitCode=1;}
 finally{record.source_after=fingerprintFiles(source);record.source_changed=JSON.stringify(record.source_before)!==JSON.stringify(record.source_after);if(record.source_changed){record.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(record,null,2));await browser.close();console.log(JSON.stringify({output,passed:record.passed,checks:record.checks.length,layouts:record.layouts.length,screens:record.screens.length,source_changed:record.source_changed,failure:record.failure}));}
})();
