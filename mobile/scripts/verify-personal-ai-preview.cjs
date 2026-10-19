/* Actual compiled mobile screens; all data is synthetic and requests stay local. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const exported = path.resolve(process.argv[2] || ''), output = path.resolve(process.argv[3] || '');
assert(process.argv[2] && process.argv[3] && fs.existsSync(path.join(exported, 'index.html')));
fs.mkdirSync(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = path.resolve(exported, '.' + pathname);
  if (!file.startsWith(exported + path.sep) && file !== exported) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(exported, 'index.html');
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const report = { synthetic: true, checks: [], screenshots: [], errors: [], blocked: [], limitations: ['No physical Android, native keyboard, pairing or live model is exercised.'] };
let browser;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (report.blocked.push(route.request().url()), route.abort()));
    await page.addInitScript(() => { globalThis.__TLI_PREVIEW_VERIFY__ = true; });
    await page.goto(origin + '/ask');
    const composer = page.getByLabel('Message to TLI', { exact: true });
    await composer.waitFor();
    assert.equal(await page.getByRole('tab').count(), 3);
    await page.getByRole('button', { name: 'Add photo', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add document', exact: true }).waitFor();
    await composer.fill('Keep this idea while I look through my library.');
    await page.screenshot({ path: path.join(output, `chat-${width}.png`) });
    await page.getByRole('tab', { name: /Library$/ }).click();
    await page.getByLabel('Search conversations', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Continue conversation', exact: true }).first().waitFor();
    assert(await page.evaluate(() => globalThis.__TLI_PREVIEW_REQUESTS__.some(r => r.method === 'GET' && r.path.startsWith('/api/intelligence/conversation-search?'))));
    await page.screenshot({ path: path.join(output, `library-${width}.png`) });
    await page.getByRole('button', { name: 'Open Notes & fixes', exact: true }).click();
    await page.waitForURL('**/notebook');
    await page.goBack();
    await page.getByRole('tab', { name: /Chat$/ }).click();
    assert.equal(await composer.inputValue(), 'Keep this idea while I look through my library.');
    await page.getByRole('tab', { name: /More$/ }).click();
    await page.getByRole('button', { name: 'Build a small app', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Home and devices', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `more-${width}.png`) });
    await page.getByRole('button', { name: 'Connection and settings', exact: true }).last().click();
    await page.getByRole('button', { name: 'Get Android update', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => globalThis.__TLI_PREVIEW_REQUESTS__.filter(r => r.method !== 'GET').length), 0, 'Browsing and returning to a draft must not mutate or submit');
    report.checks.push(`${width}px: three tabs, direct attachments, recent Library, Notes route, draft preservation, utilities and public update action`);
    report.screenshots.push(`chat-${width}.png`, `library-${width}.png`, `more-${width}.png`);
    await page.close();
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []);
  report.status = 'passed';
})().catch(error => { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); await browser?.close(); await new Promise(resolve => server.close(resolve));
});
