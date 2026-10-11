/* Real SPA with intercepted synthetic services; never scans or controls devices. */
'use strict';
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {makePage,layout,fixtures} = require('./verify_anniversary_ui_browser.cjs');
const {contrast} = require('./verify_anniversary_themes_browser.cjs');
const out = path.resolve(__dirname,'../build_work/header-status/'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});
const report={synthetic:true,checks:[],layouts:[],contrast:[],errors:[],screenshots:[]};
async function capture(page,name){const file=path.join(out,name+'.png');await page.screenshot({path:file});report.screenshots.push(file);}
async function main(){
  const browser=await chromium.launch({headless:true});
  try{
    const command=fixtures['/dashboard/command-center'];
    Object.assign(command,{ts:Date.now()/1000,storage:{ok:true,system:{drive:'C:',mount:'C:\\',pct:98,free_gb:9.7,total_gb:476.3}},devCount:2,devNames:['Desk lamp','Studio fan']});
    const run=await makePage(browser,1800,'pacific'),{page}=run;
    await page.evaluate(()=>window.__themeAuditVisible=e=>e.checkVisibility({visibilityProperty:true})&&!e.closest('[hidden]'));
    await page.waitForFunction(()=>document.getElementById('premium-status-storage')?.textContent.includes('98%'));
    assert.equal(await page.locator('#panel-dashboard2').isVisible(),true);
    assert.equal(await page.locator('#nd-narrator').isVisible(),true);
    assert.equal(await page.locator('#panel-dashboard2 .nd-vitals').isVisible(),false);
    assert.equal(await page.locator('#premium-status-storage').getAttribute('data-tone'),'critical');
    assert.match(await page.locator('#premium-status-devices').innerText(),/2 devices/);
    assert.match(await page.locator('#device-name-chip').innerText(),/Studio/);
    report.checks.push('Dashboard and Narrator retained; spacious cards replaced by header with visible critical storage');
    await page.locator('#premium-status-storage').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#premium-status-dialog').isVisible(),true);
    assert.match(await page.locator('#premium-status-dialog').innerText(),/9.7 GB/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement.id==='premium-status-storage');
    await page.locator('#premium-status-devices').click();
    assert.match(await page.locator('#premium-status-dialog').innerText(),/Registered.*availability|availability.*Registered/is);
    assert.match(await page.locator('#premium-status-dialog').innerText(),/Desk lamp/);
    await page.locator('#premium-status-dialog > button').click();
    assert.equal(await page.locator('#panel-homeauto').isVisible(),true);
    await page.locator('#premium-status-storage').click();await page.locator('#premium-status-dialog > button').click();
    assert.equal(await page.locator('#panel-visualizer').isVisible(),true);
    assert.equal(await page.locator('#visualizerPathInput').inputValue(),'C:\\');
    report.checks.push('Keyboard open/Escape/focus return; retained device names; explicit navigation prepares exact drive without scanning');
    await page.evaluate(()=>switchPanel('panel-main'));
    await page.locator('#chat-input').fill('Preserve this draft');
    await page.evaluate(()=>window.__keptDraft=document.getElementById('chat-input'));
    await page.locator('#premium-status-ai').click();
    assert.match(await page.locator('#premium-status-dialog').innerText(),/AI source/);
    await page.evaluate(()=>TLIThemes.apply('lavenderLite'));
    assert.equal(await page.locator('#premium-status-dialog').isVisible(),true);
    await page.keyboard.press('Escape');
    await page.evaluate(()=>TLIPresentation.set('legacy'));
    assert.equal(await page.locator('#premium-status-bar').isVisible(),false);
    await page.evaluate(()=>switchPanel('panel-dashboard2'));
    assert.equal(await page.locator('#panel-dashboard2 .nd-vitals').isVisible(),true);
    await page.evaluate(()=>{TLIPresentation.set('premium');switchPanel('panel-main');});
    assert.equal(await page.locator('#chat-input').inputValue(),'Preserve this draft');
    assert.equal(await page.locator('#chat-input').evaluate(e=>e===window.__keptDraft),true);
    report.checks.push('Global header works beyond Dashboard; dialog survives theme change; legacy cards and mounted chat draft preserved');
    await page.evaluate(()=>{
      window.__realHeaderObservation=TLIPresence.getObservation;
      const prior=TLIPresence.getObservation();
      TLIPresence.getObservation=()=>({...prior,storageCheckedAt:window.__headerExpiry,monitoringUnavailable:false,storageUnavailable:false});
      window.__headerExpiry=Date.now()-29800;
      window.dispatchEvent(new CustomEvent('tli-system-observation'));
    });
    await page.waitForFunction(()=>document.getElementById('premium-status-storage').textContent.includes('Previous'));
    assert.equal(await page.locator('#premium-status-storage').getAttribute('data-tone'),'critical');
    await page.evaluate(()=>{TLIPresence.getObservation=window.__realHeaderObservation;window.dispatchEvent(new CustomEvent('tli-system-observation'));});
    report.checks.push('One-shot expiry labels old storage without another observation or request and retains its critical warning');
    await page.evaluate(()=>switchPanel('panel-dashboard2'));
    const themes=await page.evaluate(()=>TLIThemes.themes.map(t=>t.id));
    for(const theme of themes){
      await page.evaluate(theme=>TLIThemes.apply(theme),theme);
      const colors=await contrast(page,'premium-status-bar');report.contrast.push({theme,where:'header',...colors});assert.deepEqual(colors.findings,[],JSON.stringify({theme,colors}));
      for(const width of [1800,1440,768,390,320]){
        await page.setViewportSize({width,height:width<800?844:1000});
        await page.waitForTimeout(20);
        const state=await layout(page,'panel-dashboard2'); report.layouts.push({theme,width,...state});
        assert.equal(state.overflow.length,0,JSON.stringify({theme,width,overflow:state.overflow}));
        assert.ok(state.documentWidth<=width+2);assert.equal(state.duplicateIds.length,0);
        const chipBoxes=await page.locator('.premium-status-chip').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right,height:r.height};}));
        for(const b of chipBoxes){assert.ok(b.x>=0&&b.right<=width+1);assert.ok(b.height>=(width<=768?44:36));}
        if(['pacific','cloudLight'].includes(theme)&&[1800,390].includes(width))await capture(page,theme+'-'+width);
        if(width===320){
          await page.locator('#premium-status-storage').click();
          const box=await page.locator('#premium-status-dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=321&&box.y+box.height<=845);
          const colors=await contrast(page,'premium-status-dialog');report.contrast.push({theme,where:'details',...colors});assert.deepEqual(colors.findings,[],JSON.stringify({theme,colors}));
          await page.keyboard.press('Escape');
        }
      }
    }
    report.checks.push('All 23 themes; five widths down to 320px; critical storage and usable detail dialogs');
    await page.locator('#premium-status-devices').click();
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
    assert.equal(await page.locator('#premium-status-dialog').isVisible(),false);
    assert.match(await page.locator('#premium-status-devices').innerText(),/Locked/);
    assert.equal(await page.locator('#premium-status-devices').isDisabled(),true);
    assert.doesNotMatch(await page.locator('#premium-status-dialog').innerText(),/Desk lamp|Studio fan/);
    assert.deepEqual(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)||/^\/visualizer\/(scan|large-files|duplicates)$/.test(c.path)),[]);
    assert.deepEqual(run.errors,[]);
    report.checks.push('Lock clears retained data and closes dialog; no action/scan requests or browser errors');
    await run.context.close();
  }catch(error){report.errors.push(String(error.stack||error));process.exitCode=1;}
  finally{await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,checks:report.checks,layouts:report.layouts.length,errors:report.errors},null,2));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
