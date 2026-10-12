/* Real SPA with intercepted local APIs only; never starts, updates or quits a host. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixtures } = require('./verify_anniversary_ui_browser.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend');
const output = path.join(root, 'build_work', 'updates', 'browser');
const origin = 'http://127.0.0.1:18081';
const report = { synthetic: true, checks: [], screenshots: [], errors: [], requests: [],
  limitations: ['Every request is intercepted. No live host, file browser, updater, installation, restart or quit is used.'] };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
const available = { state: 'available', current_version: '1.3.4', latest_version: '1.3.5', platform: 'windows',
  update_method: 'guided', can_prepare: true, can_open: false, ready_path: '', progress: 0,
  checked_at: '2026-10-11T15:30:00Z', auto_check: false, update_url: 'https://thelanintelligence.com/downloads.json',
  notes: 'Synthetic release: guided updates and clearer Settings progress.', message: '', manual_url: 'https://github.com/TheLANIntelligence/TLI/releases' };
const ready = { ...available, state: 'ready', can_prepare: false, can_open: true, progress: 100,
  ready_path: 'C:\\Synthetic TLI\\updates\\1.3.5', message: 'Package verified. Installation is pending.' };

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addInitScript(() => {
        localStorage.setItem('tli_onboard_seen_v1', '1');
        localStorage.setItem('tli_settings', JSON.stringify({ defaultTheme: 'emeraldLight', searchEnabled: false, defaultBrain: 'bundled' }));
        sessionStorage.setItem('tli_session_unlocked', '1');
      });
      let status = { ...available }, failApply = false, documentLoads = 0;
      await context.route('**/*', route => {
        const req = route.request(), url = new URL(req.url()), pathname = decodeURIComponent(url.pathname), method = req.method();
        if (url.origin !== origin) return route.abort('blockedbyclient');
        const respond = (value, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(value) });
        if (pathname.startsWith('/update/')) {
          const body = method === 'POST' ? req.postDataJSON() : null;
          report.requests.push({ width, path: pathname, method, body });
          if (pathname === '/update/status') return respond(status);
          if (pathname === '/update/check') { status = { ...available }; return respond(status); }
          if (pathname === '/update/apply') {
            if (failApply) return respond({ detail: 'Synthetic download interruption' }, 503);
            status = { ...available, state: 'downloading', progress: 47 };
            return respond({ ok: true });
          }
          if (pathname === '/update/open') return respond({ ok: true });
          if (pathname === '/update/settings') return respond({ ok: true });
          return respond({ detail: 'Unknown synthetic update route' }, 404);
        }
        if (pathname.startsWith('/api/host-control/')) {
          report.requests.push({ width, path: pathname, method });
          return respond({ detail: 'No lifecycle operation is exercised by this fixture.' }, 409);
        }
        if (!['GET', 'HEAD'].includes(method)) return respond({ ok: false, detail: 'Synthetic fixture: no operation executed.' }, 409);
        if (pathname === '/') documentLoads++;
        const file = path.resolve(frontend, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (file.startsWith(frontend + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        }
        return Object.hasOwn(fixtures, pathname) ? respond(fixtures[pathname]) : respond({ ok: false, detail: 'Synthetic service unavailable.' }, 503);
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ width, message: error.stack || error.message }));
      const check = async (name, fn) => { await fn(); report.checks.push({ width, name, passed: true }); };
      const capture = async name => {
        await page.locator('#settings-section-updates').scrollIntoViewIfNeeded();
        const file = path.join(output, `${width}-${name}.png`);
        await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file);
      };
      const refresh = async expected => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForFunction(value => document.getElementById('settings-update-state').textContent.includes(value), expected);
      };
      try {
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.waitForFunction(() => window.TLISettingsWorkspace && window.TLIHostLifecycle);
        await page.evaluate(() => { switchPanel('panel-settings'); TLISettingsWorkspace.open('app', 'settings-section-updates'); });
        await page.waitForFunction(() => document.getElementById('settings-update-state').textContent.includes('Update available'));
        await check('available release exposes Settings download, last check, release notes and saved preference', async () => {
          assert.equal(await page.locator('#settings-update-action-btn').innerText(), 'Download update');
          assert.equal(await page.locator('#settings-update-auto-check').isChecked(), false);
          assert.equal(await page.locator('#settings-update-progress-wrap').isVisible(), false);
          assert.equal(await page.locator('#tli-update-progress-wrap').isVisible(), false);
          assert.match(await page.locator('#settings-update-platform').innerText(), /Windows/);
          assert.doesNotMatch(await page.locator('#settings-update-checked').innerText(), /not yet/);
          await page.locator('#settings-update-notes-btn').click();
          assert.match(await page.locator('#tli-update-notes-body').innerText(), /Synthetic release/);
          await page.locator('#tli-update-notes-close').click();
          await capture('available');
        });
        await check('dismissed banner leaves an accessible Settings action', async () => {
          await page.locator('#tli-update-dismiss-btn').click();
          assert.equal(await page.locator('#tli-update-banner').isVisible(), false);
          assert.equal(await page.locator('#settings-update-action-btn').isVisible(), true);
          await capture('dismissed');
        });
        await check('download uses one JSON POST and continues progress in Settings', async () => {
          await page.locator('#settings-update-action-btn').click();
          await page.waitForFunction(() => document.getElementById('settings-update-progress').value === 47);
          assert.equal(await page.locator('#settings-update-progress-wrap').isVisible(), true);
          assert.equal(await page.locator('#tli-update-banner').isVisible(), false);
          const applied = report.requests.filter(r => r.width === width && r.path === '/update/apply');
          assert.equal(applied.length, 1); assert.equal(applied[0].method, 'POST'); assert.deepEqual(applied[0].body, {});
          await capture('downloading');
        });
        await check('ready package opens only on request and keeps installation pending with no automatic reload or quit', async () => {
          status = { ...ready }; await refresh('installation pending');
          assert.equal(await page.locator('#settings-update-action-btn').innerText(), 'Open update folder');
          assert.equal(await page.locator('#settings-tli-version').innerText(), 'v1.3.4');
          assert.match(await page.locator('#settings-update-stop').innerText(), /Host Start helper/);
          assert.equal(await page.locator('#settings-update-progress-wrap').isVisible(), false);
          assert.equal(report.requests.some(r => r.path === '/update/open'), width !== 1440);
          await page.locator('#settings-update-action-btn').click();
          await page.waitForFunction(() => document.getElementById('settings-update-message').textContent.includes('Update folder opened'));
          assert.equal(report.requests.filter(r => r.width === width && r.path === '/update/open').length, 1);
          assert.equal(report.requests.some(r => r.path.startsWith('/api/host-control/')), false);
          assert.equal(documentLoads, 1);
          await capture('ready');
        });
        await check('failed preparation retries the check and restores download', async () => {
          status = { ...available }; await refresh('Update available'); failApply = true;
          await page.locator('#settings-update-action-btn').click();
          await page.waitForFunction(() => document.getElementById('settings-update-action-btn').textContent === 'Retry check');
          assert.match(await page.locator('#settings-update-message').innerText(), /Synthetic download interruption/);
          await capture('retry');
          const before = report.requests.filter(r => r.width === width && r.path === '/update/apply').length;
          await page.locator('#settings-update-action-btn').click();
          await page.waitForFunction(() => document.getElementById('settings-update-action-btn').textContent === 'Download update');
          assert.equal(report.requests.filter(r => r.width === width && r.path === '/update/apply').length, before);
          assert.equal(report.requests.filter(r => r.width === width && r.path === '/update/check').length, 1);
        });
        await check('older packages offer the official download page without a prepare action', async () => {
          status = { ...available, can_prepare: false, message: 'This release uses the website installer.' };
          await refresh('Update available');
          await page.waitForFunction(() => !document.getElementById('settings-update-manual-link').hidden);
          assert.equal(await page.locator('#settings-update-action-btn').isVisible(), false);
          assert.equal(await page.locator('#settings-update-manual-link').getAttribute('href'), 'https://github.com/TheLANIntelligence/TLI/releases');
          assert.match(await page.locator('#settings-update-message').innerText(), /website installer/);
          await capture('manual');
        });
        await check('Mac ready instructions explain Terminal stop and hide unsupported in-app Quit', async () => {
          status = { ...ready, platform: 'macos' }; await refresh('installation pending');
          assert.match(await page.locator('#settings-update-stop').innerText(), /Control\+C/);
          assert.match(await page.locator('#settings-update-installer').innerText(), /TLI_Update\.command/);
          assert.equal(await page.locator('#settings-update-quit-btn').isVisible(), false);
          assert.ok(await page.locator('#settings-section-updates').evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'Update Settings must fit the viewport');
          await capture('mac-ready');
        });
      } finally { await context.close(); }
    }
    report.passed = report.checks.length === 14 && !report.errors.length;
  } catch (error) { report.error = error.stack; report.passed = false; throw error; }
  finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
  console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks, errors: report.errors }));
  process.exitCode = report.passed ? 0 : 1;
}
run().catch(error => { console.error(error); process.exitCode = 1; });
