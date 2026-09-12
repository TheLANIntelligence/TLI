/* Real SPA with synthetic binary/AI responses; no live extraction, provider or file access. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {makePage,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/anniversary-completion/rich-documents-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),raw=Buffer.from('Synthetic binary fixture: the backend worker is covered by separate real PDF/DOCX tests.');
const text='The USB printer paused after waking from sleep.\nThe recorded fix was to replace its damaged USB cable.\nCurrent printer status is not established by this manual.';
function extracted(name){const format=name.endsWith('.pdf')?'pdf':'docx';return{ok:true,protocol:'tli-document-extraction-v1',document:{name,text,extraction:{origin:{version:1,format,original_sha256:hash(raw),original_bytes:raw.length,text_sha256:hash(text),parser:'synthetic review fixture',unit_kind:format==='pdf'?'page':'paragraph',total_units:3,units:[{number:1,start:1,end:2},{number:3,start:3,end:3}],empty_units:[2],omissions:['Text extraction only; no OCR or image contents.','Reading order, columns, tables and formatting may differ from the page.','Embedded attachments, annotations, scripts and external links are not loaded.']},expires_at:Math.floor(Date.now()/1000)+1800,signature:'e'.repeat(64)}}};}
const report={synthetic:true,source_before:fingerprintFiles(root),checks:[],screens:[],errors:[],physical_acceptance:'not_run',limitations:['Browser-only intercepted binary and AI fixtures; real parser behavior is covered by the separate isolated Python tests. No live TLI, model, files, devices or physical phone were used.']};
async function prepare(browser,width,theme){
 const run=await makePage(browser,width,theme);await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});
 assert.equal(await run.page.locator('html').getAttribute('data-theme'),theme,'Requested theme must be applied without fallback');
 const calls=[];let mode='ok',held;
 await run.page.route('**/api/ai/documents/*',async route=>{
  const url=new URL(route.request().url());calls.push({method:route.request().method(),path:url.pathname});
  if(url.pathname.endsWith('/extraction-capabilities'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,protocol:'tli-document-extraction-v1',formats:{pdf:{available:true},docx:{available:true}}})});
  if(mode==='hold')await new Promise(resolve=>held=resolve);
  if(mode==='fail')return route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({detail:'The PDF is encrypted. Choose a readable copy deliberately.'})});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(extracted(url.searchParams.get('name')))});
 });
 await run.page.evaluate(()=>{switchPanel('panel-main');TLIDocuments.open();});
 assert.equal(calls.length,0,'Opening review cannot upload or query AI');
 await run.page.getByText('PDF & Word documents',{exact:true}).click();
 await run.page.locator('#documents-check-support').click();await run.page.waitForFunction(()=>!document.getElementById('documents-rich-choose').disabled);
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
 return{...run,calls,mode:value=>mode=value,release:()=>held?.()};
}
async function choose(page,name='setup-manual.pdf'){await page.locator('#documents-rich-input').setInputFiles({name,mimeType:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:raw});await page.waitForFunction(()=>document.getElementById('documents-status').textContent.startsWith('Extraction complete.'));}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const theme of ['emeraldLight','midnight','classicTli'])for(const width of [1440,768,390,320]){
  const run=await prepare(browser,width,theme),{page}=run;await choose(page);
  assert.equal(run.calls.filter(c=>c.method==='POST').length,1);
  assert.equal(await page.evaluate(()=>TLIDocuments.describeContext().length),0);
  assert.equal(await page.getByText('Preview setup-manual.pdf',{exact:true}).evaluate(n=>n.parentElement.open),true);
  await page.locator('#documents-list').scrollIntoViewIfNeeded();
  const measured=await page.evaluate(()=>{const box=document.getElementById('documents-dialog'),vw=document.documentElement.clientWidth;return{viewport:vw,document:document.documentElement.scrollWidth,overflow:[...box.querySelectorAll('button,input,pre,summary')].filter(n=>n.getClientRects().length).filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>vw+1}).map(n=>n.id||n.tagName)};});
  assert.equal(measured.overflow.length,0,JSON.stringify(measured));
  assert.match(await page.locator('#documents-list').innerText(),/L2: The recorded fix/);
  const screen=`${theme}-${width}-review.png`;await page.screenshot({path:path.join(output,screen)});report.screens.push(screen);
  await page.locator('#documents-use').click();
  await page.evaluate(()=>{const context=TLIDocuments.requestContext({});const d=context.documents[0];const meta={document_context:{actions_performed:false,documents:[{name:d.name,sha256:d.extraction.origin.text_sha256,line_count:3,chars:[...d.text].length,extraction:d.extraction.origin,coverage:{mode:'excerpts',selection:'question_terms',ranges:[{start:1,end:2}],included_lines:2,omitted_lines:1}}]}};const bubble=document.createElement('div');bubble.id='rich-fixture-answer';bubble.className='chat-bubble assistant';bubble.textContent='The manual records a cable replacement. That describes an earlier fix, not the printer’s present health. [setup-manual.pdf:L2-L2]';document.querySelector('#chat-messages, #chat-body, #chat-output').append(bubble);TLIDocuments.annotateReply(bubble,meta);TLIDocuments.sent(context,meta);});
  await page.locator('#rich-fixture-answer').scrollIntoViewIfNeeded();
  await page.locator('#rich-fixture-answer summary').click();
  assert.match(await page.locator('#rich-fixture-answer').innerText(),/Page 1: L1–L2/);
  assert.doesNotMatch(await page.locator('#rich-fixture-answer').innerText(),/Page 3:/);
  const answer=`${theme}-${width}-receipt.png`;await page.screenshot({path:path.join(output,answer)});report.screens.push(answer);
  assert.equal(await page.evaluate(()=>TLIDocuments.describeContext().length),0);report.checks.push({theme,width,measured,passed:true});report.errors.push(...run.errors);await run.context.close();
 }
 const run=await prepare(browser,1440,'emeraldLight'),{page}=run;await choose(page);await page.locator('#documents-use').click();await page.evaluate(()=>TLIDocuments.open());
 run.mode('fail');await page.locator('#documents-rich-input').setInputFiles({name:'other.pdf',mimeType:'application/pdf',buffer:raw});await page.waitForFunction(()=>document.getElementById('documents-status').textContent.includes('encrypted'));
 assert.match(await page.locator('#documents-list').innerText(),/setup-manual.pdf/);assert.doesNotMatch(await page.locator('#documents-list').innerText(),/other.pdf/);
 run.mode('hold');await page.locator('#documents-rich-input').setInputFiles({name:'late.pdf',mimeType:'application/pdf',buffer:raw});await page.waitForFunction(()=>document.getElementById('documents-use').disabled);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));run.release();await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>TLIDocuments.describeContext().length),0);assert.equal(await page.locator('#documents-dialog').isVisible(),false);assert.doesNotMatch(await page.locator('#documents-list').innerText(),/manual|USB|late.pdf/);
 report.checks.push({behavior:'failed extraction retains prior review; lock clears private selection and rejects late extraction; no replay',passed:true});report.errors.push(...run.errors);await run.context.close();
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.passed=false;report.failure=e.stack;process.exitCode=1;}finally{await browser.close();report.source_after=fingerprintFiles(root);report.source_changed=JSON.stringify(report.source_before)!==JSON.stringify(report.source_after);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,screens:report.screens.length,source_changed:report.source_changed,errors:report.errors,failure:report.failure}));}})();
