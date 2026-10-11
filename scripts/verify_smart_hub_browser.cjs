/* Actual SPA and actual controllers with synthetic responses; no live host writes. */
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {makePage, layout, fixtures, source, fingerprintFiles} = require('./verify_anniversary_ui_browser.cjs');
const output = path.resolve(__dirname, '../build_work/smart-hub/browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, {recursive:true});
const report = {source, output, synthetic:true, behaviors:[], layouts:[], captures:[], failures:[], hashesAtStart:fingerprintFiles(source)};
Object.assign(fixtures, {
  '/actions/list':{actions:[],triggers:[]}, '/actions/capabilities':{devices:[]},
  '/api/intelligence/places':{ok:true,protocol:'saved-places-v1',places:[]},
  '/dashboard/activity-summary':{ok:true,cursor:{sequence:0},total:0,warning_count:0,group_count:0,coverage:'retained',coverage_note:'Eligible activity is retained on this host.',retention_limit:100,groups:[],events:[],checked_at:Math.floor(Date.now()/1000),history:{limit:500,days:30,status:'recording'}},
});
async function check(page,id,meta) {
  const result = await layout(page,id); report.layouts.push({id,...meta,...result});
  if (result.overflow.length || result.documentWidth > result.width+2 || result.duplicateIds.length) report.failures.push({id,...meta,...result});
}
async function capture(page,name) { const file = name+'.png'; await page.screenshot({path:path.join(output,file),fullPage:true}); report.captures.push(file); }
async function interactions(browser) {
  const run = await makePage(browser,1440,'emeraldLight',{preserveSettingsOnReload:true}), {page} = run;
  await page.evaluate(()=>switchPanel('panel-dashboard2'));
  await page.locator('[data-home-task="space"]').click();
  assert.equal(await page.locator('#panel-visualizer').evaluate(e=>e.hidden),false);
  await page.evaluate(()=>switchPanel('panel-dashboard2'));
  await page.locator('[data-home-task="organize"]').click();
  await page.locator('#fo-root-path').count().then(async count=>{ if(count) await page.locator('#fo-root-path').fill('C:\\Keep my folder'); });
  await page.evaluate(()=>switchPanel('panel-dashboard2'));
  assert.deepEqual(await page.locator('[data-home-recent]').allTextContents(), ['Files','Free Space']);
  await page.locator('[data-home-recent="panel-files"]').click();
  if(await page.locator('#fo-root-path').count()) assert.equal(await page.locator('#fo-root-path').inputValue(),'C:\\Keep my folder');
  report.behaviors.push('Tasks and recent-workspace links open the real workspace without starting scans or altering a chosen folder.');
  await page.evaluate(()=>switchPanel('panel-dashboard2'));
  await page.getByRole('button',{name:'Edit shortcuts',exact:true}).click();
  await page.locator('#home-edit-dialog input[value="space"]').uncheck();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.locator('[data-home-task="space"]').count(),1);
  await page.getByRole('button',{name:'Edit shortcuts',exact:true}).click();
  await page.locator('#home-edit-dialog input[value="phone"]').check();
  await page.locator('#home-edit-dialog input[value="vault"]').check();
  assert.equal(await page.locator('#home-edit-dialog input[value="ask"]').isDisabled(),true);
  await page.getByRole('button',{name:'Save shortcuts',exact:true}).click();
  assert.equal(await page.locator('[data-home-task]').count(),6);
  await page.reload(); await page.evaluate(()=>switchPanel('panel-dashboard2'));
  assert.equal(await page.locator('[data-home-task="phone"]').count(),1);
  assert.equal(await page.locator('#home-resume').isVisible(),false);
  report.behaviors.push('Home shortcut editing supports cancellation, a six-item limit, browser-local persistence, and no persisted visit history.');
  await page.evaluate(()=>{ switchPanel('panel-main'); document.getElementById('chat-input').value='Keep my unfinished question'; switchPanel('panel-dashboard2'); });
  await page.locator('.home-ask').click();
  assert.equal(await page.locator('#chat-input').inputValue(),'Keep my unfinished question');
  assert.equal(await page.evaluate(()=>TLIChatWorkspace.prepareDraft('A new question')),false);
  assert.equal(await page.locator('#chat-input').inputValue(),'Keep my unfinished question');
  await page.evaluate(()=>{document.getElementById('chat-input').value='';document.getElementById('chat-image-preview').classList.remove('hidden');});
  assert.equal(await page.evaluate(()=>TLIChatWorkspace.prepareDraft('Do not attach to this image')),false);
  await page.evaluate(()=>{document.getElementById('chat-image-preview').classList.add('hidden');document.getElementById('chat-send-btn').disabled=true;});
  assert.equal(await page.evaluate(()=>TLIChatWorkspace.prepareDraft('Wait for the active reply')),false);
  await page.evaluate(()=>{document.getElementById('chat-send-btn').disabled=false;});
  assert.equal(await page.evaluate(()=>TLIChatWorkspace.prepareDraft('Help me understand my options.')),true);
  assert.equal(await page.locator('#chat-input').inputValue(),'Help me understand my options.');
  report.behaviors.push('Home Ask TLI preserves drafts; dashboard starters refuse existing drafts, attachments and active answers, and prepare unsent text only.');
  await page.evaluate(()=>switchPanel('panel-dashboard2'));
  await page.getByRole('button',{name:'Edit shortcuts',exact:true}).click();
  await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));
  assert.equal(await page.locator('#home-edit-dialog').evaluate(e=>e.open),false);
  assert.equal(await page.locator('#home-resume').isVisible(),false);
  assert.equal(await page.evaluate(()=>TLIChatWorkspace.prepareDraft('Blocked while locked')),false);
  await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-unlocked')));
  assert.equal(await page.locator('[data-home-recent]').count(),0);
  report.behaviors.push('Session locking closes the editor, clears visit history, and blocks starter preparation.');
  assert.deepEqual(run.errors,[]);
  const writes = run.calls.filter(c=>!['GET','HEAD'].includes(c.method)); assert.deepEqual(writes,[],'Navigation must not write or run operations');
  await run.context.close();
}
async function matrix(browser) {
  for(const width of [1440,1024,768,390,320]) for(const theme of ['emeraldLight','midnight']) {
    const run = await makePage(browser,width,theme), {page} = run;
    for(const style of ['modern','classic']) {
      await page.evaluate(style=>{TLIInterface.set(style);switchPanel('panel-dashboard2');},style);
      await page.waitForTimeout(120);
      await check(page,'panel-dashboard2',{width,theme,style});
      if([1440,390].includes(width)) await capture(page,`home-${width}-${theme}-${style}`);
      await page.getByRole('button',{name:'Edit shortcuts',exact:true}).click();
      await check(page,'home-edit-dialog',{width,theme,style});
      if(width===390&&theme==='midnight'&&style==='modern') await capture(page,'customize-home-390');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button',{name:'Edit shortcuts',exact:true}).evaluate(e=>e===document.activeElement),true);
    }
    assert.deepEqual(run.errors,[]); await run.context.close();
  }
  const run=await makePage(browser,1280,'emeraldLight'), {page}=run;
  const themes=await page.evaluate(()=>TLIThemes.themes.map(t=>t.id));
  for(const theme of themes) for(const style of ['modern','classic']) {
    await page.evaluate(({theme,style})=>{TLIThemes.apply(theme);TLIInterface.set(style);switchPanel('panel-dashboard2');},{theme,style});
    await check(page,'panel-dashboard2',{width:1280,theme,style,smoke:true});
  }
  await run.context.close();
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try { await interactions(browser); await matrix(browser); }
  catch(error) { report.failures.push({error:error.stack}); }
  finally { await browser.close(); report.hashesAtEnd=fingerprintFiles(source); fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({output,behaviors:report.behaviors,layouts:report.layouts.length,captures:report.captures.length,failures:report.failures},null,2)); }
  if(report.failures.length) process.exitCode=1;
})();
