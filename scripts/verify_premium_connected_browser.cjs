/* Real SPA and real controllers, intercepted fixtures only: no host/device actions. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
if (!process.argv.includes('--label')) process.argv.push('--label', 'premium-connected');
const {makePage, layout, fixtures, out} = require('./verify_anniversary_ui_browser.cjs');
fixtures['/api/intelligence/devices'] = {devices:[
  {id:'fixture-lamp',kind:'smart_device',vendor:'shelly',address:'192.0.2.20',relay:0,name:'Desk lamp',room:'Study'},
  {id:'fixture-fan',kind:'smart_device',vendor:'shelly',address:'192.0.2.21',relay:0,name:'Studio fan',room:'Living room'},
]};
fixtures['/api/builder/web-apps'] = {projects:[]};
const app = {id:'app_0123456789abcdef',name:'Study timer',brief:'A study timer',status:'ready_for_preview',last_error:'',revisions:[{
  revision:1,summary:'A study timer with start and pause',backend:'fixture',files:{'index.html':'<h1>Study timer</h1>','app.js':'','style.css':''},validation:{checks:['Local files']},checks:[],manual_checks:['Check the timer countdown.'],
}]};
async function main() {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const width of [1440,390,320]) for (const theme of ['emeraldLight','midnight']) {
      const run = await makePage(browser,width,theme), {page} = run;
      await page.evaluate(()=>{document.documentElement.dataset.experience='premium';document.documentElement.dataset.interface='modern';});
      let writes=0, on=false;
      await page.route('**/shelly/status?*', route=>route.fulfill({json:{ok:true,raw:{'switch:0':{output:on,apower:on?12.5:0,voltage:120,current:.1}}}}));
      await page.route('**/shelly/relay', async route=>{writes++;on=route.request().postDataJSON().action==='on';await new Promise(r=>setTimeout(r,70));await route.fulfill({json:{ok:true}});});
      await page.evaluate(async()=>{switchPanel('panel-homeauto');await loadShellyHostRegistry();await fetchAllShellyStatuses(true);stopShellyAutoRefresh();});
      assert.deepEqual(await page.locator('.sha-room-heading').allTextContents(),['Living room','Study']);
      const card=page.locator('.shelly-device-card[data-ip="192.0.2.20"]');
      await card.locator('.sha-power-control').click();
      await page.waitForFunction(()=>document.querySelector('.shelly-device-card[data-ip="192.0.2.20"] .sha-command-result').textContent.includes('reports ON'));
      assert.equal(writes,1);assert.match(await card.locator('.sha-device-state').textContent(),/On · verified/);
      await page.evaluate(()=>{shellyDevices['192.0.2.20#0'].status.checkedAt=Date.now()-40000;renderAllShellyCards();});
      assert.match(await card.locator('.sha-power-control').textContent(),/Check state/);
      await card.locator('.sha-power-control').click();
      await page.waitForFunction(()=>document.querySelector('.shelly-device-card[data-ip="192.0.2.20"] .sha-device-state').textContent.includes('On · verified'));
      assert.equal(writes,1,'Unknown/stale power control only reads status; it cannot guess a toggle');
      await card.locator('summary').click();await card.locator('summary').focus();
      await page.evaluate(()=>renderAllShellyCards());
      assert.equal(await card.locator('details').evaluate(el=>el.open),true);
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.shaControl),'details');
      await page.evaluate(()=>{document.documentElement.dataset.experience='legacy';document.documentElement.dataset.experience='premium';});
      assert.equal(writes,1);
      for (const panel of ['panel-homeauto','panel-builder','panel-files','panel-visualizer','panel-mesh']) {
        await page.evaluate(id=>switchPanel(id),panel);await page.waitForTimeout(100);
        const measure=await layout(page,panel);
        assert.deepEqual(measure.overflow,[],`${panel} ${theme} at ${width}: ${JSON.stringify(measure.overflow)}`);
        assert.ok(measure.documentWidth<=width+2,`${panel} document overflow at ${width}`);
        assert.deepEqual(measure.duplicateIds,[]);
        if (panel==='panel-builder') {
          await page.locator('#builder-app-brief').fill('Make a study timer');
          await page.locator('#builder-repository-mode').click();
          assert.equal(await page.locator('.builder-hero').isVisible(),true);
          await page.locator('#builder-small-app-mode').click();
          assert.equal(await page.locator('#builder-app-brief').inputValue(),'Make a study timer');
          await page.route('**/api/builder/web-apps', route=>route.fulfill({json:route.request().method()==='POST'?{project:app}:{projects:[app]}}));
          await page.getByRole('button',{name:'Build with local AI',exact:true}).click();
          await page.waitForFunction(()=>!document.querySelector('.builder-app-workspace').hidden);
          assert.equal(await page.locator('.builder-app-preview iframe').count(),0);
          await page.locator('#builder-repository-mode').click();await page.locator('#builder-small-app-mode').click();
          assert.match(await page.locator('.builder-app-workspace').textContent(),/Study timer/);
          const result=await layout(page,panel);assert.deepEqual(result.overflow,[]);
        }
        await page.screenshot({path:path.join(out,`${panel}-${width}-${theme}.png`),fullPage:true});
      }
      assert.deepEqual(run.errors,[]);await run.context.close();
    }
    console.log('Premium connected browser checks passed: 6 layouts × 5 workspaces; explicit state verification, stable room order, disclosure/focus and drafts retained. '+out);
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
