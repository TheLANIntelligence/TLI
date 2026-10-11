/* Separate-copy recovery acceptance. All host responses and archive bytes are synthetic. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {makePage,layout,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {contrast,textScale}=require('./verify_anniversary_themes_browser.cjs');
const output=path.resolve(__dirname,'../build_work/separate-recovery/browser-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const bytes=Buffer.alloc(512,73),hash=crypto.createHash('sha256').update(bytes).digest('hex'),password='Synthetic recovery passphrase 2026';
const destination='C:\\TLI-Recovery\\Anniversary copy';
const common=()=>({ok:true,schema_version:1,scope:'separate-data-copy',destination,archive_sha256:hash,source:{owner_id:'fixture-archive-owner',tli_version:'1.0',source_host:{id:'fixture-source',name:'Studio source'},exported_at:'2026-09-07T18:00:00Z'},counts:{notebook:8,conversations:12,diagnostics:3},owner_mapping:{source_owner:'fixture-archive-owner',target_owner:'local'},activated:false});
const review=()=>({...common(),review_token:'synthetic-single-use-review',checked_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),included:['This account’s retained Notes & fixes records','Saved AI conversations and diagnostic reports'],excluded:['Vault contents, credentials, PIN, identity and paired phones','Application files, models, configuration and other accounts'],limitations:['No automatic activation or merge into current data'],required_free_bytes:8388608,available_free_bytes:1073741824});
const receipt=()=>({...common(),completed_at:new Date().toISOString(),readback:{ok:true,schema_version:1,reader:'current-application',owner:'local',counts:common().counts,checks:{encrypted_payloads:true,current_readers:true,record_identifiers:true,stored_metadata:true,owner_mapping:true,files_unchanged:true},checked_at:new Date().toISOString()}});
const report={source,output,synthetic:true,hashesAtStart:fingerprintFiles(source),checks:[],screenshots:[],themes:[],contrast:[],failures:[],limitations:['All archive files and responses are synthetic. The browser never contacts live TLI, writes a recovery folder, starts inference, activates a host or operates a device.','The browser matrix verifies the real frontend; server archive/path/transaction tests are recorded separately.','Doubled computed text sizing is simulated; physical phones, native applications, OS scaling and screen-reader acceptance are not claimed.']};
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
async function shot(page,name){const file=name+'.png';await page.screenshot({path:path.join(output,file),fullPage:false});report.screenshots.push(file);}
async function open(run){const {page}=run;await page.goto('https://tli-ui.test/',{waitUntil:'load'});await page.waitForFunction(()=>typeof TLISettingsWorkspace?.open==='function');await page.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('data','data-recovery-settings');});await page.locator('#recovery-copy-settings>summary').click();}
async function fill(page){await page.locator('#recovery-copy-file').setInputFiles({name:'Synthetic.tlibackup',mimeType:'application/octet-stream',buffer:bytes});await page.locator('#recovery-copy-password').fill(password);await page.locator('#recovery-copy-destination').fill(destination);}
async function frameAt(page,selector){await page.locator(selector).evaluate(n=>{const main=document.querySelector('.main-scroll');main.scrollTo({top:main.scrollTop+n.getBoundingClientRect().top-main.getBoundingClientRect().top-16,behavior:'instant'});});}
async function checkLayout(page,width){const value=await layout(page,'panel-settings');assert.deepEqual(value.overflow,[]);assert.deepEqual(value.duplicateIds,[]);assert.ok(value.documentWidth<=width+2);return value;}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const width of [1440,390,320])for(const theme of ['emeraldLight','midnight']){
  const run=await makePage(browser,width,theme),{page}=run;const operations=[];let mode='success',release,hold=false;
  await page.route('**/api/intelligence/backups/recovery/*',async route=>{
   const req=route.request(),kind=req.url().endsWith('/review')?'review':'create';operations.push({kind,body:req.postData()});
   if(hold)await new Promise(resolve=>release=resolve);
   if(mode==='network')return route.abort('failed');
   if(mode==='failure')return json(route,{detail:'Synthetic destination check failed.'},409);
   return json(route,kind==='review'?review():receipt());
  });
  await open(run);assert.equal(operations.length,0);await fill(page);assert.equal(await page.locator('#recovery-copy-create').isDisabled(),true);await frameAt(page,'#recovery-copy-settings');await shot(page,`prepare-${width}-${theme}`);
  hold=true;await page.locator('#recovery-copy-review').click();await page.waitForFunction(()=>document.getElementById('recovery-copy-review').disabled);await page.waitForTimeout(30);assert.equal(operations.length,1);
  await page.evaluate(()=>document.getElementById('recovery-copy-review').click());assert.equal(operations.length,1);hold=false;release();
  await page.locator('#recovery-copy-review-result').waitFor({state:'visible'});assert.equal(await page.locator('#recovery-copy-create').isDisabled(),true);
  const reviewText=await page.locator('#recovery-copy-review-result').innerText();assert.match(reviewText,/fixture-archive-owner.*fresh local owner/s);assert.match(reviewText,/not an installed application/);assert.ok(reviewText.includes(destination));assert.ok(reviewText.includes(hash));
  await frameAt(page,'#recovery-copy-review-result');await shot(page,`review-${width}-${theme}`);const reviewedLayout=await checkLayout(page,width);
  await page.locator('#recovery-copy-ack').focus();await page.keyboard.press('Space');await page.locator('#recovery-copy-create').focus();await page.keyboard.press('Enter');
  await page.locator('#recovery-copy-receipt').waitFor({state:'visible'});assert.equal(operations.length,2);assert.match(operations[1].body,/synthetic-single-use-review/);assert.match(operations[1].body,/Synthetic recovery passphrase/);
  assert.equal(await page.locator('#recovery-copy-password').inputValue(),'');assert.equal(await page.locator('#recovery-copy-create').isDisabled(),true);
  const completed=await page.locator('#recovery-copy-receipt').innerText();assert.match(completed,/Current application readers reopened.*not activated/s);
  await frameAt(page,'#recovery-copy-receipt');await shot(page,`completed-${width}-${theme}`);
  report.checks.push({width,theme,scenario:'Open sends nothing; review reserves one request; keyboard acknowledgement/create sends exactly one reviewed copy',layout:reviewedLayout});
  await fill(page);mode='failure';await page.locator('#recovery-copy-review').click();await page.waitForFunction(()=>!document.getElementById('recovery-copy-review').disabled);assert.equal(await page.locator('#recovery-copy-receipt').innerText(),completed);assert.match(await page.locator('#recovery-copy-status').innerText(),/previous completed receipt remains/);
  mode='success';await page.locator('#recovery-copy-review').click();await page.locator('#recovery-copy-review-result').waitFor({state:'visible'});await page.locator('#recovery-copy-ack').check();mode='network';await page.locator('#recovery-copy-create').click();await page.waitForFunction(()=>!document.getElementById('recovery-copy-review').disabled);
  assert.match(await page.locator('#recovery-copy-status').innerText(),/outcome is uncertain.*Nothing was retried/s);assert.equal(await page.locator('#recovery-copy-receipt').innerText(),completed);assert.equal(operations.length,5);
  report.checks.push({width,theme,scenario:'Failed replacement review and uncertain create preserve the prior receipt without retry or activation'});
  await fill(page);await page.locator('#recovery-copy-settings>summary').click();assert.equal(await page.locator('#recovery-copy-password').inputValue(),'');assert.equal(await page.locator('#recovery-copy-destination').inputValue(),'');assert.equal(await page.locator('#recovery-copy-receipt').isVisible(),false);assert.equal(operations.length,5);
  report.checks.push({width,theme,scenario:'Closing recovery removes private drafts/review/receipt and sends no further request'});
  if(width===1440&&theme==='emeraldLight'){
   await page.locator('#recovery-copy-settings>summary').click();await fill(page);
   await page.evaluate(()=>TLISettingsWorkspace.open('general'));await page.waitForFunction(()=>document.getElementById('recovery-copy-password').value==='');assert.equal(await page.locator('#recovery-copy-destination').inputValue(),'');
   await page.evaluate(()=>TLISettingsWorkspace.open('data','data-recovery-settings'));await fill(page);mode='success';await page.locator('#recovery-copy-review').click();await page.locator('#recovery-copy-review-result').waitFor({state:'visible'});await page.locator('#recovery-copy-ack').check();
   hold=true;await page.locator('#recovery-copy-create').click();await page.waitForTimeout(30);assert.equal(operations.length,7);
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#recovery-copy-password').inputValue(),'');assert.equal(await page.locator('#recovery-copy-destination').inputValue(),'');hold=false;release();await page.waitForTimeout(30);assert.equal(await page.locator('#recovery-copy-receipt').isVisible(),false);assert.match(await page.locator('#recovery-copy-status').innerText(),/may have completed/);
   report.checks.push({width,theme,scenario:'Switching Settings categories clears private drafts; locking during create ignores the late receipt without claiming server cancellation'});
  }
  assert.deepEqual(run.errors,[]);await run.context.close();console.log(`Recovery ${width} ${theme}`);
 }
 await themes(browser);
}catch(error){report.failures.push(error.stack||error.message);}finally{await browser.close();}
 report.hashesAtEnd=fingerprintFiles(source);report.sourceUnchanged=JSON.stringify(report.hashesAtStart)===JSON.stringify(report.hashesAtEnd);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,screenshots:report.screenshots.length,themes:report.themes.length,failures:report.failures.length,sourceUnchanged:report.sourceUnchanged}));if(report.failures.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
async function themes(browser){
 const run=await makePage(browser,390,'emeraldLight'),{page}=run;let operations=0;
 await page.route('**/api/intelligence/backups/recovery/*',route=>{operations++;return json(route,review());});await open(run);await fill(page);await page.locator('#recovery-copy-review').click();await page.locator('#recovery-copy-review-result').waitFor({state:'visible'});
 await page.evaluate(()=>{window.__themeAuditVisible=el=>{if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;for(let a=el;a;a=a.parentElement){if(Number(getComputedStyle(a).opacity)===0)return false;if(a!==el&&a.tagName==='DETAILS'&&!a.open&&!a.querySelector(':scope > summary')?.contains(el))return false;}return true;};document.querySelectorAll('#recovery-copy-review-result details').forEach(n=>n.open=true);});
 report.themes=await page.locator('#settings-theme option').evaluateAll(nodes=>nodes.filter(n=>n.value&&!n.disabled).map(n=>({value:n.value,label:n.textContent})));assert.equal(report.themes.length,22);
 for(const theme of report.themes){await page.evaluate(value=>applyTheme(value),theme.value);const size=await checkLayout(page,390),colors=await contrast(page,'recovery-copy-settings');report.contrast.push({theme:theme.value,...colors});assert.deepEqual(colors.findings,[]);report.checks.push({width:390,theme:theme.value,scenario:'Recovery review/acknowledgement and expanded scope remain readable',layout:size});}
 for(const theme of ['emeraldLight','midnight']){await page.setViewportSize({width:320,height:1000});await page.evaluate(value=>applyTheme(value),theme);await textScale(page,'recovery-copy-settings',true);const size=await checkLayout(page,320);await frameAt(page,'#recovery-copy-review-result');await shot(page,`text200-${theme}`);report.checks.push({width:320,theme,scenario:'Doubled computed text and reduced-motion fixture',layout:size});await textScale(page,'recovery-copy-settings',false);}
 assert.equal(operations,1);assert.deepEqual(run.errors,[]);await run.context.close();
}
