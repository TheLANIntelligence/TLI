/* Actual SPA, synthetic intercepted HA bridge. No real token, host or device. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/anniversary-completion/home-assistant-browser-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const P='tli-home-assistant-v1',id='a'.repeat(32),entity={entity_id:'light.studio_desk',name:'Studio desk lamp · <untrusted saved label>',state:'off',availability:'reported',last_changed:'2026-09-07T19:00:00Z',last_updated:'2026-09-07T19:00:00Z',revision:'b'.repeat(64),can_review_action:true};
const conn=()=>({id,origin:'http://192.168.4.9:8123',addresses:['192.168.4.9'],insecure_http:true,expires_at:new Date(Date.now()+890000).toISOString()});
const report={synthetic:true,source_before:fingerprintFiles(root),checks:[],screens:[],errors:[],physical_acceptance:'not_run',limitations:['Browser requests are intercepted synthetic fixtures. No real Home Assistant, token, household data or device action used.','Backend tests separately exercise real owned loopback transport, including no redirects. Actual HA deployment/certificates and physical device effects remain unverified.']};
async function setup(browser,width,theme){
 const run=await makePage(browser,width,theme),calls=[];let connected=false,mode='ok',release;
 await run.page.route('**/api/integrations/home-assistant/*',async route=>{
  const req=route.request(),operation=new URL(req.url()).pathname.split('/').pop(),body=req.method()==='POST'?req.postDataJSON():null;calls.push({operation,body});
  if(mode==='hold')await new Promise(resolve=>release=resolve);
  if(mode==='fail')return route.fulfill({status:502,json:{detail:'Home Assistant rejected this read. The previous connection and results were preserved.'}});
  const data={ok:true,protocol:P,actions_performed:false};
  if(operation==='status')Object.assign(data,{connected,connections:connected?[conn()]:[]});
  else if(operation==='connection-review'){assert.deepEqual(Object.keys(body).sort(),['allow_insecure_http','origin']);Object.assign(data,{review_token:'c'.repeat(64),origin:conn().origin,addresses:conn().addresses,insecure_http:true,credential_sent:false,expires_in_seconds:300,scope:'Only this reviewed origin receives a token on Connect. Read states and Run are separate.'});}
  else if(operation==='connect'){assert.equal(body.token,'synthetic HA token only');connected=true;Object.assign(data,{connection:conn(),states_read:false});}
  else if(operation==='disconnect'){connected=false;data.disconnected=true;}
  else if(operation==='states')Object.assign(data,{connection_id:id,origin:conn().origin,items:[entity,{...entity,entity_id:'switch.unavailable',name:'Unavailable fixture switch',state:'unavailable',availability:'unavailable',can_review_action:false}],omitted_entities:3,checked_at:new Date().toISOString()});
  else if(operation==='action-review'){assert.equal(body.entity_id,entity.entity_id);Object.assign(data,{review_token:'d'.repeat(64),review_hash:'e'.repeat(64),target:{connection_id:id,origin:conn().origin,addresses:conn().addresses,entity,action:body.action,domain:'light'},scope:'One service action. Its acknowledgment does not prove physical state.',expires_in_seconds:120});}
  else if(operation==='execute'){assert.equal(body.reviewed,true);assert.equal(body.connection_id,id);assert.equal(body.review_hash,'e'.repeat(64));Object.assign(data,{connection_id:id,outcome:mode==='changed'?'failed':'accepted',ok:mode!=='changed',actions_performed:mode!=='changed',inference_called:false,physical_confirmation:false,checked_at:new Date().toISOString(),summary:mode==='changed'?'The exact entity changed since review. No service action was submitted.':'Home Assistant acknowledged the service action. Physical state is unverified. Read state before another review.'});}
  else throw new Error('Unexpected HA operation '+operation);
  await route.fulfill({json:data});
 });
 await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});await run.page.waitForFunction(()=>window.TLIHomeAssistant);await run.page.evaluate(()=>switchPanel('panel-homeauto'));
 assert.equal(await run.page.locator('html').getAttribute('data-theme'),theme,'Requested theme must be applied without fallback');
 await run.page.locator('#home-assistant-section>summary').click();await run.page.locator('#ha-check').waitFor({state:'visible'});assert.equal(calls.length,0);
 await run.page.locator('#ha-check').click();await run.page.waitForFunction(()=>document.getElementById('ha-status').textContent.includes('No Home Assistant session'));
 await run.page.locator('.ha-bridge details>summary').click();await run.page.locator('#ha-origin').fill(conn().origin);await run.page.locator('#ha-http').check();await run.page.locator('#ha-token').fill('synthetic HA token only');await run.page.locator('#ha-review-connection').click();await run.page.waitForFunction(()=>document.getElementById('ha-origin-review').textContent.includes('Review origin'));
 assert.equal(calls.length,2);await run.page.locator('#ha-origin-reviewed').check();await run.page.locator('#ha-connect').click();await run.page.waitForFunction(()=>document.getElementById('ha-status').textContent.includes('Connected for this PIN session'));assert.equal(calls.length,3);
 return {...run,calls,mode:value=>mode=value,release:()=>release?.()};
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  for(const theme of ['emeraldLight','midnight','classicTli'])for(const width of [1440,768,390,320]){
   const run=await setup(browser,width,theme),{page}=run;await page.locator('#ha-current').scrollIntoViewIfNeeded();const connection=`${theme}-${width}-connection.png`;await page.screenshot({path:path.join(output,connection)});report.screens.push(connection);
   await page.locator('#ha-read').click();await page.waitForFunction(()=>document.getElementById('ha-state-summary').textContent.includes('2 total'));assert.equal(await page.locator('#ha-review-on').isDisabled(),true);await page.locator('#ha-entity').selectOption(entity.entity_id);await page.locator('#ha-review-on').click();await page.waitForFunction(()=>document.getElementById('ha-action-review').textContent.includes('Turn on:'));assert.equal(run.calls.filter(c=>c.operation==='execute').length,0);
   const measured=await page.evaluate(()=>({pageOverflow:document.documentElement.scrollWidth>innerWidth+1,localOverflow:document.querySelector('.ha-bridge').scrollWidth>document.querySelector('.ha-bridge').clientWidth+1}));assert.equal(measured.pageOverflow,false);assert.equal(measured.localOverflow,false);
   await page.locator('#ha-action-reviewed').scrollIntoViewIfNeeded();const review=`${theme}-${width}-review.png`;await page.screenshot({path:path.join(output,review)});report.screens.push(review);
   await page.locator('#ha-action-reviewed').check();await page.locator('#ha-run').click();await page.waitForFunction(()=>document.getElementById('ha-result').textContent.includes('Physical state is unverified'));assert.equal(run.calls.filter(c=>c.operation==='execute').length,1);assert.equal(await page.locator('#ha-run').isDisabled(),true);
   report.checks.push({theme,width,measured,passed:true});report.errors.push(...run.errors);await run.context.close();
  }
  const run=await setup(browser,1440,'emeraldLight'),{page}=run;await page.locator('#ha-read').click();await page.waitForFunction(()=>document.getElementById('ha-state-summary').textContent.includes('2 total'));await page.locator('#ha-entity').selectOption(entity.entity_id);const previous=await page.locator('#ha-state-summary').textContent();run.mode('fail');await page.locator('#ha-read').click();await page.waitForFunction(()=>document.getElementById('ha-status').textContent.includes('rejected this read'));assert.equal(await page.locator('#ha-state-summary').textContent(),previous);
  await page.locator('#ha-disconnect').click();await page.waitForFunction(()=>document.getElementById('ha-status').textContent.includes('rejected this read'));assert.equal(await page.locator('#ha-read').isDisabled(),false);
  run.mode('ok');await page.locator('#ha-review-on').click();await page.waitForFunction(()=>document.getElementById('ha-action-review').textContent.includes('Turn on:'));await page.locator('#ha-action-reviewed').check();run.mode('changed');await page.locator('#ha-run').click();await page.waitForFunction(()=>document.getElementById('ha-result').textContent.includes('changed since review'));assert.equal(await page.locator('#ha-run').isDisabled(),true);
  run.mode('ok');await page.locator('#ha-review-off').click();await page.waitForFunction(()=>document.getElementById('ha-action-review').textContent.includes('Turn off:'));await page.locator('#ha-action-reviewed').check();run.mode('hold');const count=run.calls.length;await page.locator('#ha-run').click();await page.locator('#ha-run').dispatchEvent('click');assert.equal(run.calls.length,count+1);
  await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));run.release();await page.waitForTimeout(50);assert.equal(await page.locator('#ha-result').textContent(),'');assert.equal(await page.locator('#ha-current').textContent(),'');assert.equal(await page.locator('#ha-token').inputValue(),'');assert.equal(run.calls.length,count+1);
  report.checks.push({name:'failed read/disconnect retention, changed target no action, duplicate protection and lock late result',passed:true});report.errors.push(...run.errors);await run.context.close();assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.passed=false;report.failure=String(error.stack||error);process.exitCode=1;}
 finally{report.source_after=fingerprintFiles(root);report.source_changed=JSON.stringify(report.source_before)!==JSON.stringify(report.source_after);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,screens:report.screens.length,failure:report.failure}));}
})();
