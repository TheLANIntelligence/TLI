/* Synthetic Pi-hole v6 workflow in the real SPA; no lab network is contacted. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (!process.argv.includes('--label')) process.argv.push('--label','pihole');
const {makePage,layout} = require('./verify_anniversary_ui_browser.cjs');
const output = path.resolve(__dirname,'../build_work/pihole',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const now = new Date().toISOString(), origin = 'https://192.168.1.2:443', address = '192.168.1.40';
const base = {ok:true,protocol:'tli-pihole-v1'};
const connection = {id:'synthetic-connection',origin,expires_at:new Date(Date.now()+15*60*1000).toISOString()};
const groups = [{id:0,name:'Default',enabled:true,description:null,date_added:1,date_modified:2},
  {id:1,name:'Smart TVs',enabled:true,description:'Device filtering',date_added:1,date_modified:2}];
const client = () => ({id:4,client:address,comment:'Living room TV',groups:[0],editable:true,date_added:1,date_modified:2});
const files = ['backend/pihole_bridge.py','backend/pihole_receipts.py','backend/pihole_transport.py','backend/routers/pihole_routes.py','frontend/js/pihole.js','frontend/pihole.css','frontend/index.html'];
const hashes = () => Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',file))).digest('hex')]));
const report = {synthetic:true,output,views:[],limitations:['No real Pi-hole, DHCP/router attribution, real DNS behavior, power-loss recovery or physical phone tested.']};

async function main() {
  report.sourceHashes = hashes();
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const [width,theme] of [[1440,'midnight'],[1440,'emeraldLight'],[390,'emeraldLight'],[320,'midnight']]) {
      const run = await makePage(browser,width,theme), {page,context} = run;
      let current = client(), reviews = new Map(), receipts = [], pending = null, emptyActivity = false;
      const calls = [];
      await page.route('**/system/pin/verify',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})}));
      await page.route('**/api/homelab/pihole/**', async route => {
        const req=route.request(), endpoint=new URL(req.url()).pathname.split('/').pop();
        const data=req.method()==='POST'?req.postDataJSON():null;
        calls.push({method:req.method(),endpoint});
        if(pending) {const resolve=pending;pending=null;await new Promise(done=>resolve({done,route}));}
        let result;
        if(endpoint==='connect') { assert.equal(data.password,'synthetic-app-password'); result={connection}; }
        else if(endpoint==='status') result={connections:[connection],receipts};
        else if(endpoint==='inventory') result={clients:[current,{id:5,client:'AA:BB:CC:DD:EE:FF',comment:'<img src=x onerror=alert(1)>',groups:[0],editable:false,date_added:1,date_modified:2}],groups,checked_at:now};
        else if(endpoint==='activity') {
          assert.equal(data.client,address);
          result={client:address,items:emptyActivity?[]:[{time:Date.now()/1000,domain:'<img src=x onerror=alert(1)>',type:'A',status:'GRAVITY'}],from:Date.now()/1000-900,until:Date.now()/1000,checked_at:now};
        } else if(endpoint==='review') {
          assert.equal(data.client,address);
          const saved=receipts.find(row=>row.id===data.receipt_id);
          const after=data.action==='restore'?saved.before.clientrecord.groups:data.groups;
          const review={review_id:'review-'+reviews.size,expires_at:new Date(Date.now()+120000).toISOString(),target:{client:address,origin},before_groups:[...current.groups],after_groups:[...after],group_names:groups.map(({id,name})=>({id,name})),action:data.action,scope:'One exact client. Pause lasts until restored; no timer. DNS behavior has not been verified.'};
          reviews.set(review.review_id,review);result=review;
        } else if(endpoint==='execute') {
          assert.equal(data.reviewed,true);
          const review=reviews.get(data.review_id);assert.ok(review);reviews.delete(data.review_id);
          const receipt={id:'receipt-'+receipts.length,origin,tls_mode:'system_trust',pin:'',client:address,before:{clientrecord:structuredClone(current),groups},after_groups:review.after_groups,action:review.action,created_at:now,
            outcome:{outcome:'confirmed',attempted:true,acknowledged:true,membership_verified:true,summary:'Pi-hole reported the requested client memberships. DNS behavior has not been verified.',checked_at:now}};
          current={...current,groups:[...review.after_groups]};receipts.unshift(receipt);result={receipt};
        } else if(endpoint==='disconnect') result={disconnected:true};
        else throw Error('Unexpected endpoint '+endpoint);
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...base,...result})});
      });
      await page.evaluate(()=>switchPanel('panel-homelab'));
      await page.locator('#pihole-title').waitFor({state:'visible'});
      assert.equal(calls.length,0,'Navigation cannot contact Pi-hole');
      await page.locator('.pihole-config > summary').click();
      await page.locator('#pihole-origin').fill(origin);
      await page.locator('#pihole-password').fill('synthetic-app-password');
      await page.locator('#pihole-connect').click();
      await page.waitForFunction(()=>document.getElementById('pihole-status').textContent.includes('Connected for this TLI session'));
      assert.equal(await page.locator('#pihole-password').inputValue(),'');
      assert.equal(calls.length,1,'Connecting cannot automatically read DNS or clients');
      await page.locator('.pihole-config > summary').click();
      await page.locator('#pihole-inventory-read').click();
      await page.locator('#pihole-client option[value="192.168.1.40"]').waitFor({state:'attached'});
      await page.locator('#pihole-client').selectOption('AA:BB:CC:DD:EE:FF');
      assert.ok(await page.locator('#pihole-pause-review').isDisabled());
      assert.ok(await page.locator('#pihole-activity-read').isDisabled());
      assert.equal(await page.locator('#pihole-selected img').count(),0);
      await page.locator('#pihole-client').selectOption(address);
      await page.locator('#pihole-activity-read').click();
      await page.locator('#pihole-activity tbody tr').waitFor();
      assert.equal(await page.locator('#pihole-activity img').count(),0);
      await page.locator('#pihole-groups input[value="1"]').check();
      await page.locator('#pihole-groups-review').click();
      await page.locator('#pihole-review h3').waitFor();
      assert.ok(await page.locator('#pihole-apply').isDisabled(),'Review requires explicit checkbox');
      await page.locator('#pihole-confirm').check();
      await page.locator('#pihole-groups input[value="1"]').uncheck();
      assert.ok(await page.locator('#pihole-apply').isDisabled(),'Changing groups discards old review');
      await page.locator('#pihole-pause-review').click();
      await page.locator('#pihole-review h3').waitFor();
      assert.match(await page.locator('#pihole-review').innerText(),/no automatic timer/i);
      const pauseLayout=await layout(page,'panel-homelab');
      assert.equal(pauseLayout.duplicateIds.length,0);assert.equal(pauseLayout.overflow.length,0);assert.ok(pauseLayout.documentWidth<=width+2);
      await page.locator('#pihole-review').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`pihole-review-${width}-${theme}.png`),fullPage:true});
      await page.locator('#pihole-confirm').check();
      await page.locator('#pihole-apply').click();
      await page.locator('.pihole-receipt').waitFor();
      assert.deepEqual(current.groups,[]);
      assert.equal(calls.filter(row=>row.endpoint==='execute').length,1);
      await page.locator('#pihole-inventory-read').click();
      await page.locator('#pihole-client option[value="192.168.1.40"]').waitFor({state:'attached'});
      await page.locator('#pihole-client').selectOption(address);
      await page.locator('.pihole-receipt button').first().click();
      await page.waitForFunction(()=>document.getElementById('pihole-review').textContent.includes('restore previous groups'));
      await page.locator('#pihole-confirm').check();await page.locator('#pihole-apply').click();
      await page.waitForFunction(()=>document.querySelectorAll('.pihole-receipt').length===2);
      assert.deepEqual(current.groups,[0]);
      await page.locator('#pihole-inventory-read').click();
      await page.locator('#pihole-client option[value="192.168.1.40"]').waitFor({state:'attached'});
      await page.locator('#pihole-client').selectOption(address);
      emptyActivity=true;await page.locator('#pihole-activity-read').click();
      await page.waitForFunction(()=>document.getElementById('pihole-activity').textContent.includes('does not prove the device was inactive'));
      assert.equal(await page.evaluate(()=>Object.values({...localStorage,...sessionStorage}).some(v=>v.includes('synthetic-app-password')||v.includes('Living room TV'))),false);
      const held = new Promise(resolve=>{pending=resolve;});
      await page.locator('#pihole-activity-read').click();
      const hold=await held,before=calls.length;
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
      await page.locator('#tli-lock-input').fill('2468');await page.locator('#tli-lock-submit').click();
      await page.waitForFunction(()=>document.getElementById('tli-lock-screen').classList.contains('hidden'));
      hold.done();await page.waitForTimeout(100);
      assert.equal(await page.locator('.pihole-receipt').count(),0,'Lock clears private saved-change view');
      assert.equal(await page.locator('#pihole-client option').count(),1,'Late responses cannot restore client data');
      assert.equal(calls.length,before,'Unlock cannot replay operations');
      await page.locator('#pihole-check').click();
      await page.waitForFunction(()=>document.querySelectorAll('.pihole-receipt').length===2);
      assert.ok(await page.locator('#pihole-activity-read').isDisabled(),'Explicit check does not read devices or DNS');
      await page.locator('#pihole-title').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`pihole-${width}-${theme}.png`),fullPage:true});
      assert.equal(run.errors.length,0,'Real SPA uncaught errors');
      report.views.push({width,theme,calls,layout:pauseLayout,errors:run.errors});
      await context.close();
    }
  } finally {await browser.close();}
  assert.deepEqual(hashes(),report.sourceHashes,'Candidate sources must remain unchanged during browser acceptance');
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,views:report.views.length,result:'passed'}));
}
main().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);console.error(error);process.exitCode=1;});
