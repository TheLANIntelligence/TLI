/* Verify an existing Legacy browser can reach the new workspace without losing preferences. */
'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,layout}=require('./verify_anniversary_ui_browser.cjs');
const out=path.resolve(__dirname,'../build_work/premium-ui/experience-entry-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});
const report={synthetic:true,checks:[],errors:[]};
async function main(){const browser=await chromium.launch({headless:true});try{
  const run=await makePage(browser,1440,'cloudLight',{preserveSettingsOnReload:true}),{page}=run;
  await page.evaluate(()=>{TLIInterface.set('modern');TLIPresentation.set('legacy');});
  await page.reload({waitUntil:'load'});
  assert.equal(await page.locator('html').getAttribute('data-experience'),'legacy');
  assert.equal(await page.locator('#tli-use-new-experience').isVisible(),true);
  assert.equal(await page.locator('#tli-interface-select').getAttribute('aria-label'),'Legacy TLI layout');
  assert.equal(await page.locator('#panel-dashboard2 .nd-vitals').isVisible(),true);
  for(const width of [1440,768,390,320]){
    await page.setViewportSize({width,height:900});
    const check=await layout(page,'panel-dashboard2');
    assert.ok(check.documentWidth<=width+2,JSON.stringify({width,check}));
    const button=await page.locator('#tli-use-new-experience').boundingBox();assert.ok(button.x>=0&&button.x+button.width<=width+1);
    await page.screenshot({path:path.join(out,'legacy-'+width+'.png')});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>switchPanel('panel-main'));
  await page.locator('#chat-input').fill('Keep this unsent draft');
  await page.evaluate(()=>window.__entryDraft=document.getElementById('chat-input'));
  const colors=await page.evaluate(()=>localStorage.getItem('tli_settings'));
  await page.locator('#tli-use-new-experience').click();
  assert.equal(await page.locator('html').getAttribute('data-experience'),'premium');
  assert.equal(await page.locator('#premium-status-bar').isVisible(),true);
  assert.equal(await page.locator('#chat-input').inputValue(),'Keep this unsent draft');
  assert.equal(await page.locator('#chat-input').evaluate(e=>e===window.__entryDraft),true);
  assert.equal(await page.evaluate(()=>localStorage.getItem('tli_settings')),colors);
  report.checks.push('Explicit legacy label and visible upgrade at 320–1440px; button preserves current chat controller, draft and palette');
  await page.evaluate(()=>TLIPresentation.set('legacy'));
  await page.goto('http://tli-ui.test/?experience=premium&panel=dashboard2#keep',{waitUntil:'load'});
  assert.equal(await page.locator('html').getAttribute('data-experience'),'premium');
  assert.equal(page.url(),'http://tli-ui.test/?panel=dashboard2#keep');
  assert.equal(await page.locator('#nd-narrator').isVisible(),true);
  assert.equal(await page.locator('#panel-dashboard2 .nd-vitals').isVisible(),false);
  assert.equal(await page.locator('#premium-status-bar').isVisible(),true);
  assert.equal(await page.evaluate(()=>localStorage.getItem('tli_interface_style')),'modern');
  assert.equal(await page.evaluate(()=>localStorage.getItem('tli_settings')),colors);
  await page.reload({waitUntil:'load'});
  assert.equal(await page.locator('html').getAttribute('data-experience'),'premium');
  await page.screenshot({path:path.join(out,'new-experience.png')});
  report.checks.push('Activation link changes only the experience, consumes its parameter, preserves destination/hash/colors and survives reload');
  assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)),[]);assert.deepEqual(run.errors,[]);
  report.checks.push('No action requests or browser errors');await run.context.close();
}catch(error){report.errors.push(String(error.stack||error));process.exitCode=1;}finally{await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report},null,2));}}
main().catch(e=>{console.error(e);process.exitCode=1;});
