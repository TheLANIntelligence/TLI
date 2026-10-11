/* Real SPA, synthetic drives/jobs only. No household scans or file operations. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { makePage, layout, fixtures } = require('./verify_anniversary_ui_browser.cjs');
const out = path.resolve(__dirname, '../build_work/free-space-scope');
fs.mkdirSync(out, { recursive: true });
const GiB = 1024 ** 3;
fixtures['/visualizer/drives'].drives.push({ mountpoint: 'E:\\', label: 'Projects', free: 350 * GiB, total: 1000 * GiB, percent_used: 65 });
fixtures['/visualizer/cleanup/receipts'] = { ok: true, receipts: [] };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const report = { synthetic: true, checks: [], layouts: [], screenshots: [] };
  try {
    const run = await makePage(browser, 1440, 'porcelainLight');
    const { page } = run;
    const jobs = new Map(), jobRequests = []; let serial = 0, starts = 0, rejectNext = false, holdNext = false, heldJobId = null;
    await page.route('**/visualizer/jobs**', route => {
      const req = route.request(), url = new URL(req.url());
      const parts = url.pathname.split('/').filter(Boolean);
      jobRequests.push({method:req.method(),path:url.pathname});
      let job;
      if (req.method() === 'POST' && parts.length === 2) {
        starts++;
        if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic scan rejection.' }) }); }
        const body = req.postDataJSON();
        job = { id: (++serial).toString(16).padStart(32, '0'), host: { id: 'fixture-studio', name: 'Studio' }, operation: 'scan', profile: body.profile, path: body.path, status: 'completed', result_available: true, finished_at: new Date().toISOString() };
        if (holdNext) {
          holdNext = false; heldJobId = job.id;
          Object.assign(job, {status:'running', result_available:false, progress:{phase:'enumerating',entries_seen:42}, finished_at:null});
        }
        jobs.set(job.id, job);
      } else job = jobs.get(parts[2]);
      assert.ok(job);
      if (parts[3] === 'results') assert.equal(job.result_available, true, 'A running scan cannot supply completed results');
      const root = job.path;
      const children = root === 'C:\\' ? [{ name: 'hiberfil.sys', path: root + 'hiberfil.sys', size: 25.5 * GiB, protected: true }, { name: 'iVentoy', path: root + 'iVentoy', size: 12 * GiB, children: [{ name: 'Win10LTSC.vhd', path: root + 'iVentoy\\Win10LTSC.vhd', size: 7.6 * GiB }, { name: 'Windows.iso', path: root + 'iVentoy\\Windows.iso', size: 4.4 * GiB }] }] : [{ name: 'Project archive.zip', path: root + 'Project archive.zip', size: 10 * GiB }];
      const result = { tree: { name: root, path: root, size: children.reduce((sum, f) => sum + f.size, 0), children }, meta: { root, partial: false } };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, protocol: 'storage-jobs-v1', job, ...(parts[3] === 'results' ? { result } : {}) }) });
    });
    await page.evaluate(() => { TLIPresentation.set('premium'); switchPanel('panel-visualizer'); });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.experience), 'premium');
    await page.locator('.fs-drive').nth(1).waitFor();
    const drive = letter => page.locator('.fs-drive').filter({ hasText: letter + ':\\' });
    await drive('C').click();
    assert.equal(starts, 0);
    assert.equal(await page.locator('#fs-more-tools').evaluate(e => e.open), false);
    assert.equal(await page.locator('#fs-profile').isVisible(), false);
    assert.equal(await page.locator('[data-section-help="panel-visualizer"]').evaluate(e => e.open), false);
    assert.equal(await page.locator('[data-section-help="panel-visualizer"] .ui-section-help-body').isVisible(), false);
    assert.equal(await page.locator('[data-workflow-panel="panel-visualizer"]').isVisible(), false);
    await page.locator('#visualizerScanBtn').click();
    await page.locator('.fs-map-canvas').waitFor();
    assert.match(await page.locator('#vis4-summary').innerText(), /C:\\/);
    const tile = page.locator('button.fs-map-item[aria-label^="Win10LTSC.vhd"]');
    await tile.scrollIntoViewIfNeeded(); await tile.click({ button: 'right' });
    await page.locator('#fs-entry-menu').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Show in File Explorer', exact: true }).isVisible(), true);
    await page.keyboard.press('Escape');
    await drive('E').click();
    assert.equal(starts, 1);
    assert.equal(await page.locator('#storage-results').isVisible(), false);
    assert.equal(await page.locator('#fs-empty').isVisible(), true);
    assert.match(await page.locator('#fs-empty').innerText(), /E:\\/);
    assert.equal(await page.locator('#visualizerTableBody').innerText(), '');
    assert.equal(await page.locator('#fs-location-title').isVisible(), true);
    assert.equal(await page.locator('#fs-location-capacity').isVisible(), true);
    rejectNext = true;
    await page.locator('#visualizerScanBtn').click();
    await page.waitForFunction(() => document.getElementById('visualizerStatus').textContent.includes('Synthetic scan rejection'));
    assert.equal(await page.locator('#storage-results').isVisible(), false);
    await drive('C').click();
    await page.locator('.fs-map-canvas').waitFor(); assert.equal(starts, 2);
    report.checks.push('Drive selection never scans; C results disappear on E; rejected E scan never displays C; switching back restores C; reveal action remains available.');
    await page.locator('#fs-more-tools > summary').click();
    await page.locator('#fs-tab-duplicates').click();
    assert.equal(await page.locator('#fs-view-explore').isVisible(), false);
    assert.equal(await page.locator('#fs-view-duplicates').isVisible(), true);
    await page.locator('#fs-tab-explore').click();
    assert.equal(await page.locator('#vis4-summary').evaluate(e => e.contains(document.activeElement)), true);
    await page.locator('#fs-tab-duplicates').click();
    await page.locator('#fs-more-tools > summary').click();
    await page.locator('#fs-view-explore').waitFor({ state: 'visible' });
    report.checks.push('Closing extra tools returns to the selected drive results.');
    for (const [experience, mode, width] of [['premium', 'modern', 1440], ['premium', 'modern', 390], ['premium', 'modern', 320], ['legacy', 'classic', 1440], ['legacy', 'modern', 1440], ['legacy', 'modern', 390], ['legacy', 'classic', 320]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(({experience, mode}) => { TLIPresentation.set(experience); TLIInterface.set(mode); document.getElementById('fs-locations').open = false; }, {experience, mode});
      await page.locator('#panel-visualizer .page-title').scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const dimensions = await layout(page, 'panel-visualizer');
      assert.deepEqual(dimensions.overflow, []); assert.deepEqual(dimensions.duplicateIds, []);
      assert.ok(dimensions.documentWidth <= width + 1);
      const screenshot = path.join(out, `${experience}-${mode}-${width}.png`);
      await page.screenshot({ path: screenshot });
      report.layouts.push({ experience, mode, ...dimensions }); report.screenshots.push(screenshot);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { TLIPresentation.set('premium'); document.getElementById('fs-locations').open = true; });
    await drive('E').click();
    await page.locator('#visualizerScanBtn').click();
    await page.locator('.fs-map-canvas').waitFor();
    assert.match(await page.locator('#vis4-summary').innerText(), /E:\\/);
    assert.doesNotMatch(await page.locator('#storage-results').innerText(), /Win10LTSC|hiberfil|C:\\/);
    await page.locator('#panel-visualizer .page-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'e-drive-scanned.png') });
    // Keep one real controller job active while changing only browser appearance.
    // The intercepted host releases completion after all four palette checks.
    const startsBeforeThemes = starts;
    holdNext = true;
    await page.locator('#visualizerScanBtn').click();
    await page.waitForFunction(() => TLIFreeSpace.getState().job?.status === 'running');
    const active = await page.evaluate(() => {
      window.__scopeScanOwner = TLIFreeSpace;
      window.__scopeProgressNode = document.getElementById('fs-job-progress');
      const state = TLIFreeSpace.getState();
      return {id:state.job.id,path:state.job.path,progress:window.__scopeProgressNode.textContent,observationId:state.observation.job.id};
    });
    assert.equal(active.id, heldJobId); assert.equal(active.path, 'E:\\');
    assert.match(active.progress, /42/);
    for (const theme of ['emeraldLight','lavenderLite','pacific','oled']) {
      await page.evaluate(theme => TLIThemes.apply(theme), theme);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const current = await page.evaluate(() => {
        const state = TLIFreeSpace.getState();
        return {theme:document.documentElement.dataset.theme,id:state.job.id,path:state.job.path,status:state.job.status,
          entries:state.job.progress.entries_seen,progress:document.getElementById('fs-job-progress').textContent,
          observationId:state.observation.job.id,ownerRetained:TLIFreeSpace === window.__scopeScanOwner,
          progressNodeRetained:document.getElementById('fs-job-progress') === window.__scopeProgressNode};
      });
      assert.deepEqual(current, {theme,id:active.id,path:active.path,status:'running',entries:42,progress:active.progress,
        observationId:active.observationId,ownerRetained:true,progressNodeRetained:true});
      assert.equal(starts, startsBeforeThemes + 1, 'Appearance cannot restart a scan');
      assert.equal(await page.locator('#visualizerScanBtn').isEnabled(), false);
      assert.equal(await page.locator('#fs-job').isVisible(), true);
    }
    Object.assign(jobs.get(heldJobId), {status:'completed',result_available:true,finished_at:new Date().toISOString()});
    await page.waitForFunction(id => TLIFreeSpace.getState().observation?.job.id === id && !TLIFreeSpace.getState().busy, heldJobId);
    assert.equal(await page.evaluate(() => TLIFreeSpace.getState().observation.root), 'E:\\');
    assert.equal(starts, startsBeforeThemes + 1);
    assert.ok(jobRequests.filter(request => request.method === 'POST').every(request => request.path === '/visualizer/jobs'), 'Theme changes never cancel or modify the running host job');
    report.checks.push('Emerald, Lavender, Pacific and OLED preserve the same active scan, progress node, controller and prior observation; released results complete that exact job without an extra POST.');
    assert.deepEqual(run.errors, []);
    report.checks.push('Successful E scan shows only E contents; desktop and phone layouts have no overflow or duplicate IDs; no JavaScript errors.');
    report.passed = true;
    await run.context.close();
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
