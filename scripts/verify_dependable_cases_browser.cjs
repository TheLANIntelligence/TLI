/* Actual SPA, isolated synthetic case/report/peer envelopes. Never live services. */
'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {makePage,layout,fingerprintFiles,source}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const before=process.argv.includes('--before'),output=path.resolve(arg('--output')||path.join(root,'build_work/dependable-computers',(before?'cases-before-':'cases-browser-')+new Date().toISOString().replace(/[:.]/g,'-')));
fs.mkdirSync(output,{recursive:true});
const fixtureRoot=path.join(root,'build_work/dependable-computers/fixtures');
const paths=['case-report-preview.json','peer-guided-report.json'];
const [caseFixture,peerFixture]=paths.map(p=>JSON.parse(fs.readFileSync(path.join(fixtureRoot,p),'utf8')));
assert.equal(caseFixture.synthetic,true);assert.equal(peerFixture.synthetic,true);
const clone=v=>JSON.parse(JSON.stringify(v));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const record={schema_version:1,synthetic:true,source,source_before:fingerprintFiles(source),fixtures:paths.map(p=>({path:path.join(fixtureRoot,p),sha256:hash(path.join(fixtureRoot,p))})),checks:[],layouts:[],screens:[],errors:[],before,
  limitations:['Intercepted SPA fixtures, not a live TLI server or physical phone.','No inference, peer transport, repair, real saved record, or actual account was used.','Browser fixture receipts derive from actual isolated-route synthetic envelopes; backend behavior is covered separately by route tests.']};
const pass=name=>{record.checks.push({name,passed:true});console.log(JSON.stringify({check:name,passed:true}));};
const envelope=data=>({ok:true,protocol:'tli-cases-v1',checked_at:new Date().toISOString(),actions_performed:false,...data});
function prepared(row,request){
 const ref=request.case_ref,base=clone(caseFixture.response),known=new Map(row.evidence.map(l=>[l.id,l]));
 assert.equal(ref.id,row.id);assert.equal(ref.revision,row.revision);assert.equal(ref.report_refs.length,1);
 assert.equal(ref.report_refs[0].id,caseFixture.request.case_ref.report_refs[0].id);assert.equal(ref.report_refs[0].revision,caseFixture.request.case_ref.report_refs[0].revision);
 assert.ok(ref.evidence_refs.some(l=>l.id===ref.report_refs[0].id&&l.revision===ref.report_refs[0].revision));
 assert.ok(ref.step_ids.every(id=>row.steps.some(s=>s.id===id)));
 Object.assign(base.case_context,{id:row.id,title:row.title,revision:row.revision,computer_id:row.computer?.id||null,
  steps:ref.step_ids.map(id=>({id,status:row.steps.find(s=>s.id===id).status})),omitted_step_count:row.steps.length-ref.step_ids.length,
  resolution_included:ref.include_resolution,evidence_links:ref.evidence_refs.map(l=>({...known.get(l.id),...l,message_index:l.message_index??null})),omitted_link_count:row.evidence.length-ref.evidence_refs.length});
 return base;
}
async function setup(browser){
 const run=await makePage(browser,1440,'emeraldLight'),calls=[],state={row:clone(caseFixture.case),preview:'ok',check:'ok',link:'ok',save:'ok',release:null};
 await run.page.route('**/api/intelligence/**',async route=>{
  const request=route.request(),url=new URL(request.url()),p=url.pathname,method=request.method(),body=method==='GET'?null:request.postDataJSON();
  const fulfill=(data,status=200)=>route.fulfill({status,json:data});
  const handled=p==='/api/intelligence/devices'||p.startsWith('/api/intelligence/cases')||p.startsWith('/api/intelligence/diagnostics');
  if(!handled)return route.fallback();calls.push({path:p,method,body});
  if(p==='/api/intelligence/devices')return fulfill({devices:[{id:'node-host',name:'Requesting host',kind:'computer',source:'local_node',source_id:'host'},
    {id:'peer',name:'Selected other computer',kind:'computer',source:'mesh',source_id:peerFixture.response.host.id,node_id:peerFixture.response.host.id}]});
  if(p.endsWith('/cases/capabilities'))return fulfill(envelope({case_context:'tli-case-context-v1',case_report_context:'tli-case-report-context-v1',max_case_reports:1}));
  if(p==='/api/intelligence/cases/context-review'){
   const mode=state.preview;if(mode==='hold')await new Promise(resolve=>state.release=resolve);
   if(mode==='conflict')return fulfill({detail:'This selected report changed. Your selection was not sent.'},409);
   if(mode==='expired')return fulfill({detail:'Synthetic session expired.'},401);
   return fulfill(prepared(state.row,body));
  }
  if(p==='/api/intelligence/cases/evidence/review'){
   assert.equal(body.kind,'report');assert.equal(body.id,peerFixture.response.id);
   if(state.link==='fail')return fulfill({detail:'Synthetic source revision conflict; report remains saved.'},409);
   return fulfill(envelope({evidence:{kind:'report',id:body.id,revision:'c'.repeat(64),label:'Native peer observation'}}));
  }
  if(p==='/api/intelligence/cases'&&method==='GET')return fulfill(envelope({items:[state.row],total:1}));
  if(p==='/api/intelligence/cases/'+state.row.id&&method==='GET')return fulfill(envelope({case:state.row}));
  if(p==='/api/intelligence/cases/'+state.row.id&&method==='PUT'){
   if(state.save==='fail')return fulfill({detail:'Synthetic case revision conflict; keep your draft.'},409);
   throw new Error('Fixture does not authorize a successful case mutation.');
  }
  if(p==='/api/intelligence/diagnostics/options'){
   if(!before)assert.equal(url.searchParams.get('include_peer_observation'),'true');
   assert.equal(url.searchParams.get('computer_id'),'peer');return fulfill(peerFixture.options);
  }
  if(p==='/api/intelligence/diagnostics'&&method==='POST'){
   assert.equal(body.kind,'peer_system');assert.equal(body.target_id,'peer');assert.equal(body.expected_host_id,peerFixture.request.expected_host_id);assert.equal(body.expected_scope,peerFixture.request.expected_scope);assert.equal(body.internet,false);assert.ok(body.request_id);
   const mode=state.check;if(mode==='hold')await new Promise(resolve=>state.release=resolve);
   if(mode==='fail')return fulfill({detail:'Synthetic peer unavailable. No host fallback ran.'},502);
   return fulfill(peerFixture.response);
  }
  if(p==='/api/intelligence/diagnostics'&&method==='GET')return fulfill({reports:[peerFixture.response]});
  if(p==='/api/intelligence/diagnostics/'+peerFixture.response.id)return fulfill(peerFixture.response);
  return route.fallback();
 });
 await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});await run.page.waitForFunction(()=>window.TLICaseContext&&window.TLITroubleshooting&&window.TLIInterface);
 run.page.setDefaultTimeout(8000);
 await run.page.evaluate(()=>switchPanel('panel-troubleshooting'));
 await run.page.getByRole('button',{name:state.row.title,exact:true}).waitFor();
 await run.page.getByRole('button',{name:state.row.title,exact:true}).click();
 await run.page.getByRole('button',{name:'Ask about this case…',exact:true}).waitFor();
 return {...run,state,calls};
}
const count=(run,p)=>run.calls.filter(c=>c.method!=='GET'&&(!p||c.path===p)).length;
async function openCase(run){
 await run.page.getByRole('button',{name:'Ask about this case…',exact:true}).click();await run.page.locator('#case-context-use').waitFor();
 await run.page.waitForFunction(()=>document.getElementById('case-context-preview').textContent.includes('Printer stalls'));
}
async function reviewFacts(run){
 const box=run.page.locator('#case-context-dialog');await box.getByLabel(/^Recorded facts:/).check();
 await run.page.waitForFunction(()=>document.getElementById('case-context-status').textContent.includes('Review the recorded measurements'));
 assert.equal(await run.page.locator('#case-context-ack').isChecked(),false);assert.equal(await run.page.locator('#case-context-use').isDisabled(),true);
}
async function openPeerReview(run){
 await run.page.locator('#troubleshooting-computer').selectOption('peer');
 await run.page.getByRole('button',{name:'Review available checks',exact:true}).click();
 const card=run.page.locator('.troubleshooting-check-option').filter({hasText:"Observe this TLI peer's resources"});
 await card.getByRole('button',{name:'Review this check',exact:true}).click();
 await run.page.getByRole('button',{name:'Run this check',exact:true}).waitFor();
}
async function measure(page,id,meta){
 const result=await layout(page,id);
 const extra=await page.evaluate(id=>{
  const root=document.getElementById(id),rect=root.getBoundingClientRect();
  const controls=[...root.querySelectorAll('button,input,select,textarea')].filter(e=>e.checkVisibility({visibilityProperty:true})&&!e.closest('[hidden]'));
  const overlaps=[];for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
   const a=controls[i].getBoundingClientRect(),b=controls[j].getBoundingClientRect();
   if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>3&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>3&&!controls[i].contains(controls[j])&&!controls[j].contains(controls[i]))overlaps.push([controls[i].id||controls[i].textContent,controls[j].id||controls[j].textContent]);
  }
  return {overlaps,rootWidth:rect.width,rootScrollWidth:root.scrollWidth,rootClientWidth:root.clientWidth,theme:document.documentElement.dataset.theme,interface:document.documentElement.dataset.interface};
 },id);
 assert.equal(extra.theme,meta.theme);assert.equal(extra.interface,meta.interface);
 assert.deepEqual(result.overflow,[],JSON.stringify({...meta,result}));assert.deepEqual(result.duplicateIds,[]);assert.deepEqual(extra.overlaps,[],JSON.stringify({...meta,extra}));
 assert.ok(result.documentWidth<=result.width+2,JSON.stringify({...meta,result}));assert.ok(extra.rootScrollWidth<=extra.rootClientWidth+2,JSON.stringify({...meta,extra}));
 record.layouts.push({...meta,...result,...extra});
}
async function screen(page,name){
 const anchor=name.startsWith('peer-review')?'.troubleshooting-check-review':name.startsWith('case-facts')?'#case-context-dialog .report-facts':'#case-context-heading';
 await page.locator(anchor).first().evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
 const file=name+'.png';await page.screenshot({path:path.join(output,file)});record.screens.push({path:file,sha256:hash(path.join(output,file)),anchor});
}
async function matrix(run,id,scene){
 const themes=await run.page.locator('#settings-theme option').evaluateAll(rows=>rows.map(r=>r.value).filter(Boolean));assert.equal(new Set(themes).size,themes.length);assert.ok(themes.length>=23);record.themes=themes;
 for(const style of ['modern','classic'])for(const theme of themes)for(const width of [1440,768,390,320]){
  await run.page.setViewportSize({width,height:1000});await run.page.evaluate(({style,theme})=>{TLIInterface.set(style);applyTheme(theme);},{style,theme});
  await measure(run.page,id,{scene,interface:style,theme,width,largeText:false});
  if(['emeraldLight','midnight'].includes(theme))await screen(run.page,`${scene}-${style}-${theme}-${width}`);
 }
 for(const style of ['modern','classic'])for(const theme of ['emeraldLight','midnight']){
  await run.page.setViewportSize({width:320,height:1000});await run.page.evaluate(({style,theme,id})=>{TLIInterface.set(style);applyTheme(theme);
   const root=document.getElementById(id);window.__caseTextScale=[root,...root.querySelectorAll('*')].map(e=>({e,style:e.getAttribute('style'),size:parseFloat(getComputedStyle(e).fontSize)}));
   window.__caseTextScale.forEach(({e,size})=>e.style.fontSize=(size*2)+'px');
  },{style,theme,id});
  assert.ok(await run.page.evaluate(()=>window.__caseTextScale.every(({e,size})=>Math.abs(parseFloat(getComputedStyle(e).fontSize)-size*2)<.05)));
  await measure(run.page,id,{scene,interface:style,theme,width:320,largeText:true,textScale:2,textScaleScope:'review text and controls; computed font sizes doubled'});await screen(run.page,`${scene}-${style}-${theme}-320-enlarged`);
  await run.page.evaluate(()=>{window.__caseTextScale.forEach(({e,style})=>style===null?e.removeAttribute('style'):e.setAttribute('style',style));delete window.__caseTextScale;});
 }
 pass(`${scene}: all selectable themes, both interfaces, desktop/tablet/phone and enlarged text`);
}
async function workflows(browser){
 let run=await setup(browser),page=run.page;
 assert.equal(count(run),0);await page.evaluate(()=>{document.getElementById('chat-input').value='Keep this unsent question.';});
 await openCase(run);assert.equal(count(run),0);await reviewFacts(run);assert.equal(count(run),1);
 await page.locator('#case-context-ack').check();await page.locator('#case-context-use').click();
 await page.locator('#chat-context-toggle').click();await page.locator('#case-context-selected').waitFor({state:'visible'});assert.equal(await page.locator('#chat-input').inputValue(),'Keep this unsent question.');assert.equal(count(run),1);
 assert.ok(![...run.calls].some(c=>/\/chat(?:\/|$)/.test(c.path)&&c.method!=='GET'));pass('Explicit review prepares Chat with exact selected facts, preserves draft, and sends no question');
 await page.evaluate(()=>{TLICaseContext.removeContext();switchPanel('panel-troubleshooting');});await openCase(run);
 run.state.preview='conflict';await page.locator('#case-context-dialog').getByLabel(/^Recorded facts:/).uncheck();await page.locator('#case-context-dialog').getByLabel(/^Recorded facts:/).check();await page.waitForFunction(()=>document.getElementById('case-context-status').textContent.includes('report changed'));
 assert.equal(await page.locator('#case-context-use').isDisabled(),true);assert.equal(await page.locator('#chat-input').inputValue(),'Keep this unsent question.');pass('Changed report refuses attachment and retains the unsent question');
 run.state.preview='ok';run.state.row={...run.state.row,title:'Printer stalls — updated saved case',revision:'d'.repeat(64)};await page.getByRole('button',{name:'Reload saved case',exact:true}).click();await page.waitForFunction(()=>document.getElementById('case-context-status').textContent.includes('This case changed'));
 assert.equal(await page.locator('#case-context-ack').isChecked(),false);assert.equal(await page.locator('#chat-input').inputValue(),'Keep this unsent question.');pass('Changed case reload requires new review and preserves composer');
 await page.keyboard.press('Escape');assert.equal(await page.locator('#case-context-dialog').isVisible(),false);
 await openPeerReview(run);const beforeRun=count(run,'/api/intelligence/diagnostics');
 const start=page.getByRole('button',{name:'Run this check',exact:true});await start.click();await page.waitForFunction(()=>document.querySelector('.troubleshooting-check-status')?.textContent.includes('Report saved.'));
 assert.equal(count(run,'/api/intelligence/diagnostics'),beforeRun+1);run.state.link='fail';await page.getByRole('button',{name:'Add report link to this draft',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.troubleshooting-check-status')?.textContent.includes('link not saved'));
 assert.equal(count(run,'/api/intelligence/diagnostics'),beforeRun+1);assert.ok(await page.locator('.troubleshooting-check-report').isVisible());pass('Explicit native-peer request runs once; failed separate link preserves report and does not rerun');
 run.state.link='ok';await page.getByRole('button',{name:'Add report link to this draft',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.troubleshooting-check-status')?.textContent.includes('link added'));
 run.state.save='fail';await page.locator('#troubleshooting-save').click();await page.waitForFunction(()=>document.getElementById('troubleshooting-status').textContent.includes('Report saved; problem link not saved'));
 assert.equal(count(run,'/api/intelligence/diagnostics'),beforeRun+1);assert.equal(await page.locator('#troubleshooting-computer').inputValue(),'peer');pass('Failed case save keeps its peer draft and identifies the independently saved report');
 record.errors.push(...run.errors);await run.context.close();
 for(const operation of ['preview','check']){
  run=await setup(browser);page=run.page;
  if(operation==='preview'){await openCase(run);run.state.preview='hold';await page.locator('#case-context-dialog').getByLabel(/^Recorded facts:/).check();}
  else{await openPeerReview(run);run.state.check='hold';await page.getByRole('button',{name:'Run this check',exact:true}).click();}
  await page.waitForTimeout(30);assert.ok(run.state.release);await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));run.state.release();await page.waitForTimeout(70);
  assert.equal(await page.locator('#case-context-dialog').isVisible(),false);assert.equal(await page.locator('#case-context-selected').isVisible(),false);
  assert.equal(await page.locator('.troubleshooting-check-report').count(),0);assert.equal(await page.locator('#case-context-selected').textContent(),'');assert.equal(await page.locator('#case-context-preview').textContent(),'');pass(`Lock clears private ${operation} state and ignores its late response`);
  record.errors.push(...run.errors);await run.context.close();
 }
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  if(!before)await workflows(browser);
  const cases=await setup(browser);await openCase(cases);
  if(!before){await reviewFacts(cases);await cases.page.locator('#case-context-ack').focus();for(let i=0;i<24;i++){await cases.page.keyboard.press('Tab');assert.ok(await cases.page.evaluate(()=>document.activeElement?.closest('#case-context-dialog')!==null));}pass('Case native dialog keeps keyboard focus inside review');
   await cases.page.setViewportSize({width:320,height:1000});const table=cases.page.locator('.report-facts-table-scroll');await table.focus();await table.evaluate(e=>e.scrollLeft=0);await cases.page.keyboard.press('ArrowRight');await cases.page.waitForFunction(()=>document.querySelector('.report-facts-table-scroll').scrollLeft>0);pass('Narrow report table keeps every column accessible by keyboard');
  }
  await matrix(cases,'case-context-dialog',before?'before-case':'case-facts');record.errors.push(...cases.errors);await cases.context.close();
  if(!before){const peer=await setup(browser);await openPeerReview(peer);await matrix(peer,'troubleshooting-guided-checks','peer-review');record.errors.push(...peer.errors);await peer.context.close();}
  assert.deepEqual(record.errors,[]);record.passed=true;
 }catch(error){record.passed=false;record.failure=String(error.stack||error);process.exitCode=1;}
 finally{record.source_after=fingerprintFiles(source);record.source_changed=JSON.stringify(record.source_before)!==JSON.stringify(record.source_after);if(record.source_changed){record.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(record,null,2));await browser.close();console.log(JSON.stringify({output,passed:record.passed,checks:record.checks.length,layouts:record.layouts.length,screens:record.screens.length,source_changed:record.source_changed,failure:record.failure}));}
})();


