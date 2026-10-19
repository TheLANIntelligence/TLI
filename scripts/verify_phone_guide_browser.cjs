/* Full desktop SPA with synthetic local APIs. Never touches a live host or phone. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fixtures}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),frontend=path.join(root,'frontend'),output=path.join(root,'build_work/phone-guide/browser');
const origin='https://127.0.0.1:18079',stable='https://studio.local:18079',ip='https://192.168.50.12:18079';
const config={host:'0.0.0.0',port:18079,https:true};
const report={synthetic:true,checks:[],screenshots:[],errors:[],requests:[],limitations:['Full SPA with intercepted synthetic APIs; no real network configuration, PIN, host restart, phone installation or physical QR scan was performed.']};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg','.woff2':'font/woff2'};
async function run(){
 fs.mkdirSync(output,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
 await context.addInitScript(()=>{localStorage.setItem('tli_onboard_seen_v1','1');localStorage.setItem('tli_settings',JSON.stringify({defaultTheme:'emeraldLight',searchEnabled:false,defaultBrain:'bundled'}));sessionStorage.setItem('tli_session_unlocked','1');});
 let prepared=true,pin=true,saved=true,receiptId=null,pairHold=null,lastAction='prepare',receiptStatus='completed';
 const setup=()=>({pin_enabled:pin,tls_enabled:prepared,lan_enabled:prepared,certificate_ready:prepared,pairing_ready:pin&&prepared,origins:prepared?[stable,ip]:[],node:{id:'synthetic-studio',name:'Studio'}});
 const network=()=>({schema_version:1,running:prepared?config:{...config,host:'127.0.0.1',https:false},startup:{effective_next:saved?config:{...config,host:'127.0.0.1',https:false},environment_overrides:[]},certificate:{status:saved?'ready':'missing'},firewall:{supported:true,status:'ready',reason:'Private network fixture',legacy_rules:[]},manual_restart:false});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),p=decodeURIComponent(url.pathname),method=req.method();
  if(url.origin!==origin)return route.abort('blockedbyclient');
  const respond=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(p.startsWith('/api/companion/')||p.startsWith('/api/network-setup/')||p==='/system/pin/set'||p==='/system/pin/verify')report.requests.push({path:p,method,body:method==='POST'?req.postDataJSON():null});
  if(p==='/system/pin/status')return respond({enabled:pin});
  if(p==='/system/pin/set'){pin=true;return respond({ok:true});}
  if(p==='/system/pin/verify')return respond({ok:true});
  if(p==='/api/companion/v1/setup')return respond(setup());
  if(p==='/api/companion/v1/paired-devices')return respond({devices:[{id:'saved-android',name:'Existing phone',platform:'android',created_at:'2026-10-15T12:00:00Z'}]});
  if(p==='/api/network-setup/v1/status')return respond(network());
  if(p==='/api/network-setup/v1/preview'){const b=req.postDataJSON();lastAction=b.action;return respond({firewall:{program:'synthetic-python',profile:'Private',remote_addresses:'LocalSubnet',rules:[{protocol:'TCP',port:18079}]},schema_version:1,preview_id:'a'.repeat(32),action:b.action,settings:config,expires_at:Date.now()/1000+300,next_url:origin+'/',certificate:{names:['studio.local'],fingerprint:'b'.repeat(64)},warnings:['Encrypted home-network access takes effect after a reviewed restart.']});}
  if(p==='/api/network-setup/v1/confirm'){receiptId=req.postDataJSON().request_id;saved=true;return respond({schema_version:1,request_id:receiptId,status:'accepted',message:'Synthetic setup accepted.'},202);}
  if(p.startsWith('/api/network-setup/v1/receipt/'))return respond({schema_version:1,action:lastAction,request_id:receiptId,status:receiptStatus,message:receiptStatus==='completed'?'Synthetic setup saved.':'Synthetic setup applying.',restart_required:lastAction!=='firewall'&&receiptStatus==='completed',settings:config,running:network().running});
  if(p==='/api/companion/v1/pairings'&&method==='POST'){
   if(pairHold)await pairHold;const chosen=req.postDataJSON().origin;assert.ok([stable,ip].includes(chosen));const expires_at=new Date(Date.now()+300000).toISOString();
   return respond({bundle:JSON.stringify({version:chosen===stable?2:1,origin:chosen,public_key:'b'.repeat(64),token:'synthetic-private-invitation',certificate_der:'synthetic-certificate',node_id:'synthetic-studio',node_name:'Studio',expires_at}),expires_at,qr_format:'https_fragment_v2',qr:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="white"/><path d="M10 10h42v42H10z M108 10h42v42H108z M10 108h42v42H10z M65 65h30v30H65z" fill="black"/></svg>').toString('base64')});
  }
  if(!['GET','HEAD'].includes(method))return respond({ok:false,detail:'Synthetic fixture: operation not executed.'},409);
  const file=path.resolve(frontend,'.'+(p==='/'?'/index.html':p));if(file.startsWith(frontend+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  return Object.hasOwn(fixtures,p)?respond(fixtures[p]):respond({ok:false,detail:'Synthetic service unavailable.'},503);
 });
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.stack||e.message));
 const capture=async name=>{const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);};
 const check=async(name,work)=>{await work();report.checks.push(name);};
 const posts=()=>report.requests.filter(r=>r.method==='POST');
 const open=async()=>{await page.evaluate(()=>switchPanel('panel-companion'));await page.waitForFunction(()=>document.getElementById('tli-connect-device-dialog')?.open&&!document.getElementById('native-companion-refresh')?.disabled);};
 try{
  await page.goto(origin+'/',{waitUntil:'load'});await page.waitForFunction(()=>window.TLIConnectDevice&&window.TLISettingsWorkspace);
  await check('Phone navigation opens the phone flow directly, prepared computer skips configuration, public install is separate',async()=>{
   await open();assert.equal(await page.locator('#tli-connect-device-title').textContent(),'Connect phone');
   assert.equal(await page.locator('#native-companion-step-install').isVisible(),false);assert.match(await page.locator('#tli-connect-device-dialog').innerText(),/Allow phone connections/);assert.ok(await page.getByRole('button',{name:'Review Windows network access',exact:true}).count());
   await page.getByRole('button',{name:'Network access is already allowed — continue',exact:true}).click();await page.locator('#native-companion-step-install').waitFor({state:'visible'});assert.equal(await page.getByRole('button',{name:'Choose another device type',exact:true}).count(),0);
   assert.equal(await page.locator('#native-companion-step-install').isVisible(),true);assert.equal(await page.locator('#native-companion-step-pair').isVisible(),false);assert.equal(await page.locator('#native-companion-startup').count(),0);
   assert.equal(await page.locator('#native-companion-download').getAttribute('href'),'https://thelanintelligence.com/download/#android');assert.equal(await page.locator('#native-companion-install-qr').isVisible(),true);
   assert.equal(await page.locator('#native-companion-origin').inputValue(),stable);assert.equal(posts().length,0);await capture('install-desktop');
  });
  await check('Explicit in-app pairing creates one private invitation for stable identity and completion remains phone-verified',async()=>{
   await page.locator('#native-companion-installed').click();await page.locator('#native-companion-generate').evaluate(e=>{e.click();e.click()});await page.locator('#native-companion-pairing').waitFor({state:'visible'});
   assert.equal(posts().length,1);assert.equal(posts()[0].body.origin,stable);assert.match(await page.locator('#native-companion-pairing').innerText(),/Scan inside the TLI Android app/);
   const qrBounds=await page.locator('#native-companion-pairing img').evaluate(e=>{const r=e.getBoundingClientRect(),d=e.closest('dialog').getBoundingClientRect();return{top:r.top,bottom:r.bottom,width:r.width,visibleTop:Math.max(0,d.top),visibleBottom:Math.min(innerHeight,d.bottom)};});
   assert.ok(qrBounds.top>=qrBounds.visibleTop&&qrBounds.bottom<=qrBounds.visibleBottom,'The complete pairing QR must be visible immediately after creation');assert.ok(qrBounds.width>=450,'Keep the dense desktop pairing code at its scan-friendly size');
   assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Scan inside the TLI Android app');
   await capture('pairing-desktop');await page.locator('#native-companion-scan-done').click();assert.match(await page.locator('#native-companion-chat-status').innerText(),/does not mean the phone is online/);await capture('chat-next-step');
  });
  await check('Narrow dark layout remains usable, details reveal fallback without silently replacing a pairing',async()=>{
   await page.setViewportSize({width:390,height:844});await page.evaluate(()=>TLIThemes.apply('midnight'));await page.locator('#native-companion-address-details > summary').click();await page.locator('#native-companion-origin').selectOption(ip);
   assert.equal(await page.locator('#native-companion-pairing').isVisible(),false);assert.equal(posts().length,1);assert.ok(await page.locator('#tli-connect-device-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+2));await capture('fallback-narrow-dark');
  });
  await check('Settings opens the same phone-specific workflow',async()=>{
   await page.keyboard.press('Escape');await page.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('access','settings-section-companion')});await page.locator('#settings-open-companion').click();assert.equal(await page.locator('#tli-connect-device-title').textContent(),'Connect phone');assert.equal(posts().length,1);
   await page.locator('#native-companion-management > summary').click();await page.locator('#native-companion-open-access').click();assert.equal(await page.locator('#tli-connect-device-dialog').evaluate(e=>e.open),false);assert.equal(await page.locator('#panel-settings').isVisible(),true);
  });
  await check('Fresh computer uses inline PIN and reviewed setup then reads receipt without replay or automatic restart',async()=>{
   await page.keyboard.press('Escape');prepared=false;saved=false;pin=false;await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>TLIThemes.apply('emeraldLight'));await open();
   assert.equal(await page.locator('#native-companion-step-install').isVisible(),false);await page.locator('#tli-connection-new-pin').fill('1234');await page.locator('#tli-connection-confirm-pin').fill('1234');await page.getByRole('button',{name:'Set PIN & unlock',exact:true}).click();
   await page.getByRole('button',{name:'Review secure home-network setup',exact:true}).waitFor();await page.getByRole('button',{name:'Review secure home-network setup',exact:true}).click();await page.getByRole('button',{name:'Confirm network setup',exact:true}).click();
   await page.getByText('Synthetic setup saved.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Restart TLI and continue',exact:true}).count(),1);assert.equal(report.requests.filter(r=>r.path==='/api/network-setup/v1/confirm').length,1);await capture('prepared-awaiting-restart');
  });
  await check('After simulated restart Windows access is reviewed before native pairing becomes available',async()=>{
   prepared=true;await page.goto(origin+'/?restart=1#connect_device=phone&setup_receipt='+receiptId,{waitUntil:'load'});await page.getByRole('button',{name:'Review Windows network access',exact:true}).waitFor();assert.equal(await page.locator('#native-companion-step-install').isVisible(),false);assert.equal(new URL(page.url()).hash,'');
   receiptStatus='applying';await page.getByRole('button',{name:'Review Windows network access',exact:true}).click();await page.getByRole('button',{name:'Confirm firewall change',exact:true}).click();await page.getByText('Synthetic setup applying.',{exact:true}).waitFor();assert.equal(await page.locator('#native-companion-step-install').isVisible(),false);assert.equal(report.requests.filter(r=>r.path==='/api/network-setup/v1/confirm').length,2);
  });
  await check('Pending Windows setup survives same-owner lock using its opaque receipt; manual completion advances without replay',async()=>{
   const before=posts().length,reads=()=>report.requests.filter(r=>r.path.includes('/network-setup/v1/receipt/')).length;
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#tli-connect-device-dialog').evaluate(e=>e.open),false);
   assert.deepEqual(await page.evaluate(()=>({id:TLIConnectionSetup.receipt(),result:TLIConnectionSetup.result()})),{id:receiptId,result:null});const lockedReads=reads();await page.waitForTimeout(1700);assert.equal(reads(),lockedReads);
   await page.evaluate(()=>{window.dispatchEvent(new CustomEvent('tli-session-unlocked'));TLIConnectDevice.open({kind:'phone'});});await page.getByText('Synthetic setup applying.',{exact:true}).waitFor();assert.ok(reads()>lockedReads);assert.equal(posts().length,before);
   receiptStatus='completed';await page.getByRole('button',{name:'Check saved setup request',exact:true}).click();await page.locator('#native-companion-step-install').waitFor({state:'visible'});assert.equal(posts().length,before);
  });
  await check('Account and user changes clear prior-owner receipt IDs and private results',async()=>{
   const before=posts().length;
   for(const event of ['tli-account-changed','tli-user-changed']){
    await page.evaluate(event=>window.dispatchEvent(new CustomEvent(event)),event);assert.deepEqual(await page.evaluate(()=>({id:TLIConnectionSetup.receipt(),result:TLIConnectionSetup.result()})),{id:null,result:null});
    if(event==='tli-account-changed')await page.evaluate(id=>{window.dispatchEvent(new CustomEvent('tli-session-unlocked'));TLIConnectionSetup.resume(id);TLIConnectDevice.open({kind:'phone'});},receiptId);
   }
   assert.equal(posts().length,before);await page.evaluate(()=>{window.dispatchEvent(new CustomEvent('tli-session-unlocked'));TLIConnectDevice.open({kind:'phone'});});await page.getByRole('button',{name:'Network access is already allowed — continue',exact:true}).click();await page.locator('#native-companion-step-install').waitFor({state:'visible'});
  });
  await check('Lock clears the modal and private invitation without replay',async()=>{
   const before=posts().length;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#tli-connect-device-dialog').evaluate(e=>e.open),false);assert.equal(await page.locator('#native-companion-pairing').innerHTML(),'');assert.equal(posts().length,before);
  });
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(e){report.failure=e.stack;report.passed=false;await capture('failure');throw e;}finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await context.close();await browser.close();}
 console.log(JSON.stringify({output,passed:report.passed,checks:report.checks,errors:report.errors},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1});
