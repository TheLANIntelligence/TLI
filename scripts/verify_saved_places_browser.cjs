/* Routed fixtures only: no live backend, real paths or inference. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'build_work', 'saved-places-qa-'));
const read = file => fs.readFileSync(path.join(root, 'frontend', file), 'utf8');
const initial = [{ id: 'a'.repeat(32), name: 'Studio recordings', kind: 'folder', target: 'N:\\Music\\Recordings', revision: 'b'.repeat(64) }, { id: 'c'.repeat(32), name: 'Printer setup', kind: 'note', target: 'f-note', revision: 'd'.repeat(64) }, { id: 'e'.repeat(32), name: 'Free Space', kind: 'panel', target: 'panel-visualizer', revision: 'f'.repeat(64) }];
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); const results = [];
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport }), errors = [], calls = [];
      let rows = structuredClone(initial), available = false;
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), method = route.request().method();
        if (url.origin !== 'http://tli-places.test') return route.abort();
        const allowed = { '/style.css': 'style.css', '/saved-places.css': 'saved-places.css', '/js/saved-places.js': 'js/saved-places.js' };
        if (allowed[url.pathname]) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(allowed[url.pathname]) });
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/saved-places.css"></head><body><main style="padding:16px;max-width:1100px;margin:auto"><section id="panel-dashboard2"><div class="nd-wrap"><h1>Home</h1></div></section><section id="panel-files"><label for="filesRootInput">Files path</label><input id="filesRootInput"></section><section id="panel-visualizer"></section></main><script>window.opened=[];window.scans=[];window.switchPanel=id=>opened.push(id);window.TLIVisualizer={scanPath:path=>scans.push(path)};window.TLINotebook={open:ref=>{window.note=ref;}};</script><script src="/js/saved-places.js"></script></body></html>` });
        if (url.pathname.startsWith('/api/intelligence/places')) {
          calls.push({ path: url.pathname, method }); let response;
          if (url.pathname.endsWith('/check')) response = { ok: true, status: available ? 'available' : 'unavailable', detail: available ? 'The location was reachable at this check.' : 'Drive disconnected. The favorite is retained.', revision: rows[0].revision, checked_at: '2026-09-07T15:00:00Z' };
          else if (method === 'POST') { const body = route.request().postDataJSON(); const place = { ...body, id: '9'.repeat(32), revision: '8'.repeat(64) }; rows.push(place); response = { ok: true, created: true, place, message: 'Favorite saved. Its target was not opened or scanned.' }; }
          else response = { ok: true, protocol: 'saved-places-v1', places: rows };
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
        }
        return route.fulfill({ status: 404, body: 'Fixture endpoint missing' });
      });
      await page.goto('http://tli-places.test/'); assert.equal(calls.length, 0);
      await page.getByRole('button', { name: 'Open saved places', exact: true }).click();
      await page.getByRole('heading', { name: 'Studio recordings', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Scan in Free Space', exact: true }).click();
      await page.locator('#places-status').filter({ hasText: 'disconnected' }).waitFor();
      assert.deepEqual(await page.evaluate(() => scans), []);
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth, dialog: document.querySelector('#places-dialog').scrollWidth > document.querySelector('#places-dialog').clientWidth + 1 }));
      assert.equal(overflow.dialog, false); assert.equal(overflow.page, false);
      await page.screenshot({ path: path.join(output, viewport.width + '-dark.png'), fullPage: true, animations: 'disabled' });
      await page.getByRole('button', { name: 'Add favorite', exact: true }).click();
      await page.locator('#places-name').fill('Downloads'); await page.locator('#places-path').fill('C:\\Users\\Fixture\\Downloads');
      await page.locator('#places-save').click(); await page.locator('#places-status').filter({ hasText: 'Favorite saved' }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Downloads', exact: true }).count(), 1);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'emeraldLight'));
      await page.screenshot({ path: path.join(output, viewport.width + '-light.png'), fullPage: true, animations: 'disabled' });
      available = true; await page.getByRole('button', { name: 'Open in Files', exact: true }).first().click();
      await page.locator('#places-dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#filesRootInput').inputValue(), initial[0].target); assert.deepEqual(await page.evaluate(() => scans), []);
      await page.getByRole('button', { name: 'Open saved places', exact: true }).click(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#places-dialog').isVisible(), false); assert.deepEqual(errors, []);
      results.push({ viewport, status: 'passed', checks: ['explicit load', 'inert add', 'unavailable drive retained', 'no unintended scan', 'Open in Files', 'Escape', 'light/dark layout'], overflow }); await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ fixture: 'synthetic routes only', results }, null, 2)); console.log(JSON.stringify({ output, results }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
