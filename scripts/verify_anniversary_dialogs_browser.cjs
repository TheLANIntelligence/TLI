/* Read-only full-SPA overlays and standalone help. All requests use synthetic fixtures. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
process.argv.push('--label','dialogs');
const {makePage,fixtures,out,source,unexpectedRequests,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
async function inspect(page,selector) {
 return page.evaluate(selector=>{
  const surface=document.querySelector(selector),width=document.documentElement.clientWidth;
  if(!surface)throw new Error('Missing surface '+selector);
  const visible=e=>e.getClientRects().length&&!e.closest('[hidden],.hidden')&&getComputedStyle(e).visibility!=='hidden';
  const controls=[...surface.querySelectorAll('input,select,textarea,button,a')].filter(visible);
  return {surface:selector,width,documentWidth:document.documentElement.scrollWidth,visible:!!visible(surface),
   overflow:controls.filter(e=>{const r=e.getBoundingClientRect();return r.left < -2||r.right > width+2;}).map(e=>({id:e.id,text:e.textContent.trim().slice(0,60)}))};
 },selector);
}
async function main(){
 const before=fingerprintFiles(source);
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),checks=[],sessions=[];
 try {for(const width of [1440,390,320])for(const theme of ['emeraldLight','midnight']){
  const run=await makePage(browser,width,theme),page=run.page;
  const capture=async(name,selector)=>{
   await page.waitForTimeout(100);const record=await inspect(page,selector);checks.push({width,theme,name,...record});
   assert.equal(record.visible,true,name+' must open');
   await page.keyboard.press('Tab');
   assert.equal(await page.locator(selector).evaluate(e=>e.contains(document.activeElement)),true,name+' must retain keyboard focus');
   await page.screenshot({path:path.join(out,`${name}-${width}-${theme}.png`)});
  };
  await page.evaluate(()=>switchPanel('panel-settings'));
  await page.evaluate(()=>document.getElementById('about-button').click());await capture('about','#about-modal');
  await page.keyboard.press('Escape');assert.ok(await page.locator('#about-modal').evaluate(e=>e.classList.contains('hidden')));
  for(const [name,selector,owner] of [['saved-notes','#notebook-dialog','TLINotebook'],['documents','#documents-dialog','TLIDocuments'],
    ['saved-places','#places-dialog','TLIPlaces'],['history','#chat-history-drawer','TLIConversationSearch']]){
   if(name==='history') await page.evaluate(()=>switchPanel('panel-main'));
   await page.evaluate(owner=>window[owner].open(),owner);await capture(name,selector);await page.keyboard.press('Escape');
   assert.equal(await page.locator(selector).isVisible(),false,name+' must close with Escape');
  }
  await page.evaluate(()=>window.tliOpenModelManagerModal());await capture('model-library','#model-manager-modal-overlay');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#model-manager-modal-overlay').isVisible(),false);
  await page.keyboard.press('Control+k');await capture('command-palette','#tli-cmd-overlay');await page.keyboard.press('Escape');
  // Starting the wizard is visual setup only; do not advance through any save step.
  fixtures['/system/onboarding/status']={complete:false};
  await page.evaluate(()=>setupOnboardingWizard());await capture('onboarding-welcome','#tli-onboard');
  await page.locator('#tli-onboard-next').click();await capture('onboarding-pin','#tli-onboard');
  await page.evaluate(()=>tliHideOnboard());fixtures['/system/onboarding/status']={complete:true};
  const guide=await run.context.newPage();guide.on('pageerror',error=>run.errors.push(error.stack||error.message));
  await guide.goto('http://tli-ui.test/manual.html');await guide.waitForLoadState('load');
  checks.push({width,theme,name:'manual',...await inspect(guide,'body')});
  assert.equal(await guide.locator('html').getAttribute('data-help-tone'),theme==='midnight'?'dark':'light');
  await guide.screenshot({path:path.join(out,`manual-${width}-${theme}.png`)});await guide.close();
  // Show the actual PIN gate through its normal read-only status check.
  await page.evaluate(async()=>{sessionStorage.removeItem('tli_session_unlocked');await TLIPinLock.checkAndLock();});
  await capture('locked','#tli-lock-screen');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tli-lock-screen').isVisible(),true,'Escape must not dismiss the PIN gate');
  await page.locator('#tli-lock-forgot').click();await capture('pin-recovery','#tli-lock-screen');
  const session={width,theme,errors:run.errors,unexpectedRequests:unexpectedRequests(run.calls)};sessions.push(session);
  fs.writeFileSync(path.join(out,`dialog-requests-${width}-${theme}.json`),JSON.stringify({calls:run.calls,...session},null,2));
  await run.context.close();
 }} finally{await browser.close();}
 const failures=checks.filter(c=>c.overflow.length||c.documentWidth>c.width+2);
 const hashes=fingerprintFiles(source),changedDuringRun=Object.keys(hashes).filter(file=>hashes[file]!==before[file]);
 fs.writeFileSync(path.join(out,'dialogs-report.json'),JSON.stringify({source,hashes,changedDuringRun,checks,sessions,failures},null,2));
 console.log(JSON.stringify({out,views:checks.length,failures,sessions}));
 assert.equal(failures.length,0,'Dialogs or help have overflowing controls');
 assert.ok(sessions.every(s=>!s.errors.length&&!s.unexpectedRequests.length),'Browser errors or unexpected action requests');
 assert.equal(changedDuringRun.length,0,'Source changed during dialog verification; rerun the candidate');
}
main().catch(error=>{fs.writeFileSync(path.join(out,'dialogs-error.txt'),error.stack);console.error(error);process.exitCode=1;});
