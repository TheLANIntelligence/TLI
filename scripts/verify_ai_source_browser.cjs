/* Header and Chat share observed provider state; every response is synthetic. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fingerprint = require('./anniversary_ui_source_hash.cjs');
if (!process.argv.includes('--label')) process.argv.push('--label', 'ai-source');
const { makePage, fixtures, out } = require('./verify_anniversary_ui_browser.cjs');
async function main() {
  const before = fingerprint(), report = { synthetic: true, cases: [], hashesAtStart: before, errors: [], limitations: ['Browser checks use intercepted fake providers. No live inference, model switch or physical-phone test.'] };
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const state of ['healthy', 'unknown']) {
      if (state === 'unknown') for (const key of ['/api/ai/model/info', '/api/ai/status', '/api/ai/bundled/status', '/api/ai/mesh/status']) fixtures[key] = {};
      const run = await makePage(browser, 1440, 'emeraldLight');
      await run.page.evaluate(async () => { switchPanel('panel-main'); await window.TLIAISource.refresh(); });
      const expected = state === 'healthy' ? 'AI: Integrated · Ready' : 'AI: Not confirmed';
      await run.page.waitForFunction(expected => document.getElementById('ai-source-badge').textContent === expected, expected);
      const result = await run.page.evaluate(() => ({ header: document.getElementById('ai-source-text').textContent, chat: document.getElementById('ai-source-badge').textContent,
        bannerVisible: !document.getElementById('tli-no-ai-banner').hidden && getComputedStyle(document.getElementById('tli-no-ai-banner')).display !== 'none',
        source: window.TLIAISource.getSnapshot() }));
      assert.equal(result.header, state === 'healthy' ? 'AI: Integrated' : 'AI: Not confirmed');
      assert.equal(result.bannerVisible, false, 'Unconfirmed model presence must not show a missing-model banner');
      await run.page.screenshot({ path: path.join(out, `ai-${state}-1440.png`), fullPage: true });
      report.cases.push({ state, ...result }); report.errors.push(...run.errors);
      assert.deepEqual(run.errors, []);
      assert.deepEqual(run.calls.filter(call => !['GET', 'HEAD'].includes(call.method)), []);
      await run.context.close();
    }
  } finally { await browser.close(); }
  report.hashesAtEnd = fingerprint(); report.sourceUnchanged = JSON.stringify(report.hashesAtStart) === JSON.stringify(report.hashesAtEnd);
  fs.writeFileSync(path.join(out, 'ai-source-report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.sourceUnchanged, true, 'Production source changed during verification');
  console.log(JSON.stringify({ out, cases: report.cases.length, errors: report.errors.length, sourceUnchanged: report.sourceUnchanged }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
