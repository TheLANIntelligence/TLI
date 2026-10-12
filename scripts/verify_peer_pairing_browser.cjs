/* Real SPA with synthetic, intercepted pairing responses. No LAN contacts. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {makePage, layout, fixtures, source, fingerprintFiles} = require('./verify_anniversary_ui_browser.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work', 'connected-computers',
  'peer-pairing-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, {recursive:true});
fixtures['/mesh/chat/messages'] = {messages:[]};
fixtures['/mesh/pairing/requests'] = {ok:true,supported:true,requests:[]};
const peer = {id:'fixture-den',name:'Den',origin:'https://192.168.2.11:8443'};
fixtures['/mesh/directory'] = {mode:'standalone',this_device_id:'fixture-studio',devices:[
  {device_id:'fixture-other-computer',display_name:'Other computer',ip:'192.168.2.12',port:8443,status:'pending'},
  {device_id:peer.id,display_name:peer.name,ip:'192.168.2.11',port:8443,status:'pending'},
  {device_id:'fixture-inference-only',display_name:'Compute worker',ip:'192.168.2.13',port:8443,status:'pending',peer_profile:'inference_node'},
  {device_id:'fixture-address-unavailable',display_name:'Address unavailable',status:'pending'}
]};
fixtures['/api/mesh/health'] = {ok:true,nodes:[
  {...fixtures['/api/mesh/health'].nodes[0],pairing_available:true},
  {node_id:'fixture-other-computer',peer_id:'fixture-other-computer',node_name:'Other computer',ip:'192.168.2.12',port:8443,is_self:false,online:null,connection_state:'review_required',pairing_available:true},
  {node_id:'reported-den-id',peer_id:peer.id,node_name:peer.name,ip:'192.168.2.11',port:8443,is_self:false,online:null,connection_state:'review_required',pairing_available:true},
  {node_id:'fixture-inference-only',peer_id:'fixture-inference-only',node_name:'Compute worker',ip:'192.168.2.13',port:8443,is_self:false,online:null,peer_profile:'inference_node',pairing_available:true},
  {node_id:'fixture-address-unavailable',peer_id:'fixture-address-unavailable',node_name:'Address unavailable',is_self:false,online:null,pairing_available:false}
]};
const code = 'ABCD-EF12-3456';
const request = (changes={}) => ({request_id:'fixture-pairing-request',direction:'outgoing',peer,
  code,expires_at:new Date(Date.now()+600000).toISOString(),state:'comparing',
  local_confirmed:false,remote_confirmed:false,grants:['messages'],...changes});
const report = {synthetic:true,source,checks:[],screenshots:[],layouts:[],sessions:[],
  limitations:['All requests are intercepted. No computer was contacted, trusted, or messaged.',
    'Cryptographic code derivation and peer authority are verified by isolated backend tests.']};
const json = (route,body,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});

async function snapshot(page,mode,name,width) {
  await page.setViewportSize({width,height:1000});
  const measured = await layout(page,'tli-peer-pairing-dialog');
  assert.deepEqual(measured.overflow,[],`${name}: controls fit the viewport`);
  assert.equal(measured.duplicateIds.length,0,`${name}: unique IDs`);
  assert.ok(measured.documentWidth<=width+2,`${name}: no page overflow`);
  report.layouts.push({mode,name,...measured});
  const file=path.join(output,`${name}-${mode}-${width}.png`);
  await page.screenshot({path:file,fullPage:true});
  report.screenshots.push(file);
}

async function main() {
  const initialHashes=fingerprintFiles(source);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const mode of ['modern','classic']) {
      const run=await makePage(browser,1440,'emeraldLight');
      const page=run.page,operations=[];
      let current=[],listStatus=200,listDetail='Not Found',holdList=null,confirmError=null;
      await page.route('**/mesh/pairing/**',async route => {
        const req=route.request(),pathname=new URL(req.url()).pathname;
        const call={method:req.method(),path:pathname};
        if(req.postData()) call.body=req.postDataJSON();
        operations.push(call);
        if(pathname==='/mesh/pairing/requests') {
          if(holdList) return holdList(route);
          return json(route,listStatus===200?{ok:true,supported:true,requests:current}:{detail:listDetail},listStatus);
        }
        if(pathname==='/mesh/pairing/start') {
          assert.equal(call.method,'POST');
          assert.equal(call.body.device_id,peer.id);
          current=[request()];
          return json(route,{ok:true,request:current[0]});
        }
        assert.equal(current.length,1,'An explicit pairing request must exist before an operation');
        assert.equal(pathname.split('/')[3],current[0].request_id);
        const action=pathname.split('/')[4];
        assert.ok(['confirm','refresh','cancel'].includes(action),'Only reviewed pairing operations are allowed');
        assert.equal(call.method,'POST');
        if(action==='confirm') {
          assert.deepEqual(call.body,{code,allow_messages:true});
          if(confirmError) return json(route,{detail:confirmError},404);
          current=[{...current[0],local_confirmed:true,state:current[0].remote_confirmed?'connected':'waiting'}];
        } else if(action==='cancel') current=[{...current[0],state:'cancelled',code:null}];
        return json(route,{ok:true,request:current[0]});
      });
      const dialog=page.locator('#tli-peer-pairing-dialog');
      const open=async options => {
        await page.evaluate(options=>TLIPeerPairing.open(options),options||{deviceId:peer.id,name:peer.name});
        await dialog.waitFor({state:'visible'});
      };
      const close=()=>dialog.getByRole('button',{name:'Close',exact:true}).click();
      const confirm=()=>dialog.getByRole('button',{name:'Codes match — allow messages',exact:true});
      const checkboxes=()=>dialog.locator('input[type="checkbox"]');
      // Polling an existing outgoing request may refresh its remote status; it
      // never starts, confirms or cancels the locally reviewed connection.
      const mutations=()=>operations.filter(item=>item.method!=='GET'&&!item.path.endsWith('/refresh'));
      const waitCode=()=>dialog.getByText(code,{exact:true}).waitFor();
      try {
        await page.evaluate(mode=>{TLIInterface.set(mode);switchPanel('panel-mesh');},mode);
        await page.waitForFunction(()=>typeof window.TLIPeerPairing?.open==='function');
        const entry=page.locator(`[data-pairing-device-id="${peer.id}"]`);
        await entry.waitFor({state:'attached'});
        assert.equal(await entry.locator('xpath=..').locator('.mcd-node-name').textContent(),peer.name);
        assert.equal(await page.locator('[data-pairing-device-id="fixture-studio"]').count(),0);
        assert.equal(await page.locator('[data-pairing-device-id="fixture-inference-only"]').count(),0);
        assert.equal(await page.locator('[data-pairing-device-id="fixture-address-unavailable"]').count(),0);
        assert.equal(await entry.isVisible(),true,'The Computers connection entry must be reachable in the visible interface');
        await entry.click();
        await dialog.waitFor({state:'visible'});
        await dialog.getByRole('heading',{name:peer.name,exact:true}).waitFor();
        const start=dialog.getByRole('button',{name:'Request connection',exact:true});
        await start.waitFor();
        assert.equal(mutations().length,0,'Opening a connection review cannot request or approve a connection');
        assert.deepEqual(operations.filter(item=>item.method!=='GET'),[],'Opening without an active request is entirely read-only');
        assert.equal(await dialog.locator('textarea').count(),0,'Ordinary pairing requires no public-card copying');
        assert.equal(await dialog.getByText(/certificate_der|public_key|signature/).count(),0,'No raw computer card is exposed');
        await start.click();
        await waitCode();
        assert.deepEqual(mutations()[0],{method:'POST',path:'/mesh/pairing/start',body:{device_id:peer.id}},'Directory selection preserves the chosen computer identity until explicit Request connection');
        report.checks.push(`${mode}: Computers directory opens the selected computer without sending; only Request connection posts its exact ID`);
        assert.equal(mutations().length,1,'Only an explicit request starts pairing');
        assert.equal(await checkboxes().count(),2,'Both code comparison and message permission are explicit');
        assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(),0);
        assert.equal(await confirm().isDisabled(),true);
        await checkboxes().nth(0).check();
        assert.equal(await confirm().isDisabled(),true,'One checkbox cannot authorize connection');
        await checkboxes().nth(1).check();
        assert.equal(await confirm().isEnabled(),true);
        assert.equal(mutations().length,1,'Checking permissions does not confirm by itself');
        for(const width of [1440,390]) await snapshot(page,mode,'compare-code',width);
        await page.setViewportSize({width:1440,height:1000});
        await confirm().click();
        await page.waitForFunction(()=>document.getElementById('tli-peer-pairing-dialog')?.textContent.includes('Waiting'));
        assert.equal(mutations().filter(item=>item.path.endsWith('/confirm')).length,1);
        current=[{...current[0],remote_confirmed:true,state:'connected'}];
        await dialog.getByRole('button',{name:'Refresh status',exact:true}).click();
        await dialog.getByText(/Both computers confirmed/i).first().waitFor();
        report.checks.push(`${mode}: opening is read-only; explicit start and two unchecked permissions gate confirmation; connected state needs both hosts`);
        await close();

        // The other computer's approval never supplies this computer's consent.
        current=[request({direction:'incoming',remote_confirmed:true})];
        const beforeIncoming=mutations().length;
        await open({requestId:current[0].request_id});
        await waitCode();
        await checkboxes().nth(0).waitFor();
        assert.equal(mutations().length,beforeIncoming);
        assert.equal(await confirm().isDisabled(),true);
        assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(),0);
        for(const width of [1440,390]) await snapshot(page,mode,'incoming-request',width);
        await page.setViewportSize({width:1440,height:1000});
        await checkboxes().nth(0).check();
        await checkboxes().nth(1).check();
        await confirm().click();
        await dialog.getByText(/Both computers confirmed/i).first().waitFor();
        assert.equal(mutations().filter(item=>item.path.endsWith('/confirm')).length,2);
        report.checks.push(`${mode}: incoming requests remain unapproved until explicit local code comparison and message permission`);
        await close();

        current=[request({direction:'incoming'})];
        await open({requestId:current[0].request_id});await waitCode();
        await checkboxes().nth(0).waitFor();
        await dialog.getByRole('button',{name:'Decline request',exact:true}).click();
        await dialog.getByText(/declined|cancelled/i).first().waitFor();
        assert.equal(mutations().filter(item=>item.path.endsWith('/cancel')).length,1);
        report.checks.push(`${mode}: declining issues a single cancellation and removes active consent controls`);
        await close();

        const hostile='<img src=x onerror="window.__pairingInjection=true">';
        current=[request({direction:'incoming',peer:{...peer,name:hostile}})];
        await open({requestId:current[0].request_id});await waitCode();
        await dialog.getByText(hostile,{exact:false}).first().waitFor();
        assert.equal(await dialog.getByText(hostile,{exact:false}).count()>=1,true);
        assert.equal(await dialog.locator('img[src="x"]').count(),0);
        assert.equal(await page.evaluate(()=>window.__pairingInjection),undefined);
        assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(),0);
        report.checks.push(`${mode}: untrusted computer names render as text and cannot inject executable markup`);
        await close();

        current=[request({request_id:'fixture-waiting-pairing-request',direction:'incoming',code:null,state:'waiting'})];
        const beforePending=mutations().length;
        await open({requestId:current[0].request_id});
        await dialog.getByText(/Waiting for the other computer to finish/i).waitFor();
        assert.equal(await checkboxes().count(),0);
        assert.equal(await confirm().count(),0);
        assert.equal(mutations().length,beforePending);
        await close();
        current=[request({request_id:'fixture-expired-pairing-request',direction:'incoming',expires_at:new Date(Date.now()-60000).toISOString()})];
        await open({requestId:current[0].request_id});
        await dialog.getByText(/No connection requests are waiting/i).waitFor();
        assert.equal(await checkboxes().count(),0);
        assert.equal(await dialog.getByText(code,{exact:true}).count(),0);
        assert.equal(mutations().length,beforePending);
        report.checks.push(`${mode}: incomplete exchanges and expired requests cannot expose confirmation controls`);
        await close();

        current=[request({request_id:'fixture-server-expired-request',direction:'incoming'})];
        confirmError={code:'pairing_expired',message:'This connection request expired. Send a new request.'};
        await open({requestId:current[0].request_id});await waitCode();
        await checkboxes().nth(0).check();await checkboxes().nth(1).check();
        const beforeExpiredConfirmation=mutations().length;
        await confirm().click();
        await dialog.locator('#tli-peer-pairing-status').getByText(confirmError.message,{exact:true}).waitFor();
        assert.equal(await dialog.getByText(/need updated TLI|Install the updated TLI/i).count(),0,'A structured expiry response is not an unsupported-version response');
        assert.equal(mutations().length,beforeExpiredConfirmation+1,'Expiry cannot silently retry or request a fresh connection');
        assert.equal(current[0].local_confirmed,false);
        report.checks.push(`${mode}: structured pairing_expired 404 explains expiry without version fallback or retry`);
        await close();confirmError=null;

        // Pairing access may require localhost even when ordinary browsing is
        // available without a PIN. Its 403 cannot lock the whole application.
        current=[request({request_id:'fixture-locally-restricted-request',direction:'incoming'})];
        await page.evaluate(()=>{
          window.__pairingGlobalLocks=0;
          window.addEventListener('tli-session-locked',()=>{window.__pairingGlobalLocks++;});
        });
        await open({requestId:current[0].request_id});await waitCode();
        await checkboxes().nth(0).check();await checkboxes().nth(1).check();
        const beforeUnauthorized=mutations().length;
        listStatus=403;listDetail='Open TLI on this computer to review connection requests.';
        await dialog.getByRole('button',{name:'Refresh status',exact:true}).click();
        await dialog.locator('#tli-peer-pairing-status').getByText(listDetail,{exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.__pairingGlobalLocks),0);
        assert.equal(await dialog.isVisible(),true);
        assert.equal(await dialog.getByText(code,{exact:true}).count(),0);
        assert.equal(await checkboxes().count(),0);
        assert.equal(await confirm().count(),0);
        assert.equal(await page.locator('#tli-peer-pairing-banner').count(),0);
        assert.equal(mutations().length,beforeUnauthorized);
        await close();listStatus=200;
        await open({requestId:current[0].request_id});await waitCode();
        assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(),0,'Restored access must require fresh comparison and permission');
        await close();listStatus=403;
        const backgroundRejection=page.waitForResponse(response=>new URL(response.url()).pathname==='/mesh/pairing/requests'&&response.status()===403);
        await page.evaluate(()=>TLIPeerPairing.install());await backgroundRejection;
        await page.locator('#tli-peer-pairing-banner').waitFor({state:'detached'});
        assert.equal(await page.evaluate(()=>window.__pairingGlobalLocks),0);
        assert.equal(mutations().length,beforeUnauthorized);
        assert.equal(await dialog.isVisible(),false);
        report.checks.push(`${mode}: foreground and background pairing 403 clears stale consent without global lock, confirmation or peer actions`);
        listStatus=200;listDetail='Not Found';

        current=[];listStatus=404;
        const beforeUnsupported=mutations().length;
        await open();
        await dialog.getByText(/update|unsupported|not support|does not provide|matching.*version/i).first().waitFor();
        assert.equal(mutations().length,beforeUnsupported);
        assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(),0);
        report.checks.push(`${mode}: unavailable pairing endpoints show actionable setup information without fallback approval`);
        await close();listStatus=200;

        // A closed request's response cannot populate a later opened review.
        let heldRoute,releaseHeld,notifyHeld;
        let held=new Promise(resolve=>{notifyHeld=resolve;});
        holdList=route=>new Promise(resolve=>{heldRoute=route;releaseHeld=resolve;notifyHeld();});
        await open();await held;await close();
        holdList=null;current=[request({peer:{...peer,name:'New comparison'}})];
        await open();await waitCode();
        await json(heldRoute,{ok:true,supported:true,requests:[request({peer:{...peer,name:'Old comparison'}})]});releaseHeld();
        await page.waitForTimeout(100);
        assert.equal(await dialog.getByText(/Old comparison/).count(),0);
        assert.ok(await dialog.getByText(/New comparison/).count()>0);
        report.checks.push(`${mode}: late results from closed reviews cannot overwrite the current review`);
        await close();

        held=new Promise(resolve=>{notifyHeld=resolve;});
        holdList=route=>new Promise(resolve=>{heldRoute=route;releaseHeld=resolve;notifyHeld();});
        await open();await held;
        await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
        await json(heldRoute,{ok:true,supported:true,requests:[request()]});releaseHeld();
        await page.waitForTimeout(100);
        assert.equal(await dialog.isVisible(),false);
        assert.equal(await dialog.locator('input,textarea,select').count(),0);
        report.checks.push(`${mode}: locking clears comparison and permission controls; late responses cannot reopen them`);

        holdList=null;listStatus=200;current=[request({request_id:'fixture-session-expiry-request',direction:'incoming'})];
        await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-unlocked')));
        await open({requestId:current[0].request_id});await waitCode();
        await checkboxes().nth(0).check();await checkboxes().nth(1).check();
        const locksBeforeExpiry=await page.evaluate(()=>window.__pairingGlobalLocks);
        const mutationsBeforeExpiry=mutations().length;
        listStatus=401;listDetail='Unlock TLI to review connection requests.';
        await dialog.getByRole('button',{name:'Refresh status',exact:true}).click();
        await dialog.waitFor({state:'hidden'});
        assert.ok(await page.evaluate(()=>window.__pairingGlobalLocks)>locksBeforeExpiry,'Actual authentication expiry still invokes the global lock');
        assert.equal(await dialog.locator('input,textarea,select').count(),0);
        assert.equal(await dialog.getByText(code,{exact:true}).count(),0);
        assert.equal(await page.locator('#tli-peer-pairing-banner').count(),0);
        assert.equal(mutations().length,mutationsBeforeExpiry);
        report.checks.push(`${mode}: actual session 401 preserves global lock behavior and clears pending code and consent`);
        assert.deepEqual(run.errors,[]);
        assert.deepEqual(run.calls.filter(item=>!['GET','HEAD'].includes(item.method)),[],'All mutations must remain inside the explicit intercepted pairing flow');
        report.sessions.push({mode,operations,errors:run.errors});
      } finally {await run.context.close();}
    }
    report.sourceUnchanged=JSON.stringify(initialHashes)===JSON.stringify(fingerprintFiles(source));
    assert.equal(report.sourceUnchanged,true,'Frontend changed during verification; rerun current source.');
    report.frontendHashes=initialHashes;report.passed=true;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,checks:report.checks.length,passed:report.passed||false}));
  }
}
main().catch(error=>{
  fs.writeFileSync(path.join(output,'error.txt'),error.stack);
  console.error(error);process.exitCode=1;
});
