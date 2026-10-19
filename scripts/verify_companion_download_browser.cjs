/* Public Android download and legacy email-link QA. All network traffic is
 * intercepted; no APK is downloaded, email sent, or live registration used. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const landing = path.join(root, 'landing');
const origin = 'https://thelanintelligence.com';
const out = path.join(root, 'build_work', 'companion-download', new Date().toISOString().replace(/[:.]/g, '-'));
const report = { synthetic_only: true, checks: [], screenshots: [], errors: [], limitations: [
  'Browser checks use production page source with mocked services; deployment and APK installation require separate acceptance.',
] };
const token = 'a1'.repeat(32);
const contentType = file => ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream');
async function check(label, work) { await work(); report.checks.push(label); }

(async () => {
  const { COMPANION_RELEASE: companion } = await import(pathToFileURL(path.join(landing, 'js/companion-release.js')).href);
  const { PUBLIC_RELEASE: desktop } = await import(pathToFileURL(path.join(landing, 'js/release.js')).href);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  async function fixture(width, platform = null) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const calls = [];
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.hash, '');
      if (url.origin === 'https://challenges.cloudflare.com') {
        assert.equal(platform !== null, true, 'Failed configuration must not load an external challenge');
        return route.fulfill({ contentType: 'application/javascript', body:
          'window.turnstile={render:function(selector,options){window.syntheticChallenge=options;return "synthetic-widget";},reset:function(){}};' });
      }
      assert.equal(url.origin, origin, 'No APK, host or external network request is made');
      if (url.pathname.startsWith('/api/')) {
        calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
        if (url.pathname === '/api/download/config') return route.fulfill({ status: platform ? 200 : 503,
          contentType: 'application/json', body: JSON.stringify(platform
            ? { enabled: true, turnstileSiteKey: 'synthetic-key' } : { error: 'unavailable' }) });
        if (url.pathname === '/api/download/verify' && platform) {
          assert.deepEqual(request.postDataJSON(), { token });
          const release = platform === 'android' ? companion : { ...desktop[platform], version: desktop.version };
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'verified', platform, version: release.version, url: release.url }) });
        }
        throw new Error('Unexpected API effect');
      }
      const file = path.resolve(landing, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      assert.ok(file.startsWith(landing + path.sep));
      return route.fulfill({ contentType: contentType(file), body: fs.readFileSync(file), headers: { 'Referrer-Policy': 'no-referrer' } });
    });
    return { context, page, calls };
  }
  try {
    for (const width of [320, 390, 1280]) {
      const f = await fixture(width);
      await f.page.goto(origin + '/download/#android');
      await f.page.locator('#companion-file[href]').waitFor();
      await check(width + ': public APK remains available during registration outage', async () => {
        assert.equal(await f.page.locator('#companion-file').getAttribute('href'), companion.url);
        assert.equal(await f.page.locator('#companion-file').isVisible(), true);
        assert.equal(await f.page.locator('#download-ready').isHidden(), true);
        assert.equal(await f.page.locator('#android-sha256').textContent(), companion.sha256);
        assert.ok((await f.page.locator('#companion-version').textContent()).includes(companion.label));
        assert.equal(f.page.url(), origin + '/download/#android');
        assert.equal(await f.page.locator('#android').evaluate(node => {
          const bounds = node.getBoundingClientRect();
          return bounds.top >= 0 && bounds.top < 160;
        }), true, 'The Android deep link opens its download section immediately');
        assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
        assert.equal(await f.page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      });
      await check(width + ': keyboard access, understandable steps and no horizontal overflow', async () => {
        await f.page.locator('#companion-file').focus();
        assert.equal(await f.page.locator('#companion-file').evaluate(node => node === document.activeElement), true);
        assert.match(await f.page.locator('#android').innerText(), /scan it inside the app/);
        assert.match(await f.page.locator('#android').innerText(), /over your existing app/);
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const button = await f.page.locator('#companion-file').boundingBox();
        assert.ok(button.height >= 44 && button.x >= 0 && button.x + button.width <= width);
      });
      const screenshot = path.join(out, 'android-' + width + '.png');
      await f.page.screenshot({ path: screenshot });
      report.screenshots.push(screenshot);
      if (width === 320) {
        await f.page.evaluate(() => {
          const nodes = [...document.querySelectorAll('#android *')];
          const sizes = nodes.map(node => getComputedStyle(node).fontSize);
          nodes.forEach((node, index) => { node.style.fontSize = (parseFloat(sizes[index]) * 2) + 'px'; });
        });
        await check('320: Android download remains reachable at 200% text size', async () => {
          assert.equal(await f.page.locator('#companion-file').isVisible(), true);
          assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const button = await f.page.locator('#companion-file').boundingBox();
          assert.ok(button.x >= 0 && button.x + button.width <= width);
        });
        await f.page.screenshot({ path: path.join(out, 'android-320-large-text.png') });
      }
      await f.context.close();
    }
    for (const platform of ['windows', 'macos', 'android']) {
      const f = await fixture(390, platform);
      await f.page.goto(origin + '/download/#verify=' + token);
      await f.page.locator('#verify-email:enabled').waitFor();
      await check(platform + ': existing emailed link retains explicit verification', async () => {
        assert.equal(new URL(f.page.url()).hash, '');
        assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
        assert.equal(await f.page.locator('#companion-file').getAttribute('href'), companion.url);
        await f.page.locator('#verify-email').click();
        await f.page.locator('#download-file[href]').waitFor();
        assert.equal(await f.page.locator('#download-file').getAttribute('href'), platform === 'android' ? companion.url : desktop[platform].url);
        assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
        assert.equal(await f.page.locator('#companion-file').getAttribute('href'), companion.url);
      });
      await f.context.close();
    }
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.message; process.exitCode = 1;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output: out, status: report.status, checks: report.checks.length, failure: report.failure }));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
