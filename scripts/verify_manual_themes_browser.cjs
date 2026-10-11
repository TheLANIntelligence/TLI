/* Standalone manual against intercepted local assets and synthetic browser settings. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { contrast } = require('./verify_anniversary_themes_browser.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build_work/theme-refresh/manual-contrast-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });
const sources = ['frontend/manual.html', 'frontend/themes.css', 'frontend/help-workspace.css', 'frontend/js/theme-catalog.js', 'frontend/js/help-workspace.js', 'scripts/verify_manual_themes_browser.cjs', 'scripts/verify_anniversary_themes_browser.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { synthetic: true, liveBackendUsed: false, initialHashes: hashes(), results: [], requests: [], errors: [], limitations: ['Computed solid-background contrast; no physical screen-reader acceptance.', 'Pseudo-element numbers are checked through their actual computed foreground, background and font style.'] };

async function measuredDetails(page) {
  return page.evaluate(() => {
    const parse = color => {
      const values = color.match(/-?[\d.]+/g)?.map(Number);
      if (!values || values.length < 3) return null;
      if (color.startsWith('color(srgb-linear')) for (let i = 0; i < 3; i++) values[i] = 255 * (values[i] <= .0031308 ? values[i] * 12.92 : 1.055 * values[i] ** (1 / 2.4) - .055);
      else if (color.startsWith('color(srgb')) for (let i = 0; i < 3; i++) values[i] *= 255;
      return [values[0], values[1], values[2], values.length > 3 ? values[3] : 1];
    };
    const blend = (top, bottom) => top.slice(0, 3).map((c, i) => c * top[3] + bottom[i] * (1 - top[3])).concat(1);
    const lum = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const values = [];
    for (const el of document.querySelectorAll('.badge, .qs-steps li, .step-list li')) {
      const pseudo = el.matches('.qs-steps li, .step-list li') ? '::before' : null;
      const style = getComputedStyle(el, pseudo), layers = [], reasons = [];
      if (pseudo) layers.push(parse(style.backgroundColor));
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
        const computed = getComputedStyle(ancestor);
        const bg = parse(computed.backgroundColor);
        if (computed.backgroundImage !== 'none') reasons.push('background image');
        if (Number(computed.opacity) < 1) reasons.push('opacity');
        if (computed.filter !== 'none') reasons.push('filter');
        if (bg) layers.push(bg);
        if (bg?.[3] === 1) break;
      }
      const background = layers.filter(Boolean).reverse().reduce((base, layer) => blend(layer, base), [255, 255, 255, 1]);
      const foreground = blend(parse(style.color), background), a = lum(foreground), b = lum(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const size = parseFloat(style.fontSize), required = size >= 24 || (size >= 18.6667 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
      values.push({ selector: el.matches('.badge') ? '.' + el.className.trim().replaceAll(' ', '.') : (el.closest('.qs-steps') ? '.qs-steps li::before' : '.step-list li::before'), text: pseudo ? style.content : el.textContent.trim(), foreground: style.color, background: background.slice(0, 3).map(Math.round), fontSize: size, fontWeight: style.fontWeight, ratio: Number(ratio.toFixed(3)), required, passed: ratio + .01 >= required, review: reasons });
    }
    return values;
  });
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('tli_settings', JSON.stringify({ defaultTheme: 'emeraldLight', syntheticManualCheck: true })));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      report.requests.push({ method: request.method(), path: url.pathname, host: url.hostname });
      if (url.hostname !== 'tli-manual.test' || !['GET', 'HEAD'].includes(request.method())) return route.abort('blockedbyclient');
      const file = path.resolve(root, 'frontend', '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(path.join(root, 'frontend') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort('blockedbyclient');
      const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
      return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto('http://tli-manual.test/manual.html', { waitUntil: 'load' });
    await page.evaluate(() => {
      document.body.id = 'manual-audit';
      window.__manualStorage = localStorage.getItem('tli_settings');
      window.__manualWrites = [];
      for (const method of ['setItem', 'removeItem', 'clear']) Storage.prototype[method] = function (key) { window.__manualWrites.push({ method, key }); };
      window.__themeAuditVisible = el => {
        if (el.closest('[hidden],.hidden,[aria-hidden="true"]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
        for (let node = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) === 0) return false;
        return true;
      };
    });
    const themes = await page.evaluate(() => TLIThemes.themes.map(theme => ({ id: theme.id, tone: theme.tone })));
    assert.equal(themes.length, 22);
    for (const theme of themes) {
      await page.evaluate(id => TLIThemes.apply(id), theme.id);
      const text = await contrast(page, 'manual-audit');
      const details = await measuredDetails(page);
      report.results.push({ theme: theme.id, ...text, details });
      if (['emeraldLight', 'midnight', 'roseQuartz', 'pacific'].includes(theme.id)) {
        await page.locator('#quickstart').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, theme.id + '-manual-quickstart.png') });
      }
    }
    const storage = await page.evaluate(() => ({ original: window.__manualStorage, final: localStorage.getItem('tli_settings'), writes: window.__manualWrites }));
    report.storagePreserved = storage.original === storage.final && storage.writes.length === 0;
    report.storageWrites = storage.writes;
    await context.close();
  } finally { await browser.close(); }
  report.finalHashes = hashes();
  report.sourceUnchanged = JSON.stringify(report.initialHashes) === JSON.stringify(report.finalHashes);
  report.summary = { themes: report.results.length, textContrastFailures: report.results.reduce((sum, item) => sum + item.findings.length, 0), badgeChecks: report.results.reduce((sum, item) => sum + item.details.filter(detail => detail.selector.startsWith('.badge')).length, 0), numberedStepChecks: report.results.reduce((sum, item) => sum + item.details.filter(detail => detail.selector.endsWith('::before')).length, 0), detailFailures: report.results.reduce((sum, item) => sum + item.details.filter(detail => !detail.passed).length, 0), visualReview: report.results.reduce((sum, item) => sum + item.review.length + item.details.filter(detail => detail.review.length).length, 0), errors: report.errors.length, storagePreserved: report.storagePreserved, sourceUnchanged: report.sourceUnchanged };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report.summary }));
  assert.equal(report.summary.textContrastFailures + report.summary.detailFailures + report.summary.errors, 0);
  assert.equal(report.storagePreserved, true);
  assert.equal(report.sourceUnchanged, true);
}
main().catch(error => { fs.writeFileSync(path.join(output, 'error.txt'), error.stack); console.error(error); process.exitCode = 1; });
