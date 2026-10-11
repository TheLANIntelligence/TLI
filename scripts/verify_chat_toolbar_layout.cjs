/* Real browser layout regression: native closed details vs actual overflow.
 * No app server, model, user data or household action. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,layout,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/anniversary-completion/chat-toolbar-layout-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const report={synthetic:true,source_before:fingerprintFiles(root),checks:[],screens:[],errors:[],physical_acceptance:'not_run'};
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:768,height:800}});
  for(const fallback of [false,true]){
   await page.setContent('<section id="fixture"><details id="outer"><summary><button id="visible-summary" style="position:absolute;left:1500px;width:150px">Visible summary</button></summary><button id="hidden-content" style="position:absolute;left:1400px;width:150px">Hidden content</button><details open><summary>Nested</summary><button id="hidden-nested" style="position:absolute;left:1300px;width:150px">Nested hidden content</button></details></details><div hidden><button id="hidden-attribute" style="position:absolute;left:1200px;width:150px">Hidden</button></div></section>');
   await page.evaluate(fallback=>{window.savedVisibility??=Element.prototype.checkVisibility;Element.prototype.checkVisibility=fallback?undefined:window.savedVisibility;},fallback);
   const closed=await layout(page,'fixture');assert.deepEqual(closed.overflow.map(r=>r.id),['visible-summary'],'Visible summary controls remain checked; hidden details descendants do not');
   await page.evaluate(()=>document.getElementById('outer').open=true);const opened=await layout(page,'fixture');assert.deepEqual(opened.overflow.map(r=>r.id),['visible-summary','hidden-content','hidden-nested'],'Opening exposes real overflowing controls');
   report.checks.push({name:fallback?'Native-details visibility fallback':'Browser-native checkVisibility',passed:true,closed,opened});
  }
  await page.close();
  for(const width of [1024,768,390,320])for(const theme of ['emeraldLight','midnight']){
   const run=await makePage(browser,width,theme),{page}=run;await page.evaluate(()=>switchPanel('panel-main'));const before=run.calls.length;
   for(const opened of [false,true]){
    await page.evaluate(opened=>document.getElementById('chat-options').open=opened,opened);await page.waitForTimeout(40);
    const measured=await layout(page,'panel-main');assert.deepEqual(measured.overflow,[]);assert.ok(measured.documentWidth<=width+2);
    const controls=await page.evaluate(()=>['documents-open','teaching-toggle','tts-voice-select','screenshot-start'].map(id=>{const e=document.getElementById(id);return {id,visible:e.checkVisibility({visibilityProperty:true}),right:e.getBoundingClientRect().right};}));assert.ok(controls.every(c=>c.visible===opened));
    report.checks.push({width,theme,opened,passed:true,measured,controls});
    if(opened){await page.locator('#chat-options').scrollIntoViewIfNeeded();const name=`${theme}-${width}-options.png`;await page.screenshot({path:path.join(output,name)});report.screens.push(name);}
   }
   assert.equal(run.calls.slice(before).filter(r=>r.method!=='GET'&&r.method!=='HEAD').length,0);report.errors.push(...run.errors);await run.context.close();
  }
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(e){report.passed=false;report.error=String(e.stack||e);process.exitCode=1;}
 finally{report.source_after=fingerprintFiles(root);report.source_changed=JSON.stringify(report.source_before)!==JSON.stringify(report.source_after);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,screens:report.screens.length,error:report.error}));}
})();
