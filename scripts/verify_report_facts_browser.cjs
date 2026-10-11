/* Actual SPA with synthetic intercepted reports/chat. No TLI server or live probes. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
if(!process.argv.includes('--label'))process.argv.push('--label','report-facts');
const {makePage,source}=require('./verify_anniversary_ui_browser.cjs');
const {measuredLayout,textScale,contrast}=require('./verify_anniversary_themes_browser.cjs');
const root=path.resolve(__dirname,'..'),arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const fixturePath=path.resolve(arg('--fixture')||path.join(root,'build_work/evidence-led-troubleshooting/fixtures/reports.json'));
const fixture=JSON.parse(fs.readFileSync(fixturePath));assert.equal(fixture.synthetic,true);
const output=path.join(root,'build_work/evidence-led-troubleshooting/browser',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tracked=['frontend/js/report-facts.js','frontend/report-facts.css','frontend/js/intelligence.js','frontend/js/report-review.js','frontend/js/memory-continuity.js','frontend/memory-continuity.css'];
const hashes=()=>Object.fromEntries(tracked.map(p=>[p,hash(path.join(source,p))]));
const result={synthetic:true,source,fixture:{path:fixturePath,sha256:hash(fixturePath)},hashesAtStart:hashes(),checks:[],layouts:[],contrast:[],screenshots:[],errors:[],limitations:['All API requests are synthetic and intercepted; no application server, model or device was contacted.','Report fixture uses the actual pure backend report_facts.build projection of fake samples.','This verifies presentation and controller behavior, not model quality, physical printing, phone behavior or native delivery.','Source binding covers the listed desktop presentation files; independent concurrent work may alter other source files.']};
const stamp=fixture.performance.created_at,revision='a'.repeat(64),answer='Interpretation: these saved samples do not establish that the application task finished. The host and selected process had different CPU usage [R1].';
function evidence(facts=fixture.performance.recorded_facts){return {version:1,interpretation:'ai',sources:[{handle:'R1',kind:'report',id:'fixture-report',label:'Historical performance observation',revision:null,provenance:'recorded_measurement',saved_at:null,observed_at:stamp,host_id:'fixture-studio',target_id:null,ranges:[]}],recorded_report:structuredClone(facts),historical_notes:{checked:true,changed:1,unavailable:1,references:[{exchange_index:1,note_id:'older-note',title:'Prior printer suggestion',revision,handle:'N1',status:'changed'},{exchange_index:2,note_id:'removed-note',title:'Retired cable suggestion',revision:'b'.repeat(64),handle:'N1',status:'unavailable'}]},citations_checked:true,citations:[{reference:'[R1]',handle:'R1'}],invalid_citations:0};}
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
async function setup(browser,width=1440,theme='emeraldLight'){
 const run=await makePage(browser,width,theme),{context,page}=run;
 const state={requests:[],evidence:evidence(),report:structuredClone(fixture.performance),gate:null};
 await context.route('**/api/intelligence/**',async route=>{
  const request=route.request(),url=new URL(request.url()),p=url.pathname,method=request.method();
  if(p==='/api/intelligence/memory/capabilities')return json(route,{ok:true,protocol:'tli-memory-continuity-v1',use_conversation_history:true,evidence_context_version:1});
  if(p==='/api/intelligence/devices')return json(route,{node:fixture.system.host,scope:'Synthetic registered devices; no live discovery.',devices:[]});
  if(!p.startsWith('/api/intelligence/diagnostics'))return route.fallback();
  state.requests.push({method,path:p,...(method==='POST'?{body:request.postDataJSON()}:{})});
  if(p.endsWith('/repeat-review'))return json(route,{ok:true,protocol:'tli-report-review-v1',actions_performed:false,checked_at:stamp,source:{id:'fixture-system'},source_revision:revision,available:true,reason:'Exact saved host check can be reviewed.',scope:{host:fixture.system.host,target:null,kind:'system',internet:false,revision:'c'.repeat(64)},request:{repeat_of:'fixture-system',expected_report_revision:revision,expected_scope:'c'.repeat(64),expected_host_id:'fixture-studio',kind:'system',target_id:null,internet:false}});
  if(method==='POST')return json(route,{...fixture.system,id:'fixture-system-new',recorded_facts:{...fixture.system.recorded_facts,report_id:'fixture-system-new'}});
  if(p==='/api/intelligence/diagnostics')return json(route,{reports:[state.report,fixture.system]});
  if(state.gate)await state.gate;
  return json(route,p.endsWith('/fixture-system')?fixture.system:state.report).catch(()=>{});
 });
 await context.route('**/api/ai/chat/stream',async route=>{
  state.requests.push({method:'POST',path:'/api/ai/chat/stream',body:route.request().postDataJSON()});
  const meta={type:'meta',provider:'bundled',handled_by:'llm',conversation_id:'fixture-chat',session_id:'fixture-chat',evidence_context:state.evidence};
  return route.fulfill({contentType:'text/event-stream',body:[{type:'delta',text:answer},meta,{type:'done'}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')});
 });
 await context.route('**/api/ai/conversations/fixture-history',route=>{state.requests.push({method:'GET',path:'/api/ai/conversations/fixture-history'});return json(route,{id:'fixture-history',messages:[{role:'user',content:'What does this saved observation establish?'},{role:'assistant',content:answer,provider:'bundled',handled_by:'llm',evidence_context:state.evidence}]});});
 await page.waitForFunction(()=>window.TLIReportFacts&&window.TLIMemory&&window.TLIIntelligence);
 await page.evaluate(()=>{switchPanel('panel-main');window.__themeAuditVisible=el=>{if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;for(let p=el;p;p=p.parentElement){if(Number(getComputedStyle(p).opacity)===0)return false;if(p!==el&&p.tagName==='DETAILS'&&!p.open&&!p.querySelector(':scope > summary')?.contains(el))return false;}return true;};});
 assert.match(page.url(),/^http:/);assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined');
 return {...run,state};
}
const check=label=>result.checks.push(label);
async function send(run){await run.page.locator('#chat-input').fill('What does this saved observation establish?');await run.page.locator('#chat-send-btn').click();await run.page.waitForFunction(()=>!document.getElementById('chat-send-btn').disabled);await run.page.locator('#chat-output .report-facts').waitFor();}
async function screenshot(page,name){const file=path.join(output,name+'.png');await page.screenshot({path:file});result.screenshots.push({file,sha256:hash(file)});}
async function layout(page,id,meta){const v=await measuredLayout(page,id);result.layouts.push({...meta,...v});assert.equal(v.overflow.length,0,JSON.stringify(v.overflow));assert.ok(v.documentWidth<=meta.width+2);}
async function auditContrast(page,selector,meta){const v=await contrast(page,selector);result.contrast.push({...meta,...v});assert.equal(v.findings.length,0,JSON.stringify(v.findings));}
async function main(){const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const first=await setup(browser);await first.page.locator('#chat-input').fill('Keep this written question');
 await first.page.evaluate(()=>switchPanel('panel-devices'));await first.page.getByText('Device context & diagnostics',{exact:true}).click();
 await first.page.locator('.tli-int-history button').first().click();
 assert.equal(first.state.requests.filter(x=>x.method==='POST').length,0);
 assert.equal((await first.page.evaluate(()=>TLIIntelligence.getContext())).diagnostic_id,null);
 assert.equal(await first.page.locator('#chat-input').inputValue(),'Keep this written question');
 assert.match(await first.page.locator('.tli-int-report .report-facts').innerText(),/Observation stopped.*17 recorded.*30 planned/s);
 check('Legacy diagnostic history is read-only: no mutation, attachment or draft replacement. Full saved facts retain stopped17/30 status.');
 await first.page.getByRole('button',{name:'Discuss this report in chat',exact:true}).click();
 assert.equal((await first.page.evaluate(()=>TLIIntelligence.getContext())).diagnostic_id,'fixture-report');assert.equal(await first.page.locator('#chat-input').inputValue(),'Keep this written question');assert.equal(first.state.requests.filter(x=>x.method==='POST').length,0);
 check('Discuss explicitly attaches the chosen saved report, preserving the typed question without sending.');
 await send(first);const card=first.page.locator('#chat-output .report-facts');
 assert.match(await card.innerText(),/Observation stopped.*Sketch.*17 recorded.*30 planned/s);assert.equal(await card.locator('.report-facts-expanded').getAttribute('open'),null);assert.equal(await card.locator('table').isVisible(),false);
 assert.equal(await card.evaluate(e=>{const p=e.parentElement;return p.textContent.indexOf('Recorded report facts')<p.textContent.indexOf('Interpretation:');}),true);
 await card.locator('summary').first().focus();await first.page.keyboard.press('Enter');assert.equal(await card.locator('table').isVisible(),true);
 assert.match(await card.locator('tr').filter({hasText:'Host CPU'}).innerText(),/88%/);assert.match(await card.locator('tr').filter({hasText:'Selected process CPU'}).innerText(),/52%/);
 check('Actual SSE metadata prepends a compact source-bound facts card before prose; keyboard expansion preserves host88% vs process52% and RSS512MiB.');
 await first.page.getByText('Sources & interpretation',{exact:true}).click();await first.page.getByText('Changed or unavailable historical notes',{exact:true}).click();
 const hist=first.page.locator('details').filter({has:first.page.locator('summary').filter({hasText:'Changed or unavailable historical notes'})}).last();
 assert.match(await hist.innerText(),/Earlier exchange 1.*changed.*Earlier exchange 2.*no longer available/is);assert.equal(await hist.locator('button,a').count(),0);check('Changed/unavailable historical note references are inert exchange-scoped labels, with no current source links or extra reads.');
 const before=await first.page.evaluate(()=>TLIIntelligence.getContext());await first.page.getByRole('button',{name:'Open saved report',exact:true}).click();await first.page.locator('#tli-saved-report-dialog[open]').waitFor();assert.deepEqual(await first.page.evaluate(()=>TLIIntelligence.getContext()),before);assert.equal(first.state.requests.filter(x=>x.method==='POST').length,1);
 assert.equal(await first.page.locator('#tli-saved-report-dialog .report-facts table').isVisible(),true);assert.equal(await first.page.locator('#tli-saved-report-dialog .report-facts-interpretation').getAttribute('open'),null);check('Source navigation opens full historical measurements read-only; saved interpretation and unperformed suggestions stay separate.');await first.page.keyboard.press('Escape');
 await first.page.locator('#chat-input').fill('');await first.page.evaluate(()=>loadConversation('fixture-history','Saved fixture'));
 assert.equal(await first.page.locator('#chat-output .report-facts').count(),1);assert.equal(await first.page.locator('#chat-output .report-facts table').isVisible(),false);assert.equal(first.state.requests.filter(x=>x.method==='POST').length,1);check('Saved conversation reopening restores the same compact facts and historical source receipt without an AI request.');
 first.state.evidence.recorded_report.host.id='another-host';await first.page.evaluate(()=>loadConversation('fixture-history','Mismatched source'));
 assert.match(await first.page.locator('#chat-output .report-facts').innerText(),/structured report summary is unavailable/);assert.equal(await first.page.locator('#chat-output .report-facts table').count(),0);check('A mismatched recorded host cannot inherit the cited report identity or display authoritative measurements.');
 result.errors.push(...first.errors);await first.context.close();
 const repeat=await setup(browser);await repeat.page.evaluate(()=>TLIIntelligence.openSavedReport('fixture-system'));await repeat.page.getByRole('button',{name:'Review repeat check',exact:true}).click();await repeat.page.getByRole('button',{name:'Run reviewed repeat check',exact:true}).waitFor();assert.equal(repeat.state.requests.filter(x=>x.method==='POST').length,0);await repeat.page.getByRole('button',{name:'Run reviewed repeat check',exact:true}).dblclick();await repeat.page.getByText('New saved report',{exact:true}).waitFor();const posts=repeat.state.requests.filter(x=>x.method==='POST');assert.equal(posts.length,1);assert.match(posts[0].body.request_id,/^[0-9a-f]{32}$/);assert.equal(posts[0].body.expected_host_id,'fixture-studio');check('Insecure HTTP uses secure random bytes for one explicit reviewed diagnostic; rapid duplicate activation sends one source-bound intercepted POST.');result.errors.push(...repeat.errors);await repeat.context.close();
 const late=await setup(browser);let release;late.state.gate=new Promise(r=>release=r);await late.page.evaluate(()=>{window.pendingReport=TLIIntelligence.openSavedReport('fixture-report').catch(()=>{});});await late.page.waitForTimeout(30);await late.page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));release();await late.page.waitForTimeout(80);assert.equal(await late.page.locator('#tli-saved-report-dialog[open]').count(),0);assert.equal(await late.page.locator('.report-facts').count(),0);check('Session lock clears the report view and rejects a late saved report response.');await late.context.close();
 for(const width of [1440,768,390,320])for(const theme of ['emeraldLight','midnight','classicTli']){
  const run=await setup(browser,width,theme);await send(run);await run.page.locator('#chat-output .report-facts').scrollIntoViewIfNeeded();await layout(run.page,'panel-main',{width,theme,view:'chat-compact'});await screenshot(run.page,`chat-compact-${width}-${theme}`);
  await run.page.locator('#chat-output .report-facts > details > summary').click();await layout(run.page,'panel-main',{width,theme,view:'chat-expanded'});await auditContrast(run.page,'.report-facts',{width,theme});await screenshot(run.page,`chat-expanded-${width}-${theme}`);
  if(width===320&&theme==='midnight'){const table=run.page.locator('.report-facts-table-scroll');await table.focus();await run.page.keyboard.press('ArrowRight');await run.page.waitForTimeout(120);assert.ok(await table.evaluate(e=>e.scrollLeft)>0);check('320px measurement table supports keyboard horizontal scrolling.');await textScale(run.page,'panel-main',true);await layout(run.page,'panel-main',{width,theme,view:'chat-expanded-200-percent'});await screenshot(run.page,'chat-expanded-320-midnight-enlarged');}
  await run.page.evaluate(()=>TLIIntelligence.openSavedReport('fixture-report'));await layout(run.page,'tli-saved-report-dialog',{width,theme,view:'report'});await screenshot(run.page,`saved-report-${width}-${theme}`);
  result.errors.push(...run.errors);await run.context.close();
 }
 const themes=await setup(browser,390);await send(themes);await themes.page.locator('#chat-output .report-facts > details > summary').click();
 result.themes=await themes.page.locator('#settings-theme option').evaluateAll(o=>o.filter(x=>!x.disabled&&x.value).map(x=>x.value));
 for(const theme of result.themes){await themes.page.evaluate(t=>applyTheme(t),theme);await layout(themes.page,'panel-main',{width:390,theme,view:'all-theme-facts'});await auditContrast(themes.page,'.report-facts',{width:390,theme});}
 assert.equal(themes.state.requests.filter(x=>x.method==='POST').length,1);check('Every registered theme keeps facts readable; inspecting themes produces no additional AI or diagnostic request.');result.errors.push(...themes.errors);await themes.context.close();
 assert.equal(result.errors.length,0);result.hashesAtEnd=hashes();result.sourceUnchanged=JSON.stringify(result.hashesAtStart)===JSON.stringify(result.hashesAtEnd);assert.equal(result.sourceUnchanged,true);result.completed=true;
 }finally{await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));}console.log(JSON.stringify({output,checks:result.checks.length,layouts:result.layouts.length,themes:result.themes.length,screenshots:result.screenshots.length,sourceUnchanged:result.sourceUnchanged}));}
main().catch(e=>{fs.writeFileSync(path.join(output,'error.txt'),e.stack);console.error(e);process.exitCode=1;});
