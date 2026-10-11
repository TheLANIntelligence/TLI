/* Real SPA; all network requests intercepted with synthetic data. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {makePage, layout, fixtures} = require('./verify_anniversary_ui_browser.cjs');
const output = path.resolve(__dirname, '../build_work/premium-ui/acceptance-' + new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output, {recursive:true});
const report = {synthetic:true, output, layouts:[], checks:[], errors:[], captures:[], navigationMs:[]};
Object.assign(fixtures, {'/actions/capabilities':{devices:[]}, '/actions/list':{actions:[],triggers:[]}, '/api/intelligence/places':{ok:true,places:[]}});
async function capture(page, name) {
  if(await page.locator('#panel-dashboard2').isVisible()) await page.waitForFunction(()=>{
    const statement=document.getElementById('nd-statement');
    return Number(getComputedStyle(statement).opacity)===1 && statement.textContent.trim().length>0;
  });
  const file = path.join(output,name+'.png'); await page.screenshot({path:file}); report.captures.push(file);
}
async function checkLayout(page,id,meta) { const result=await layout(page,id); report.layouts.push({id,...meta,...result}); assert.equal(result.overflow.length,0,JSON.stringify({id,...meta,overflow:result.overflow})); assert.ok(result.documentWidth<=result.width+2); assert.equal(result.duplicateIds.length,0); }
async function main() {
  const browser=await chromium.launch({headless:true});
  try {
    const run=await makePage(browser,1440,'lavenderLite',{preserveSettingsOnReload:true}), {page}=run;
    assert.equal(await page.locator('html').getAttribute('data-experience'),'premium');
    assert.equal(await page.locator('#panel-dashboard2').isVisible(),true);
    assert.deepEqual(await page.locator('.simplified-main-nav .ui-nav-label').allTextContents(),['Dashboard','Ask TLI','Create','Files','Smart home','Computers']);
    assert.equal(await page.locator('.simplified-main-nav [data-panel-target="panel-dashboard2"]').getAttribute('aria-current'),'page');
    assert.equal(await page.locator('#nd-narrator').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.getElementById('nd-attention').compareDocumentPosition(document.getElementById('home-launchpad')) & Node.DOCUMENT_POSITION_FOLLOWING),4);
    await page.waitForFunction(()=>document.getElementById('nd-statement-text').textContent.trim().length>0);
    const narratorNode=await page.locator('#nd-narrator').evaluate(e=>{window.__narratorNode=e;return e.id;});
    await page.evaluate(()=>{TLIThemes.apply('pacific');TLIPresentation.set('legacy');TLIPresentation.set('premium');});
    assert.equal(await page.locator('#nd-narrator').evaluate(e=>e===window.__narratorNode),true);
    assert.equal(narratorNode,'nd-narrator');
    assert.equal(await page.locator('#nd-narrator').isVisible(),true);
    await page.reload({waitUntil:'load'});
    await page.waitForFunction(()=>document.getElementById('nd-statement-text').textContent.trim().length>0);
    assert.equal(await page.locator('#panel-dashboard2').isVisible(),true);
    await page.locator('.simplified-main-nav [data-panel-target="panel-main"]').click();
    assert.equal(await page.locator('#panel-main').isVisible(),true);
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.evaluate(()=>document.fonts.check('14px "TLI Inter"')),true);
    assert.equal(await page.locator('.sidebar-logo').innerText(),'TLI');
    const brand = await page.locator('.sidebar-logo').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,accent:getComputedStyle(e).getPropertyValue('--accent').trim()}));
    assert.ok(brand.bg !== 'rgb(8, 120, 88)','Lavender brand must follow palette');
    report.checks.push('Dashboard and live Narrator at startup/reload; six primary destinations; original Narrator survives appearance switches; chat one click away');
    report.checks.push('Local font and one palette-colored brand');
    await page.locator('#chat-input').fill('Keep this draft exactly');
    await page.evaluate(()=>{window.__draftNode=document.getElementById('chat-input');window.__draftNode.focus();window.__draftNode.setSelectionRange(2,8);TLIInterface.set('classic');});
    assert.equal(await page.locator('html').getAttribute('data-interface'),'modern');
    await page.evaluate(()=>TLIPresentation.set('legacy'));
    assert.equal(await page.locator('html').getAttribute('data-interface'),'classic');
    await page.evaluate(()=>TLIPresentation.set('premium'));
    assert.equal(await page.evaluate(()=>document.getElementById('chat-input')===window.__draftNode),true);
    assert.equal(await page.locator('#chat-input').inputValue(),'Keep this draft exactly');
    assert.equal(await page.evaluate(()=>document.getElementById('chat-input').selectionStart),2);
    assert.equal(await page.evaluate(()=>localStorage.getItem('tli_interface_style')),'classic');
    report.checks.push('Legacy round trip preserves mounted draft/selection and saved Classic choice');
    await page.locator('#chat-input').fill('');
    const panels=['panel-dashboard2','panel-main','panel-builder','panel-homeauto','panel-files','panel-visualizer','panel-mesh','panel-settings','panel-vault','panel-more','panel-help'];
    for (const width of [1440,768,390,320]) {
      await page.setViewportSize({width,height:width<800?844:1000});
      if(width<769) {
        const dashboard=page.locator('.tli-bottom-nav [data-panel-target="panel-dashboard2"]');
        assert.equal(await dashboard.isVisible(),true);
        await dashboard.click();
        assert.equal(await dashboard.getAttribute('aria-current'),'page');
        assert.equal(await page.locator('#nd-narrator').isVisible(),true);
      }
      for(const id of panels) {
        await page.evaluate(id=>switchPanel(id),id);
        await page.waitForTimeout(60);
        await checkLayout(page,id,{width});
        if([1440,390].includes(width)) await capture(page,`${id}-${width}`);
      }
    }
    const themes=await page.evaluate(()=>TLIThemes.themes.map(t=>t.id));
    for(const theme of themes) {
      await page.setViewportSize({width:1440,height:1000});
      await page.evaluate(theme=>{TLIThemes.apply(theme);switchPanel('panel-main');},theme);
      await checkLayout(page,'panel-main',{theme,width:1440});
      if(['emeraldLight','midnight','pacific','copper','roseQuartz','oled'].includes(theme)) await capture(page,`ask-${theme}`);
      await page.setViewportSize({width:320,height:844});
      await checkLayout(page,'panel-main',{theme,width:320});
      await page.evaluate(()=>switchPanel('panel-dashboard2'));
      assert.equal(await page.locator('#nd-narrator').isVisible(),true);
      await checkLayout(page,'panel-dashboard2',{theme,width:320});
      await page.setViewportSize({width:1440,height:1000});
      await checkLayout(page,'panel-dashboard2',{theme,width:1440});
      if(['emeraldLight','pacific'].includes(theme)) await capture(page,`dashboard-${theme}`);
    }
    report.checks.push('All 23 themes in conversation and Dashboard at desktop and 320px; direct mobile Dashboard navigation');
    await page.setViewportSize({width:1440,height:1000});
    for(let i=0;i<30;i++) {
      const id=panels[i%panels.length];
      report.navigationMs.push(await page.evaluate(async id=>{const start=performance.now();switchPanel(id);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return performance.now()-start;},id));
    }
    const sorted=report.navigationMs.slice().sort((a,b)=>a-b); report.navigationP75=sorted[Math.floor(sorted.length*.75)];
    report.checks.push('Repeated local navigation measured to second animation frame (lab proxy, not field INP)');
    assert.ok(report.navigationP75<=200,`Navigation p75 ${report.navigationP75}ms`);
    await page.goto('http://tli-ui.test/?panel=main',{waitUntil:'load'});
    await page.waitForFunction(()=>document.getElementById('panel-main').classList.contains('active'));
    assert.equal(await page.locator('#panel-main').isVisible(),true);
    report.checks.push('Explicit Chat deep links still open Chat');
    assert.equal(run.errors.length,0,run.errors.join('\n'));
    const writes=run.calls.filter(c=>!['GET','HEAD'].includes(c.method));
    assert.deepEqual(writes,[],'Appearance/navigation must not operate tools');
    report.checks.push('No browser errors, no action requests, all external requests blocked');
    await run.context.close();
  } catch(error) { report.errors.push(String(error.stack||error)); process.exitCode=1; }
  finally { await browser.close(); fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({output,checks:report.checks,layouts:report.layouts.length,navigationP75:report.navigationP75,errors:report.errors},null,2)); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
