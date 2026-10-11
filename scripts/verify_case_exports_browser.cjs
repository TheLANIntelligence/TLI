/* Real SPA, synthetic intercepted exports only. No running TLI or household data. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {makePage,fixtures,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/anniversary-completion/case-exports-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const stamp=new Date().toISOString(),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const problem={id:'case-'+'a'.repeat(32),revision:'b'.repeat(64),title:'Studio printing stalls after wake',symptom:'The printer queue paused twice yesterday.',computer:null,status:'open',archived:false,steps:[],resolution:'',created_at:stamp,updated_at:stamp,evidence:[
 {kind:'note',id:'fixture-note',revision:'c'.repeat(64),label:'Previous cable fix · setup details',availability:'current',linked_at:stamp},
 {kind:'report',id:'fixture-report',revision:'d'.repeat(64),label:'Earlier network report · source changed',availability:'changed',linked_at:stamp}]};
const envelope=data=>({ok:true,protocol:'tli-cases-v1',checked_at:stamp,actions_performed:false,...data});
fixtures['/api/intelligence/cases']=envelope({items:[problem],total:1});fixtures['/api/intelligence/cases/'+problem.id]=envelope({case:problem});
const escape=v=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function packet(selection){
 const text='TLI · Reviewed troubleshooting export\n\nHistorical saved records, not current health.\nAutomatic redaction cannot find every secret. This file is unencrypted and is not a backup.\n\nProblem · User record\nStudio printing stalls after wake\nSymptom: The printer queue paused twice yesterday.\nStatus: Open — still investigating\n\nSelected evidence\n'+(selection.evidence.length?'E1 · historical_saved_note\nPrevious cable fix\nRecorded setup detail: [redacted] cable was replaced. Improvement was recorded then; current printer health is unknown.':'No linked evidence selected.')+'\n\nNo checks, repairs or AI requests ran for this export.\n';
 const preview=selection.format==='html'?'<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{background:#f4f6f5;color:#18342b;font:16px/1.65 system-ui;margin:1.4rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style></head><body><pre>'+escape(text)+'</pre></body></html>':selection.format==='json'?JSON.stringify({historical_record:text},null,2):text;
 return{ok:true,protocol:'tli-case-export-v1',checked_at:stamp,actions_performed:false,source_unchanged:true,format:selection.format,preview,bytes:Buffer.byteLength(preview),preview_sha256:hash(preview),review_token:'e'.repeat(64),expires_in_seconds:600,filename:'tli-troubleshooting.'+({html:'html',text:'txt',json:'json'}[selection.format])};
}
const report={synthetic:true,source_before:fingerprintFiles(root),checks:[],screens:[],errors:[],sandbox_fixture_rejections:[],physical_acceptance:'not_run',limitations:['Intercepted browser fixtures only. No live TLI, household files, model, phone or devices were used.','The opaque-origin preview correctly rejects Playwright/shared-fixture init scripts that try to read serviceWorker/localStorage; these exact harness exceptions are recorded separately. No sandbox permission is weakened.']};
function collectErrors(run){for(const error of run.errors){
 const harness=/^SecurityError: Failed to read the '(serviceWorker|localStorage)' property from '(Navigator|Window)': (?:Service worker is disabled because the context|The document) is sandboxed and lacks the 'allow-same-origin' flag\./.test(error)&&!error.includes('https://tli-ui.test/');
 (harness?report.sandbox_fixture_rejections:report.errors).push(error);
}}
async function prepare(browser,width,theme){
 const run=await makePage(browser,width,theme);await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});await run.page.waitForFunction(()=>typeof TLICaseExport==='object');
 assert.equal(await run.page.locator('html').getAttribute('data-theme'),theme,'Requested theme must be applied without fallback');
 let latest;const calls=[];let mode='ok',held;
 await run.page.route('**/api/intelligence/case-exports/*',async route=>{
  const req=route.request(),body=req.postDataJSON();calls.push({path:new URL(req.url()).pathname,body});
  if(mode==='hold'){await new Promise(resolve=>held=resolve);}
  if(mode==='fail')return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'Selected source changed; review the latest version.'})});
  if(req.url().endsWith('/preview')){latest=packet(body);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(latest)});}
  return route.fulfill({status:200,contentType:'text/html',headers:{'X-TLI-Export-SHA256':latest.preview_sha256},body:latest.preview});
 });
 await run.page.evaluate(()=>switchPanel('panel-troubleshooting'));await run.page.getByRole('button',{name:problem.title,exact:true}).click();await run.page.getByRole('button',{name:'Export…',exact:true}).click();
 assert.equal(calls.length,0);assert.equal(await run.page.locator('#case-export-content-1').isDisabled(),true);
 return{...run,calls,mode:value=>mode=value,release:()=>held?.()};
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const theme of ['emeraldLight','midnight','classicTli'])for(const width of [1440,768,390,320]){
  const run=await prepare(browser,width,theme),{page}=run;
  await page.locator('#case-export-content-0').check();await page.locator('#case-export-preview-button').click();await page.waitForFunction(()=>document.querySelector('#case-export-output iframe'));
  assert.equal(run.calls.length,1);assert.equal(run.calls[0].body.evidence.length,1);assert.equal(run.calls[0].body.evidence[0].include_content,true);
  const measured=await page.evaluate(()=>{const box=document.getElementById('case-export-dialog'),vw=document.documentElement.clientWidth;return{document_width:document.documentElement.scrollWidth,viewport:vw,dialog:box.getBoundingClientRect().width,overflow:[...box.querySelectorAll('input,textarea,button,select,iframe')].filter(n=>n.getClientRects().length).filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>vw+1}).map(n=>n.id),sandbox:document.querySelector('#case-export-output iframe').getAttribute('sandbox')};});
  assert.equal(measured.overflow.length,0,JSON.stringify(measured));assert.equal(measured.sandbox,'');
  await page.locator('#case-export-dialog').evaluate(n=>n.scrollTop=0);const file=`${theme}-${width}-selection.png`;await page.screenshot({path:path.join(output,file)});report.screens.push(file);
  await page.locator('#case-export-output').scrollIntoViewIfNeeded();const preview=`${theme}-${width}-preview.png`;await page.screenshot({path:path.join(output,preview)});report.screens.push(preview);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#case-export-dialog').isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Export…',exact:true}).evaluate(n=>document.activeElement===n),true);
  report.checks.push({theme,width,measured,passed:true});collectErrors(run);await run.context.close();
 }
 const run=await prepare(browser,1440,'emeraldLight'),{page}=run;
 await page.locator('#case-export-preview-button').click();await page.waitForFunction(()=>document.querySelector('#case-export-output iframe'));
 await page.locator('#case-export-reviewed').check();let emitted=0;page.on('download',()=>emitted++);
 const downloaded=page.waitForEvent('download');await page.locator('#case-export-download').click();await downloaded;
 assert.equal(emitted,1);assert.equal(run.calls.filter(c=>c.path.endsWith('/download')).length,1);
 run.mode('fail');await page.locator('#case-export-download').click();await page.waitForFunction(()=>document.getElementById('case-export-status').textContent.includes('Selected source changed'));
 assert.equal(await page.locator('#case-export-output iframe').count(),1);assert.equal(emitted,1);
 run.mode('hold');await page.locator('#case-export-preview-button').click();await page.waitForFunction(()=>document.getElementById('case-export-preview-button').disabled);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));run.release();await page.waitForTimeout(150);
 assert.equal(await page.locator('#case-export-dialog').innerText(),'');assert.equal(await page.locator('#case-export-output').count(),0);assert.equal(emitted,1);
 report.checks.push({behavior:'reviewed synthetic download; failed replacement retained; lock rejects late preview; no replay',passed:true});collectErrors(run);await run.context.close();
 assert.deepEqual(fingerprintFiles(root),report.source_before,'Frontend source changed during capture; rerun matched evidence');assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.passed=false;report.failure=e.stack;process.exitCode=1;}finally{await browser.close();report.source_after=fingerprintFiles(root);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,screens:report.screens.length,errors:report.errors,failure:report.failure}));}})();
