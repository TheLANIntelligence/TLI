/* Real browser shell, intercepted synthetic hosts. No live TLI or household work. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
process.argv.push('--label','dependable-computers');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {contrast,textScale}=require('./verify_anniversary_themes_browser.cjs');
const before=process.argv.includes('--before'),quick=process.argv.includes('--quick');
const output=path.join(root,'build_work/dependable-computers',`browser-${before?'before':'after'}-`+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const report={source,synthetic:true,before,started_at:new Date().toISOString(),checks:[],layouts:[],screenshots:[],errors:[],limitations:['Requests are intercepted; no live restart, PIN, pairing, inference or device action.','Source/browser checks do not validate physical phones or another household computer.','Computed contrast and doubled text complement visual review; a physical screen reader was not exercised.']};
const hash=filename=>crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const matched=JSON.parse(JSON.stringify(fixtures['/api/diagnostics/version']));
fixtures['/visualizer/cleanup/receipts']={ok:true,receipts:[]};
fixtures['/visualizer/history']={ok:true,protocol:'storage-history-v1',snapshots:[]};
async function record(page,name,width,theme,mode,selector='panel-visualizer',screenshot=true){
 const measure=await layout(page,selector);report.layouts.push({name,width,theme,mode,...measure});
 assert.equal(measure.duplicateIds.length,0);assert.ok(measure.documentWidth<=width+2,`${name}: document overflow`);
 assert.deepEqual(measure.overflow,[],`${name}: controls overflow`);
 if(screenshot){const file=path.join(output,`${name}-${width}-${theme}-${mode}.png`);await page.screenshot({path:file,fullPage:true});report.screenshots.push({name,file,sha256:hash(file)});}
}
async function check(name,body){try{await body();report.checks.push({name,passed:true});}catch(e){report.checks.push({name,passed:false,error:e.stack});report.errors.push(e.stack);}fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
async function ready(browser,width=1440,theme='emeraldLight',mode='modern'){
 const run=await makePage(browser,width,theme);await run.page.evaluate(mode=>{TLIInterface.set(mode);switchPanel('panel-visualizer');},mode);
 await run.page.waitForFunction(()=>window.TLIFreeSpace?.getState);
 await run.page.evaluate(()=>window.__themeAuditVisible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width>0);
 return run;
}
async function main(){
 const hashes=fingerprintFiles(source),browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 for(const mode of ['modern','classic']){
  const run=await ready(browser,1440,'emeraldLight',mode),p=run.page;
  try{
   await check(`${mode}: navigation has no mutations`,async()=>{
    for(const id of ['panel-mesh','panel-companion','panel-troubleshooting','panel-visualizer']){await p.evaluate(id=>switchPanel(id),id);await p.waitForTimeout(70);}
    assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);
   });
   if(!before){
    await check(`${mode}: matching host has no warning`,async()=>{await p.evaluate(()=>TLIRelease.check(true));assert.equal(await p.locator('#tli-release-notice').isVisible(),false);});
    await check(`${mode}: Settings exposes running identity without an online update check`,async()=>{
     try{
     await p.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('app','settings-section-updates');});
     await p.locator('.tli-release-settings summary').click();assert.match(await p.locator('#settings-release-identity').innerText(),new RegExp('a'.repeat(64)));
     await p.locator('#settings-release-recheck').focus();await p.keyboard.press('Enter');
     for(const width of [1440,320]){await p.setViewportSize({width,height:1000});await record(p,'settings-identity',width,'emeraldLight',mode,'settings-section-updates');}
     assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);
     }finally{
     await p.setViewportSize({width:1440,height:1000});await p.evaluate(()=>switchPanel('panel-visualizer'));
     }
    });
    await p.route('**/api/diagnostics/version',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,build_id:'older-runtime'})}));
    await check(`${mode}: old host explains mismatch and blocks a new storage job`,async()=>{
     await p.evaluate(()=>TLIRelease.check(true));await p.locator('#tli-release-notice').waitFor();
     assert.match(await p.locator('#tli-release-message').innerText(),/cannot confirm/);
     await p.locator('#visualizerPathInput').fill('C:\\Users\\Demo\\Downloads');await p.locator('#visualizerScanBtn').click();
     await p.waitForFunction(()=>!TLIFreeSpace.getState().busy);
     assert.equal(run.calls.some(c=>c.path==='/visualizer/jobs'&&c.method==='POST'),false);
     assert.match(await p.locator('#panel-visualizer').innerText(),/request was rejected/);
     await p.locator('#tli-release-recheck').focus();await p.keyboard.press('Enter');
     assert.equal(run.calls.some(c=>c.path==='/visualizer/jobs'&&c.method==='POST'),false);
    });
    await record(p,'unsupported-host',1440,'emeraldLight',mode);
    await p.unroute('**/api/diagnostics/version');
    const drift=JSON.parse(JSON.stringify(matched));drift.release.compatibility.state='restart_required';
    await p.route('**/api/diagnostics/version',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(drift)}));
    await p.evaluate(()=>TLIRelease.check(true));
    await check(`${mode}: changed source reports manual restart and never retries work`,async()=>{
     assert.match(await p.locator('#tli-release-message').innerText(),/Existing work has not been cancelled/);
     await p.locator('#tli-release-notice summary').click();assert.match(await p.locator('#tli-release-detail').innerText(),/Running application/);
     assert.equal(run.calls.some(c=>!['GET','HEAD'].includes(c.method)),false);
    });
    const themes=quick?['emeraldLight','midnight']:await p.evaluate(()=>TLIThemes.themes.map(t=>t.id));
    for(const theme of themes){await p.setViewportSize({width:390,height:1000});await p.evaluate(t=>TLIThemes.apply(t),theme);
     await check(`${mode}: ${theme} warning controls at 390px`,async()=>{await record(p,'restart',390,theme,mode,'tli-release-notice',['emeraldLight','midnight'].includes(theme));const c=await contrast(p,'tli-release-notice');assert.deepEqual(c.findings,[]);});}
    for(const width of [1440,768,320])for(const theme of ['emeraldLight','midnight']){
     await p.setViewportSize({width,height:1000});await p.evaluate(t=>TLIThemes.apply(t),theme);
     await check(`${mode}: ${theme} ${width}px restart message`,()=>record(p,'restart',width,theme,mode,'tli-release-notice'));
     if(width===320){await textScale(p,'tli-release-notice',true);await check(`${mode}: enlarged ${theme} warning`,()=>record(p,'restart-enlarged',width,theme,mode,'tli-release-notice'));await textScale(p,'tli-release-notice',false);}
    }
   }
   await p.route('**/system/pin/lock',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,locked:true})}));
   await p.setViewportSize({width:1440,height:1000});await p.evaluate(()=>TLIThemes.apply('emeraldLight'));
   await p.locator('#tli-lock-btn').click();await p.locator('#tli-lock-screen').waitFor();await p.waitForTimeout(160);
   for(const width of [1440,390,320])for(const theme of ['emeraldLight','midnight']){
    await p.setViewportSize({width,height:1000});await p.evaluate(t=>TLIThemes.apply(t),theme);
    await check(`${mode}: ${width}px ${theme} lock form`,async()=>{
     const box=await p.locator('.tli-lock-card').boundingBox();if(!before)assert.ok(box.width<=420,`Lock form ${box.width}px`);
     await record(p,'lock',width,theme,mode,'tli-lock-screen');
    });
   }
   report.errors.push(...run.errors);
  }finally{await run.context.close();}
 }
 }finally{
  await browser.close();report.sourceUnchanged=JSON.stringify(hashes)===JSON.stringify(fingerprintFiles(source));report.frontend_hashes=hashes;
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,checks:report.checks.length,failed:report.checks.filter(c=>!c.passed).length,errors:report.errors,sourceUnchanged:report.sourceUnchanged}));
  if(report.errors.length||!report.sourceUnchanged)process.exitCode=1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
