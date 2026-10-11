/* Real browser SPA; all responses are synthetic and every network route intercepted. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
if(!process.argv.includes('--label'))process.argv.push('--label','chat-evidence');
const {makePage,source}=require('./verify_anniversary_ui_browser.cjs');
const {measuredLayout,textScale}=require('./verify_anniversary_themes_browser.cjs');
const output=path.join(__dirname,'../build_work/grounded-chat/browser',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const tracked=['frontend/app.js','frontend/index.html','frontend/js/memory-continuity.js','frontend/memory-continuity.css','frontend/js/chat-workspace.js','frontend/chat-workspace.css','frontend/js/chat-format.js'];
const hashes=()=>Object.fromEntries(tracked.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(source,file))).digest('hex')]));
const result={synthetic:true,source,output,hashesAtStart:hashes(),behaviors:[],layouts:[],screenshots:[],errors:[],limitations:['No application server, household data, inference, downloads or devices were used. All requests are intercepted.','Browser fixtures do not constitute physical-phone acceptance or prove model answer correctness.']};
const stamp='2026-09-08T10:00:00Z',revision='a'.repeat(64);
const supplied=[{handle:'N1',kind:'note',id:'fixture-note',label:'Printer disconnects · studio workstation',revision,provenance:'chat_ai',saved_at:stamp,observed_at:null,host_id:null,target_id:null,ranges:[]},
{handle:'R1',kind:'report',id:'fixture-report',label:'Saved diagnostic report',revision:null,provenance:'recorded_measurement',saved_at:null,observed_at:stamp,host_id:'fixture-studio',target_id:null,ranges:[]}];
const receipt=()=>({version:1,interpretation:'ai',sources:structuredClone(supplied),historical_notes:{checked:true,changed:1,unavailable:1},citations_checked:true,citations:[{reference:'[N1]',handle:'N1'},{reference:'[R1]',handle:'R1'}],invalid_citations:1});
async function setup(browser,width=1440,theme='emeraldLight'){
 const run=await makePage(browser,width,theme);const {page,context}=run;
 const state={supported:true,calls:[],gate:null};
 await context.route('**/api/intelligence/memory/capabilities',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,protocol:'tli-memory-continuity-v1',use_conversation_history:state.supported,evidence_context_version:1})}));
 await context.route('**/api/intelligence/diagnostics/fixture-report',route=>{state.calls.push({method:'GET',path:'/api/intelligence/diagnostics/fixture-report'});return route.fulfill({contentType:'application/json',body:JSON.stringify({id:'fixture-report',kind:'system',created_at:stamp,host:{id:'fixture-studio',name:'Studio'},target:null,scope:'Checks ran on Studio at the recorded time. No new checks ran.',checks:[{id:'ram',label:'Host RAM',status:'pass',detail:'RAM was 42% in this historical sample.'}],findings:[],next_steps:[],verified_fix:null})});});
 await context.route('**/api/ai/chat/stream',async route=>{
  const request=route.request(),body=request.postDataJSON();state.calls.push({method:'POST',path:'/api/ai/chat/stream',body});
  if(state.gate)await state.gate;
  const metadata={type:'meta',session_id:'fixture-chat',conversation_id:'fixture-chat',provider:'bundled',handled_by:'llm',evidence_context:receipt(),memory_context:{use_saved_memory:true,status:'included',notes:[{id:'fixture-note',title:'Printer disconnects',revision,source:'chat_ai',category:'general',updated_at:stamp,device_id:null}],omitted_for_budget:0},conversation_context:{status:body.use_conversation_history===false?'disabled':'included',...(body.use_conversation_history===false?{use_conversation_history:false}:{}),included_messages:body.use_conversation_history===false?0:2,included_exchanges:body.use_conversation_history===false?0:1,omitted_messages:0,character_budget:12000}};
  const frames=[{type:'delta',text:'The saved suggestion mentions a cable [N1](https://untrusted.example). The report records an earlier RAM sample [R1]. Neither proves the computer is healthy now. [N99] remains unverified.'},metadata,{type:'done'}];
  await route.fulfill({contentType:'text/event-stream',body:frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')}).catch(()=>{});
 });
 await page.goto('https://tli-ui.test/',{waitUntil:'load'});
 await page.waitForFunction(()=>typeof switchPanel==='function' && window.TLIMemory && document.getElementById('memory-use-history'));
 assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
 await page.evaluate(()=>{switchPanel('panel-main');window.__themeAuditVisible=el=>{if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;for(let p=el;p;p=p.parentElement){if(Number(getComputedStyle(p).opacity)===0)return false;if(p!==el&&p.tagName==='DETAILS'&&!p.open&&!p.querySelector(':scope > summary')?.contains(el))return false;}return true;};});
 return {...run,state};
}
async function send(run){await run.page.locator('#memory-use-history').uncheck();await run.page.locator('#chat-input').fill('Explain the previous printer fix and its evidence.');await run.page.locator('#chat-send-btn').click();await run.page.waitForFunction(()=>!document.getElementById('chat-send-btn').disabled);}
async function capture(page,name){const file=path.join(output,name+'.png');await page.screenshot({path:file});result.screenshots.push({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}
async function main(){const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const first=await setup(browser);
 assert.equal(first.state.calls.length,0);assert.equal(await first.page.locator('#memory-use-history').isChecked(),true);
 await send(first);assert.equal(first.state.calls.filter(c=>c.method==='POST').length,1);assert.equal(first.state.calls[0].body.use_conversation_history,false);
 await first.page.getByText('Sources & interpretation',{exact:true}).click();
 await first.page.getByText('Context for this answer',{exact:true}).click();
 assert.match(await first.page.locator('#chat-output').innerText(),/Earlier conversation was off.*No prior exchanges/s);
 assert.equal(await first.page.locator('#chat-output a[href*="untrusted.example"]').count(),0);
 assert.equal(await first.page.locator('#memory-use-history').isChecked(),true);
 const previous=await first.page.evaluate(()=>window.TLIIntelligence.getContext());
 await first.page.getByRole('button',{name:'Open saved report',exact:true}).click();
 await first.page.waitForFunction(()=>document.getElementById('tli-saved-report-dialog')?.open);
 assert.deepEqual(await first.page.evaluate(()=>window.TLIIntelligence.getContext()),previous);assert.equal(first.state.calls.filter(c=>c.method==='POST').length,1);
 await first.page.keyboard.press('Escape');result.behaviors.push('History off reached the actual request; completion reset only the next-question control; source report opened read-only without attaching or running checks.');
 first.state.supported=false;await send(first);assert.equal(first.state.calls.filter(c=>c.method==='POST').length,1);assert.match(await first.page.locator('#chat-input').inputValue(),/printer fix/);assert.match(await first.page.locator('#chat-output').innerText(),/without earlier conversation/);
 result.behaviors.push('Unsupported history capability blocked the question and preserved the draft.');
 result.errors.push(...first.errors);await first.context.close();
 const locked=await setup(browser);let release;locked.state.gate=new Promise(yes=>release=yes);
 await locked.page.locator('#chat-input').fill('A delayed question');await locked.page.locator('#chat-send-btn').click();await locked.page.waitForFunction(()=>document.getElementById('chat-send-btn').disabled);
 await new Promise(resolve=>setTimeout(resolve,100));await locked.page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));release();await locked.page.waitForTimeout(200);
 assert.doesNotMatch(await locked.page.locator('#chat-output').innerText(),/delayed question|saved suggestion|Sources & interpretation/);assert.equal(await locked.page.locator('#chat-output .memory-context-receipt').count(),0);assert.equal(await locked.page.locator('#memory-use-history').isChecked(),true);result.behaviors.push('Session lock cleared private content and late completion could not repopulate evidence.');await locked.context.close();
 for(const width of [1440,768,390,320])for(const theme of ['emeraldLight','midnight','classicTli']){
  const run=await setup(browser,width,theme);await send(run);await run.page.getByText('Sources & interpretation',{exact:true}).click();
  const layout=await measuredLayout(run.page,'panel-main');result.layouts.push({width,theme,...layout});assert.equal(layout.overflow.length,0);assert.ok(layout.documentWidth<=width+2);
  await capture(run.page,`chat-${width}-${theme}`);
  if(width===320&&theme==='emeraldLight'){await textScale(run.page,'panel-main',true);const enlarged=await measuredLayout(run.page,'panel-main');result.layouts.push({width,theme,textScale:2,...enlarged});assert.equal(enlarged.overflow.length,0);await capture(run.page,'chat-320-enlarged');}
  result.errors.push(...run.errors);await run.context.close();
 }
 assert.equal(result.errors.length,0);result.hashesAtEnd=hashes();result.changedDuringRun=tracked.filter(file=>result.hashesAtStart[file]!==result.hashesAtEnd[file]);
 result.completed=true;
}finally{await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));}console.log(JSON.stringify({output,behaviors:result.behaviors.length,layouts:result.layouts.length,screenshots:result.screenshots.length,errors:result.errors.length,changedDuringRun:result.changedDuringRun}));}
main().catch(error=>{fs.writeFileSync(path.join(output,'error.txt'),error.stack);console.error(error);process.exitCode=1;});
