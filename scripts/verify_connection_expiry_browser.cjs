/* Real browser UI, intercepted synthetic requests only. No host or peer I/O. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {makePage}=require('./verify_anniversary_ui_browser.cjs');
const output=path.resolve(__dirname,'../build_work/connected-computers/expiry-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
async function main(){
 const browser=await chromium.launch({channel:'msedge',headless:true}),report={synthetic:true,checks:[]};
 try{
  for(const width of [1440,390]){
   const {page,context,errors}=await makePage(browser,width,'emeraldLight'),base=Date.now(),writes=[];
   let unavailable=false;
   const receipt={state:'connected',fresh:true,online:true,checked_at:new Date(base).toISOString(),expires_at:new Date(base+90000).toISOString(),ready_grants:['messages','observe'],capabilities:{messages:{state:'ready'},observe:{state:'ready'},coordinate:{state:'permission_required'}}};
   const peer={id:'expiry-peer',name:'Studio peer',ip:'192.168.1.8',status:'allowed',trust_state:'verified',reviewed_grants:['messages','observe'],messaging:{available:true},connection:receipt};
   await page.evaluate(now=>{window.fixtureNow=now;Date.now=()=>window.fixtureNow;},base);
   await page.route('**/api/lan/peers',route=>json(route,unavailable?{detail:'Fixture host unreachable'}:{peers:[peer]},unavailable?503:200));
   await page.route('**/api/mesh/health',route=>json(route,unavailable?{detail:'Fixture host unreachable'}:{nodes:[{...peer,node_id:peer.id,node_name:peer.name,is_self:false}]},unavailable?503:200));
   await page.route('**/mesh/trust/setup',route=>json(route,{ready:true,stable_origins:['https://studio.local:8443']}));
   await page.route('**/api/companion/v1/setup',route=>json(route,{pin_enabled:true,pairing_ready:true}));
   await page.route('**/mesh/chat/**',route=>{if(route.request().method()!=='GET')writes.push(new URL(route.request().url()).pathname);return json(route,{messages:[],threads:[],typing:false,receipts:[],cursor:0});});
   await page.route('**/mesh/directory/*/connection',route=>{writes.push(new URL(route.request().url()).pathname);return json(route,{node_id:peer.id,online:true,ready_grants:receipt.ready_grants,connection:receipt});});
   await page.evaluate(()=>TLIChat.openPeer('expiry-peer'));
   const input=page.locator('#tli-chat-input'),send=page.locator('#tli-chat-send-btn');
   await input.fill('Keep this unsent draft while the connection expires.');
   await page.waitForFunction(()=>!document.getElementById('tli-chat-send-btn').disabled);
   await page.evaluate(()=>switchPanel('panel-mesh'));
   await page.locator('#mcd-grid').getByRole('button',{name:'Messages & files',exact:true}).waitFor();
   await page.evaluate(()=>TLIConnectDevice.open({kind:'computer',deviceId:'expiry-peer'}));
   const guide=page.locator('#tli-connect-device-dialog');
   await guide.getByRole('heading',{name:'Connected to Studio peer',exact:true}).waitFor();
   await guide.getByRole('button',{name:'Open messages & files',exact:true}).waitFor();
   const beforeWrites=writes.length;
   unavailable=true;
   await page.evaluate(()=>{window.fixtureNow+=90000;document.getElementById('mcd-refresh-btn').click();return MeshService.refreshPeers();});
   await guide.getByText(/Connection check expired/).waitFor();
   assert.equal(await guide.getByRole('button',{name:'Open messages & files',exact:true}).count(),0);
   await page.waitForFunction(()=>!Array.from(document.querySelectorAll('#mcd-grid button')).some(button=>button.textContent==='Messages & files'));
   assert.equal(await page.locator('#mcd-grid .mcd-status-dot.online').count(),0);
   assert.equal(await page.locator('#mcd-grid').getByText(/Connection check expired/).count(),1);
   const cached=await page.evaluate(()=>MeshService.getPeers().peers[0]);
   assert.equal(cached.online,null);assert.equal(cached.connection.fresh,false);assert.deepEqual(cached.ready_grants,[]);assert.deepEqual(cached.reviewed_grants,['messages','observe']);
   assert.equal(writes.length,beforeWrites,'Expiry and failed reads must not send another check, approval, or message.');
   report.checks.push(width+': failed host refresh expires guide and mesh readiness/actions while preserving reviewed grants');
   await guide.getByRole('button',{name:'Close',exact:true}).click();
   await page.evaluate(()=>switchPanel('panel-tli-chat'));
   await page.waitForFunction(()=>document.getElementById('tli-chat-send-btn').disabled);
   assert.equal(await input.inputValue(),'Keep this unsent draft while the connection expires.');
   assert.equal(await input.isDisabled(),false);
   assert.equal(await send.isDisabled(),true);
   assert.equal(await page.locator('#tli-chat-share-btn').isDisabled(),true);
   assert.equal(await page.locator('#tli-chat-thread-meta .online').count(),0);
   await page.screenshot({path:path.join(output,'expired-draft-'+width+'.png')});
   report.checks.push(width+': reopening messages expires cached receipt before refresh and keeps editable draft with Send/share disabled');
   unavailable=false;receipt.checked_at=new Date(base+90000).toISOString();receipt.expires_at=new Date(base+180000).toISOString();
   await page.locator('#tli-chat-message-readiness').getByRole('button',{name:'Refresh status',exact:true}).click();
   await page.waitForFunction(()=>!document.getElementById('tli-chat-send-btn').disabled);
   unavailable=true;await page.evaluate(()=>{window.fixtureNow+=90000;});
   await page.waitForFunction(()=>document.getElementById('tli-chat-send-btn').disabled,{},{timeout:2500});
   assert.equal(await input.inputValue(),'Keep this unsent draft while the connection expires.');
   assert.equal(await page.locator('#tli-chat-share-btn').isDisabled(),true);
   report.checks.push(width+': visible messages expire on the shared timer without a successful refresh');
   assert.deepEqual(errors,[]);await context.close();
  }
  report.passed=true;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,passed:true}));
 }finally{await browser.close();}
}
main().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);console.error(error);process.exitCode=1;});
