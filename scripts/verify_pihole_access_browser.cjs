/* Real owner SPA and standalone guest page; all APIs are synthetic and intercepted. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(!process.argv.includes('--label'))process.argv.push('--label','pihole-access');
const {makePage,layout}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/pihole-access',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const portal='https://192.168.1.2:8000',pihole='https://192.168.1.3:443',ip='192.168.1.40';
const protocol='tli-pihole-access-v1',now=()=>new Date().toISOString();
const files=['backend/pihole_self_service.py','backend/pihole_access_store.py','backend/routers/pihole_access_routes.py','backend/main.py','backend/tli_state.py','frontend/pihole-access.html','frontend/pihole-access.css','frontend/js/pihole-access.js','frontend/js/pihole-sharing.js','frontend/index.html'];
const hashes=()=>Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const report={synthetic:true,output,views:[],limitations:['No live Pi-hole, actual network client attribution, real Wi-Fi, mobile hardware, or certificate trust setup tested.']};

async function main(){
 report.sourceHashes=hashes();const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const [width,theme]of[[1440,'midnight'],[1440,'emeraldLight'],[390,'emeraldLight'],[320,'midnight']]){
  const run=await makePage(browser,width,theme),owner=run.page;
  let enabled=false,pending=null,grant=null,filtering=true,held=null;
  const calls=[],operationIds=new Set(),guestErrors=[];
  const json=(route,data,status=200,headers={})=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify({protocol,ok:status===200,...data})});
  await owner.route('**/system/pin/verify',route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'}));
  await owner.route('**/api/homelab/pihole/self-service/**',async route=>{
   const req=route.request(),action=new URL(req.url()).pathname.split('/').pop(),data=req.method()==='POST'?req.postDataJSON():null;
   calls.push({actor:'owner',action});
   if(action==='enable'){assert.equal(data.password,'synthetic-password');enabled=true;return json(route,{enabled:true,origin:pihole});}
   if(action==='status')return json(route,{enabled,origin:enabled?pihole:null,requests:pending?[pending]:[],grants:grant?[grant]:[],checked_at:now(),portal_origins:[portal]});
   if(action==='inventory')return json(route,{clients:[{id:4,client:ip,comment:'Guest phone',groups:[0],editable:true},{id:5,client:'192.168.1.41',comment:'Another device',groups:[0],editable:true}],groups:[{id:0,name:'Default',enabled:true}],checked_at:now()});
   if(action==='approve'){assert.deepEqual(data,{request_id:pending.id,client:ip,reviewed:true});grant={id:pending.id,name:pending.name,client:ip,revoked:false};pending=null;return json(route,{grant});}
   if(action==='revoke'){assert.equal(data.grant_id,grant.id);grant.revoked=true;return json(route,{grant});}
   if(action==='disable'){enabled=false;return json(route,{enabled:false});}
   throw Error('Unexpected owner action '+action);
  });
  await owner.evaluate(()=>switchPanel('panel-homelab'));
  await owner.locator('#pihole-sharing-title').waitFor({state:'visible'});
  assert.equal(calls.length,0);
  await owner.locator('#pihole-sharing-workspace details summary').click();
  await owner.locator('#pihole-sharing-origin').fill(pihole);
  await owner.locator('#pihole-sharing-password').fill('synthetic-password');
  assert.ok(await owner.locator('#pihole-sharing-enable').isDisabled());
  await owner.locator('#pihole-sharing-consent').check();await owner.locator('#pihole-sharing-enable').click();
  await owner.waitForFunction(()=>document.getElementById('pihole-sharing-status').textContent.startsWith('Household sharing enabled'));
  assert.equal(await owner.locator('#pihole-sharing-password').inputValue(),'');
  await owner.locator('#pihole-sharing-check').click();
  await owner.locator('#pihole-sharing-host-options button').waitFor();await owner.locator('#pihole-sharing-host-options button').click();
  assert.equal(await owner.locator('#pihole-sharing-link a').getAttribute('href'),portal+'/pihole-access');
  await owner.locator('#pihole-sharing-workspace details summary').click();
  const guestContext=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  const guest=await guestContext.newPage();guest.on('pageerror',error=>guestErrors.push(error.message));
  await guestContext.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,portal);
   if(url.pathname.startsWith('/api/pihole-access/')){
    const action=url.pathname.split('/').pop(),data=req.method()==='POST'?req.postDataJSON():null;calls.push({actor:'guest',action});
    if(action==='request'){
     assert.deepEqual(Object.keys(data),['name']);pending={id:'a'.repeat(32),name:data.name,source_ip:ip,expires_at:new Date(Date.now()+600000).toISOString()};
     return json(route,{state:'pending',source_ip:ip,expires_at:pending.expires_at},200,{'Set-Cookie':'tli_pihole_access='+pending.id+'.'+'b'.repeat(64)+'; Secure; HttpOnly; SameSite=Strict; Path=/api/pihole-access; Max-Age=31536000'});
    }
    assert.ok(req.headers()['cookie']?.includes('tli_pihole_access='),'Guest must retain scoped browser credential');
    if(action==='forget')return json(route,{forgotten:true,state:'unpaired',checked_at:now(),detail:'This browser has forgotten its device access. Filtering was not changed.'},200,{'Set-Cookie':'tli_pihole_access=; Secure; HttpOnly; SameSite=Strict; Path=/api/pihole-access; Max-Age=0'});
    if(!enabled)return json(route,{state:'offline',checked_at:now(),detail:'Owner must reconnect Pi-hole.'});
    if(!grant)return json(route,{state:'pending',name:pending.name,client:ip,checked_at:now(),detail:'Waiting for owner approval.'});
    if(grant.revoked)return json(route,{detail:'Device access was revoked.'},401);
    if(action==='status')return json(route,{state:filtering?'on':'off',name:grant.name,client:ip,checked_at:now(),detail:'Pi-hole group membership observed for this device.'});
    if(action==='filtering'){
     assert.deepEqual(Object.keys(data).sort(),['enabled','operation_id']);assert.equal(typeof data.enabled,'boolean');assert.ok(!operationIds.has(data.operation_id));operationIds.add(data.operation_id);filtering=data.enabled;
     if(held){const resolve=held;held=null;await new Promise(done=>resolve(done));}
     return json(route,{state:filtering?'on':'off',name:grant.name,client:ip,checked_at:now(),detail:'Pi-hole group membership observed for this device.',outcome:{outcome:'confirmed',attempted:true,acknowledged:true,membership_verified:true,summary:'Pi-hole reported the requested client groups. DNS behavior has not been verified.',checked_at:now()}});
    }
    throw Error('Unexpected guest action '+action);
   }
   assert.equal(req.method(),'GET');
   const file=path.join(root,'frontend',url.pathname==='/pihole-access'?'pihole-access.html':url.pathname.slice(1));
   assert.ok(file.startsWith(path.join(root,'frontend')+path.sep));
   const type={'.html':'text/html','.css':'text/css','.js':'text/javascript'}[path.extname(file)];
   return route.fulfill({status:200,contentType:type,body:fs.readFileSync(file)});
  });
  const beforeOpen=calls.length;await guest.goto(portal+'/pihole-access');await guest.locator('#pihole-access-check').waitFor();
  assert.equal(calls.length,beforeOpen,'Opening page cannot read private state or perform changes');
  await guest.locator('#pihole-access-name').fill('Alex’s phone');await guest.locator('#pihole-access-request').click();
  await guest.waitForFunction(()=>document.getElementById('pihole-access-state').textContent.includes('Waiting for household approval'));
  assert.equal(await guest.evaluate(()=>document.cookie.includes('tli_pihole_access')),false);
  await owner.locator('#pihole-sharing-check').click();await owner.locator('#pihole-sharing-requests select').waitFor();
  await owner.locator('#pihole-sharing-inventory').click();await owner.locator('#pihole-sharing-requests option[value="192.168.1.40"]').waitFor({state:'attached'});
  assert.equal(await owner.locator('#pihole-sharing-requests option[value="192.168.1.41"]').count(),0);
  await owner.locator('#pihole-sharing-requests select').selectOption(ip);
  assert.ok(await owner.getByRole('button',{name:'Approve this device',exact:true}).isDisabled());
  await owner.locator('#pihole-sharing-requests input[type=checkbox]').check();
  const ownerLayout=await layout(owner,'panel-homelab');assert.equal(ownerLayout.overflow.length,0);assert.equal(ownerLayout.duplicateIds.length,0);
  await owner.locator('#pihole-sharing-requests').scrollIntoViewIfNeeded();await owner.screenshot({path:path.join(output,`owner-approval-${width}-${theme}.png`),fullPage:true});
  await owner.getByRole('button',{name:'Approve this device',exact:true}).click();
  await owner.waitForFunction(()=>document.getElementById('pihole-sharing-status').textContent.startsWith('Device approved'));
  await owner.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
  await guest.locator('#pihole-access-check').click();await guest.locator('#pihole-access-pause').waitFor();await guest.waitForFunction(()=>!document.getElementById('pihole-access-pause').disabled);
  await guest.locator('#pihole-access-pause').click();await guest.waitForFunction(()=>!document.getElementById('pihole-access-restore').disabled);assert.equal(filtering,false);
  const guestLayout=await guest.evaluate(()=>({width:document.documentElement.scrollWidth,duplicateIds:Array.from(document.querySelectorAll('[id]')).map(x=>x.id).filter((x,i,a)=>a.indexOf(x)!==i)}));
  assert.ok(guestLayout.width<=width+2);assert.equal(guestLayout.duplicateIds.length,0);
  await guest.screenshot({path:path.join(output,`guest-paused-${width}-${theme}.png`),fullPage:true});
  const beforeReload=calls.length;await guest.reload();assert.equal(calls.length,beforeReload);
  await guest.locator('#pihole-access-check').click();await guest.waitForFunction(()=>!document.getElementById('pihole-access-restore').disabled);
  await guest.locator('#pihole-access-restore').click();await guest.waitForFunction(()=>!document.getElementById('pihole-access-pause').disabled);assert.equal(filtering,true);
  const wait=new Promise(resolve=>held=resolve);await guest.locator('#pihole-access-pause').click();const release=await wait,beforeLate=calls.length;
  await guest.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));});release();await guest.waitForTimeout(100);
  assert.ok(await guest.locator('#pihole-access-pause').isDisabled());assert.ok(await guest.locator('#pihole-access-restore').isDisabled());assert.equal(calls.length,beforeLate);
  await guest.locator('#pihole-access-check').click();await guest.waitForFunction(()=>!document.getElementById('pihole-access-restore').disabled);
  await guest.locator('#pihole-access-restore').click();await guest.waitForFunction(()=>!document.getElementById('pihole-access-pause').disabled);
  await owner.locator('#tli-lock-input').fill('2468');await owner.locator('#tli-lock-submit').click();await owner.waitForFunction(()=>document.getElementById('tli-lock-screen').classList.contains('hidden'));
  await owner.locator('#pihole-sharing-check').click();await owner.getByRole('button',{name:'Revoke device access',exact:true}).waitFor();await owner.getByRole('button',{name:'Revoke device access',exact:true}).click();
  await owner.waitForFunction(()=>document.getElementById('pihole-sharing-status').textContent.startsWith('Device access revoked'));
  await guest.locator('#pihole-access-check').click();await guest.waitForFunction(()=>document.getElementById('pihole-access-status').textContent.includes('could not be verified'));
  assert.ok(await guest.locator('#pihole-access-pause').isDisabled());
  await guest.locator('#pihole-access-forget').click();await guest.waitForFunction(()=>!document.getElementById('pihole-access-request').disabled);
  assert.equal((await guestContext.cookies()).some(cookie=>cookie.name==='tli_pihole_access'),false);
  await guest.locator('#pihole-access-name').fill('Alex’s phone again');await guest.locator('#pihole-access-request').click();
  await guest.waitForFunction(()=>document.getElementById('pihole-access-state').textContent.includes('Waiting for household approval'));
  assert.equal(await guest.evaluate(()=>localStorage.length+sessionStorage.length),0);
  assert.equal(run.errors.length,0);assert.equal(guestErrors.length,0);
  report.views.push({width,theme,calls,ownerLayout,guestLayout,ownerErrors:run.errors,guestErrors});
  await guestContext.close();await run.context.close();
 }}finally{await browser.close();}
 assert.deepEqual(hashes(),report.sourceHashes,'Sources must stay fixed during browser acceptance');
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,views:report.views.length,result:'passed'}));
}
main().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);console.error(error);process.exitCode=1;});
