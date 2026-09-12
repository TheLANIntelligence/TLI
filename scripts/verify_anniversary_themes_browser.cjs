/* Read-only full-SPA theme checks. No live server, provider, device or persistence. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const fingerprint = require('./anniversary_ui_source_hash.cjs');
const hashesAtStart = fingerprint();
if (!process.argv.includes('--label')) process.argv.push('--label', 'themes');
const { makePage, layout, fixtures, panelIds, out } = require('./verify_anniversary_ui_browser.cjs');
fixtures['/hub/status'] = { enabled: false, installed: [] };
fixtures['/hub/sample'] = { source: 'sample', packages: [{ id: 'fixture-theme', name: 'Studio palette', author: 'Synthetic fixture', version: '1.0', type: 'theme', description: 'A sample package for checking readability.', tags: ['theme'], installed: false }] };
fixtures['/actions/capabilities'] = { devices: [] };
fixtures['/hub/local-registry'] = { packages: [] };
const representative = ['panel-main', 'panel-settings', 'panel-dashboard2', 'panel-tools', 'panel-hub'];
const report = { synthetic: true, reducedMotion: true, themes: [], layout: [], contrast: [], textEnlargement: [], errors: [], blockedStorageWrites: [], blockedRequests: [], limitations: ['Computed contrast covers solid backgrounds. Gradients, filters and ancestor opacity are listed for visual review.', 'Text enlargement doubles computed text and line sizes; this is a simulation, not operating-system text zoom.', 'No physical phones or screen-reader acceptance was performed.'] };
async function measuredLayout(page, id) {
  const result = await layout(page, id);
  result.overflow = await page.evaluate(id => [...document.getElementById(id).querySelectorAll('input,select,textarea,button')].filter(window.__themeAuditVisible).filter(el => { const r = el.getBoundingClientRect(); return r.right > document.documentElement.clientWidth + 2 || r.left < -2; }).map(el => ({ id: el.id, text: el.textContent.trim().slice(0,50), right: Math.round(el.getBoundingClientRect().right) })), id);
  return result;
}
async function contrast(page, id) {
  return page.evaluate(id => {
    const root = document.getElementById(id) || document.querySelector(id), findings = [], review = [], gradientChecks = [];
    const parse = color => {
      const v = color.match(/-?[\d.]+/g)?.map(Number); if (!v || v.length < 3) return null;
      if (color.startsWith('color(srgb-linear')) for (let i=0;i<3;i++) v[i] = 255 * (v[i] <= .0031308 ? v[i]*12.92 : 1.055*v[i]**(1/2.4)-.055);
      else if (color.startsWith('color(srgb')) for (let i=0;i<3;i++) v[i] *= 255;
      return [v[0],v[1],v[2],v.length>3?v[3]:1];
    };
    const blend = (top, bottom) => top.slice(0,3).map((c,i) => c * top[3] + bottom[i] * (1-top[3])).concat(1);
    const lum = rgb => rgb.slice(0,3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v+.055)/1.055)**2.4; }).reduce((s,v,i) => s+v*[.2126,.7152,.0722][i],0);
    const visible = window.__themeAuditVisible;
    const name = el => el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].slice(0,2).join('.') : '');
    for (const el of [root, ...root.querySelectorAll('*')].filter(visible)) {
      if (el.disabled || el.closest('button:disabled') || ['OPTION','SCRIPT','STYLE','SVG','PATH'].includes(el.tagName)) continue;
      if (el.tagName === 'INPUT' && ['checkbox','radio','range','color','hidden','file'].includes(el.type)) continue;
      const input = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      const text = input ? (el.value || el.getAttribute('placeholder') || '') : [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ').trim();
      if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
      const style = getComputedStyle(el), fgStyle = input && !el.value && el.hasAttribute('placeholder') ? getComputedStyle(el, '::placeholder') : style;
      const fg = parse(fgStyle.color); if (!fg) continue;
      const layers = [], reasons = [], gradients = [];
      for (let node = el; node; node = node.parentElement) {
        const s = getComputedStyle(node), bg = parse(s.backgroundColor);
        if (Number(s.opacity) < .999) reasons.push('opacity ' + s.opacity + ' on ' + name(node));
        if (s.filter !== 'none') reasons.push('filter on ' + name(node));
        if (s.backgroundImage !== 'none') {
          // Only ordinary two-stop opaque RGB gradients are bounded here.
          // Component minima/maxima conservatively enclose every intermediate
          // sRGB color. Alpha, images, multiple layers/stops and advanced color
          // interpolation remain unresolved instead of being waved through.
          const match = s.backgroundBlendMode === 'normal' && s.backgroundImage.match(/^linear-gradient\(-?[\d.]+deg,\s*(rgb\([\d.,\s]+\)),\s*(rgb\([\d.,\s]+\))\)$/);
          const stops = match && [parse(match[1]), parse(match[2])];
          if (stops && stops.every(color => color && color[3] === 1)) {
            layers.push({ low: [0,1,2].map(i => Math.min(stops[0][i], stops[1][i])).concat(1),
              high: [0,1,2].map(i => Math.max(stops[0][i], stops[1][i])).concat(1) });
            gradients.push({ selector: name(node), image: s.backgroundImage });
            break;
          }
          reasons.push('background image or gradient on ' + name(node));
        }
        if (bg) layers.push({ low: bg, high: bg });
        if (bg?.[3] === 1) break;
      }
      const data = { selector: name(el), text: text.trim().slice(0,95), foreground: fgStyle.color, fontSize: parseFloat(style.fontSize), fontWeight: style.fontWeight };
      if (reasons.length) { review.push({ ...data, reasons }); continue; }
      const ordered = layers.reverse();
      const low = ordered.reduce((base, layer) => blend(layer.low, base), [255,255,255,1]);
      const high = ordered.reduce((base, layer) => blend(layer.high, base), [255,255,255,1]);
      const fgLow = lum(blend(fg, low)), fgHigh = lum(blend(fg, high)), bgLow = lum(low), bgHigh = lum(high);
      const ratio = bgLow >= fgHigh ? (bgLow+.05)/(fgHigh+.05) : fgLow >= bgHigh ? (fgLow+.05)/(bgHigh+.05) : 1;
      const required = data.fontSize >= 24 || (data.fontSize >= 18.6667 && Number(data.fontWeight) >= 700) ? 3 : 4.5;
      if (gradients.length) gradientChecks.push({ ...data, gradients, backgroundBounds: [low, high], minimumContrast: Number(ratio.toFixed(2)), required });
      if (ratio + .01 < required) findings.push({ ...data, background: low.slice(0,3).map(Math.round), backgroundUpperBound: high.slice(0,3).map(Math.round), ratio: Number(ratio.toFixed(2)), required });
    }
    return { findings, review, gradientChecks };
  }, id);
}
async function textScale(page, id, enable) {
  return page.evaluate(({ id, enable }) => {
    if (!enable) { for (const [el, style] of window.__themeTextSizes || []) { if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style); } window.__themeTextSizes = []; return; }
    const root = document.getElementById(id), all = [...root.querySelectorAll('*')].filter(el => window.__themeAuditVisible(el) && (/^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(el.tagName) || [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())));
    const styles = all.map(el => { const s = getComputedStyle(el); return [el, el.getAttribute('style'), parseFloat(s.fontSize), parseFloat(s.lineHeight)]; });
    window.__themeTextSizes = styles.map(([el, style]) => [el, style]);
    for (const [el, , size, line] of styles) { el.style.setProperty('font-size', size * 2 + 'px', 'important'); if (Number.isFinite(line)) el.style.setProperty('line-height', line * 2 + 'px', 'important'); }
  }, { id, enable });
}
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [1440, 320]) {
      const run = await makePage(browser, width, 'midnight'), page = run.page;
      const themes = await page.locator('#settings-theme option').evaluateAll(options => options.filter(o => !o.disabled && o.value).map(o => ({ value: o.value, label: o.textContent })));
      if (!report.themes.length) report.themes = themes;
      assert.ok(themes.length > 0, 'Audit should enumerate every current selectable theme');
      const saved = await page.evaluate(() => ({ settings: localStorage.getItem('tli_settings'), selected: document.getElementById('settings-theme').value }));
      await page.evaluate(() => {
        window.__themeWrites = [];
        for (const method of ['setItem','removeItem','clear']) Storage.prototype[method] = function(key) { window.__themeWrites.push({ method, key }); };
        window.__themeAuditVisible = el => {
          if (el.closest('[hidden],.hidden,[aria-hidden="true"]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
          for (let ancestor=el;ancestor;ancestor=ancestor.parentElement) {
            if (Number(getComputedStyle(ancestor).opacity) === 0) return false;
            if (ancestor !== el && ancestor.tagName === 'DETAILS' && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(el)) return false;
          }
          return true;
        };
      });
      for (const theme of themes) {
        await page.evaluate(theme => applyTheme(theme), theme.value);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme.value);
        for (const panel of width === 1440 ? representative : panelIds) {
          await page.evaluate(id => switchPanel(id), panel); await page.waitForTimeout(35);
          const current = await measuredLayout(page, panel); report.layout.push({ theme: theme.value, width, panel, ...current });
          if (width === 1440) {
            report.contrast.push({ theme: theme.value, panel, ...await contrast(page, panel) });
            if (panel === 'panel-main' || panel === 'panel-hub') await page.screenshot({ path: path.join(out, `${theme.value}-${panel}.png`) });
          }
          if (width === 320 && representative.includes(panel)) {
            await page.evaluate(panel => {
              const ids = panel === 'panel-main' ? ['chat-options'] : panel === 'panel-dashboard2' ? ['narrator-preferences'] : panel === 'panel-tools' ? ['tools-advanced-arguments'] : [];
              window.__themeOpenedDetails = ids.map(id => document.getElementById(id)).filter(Boolean).map(el => [el, el.open]);
              window.__themeOpenedDetails.forEach(([el]) => { el.open = true; });
            }, panel);
            if (panel === 'panel-hub') await page.locator('#hub-tabs button[data-type="publish"]').click();
            await textScale(page, panel, true);
            report.textEnlargement.push({ theme: theme.value, panel, scale: 2, flow: panel === 'panel-hub' ? 'Publish form' : 'Main controls with optional details expanded', ...await measuredLayout(page, panel) });
            if (theme.value === 'midnight' || theme.value === 'emeraldLight') await page.screenshot({ path: path.join(out, `text200-${theme.value}-${panel}.png`) });
            await textScale(page, panel, false);
            await page.evaluate(() => window.__themeOpenedDetails.forEach(([el, open]) => { el.open = open; }));
            if (panel === 'panel-hub') await page.locator('#hub-tabs button[data-type="all"]').click();
          }
        }
      }
      const after = await page.evaluate(() => ({ settings: localStorage.getItem('tli_settings'), selected: document.getElementById('settings-theme').value, writes: window.__themeWrites }));
      assert.equal(after.settings, saved.settings, 'Theme inspection must preserve saved settings');
      assert.equal(after.selected, saved.selected, 'Theme inspection must preserve the selected setting');
      report.blockedStorageWrites.push(...after.writes.map(write => ({ width, ...write })));
      report.errors.push(...run.errors.map(error => ({ width, error })));
      // The fixture rejects every non-GET request before it reaches any server.
      // Record automatic requests from existing panel-open hooks separately.
      report.blockedRequests.push(...run.calls.filter(call => !['GET','HEAD'].includes(call.method)).map(call => ({ width, ...call })));
      await run.context.close();
    }
  } finally { await browser.close(); }
  report.hashesAtStart = hashesAtStart;
  report.hashesAtEnd = fingerprint();
  report.sourceUnchanged = JSON.stringify(report.hashesAtStart) === JSON.stringify(report.hashesAtEnd);
  report.summary = { themes: report.themes.length, layouts: report.layout.length, overflow: report.layout.filter(r => r.overflow.length || r.documentWidth > r.width + 2).length, contrastFailures: report.contrast.reduce((n,r) => n+r.findings.length,0), needsVisualReview: report.contrast.reduce((n,r) => n+r.review.length,0), textEnlargementChecks: report.textEnlargement.length, textEnlargementOverflow: report.textEnlargement.filter(r => r.overflow.length || r.documentWidth > r.width + 2).length, errors: report.errors.length, storageWrites: 0, automaticStorageWritesBlocked: report.blockedStorageWrites.length, automaticRequestsBlocked: report.blockedRequests.length };
  fs.writeFileSync(path.join(out, 'themes-report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.sourceUnchanged, true, 'Production source changed during verification');
  console.log(JSON.stringify({ output: out, ...report.summary }));
}
module.exports = { measuredLayout, contrast, textScale };
if (require.main === module) main().catch(error => { fs.writeFileSync(path.join(out, 'themes-error.txt'), error.stack); console.error(error); process.exitCode = 1; });
