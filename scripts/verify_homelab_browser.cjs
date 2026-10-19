/* Real SPA, synthetic HomeLab responses; no server or lab hardware contacted. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (!process.argv.includes('--label')) process.argv.push('--label','homelab');
const {makePage,layout} = require('./verify_anniversary_ui_browser.cjs');
const output = path.resolve(__dirname,'../build_work/homelab',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const now = new Date().toISOString();
const overview = () => ({checked_at:now,sources:{
  computers:{state:'available',detail:'Saved computer entries; live availability unknown.',items:[
    {id:'node-studio',name:'Studio workstation',kind:'host',role:'standalone',availability:'unknown'},
    {id:'node-spare',name:'Spare AI computer',kind:'computer',role:'registered',availability:'unknown'}]},
  devices:{state:'available',detail:'Registered devices; live availability unknown.',items:[
    {id:'homepower-lamp',name:'Desk lamp',kind:'smart_device',room:'Office',availability:'unknown'}]},
  ai:{state:'not_checked',selection:null,detail:'Choose local AI or a reviewed LAN model in Ask TLI. Readiness is not checked.'}
}});
const snapshot = () => ({ok:true,protocol:'tli-homelab-proxmox-v1',origin:'https://192.168.1.20:8006',checked_at:now,tls_verification:'certificate_pin',actions_performed:false,
  scope:'Resources visible to this API token only. Reported status is not application health.',
  counts:{nodes:1,virtual_machines:1,containers:1,storage:1,other:0,total:4},resources:[
    {id:'node/pve',type:'node',name:'Lab server',node:'pve',status:'online',cpu:.12,mem:8*1024**3,maxmem:32*1024**3},
    {id:'qemu/100',type:'qemu',name:'Media server',node:'pve',status:'running',cpu:.04,mem:2*1024**3,maxmem:4*1024**3},
    {id:'lxc/101',type:'lxc',name:'<img src=x onerror=alert(1)>',node:'pve',status:'stopped'},
    {id:'storage/pve/local',type:'storage',name:'local',node:'pve',status:'available',disk:100*1024**3,maxdisk:500*1024**3}
  ]});
const report = {synthetic:true,output,views:[],limitations:['Synthetic API responses; no Proxmox, live household devices or physical phone tested.']};
const files = ['backend/homelab_overview.py','backend/homelab_proxmox.py','backend/routers/homelab_routes.py','frontend/js/homelab.js','frontend/homelab.css','frontend/index.html','frontend/js/ui-foundation.js','frontend/js/simplification.js','frontend/js/smart-hub.js'];
const hashes = () => Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',file))).digest('hex')]));
async function fill(page) {
  await page.locator('#lab-proxmox-origin').fill('https://192.168.1.20:8006');
  await page.locator('#lab-proxmox-token').fill('reader@pve!tli');
  await page.locator('#lab-proxmox-secret').fill('synthetic-secret-only');
  await page.locator('#lab-proxmox-pin').fill('a'.repeat(64));
}
async function main() {
  report.sourceHashes = hashes();
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const [width,theme] of [[1440,'midnight'],[1440,'emeraldLight'],[390,'emeraldLight'],[320,'midnight']]) {
      const run = await makePage(browser,width,theme), {page,context} = run;
      await page.route('**/system/pin/verify',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})}));
      let data = overview(), status = 200, pending = null;
      const calls = [];
      await page.route('**/api/homelab/**',async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname;
        calls.push({method:req.method(),endpoint});
        if (pending) { const resolve = pending; pending = null; await new Promise(done => resolve({done,route})); }
        if(endpoint.endsWith('/overview')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
        assert.equal(endpoint,'/api/homelab/proxmox/inspect'); assert.equal(req.method(),'POST');
        const body = req.postDataJSON(); assert.deepEqual(Object.keys(body).sort(),['certificate_sha256','origin','token_id','token_secret']);
        assert.equal(body.token_secret,'synthetic-secret-only');
        return route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?snapshot():{detail:'Synthetic Proxmox unavailable.'})});
      });
      await page.evaluate(()=>switchPanel('panel-homelab'));
      await page.locator('#lab-refresh').waitFor({state:'visible'});
      assert.equal(calls.length,0,'Opening HomeLab must not contact its APIs');
      assert.ok(await page.locator('[data-panel-target="panel-homelab"]').count(),'HomeLab must be discoverable in navigation');
      await page.locator('#lab-refresh').click();
      await page.waitForFunction(()=>document.querySelectorAll('.lab-record').length===3);
      assert.match(await page.locator('#lab-metrics').innerText(),/Choose AI/);
      assert.doesNotMatch(await page.locator('#lab-status').innerText(),/unavailable sources/);
      await page.locator('#lab-search').fill('Office');
      assert.equal(await page.locator('.lab-record').count(),1);
      assert.match(await page.locator('#lab-inventory').innerText(),/Desk lamp/);
      await page.locator('#lab-search').fill('');
      await page.locator('.lab-proxmox-config > summary').click();
      await fill(page);
      await page.locator('#lab-inspect').click();
      await page.waitForFunction(()=>document.querySelectorAll('.lab-proxmox-record').length===4);
      assert.equal(await page.locator('#lab-proxmox-secret').inputValue(),'');
      assert.equal(await page.locator('#lab-proxmox-token').inputValue(),'');
      assert.equal(await page.locator('#lab-proxmox-results img').count(),0,'Resource text must never become markup');
      assert.equal(await page.evaluate(()=>Object.values({...localStorage,...sessionStorage}).some(v=>v.includes('synthetic-secret-only'))),false);
      await page.locator('#lab-proxmox-kind').selectOption('qemu');
      assert.equal(await page.locator('.lab-proxmox-record').count(),1);
      await page.locator('#lab-proxmox-kind').selectOption('all');
      const layoutResult = await layout(page,'panel-homelab');
      assert.equal(layoutResult.duplicateIds.length,0,'No duplicate IDs');
      assert.equal(layoutResult.overflow.length,0,'No control overflow');
      assert.ok(layoutResult.documentWidth<=width+2,'No page overflow');
      await page.locator('.lab-proxmox-config').evaluate(element=>{element.open=false;});
      await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('.main-scroll').scrollTop=0;document.querySelector('.lab-hero').scrollIntoView({block:'start',behavior:'instant'});});
      await page.screenshot({path:path.join(output,`homelab-${width}-${theme}.png`),fullPage:true});
      await page.locator('#lab-proxmox-title').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`proxmox-${width}-${theme}.png`),fullPage:true});
      await page.locator('.lab-proxmox-config > summary').click();
      status = 502; await fill(page); await page.locator('#lab-inspect').click();
      await page.waitForFunction(()=>document.getElementById('lab-status').textContent.includes('Synthetic Proxmox unavailable'));
      assert.equal(await page.locator('.lab-proxmox-record').count(),4,'Failed read retains dated observation');
      data = overview(); data.sources.devices = {state:'unavailable',items:[],detail:'Synthetic damaged registry was retained.'};
      await page.locator('#lab-refresh').click();
      await page.waitForFunction(()=>document.querySelectorAll('.lab-record').length===2);
      assert.match(await page.locator('#lab-source-notices').innerText(),/damaged registry/);
      const held = new Promise(resolve => { pending = resolve; });
      await page.locator('#lab-refresh').click();
      const hold = await held, before = calls.length;
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
      await page.locator('#tli-lock-input').fill('2468');
      await page.locator('#tli-lock-submit').click();
      await page.waitForFunction(()=>document.getElementById('tli-lock-screen').classList.contains('hidden'));
      hold.done();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.lab-record').count(),0,'Late response cannot restore private records');
      assert.equal(await page.locator('.lab-proxmox-record').count(),0);
      assert.equal(calls.length,before,'Unlock cannot replay an inventory operation');
      assert.ok(await page.locator('#lab-inspect').isDisabled());
      data = overview(); data.sources.computers.items=[]; data.sources.devices.items=[];
      await page.locator('#lab-refresh').click();
      await page.waitForFunction(()=>document.getElementById('lab-inventory').textContent.includes('No records were returned'));
      assert.equal(run.errors.length,0,'SPA must have no uncaught errors');
      report.views.push({width,theme,calls,layout:layoutResult,errors:run.errors});
      await context.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(hashes(),report.sourceHashes,'Candidate sources must remain unchanged during browser acceptance');
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,views:report.views.length,result:'passed'}));
}
main().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);console.error(error);process.exitCode=1;});
