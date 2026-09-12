/* Offline source exhibits: every request is intercepted, no TLI server. */
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work/anniversary-continuity/retrospective');
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const report = {synthetic:true,checks:[],requests:[],errors:[],physical_acceptance:'not_run'};
  try {
    for (const width of [1440,768,390,320]) {
      const context = await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        report.requests.push({method:request.method(),path:url.pathname});
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/(?:history\/)?/,'');
        const filename = path.resolve(root,'frontend/history',relative);
        if (url.hostname !== 'tli-history.test' || request.method() !== 'GET' || !filename.startsWith(path.join(root,'frontend/history')+path.sep) || !fs.existsSync(filename)) {
          report.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
          return route.abort();
        }
        return route.fulfill({contentType:filename.endsWith('.png')?'image/png':filename.endsWith('.css')?'text/css':filename.endsWith('.json')?'application/json':'text/html',body:fs.readFileSync(filename)});
      });
      const page = await context.newPage();
      page.on('pageerror', error=>report.errors.push(error.message));
      if(width===1440) {
        for(const edition of ['early','anniversary']) for(const panel of ['dashboard','chat','vault','files','settings']) {
          await page.goto(`http://tli-history.test/history/${edition}-${panel}.html`);
          await page.locator('.exhibit-panel').waitFor({state:'visible'});
          await page.screenshot({path:path.join(root,'frontend/history',`${edition}-${panel}.png`)});
        }
      }
      await page.goto('http://tli-history.test/');
      assert.equal(await page.locator('script').count(),0);
      assert.equal(await page.locator('iframe:not([sandbox])').count(),0);
      assert.equal(await page.locator('details').count(),5);
      const layout = await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));
      assert.ok(layout.content<=width+1, `Gallery overflows at ${width}`);
      await page.locator('summary').nth(1).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('details').nth(1).getAttribute('open'),'');
      assert.equal(await page.locator('img').count(),10);
      await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:path.join(output,`gallery-${width}.png`),fullPage:true});
      report.checks.push({width,keyboard_disclosure:true,layout});
      if(width===1440) for(const edition of ['early','anniversary']) for(const panel of ['dashboard','chat','vault','files','settings']) {
        await page.goto(`http://tli-history.test/history/${edition}-${panel}.html`);
        assert.equal(await page.locator('script,form,iframe,img,video,audio,object').count(),0);
        assert.equal(await page.locator('input:not([disabled]),button:not([disabled]),textarea:not([disabled]),select:not([disabled])').count(),0);
        assert.equal(await page.locator('[onclick],[onload],a[href]').count(),0);
        await page.screenshot({path:path.join(output,`${edition}-${panel}.png`),fullPage:false});
        report.checks.push({edition,panel,inert:true});
      }
      await context.close();
    }
    assert.deepEqual(report.errors,[]);
    const provenancePath=path.join(root,'frontend/history/provenance.json');
    const provenance=JSON.parse(fs.readFileSync(provenancePath,'utf8'));
    for(const view of provenance.views) {
      view.preview_file=view.file.replace(/\.html$/,'.png');
      view.preview_sha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'frontend/history',view.preview_file))).digest('hex');
      view.preview_conditions='Inert synthetic source exhibit rendered in Edge at 1440 × 1000, reduced motion; no application scripts.';
    }
    fs.writeFileSync(provenancePath,JSON.stringify(provenance,null,2)+'\n');
    console.log(`${report.checks.length} retrospective browser checks passed.`);
  } finally {
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
