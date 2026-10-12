/* Synthetic browser regression: no server, real peers, credentials or LAN I/O. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const mesh = fs.readFileSync(path.join(root, 'frontend/js/mesh.js'), 'utf8');
const switcher = app.slice(app.indexOf('function setupNodeSwitcher() {'), app.indexOf('// ---------- init ----------', app.indexOf('function setupNodeSwitcher() {')));
const directoryRenderer = mesh.slice(mesh.indexOf('function renderMeshDirectory(directory) {'), mesh.indexOf('async function refreshMeshDirectory()'));
assert(switcher.includes('subscribeExpiry') && directoryRenderer.includes('computeNodeHealth'));
const html = `<!doctype html><meta charset="utf-8"><style>.hidden{display:none}.node-switcher-item{display:flex;gap:12px;padding:8px}.mesh-node-card{border:1px solid #ccc}</style>
<span id="device-name-chip">Synthetic home</span><button id="node-switcher-btn">Computers <span id="node-switcher-label"></span></button>
<div id="node-switcher-menu" class="hidden"><div id="node-switcher-items"></div></div>
<section id="mesh-host-card"><p id="mesh-directory-status"></p><div id="mesh-directory-list"></div><p id="mesh-directory-empty"></p></section>`;

async function main() {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  const checks = [];
  try {
    for (const width of [1440,390]) {
      const context = await browser.newContext({viewport:{width,height:960}});
      const page = await context.newPage();
      let directory = {this_device_id:'self', devices:[]}, held = null, release = null, requests = 0;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        assert.equal(url.hostname, 'tli.test', 'Never contact a discovered computer in this harness');
        if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:html});
        if (url.pathname === '/mesh/directory') {
          requests++;
          const value = structuredClone(directory);
          if (held) { release = held; await held.promise; }
          return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
        }
        throw Error('Unexpected request: '+url.pathname);
      });
      await page.goto('https://tli.test/');
      await page.evaluate(() => {
        window.currentNodeConfig = {is_host:true}; window.meshDirectoryCache = null;
        window.meshUiLocked = false; window.$ = id => document.getElementById(id);
        window.opened = []; window.connections = []; window.toasts = [];
        window.open = (...args) => opened.push(args);
        window.TLIConnectDevice = {open:value => connections.push(value)};
        window.showToast = (...args) => toasts.push(args);
        window.realNow = Date.now.bind(Date); window.clockOffset = 0;
        Date.now = () => realNow()+clockOffset;
      });
      await page.addScriptTag({path:path.join(root,'frontend/js/mesh-service.js')});
      await page.addScriptTag({content:"const meshEscape = value => String(value == null ? '' : value).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n"+directoryRenderer+'\n'+switcher+'\nsetupNodeSwitcher();'});
      const receipt = () => ({state:'connected',fresh:true,online:true,expires_at:new Date(Date.now()+90000).toISOString(),ready_grants:['messages'],capabilities:{messages:{state:'ready'}}});
      const base = {device_id:'peer',display_name:'Workshop',status:'allowed',trust_state:'verified',peer_profile:'full_host',origin:'https://workshop.local:9443',ip:'192.168.2.20',port:8000,is_host:true,last_seen:new Date().toISOString()};
      async function open(row) {
        if (!await page.locator('#node-switcher-menu').evaluate(node=>node.classList.contains('hidden'))) await page.locator('#node-switcher-btn').click();
        directory = {this_device_id:'self',devices:[row]}; const before = requests;
        await page.locator('#node-switcher-btn').click();
        await page.waitForFunction(name => document.querySelector('.node-switcher-item-name')?.textContent===name,row.display_name);
        assert(requests>before);
      }

      // A sole pending row remains available, names are text, and host/timestamp
      // metadata cannot create a live status or a guessed HTTP console link.
      const pending = {...base,display_name:'<img src=x onerror=alert(1)>',status:'pending',trust_state:'unreviewed',origin:'http://unreviewed.local:8000'};
      await open(pending);
      assert.equal(await page.locator('#node-switcher-items button').count(),1);
      assert.equal(await page.locator('#node-switcher-items a, #node-switcher-items img').count(),0);
      assert.equal(await page.locator('.node-switcher-item--online').count(),0);
      await page.locator('.node-switcher-item').click();
      assert.deepEqual(await page.evaluate(()=>connections),[{kind:'computer',deviceId:'peer'}]);
      assert.deepEqual(await page.evaluate(()=>opened),[]);
      checks.push({width,pendingRoutesToReview:true,untrustedNameIsText:true});

      await open({...base,display_name:'Reviewed console',connection:receipt()});
      assert.equal(await page.locator('.node-switcher-item-badge').textContent(),'Connected');
      await page.locator('.node-switcher-item').click();
      assert.deepEqual(await page.evaluate(()=>opened),[['https://workshop.local:9443/?panel=','_blank','noopener']]);
      await open({...base,display_name:'Compute Node',peer_profile:'inference_node',connection:receipt()});
      await page.locator('.node-switcher-item').click();
      assert.deepEqual(await page.evaluate(()=>connections.at(-1)),{kind:'node',deviceId:'peer'});
      assert.equal(await page.evaluate(()=>opened.length),1);
      await open({...base,display_name:'Invalid console origin',origin:'http://192.168.2.20:8000'});
      await page.locator('.node-switcher-item').click();
      assert.equal(await page.evaluate(()=>opened.length),1);
      assert.equal(await page.evaluate(()=>toasts.length),1);
      checks.push({width,reviewedHttpsExact:true,nodeHasNoConsole:true,noHttpFallback:true});

      // Both live header and legacy card badges must expire without another
      // request. Authority alone and a recent beacon cannot claim Connected.
      const connected = {...base,display_name:'Expiry sample',connection:receipt()};
      await open(connected);
      await page.evaluate(row=>renderMeshDirectory({devices:[row]}),connected);
      assert.match(await page.locator('.mesh-pill-health').textContent(),/Connected/);
      await page.locator('.node-switcher-item').focus();
      const count = requests;
      await page.evaluate(()=>clockOffset=120000);
      await page.waitForFunction(()=>document.querySelector('.node-switcher-item-badge')?.textContent==='Not checked' && document.querySelector('.mesh-pill-health')?.textContent==='Connection not checked');
      assert.equal(await page.locator('.node-switcher-item--online').count(),0);
      assert(await page.locator('.node-switcher-item').evaluate(node=>document.activeElement===node),'Receipt expiry preserves keyboard focus');
      assert.equal(requests,count,'Expiry must not probe the network');
      await page.evaluate(()=>clockOffset=0);
      for (const connection of [undefined,{state:'connected',fresh:true},{...receipt(),expires_at:'not-a-date'}]) {
        await page.evaluate(row=>renderMeshDirectory({devices:[row]}),{...base,connection});
        assert.match(await page.locator('.mesh-pill-health').textContent(),/Connection not checked/);
      }
      checks.push({width,expiresWithoutNetwork:true,legacyNoTimestampPresence:true});

      // A delayed directory response cannot restore the switcher after lock.
      await page.locator('#node-switcher-btn').click();
      let resolve;
      const promise = new Promise(done=>{resolve=done;});
      held = {promise,resolve}; directory={devices:[{...base,display_name:'Late private row',connection:receipt()}]};
      await page.locator('#node-switcher-btn').click();
      await page.waitForFunction(()=>!document.querySelector('#node-switcher-menu').classList.contains('hidden'));
      while (!release) await new Promise(done=>setTimeout(done,10));
      await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));
      release.resolve(); held=null;
      await page.waitForTimeout(50);
      assert.equal(await page.locator('#node-switcher-items').textContent(),'');
      assert(await page.locator('#node-switcher-menu').evaluate(node=>node.classList.contains('hidden')));
      checks.push({width,lockRejectsLateDirectory:true});
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({synthetic:true,checks},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
