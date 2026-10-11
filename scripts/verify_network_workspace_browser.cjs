/* Full SPA layout and keyboard checks. All requests use synthetic fixtures. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fingerprint = require('./anniversary_ui_source_hash.cjs');
const hashesAtStart = fingerprint();
if (!process.argv.includes('--label')) process.argv.push('--label', 'network-ui');
const { makePage, layout, fixtures, out } = require('./verify_anniversary_ui_browser.cjs');
fixtures['/hub/status'] = { enabled: false, installed: [] };
fixtures['/hub/sample'] = { packages: [{ id: 'fixture-theme', name: 'Studio palette', author: 'Synthetic fixture', version: '1.0', type: 'theme', description: 'An example package for reviewing the layout.', preview_css: ':root { --bg: #102320; --accent: #30b891; }', tags: ['theme'], installed: false }] };
fixtures['/hub/local-registry'] = { packages: [] };
fixtures['/actions/capabilities'] = { devices: [] };
fixtures['/tools/list'] = { tools: [{ id: 'sys_snapshot', label: 'System snapshot' }, { id: 'sys_top_processes', label: 'Top processes' }, { id: 'net_connectivity_diag', label: 'Connectivity check' }] };
const checks = [], errors = [];
async function checkLayout(page, id, width, theme, variant = '') {
  const result = await layout(page, id);
  checks.push({ width, theme, panel: id, variant, ...result });
  assert.deepEqual(result.overflow, [], `${id} ${variant} overflows at ${width}: ${JSON.stringify(result.overflow)}`);
  assert.ok(result.documentWidth <= width + 2, `${id} document overflows at ${width}`);
  assert.deepEqual(result.duplicateIds, [], 'DOM IDs must stay unique');
}
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [1440, 1024, 390, 320]) for (const theme of ['emeraldLight', 'midnight']) {
      const run = await makePage(browser, width, theme), page = run.page;
      assert.equal(await page.locator('link[href*="ui-foundation.css"]').count(), 1);
      for (const panel of ['panel-mesh', 'panel-automations', 'panel-tools', 'panel-games', 'panel-hub', 'panel-homeauto', 'panel-tli-chat', 'panel-scripts']) {
        await page.evaluate(id => switchPanel(id), panel);
        await page.waitForTimeout(100);
        await checkLayout(page, panel, width, theme);
        if (panel === 'panel-hub') {
          await page.screenshot({ path: path.join(out, `hub-${width}-${theme}.png`), fullPage: true });
          const tabs = page.locator('#hub-tabs button');
          for (let i = 0; i < await tabs.count(); i++) {
            await tabs.nth(i).focus();
            assert.equal(await tabs.nth(i).evaluate(el => document.activeElement === el), true);
            await page.keyboard.press('Enter');
            await checkLayout(page, panel, width, theme, `tab ${i}`);
          }
          assert.equal(await page.locator('#hub-publish-form').isVisible(), true);
          assert.equal(await page.locator('#hub-grid').isVisible(), false);
          await page.screenshot({ path: path.join(out, `hub-publish-${width}-${theme}.png`), fullPage: true });
        }
        if (panel === 'panel-homeauto') {
          await page.locator('#smart-device-open').click();
          assert.equal(await page.locator('#smart-device-dialog').evaluate(el => el.open), true);
          assert.equal(await page.evaluate(() => document.activeElement.id), 'shelly-ip-input');
          await page.locator('#shelly-ip-input').fill('192.0.2.20');
          await page.locator('#shelly-relay-input').fill('2');
          await checkLayout(page, 'smart-device-dialog', width, theme, 'dialog open');
          await page.screenshot({ path: path.join(out, `smart-device-dialog-${width}-${theme}.png`) });
          const last = page.locator('#smart-device-dialog button:visible').last();
          await last.focus(); await page.keyboard.press('Tab');
          const focusState = await page.evaluate(() => ({ inside: !!document.activeElement.closest('#smart-device-dialog'), active: document.activeElement.outerHTML.slice(0,180), buttons: [...document.querySelectorAll('#smart-device-dialog button')].map(el => ({ text: el.textContent, hidden: el.hidden, display: getComputedStyle(el).display })) }));
          assert.equal(focusState.inside, true, 'Dialog must retain keyboard focus: ' + JSON.stringify(focusState));
          await page.keyboard.press('Shift+Tab');
          assert.equal(await page.evaluate(() => document.activeElement.id), 'shelly-add-device-btn');
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#smart-device-dialog').evaluate(el => el.open), false);
          assert.equal(await page.evaluate(() => document.activeElement.id), 'smart-device-open');
          await page.locator('#smart-device-open').click();
          assert.equal(await page.locator('#shelly-ip-input').inputValue(), '192.0.2.20');
          assert.equal(await page.locator('#shelly-relay-input').inputValue(), '2');
          await page.keyboard.press('Escape');
        }
        if (panel === 'panel-tools') {
          await page.locator('#tools-select').selectOption('sys_top_processes');
          await page.locator('#tools-process-limit').fill('12');
          await page.locator('#tools-advanced-arguments > summary').click();
          await checkLayout(page, panel, width, theme, 'guided and advanced fields');
        }
        if (panel === 'panel-tli-chat') {
          await page.locator('#network-federation > summary').click();
          await checkLayout(page, panel, width, theme, 'cross-network disclosure');
        }
      }
      errors.push(...run.errors.map(error => ({ width, theme, error })));
      assert.equal(run.calls.filter(call => !['GET', 'HEAD'].includes(call.method)).length, 0, 'UI navigation must not submit operations');
      fs.writeFileSync(path.join(out, `requests-${width}-${theme}.json`), JSON.stringify({ calls: run.calls, errors: run.errors, unknown: [...new Set(run.unknown)] }, null, 2));
      await run.context.close();
    }
    assert.deepEqual(errors, [], 'Full-source app must not throw browser errors');
  } finally { await browser.close(); }
  const hashesAtEnd = fingerprint(), sourceUnchanged = JSON.stringify(hashesAtStart) === JSON.stringify(hashesAtEnd);
  fs.writeFileSync(path.join(out, 'network-report.json'), JSON.stringify({ synthetic: true, checks, errors, hashesAtStart, hashesAtEnd, sourceUnchanged }, null, 2));
  assert.equal(sourceUnchanged, true, 'Production source changed during verification');
  console.log(JSON.stringify({ output: out, checks: checks.length, errors: errors.length }));
}
main().catch(error => { fs.writeFileSync(path.join(out, 'network-error.txt'), error.stack); console.error(error); process.exitCode = 1; });
