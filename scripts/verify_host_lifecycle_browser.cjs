/* Real SPA with intercepted local APIs only; never contacts or restarts a host. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fixtures}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),frontend=path.join(root,'frontend');
const output=path.join(root,'build_work/host-lifecycle/browser');
const base='/api/host-control/v1/lifecycle',origin='http://127.0.0.1:18079';
const baseline={schema_version:1,instance_id:'a'.repeat(32),installation_id:'b'.repeat(64)};
const report={synthetic:true,checks:[],screenshots:[],errors:[],requests:[],limitations:['Every request is intercepted; no live lifecycle command, host restart or quit occurs.']};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg','.woff2':'font/woff2'};
async function run(){
 fs.mkdirSync(output,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
 await context.addInitScript(()=>{localStorage.setItem('tli_onboard_seen_v1','1');localStorage.setItem('tli_settings',JSON.stringify({defaultTheme:'emeraldLight',searchEnabled:false,defaultBrain:'bundled'}));sessionStorage.setItem('tli_session_unlocked','1');});
 let action='restart',readyReads=0,failConfirm=false,failReceipt=false,releaseState='matched',legacyHost=false;
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url()),pathname=decodeURIComponent(url.pathname),method=req.method();
  if(url.origin!==origin)return route.abort('blockedbyclient');
  const respond=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(pathname==='/api/diagnostics/version'){
   if(releaseState==='connection_lost')return route.abort('failed');
   const value=fixtures[pathname];return respond({...value,release:{...value.release,compatibility:{state:releaseState}}});
  }
  if(pathname.startsWith(base)){
   const body=method==='POST'?req.postDataJSON():null;report.requests.push({path:pathname,method,body});
   if(pathname===base)return legacyHost?respond({detail:'Not Found'},404):respond({...baseline,available:true,capabilities:{restart:true,quit:true},reason:'Synthetic supported launcher'});
   if(pathname===base+'/preview'){action=body.action;return respond({...baseline,preview_id:'c'.repeat(32),expires_at:Date.now()/1000+60,action,current_url:origin+'/',next_url:origin+'/',consequences:['The application exits cleanly; your computer stays on.']});}
   if(pathname===base+'/confirm'){if(failConfirm)return route.abort('failed');return respond({schema_version:1,request_id:body.request_id,action,status:'accepted',message:'Synthetic receipt only.',next_url:origin+'/'},202);}
   if(pathname===base+'/ready'){readyReads++;return respond({...baseline,instance_id:readyReads>=2?'d'.repeat(32):baseline.instance_id});}
   if(pathname.startsWith(base+'/receipt/'))return respond({schema_version:1,request_id:pathname.split('/').at(-1),action,status:failReceipt?'failed':'accepted',message:failReceipt?'The restart helper could not start.':'Synthetic accepted receipt.'});
   return respond({detail:'Unknown synthetic lifecycle route'},404);
  }
  if(!['GET','HEAD'].includes(method))return respond({ok:false,detail:'Synthetic fixture: no operation executed.'},409);
  const file=path.resolve(frontend,'.'+(pathname==='/'?'/index.html':pathname));
  if(file.startsWith(frontend+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  return Object.hasOwn(fixtures,pathname)?respond(fixtures[pathname]):respond({ok:false,detail:'Synthetic service unavailable.'},503);
 });
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.stack||error.message));
 const load=async()=>{await page.goto(origin+'/',{waitUntil:'load'});await page.waitForFunction(()=>window.TLIHostLifecycle&&window.TLISettingsWorkspace);await page.waitForTimeout(300);};
 const openSettings=()=>page.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('app','settings-section-host-lifecycle');});
 const check=async(name,fn)=>{await fn();report.checks.push({name,passed:true});};
 const capture=async name=>{const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);};
 try{
  await load();await check('No lifecycle request on startup; Device menu opens accessible review without confirming',async()=>{
   assert.equal(report.requests.length,0);await page.locator('#tli-device-trigger').click();await page.locator('#tli-host-menu-restart').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);
   assert.equal(await page.locator('#tli-host-lifecycle-dialog').evaluate(e=>e.open),true);assert.equal(await page.evaluate(()=>document.activeElement.id),'tli-host-lifecycle-cancel');
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'tli-host-lifecycle-confirm');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'tli-host-lifecycle-cancel');
   assert.equal(report.requests.filter(r=>r.path.endsWith('/confirm')).length,0);await capture('restart-review');await page.keyboard.press('Escape');assert.equal(await page.locator('#tli-host-lifecycle-dialog').evaluate(e=>e.open),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'tli-device-trigger');
  });
  await check('Settings contains the same quit flow; double activation sends one confirmation and no readiness polling',async()=>{
   await openSettings();assert.match(await page.locator('#settings-section-host-lifecycle').innerText(),/Closing this browser leaves TLI running/);await page.locator('#tli-host-settings-quit').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);await capture('quit-review');
   await page.locator('#tli-host-lifecycle-confirm').evaluate(button=>{button.click();button.click();});await page.waitForFunction(()=>document.getElementById('tli-host-lifecycle-status').textContent.includes('Quit was accepted'));
   assert.equal(report.requests.filter(r=>r.path.endsWith('/confirm')).length,1);assert.match(report.requests.find(r=>r.path.endsWith('/confirm')).body.request_id,/^[a-f0-9]{32}$/);await page.waitForTimeout(1100);assert.equal(report.requests.some(r=>r.path.endsWith('/ready')),false);
  });
  await load();await check('Accepted restart reconnects only after matching installation and a new instance',async()=>{
   await openSettings();await page.locator('#tli-host-settings-restart').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);await page.locator('#tli-host-lifecycle-confirm').click();await page.waitForFunction(()=>document.getElementById('tli-host-lifecycle-status').textContent.includes('TLI restarted'),null,{timeout:8000});assert.equal(readyReads,2);assert.equal(await page.locator('#tli-host-lifecycle-reload').isVisible(),true);await capture('restart-confirmed');
  });
  await load();await check('Lost confirmation remains uncertain and manual check never resends it',async()=>{
   failConfirm=true;await openSettings();await page.locator('#tli-host-settings-restart').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);const before=report.requests.filter(r=>r.path.endsWith('/confirm')).length;await page.locator('#tli-host-lifecycle-confirm').click();await page.waitForFunction(()=>document.getElementById('tli-host-lifecycle-status').textContent.includes('not confirmed'));await page.locator('#tli-host-lifecycle-check').click();await page.waitForTimeout(100);assert.equal(report.requests.filter(r=>r.path.endsWith('/confirm')).length,before+1);
  });
  await load();await check('Same-process failed receipt displays the host explanation and stops automatic checks',async()=>{
   failConfirm=false;failReceipt=true;readyReads=0;await openSettings();await page.locator('#tli-host-settings-restart').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);const before=report.requests.filter(r=>r.path.endsWith('/confirm')).length;await page.locator('#tli-host-lifecycle-confirm').click();await page.waitForFunction(()=>document.getElementById('tli-host-lifecycle-status').textContent.includes('Restart failed: The restart helper could not start.'),null,{timeout:5000});await page.waitForTimeout(2200);assert.equal(readyReads,1);assert.equal(report.requests.filter(r=>r.path.endsWith('/confirm')).length,before+1);await capture('restart-failed');failReceipt=false;
  });
  await load();await check('Dark theme and narrow desktop window keep review controls visible without horizontal overflow',async()=>{
   failConfirm=false;await page.setViewportSize({width:390,height:850});await page.evaluate(()=>TLIThemes.apply('midnight'));await openSettings();await page.locator('#tli-host-settings-quit').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);
   assert.ok(await page.locator('#tli-host-lifecycle-dialog').evaluate(element=>element.scrollWidth<=element.clientWidth+2));await capture('quit-review-narrow-dark');await page.keyboard.press('Escape');
  });
  await check('Update notice and Settings version card open restart review without sending a command',async()=>{
   releaseState='restart_required';const before=report.requests.length;await page.setViewportSize({width:1440,height:1000});await load();await page.evaluate(()=>{TLIThemes.apply('emeraldLight');switchPanel('panel-main');});assert.equal(report.requests.length,before);await page.waitForFunction(()=>!document.getElementById('tli-release-restart').hidden);await capture('release-restart-notice');const confirmed=report.requests.filter(r=>r.path.endsWith('/confirm')).length;
   await page.locator('#tli-release-restart').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);assert.equal(report.requests.filter(r=>r.path.endsWith('/confirm')).length,confirmed);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'tli-release-restart');
   await page.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('app','settings-section-updates');});await page.locator('#settings-release-restart').click();await page.waitForFunction(()=>!document.getElementById('tli-host-lifecycle-confirm').disabled);assert.equal(report.requests.filter(r=>r.path.endsWith('/confirm')).length,confirmed);await page.keyboard.press('Escape');
  });
  await check('Legacy running host shows exact one-time restart fallback without a mutation',async()=>{
   legacyHost=true;const before=report.requests.length;await page.locator('#tli-release-restart').click();await page.waitForFunction(()=>document.getElementById('tli-host-lifecycle-status').textContent.includes('TLI_Setup.bat, choose 9'));assert.equal(await page.locator('#tli-host-lifecycle-confirm').isDisabled(),true);assert.deepEqual(report.requests.slice(before).map(r=>r.method),['GET']);await capture('release-legacy-restart-fallback');await page.keyboard.press('Escape');legacyHost=false;
  });
  await check('Matched and unknown connection states hide update restart with no lifecycle probes',async()=>{
   const before=report.requests.length;for(const value of ['matched','connection_lost']){releaseState=value;await page.evaluate(()=>TLIRelease.check(true));assert.equal(await page.locator('#tli-release-restart').isVisible(),false);assert.equal(await page.locator('#settings-release-restart').isVisible(),false);if(value==='matched')assert.equal(await page.locator('#tli-release-notice').isVisible(),false);else assert.match(await page.locator('#tli-release-message').innerText(),/Check the connection/);}assert.equal(report.requests.length,before);
  });
  report.passed=report.checks.length===9&&!report.errors.length;
 }catch(error){report.error=error.stack;report.passed=false;throw error;}finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await context.close();await browser.close();}
 console.log(JSON.stringify({output,passed:report.passed,checks:report.checks,errors:report.errors}));process.exitCode=report.passed?0:1;
}
run().catch(error=>{console.error(error);process.exitCode=1;});
