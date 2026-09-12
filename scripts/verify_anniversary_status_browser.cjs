/* Full SPA status presentation against synthetic intercepted responses only. */
const { chromium } = require('playwright');
const { makePage, fixtures } = require('./verify_anniversary_ui_browser.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'build_work', 'anniversary-ui', 'status-browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const files = ['frontend/app.js', 'frontend/js/ui-health.js', 'frontend/js/system-state-bar.js', 'frontend/js/ui-foundation.js', 'frontend/ui-foundation.css', 'frontend/index.html', 'scripts/verify_anniversary_status_browser.cjs'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const startingHashes = hashes(), original = JSON.parse(JSON.stringify(fixtures)), results = [];
function reset() {
  Object.keys(fixtures).forEach(key => delete fixtures[key]); Object.assign(fixtures, JSON.parse(JSON.stringify(original)));
  const stamp = Date.now() / 1000;
  fixtures['/dashboard/command-center'].ts = stamp;
  fixtures['/dashboard/command-center'].state.probed_ts = stamp;
  Object.assign(fixtures['/dashboard/command-center'], { aiOk: false, lmOnline: false, activeAlerts: [] });
  fixtures['/api/mesh/health'] = { ok: true, nodes: [
    { node_id: 'fixture-studio', node_name: 'Studio', is_self: true, online: true, ai_healthy: false, cpu_percent: 18, ram_percent: 43 },
    { node_id: 'fixture-den', node_name: 'Den', is_self: false, online: true, ai_healthy: false, cpu_percent: 29, ram_percent: 51 },
  ] };
  return stamp;
}
async function open(run) {
  run.page.setDefaultTimeout(7000);
  await run.page.evaluate(() => switchPanel('panel-dashboard2'));
  await run.page.waitForFunction(() => document.getElementById('nd-meta-line').dataset.freshness && document.querySelector('#nd-mesh-nodes .nd-mesh-node'));
}
const noActions = calls => {
  assert.deepEqual(calls.filter(c => !['GET', 'HEAD'].includes(c.method)), [], 'Status presentation must not mutate state');
  assert.ok(calls.every(c => !/\/(?:generate|completion|completions|run|check|scan)(?:\/|$)/.test(c.path)), 'No model generation, diagnostics or device actions');
};
async function check(browser, name, setup, inspect) {
  const stamp = reset(); setup?.();
  const run = await makePage(browser, 1440, 'emeraldLight'); const baseline = run.calls.length, baselineErrors = run.errors.length;
  const result = { name, status: 'passed' };
  try {
    await open(run); await inspect(run, stamp);
    noActions(run.calls.slice(baseline));
    assert.equal(run.errors.length, baselineErrors, 'No new uncaught browser errors');
  } catch (error) { result.status = 'failed'; result.error = error.stack; }
  result.presentation = await run.page.evaluate(() => ({
    meta: document.getElementById('nd-meta-line').textContent,
    label: document.getElementById('nd-status-label').textContent,
    quickRead: document.getElementById('nd-quickread').textContent,
    mesh: document.getElementById('nd-mesh-strip').textContent,
  }));
  result.calls = run.calls; result.errors = run.errors; result.unknown = [...new Set(run.unknown)];
  await run.page.screenshot({ path: path.join(out, name + '.png') }); await run.context.close(); results.push(result);
  console.log(`${result.status}: ${name}${result.error ? '\n' + result.error : ''}`);
}
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await check(browser, 'fresh-system-check-independent-of-ai', null, async ({ page }) => {
      assert.equal(await page.locator('#nd-status-label').innerText(), 'CHECKED');
      assert.equal(await page.locator('#nd-meta-line').getAttribute('data-freshness'), 'fresh');
      assert.equal(await page.locator('#ndv-ai-val').innerText(), 'Unavailable');
      assert.match(await page.locator('#nd-quickread').innerText(), /AI unavailable/);
      assert.doesNotMatch(await page.locator('#nd-meta-line').innerText(), /AI readiness|AI unavailable/);
    });
    await check(browser, 'unknown-ai-and-peer-readings-stay-unknown', () => {
      delete fixtures['/dashboard/command-center'].aiOk; delete fixtures['/dashboard/command-center'].lmOnline;
      fixtures['/api/mesh/health'].nodes[1] = { node_id: 'fixture-den', node_name: 'Den', is_self: false, has_ai: true, cpu_percent: -2, ram_percent: null };
    }, async ({ page }) => {
      assert.equal(await page.locator('#nd-status-label').innerText(), 'CHECKED');
      assert.equal(await page.locator('#ndv-ai-val').innerText(), 'Unknown');
      assert.match(await page.locator('#nd-quickread').innerText(), /AI status unknown/);
      const peer = page.locator('#nd-mesh-nodes .nd-mesh-node').filter({ hasText: 'Den' });
      assert.match(await peer.innerText(), /Status unknown/); assert.match(await peer.innerText(), /AI status unknown/);
      assert.match(await peer.innerText(), /CPU unknown/); assert.match(await peer.innerText(), /RAM unknown/);
      assert.doesNotMatch(await peer.innerText(), /CPU 0%|RAM 0%|Not reachable|AI unavailable/);
    });
    await check(browser, 'partial-and-invalid-metrics', () => {
      const data = fixtures['/dashboard/command-center'];
      Object.assign(data.state, { cpu_pct: null, ram_pct: '43%', disk_pct_by_drive: {} });
      data.diskData = { ok: true, system: { drive: 'C:', pct: null } }; data.devCount = null;
    }, async ({ page }) => {
      assert.equal(await page.locator('#nd-status-label').innerText(), 'UNKNOWN');
      assert.equal(await page.locator('#nd-meta-line').getAttribute('data-freshness'), 'incomplete');
      assert.equal(await page.locator('#ndv-storage-val').innerText(), '—');
      assert.match(await page.locator('#ndv-storage-sub').innerText(), /unavailable/);
      for (const key of ['cpu', 'ram']) assert.equal(await page.locator(`#tli-state-bar [data-metric="${key}"]`).innerText(), '--');
      assert.doesNotMatch(await page.locator('#nd-quickread').innerText(), /undefined|NaN|0%/);
    });
    await check(browser, 'partial-storage-capacity', () => {
      fixtures['/dashboard/command-center'].diskData = { ok: true, system: { drive: 'C:', pct: 74 } };
    }, async ({ page }) => {
      assert.equal(await page.locator('#ndv-storage-val').innerText(), '74%');
      assert.match(await page.locator('#ndv-storage-sub').innerText(), /Capacity details unavailable/);
      assert.doesNotMatch(await page.locator('#nd-quickread').innerText(), /undefined|NaN|0 GB/);
    });
    await check(browser, 'thirty-second-expiry-without-new-probe', null, async ({ page, calls }, stamp) => {
      const before = calls.filter(c => ['/dashboard/command-center', '/dashboard/state'].includes(c.path)).length;
      const storage = await page.locator('#ndv-storage-val').innerText();
      // Move Date.now while leaving real interval scheduling alone. The one-second
      // freshness renderer runs; the thirty-second refresh has not elapsed.
      await page.clock.setFixedTime(new Date(stamp * 1000 + 30001));
      await page.waitForFunction(() => document.getElementById('nd-meta-line').dataset.freshness === 'stale');
      assert.match(await page.locator('#nd-meta-line').innerText(), /readings stale/);
      assert.equal(await page.locator('#nd-status-label').innerText(), 'UNKNOWN');
      assert.equal(await page.locator('#ndv-storage-val').innerText(), storage);
      assert.equal(calls.filter(c => ['/dashboard/command-center', '/dashboard/state'].includes(c.path)).length, before);
    });
    await check(browser, 'failed-dashboard-refresh-retains-observation', null, async ({ page, calls }) => {
      const before = await page.evaluate(() => ({
        storage: document.getElementById('ndv-storage-val').textContent, smart: document.getElementById('ndv-smart-val').textContent,
        ai: document.getElementById('ndv-ai-val').textContent, time: document.getElementById('nd-meta-line').textContent.split(' · ').at(-1),
      }));
      const failed = ['/dashboard/command-center', '/status', '/homeauto/devices', '/api/ai/bundled/status', '/api/system/disk', '/status/alerts'];
      await page.route(url => url.hostname === 'tli-ui.test' && failed.includes(url.pathname), async route => {
        calls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, detail: 'Synthetic monitoring failure' }) });
      });
      await page.evaluate(() => { window.TLIDash2.onClose(); window.TLIDash2.onOpen(); });
      await page.waitForFunction(() => document.getElementById('nd-meta-line').dataset.freshness === 'unavailable');
      assert.equal(await page.locator('#ndv-storage-val').innerText(), before.storage);
      assert.equal(await page.locator('#ndv-smart-val').innerText(), before.smart);
      assert.equal(await page.locator('#ndv-ai-val').innerText(), before.ai);
      assert.match(await page.locator('#nd-meta-line').innerText(), /Monitoring unavailable; previous results retained/);
      assert.ok((await page.locator('#nd-meta-line').innerText()).endsWith(before.time));
      assert.equal(await page.locator('#nd-status-label').innerText(), 'UNKNOWN');
    });
    await check(browser, 'failed-mesh-refresh-retains-computers', null, async ({ page, calls }) => {
      await page.waitForFunction(() => /Computers checked/.test(document.querySelector('.ui-mesh-observed').textContent));
      const before = await page.locator('#nd-mesh-nodes').innerHTML();
      const time = (await page.locator('.ui-mesh-observed').innerText()).replace('Computers checked ', '');
      await page.route('http://tli-ui.test/api/mesh/health', route => {
        calls.push({ method: route.request().method(), path: '/api/mesh/health' });
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      });
      await page.evaluate(() => { window.TLIDash2.onClose(); window.TLIDash2.onOpen(); });
      await page.waitForFunction(() => /Computer refresh unavailable/.test(document.querySelector('.ui-mesh-observed').textContent));
      assert.equal(await page.locator('#nd-mesh-nodes').innerHTML(), before);
      assert.ok((await page.locator('.ui-mesh-observed').innerText()).includes(time));
    });
  } finally { await browser.close(); }
  const finalHashes = hashes(), changedSources = files.filter(file => startingHashes[file] !== finalHashes[file]);
  const report = { synthetic: true, source: root, startingHashes, finalHashes, changedSources, results, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, passed: report.passed, failed: report.failed, changedSources }));
  if (report.failed || changedSources.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); fs.writeFileSync(path.join(out, 'error.txt'), error.stack); process.exitCode = 1; });
