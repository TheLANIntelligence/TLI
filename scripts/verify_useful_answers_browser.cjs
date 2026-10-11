/* Actual SPA, controlled browser streams and owned synthetic notes. No live TLI. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {makePage,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {contrast,textScale,measuredLayout}=require('./verify_anniversary_themes_browser.cjs');
const before=process.argv.includes('--before');
const output=path.resolve(__dirname,'../build_work/useful-answers',(before?'before-':'browser-')+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const report={source,output,before,synthetic:true,hashesAtStart:fingerprintFiles(source),checks:[],themes:[],screenshots:[],failures:[],limitations:['Browser fixtures intercept every request. Follow-up selection and document excerpt relevance are backend evaluation gates, not inferred from these simulated answer receipts.','Timing is measured in the browser from Send; it is not model throughput. Physical phones, native apps, real inference, and screen-reader acceptance are not claimed.','Theme checks use computed contrast on solid surfaces and 200% computed text simulation; detailed visual review is Emerald Light and Midnight.']};
const now=new Date().toISOString(),ref={conversation_id:'fixture-useful',message_index:1,revision:'a'.repeat(64)};
const oldNote={id:'f-printer-setup',revision:'b'.repeat(64),title:'Studio printer connection',text:'Old fix: restart the printer after changing Wi-Fi.',category:'device',device_id:'retired-studio-printer',source:'user_confirmation',created_at:now,updated_at:now};
const newText='Keep the printer on the same Wi-Fi network as Studio. Check the saved connection details before changing anything.';
const preview={source:{...ref,role:'assistant',created_at:now,provider:'bundled',model:'Qwen2.5 3B'},source_kind:'ai_suggestion',text:newText,suggested_text:newText,suggested_title:'Printer connection advice',requires_excerpt:false};
fixtures['/api/ai/documents/capabilities']={ok:true,protocol:'tli-document-questions-v1'};
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
async function screenshot(page,name){const file=name+'.png';await page.screenshot({path:path.join(output,file),fullPage:false});report.screenshots.push(file);}
async function visible(page){await page.evaluate(()=>{window.__themeAuditVisible=el=>{if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;for(let a=el;a;a=a.parentElement){if(Number(getComputedStyle(a).opacity)===0)return false;if(a!==el&&a.tagName==='DETAILS'&&!a.open&&!a.querySelector(':scope > summary')?.contains(el))return false;}return true;};});}
async function sized(page,id,width){const size=await measuredLayout(page,id);assert.deepEqual(size.overflow,[]);assert.ok(size.documentWidth<=width+2);const boxes=await page.locator('#'+id).evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(boxes.scroll<=boxes.width+2);return size;}
async function openReview(page){await page.evaluate(ref=>{const output=document.getElementById('chat-output');const bubble=output.querySelector('.chat-bubble-ai')||output.querySelector('.chat-bubble:last-child');TLIMemory.decorateMessage(bubble,{source_ref:ref});},ref);await page.getByRole('button',{name:'Save to Notes & fixes…',exact:true}).last().click();await page.locator('#memory-save-text').waitFor();}
async function updateMode(page){await page.locator('#memory-save-mode').selectOption('update');await page.locator('#memory-save-target option[value="f-printer-setup"]').waitFor({state:'attached'});await page.locator('#memory-save-target').selectOption(oldNote.id);}
async function installStream(page){await page.evaluate(()=>{
 const original=window.fetch;window.__usefulStreams=[];
 window.fetch=async function(input,options={}){
  const url=typeof input==='string'?input:input.url;
  if(!String(url).includes('/api/ai/chat/stream'))return original.call(this,input,options);
  const entry={body:JSON.parse(options.body||'{}'),closed:false,cancelled:false};window.__usefulStreams.push(entry);
  return new Response(new ReadableStream({start(controller){entry.frame=data=>{if(!entry.closed)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(data)+'\n\n'));};entry.close=()=>{if(!entry.closed){entry.closed=true;controller.close();}};},cancel(){entry.cancelled=true;entry.closed=true;}}),{headers:{'Content-Type':'text/event-stream'}});
 };
});}
async function send(page,text){const count=await page.evaluate(()=>__usefulStreams.length);await page.locator('#chat-input').fill(text);await page.locator('#chat-send-btn').click();await page.waitForFunction(n=>__usefulStreams.length===n+1,count);return count;}
async function frames(page,index,frames,close=false){await page.evaluate(({index,frames,close})=>{for(const frame of frames)__usefulStreams[index].frame(frame);if(close)__usefulStreams[index].close();},{index,frames,close});}
async function done(page,index,metadata,text){await frames(page,index,[{type:'meta',session_id:'fixture-useful',provider:'bundled',handled_by:'llm',...metadata},{type:'delta',text},{type:'done'}],true);await page.waitForFunction(()=>!document.getElementById('chat-send-btn').disabled);}
async function setup(browser,width,theme){const run=await makePage(browser,width,theme);await visible(run.page);let current={...oldNote},saves=0,fail=false;
 await run.page.route(/\/api\/intelligence\/memory(?:\?.*)?$/,route=>json(route,{facts:[current]}));
 await run.page.route('**/api/intelligence/memory/from-chat/preview',route=>json(route,preview));
 await run.page.route('**/api/intelligence/memory/from-chat/save',route=>{saves++;const data=route.request().postDataJSON();if(fail)return json(route,{detail:'The saved note changed. Refresh and review its latest revision.'},409);current={...current,title:data.title,text:data.text,category:data.category,device_id:data.device_id,source:'chat_ai',revision:'c'.repeat(64)};return json(route,{ok:true,already_saved:false,updated_existing:!!data.note_id,note:current});});
 await run.page.evaluate(()=>switchPanel('panel-main'));await installStream(run.page);
 return{...run,get note(){return current},get saves(){return saves},set fail(v){fail=v}};}
async function workflow(browser,width,theme){const run=await setup(browser,width,theme),{page}=run;
 const index=await send(page,'Help me understand the printer connection.');await page.locator('#chat-response-status').waitFor();
 assert.match(await page.locator('#chat-response-status-text').innerText(),before?/working/:/Waiting/);
 await screenshot(page,`waiting-${width}-${theme}`);
 await frames(page,index,[{type:'meta',session_id:'fixture-useful',provider:'bundled',handled_by:'llm',source_ref:ref},{type:'delta',text:newText}]);
 await page.waitForFunction(text=>document.getElementById('chat-output').innerText.includes(text),newText);
 if(!before)assert.match(await page.locator('#chat-response-status-text').innerText(),/Receiving/);
 await frames(page,index,[{type:'done'}],true);await page.waitForFunction(()=>!document.getElementById('chat-send-btn').disabled);
 if(!before){assert.match(await page.locator('.chat-response-timing').last().innerText(),/First text.*Response received.*Browser timing/);report.checks.push({width,theme,flow:'Controlled actual SSE: waiting, first displayed text, final browser timing'});}
 await openReview(page);
 if(before){await screenshot(page,`saved-copy-${width}-${theme}`);await run.context.close();return;}
 await updateMode(page);assert.equal(await page.locator('#memory-save-device').inputValue(),oldNote.device_id);assert.equal(await page.locator('#memory-save-category').inputValue(),oldNote.category);
 assert.match(await page.locator('#memory-save-comparison').innerText(),/Old fix:.*Keep the printer/s);assert.equal(run.saves,0);
 await page.locator('#memory-save-comparison').scrollIntoViewIfNeeded();await screenshot(page,`review-update-${width}-${theme}`);
 await sized(page,'memory-save-dialog',width);report.checks.push({width,theme,flow:'Explicit owned target, retired computer preserved, current/proposed comparison; no mutation until reviewed save'});
 await page.locator('#memory-save-reviewed').check();run.fail=true;await page.locator('#memory-save-confirm').click();await page.getByText(/Refresh current notes and review again/).waitFor();
 assert.equal(await page.locator('#memory-save-text').inputValue(),newText);assert.equal(run.saves,1);
 await page.locator('#memory-save-confirm').click();assert.equal(run.saves,1);
 run.fail=false;await page.locator('#memory-save-refresh').click();await page.locator('#memory-save-target').selectOption(oldNote.id);await page.locator('#memory-save-reviewed').check();
 await page.locator('#memory-save-confirm').focus();await page.keyboard.press('Enter');await page.getByText(/Updated the reviewed note/).waitFor();assert.equal(run.saves,2);
 report.checks.push({width,theme,flow:'409 preserves proposal, blocks duplicate re-save, explicit refreshed review updates exact note'});
 await page.getByRole('button',{name:'Close review',exact:true}).click();
 const recall=await send(page,'What did we decide about that?');
 await done(page,recall,{memory_context:{use_saved_memory:true,status:'included',notes:[run.note],omitted_for_budget:0},conversation_context:{status:'included',included_messages:2,included_exchanges:1,omitted_messages:0,character_budget:12000}},'The current saved note says to keep the printer on the same Wi-Fi network. It is a saved AI suggestion, not a verified fix.');
 await page.getByText('Context for this answer',{exact:true}).last().click();assert.match(await page.locator('#chat-output').innerText(),/AI suggestion, unconfirmed/);
 report.checks.push({width,theme,flow:'Follow-up answer renders supplied current note revision/source and prior-exchange receipt; generation once per explicit Send'});
 await page.locator('#new-chat-btn').click();await page.evaluate(()=>TLIDocuments.open());
 const document=Array.from({length:100},(_,i)=>`Line ${i+1}: ${i===49?'The DNS server is 192.0.2.53. ':'Background setup detail. '}`.padEnd(160,'.')).join('\n');
 await page.locator('#documents-input').setInputFiles({name:'studio-network.md',mimeType:'text/markdown',buffer:Buffer.from(document)});await page.locator('#documents-use').click();
 const docs=await send(page,'What DNS server is recorded?');
 assert.equal(await page.evaluate(i=>__usefulStreams[i].body.documents[0].text,docs),document);
 const document_context={actions_performed:false,documents:[{name:'studio-network.md',sha256:crypto.createHash('sha256').update(document).digest('hex'),line_count:100,chars:document.length,coverage:{mode:'excerpts',selection:'question_terms',ranges:[{start:49,end:51}],included_lines:3,omitted_lines:97}}]};
 await done(page,docs,{document_context},'The selected excerpt records DNS server 192.0.2.53 (studio-network.md, line 50). The rest of the file was not supplied in this answer.');
 await page.locator('.documents-receipt').waitFor();assert.match(await page.locator('.documents-receipt').innerText(),/97.*omitted|omitted.*97/i);await page.locator('.documents-receipt').scrollIntoViewIfNeeded();await screenshot(page,`document-excerpts-${width}-${theme}`);await sized(page,'panel-main',width);
 report.checks.push({width,theme,flow:'Browser attachment reviewed and sent once; excerpt receipt shows exact original hash/line ranges and 97 omitted lines'});
 await page.locator('#new-chat-btn').click();const stop=await send(page,'Explain why this network check matters.');await frames(page,stop,[{type:'delta',text:'The gateway answered. DNS still needs a separate observation.'}]);await page.waitForFunction(()=>document.getElementById('chat-output').innerText.includes('The gateway answered'));
 await page.locator('#chat-input').fill('My newer draft');await page.locator('#abort-chat-btn').click();await page.locator('.chat-interruption').waitFor();
 assert.equal(await page.locator('#chat-input').inputValue(),'My newer draft');assert.match(await page.locator('.chat-response-timing').innerText(),/Stopped waiting after/);
 const count=await page.evaluate(()=>__usefulStreams.length);await page.getByRole('button',{name:'Review question to retry',exact:true}).click();assert.equal(await page.evaluate(()=>__usefulStreams.length),count);
 await frames(page,stop,[{type:'delta',text:'LATE_PRIVATE_OUTPUT'},{type:'done'}],true);assert.doesNotMatch(await page.locator('#chat-output').innerText(),/LATE_PRIVATE_OUTPUT/);
 await page.locator('.chat-interruption').scrollIntoViewIfNeeded();await screenshot(page,`stopped-${width}-${theme}`);
 report.checks.push({width,theme,flow:'Stop preserves partial answer/newer draft, stamps stopped browser wait, ignores late delta, and never retries'});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#memory-save-editor').innerText(),'');assert.equal(await page.locator('#chat-response-status').isVisible(),false);
 report.checks.push({width,theme,flow:'Session lock clears note review and active progress; no delayed resurrection'});
 assert.deepEqual(run.errors,[]);assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)&&!c.url.includes('conversations')),[]);
 await run.context.close();console.log(`Workflows ${width} ${theme}`);
}
async function themes(browser){const run=await setup(browser,390,'emeraldLight'),{page}=run;
 const i=await send(page,'Explain the printer connection.');await done(page,i,{source_ref:ref},newText);await openReview(page);await updateMode(page);
 const themes=await page.locator('#settings-theme option').evaluateAll(options=>options.filter(o=>o.value&&!o.disabled).map(o=>({id:o.value,name:o.textContent})));assert.equal(themes.length,22);
 for(const theme of themes){await page.evaluate(id=>applyTheme(id),theme.id);const size=await sized(page,'memory-save-dialog',390),colors=await contrast(page,'memory-save-dialog');assert.deepEqual(colors.findings,[],theme.id);report.themes.push({theme,...colors,layout:size});}
 for(const theme of ['emeraldLight','midnight']){await page.evaluate(id=>applyTheme(id),theme);await page.setViewportSize({width:320,height:920});await textScale(page,'memory-save-dialog',true);await sized(page,'memory-save-dialog',320);await page.locator('#memory-save-comparison').scrollIntoViewIfNeeded();await screenshot(page,`text200-review-320-${theme}`);await textScale(page,'memory-save-dialog',false);}
 assert.equal(run.saves,0);await page.getByRole('button',{name:'Close review',exact:true}).click();
 await page.evaluate(()=>{const bubble=document.querySelector('#chat-output .chat-bubble:last-child');TLIDocuments.annotateReply(bubble,{document_context:{actions_performed:false,documents:[{name:'studio-network.md',sha256:'d'.repeat(64),line_count:100,chars:16000,coverage:{mode:'excerpts',selection:'question_terms',ranges:[{start:49,end:51}],included_lines:3,omitted_lines:97}}]}});});
 for(const theme of themes){await page.evaluate(id=>applyTheme(id),theme.id);await sized(page,'panel-main',320);const colors=await contrast(page,'chat-output');assert.deepEqual(colors.findings,[],theme.id);report.checks.push({theme:theme.id,flow:'Updated note modal, excerpt receipt and browser timing renderers: computed contrast, wrapping and no save/navigation side effects'});}
 assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
 assert.deepEqual(run.errors,[]);await run.context.close();}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const width of before?[1440,320]:[1440,390,320])for(const theme of before?[width===1440?'emeraldLight':'midnight']:['emeraldLight','midnight'])await workflow(browser,width,theme);
 if(!before)await themes(browser);
}catch(e){report.failures.push(e.stack||String(e));}finally{await browser.close();}
report.hashes=fingerprintFiles(source);report.sourceUnchanged=JSON.stringify(report.hashes)===JSON.stringify(report.hashesAtStart);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,themes:report.themes.length,screenshots:report.screenshots.length,failures:report.failures,sourceUnchanged:report.sourceUnchanged}));if(report.failures.length)process.exitCode=1;})();
