/* Full SPA theme-library acceptance. Synthetic intercepted services only. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fingerprint = require('./anniversary_ui_source_hash.cjs');
if (!process.argv.includes('--label')) process.argv.push('--label', 'theme-library');
const { makePage, fixtures, panelIds, out } = require('./verify_anniversary_ui_browser.cjs');
const { measuredLayout, contrast, textScale } = require('./verify_anniversary_themes_browser.cjs');
const sourceArg = process.argv.indexOf('--source');
const sourceRoot = path.resolve(sourceArg < 0 ? path.join(__dirname, '..') : process.argv[sourceArg + 1]);
const representative = ['panel-main', 'panel-settings', 'panel-dashboard2', 'panel-tools', 'panel-hub'];
const report = { synthetic: true, hashesAtStart: fingerprint(), themes: [], layouts: [], contrast: [], gradientProbes: [], enlargedText: [], nativeControls: [], previews: [], selection: [], filters: [], manual: [], compatibility: [], galleryMedia: [], errors: [], operations: [], blockedStorageWrites: [],
  limitations: ['Full SPA served with synthetic intercepted responses; no live TLI or inference.', 'Text enlargement doubles computed text and line heights; no physical-phone or screen-reader acceptance.', 'Solid-color contrast and conservative opaque two-stop RGB gradient bounds are measured; other gradients, images and opacity are reported for review.'] };
const visibleScript = () => {
  window.__themeAuditVisible = el => {
    if (el.closest('[hidden],.hidden,[aria-hidden="true"]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
    for (let parent = el; parent; parent = parent.parentElement) {
      if (Number(getComputedStyle(parent).opacity) === 0) return false;
      if (parent !== el && parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(el)) return false;
    }
    return true;
  };
};
async function openAppearance(page) {
  await page.evaluate(() => { switchPanel('panel-settings'); window.TLISettingsWorkspace.open('general', 'settings-section-appearance'); });
}
async function catalog(page) {
  const value = await page.evaluate(() => window.TLIThemes?.themes?.map(({ id, name, tone, collection }) => ({ id, name, tone, collection })));
  assert.equal(value?.length, 23, 'All existing themes plus Classic TLI must be available');
  assert.equal(new Set(value.map(theme => theme.id)).size, 23, 'Theme IDs must be unique');
  assert.equal(value.filter(theme => theme.collection === 'new').length, 6);
  const selected = await page.locator('#settings-theme option').evaluateAll(options => options.map(option => option.value));
  assert.deepEqual([...selected].sort(), value.map(theme => theme.id).sort(), 'Gallery and existing select must expose the same choices');
  return value;
}
function recordRun(run) {
  report.errors.push(...run.errors);
  report.operations.push(...run.calls.filter(call => !['GET', 'HEAD'].includes(call.method)));
}

async function gradientProbes(browser) {
  const run = await makePage(browser, 1440, 'emeraldLight'), page = run.page;
  await page.evaluate(visibleScript);
  for (const [name, color, gradient, expected] of [
    ['readable opaque gradient', '#000', 'linear-gradient(135deg, rgb(255,255,255), rgb(220,240,225))', 'pass'],
    ['unreadable opaque gradient', '#f5f5f5', 'linear-gradient(135deg, rgb(255,255,255), rgb(220,240,225))', 'fail'],
    ['foreground within gradient bounds', '#888', 'linear-gradient(135deg, rgb(0,0,0), rgb(255,255,255))', 'fail'],
    ['transparent gradient still needs review', '#000', 'linear-gradient(135deg, rgba(255,255,255,.8), rgb(220,240,225))', 'review'],
  ]) {
    await page.evaluate(({ color, gradient }) => {
      document.getElementById('theme-gradient-proof')?.remove();
      const box = document.createElement('div'); box.id = 'theme-gradient-proof'; box.textContent = 'Synthetic contrast evidence';
      Object.assign(box.style, { position: 'fixed', left: '320px', top: '240px', width: '500px', padding: '20px', color, background: gradient, fontSize: '16px', fontWeight: '400', zIndex: '10000' });
      document.body.appendChild(box);
    }, { color, gradient });
    const result = await contrast(page, 'theme-gradient-proof');
    if (expected === 'pass') { assert.equal(result.findings.length, 0); assert.equal(result.review.length, 0); assert.equal(result.gradientChecks.length, 1); }
    if (expected === 'fail') { assert.equal(result.findings.length, 1); assert.equal(result.review.length, 0); }
    if (expected === 'review') assert.equal(result.review.length, 1);
    report.gradientProbes.push({ name, expected, ...result });
  }
  await page.evaluate(() => document.getElementById('theme-gradient-proof')?.remove());
  recordRun(run); await run.context.close();
}

async function paletteChecks(browser) {
  const widthArgument = process.argv.indexOf('--width');
  for (const width of widthArgument < 0 ? [1440, 320] : [Number(process.argv[widthArgument + 1])]) {
    const run = await makePage(browser, width, 'emeraldLight'), page = run.page;
    const themes = await catalog(page); if (!report.themes.length) report.themes = themes;
    const previewPalettes = await page.locator('.tli-theme-preview[data-theme]').evaluateAll(items => Object.fromEntries(items.map(el => {
      const style = getComputedStyle(el);
      return [el.dataset.theme, ['--bg-main', '--bg-panel', '--accent', '--text-main', '--text-muted'].map(token => style.getPropertyValue(token).trim())];
    })));
    await page.evaluate(visibleScript);
    const before = await page.evaluate(() => ({ settings: localStorage.getItem('tli_settings'), selected: document.getElementById('settings-theme').value }));
    await page.evaluate(() => {
      window.__themeBlockedWrites = [];
      for (const method of ['setItem', 'removeItem', 'clear']) Storage.prototype[method] = function(key) { window.__themeBlockedWrites.push({ method, key }); };
    });
    for (const theme of themes) {
      await page.evaluate(id => applyTheme(id), theme.id);
      const native = await page.evaluate(() => ({ id: document.documentElement.dataset.theme, tone: getComputedStyle(document.documentElement).colorScheme,
        bodyDark: document.body.classList.contains('theme-dark'), selectTone: getComputedStyle(document.getElementById('settings-theme')).colorScheme,
        reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }));
      report.nativeControls.push({ width, theme: theme.id, ...native });
      assert.equal(native.id, theme.id); assert.equal(native.tone, theme.tone); assert.equal(native.selectTone, theme.tone);
      assert.equal(native.bodyDark, theme.tone === 'dark'); assert.equal(native.reduceMotion, true);
      const appliedPalette = await page.evaluate(() => ['--bg-main', '--bg-panel', '--accent', '--text-main', '--text-muted'].map(token => getComputedStyle(document.documentElement).getPropertyValue(token).trim()));
      assert.ok(appliedPalette.every(Boolean), 'Every theme must provide all preview tokens');
      assert.deepEqual(previewPalettes[theme.id], appliedPalette, 'An unselected preview must show its own real palette');
      report.previews.push({ width, theme: theme.id, matchesAppliedPalette: true });
      if (width === 1440) report.contrast.push({ width, theme: theme.id, panel: 'shell-header', ...await contrast(page, '.main-region > header') });
      for (const panel of panelIds) {
        await page.evaluate(id => switchPanel(id), panel);
        if (panel === 'panel-settings') await openAppearance(page);
        await page.waitForTimeout(25);
        report.layouts.push({ width, theme: theme.id, panel, ...await measuredLayout(page, panel) });
        if (width === 1440 && representative.includes(panel)) {
          report.contrast.push({ width, theme: theme.id, panel, ...await contrast(page, panel) });
          if (panel === 'panel-main' || panel === 'panel-settings') await page.screenshot({ path: path.join(out, `${theme.id}-${panel}-1440.png`), fullPage: true });
        }
        if (width === 320 && representative.includes(panel)) {
          await page.evaluate(panel => {
            const ids = panel === 'panel-main' ? ['chat-options'] : panel === 'panel-dashboard2' ? ['narrator-preferences'] : panel === 'panel-tools' ? ['tools-advanced-arguments'] : [];
            window.__themeDetails = ids.map(id => document.getElementById(id)).filter(Boolean).map(el => [el, el.open]);
            window.__themeDetails.forEach(([el]) => { el.open = true; });
          }, panel);
          if (panel === 'panel-hub') await page.locator('#hub-tabs button[data-type="publish"]').click();
          await textScale(page, panel, true);
          report.enlargedText.push({ width, theme: theme.id, panel, scale: 2, ...await measuredLayout(page, panel) });
          if (panel === 'panel-settings') await page.screenshot({ path: path.join(out, `${theme.id}-gallery-text200-320.png`), fullPage: true });
          await textScale(page, panel, false);
          await page.evaluate(() => window.__themeDetails.forEach(([el, open]) => { el.open = open; }));
          if (panel === 'panel-hub') await page.locator('#hub-tabs button[data-type="all"]').click();
        }
      }
    }
    const after = await page.evaluate(() => ({ settings: localStorage.getItem('tli_settings'), selected: document.getElementById('settings-theme').value, writes: window.__themeBlockedWrites }));
    assert.equal(after.settings, before.settings, 'Palette inspection must not persist a theme');
    assert.equal(after.selected, themes.at(-1).id, 'The native picker should reflect the currently rendered palette');
    assert.equal(after.writes.filter(write => write.key === 'tli_settings').length, 0, 'Rendering a palette must not attempt a preference write');
    report.blockedStorageWrites.push(...after.writes.map(write => ({ width, ...write })));
    recordRun(run); await run.context.close();
  }
}

async function trackPreferenceWrites(page) {
  await page.evaluate(() => {
    window.__themePreferenceWrites = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === 'tli_settings') window.__themePreferenceWrites.push(JSON.parse(value));
      return original.apply(this, arguments);
    };
  });
}

async function workflowChecks(browser) {
  const run = await makePage(browser, 1440, 'midnight', { preserveSettingsOnReload: true }), page = run.page;
  const themes = await catalog(page);
  if (!report.themes.length) report.themes = themes;
  const original = await page.evaluate(() => {
    const settings = { ...JSON.parse(localStorage.getItem('tli_settings')), teachingOn: true, defaultTemp: '0.45', defaultMax: '512', themeFixtureFuturePreference: { preserve: true } };
    localStorage.setItem('tli_settings', JSON.stringify(settings));
    return settings;
  });
  await openAppearance(page); await trackPreferenceWrites(page);
  for (const filter of ['light', 'dark', 'new', 'all']) {
    const button = page.locator(`[data-theme-filter="${filter}"]`);
    await button.focus(); await page.keyboard.press('Enter');
    const expected = themes.filter(theme => filter === 'all' || (filter === 'new' ? theme.collection === 'new' : theme.tone === filter)).map(theme => theme.id);
    const shown = await page.locator('[data-theme-choice]:not([hidden])').evaluateAll(cards => cards.map(card => card.dataset.themeChoice));
    assert.deepEqual(shown.sort(), expected.sort());
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await button.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.__themePreferenceWrites.length), 0);
    report.filters.push({ filter, shown: shown.length, keyboard: true, writes: 0 });
  }
  const ordered = [...themes.filter(theme => theme.id !== original.defaultTheme), ...themes.filter(theme => theme.id === original.defaultTheme)];
  for (const theme of ordered) {
    await openAppearance(page);
    const card = page.locator(`[data-theme-choice="${theme.id}"]`);
    const before = await page.evaluate(() => window.__themePreferenceWrites.length);
    await card.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme.id);
    const after = await page.evaluate(() => ({ settings: JSON.parse(localStorage.getItem('tli_settings')), writes: window.__themePreferenceWrites.length, value: document.getElementById('settings-theme').value }));
    assert.deepEqual(after.settings, { ...original, defaultTheme: theme.id }, 'Theme selection must preserve all other preferences');
    assert.equal(after.value, theme.id); assert.equal(after.writes - before, 1, 'One keyboard choice should persist exactly once');
    assert.equal(await card.getAttribute('aria-pressed'), 'true');
    await card.click(); assert.equal(await page.evaluate(() => window.__themePreferenceWrites.length), after.writes, 'Choosing the current theme should not write again');
    await page.reload({ waitUntil: 'load' }); await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme.id);
    await page.waitForFunction(() => document.getElementById('tli-theme-library')?.dataset.bound === '1');
    assert.equal(await page.locator('#settings-theme').inputValue(), theme.id);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings'))), after.settings);
    report.selection.push({ theme: theme.id, savedOnce: true, unchangedOtherPreferences: true, retainedAfterReload: true });
    const manual = await run.context.newPage(); manual.on('pageerror', error => report.errors.push(error.stack || error.message));
    await manual.goto('http://tli-ui.test/manual.html', { waitUntil: 'load' });
    const tone = await manual.evaluate(() => ({ declared: document.documentElement.dataset.helpTone, native: getComputedStyle(document.documentElement).colorScheme, background: getComputedStyle(document.body).backgroundColor }));
    assert.equal(tone.declared, theme.tone); assert.equal(tone.native, theme.tone);
    report.manual.push({ theme: theme.id, ...tone }); await manual.close();
    await trackPreferenceWrites(page);
  }
  // Legacy aliases and an unrecognized saved name affect rendering, not storage.
  for (const [saved, applied] of [['cloud', 'cloudLight'], ['emeraldDark', 'midnight'], ['unknown-future-theme', 'emeraldLight']]) {
    await page.evaluate(value => localStorage.setItem('tli_settings', JSON.stringify(value)), { ...original, defaultTheme: saved });
    await page.reload({ waitUntil: 'load' }); await page.waitForFunction(id => document.documentElement.dataset.theme === id, applied);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings'))), { ...original, defaultTheme: saved });
    report.compatibility.push({ saved, applied, preservedSavedValue: true });
  }
  await openAppearance(page);
  const beforeFailure = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, settings: localStorage.getItem('tli_settings') }));
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key) {
      if (this === localStorage && key === 'tli_settings') throw new DOMException('Synthetic storage failure', 'QuotaExceededError');
      return original.apply(this, arguments);
    };
  });
  await page.locator('[data-theme-choice="midnight"]').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), beforeFailure.theme);
  assert.equal(await page.locator('#settings-theme').inputValue(), beforeFailure.theme);
  assert.equal(await page.evaluate(() => localStorage.getItem('tli_settings')), beforeFailure.settings);
  assert.equal(await page.locator(`[data-theme-choice="${beforeFailure.theme}"]`).getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#settings-theme-status').textContent(), /could not be saved/i);
  report.compatibility.push({ rejectedPreferenceWrite: true, appearanceAndSelectionPreserved: true });
  // A missing catalog must retain the existing native picker as a fallback.
  await run.context.route('**/js/theme-library.js*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.TLIThemes = {...window.TLIThemes, themes: []};\n' + fs.readFileSync(path.join(sourceRoot, 'frontend/js/theme-library.js'), 'utf8') }));
  await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => typeof window.TLISettingsWorkspace?.open === 'function');
  await openAppearance(page);
  assert.equal(await page.locator('#tli-theme-library').isVisible(), false);
  assert.equal(await page.locator('#settings-theme').isVisible(), true);
  assert.equal(await page.locator('#settings-theme').isEnabled(), true);
  await page.locator('#settings-theme').selectOption('cloudLight');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'cloudLight');
  report.compatibility.push({ emptyCatalog: true, nativePickerUsable: true });
  await run.context.unroute('**/js/theme-library.js*');
  await run.context.route('**/js/theme-catalog.js*', route => route.fulfill({ status: 503, contentType: 'text/javascript', body: '// Synthetic catalog unavailable.' }));
  await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => typeof window.TLISettingsWorkspace?.open === 'function');
  await openAppearance(page); await trackPreferenceWrites(page);
  assert.equal(await page.locator('#tli-theme-library').isVisible(), false);
  const beforeCatalogFailure = await page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings')));
  await page.locator('#settings-theme').selectOption('midnight');
  const fallback = await page.evaluate(() => ({ id: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme,
    dark: document.body.classList.contains('theme-dark'), settings: JSON.parse(localStorage.getItem('tli_settings')), writes: window.__themePreferenceWrites.length }));
  assert.equal(fallback.id, 'midnight'); assert.equal(fallback.scheme, 'dark'); assert.equal(fallback.dark, true); assert.equal(fallback.writes, 1);
  assert.deepEqual(fallback.settings, { ...beforeCatalogFailure, defaultTheme: 'midnight' });
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'midnight');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings'))), fallback.settings);
  report.compatibility.push({ catalogScriptUnavailable: true, nativeDarkThemeAppliedAndRetained: true, savedOnce: true });
  recordRun(run); await run.context.close();
}

async function galleryScreenshots(browser) {
  for (const [width, theme] of [[1440, 'porcelainLight'], [1440, 'midnight'], [390, 'porcelainLight'], [390, 'pacific']]) {
    // These are newly collected synthetic observations for this fresh screenshot
    // session; do not reuse a timestamp from the earlier, longer matrix run.
    const checkedAt = new Date().toISOString(), probed = Math.floor(Date.now() / 1000);
    for (const endpoint of ['/dashboard/state', '/dashboard/presence', '/dashboard/command-center']) {
      if (fixtures[endpoint]?.state) Object.assign(fixtures[endpoint].state, { metrics_checked_at: checkedAt, probed_ts: probed });
    }
    const run = await makePage(browser, width, theme), page = run.page;
    await page.evaluate(visibleScript); await openAppearance(page);
    await page.locator('[data-theme-filter="new"]').click();
    await page.locator('.tli-theme-toolbar').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-theme-choice]:not([hidden])').count(), 6);
    const measured = await measuredLayout(page, 'panel-settings');
    assert.deepEqual(measured.overflow, []); assert.ok(measured.documentWidth <= width + 2);
    const screenshot = `gallery-new-${theme}-${width}.png`;
    await page.screenshot({ path: path.join(out, screenshot), fullPage: true });
    report.galleryMedia.push({ width, theme, screenshot, visibleNewThemes: 6, overflow: measured.overflow });
    recordRun(run); await run.context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    if (!process.argv.includes('--gallery-only')) {
      await gradientProbes(browser);
      if (!process.argv.includes('--workflow-only')) await paletteChecks(browser);
      await workflowChecks(browser);
    }
    await galleryScreenshots(browser);
  }
  finally {
    await browser.close();
    report.hashesAtEnd = fingerprint(); report.sourceUnchanged = JSON.stringify(report.hashesAtStart) === JSON.stringify(report.hashesAtEnd);
    const overflow = item => item.overflow.length || item.documentWidth > item.width + 2;
    report.summary = { themes: report.themes.length, layouts: report.layouts.length, overflow: report.layouts.filter(overflow).length,
      contrastFailures: report.contrast.reduce((sum, item) => sum + item.findings.length, 0), contrastReview: report.contrast.reduce((sum, item) => sum + item.review.length, 0),
      measuredGradients: report.contrast.reduce((sum, item) => sum + (item.gradientChecks?.length || 0), 0), gradientProbes: report.gradientProbes.length,
      enlargedText: report.enlargedText.length, enlargedOverflow: report.enlargedText.filter(overflow).length, selections: report.selection.length,
      nativeControls: report.nativeControls.length, previews: report.previews.length, manualChecks: report.manual.length, filters: report.filters.length, compatibility: report.compatibility.length,
      galleryScreenshots: report.galleryMedia.length, errors: report.errors.length, operations: report.operations.length, sourceUnchanged: report.sourceUnchanged };
    fs.writeFileSync(path.join(out, 'theme-library-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, ...report.summary }));
  }
  assert.equal(report.sourceUnchanged, true, 'Source changed during theme verification');
  assert.equal(report.summary.overflow, 0); assert.equal(report.summary.enlargedOverflow, 0);
  assert.equal(report.summary.contrastFailures, 0); assert.equal(report.summary.contrastReview, 0);
  assert.equal(report.summary.errors, 0); assert.equal(report.summary.operations, 0);
}
main().catch(error => { fs.writeFileSync(path.join(out, 'theme-library-error.txt'), error.stack); console.error(error); process.exitCode = 1; });
