/* Real Edge CSP/opaque-origin checks; every browser request is intercepted.
 * Responses come from TestClient with the actual main middleware in a temporary
 * TLI_ROOT. No installed server, browser profile, model or device is contacted.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const python = process.env.TLI_TEST_PYTHON || path.join(root, 'backend', '.venv', 'Scripts', 'python.exe');
const capture = spawnSync(python, [path.join(root, 'backend', 'tests', 'installed_app_isolation_fixture.py')],
  {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024});
assert.equal(capture.status, 0, capture.stderr || capture.stdout);
const responses = JSON.parse(capture.stdout);
const appPath = '/apps/isolation-fixture/index.html';
assert.equal(responses[appPath].status, 200, responses[appPath].body);
assert.equal(responses['/hub/apps'].status, 200, responses['/hub/apps'].body);
assert.ok(responses['/apps/isolation-fixture/manifest.json'].status >= 400);
const controller = fs.readFileSync(path.join(root, 'frontend', 'js', 'tli-apps.js'), 'utf8');
const origin = 'http://localhost:8000';
const shell = `<!doctype html><html><body><p id="private-parent">SYNTHETIC PRIVATE PARENT</p>
<main class="main-scroll"><section class="panel-container" id="panel-installed-apps">
<p id="installed-app-status"></p><div id="installed-app-list"></div></section></main>
<script>
window.toastCalls = 0; window.showToast = () => window.toastCalls++;
localStorage.setItem('tli_settings', JSON.stringify({secret:'SYNTHETIC SETTINGS'}));
localStorage.setItem('tli-app-storage:isolation-fixture:note', JSON.stringify('PRESERVED NOTE'));
window.switchPanel = id => {
 for (const panel of document.querySelectorAll('.panel-container')) panel.hidden = panel.id !== id;
 document.dispatchEvent(new CustomEvent('tli-panel-switched', {detail:{panelId:id}}));
};
</script><script src="/js/tli-apps.js"></script></body></html>`;

(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const calls = [], checks = [];
  try {
    const context = await browser.newContext({serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      calls.push({url: request.url(), method: request.method()});
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (url.pathname === '/') return route.fulfill({status:200, contentType:'text/html', body:shell});
      if (url.pathname === '/js/tli-apps.js') return route.fulfill({status:200, contentType:'application/javascript', body:controller});
      const response = responses[url.pathname];
      if (response) {
        const headers = {...response.headers}; delete headers['content-length'];
        return route.fulfill({status:response.status, headers, body:response.body});
      }
      return route.fulfill({status:404, contentType:'text/plain', body:'Synthetic route unavailable'});
    });
    await context.addCookies([{name:'synthetic-cookie', value:'PRIVATE COOKIE', url:origin}]);
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => !!window.TLIApps);
    await page.evaluate(async () => { window.dispatchEvent(new CustomEvent('tli-private-observation-ready')); await TLIApps.reload(); });
    assert.equal(await page.evaluate(() => TLIApps.open('isolation-fixture')), true);
    await page.frameLocator('.tli-app-frame').locator('#add').waitFor();
    const frame = page.frames().find(frame => frame.url() === origin + appPath);
    assert.ok(frame);
    const sandbox = await page.locator('.tli-app-frame').getAttribute('sandbox');
    assert.equal(sandbox, 'allow-scripts');
    await frame.evaluate(() => window.probeDone);
    const probe = await frame.evaluate(() => window.probe);
    assert.equal(probe.ready, true); assert.deepEqual(probe.permissions, []);
    for (const key of ['parent', 'cookie', 'storage']) assert.equal(probe[key].allowed, false, key);
    assert.equal(probe.fetch, 'blocked');
    assert.match(probe.bridge, /unavailable/i); assert.match(probe.bridgeStorage, /unavailable/i);
    await frame.locator('#add').click(); assert.equal(await frame.locator('#count').textContent(), '1');
    assert.equal(await page.evaluate(() => window.toastCalls), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('tli-app-storage:isolation-fixture:note')), '"PRESERVED NOTE"');
    assert.match(await page.evaluate(() => localStorage.getItem('tli_settings')), /SYNTHETIC SETTINGS/);
    checks.push('Local script works; iframe cannot read parent/cookie/storage or use bridge/API/subresources.');
    await page.evaluate(async () => { await TLIApps.reload({afterMutation:true}); });
    assert.equal(frame.isDetached(), true);
    assert.equal(await page.locator('.tli-app-frame').getAttribute('src'), null);
    assert.equal(await page.evaluate(() => TLIApps.open('isolation-fixture')), true);
    await page.frameLocator('.tli-app-frame').locator('#add').waitFor();
    checks.push('App mutation refresh closes old code and restores launchers without automatically reopening code.');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tli-session-locked')));
    assert.equal(await page.locator('.tli-app-frame').count(), 0);
    assert.equal(await page.evaluate(() => TLIApps.open('isolation-fixture')), false);
    checks.push('Lock removes running app frames and prevents reopening.');

    const direct = await context.newPage();
    await direct.goto(origin + appPath);
    await direct.evaluate(() => window.probeDone);
    const directProbe = await direct.evaluate(() => window.probe);
    assert.equal(directProbe.cookie.allowed, false); assert.equal(directProbe.storage.allowed, false);
    assert.equal(directProbe.fetch, 'blocked'); assert.deepEqual(directProbe.permissions, []);
    await direct.locator('#add').click(); assert.equal(await direct.locator('#count').textContent(), '1');
    checks.push('Direct top-level visit also has an opaque origin and blocked API/subresource access.');
    assert.deepEqual(calls.filter(call => /forbidden-|\/mesh\/|\/tools\//.test(call.url)), []);
    assert.deepEqual(calls.filter(call => call.method !== 'GET'), []);
    assert.deepEqual(calls.filter(call => new URL(call.url).origin !== origin), []);
    assert.deepEqual(calls.filter(call => new URL(call.url).pathname === '/tli-bridge.js'), []);
    console.log(JSON.stringify({browser:browser.version(), synthetic:true, checks, interceptedRequests:calls.length,
      limitations:'No live installation, real credential or universal self-navigation/network-sandbox acceptance.'}, null, 2));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
