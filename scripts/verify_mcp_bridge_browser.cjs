/* Real SPA with intercepted synthetic MCP only. No live host, credentials or AI. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/anniversary-completion/mcp-browser-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const V='2026-07-28',P='tli-mcp-bridge-v1',credential='tlim_'+'a'.repeat(43);
const report={synthetic:true,source_before:fingerprintFiles(root),checks:[],screens:[],errors:[],physical_acceptance:'not_run',limitations:['Intercepted SPA fixtures only; separate SDK verifier tests the real loopback transport. No external client account, live TLI, real credentials, model or household data used.','MCP is intentionally loopback-only; narrow browser layouts test UI access/reflow and do not imply phone or LAN MCP support.']};
async function setup(browser,width,theme){
 const run=await makePage(browser,width,theme),calls=[];let enabled=false,mode='ok',release;
 const grant=()=>({ok:true,protocol:P,mcp_protocol:V,id:'b'.repeat(32),scopes:['registry','health'],endpoint:'http://127.0.0.1:8000/api/mcp',expires_at:new Date(Date.now()+890000).toISOString(),credential});
 await run.page.route(/\/api\/(mcp$|integrations\/mcp\/)/,async route=>{
  const req=route.request(),url=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON():null;calls.push({path:url.pathname,method:req.method(),body});
  if(mode==='hold')await new Promise(resolve=>release=resolve);
  if(mode==='fail')return route.fulfill({status:503,json:{detail:'The saved registry could not be read. Previous files were preserved.'}});
  if(mode==='expired')return route.fulfill({status:401,json:{detail:'The independent MCP grant expired.'}});
  let data;
  if(url.pathname.endsWith('/status'))data={ok:true,protocol:P,mcp_protocol:V,enabled,grants:enabled?[grant()]:[]};
  else if(url.pathname.endsWith('/grant')){assert.deepEqual(body,{scopes:['registry','health'],reviewed:true});enabled=true;data=grant();}
  else if(url.pathname.endsWith('/revoke')){enabled=false;data={ok:true,protocol:P,revoked:true};}
  else{
   assert.equal(req.headers()['authorization'],'Bearer '+credential);assert.equal(req.headers()['mcp-method'],body.method);assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'],V);
   let result={resultType:'complete'};
   if(body.method==='server/discover')result.supportedVersions=[V];
   else if(body.method==='tools/list')Object.assign(result,{cacheScope:'private',ttlMs:0,tools:[{name:'tli_registered_devices'},{name:'tli_reported_health'}]});
   else{assert.equal(body.method,'tools/call');assert.equal(req.headers()['mcp-name'],body.params.name);Object.assign(result,{isError:false,structuredContent:{ok:true,read_at:new Date().toISOString(),actions_performed:false,inference_called:false,data:{items:[{id:'fixture-computer',name:'Studio computer · saved registry label',room:'Editing room',address:'192.0.2.20',observed_at:null}],observation:'Saved registry records; current reachability unknown.',unavailable_sources:['Another registry was unavailable']}}});}
   data={jsonrpc:'2.0',id:body.id,result};
  }
  await route.fulfill({json:data});
 });
 await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});await run.page.waitForFunction(()=>window.TLIMCPBridge&&window.TLISettingsWorkspace);
 assert.equal(await run.page.locator('html').getAttribute('data-theme'),theme,'Requested theme must be applied without fallback');
 await run.page.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('access','settings-section-mcp');});
 await run.page.locator('#mcp-check').waitFor({state:'visible'});assert.equal(calls.length,0,'Navigation cannot enable, connect or read');
 await run.page.locator('#mcp-check').click();await run.page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('disabled for this browser'));
 await run.page.locator('#mcp-scope-registry').check();await run.page.locator('#mcp-scope-health').check();await run.page.locator('#mcp-allow').check();await run.page.locator('#mcp-enable').click();await run.page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('Temporary access enabled'));
 assert.equal(calls.length,2);return {...run,calls,mode:v=>mode=v,release:()=>release?.()};
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  for(const theme of ['emeraldLight','midnight','classicTli'])for(const width of [1440,768,390,320]){
   const run=await setup(browser,width,theme),{page}=run;
   await page.locator('#settings-section-mcp').scrollIntoViewIfNeeded();const first=`${theme}-${width}-grant.png`;await page.screenshot({path:path.join(output,first)});report.screens.push(first);
   await page.locator('.mcp-bridge details summary').click();await page.locator('#mcp-inspect').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('Inspector connected'));
   assert.equal(run.calls.length,4);await page.locator('#mcp-preview').click();assert.equal(run.calls.length,4);await page.locator('#mcp-reviewed').check();await page.locator('#mcp-call').click();await page.waitForFunction(()=>document.getElementById('mcp-result').textContent.includes('Studio computer'));
   assert.equal(run.calls.length,5);const measured=await page.evaluate(()=>({pageOverflow:document.documentElement.scrollWidth>innerWidth+1,localOverflow:document.querySelector('.mcp-bridge').scrollWidth>document.querySelector('.mcp-bridge').clientWidth+1}));assert.equal(measured.pageOverflow,false);assert.equal(measured.localOverflow,false);
   await page.locator('#mcp-result').scrollIntoViewIfNeeded();const second=`${theme}-${width}-read.png`;await page.screenshot({path:path.join(output,second)});report.screens.push(second);
   report.checks.push({theme,width,passed:true,measured});report.errors.push(...run.errors);await run.context.close();
  }
  const run=await setup(browser,1440,'emeraldLight'),{page}=run;await page.locator('.mcp-bridge details summary').click();await page.locator('#mcp-inspect').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('Inspector connected'));
  await page.locator('#mcp-preview').click();await page.locator('#mcp-reviewed').check();await page.locator('#mcp-call').click();await page.waitForFunction(()=>document.getElementById('mcp-result').textContent.includes('Studio computer'));
  const prior=await page.locator('#mcp-result').textContent();run.mode('fail');await page.locator('#mcp-call').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('could not be read'));assert.equal(await page.locator('#mcp-result').textContent(),prior);
  await page.locator('#mcp-disconnect').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('could not be read'));assert.equal(await page.locator('#mcp-secret').inputValue(),credential);
  await page.evaluate(()=>{window.__mcpUnexpectedLocks=0;window.addEventListener('tli-session-locked',()=>window.__mcpUnexpectedLocks++);document.getElementById('chat-input').value='Unsent independent chat draft';});
  run.mode('expired');await page.locator('#mcp-call').click();await page.waitForFunction(()=>document.getElementById('mcp-secret').value==='');
  assert.equal(await page.evaluate(()=>window.__mcpUnexpectedLocks),0);assert.equal(await page.locator('#chat-input').inputValue(),'Unsent independent chat draft');
  run.mode('ok');await page.locator('#mcp-check').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('credential is no longer'));await page.locator('#mcp-disconnect').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('access revoked'));
  await page.locator('#mcp-scope-registry').check();await page.locator('#mcp-scope-health').check();await page.locator('#mcp-allow').check();await page.locator('#mcp-enable').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('Temporary access enabled'));await page.locator('#mcp-inspect').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('Inspector connected'));await page.locator('#mcp-preview').click();await page.locator('#mcp-reviewed').check();
  run.mode('hold');const count=run.calls.length;await page.locator('#mcp-call').click();await page.waitForFunction(()=>document.getElementById('mcp-call').disabled);await page.locator('#mcp-call').dispatchEvent('click');assert.equal(run.calls.length,count+1);
  await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));run.release();await page.waitForTimeout(50);assert.equal(await page.locator('#mcp-secret').inputValue(),'');assert.equal(await page.locator('#mcp-result').textContent(),'');assert.equal(run.calls.length,count+1);
  run.mode('ok');await page.locator('#mcp-check').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('credential is no longer'));await page.locator('#mcp-disconnect').click();await page.waitForFunction(()=>document.getElementById('mcp-status').textContent.includes('access revoked'));
  report.checks.push({name:'failure retention, independent grant expiry preserves PIN drafts, duplicate protection, lock late result, explicit missing-credential recovery/revoke',passed:true});report.errors.push(...run.errors);await run.context.close();
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.passed=false;report.failure=String(error.stack||error);process.exitCode=1;}
 finally{report.source_after=fingerprintFiles(root);report.source_changed=JSON.stringify(report.source_before)!==JSON.stringify(report.source_after);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,screens:report.screens.length,failure:report.failure}));}
})();
