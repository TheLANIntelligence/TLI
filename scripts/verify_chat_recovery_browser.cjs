/* Complete real SPA with synthetic intercepted replies; no TLI server or inference. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {contrast,textScale}=require('./verify_anniversary_themes_browser.cjs');
const output=path.resolve(__dirname,'../build_work/chat-recovery',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const report={source,output,synthetic:true,hashesAtStart:fingerprintFiles(source),checks:[],screenshots:[],sessions:[],failures:[],limitations:['Theme smoke uses real receipt/interruption renderers; SSE lifecycle is exercised separately. Enlarged text doubles computed text sizing; OS text scaling is not claimed. Computed contrast checks solid surfaces; gradients and transparency need visual review.', 'Intercepted browser fixtures only. Physical-phone and screen-reader acceptance are not claimed. Incomplete replies remain in the current view and are not saved as completed conversations.']};
const now=new Date().toISOString();
const diagnostic={id:'fixture-report',kind:'system',created_at:now,host:{id:'fixture-studio',name:'Studio'},target:{id:'fixture-printer',name:'Studio printer'},scope:'Checks ran on Studio; this does not measure the requesting browser.',checks:[{id:'ram',label:'Host memory',status:'pass',detail:'RAM usage was 43%.'}],findings:[{certainty:'observed',text:'This is a single observed sample.'}],next_steps:['Review the existing observations before deciding on a new check.']};
fixtures['/api/intelligence/devices']={devices:[{id:'fixture-printer',name:'Studio printer',kind:'printer'}],node:{id:'fixture-studio',name:'Studio'},scope:'This TLI host'};
fixtures['/api/intelligence/diagnostics']={reports:[diagnostic]};
fixtures['/api/ai/conversations/fixture-resume']={messages:[{role:'user',content:'Where are my setup notes?'},{role:'assistant',content:'Use Notes & fixes to review saved setup details.'}]};
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
const frame=data=>'data: '+JSON.stringify(data)+'\n\n';
async function capture(page,name){const file=name+'.png';await page.screenshot({path:path.join(output,file),fullPage:false});report.screenshots.push(file);}
async function receiptChecks(browser){
 const observation_context={schema_version:1,topic:'ram',host:{id:'fixture-studio',name:'Studio'},resource:'Host memory',source:'Latest successful host resource probe',observed_at:now,checked_at:now,status:'current',coverage:'One host sample. It does not measure this browser or establish sustained pressure.'};
 const input_budget={version:1,provider:'bundled',model:'standard',estimation:'heuristic',capacity_status:'configured',context_tokens:4096,capacity_source:'owned_runtime_launch',reserved_output_tokens:1024,character_limit:12000,input_characters:2000,estimated_input_tokens:800,fit:'estimated',checked_at:now};
 for(const width of [1440,320])for(const theme of ['emeraldLight','midnight']){
  const run=await makePage(browser,width,theme),{page}=run;let requestCount=0;
  const observed={provider:'tli-tools',handled_by:'observed_status',observation_context};
  const budget={provider:'bundled',handled_by:'llm',input_budget,memory_context:{use_saved_memory:true,status:'none',notes:[],omitted_for_budget:0},conversation_context:{status:'none',included_messages:0,included_exchanges:0,omitted_messages:0,character_budget:12000}};
  await page.route('**/api/ai/chat/stream',route=>{requestCount++;const metadata=requestCount===1?observed:budget;return route.fulfill({contentType:'text/event-stream',body:frame({type:'meta',session_id:'fixture-evidence',...metadata})+frame({type:'delta',text:requestCount===1?'Studio memory usage was 43% in the latest successful sample.':'The available context includes your latest question. This estimate does not establish answer quality.'})+frame({type:'done'})});});
  await page.route('**/api/ai/conversations/fixture-evidence-history',route=>json(route,{messages:[
   {role:'user',content:'How much RAM was in use?'},{role:'assistant',content:'This retained observation was already stale when answered.',...observed,observation_context:{...observation_context,status:'stale',observed_at:new Date(Date.now()-120000).toISOString()}},
   {role:'user',content:'What was provided?'},{role:'assistant',content:'The previous provider did not report its effective capacity.',...budget,input_budget:{...input_budget,provider:'lmstudio',capacity_status:'unknown',context_tokens:null,fit:'unknown'}},
   {role:'user',content:'An older incomplete receipt'},{role:'assistant',content:'The older host did not return usable metadata.',provider:'tli-tools',observation_context:{private_text:'SHOULD_NOT_RENDER'},input_budget:{private_text:'SHOULD_NOT_RENDER'}}]}));
  await page.evaluate(()=>switchPanel('panel-main'));
  for(const [mode,question]of [['readings','How much RAM am I using?'],['budget','Explain the available reference context.']]){
   await page.locator('#new-chat-btn').click();await page.locator('#chat-input').fill(question);await page.locator('#chat-send-btn').click();
   const summary=page.getByText(mode==='readings'?'Readings used for this answer':'Input size & model limits',{exact:true});await summary.waitFor();await summary.click();
   const text=await page.locator('#chat-output').innerText();assert.match(text,mode==='readings'?/did not use saved notes, prior conversation or AI inference/:/planning estimate, not an exact tokenizer count/);
   assert.equal(await page.locator('.chat-interruption').count(),0);
   const size=await layout(page,'panel-main');assert.deepEqual(size.overflow,[]);assert.ok(size.documentWidth<=width+2);
   await summary.scrollIntoViewIfNeeded();await capture(page,`${mode}-receipt-${width}-${theme}`);
   report.checks.push({width,theme,scenario:`Actual SSE ${mode} metadata renders the complete dated receipt`,layout:size});
  }
  const before=requestCount;assert.equal(await page.evaluate(()=>loadConversation('fixture-evidence-history','Evidence history')),true);
  await page.locator('#chat-output details').evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
  const text=await page.locator('#chat-output').innerText();assert.match(text,/Stale reading when answered/);assert.match(text,/effective context capacity is unknown/);
  assert.match(text,/did not provide a usable reading receipt/);assert.match(text,/did not report a usable input-size check/);assert.doesNotMatch(text,/SHOULD_NOT_RENDER/);assert.equal(requestCount,before);
  const receiptWidths=await page.locator('#chat-output details').evaluateAll(nodes=>nodes.map(n=>({width:n.clientWidth,scroll:n.scrollWidth})));
  assert.ok(receiptWidths.every(n=>n.scroll<=n.width+2));
  report.checks.push({width,theme,scenario:'Resumed stale/unknown/invalid receipts remain accurate, with details open and no generation',receiptWidths});
  assert.deepEqual(run.errors,[]);await run.context.close();console.log(`Receipts ${width} ${theme}`);
 }
}
async function themeChecks(browser){
 const run=await makePage(browser,390,'emeraldLight'),{page}=run;
 await page.evaluate(()=>switchPanel('panel-main'));
 await page.evaluate(now=>{
  window.__themeAuditVisible = el => {
   if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;
   for(let a=el;a;a=a.parentElement){if(Number(getComputedStyle(a).opacity)===0)return false;if(a!==el&&a.tagName==='DETAILS'&&!a.open&&!a.querySelector(':scope > summary')?.contains(el))return false;}return true;
  };
  document.getElementById('chat-output').innerHTML='';
  const incomplete=appendMessage('assistant','The gateway answered. DNS was not tested.');
  TLIChatWorkspace.showInterrupted(incomplete,{partial:'The gateway answered. DNS was not tested.',message:'The connection ended.',review:()=>{document.getElementById('chat-input').value='Review the network report.';}});
  const reply=appendMessage('assistant','The latest host memory reading was 43%.');
  TLIMemory.decorateReply(reply,{
   provider:'bundled',handled_by:'llm',
   observation_context:{schema_version:1,topic:'ram',host:{id:'fixture-studio',name:'Studio'},resource:'Host memory',source:'Latest successful probe',observed_at:now,checked_at:now,status:'current',coverage:'One host sample; it does not measure this browser.'},
   input_budget:{version:1,provider:'bundled',model:'standard',estimation:'heuristic',capacity_status:'configured',context_tokens:4096,capacity_source:'owned_runtime_launch',reserved_output_tokens:1024,character_limit:12000,input_characters:2000,estimated_input_tokens:800,fit:'estimated',checked_at:now}
  });
  document.querySelectorAll('#chat-output details').forEach(n=>n.open=true);
 },now);
 const themes=await page.locator('#settings-theme option').evaluateAll(nodes=>nodes.filter(n=>n.value&&!n.disabled).map(n=>({value:n.value,label:n.textContent})));
 report.themes=themes;report.contrast=[];report.textEnlargement=[];assert.equal(themes.length,22);
 for(const theme of themes){
  await page.evaluate(value=>applyTheme(value),theme.value);
  const size=await layout(page,'panel-main');assert.deepEqual(size.overflow,[]);assert.ok(size.documentWidth<=392);
  const colors=await contrast(page,'chat-output');report.contrast.push({theme:theme.value,...colors});assert.deepEqual(colors.findings,[],`Changed chat surfaces must be readable in ${theme.value}`);
  const widths=await page.locator('#chat-output details,.chat-interruption').evaluateAll(nodes=>nodes.map(n=>({width:n.clientWidth,scroll:n.scrollWidth})));assert.ok(widths.every(n=>n.scroll<=n.width+2));
  report.checks.push({width:390,theme:theme.value,scenario:'Real receipt/interruption renderers with disclosures open, theme colors and wrapping',layout:size,receiptWidths:widths});
 }
 for(const theme of ['emeraldLight','midnight']){
  await page.setViewportSize({width:320,height:920});await page.evaluate(value=>applyTheme(value),theme);
  await textScale(page,'chat-output',true);
  const size=await layout(page,'panel-main');assert.deepEqual(size.overflow,[]);assert.ok(size.documentWidth<=322);
  const widths=await page.locator('#chat-output details,.chat-interruption').evaluateAll(nodes=>nodes.map(n=>({width:n.clientWidth,scroll:n.scrollWidth})));assert.ok(widths.every(n=>n.scroll<=n.width+2));
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  await page.locator('.chat-interruption').evaluate(n=>{const box=document.getElementById('chat-output');box.scrollTop+=n.getBoundingClientRect().top-box.getBoundingClientRect().top-12;});await capture(page,`text200-recovery-320-${theme}`);
  await page.getByText('Input size & model limits',{exact:true}).evaluate(n=>{const box=document.getElementById('chat-output');box.scrollTop+=n.getBoundingClientRect().top-box.getBoundingClientRect().top-12;});await capture(page,`text200-receipts-320-${theme}`);
  report.textEnlargement.push({width:320,theme,scale:2,layout:size,receiptWidths:widths,reducedMotion:true});
  report.checks.push({width:320,theme,scenario:'Changed chat surfaces at doubled text size with reduced motion',layout:size});
  await textScale(page,'chat-output',false);
 }
 assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[],'Changing themes and rendering context must not execute an action or inference');
 assert.deepEqual(run.errors,[]);await run.context.close();console.log(`Chat surfaces ${themes.length} themes, enlarged text and reduced motion`);
}
async function main(){const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const width of [1440,390,320])for(const theme of ['emeraldLight','midnight']){
  const run=await makePage(browser,width,theme),{page}=run;let generationCalls=0,release;
  const wait=new Promise(resolve=>release=resolve);
  await page.route('**/api/ai/chat/stream',async route=>{generationCalls++;await wait;await route.fulfill({contentType:'text/event-stream',body:
    frame({type:'meta',session_id:'fixture-chat',provider:'bundled',handled_by:'llm'})+
    frame({type:'delta',text:'The gateway responded in the selected report.\n\nDNS was not tested, so this evidence cannot establish the cause of the interruption.'})+
    frame({type:'error',detail:'The synthetic provider connection ended before completion.'})});});
  await page.evaluate(()=>switchPanel('panel-main'));
  await page.locator('#chat-input').fill('Help me interpret the network report.');await page.locator('#chat-send-btn').click();
  await page.waitForFunction(()=>document.getElementById('chat-send-btn').disabled);
  await page.locator('#chat-input').fill('Keep this newer draft.');release();
  await page.locator('.chat-interruption').waitFor();
  assert.equal(generationCalls,1);assert.match(await page.locator('#chat-output').innerText(),/The gateway responded.*DNS was not tested/s);
  assert.equal(await page.locator('#chat-input').inputValue(),'Keep this newer draft.');
  await page.locator('.chat-interruption').scrollIntoViewIfNeeded();
  await capture(page,`partial-response-${width}-${theme}`);
  const retry=page.getByRole('button',{name:'Review question to retry',exact:true});
  await retry.click();assert.equal(await page.locator('#chat-input').inputValue(),'Keep this newer draft.');assert.equal(generationCalls,1);
  await page.locator('#chat-input').fill('');await retry.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#chat-input').inputValue(),'Help me interpret the network report.');assert.equal(generationCalls,1);
  await page.locator('.chat-interruption').scrollIntoViewIfNeeded();
  const size=await layout(page,'panel-main');assert.deepEqual(size.overflow,[]);assert.deepEqual(size.duplicateIds,[]);assert.ok(size.documentWidth<=width+2);
  report.checks.push({width,theme,scenario:'Partial output and newer draft preserved; retry only prepares question',generationCalls,layout:size});
  await page.evaluate(()=>switchPanel('panel-devices'));const details=page.locator('#panel-devices > .tli-intelligence');await details.evaluate(n=>{n.open=true;});
  await page.getByRole('button',{name:/^Studio printer ·/}).click();
  assert.equal(await page.evaluate(()=>TLIIntelligence.getContext().diagnostic_id),'fixture-report');
  await page.evaluate(()=>loadConversation('fixture-resume','Setup discussion'));
  assert.equal(await page.evaluate(()=>TLIIntelligence.getContext().diagnostic_id),null);assert.equal(await page.evaluate(()=>TLIIntelligence.getContext().target_id),null);
  await page.getByRole('button',{name:/^Studio printer ·/}).click();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
  assert.equal(await page.evaluate(()=>TLIIntelligence.getContext().diagnostic_id),null);
  assert.equal(await page.locator('.tli-int-report').innerText(),'');assert.equal(generationCalls,1);
  report.checks.push({width,theme,scenario:'Successful conversation resume clears target/report; lock clears private diagnostic content without generation'});
  assert.deepEqual(run.errors,[]);report.sessions.push({width,theme,errors:run.errors,generationCalls,blockedOrReadCalls:run.calls});
  await run.context.close();console.log(`Chat recovery ${width} ${theme}`);
 }
 await receiptChecks(browser);
 await themeChecks(browser);
}catch(error){report.failures.push(error.stack||error.message);}finally{await browser.close();}
report.hashes=fingerprintFiles(source);report.sourceUnchanged=JSON.stringify(report.hashes)===JSON.stringify(report.hashesAtStart);
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,screenshots:report.screenshots.length,failures:report.failures.length,sourceUnchanged:report.sourceUnchanged}));
if(report.failures.length)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
