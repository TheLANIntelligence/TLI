/* Synthetic desktop Companion setup QA; never contacts a real TLI or helper. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build_work','host-start','browser-'+new Date().toISOString().replace(/[:.]/g,'-'));
const files=['style.css','themes.css','ui-foundation.css','native-companion.css','js/native-companion.js'];
const assets=Object.fromEntries(files.map(name=>[name,fs.readFileSync(path.join(root,'frontend',name),'utf8')]));
const report={synthetic:true,passed:false,layouts:[],errors:[],calls:[],sourceHashes:Object.fromEntries(Object.entries(assets).map(([name,s])=>[name,crypto.createHash('sha256').update(s).digest('hex')]))};
const configured={schema_version:1,setup_command:'TLI_Setup.ps1',instructions:['Review a separate helper HTTPS port locally.','Keep the computer awake and signed in.'],host_control:{schema_version:1,enabled:true,available:true,helper_id:'synthetic-helper',node_id:'synthetic-home',origin:'https://192.168.1.12:8001',certificate_sha256:'a'.repeat(64),capabilities:{start_backend:true,wake_host:false},reason:'Configured; check helper availability from your phone.'}};
(async()=>{fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const theme of ['emeraldLight','midnight'])for(const width of [1100,390,320]){
  const page=await browser.newPage({viewport:{width,height:960}});let mode='configured';const calls=[];page.on('pageerror',error=>report.errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.hostname,'host-start.test');
   const file=files.find(name=>'/'+name===url.pathname);if(file)return route.fulfill({contentType:file.endsWith('.css')?'text/css':'application/javascript',body:assets[file]});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${files.filter(n=>n.endsWith('.css')).map(n=>'<link rel="stylesheet" href="/'+n+'">').join('')}</head><body data-tli-ui="anniversary" style="padding:12px;margin:0;min-width:0"><main id="panel-companion"></main><script src="/js/native-companion.js"></script></body></html>`});
   calls.push({method:request.method(),path:url.pathname});assert.equal(request.method(),'GET');
   let value;
   if(url.pathname==='/api/host-control/v1/setup'){
    if(mode==='missing')return route.fulfill({status:404,json:{detail:'Missing'}});
    value=mode==='disabled'?{...configured,host_control:{schema_version:1,enabled:false,available:false,reason:'Configure the helper locally first.'}}:configured;
   }else if(url.pathname.endsWith('/setup'))value={pin_enabled:true,tls_enabled:true,lan_enabled:true,certificate_ready:true,pairing_ready:true,origins:['https://192.168.1.12:8000']};
   else if(url.pathname.endsWith('/startup')){const c={host:'0.0.0.0',port:8000,https:true};value={ok:true,configured:true,saved:c,running:c,effective_next:c,restart_required:false,environment_overrides:[]};}
   else if(url.pathname.endsWith('/paired-devices'))value={devices:[]};else throw Error('Unexpected path '+url.pathname);
   return route.fulfill({json:value});
  });
  await page.goto('https://host-start.test/');await page.evaluate(()=>TLICompanion.onOpen());
  assert.equal(calls.some(c=>c.path.includes('host-control')),false);
  await page.locator('#native-host-start-check').click();await page.waitForFunction(()=>document.getElementById('native-host-start-status').textContent.includes('Saved helper configuration'));
  assert.match(await page.locator('#native-host-start-status').innerText(),/availability has not been checked/);
  assert.match(await page.locator('#native-companion-host-start').innerText(),/cannot wake or power on/);
  assert.match(await page.locator('#native-host-start-address').innerText(),/https:\/\/192\.168\.1\.12:8001/);
  assert.doesNotMatch(await page.locator('#native-companion-host-start').innerText(),/Certificate fingerprint|TLI_Setup\.bat|synthetic-helper/);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  const collapsedHeight=(await page.locator('#native-companion-host-start').boundingBox()).height;assert.ok(collapsedHeight<700,'Initial card stays compact');
  await page.locator('#native-companion-host-start').screenshot({path:path.join(out,`host-start-${width}-${theme}.png`)});
  const beforeDisclosures=calls.length;
  await page.locator('#native-host-start-check').focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'native-host-start-connection-summary');
  assert.notEqual(await page.locator('#native-host-start-connection-summary').evaluate(n=>getComputedStyle(n).outlineStyle),'none');
  await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('native-host-start-connection').open);
  assert.match(await page.locator('#native-host-start-details').innerText(),/Computer identity.*synthetic-home.*Helper identity.*synthetic-helper.*Certificate fingerprint/s);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.getElementById('native-host-start-connection').open);
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'native-host-start-setup-summary');
  await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('native-host-start-setup').open);
  assert.match(await page.locator('#native-host-start-setup').innerText(),/TLI_Setup\.bat.*Enable phone host start/s);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#native-companion-host-start').screenshot({path:path.join(out,`host-start-expanded-${width}-${theme}.png`)});
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.getElementById('native-host-start-setup').open);
  assert.equal(calls.length,beforeDisclosures);report.layouts.push({width,theme,overflow,collapsedHeight,nativeDisclosures:{keyboardEnter:true,keyboardSpace:true,tabOrder:true,focusVisible:true,noRequests:true}});
  mode='missing';await page.locator('#native-host-start-check').click();await page.waitForFunction(()=>document.getElementById('native-host-start-status').textContent.includes('does not provide Host Start'));assert.equal(await page.locator('#native-host-start-details').innerText(),'');
  mode='disabled';await page.locator('#native-host-start-check').click();await page.waitForFunction(()=>document.getElementById('native-host-start-status').textContent.includes('not enabled'));
  await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));assert.equal(await page.locator('#native-host-start-check').isDisabled(),true);
  report.calls.push(...calls);await page.close();
 }
 assert.equal(report.errors.length,0);report.passed=true;
}finally{await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,out,layouts:report.layouts.length,errors:report.errors}));}})().catch(error=>{console.error(error);process.exitCode=1});
