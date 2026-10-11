/* Static synthetic answer evidence only; no application server or inference. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'build_work', 'anniversary-continuity', 'answer-validation-browser');
const files = ['frontend/answer-validation.html', 'frontend/assets/answer-validation.json'];
const fingerprint = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const start = fingerprint();
const evidence = JSON.parse(fs.readFileSync(path.join(root, files[1]), 'utf8'));
const dimensions = ['factual_grounding', 'useful_next_steps', 'context_handling', 'truthful_action_claims'];
const report = { synthetic: true, hashesAtStart: start, checks: [], errors: [], requests: [], screenshots: [],
  limitations: ['Static local page with intercepted requests. No live TLI, model or household data.', 'Browser keyboard/layout checks do not constitute physical-phone or screen-reader acceptance.'], physical_user_acceptance: 'not_run' };
fs.mkdirSync(out, { recursive: true });

async function main() {
  assert.equal(evidence.quality_acceptance, 'not_passed');
  assert.equal(evidence.physical_user_acceptance, 'not_run');
  assert.equal(evidence.cases.length, 23);
  assert.equal(evidence.agent_review.quality_gate, 'failed');
  assert.equal(evidence.agent_review.acceptance.answers_sha256, evidence.response_report_sha256);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [1440, 1024, 390, 320]) for (const tone of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: tone, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        report.requests.push({ width, tone, method: request.method(), path: url.pathname });
        if (url.hostname !== 'tli-ui.test' || request.method() !== 'GET') return route.abort('blockedbyclient');
        const file = url.pathname === '/answer-validation.html' ? files[0] : url.pathname === '/assets/answer-validation.json' ? files[1] : null;
        if (!file) return route.fulfill({ status: 404, body: 'Synthetic page only.' });
        return route.fulfill({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : 'application/json', body: fs.readFileSync(path.join(root, file)) });
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push({ width, tone, message: error.message }));
      await page.goto('https://tli-ui.test/answer-validation.html', { waitUntil: 'load' });
      assert.match(await page.locator('.notice').innerText(), /quality has not fully passed acceptance/i);
      assert.match(await page.locator('.notice').innerText(), /Physical user acceptance has not been run/i);
      assert.match(await page.locator('main').innerText(), /not a measured overall accuracy percentage/i);
      assert.equal(await page.locator('tbody details').count(), 23);
      const actual = await page.locator('tbody tr').evaluateAll(rows => rows.filter((row, index) => index % 2 === 0).map(row => [...row.children].map(cell => cell.textContent.trim())));
      assert.deepEqual(actual, evidence.cases.map(row => [row.id, ...dimensions.map(key => String(row.agent_assessment[key]))]));
      assert.deepEqual(await page.locator('blockquote').allTextContents(), evidence.cases.map(row => row.answer));

      const first = page.locator('details').first();
      await first.locator('summary').focus();
      assert.equal(await first.locator('summary').evaluate(el => document.activeElement === el), true);
      assert.notEqual(await first.locator('summary').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      await page.keyboard.press('Enter');
      assert.equal(await first.evaluate(el => el.open), true);
      await page.keyboard.press('Space');
      assert.equal(await first.evaluate(el => el.open), false);
      // Open evidence before measuring so long prose and literal paths are included.
      await page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));
      const measured = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth, bodyColor: getComputedStyle(document.body).color,
        overflow: [...document.querySelectorAll('a, summary, blockquote, main > p, .notice')].filter(el => {
          const box = el.getBoundingClientRect(); return box.left < -2 || box.right > document.documentElement.clientWidth + 2;
        }).map(el => ({ tag: el.tagName, text: el.textContent.slice(0, 60) })) }));
      assert.ok(measured.documentWidth <= width + 2, `Page overflow at ${width}/${tone}`);
      assert.deepEqual(measured.overflow, []);
      await page.locator('details').evaluateAll(items => items.forEach(item => { item.open = false; }));
      await page.evaluate(() => scrollTo(0, 0));
      if (width === 1440 || width === 390) {
        const filename = `answer-validation-${width}-${tone}.png`;
        await page.screenshot({ path: path.join(out, filename), fullPage: true });
        report.screenshots.push(filename);
      }
      report.checks.push({ width, tone, scoresMatched: true, answersMatched: true, failedQualityVisible: true, keyboardDisclosure: true, ...measured });
      await context.close();
    }
  } finally {
    await browser.close();
    report.hashesAtEnd = fingerprint();
    report.sourceUnchanged = JSON.stringify(start) === JSON.stringify(report.hashesAtEnd);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  assert.deepEqual(report.errors, []);
  assert.equal(report.sourceUnchanged, true);
  assert.ok(report.requests.every(row => row.method === 'GET' && row.path === '/answer-validation.html'));
  console.log(JSON.stringify({ output: out, layouts: report.checks.length, errors: report.errors.length, sourceUnchanged: report.sourceUnchanged }));
}
main().catch(error => { fs.writeFileSync(path.join(out, 'error.txt'), error.stack); console.error(error); process.exitCode = 1; });
