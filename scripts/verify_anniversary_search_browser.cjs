/* Real SPA interaction checks against intercepted synthetic data only. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makePage, fixtures, layout } = require('./verify_anniversary_ui_browser.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'build_work', 'anniversary-ui', 'search-browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const now = new Date().toISOString();
const note = { id: 'fixture-router-note', revision: 'a'.repeat(64), title: 'Router troubleshooting', text: 'Private synthetic note body for router troubleshooting.', source: 'user', category: 'general', created_at: now, updated_at: now, device_id: null };
const place = { id: 'b'.repeat(32), revision: 'c'.repeat(64), name: 'Router documents', kind: 'folder', target: 'C:\\Synthetic\\Router', created_at: now, updated_at: now };
fixtures['/api/intelligence/memory'] = { facts: [note] };
fixtures['/api/intelligence/places'] = { ok: true, protocol: 'saved-places-v1', places: [place] };
fixtures['/api/ai/conversations/fixture-router-chat'] = { id: 'fixture-router-chat', title: 'Router conversation', messages: [{ role: 'user', content: 'Where are my router notes?' }, { role: 'assistant', content: 'This is a retained synthetic conversation.' }] };
fixtures['/api/ai/storage/location'] = { ok: true, path: 'C:\\Synthetic\\Models', free_gb: 120 };
fixtures['/api/ai/model/progress'] = { ok: true, status: 'idle', in_progress: false };
const reports = [];
const sourceFiles = ['frontend/js/cmd-palette.js', 'frontend/js/notebook.js', 'frontend/js/saved-places.js', 'frontend/js/ai-model-manager.js', 'frontend/js/system-state-bar.js', 'frontend/js/ui-foundation.js', 'frontend/ui-foundation.css', 'frontend/app.js', 'frontend/index.html', 'scripts/verify_anniversary_search_browser.cjs', 'scripts/verify_anniversary_ui_browser.cjs'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const startingHashes = sourceHashes();
const json = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
const searchReply = (query, title = 'Router conversation') => ({ ok: true, protocol: 'conversation-search-v1', query, items: [{ id: 'fixture-router-chat', title, last_updated: now, message_count: 2 }], next_cursor: null, coverage: { complete: true, more_to_search: false, text_limited: false } });

async function create(browser, width = 1440, theme = 'emeraldLight') {
  const run = await makePage(browser, width, theme);
  run.page.setDefaultTimeout(8000);
  await run.page.route(url => url.hostname === 'tli-ui.test' && url.pathname === '/api/intelligence/conversation-search', route => {
    const request = route.request(), query = new URL(request.url()).searchParams.get('q');
    run.calls.push({ method: request.method(), path: '/api/intelligence/conversation-search', query });
    return route.fulfill(json(searchReply(query)));
  });
  return run;
}
async function search(page, query = 'router') {
  await page.keyboard.press('Control+k');
  await page.locator('#tli-cmd-input').fill(query);
  await page.waitForFunction(() => /saved results|No matching/.test(document.getElementById('tli-cmd-saved-status').textContent));
}
const noOperations = (calls, start) => {
  const made = calls.slice(start);
  assert.deepEqual(made.filter(c => !['GET', 'HEAD'].includes(c.method)), [], 'Opening/searching must not issue mutations');
  assert.ok(made.every(c => !/\/(?:generate|completion|completions|stream|run|check|scan)(?:\/|$)/.test(c.path)), 'No inference, target checks or scans');
};
async function trap(page, selector) {
  const ends = await page.locator(selector).evaluate(root => {
    const controls = [...root.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
    const first = controls[0], last = controls.at(-1); assertFocusable(first); assertFocusable(last);
    function assertFocusable(n) { if (!n) throw new Error('No focusable controls'); }
    last.focus(); return { first: first.id || null, last: last.id || null };
  });
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(selector).evaluate(root => root.contains(document.activeElement)), true, 'Tab stays inside overlay');
  if (ends.first) assert.equal(await page.evaluate(() => document.activeElement.id), ends.first, 'Tab wraps to first control');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator(selector).evaluate(root => root.contains(document.activeElement)), true, 'Shift+Tab stays inside overlay');
  if (ends.last) assert.equal(await page.evaluate(() => document.activeElement.id), ends.last, 'Shift+Tab wraps to last control');
}
async function check(browser, name, width, fn, theme = 'emeraldLight') {
  const run = await create(browser, width, theme), beforeErrors = run.errors.length;
  const result = { name, width, theme, status: 'passed' };
  try {
    await fn(run);
    assert.equal(run.errors.length, beforeErrors, 'No new uncaught browser errors during this flow');
  } catch (error) { result.status = 'failed'; result.error = error.stack; }
  result.layout = await layout(run.page, 'panel-main');
  if (result.status === 'failed') result.ui = await run.page.evaluate(() => ({ focus: document.activeElement?.outerHTML, dialogs: [...document.querySelectorAll('dialog[open]')].map(e => ({ id:e.id, box:e.getBoundingClientRect().toJSON(), visibility:getComputedStyle(e).visibility, display:getComputedStyle(e).display })), body: document.body.className, hit: document.elementsFromPoint(300,220).map(e => e.tagName + '#' + e.id) }));
  result.errors = run.errors; result.unknown = [...new Set(run.unknown)]; result.calls = run.calls;
  await run.page.screenshot({ path: path.join(out, name + '-' + width + '.png') });
  reports.push(result); await run.context.close();
  console.log(`${result.status}: ${name} (${width})${result.error ? '\n' + result.error : ''}`);
  fs.writeFileSync(path.join(out, 'checks-in-progress.json'), JSON.stringify(reports, null, 2));
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await check(browser, 'typed-search-and-resume', 1440, async ({ page, calls }) => {
      await page.evaluate(() => switchPanel('panel-main')); await page.locator('#chat-input').fill('Preserve this draft');
      const start = calls.length;
      await page.keyboard.press('Control+k'); await page.locator('#tli-cmd-input').fill('r'); await page.waitForTimeout(350);
      assert.equal(calls.slice(start).filter(c => ['/api/intelligence/memory', '/api/intelligence/conversation-search', '/api/intelligence/places'].includes(c.path)).length, 0);
      await page.locator('#tli-cmd-input').fill('router');
      await page.waitForFunction(() => document.getElementById('tli-cmd-saved-status').textContent.startsWith('3 saved results'));
      assert.equal(await page.locator('#tli-cmd-results [role="option"]').count(), 3);
      assert.doesNotMatch(await page.locator('#tli-cmd-results').innerText(), /Private synthetic note body/);
      noOperations(calls, start);
      await page.locator('#tli-cmd-results [role="option"]').filter({ hasText: 'Router troubleshooting' }).click();
      await page.waitForFunction(() => document.getElementById('notebook-dialog').open && /Opened the current saved note from search/.test(document.getElementById('notebook-dialog').textContent));
      assert.equal(await page.locator('#tli-cmd-overlay').isVisible(), false);
      assert.deepEqual(await page.evaluate(() => window.TLINotebook.describeContext()), []);
      assert.equal(await page.locator('#chat-input').inputValue(), 'Preserve this draft');
      await page.screenshot({ path: path.join(out, 'saved-note-from-search-1440.png') });
      await page.keyboard.press('Escape');
      await search(page); await page.locator('#tli-cmd-results [role="option"]').filter({ hasText: 'Router documents' }).click();
      await page.waitForFunction(() => /Favorite selected from search/.test(document.getElementById('places-status').textContent));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'places-entry-' + place.id);
      assert.equal(await page.locator('#places-editor').isVisible(), false);
      noOperations(calls, start); await page.screenshot({ path: path.join(out, 'favorite-from-search-1440.png') }); await page.keyboard.press('Escape');
      await search(page); await page.locator('#tli-cmd-results [role="option"]').filter({ hasText: 'Router conversation' }).click();
      await page.waitForFunction(() => window.currentConversationId === 'fixture-router-chat');
      assert.match(await page.locator('#chat-output').innerText(), /retained synthetic conversation/);
      assert.equal(await page.locator('#chat-input').inputValue(), 'Preserve this draft');
      noOperations(calls, start);
    });

    for (const reason of ['query-change', 'close', 'lock']) {
      await check(browser, 'late-search-' + reason, 1440, async ({ page, calls }) => {
        let release, reads = 0;
        const waiting = new Promise(resolve => { release = resolve; });
        await page.route('http://tli-ui.test/api/intelligence/memory', async route => {
          calls.push({ method: route.request().method(), path: '/api/intelligence/memory' }); reads++;
          const first = reads === 1; if (first) await waiting;
          try { await route.fulfill(json({ facts: [{ ...note, title: first ? 'Router obsolete private result' : 'Studio current note', text: first ? 'router' : 'studio' }] })); } catch (_) { /* cancelled requests are expected */ }
        });
        const start = calls.length; await page.keyboard.press('Control+k'); await page.locator('#tli-cmd-input').fill('router');
        await page.waitForTimeout(400); assert.equal(reads, 1);
        if (reason === 'query-change') {
          await page.locator('#tli-cmd-input').fill('studio');
          await page.waitForFunction(() => document.getElementById('tli-cmd-results').textContent.includes('Studio current note'));
        } else if (reason === 'close') await page.keyboard.press('Escape');
        else await page.evaluate(() => window.dispatchEvent(new CustomEvent('tli-session-locked')));
        release(); await page.waitForTimeout(150);
        assert.doesNotMatch(await page.locator('#tli-cmd-results').textContent(), /obsolete private/);
        if (reason !== 'query-change') {
          assert.equal(await page.locator('#tli-cmd-overlay').isVisible(), false);
          assert.equal(await page.locator('#tli-cmd-results').textContent(), '');
          assert.equal(await page.locator('#tli-cmd-saved-status').textContent(), '');
        }
        noOperations(calls, start);
      });
    }

    await check(browser, 'model-library-keyboard', 1440, async ({ page, calls }) => {
      await page.evaluate(() => switchPanel('panel-settings'));
      await page.getByRole('button', { name: 'AI & chat', exact: true }).click();
      const opener = page.getByRole('button', { name: 'Open model library', exact: true });
      const start = calls.length; await opener.click();
      await page.waitForFunction(() => document.querySelector('#mm2-tiers .mm2-technical'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'model-manager-x');
      const details = page.locator('#mm2-tiers .mm2-technical').first();
      assert.equal(await details.evaluate(e => e.open), false);
      await details.locator('summary').focus(); await page.keyboard.press('Enter');
      assert.equal(await details.evaluate(e => e.open), true);
      await trap(page, '#model-manager-modal-overlay');
      await page.screenshot({ path: path.join(out, 'model-library-open-1440.png') });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#model-manager-modal-overlay').isVisible(), false);
      assert.equal(await opener.evaluate(e => e === document.activeElement), true);
      noOperations(calls, start);
    });

    for (const width of [390, 320]) await check(browser, 'mobile-more-and-search', width, async ({ page, calls }) => {
      const more = page.locator('#tli-bn-more-btn'); await more.click();
      await page.waitForFunction(() => document.getElementById('tli-more-drawer').contains(document.activeElement));
      await trap(page, '#tli-more-drawer'); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#tli-more-drawer').isVisible(), false);
      assert.equal(await more.evaluate(e => e === document.activeElement), true);
      const start = calls.length; await search(page);
      const measured = await page.locator('#tli-cmd-overlay').evaluate(e => {
        const panel = e.querySelector('.tli-cmd-palette').getBoundingClientRect();
        return { left: panel.left, right: panel.right, viewport: innerWidth };
      });
      assert.ok(measured.left >= -1 && measured.right <= measured.viewport + 1, 'Search fits phone width');
      await trap(page, '#tli-cmd-overlay'); noOperations(calls, start);
    }, width === 320 ? 'midnight' : 'emeraldLight');
  } finally { await browser.close(); }
  const hashes = sourceHashes(), changedSources = sourceFiles.filter(file => hashes[file] !== startingHashes[file]);
  const report = { synthetic: true, source: root, createdAt: new Date().toISOString(), startingHashes, hashes, changedSources, checks: reports, passed: reports.filter(r => r.status === 'passed').length, failed: reports.filter(r => r.status === 'failed').length };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, passed: report.passed, failed: report.failed, changedSources }));
  if (report.failed || changedSources.length) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(out, 'error.txt'), error.stack); console.error(error); process.exitCode = 1; });
