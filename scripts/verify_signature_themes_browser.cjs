/* Signature-theme acceptance: real SPA, intercepted synthetic services, no live host. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { makePage, source, fingerprintFiles, panelIds, fixtures } = require('./verify_anniversary_ui_browser.cjs');
const { measuredLayout, contrast, textScale } = require('./verify_anniversary_themes_browser.cjs');
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const before = process.argv.includes('--before'), full = process.argv.includes('--full'), computedOnly = process.argv.includes('--computed-only'), extendedSmoke = process.argv.includes('--extended-smoke'), probesOnly = process.argv.includes('--probes-only');
const output = path.resolve(arg('--output') || path.join(__dirname, '../build_work/signature-themes/browser', Date.now().toString()));
fs.mkdirSync(output, { recursive: true });
if (fs.existsSync(path.join(output, 'report.json'))) throw Error('Use a fresh output directory; retain earlier evidence.');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const signature = ['emeraldLight', 'lavenderLite', 'porcelainLight', 'roseQuartz', 'pacific', 'copper', 'graphite', 'terminal'];
const reps = ['panel-dashboard2', 'panel-main', 'panel-settings'];
const preservationPanels = [...reps, 'panel-mesh', 'panel-homeauto', 'panel-devices'];
const tokens = ['--theme-font-ui', '--theme-font-heading', '--theme-font-data', '--theme-heading-weight', '--theme-heading-tracking', '--theme-card-radius', '--theme-control-radius', '--theme-dialog-radius', '--theme-card-shadow', '--theme-control-shadow', '--theme-canvas-image', '--theme-sidebar-image', '--theme-header-image', '--theme-classic-card-background', '--theme-classic-header-background'];
const palette = ['--bg-main', '--bg-panel', '--bg-header', '--bg-sidebar', '--accent', '--text-main', '--text-muted'];
const targetPanels = arg('--panels')?.split(',');
tokens.push('--theme-content-opacity', '--theme-control-text', '--theme-reading-surface', '--theme-selected-surface', '--theme-avatar-text', '--theme-peer-avatar-background', '--theme-peer-avatar-text', '--theme-muted-avatar-text');
const baseline = arg('--baseline-report') ? JSON.parse(fs.readFileSync(arg('--baseline-report'), 'utf8')) : null;
const observed = Math.floor(Date.now() / 1000);
const event = { id: 'signature-event', title: 'Project backup reminder saved', body: 'A synthetic setup note records where the studio backup is kept. No files were inspected or changed.', level: 'info', category: 'saved work', node: 'Studio', count: 1, first_ts: observed, ts: observed };
fixtures['/dashboard/activity-summary'] = { ok: true, cursor: { sequence: 1, session_id: 'signature-fixture' }, total: 1, warning_count: 0, group_count: 1, coverage: 'retained', coverage_note: 'Synthetic retained activity for the theme review.', retention_limit: 200, groups: [event], events: [event], checked_at: observed, reviewed_at: null };
fixtures['/api/intelligence/places'] = { ok: true, protocol: 'saved-places-v1', places: [{ id: 'b'.repeat(32), revision: 'c'.repeat(64), name: 'Project backups', kind: 'folder', target: 'D:\\Studio\\Project backups', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
fixtures['/api/mesh/health'].nodes.push({ node_id: 'fixture-attic', peer_id: 'fixture-attic', node_name: 'Attic', ip: '192.0.2.12', port: 8000, is_self: false, online: false, has_ai: false, checked_at: new Date().toISOString() });
const report = { schema_version: 1, synthetic_only: true, before, full, source, method: { path: __filename, sha256: sha(__filename) }, source_before: fingerprintFiles(source), signature, checks: [], layouts: [], contrast: [], computed: [], previews: [], screenshots: [], sessions: [], errors: [], limitations: ['No live TLI, model, household data, device actions or native builds are contacted.', 'Computed text enlargement, desktop keyboard and browser viewport fixtures do not establish physical-phone or screen-reader acceptance.', 'Contrast measures opaque colors and bounded two-stop RGB gradients. Unsupported visual effects remain explicitly recorded for visual review.', 'Unchanged-theme preservation compares exact computed application styles in representative real DOMs, excluding the deliberately redesigned theme gallery.'] };
async function check(name, fn) { try { await fn(); report.checks.push({ name, passed: true }); } catch (e) { report.checks.push({ name, passed: false, error: String(e.stack || e) }); } }
async function shot(page, name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push({ name, path: file, sha256: sha(file) }); }
async function frame(page, panel) {
  await page.evaluate(panel => { document.scrollingElement.scrollTop = 0; document.querySelector('.main-scroll')?.scrollTo(0, 0); if (panel === 'panel-main') document.getElementById('chat-output').scrollTop = 0; if (panel === 'panel-settings') document.getElementById('settings-section-appearance')?.scrollIntoView({ block: 'start' }); }, panel);
  await page.waitForTimeout(70);
}
async function panelShot(page, meta) { await frame(page, meta.panel); const name = ['panel', meta.theme, meta.mode, meta.panel, meta.width].join('-'), file = path.join(output, name + '.jpg'); await page.screenshot({ path: file, fullPage: false, type: 'jpeg', quality: 78 }); report.screenshots.push({ ...meta, name, path: file, sha256: sha(file) }); }
function visibleScript() {
  window.__themeAuditVisible = el => {
    if (el.closest('[hidden],.hidden,[aria-hidden="true"]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
    for (let parent = el; parent; parent = parent.parentElement) {
      if (Number(getComputedStyle(parent).opacity) === 0) return false;
      if (parent !== el && parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(el)) return false;
    }
    return true;
  };
}
async function setup(run, mode, width) {
  await run.page.setViewportSize({ width, height: width < 400 ? 844 : 1000 });
  await run.page.evaluate(mode => { TLIInterface.set(mode); window.__themePreferenceWrites = []; const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (this === localStorage && key === 'tli_settings') window.__themePreferenceWrites.push(value); return original.apply(this, arguments); }; }, mode);
  await run.page.evaluate(visibleScript);
  const revision = 'a'.repeat(64);
  const messages = [{ role: 'user', content: 'What should I check before moving my project backups?', source_ref: { conversation_id: 'synthetic-signature', message_index: 0, revision } }, { role: 'assistant', content: '**Start with the copy you trust.**\n\nCheck that your recent project opens from the backup drive before changing the original. Your saved setup note says backups are kept in the studio drawer. [N1]\n\n1. Confirm the exact folder and the date of the backup.\n2. Open **Free Space** if you want to inspect the largest files.\n3. Review the selected files before any cleanup.\n\nI have not scanned, moved or deleted files.', source_ref: { conversation_id: 'synthetic-signature', message_index: 1, revision }, provider: 'bundled', model: 'Synthetic theme fixture', memory_context: { use_saved_memory: true, status: 'included', omitted_for_budget: 0, notes: [{ id: 'fixture-note', title: 'Studio backup location', revision, updated_at: '2026-09-12T16:00:00Z', source: 'user', device_id: null }] }, conversation_context: { status: 'none', included_messages: 0, included_exchanges: 0, omitted_messages: 0, character_budget: 6000 }, evidence_context: { version: 1, interpretation: 'ai', citations_checked: true, sources: [{ handle: 'N1', kind: 'note', id: 'fixture-note', revision, label: 'Studio backup location', provenance: 'user', saved_at: '2026-09-12T16:00:00Z', ranges: [] }], citations: [{ reference: '[N1]', handle: 'N1' }], invalid_citations: 0 } }];
  await run.context.route('**/api/ai/conversations/synthetic-signature', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'synthetic-signature', messages }) }));
  assert.equal(await run.page.evaluate(() => loadConversation('synthetic-signature', 'Project backups')), true);
  const toast = run.page.locator('#tli-toast-container .tli-toast').filter({ hasText: 'Resumed: Project backups' });
  if (await toast.count()) { await toast.getByRole('button', { name: 'Dismiss', exact: true }).click(); await toast.waitFor({ state: 'hidden' }); }
}
async function open(page, panel) {
  await page.evaluate(panel => { switchPanel(panel); if (panel === 'panel-settings') TLISettingsWorkspace.open('general', 'settings-section-appearance'); }, panel);
  await page.waitForTimeout(35);
  if (panel === 'panel-dashboard2') {
    await page.evaluate(message => TLIDash2.setEventMessage(message), { type: 'status', text: 'Your studio, ready for the next idea. Review the latest readings and pick up your saved work.', severity: 'info' });
    await page.waitForFunction(() => document.getElementById('nd-statement-text')?.textContent.includes('Your studio, ready') && Number(getComputedStyle(document.getElementById('nd-statement')).opacity) > .99, undefined, { timeout: 3000 });
  }
}
async function computed(page, panel) {
  return page.evaluate(({ panel, tokens, palette }) => {
    const fields = ['color', 'backgroundColor', 'backgroundImage', 'boxShadow', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'borderTopLeftRadius', 'borderTopWidth', 'borderTopColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'colorScheme', 'opacity'];
    const selectors = ['html', 'body', '.main-region > header', '#sidebar', '#sidebar .sidebar-logo', '#sidebar .nav-item.active', '#' + panel, '#' + panel + ' .page-header', '#' + panel + ' h1', '#' + panel + ' h2', '#' + panel + ' h3', '#' + panel + ' .card', '#' + panel + ' .btn-primary', '#' + panel + ' input:not([type=hidden])', '#' + panel + ' textarea', '#' + panel + ' select'];
    if (panel === 'panel-main') selectors.push('#chat-composer-shell', '#chat-input', '#chat-send-btn', '.chat-bubble-user', '.chat-bubble-ai', '.chat-message-more', '.chat-answer-details');
    if (panel === 'panel-dashboard2') selectors.push('#nd-attention', '#nd-narrator', '.nd-narrator__text', '#panel-dashboard2 .page-title', '.dashboard-attention', '.nd-statement', '.nd-vital', '.nd-vital__val', '.activity-catchup');
    if (panel === 'panel-settings') selectors.push('#settings-theme', '#settings-section-appearance', '.settings-workspace-nav');
    if (panel === 'panel-mesh') selectors.push('.mcd-node-avatar.self-av', '.mcd-node-avatar.peer-av');
    if (panel === 'panel-homeauto') selectors.push('.sha-card--unknown', '.sha-last-checked', '.shelly-raw-details > summary');
    if (panel === 'panel-devices') selectors.push('.tli-seg-btn', '.tli-seg-btn.is-active', '.tli-printers-toolbar-meta', '.tli-printers-search');
    const styles = Object.fromEntries(selectors.map(selector => {
      const node = [...document.querySelectorAll(selector)].find(e => !e.closest('#tli-theme-library'));
      if (!node) return [selector, null]; const style = getComputedStyle(node);
      return [selector, Object.fromEntries(fields.map(field => [field, style[field]]))];
    }));
    return { styles, palette: Object.fromEntries(palette.map(key => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])), signatureTokens: Object.fromEntries(tokens.map(key => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])) };
  }, { panel, tokens, palette });
}
async function captureLayout(page, meta) {
  const result = { ...meta, ...await measuredLayout(page, meta.panel) }; report.layouts.push(result);
  await check(Object.values(meta).join(' ') + ' controls fit viewport', () => { assert.ok(result.documentWidth <= result.width + 2, JSON.stringify(result)); assert.deepEqual(result.overflow, []); assert.deepEqual(result.duplicateIds || [], []); });
}
async function captureContrast(page, meta) { const result = { ...meta, ...await contrast(page, meta.panel) }; report.contrast.push(result); await check(Object.values(meta).join(' ') + ' readable text contrast', () => { assert.deepEqual(result.findings, []); assert.deepEqual(result.review, [], 'Every visible text effect must be measured or fixed; review is not a pass'); }); }
async function popup(page, meta) {
  await open(page, 'panel-main');
  await check(Object.values(meta).join(' ') + ' More actions are visible, focusable and do not execute', async () => {
    const more = page.locator('.chat-message-more').first(), menu = page.locator('.chat-message-menu').first();
    await more.scrollIntoViewIfNeeded(); await more.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(50);
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    for (const item of await menu.locator('button').all()) assert.equal(await item.evaluate(e => { const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1 && !!hit && (hit === e || e.contains(hit)); }), true);
    await captureContrast(page, { ...meta, panel: '.chat-message-menu' });
    await page.keyboard.press('Escape'); assert.equal(await menu.isVisible(), false); assert.equal(await more.evaluate(e => e === document.activeElement), true);
  });
}
async function modelDialog(page, meta) {
  await open(page, 'panel-main');
  await check(Object.values(meta).join(' ') + ' model dialog fits and Escape returns focus', async () => {
    const launcher = page.locator('#chat-runtime-button'); await launcher.click(); await page.waitForTimeout(100);
    const modal = page.locator('#model-manager-modal-overlay'); assert.equal(await modal.isVisible(), true);
    await captureLayout(page, { ...meta, panel: 'model-manager-modal-overlay', state: 'dialog' });
    await captureContrast(page, { ...meta, panel: 'model-manager-modal-overlay' });
    await page.keyboard.press('Escape'); assert.equal(await modal.isVisible(), false); assert.equal(await launcher.evaluate(e => e === document.activeElement), true);
  });
}
async function fontFallback(page, meta) {
  const previous = await page.evaluate(() => ['--theme-font-heading', '--theme-font-data'].map(key => [key, document.documentElement.style.getPropertyValue(key)]));
  try {
    const metrics = await page.evaluate(() => {
      return ['--theme-font-heading', '--theme-font-data'].map(key => {
        const value = getComputedStyle(document.documentElement).getPropertyValue(key).trim(), fallback = value.split(',').slice(1).join(',');
        const simulated = '"TLI intentionally missing fixture face",' + fallback; document.documentElement.style.setProperty(key, simulated);
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); ctx.font = '24px ' + fallback; const expected = ctx.measureText('Studio, 72 GiB — your home').width; ctx.font = '24px ' + simulated;
        return { key, expected, actual: ctx.measureText('Studio, 72 GiB — your home').width, fallback };
      });
    });
    await check(Object.values(meta).join(' ') + ' unavailable first font uses the declared local fallback', () => { for (const m of metrics) { assert.ok(m.fallback && m.actual > 0); assert.equal(m.actual, m.expected); } });
    for (const panel of reps) { await open(page, panel); await captureLayout(page, { ...meta, panel, font: 'first face unavailable' }); }
  } finally { await page.evaluate(previous => { for (const [key, value] of previous) { if (value) document.documentElement.style.setProperty(key, value); else document.documentElement.style.removeProperty(key); } }, previous); }
}
async function matrix(browser) {
  const widths = full || before ? [1440, 320] : [1440, 320];
  for (const mode of ['modern', 'classic']) for (const width of widths) {
    const run = await makePage(browser, width, 'emeraldLight'), page = run.page;
    try {
      await setup(run, mode, width);
      const themes = await page.evaluate(() => TLIThemes.themes.map(({ id, name, tone, collection, signature }) => ({ id, name, tone, collection, signature })));
      if (!report.themes) report.themes = themes;
      await check(mode + ' ' + width + ' catalogue IDs and ordering retained', () => { assert.equal(themes.length, 23); assert.equal(new Set(themes.map(t => t.id)).size, 23); if (baseline) assert.deepEqual(themes.map(t => t.id), baseline.themes.map(t => t.id)); if (!before) assert.deepEqual(themes.filter(t => t.signature).map(t => t.id).sort(), [...signature].sort()); });
      for (const theme of themes) {
        await page.evaluate(id => applyTheme(id), theme.id);
        const panels = targetPanels || (full && signature.includes(theme.id) ? panelIds : preservationPanels);
        for (const panel of panels) {
          await open(page, panel);
          const meta = { theme: theme.id, mode, width, panel };
          if (!before && panel === 'panel-main') await check(Object.values(meta).join(' ') + ' Screenshot help retains its position and consumes control geometry', async () => {
            const style = await page.locator('#screenshot-start').evaluate(e => ({ radius: getComputedStyle(e).borderTopLeftRadius, token: getComputedStyle(e).getPropertyValue('--theme-control-radius').trim(), height: e.getBoundingClientRect().height }));
            assert.equal(style.radius, signature.includes(theme.id) ? style.token : '8px');
            assert.ok(style.height >= 44);
          });
          if (!before && panel === 'panel-mesh') await check(Object.values(meta).join(' ') + ' offline avatar exists and retains appropriate theme text', async () => { const avatar = page.locator('.mcd-node-avatar.offline-av'); assert.equal(await avatar.count(), 1); const actual = await avatar.evaluate(e => getComputedStyle(e).color), opacity = await avatar.evaluate(e => getComputedStyle(e.closest('.mcd-node')).opacity); if (!signature.includes(theme.id)) { assert.equal(actual, 'rgb(255, 255, 255)', 'The retained baseline .mcd-node-avatar literal #fff remains in effect'); assert.equal(opacity, '0.6', 'The other15 retain the baseline offline-card opacity'); } else { assert.equal(await avatar.evaluate(e => getComputedStyle(e).color === getComputedStyle(document.querySelector('.main-scroll')).backgroundColor), true); assert.equal(opacity, '1'); } });
          if (preservationPanels.includes(panel)) {
            const row = { ...meta, ...await computed(page, panel) }; report.computed.push(row);
            if (baseline && !signature.includes(theme.id)) await check(Object.values(meta).join(' ') + ' unchanged theme exactly preserves application styles', () => { const old = baseline.computed.find(r => r.theme === theme.id && r.mode === mode && r.width === width && r.panel === panel); assert.ok(old, 'Matching frozen baseline required'); assert.deepEqual(row.styles, old.styles); assert.deepEqual(row.palette, old.palette); });
          }
          if (signature.includes(theme.id)) {
            await captureLayout(page, meta);
            if (!before) await captureContrast(page, meta);
            if (reps.includes(panel) && !computedOnly) { await frame(page, panel); await shot(page, [before ? 'before' : 'after', theme.id, mode, panel, width].join('-')); }
            if (full && !before) await panelShot(page, meta);
          }
        }
        if (!before && signature.includes(theme.id) && !targetPanels) {
          if (width === 320) await page.setViewportSize({ width, height: 568 });
          await popup(page, { theme: theme.id, mode, width });
          if (width === 320) await page.setViewportSize({ width, height: 844 });
          if (full || extendedSmoke) { await modelDialog(page, { theme: theme.id, mode, width }); await fontFallback(page, { theme: theme.id, mode, width }); }
          if (width === 320) for (const panel of reps) {
            await open(page, panel); await textScale(page, panel, true); await captureLayout(page, { theme: theme.id, mode, width, panel, text: '200%' }); await textScale(page, panel, false);
          }
          if (full || extendedSmoke) { await open(page, 'panel-main'); await page.locator('#chat-input').fill('Please help me review C:\\Users\\Studio\\' + 'A very long project folder\\'.repeat(15)); await captureLayout(page, { theme: theme.id, mode, width, panel: 'panel-main', state: 'long unsent path' }); await page.locator('#chat-input').fill(''); }
        }
      }
      await check(mode + ' ' + width + ' inspection does not persist preferences or perform operations', async () => { assert.equal(await page.evaluate(() => window.__themePreferenceWrites.length), 0); assert.deepEqual(run.calls.filter(c => !['GET', 'HEAD'].includes(c.method)), []); });
    } finally { report.errors.push(...run.errors); report.sessions.push({ mode, width, mutations: run.calls.filter(c => !['GET', 'HEAD'].includes(c.method)) }); await run.context.close(); }
  }
  if (full && !before) for (const width of [390, 900]) for (const mode of ['modern', 'classic']) {
    const run = await makePage(browser, width, 'emeraldLight');
    try { await setup(run, mode, width); for (const theme of signature) { await run.page.evaluate(id => applyTheme(id), theme); for (const panel of reps) { await open(run.page, panel); await captureLayout(run.page, { theme, mode, width, panel }); } await popup(run.page, { theme, mode, width }); } }
    finally { report.errors.push(...run.errors); report.sessions.push({ mode, width, mutations: run.calls.filter(c => !['GET', 'HEAD'].includes(c.method)) }); await run.context.close(); }
  }
}
async function previewAndPreferenceChecks(browser) {
  const run = await makePage(browser, 1440, 'midnight', { preserveSettingsOnReload: true }), page = run.page;
  try {
    await page.evaluate(visibleScript); await open(page, 'panel-settings');
    const themes = await page.evaluate(() => TLIThemes.themes.map(t => ({ ...t })));
    const initial = await page.evaluate(() => { const saved = { ...JSON.parse(localStorage.getItem('tli_settings')), teachingOn: true, defaultTemp: '0.45', fixtureFuturePreference: { keep: true } }; localStorage.setItem('tli_settings', JSON.stringify(saved)); window.__writes = []; const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (this === localStorage && key === 'tli_settings') window.__writes.push(value); return original.apply(this, arguments); }; return saved; });
    await check('Gallery starts with exactly eight signature themes and light/dark groups', async () => { assert.equal(await page.locator('[data-theme-filter="signature"]').getAttribute('aria-pressed'), 'true'); assert.deepEqual((await page.locator('[data-theme-choice]:not([hidden])').evaluateAll(es => es.map(e => e.dataset.themeChoice))).sort(), [...signature].sort()); });
    const rootTokens = await page.evaluate(keys => Object.fromEntries(keys.map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])), [...palette, ...tokens]);
    for (const filter of ['light', 'dark', 'signature', 'all']) await check('Keyboard gallery filter ' + filter + ' has no preference side effect', async () => {
      const button = page.locator('[data-theme-filter="' + filter + '"]'); await button.focus(); await page.keyboard.press('Enter');
      const expected = themes.filter(t => filter === 'all' || (filter === 'signature' ? t.signature : filter === 'new' ? t.collection === 'new' : t.tone === filter)).map(t => t.id).sort();
      assert.deepEqual((await page.locator('[data-theme-choice]:not([hidden])').evaluateAll(es => es.map(e => e.dataset.themeChoice))).sort(), expected); assert.equal(await page.evaluate(() => window.__writes.length), 0);
    });
    for (const theme of themes) await check(theme.id + ' unselected preview uses its own real tokens without leakage', async () => {
      const preview = await page.locator('.tli-theme-preview[data-theme="' + theme.id + '"]').evaluate((e, keys) => Object.fromEntries(keys.map(k => [k, getComputedStyle(e).getPropertyValue(k).trim()])), [...palette, ...tokens]);
      await page.evaluate(id => applyTheme(id), theme.id);
      const applied = await page.evaluate(keys => Object.fromEntries(keys.map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])), [...palette, ...tokens]);
      assert.deepEqual(preview, applied); report.previews.push({ theme: theme.id, tokens: preview });
    });
    await page.evaluate(() => applyTheme('midnight')); assert.deepEqual(await page.evaluate(keys => Object.fromEntries(keys.map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])), [...palette, ...tokens]), rootTokens);
    for (const theme of themes) await check(theme.id + ' deliberate selection writes once and preserves other settings', async () => {
      const card = page.locator('[data-theme-choice="' + theme.id + '"]'); const old = await page.evaluate(() => window.__writes.length);
      await card.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme.id);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings'))), { ...initial, defaultTheme: theme.id });
      const after = await page.evaluate(() => window.__writes.length); assert.equal(after - old, 1); await card.click(); assert.equal(await page.evaluate(() => window.__writes.length), after);
    });
    for (const [saved, applied] of [['cloud', 'cloudLight'], ['emeraldDark', 'midnight'], ['unknown-future-theme', 'emeraldLight']]) await check(saved + ' legacy or unknown preference is rendered without rewriting', async () => {
      await page.evaluate(value => localStorage.setItem('tli_settings', JSON.stringify(value)), { ...initial, defaultTheme: saved }); await page.reload({ waitUntil: 'load' }); await page.waitForFunction(id => document.documentElement.dataset.theme === id, applied); assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings'))), { ...initial, defaultTheme: saved });
    });
    await open(page, 'panel-settings'); await page.locator('[data-theme-filter="all"]').click();
    await check('Rejected theme save preserves stored settings, visible theme and selected choice', async () => {
      const previous = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, settings: localStorage.getItem('tli_settings') }));
      await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key) { if (this === localStorage && key === 'tli_settings') throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); return original.apply(this, arguments); }; });
      await page.locator('[data-theme-choice="midnight"]').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), previous.theme); assert.equal(await page.evaluate(() => localStorage.getItem('tli_settings')), previous.settings); assert.equal(await page.locator('#settings-theme').inputValue(), previous.theme); assert.match(await page.locator('#settings-theme-status').textContent(), /could not be saved/i);
    });
  } finally { report.errors.push(...run.errors); report.sessions.push({ state: 'gallery', mutations: run.calls.filter(c => !['GET', 'HEAD'].includes(c.method)) }); await run.context.close(); }
}
async function gradientProbes(browser) {
  const run = await makePage(browser, 1440, 'emeraldLight'), page = run.page;
  try {
    await page.evaluate(visibleScript);
    const grid = 'repeating-linear-gradient(0deg,transparent 0,transparent 31px,rgba(120,221,140,.025) 32px),repeating-linear-gradient(90deg,transparent 0,transparent 31px,rgba(120,221,140,.025) 32px)';
    for (const spec of [
      { name: 'Positioned opaque gradient bounds pass dark text', background: '#fff', image: 'linear-gradient(120deg,#fff 0%,#ddd 55%)', color: '#111', result: 'pass' },
      { name: 'Foreground between gradient extremes fails', background: '#fff', image: 'linear-gradient(120deg,#000 0%,#fff 55%)', color: '#777', result: 'fail' },
      { name: 'RGBA gradient composites over the opaque base', background: '#fff', image: 'linear-gradient(120deg,rgba(0,0,0,.06),rgba(0,0,0,.12))', color: '#111', result: 'pass' },
      { name: 'Foreground between alpha-composited extrema fails', background: '#fff', image: 'linear-gradient(120deg,rgba(0,0,0,0),rgba(0,0,0,1))', color: '#777', result: 'fail' },
      { name: 'Legacy AI pill radial alpha is bounded over its base', background: '#f7faf8', image: 'radial-gradient(circle at top left,rgba(8,120,88,.10) 0%,transparent 60%)', color: '#1b3028', result: 'pass' },
      { name: 'Foreground between radial alpha-composited extrema fails', background: '#fff', image: 'radial-gradient(circle at top left,rgba(0,0,0,1) 0%,transparent 60%)', color: '#777', result: 'fail' },
      { name: 'Terminal grid maximum overlap passes light text', background: '#09140e', image: grid, color: '#bdd3c2', result: 'pass' },
      { name: 'Foreground inside Terminal grid luminance interval fails', background: '#09140e', image: grid, color: 'rgb(11,25,17)', result: 'fail' },
      { name: 'Unsupported three-stop gradient requires review', background: '#fff', image: 'linear-gradient(120deg,#fff,#ddd,#aaa)', color: '#111', result: 'review' },
      { name: 'Stronger unvalidated grid alpha requires review', background: '#09140e', image: grid.replaceAll('.025', '.5'), color: '#bdd3c2', result: 'review' },
    ]) {
      await page.evaluate(spec => { document.getElementById('signature-gradient-probe')?.remove(); const el = document.createElement('div'); el.id = 'signature-gradient-probe'; el.textContent = 'Synthetic contrast evidence'; Object.assign(el.style, { position: 'fixed', zIndex: '2147483647', left: '0', top: '0', width: '400px', padding: '20px', font: '14px sans-serif', backgroundColor: spec.background, backgroundImage: spec.image, color: spec.color }); document.body.append(el); }, spec);
      const result = await contrast(page, 'signature-gradient-probe'); report.gradientProbes ||= []; report.gradientProbes.push({ ...spec, ...result });
      await check(spec.name, () => { if (spec.result === 'review') assert.ok(result.review.length > 0); else { assert.equal(result.review.length, 0); assert.ok(result.gradientChecks.length > 0); if (spec.result === 'pass') assert.equal(result.findings.length, 0); else { assert.ok(result.findings.length > 0); assert.equal(result.findings[0].ratio, 1); } } });
    }
    await page.evaluate(() => document.getElementById('signature-gradient-probe').remove());
    for (const theme of await page.evaluate(() => TLIThemes.themes.map(t => t.id))) {
      await page.evaluate(id => applyTheme(id), theme);
      const result = await contrast(page, '.main-region > header'); report.contrast.push({ theme, panel: 'shell-header', ...result });
      await check(theme + ' entire header including legacy AI pill has bounded readable contrast', () => { assert.deepEqual(result.findings, []); assert.deepEqual(result.review, []); });
    }
  } finally { report.errors.push(...run.errors); report.sessions.push({ state: 'gradient-probes', mutations: run.calls.filter(c => !['GET', 'HEAD'].includes(c.method)) }); await run.context.close(); }
}
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { if (!before) await gradientProbes(browser); if (!probesOnly) { await matrix(browser); if (!before) await previewAndPreferenceChecks(browser); } }
  catch (e) { report.errors.push(String(e.stack || e)); }
  finally {
    await browser.close(); report.source_after = fingerprintFiles(source); report.source_unchanged = JSON.stringify(report.source_before) === JSON.stringify(report.source_after);
    if (!before && baseline && !probesOnly && !targetPanels) for (const mode of ['modern', 'classic']) {
      const rows = report.computed.filter(r => signature.includes(r.theme) && r.mode === mode && r.width === 1440 && r.panel === 'panel-dashboard2');
      await check(mode + ' signature styles visibly vary beyond accent colors', () => { const values = fields => new Set(rows.map(r => JSON.stringify(fields.map(field => r.styles[field[0]]?.[field[1]])))).size; assert.equal(rows.length, 8); for (const row of rows) for (const selector of ['#panel-dashboard2 .page-title', '.dashboard-attention', '.nd-vital__val']) assert.ok(row.styles[selector], selector + ' must be an actual product element'); assert.ok(values([['#panel-dashboard2 .page-title', 'fontFamily']]) >= 3, 'Three actual heading font treatments'); assert.ok(values([['.dashboard-attention', 'borderTopLeftRadius']]) >= 3, 'Different actual card geometry'); assert.ok(values([['.dashboard-attention', 'boxShadow']]) >= 3, 'Different actual card depth'); });
    }
    report.summary = { checks: report.checks.length, failures: report.checks.filter(c => !c.passed).length, layouts: report.layouts.length, screenshots: report.screenshots.length, contrastFailures: report.contrast.reduce((n, r) => n + r.findings.length, 0), contrastReview: report.contrast.reduce((n, r) => n + r.review.length, 0), computed: report.computed.length, previews: report.previews.length, errors: report.errors.length, mutations: report.sessions.reduce((n, s) => n + s.mutations.length, 0), sourceUnchanged: report.source_unchanged };
    report.passed = report.summary.failures === 0 && report.summary.errors === 0 && report.summary.mutations === 0 && report.source_unchanged;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.summary)); if (!report.passed) process.exitCode = 1;
  }
}
main();
