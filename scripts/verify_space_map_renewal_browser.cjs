/* Actual browser SPA and bundled D3 with a screenshot-shaped synthetic scan.
 * Every request is intercepted. No TLI server, household path, cleanup or AI is used.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
process.argv.push('--label', 'space-map-renewal');
const { makePage, layout, fixtures, source, fingerprintFiles } = require('./verify_anniversary_ui_browser.cjs');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const before = process.argv.includes('--before');
const quick = process.argv.includes('--quick');
const output = path.resolve(arg('--output') || path.join(__dirname, '../build_work/space-map-renewal', (before ? 'before-' : 'after-') + new Date().toISOString().replace(/[:.]/g, '-')));
fs.mkdirSync(output, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  schema_version: 1, synthetic: true, mode: before ? 'before' : 'after', source,
  source_before: fingerprintFiles(source), started_at: new Date().toISOString(),
  checks: [], layouts: [], contrasts: [], screenshots: [], requests: [], errors: [],
  limitations: [
    'Actual Chromium SPA with intercepted synthetic scan responses; no household scans, file opening, file moves or AI calls.',
    'Recorded bytes determine map area. Unknown sizes, drive capacity and grouped paths are distinct.',
    'Touch-sized browser controls and reduced motion are checked; physical touch, assistive-technology and native-platform acceptance are not run.',
    'The historical before mode records the same fixture and appearance without asserting that newly implemented actions exist.'
  ]
};
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const scanRoot = 'C:\\';
const vhdPath = scanRoot + 'iVentoy\\Win10LTSC.vhd';
const groupedBytes = Math.round(22.9 * GiB);
const now = '2026-09-13T16:00:00Z';
function scan() {
  const folder = (name, children) => ({ name, path: scanRoot + name, size: children.reduce((total, child) => total + (child.size_known === false ? 0 : child.size), 0), children });
  const children = [
    { name: 'hiberfil.sys', path: scanRoot + 'hiberfil.sys', size: 25.5 * GiB, protected: true },
    folder('iVentoy', [
      { name: 'Win10LTSC.vhd', path: vhdPath, size: Math.round(7.6 * GiB) },
      { name: 'en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso', path: scanRoot + 'iVentoy\\en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso', size: Math.round(4.6 * GiB) }
    ]),
    folder('Studio projects', Array.from({ length: 310 }, (_, index) => {
      const ext = ['mp4', 'jpg', 'pdf', 'zip', 'gguf', 'wav'][index % 6];
      const name = index === 1 ? 'Extremely long reference filename with spaces and a reviewed build number — portrait of the studio installation 2026-09-13 final approved documentation.pdf' : `Studio reference ${String(index).padStart(3, '0')}.${ext}`;
      return { name, path: scanRoot + 'Studio projects\\' + name, size: Math.round((index === 0 ? 430 : index < 12 ? 5 : .01) * MiB) };
    })),
    folder('Driver installers', [{ name: 'Setup.exe', path: scanRoot + 'Driver installers\\Setup.exe', size: 145 * MiB }]),
    { name: 'Unavailable folder', path: scanRoot + 'Unavailable folder', size: 0, size_known: false, size_partial: true, children: [] },
    ...Array.from({ length: 10 }, (_, index) => ({ name: `empty-${index}.log`, path: scanRoot + `empty-${index}.log`, size: 0 }))
  ];
  return {
    tree: { name: 'Studio system (C:)', path: scanRoot, size: children.reduce((total, child) => total + (child.size_known === false ? 0 : child.size), 0) + groupedBytes, omitted_bytes: groupedBytes, omitted_entries: 17000, size_partial: true, children },
    meta: { root: scanRoot, partial: true, denied: 1, skipped: 38, files: 17324, dirs: 39, entry_limit_hit: true, representation_limited: true, scan_filters: { excluded_names: ['AppData', 'node_modules', '.git'], follow_links: false, max_depth: 18, max_entries: 50000, max_seconds: 15 } }
  };
}
report.fixture_sha256 = crypto.createHash('sha256').update(JSON.stringify(scan())).digest('hex');
fixtures['/visualizer/cleanup/receipts'] = { ok: true, receipts: [] };

async function ready(browser) {
  const run = await makePage(browser, 1440, 'emeraldLight');
  const jobs = new Map(), records = [];
  let serial = 0, malformed = false;
  await run.page.route('**/visualizer/jobs**', route => {
    const request = route.request(), url = new URL(request.url()), parts = url.pathname.split('/').filter(Boolean);
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    records.push({ path: url.pathname, method: request.method(), body });
    let job;
    if (parts.length === 2 && request.method() === 'POST') {
      job = { id: (++serial).toString(16).padStart(32, '0'), host: { id: 'fixture-studio', name: 'Studio' }, operation: 'scan', profile: body.profile, path: body.path, status: 'partial', result_available: true, started_at: now, updated_at: now, finished_at: now, progress: { phase: 'completed', entries_seen: 50000 }, limits: {}, include_excluded: body.include_excluded };
      jobs.set(job.id, job);
    } else job = jobs.get(parts[2]);
    assert.ok(job, 'Synthetic harness only serves a job explicitly started in this test');
    const result = scan(); if (malformed) result.tree.size = 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, protocol: 'storage-jobs-v1', job, ...(parts[3] === 'results' ? { result } : {}) }) });
  });
  await run.page.evaluate(() => {
    window.__mapClipboard = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__mapClipboard.push(value); } } });
    TLIInterface.set('modern'); switchPanel('panel-visualizer');
  });
  await run.page.locator('#visualizerPathInput').fill(scanRoot);
  await run.page.locator('#visualizerScanBtn').click();
  try { await run.page.waitForFunction(() => !!TLIFreeSpace.getState().observation); }
  catch (error) {
    report.setup_failure = { status: await run.page.locator('#visualizerStatus').textContent(), requests: records, errors: run.errors };
    await run.context.close(); throw error;
  }
  return { ...run, records, malformed: () => { malformed = true; } };
}

const menu = page => page.locator('#fs-entry-menu');
const vhd = page => page.locator('button.fs-map-item[aria-label^="Win10LTSC.vhd"]');
const systemFile = page => page.locator('button.fs-map-item[aria-label^="hiberfil.sys"]');
async function settledRightClick(target) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await target.click({ button: 'right' });
}
async function settledClick(target) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await target.click();
}
async function closeActions(page) { if (await menu(page).isVisible()) await page.keyboard.press('Escape'); }
async function mapSurface(page) {
  await page.locator('#fs-mobile-map').evaluate(element => element.click());
  await page.locator('.fs-map-canvas').waitFor({ state: 'visible' });
}
async function check(name, action) {
  try { await action(); report.checks.push({ name, passed: true }); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); throw error; }
}
async function snapshot(run, name, width, theme, mode, save = true) {
  if (!before && name.endsWith('actions')) assert.equal(await menu(run.page).isVisible(), true, `Action popup must actually be visible for ${name}/${mode}/${theme}/${width}`);
  const measured = await layout(run.page, 'panel-visualizer');
  report.layouts.push({ name, width, theme, mode, ...measured });
  assert.equal(measured.duplicateIds.length, 0);
  assert.equal(measured.overflow.length, 0, JSON.stringify(measured.overflow));
  assert.ok(measured.documentWidth <= width + 2, `Document overflow at ${mode}/${theme}/${width}`);
  if (await menu(run.page).isVisible()) {
    const bounds = await menu(run.page).evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, overflow: [...element.querySelectorAll('button,input')].filter(item => { const r = item.getBoundingClientRect(); return r.left < box.left - 2 || r.right > box.right + 2; }).map(item => item.textContent) };
    });
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width + 2 && bounds.bottom <= bounds.height + 2, JSON.stringify(bounds));
    assert.deepEqual(bounds.overflow, []);
  }
  if (save) {
    const file = path.join(output, `${name}-${mode}-${theme}-${width}.png`);
    await run.page.screenshot({ path: file });
    report.screenshots.push({ name, width, theme, mode, file, sha256: hash(file) });
    if (width === 1440 && ['overview', 'inspect-smaller-files', 'expanded-map'].includes(name)) {
      const crop = path.join(output, `${name}-map-close-up-${mode}-${theme}-${width}.png`);
      await run.page.locator('#vis4-treemap-container').screenshot({ path: crop });
      report.screenshots.push({ name: name + '-map-close-up', width, theme, mode, file: crop, sha256: hash(crop), cropped_to: '#vis4-treemap-container' });
    }
  }
}
async function colorContrast(page, theme, mode, width) {
  const results = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixel = (foreground, background) => { context.clearRect(0, 0, 1, 1); context.fillStyle = background; context.fillRect(0, 0, 1, 1); context.fillStyle = foreground; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const luminance = values => values.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
    const targets = ['button.fs-map-item[aria-label^="hiberfil.sys"] .fs-map-tile-label', 'button.fs-map-item[aria-label^="Win10LTSC.vhd"] .fs-map-tile-label', '.fs-map-tile-type', '#fs-entry-menu button'];
    return targets.map(selector => {
      const element = document.querySelector(selector); if (!element?.getClientRects().length) return null;
      const style = getComputedStyle(element); let background = style.backgroundColor;
      if (background === 'rgba(0, 0, 0, 0)' || background === 'transparent') {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const color = getComputedStyle(parent).backgroundColor;
          if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; }
        }
      }
      const bg = luminance(pixel(background, '#fff')), fg = luminance(pixel(style.color, background));
      return { selector, color: style.color, background, ratio: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05) };
    }).filter(Boolean);
  });
  report.contrasts.push({ theme, mode, width, results });
  if (!before) for (const result of results) assert.ok(result.ratio >= 4.45, `${theme}/${mode}: ${result.selector} text contrast ${result.ratio.toFixed(2)}`);
}
function assertNoActions(run) {
  const writes = run.calls.filter(call => !['GET', 'HEAD'].includes(call.method));
  const actions = run.calls.filter(call => /(?:\/cleanup\/(?:execute|preview)|\/visualizer\/delete|\/cleanup\/clean_safe|\/file[s]?\/(?:open|reveal)|\/api\/ai\/chat|\/v1\/chat\/completions)/.test(call.path));
  assert.deepEqual(writes, [], 'Only explicitly requested synthetic storage jobs may use a mutation request');
  assert.deepEqual(actions, [], 'Map navigation, menus and cleanup selection must not execute actions');
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let run;
  try {
    run = await ready(browser); const page = run.page;
    await check('Screenshot-shaped scan retains exact area, unknown sizes, missing paths and explicit observation identity', async () => {
      const fact = await page.evaluate(() => {
        const state = TLIFreeSpace.getState(), canvas = document.querySelector('.fs-map-canvas'), box = canvas.getBoundingClientRect();
        return { mode: state.mode, total: state.mapView.total, raw: state.observation.raw.tree.size, unknown: state.mapView.unknown, aggregate: state.mapView.aggregateBytes, cells: canvas.querySelectorAll('.fs-map-item').length, area: [...canvas.querySelectorAll('.fs-map-item')].reduce((sum, item) => { const r = item.getBoundingClientRect(); return sum + r.width * r.height; }, 0), canvas: box.width * box.height };
      });
      assert.equal(fact.mode, 'map'); assert.equal(fact.total, fact.raw); assert.equal(fact.unknown, 1);
      assert.equal(fact.aggregate, groupedBytes); assert.ok(fact.cells <= 500);
      assert.ok(Math.abs(fact.area / fact.canvas - 1) < .005, JSON.stringify(fact));
      assert.equal(run.records.length, 2); report.initial_map = fact;
    });
    await page.locator('#storage-results').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await snapshot(run, 'overview', 1440, 'emeraldLight', 'modern');
    if (!before) {
      await check('Right click opens exact file actions without selecting cleanup or performing host work', async () => {
        await settledRightClick(vhd(page));
        assert.equal(await menu(page).isVisible(), true);
        assert.match(await page.locator('#fs-menu-title').innerText(), /Win10LTSC\.vhd/);
        assert.ok((await menu(page).innerText()).includes(vhdPath));
        for (const name of ['Copy path', 'Review folder in Files', 'Prepare folder scan', 'Hide from this view', 'Close actions']) assert.equal(await menu(page).getByRole('button', { name, exact: true }).count(), 1);
        assert.equal(await menu(page).locator('input[type="checkbox"]').isChecked(), false);
        assert.equal(run.records.length, 2); assertNoActions(run);
        await snapshot(run, 'file-actions', 1440, 'emeraldLight', 'modern');
        await menu(page).getByRole('button', { name: 'Copy path', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => __mapClipboard), [vhdPath]); await closeActions(page);
      });
      await check('Keyboard context actions, focus movement, Escape and outside dismissal retain a valid invoker', async () => {
        await vhd(page).focus(); await page.keyboard.press('Shift+F10'); assert.equal(await menu(page).isVisible(), true);
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#fs-entry-menu')), true);
        await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#fs-entry-menu')), true);
        await page.keyboard.press('Escape'); assert.equal(await menu(page).isVisible(), false);
        assert.equal(await vhd(page).evaluate(element => element === document.activeElement), true);
        await vhd(page).dispatchEvent('keydown', { key: 'ContextMenu', bubbles: true }); assert.equal(await menu(page).isVisible(), true);
        await page.locator('#fs-map-workbench').dispatchEvent('pointerdown', { bubbles: true });
        assert.equal(await menu(page).isVisible(), false); assert.equal(run.records.length, 2);
      });
      await check('Protected system files and missing-path aggregate never become cleanup candidates', async () => {
        await settledRightClick(systemFile(page));
        const choice = menu(page).locator('input[type="checkbox"]');
        if (await choice.count()) assert.equal(await choice.isEnabled(), false);
        assert.match(await menu(page).innerText(), /protected/i); await closeActions(page);
        await settledRightClick(page.locator('button.fs-map-item[aria-label^="Other indexed contents"]'));
        assert.match(await menu(page).innerText(), /individual|retained|grouped/i);
        for (const name of ['Copy path', 'Review folder in Files']) {
          const button = menu(page).getByRole('button', { name, exact: true });
          if (await button.count()) assert.equal(await button.isEnabled(), false);
        }
        assert.equal(await menu(page).locator('input[type="checkbox"]:enabled').count(), 0);
        await closeActions(page); assertNoActions(run);
      });
      await check('Hide grouped bytes and dominant files rescale an explicitly bounded view and reset without altering observations', async () => {
        const initial = await page.evaluate(() => ({ total: TLIFreeSpace.getState().mapView.total, raw: JSON.stringify(TLIFreeSpace.getState().observation.raw) }));
        const accounting = page.locator('.fs-map-accounting');
        if (!await accounting.evaluate(element => element.open)) await accounting.locator('summary').click();
        assert.equal(await accounting.evaluate(element => element.open), true);
        const hideGrouped = accounting.getByRole('button', { name: 'Hide grouped bytes', exact: true });
        assert.equal(await hideGrouped.isVisible(), true);
        await hideGrouped.click();
        let state = await page.evaluate(() => ({ ...TLIFreeSpace.getState().mapView, model: undefined, rows: undefined }));
        assert.equal(state.hiddenBytes, groupedBytes); assert.equal(state.total, initial.total - groupedBytes); assert.equal(state.matchedTotal, initial.total);
        assert.equal(await page.locator('.fs-map-hidden').isVisible(), true);
        await settledRightClick(systemFile(page)); await menu(page).getByRole('button', { name: 'Hide from this view', exact: true }).click();
        state = await page.evaluate(() => ({ total: TLIFreeSpace.getState().mapView.total, hiddenBytes: TLIFreeSpace.getState().mapView.hiddenBytes, raw: JSON.stringify(TLIFreeSpace.getState().observation.raw) }));
        assert.equal(state.hiddenBytes, groupedBytes + 25.5 * GiB); assert.equal(state.total, initial.total - state.hiddenBytes); assert.equal(state.raw, initial.raw);
        assert.equal(await page.locator('button.fs-map-item[aria-label^="hiberfil.sys"]').count(), 0);
        await snapshot(run, 'inspect-smaller-files', 1440, 'emeraldLight', 'modern');
        await page.getByRole('button', { name: 'Show hidden entries', exact: true }).click();
        assert.equal(await page.evaluate(() => TLIFreeSpace.getState().mapView.total), initial.total);
        assert.equal(await page.evaluate(() => TLIFreeSpace.getState().mapView.hiddenBytes), 0); assert.equal(run.records.length, 2); assertNoActions(run);
      });
      await check('Expanded map and side-by-side list use the same observation and return keyboard focus', async () => {
        const total = await page.evaluate(() => TLIFreeSpace.getState().mapView.total);
        await page.getByRole('button', { name: 'Expand map', exact: true }).click();
        assert.equal(await page.locator('#fs-map-workbench').evaluate(element => element.classList.contains('fs-map-expanded')), true);
        assert.equal(await page.evaluate(() => TLIFreeSpace.getState().mapView.total), total);
        assert.equal(await page.getByRole('button', { name: 'Map beside list', exact: true }).evaluate(element => document.activeElement === element), true);
        await page.locator('.fs-map-canvas').evaluate(element => element.scrollIntoView({ block: 'center' }));
        await snapshot(run, 'expanded-map', 1440, 'emeraldLight', 'modern');
        await page.getByRole('button', { name: 'Map beside list', exact: true }).click();
        assert.equal(await page.locator('#fs-map-workbench').evaluate(element => element.classList.contains('fs-map-expanded')), false);
        assert.equal(run.records.length, 2); assertNoActions(run);
      });
      await check('The file menu prepares a folder and reviews a Files handoff without running a scan or replacing drafts', async () => {
        await settledRightClick(vhd(page)); await menu(page).getByRole('button', { name: 'Prepare folder scan', exact: true }).click();
        assert.equal(await page.locator('#visualizerPathInput').inputValue(), scanRoot + 'iVentoy');
        assert.equal(await page.evaluate(() => TLIFreeSpace.getState().observation.root), scanRoot); assert.equal(run.records.length, 2);
        assert.equal(await page.locator('#storage-results').isVisible(), false, 'Another selected location must hide the previous root and its actions');
        await page.locator('#visualizerPathInput').fill(scanRoot);
        assert.equal(await page.locator('#storage-results').isVisible(), true, 'Selecting the recorded root restores its retained observation without a scan');
        assert.equal(run.records.length, 2);
        await settledRightClick(vhd(page)); await menu(page).getByRole('button', { name: 'Review folder in Files', exact: true }).click();
        assert.equal(await page.locator('#fs-handoff').evaluate(element => element.open), true);
        assert.equal(await page.locator('#fs-handoff-text').innerText(), scanRoot + 'iVentoy');
        await page.locator('#fs-handoff-close').click(); assertNoActions(run);
        await page.locator('#visualizerPathInput').fill(scanRoot);
      });
      await check('Cleanup selection uses the existing reviewed workflow and creates no preview or move automatically', async () => {
        await settledRightClick(vhd(page)); const choice = menu(page).locator('input[type="checkbox"]'); await choice.check();
        assert.equal(await choice.isChecked(), true);
        await menu(page).getByRole('button', { name: 'Review selected files', exact: true }).click();
        assert.match(await page.locator('#cleanup-selection').textContent(), /Win10LTSC\.vhd/);
        assert.equal(await page.locator('#cleanup-execute').isVisible(), false); assertNoActions(run);
        await page.locator('#cleanup-clear').click(); await mapSurface(page);
      });
      await check('Closing the page invalidates detached action callbacks and returning does not start a scan', async () => {
        await settledRightClick(vhd(page));
        await menu(page).getByRole('button', { name: 'Copy path', exact: true }).evaluate(element => { window.__staleMapAction = element; });
        const copied = await page.evaluate(() => __mapClipboard.length);
        await page.evaluate(() => { switchPanel('panel-dashboard2'); window.__staleMapAction.click(); });
        assert.equal(await menu(page).isVisible(), false); assert.equal(await page.evaluate(() => __mapClipboard.length), copied);
        await page.evaluate(() => switchPanel('panel-visualizer')); await mapSurface(page); assert.equal(run.records.length, 2);
      });
      await check('A long exact path has keyboard actions in the narrow list and returns focus to its file', async () => {
        await page.setViewportSize({ width: 320, height: 1000 }); await page.locator('#fs-mobile-list').click();
        await page.locator('#fs-explorer-filters summary').click(); await page.locator('#visualizerSearchInput').fill('Extremely long reference');
        const entry = page.locator('#visualizerTableBody .storage-file-action');
        await entry.focus(); await page.keyboard.press('Shift+F10');
        const expected = scan().tree.children.find(item => item.name === 'Studio projects').children[1].path;
        assert.ok((await menu(page).innerText()).includes(expected));
        await snapshot(run, 'long-path-actions', 320, 'emeraldLight', 'modern');
        await page.keyboard.press('Escape'); assert.equal(await entry.evaluate(element => element === document.activeElement), true);
        await page.locator('#visualizerSearchInput').fill(''); await page.locator('#fs-explorer-filters summary').click();
        await page.setViewportSize({ width: 1440, height: 1000 }); await mapSurface(page); assert.equal(run.records.length, 2); assertNoActions(run);
      });
    }
    const themes = quick ? ['emeraldLight', 'midnight'] : await page.evaluate(() => TLIThemes.themes.map(theme => theme.id));
    for (const mode of ['modern', 'classic']) for (const theme of themes) for (const width of [1440, 320]) {
      await closeActions(page); await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(({ theme, mode }) => { TLIThemes.apply(theme); TLIInterface.set(mode); }, { theme, mode });
      await mapSurface(page); await page.locator('#vis4-treemap-container').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(35);
      const save = ['emeraldLight', 'midnight', 'lavenderLite', 'terminal'].includes(theme);
      await snapshot(run, 'map', width, theme, mode, save);
      if (!before) {
        await vhd(page).click(); await settledClick(page.locator('#fs-selected-actions'));
        await snapshot(run, 'actions', width, theme, mode, save); await colorContrast(page, theme, mode, width); await closeActions(page);
        if (width === 320) {
          await page.locator('#fs-mobile-list').click();
          await settledClick(page.locator('#visualizerTableBody .fs-entry-actions').first());
          await snapshot(run, 'list-actions', width, theme, mode, false); await closeActions(page);
        }
      }
    }
    for (const width of [1024, 768, 390]) for (const mode of ['modern', 'classic']) {
      await closeActions(page); await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(mode => { TLIThemes.apply('emeraldLight'); TLIInterface.set(mode); }, mode);
      await mapSurface(page); await page.locator('#vis4-treemap-container').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await snapshot(run, 'responsive', width, 'emeraldLight', mode, true);
      if (!before) {
        await vhd(page).focus(); await page.keyboard.press('Shift+F10');
        await snapshot(run, 'responsive-actions', width, 'emeraldLight', mode, true); await closeActions(page);
      }
    }
    if (!before) {
      await check('Long names, list pagination, enlarged text and reduced motion retain map and action access', async () => {
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(() => document.querySelector('#panel-visualizer').style.fontSize = '24px');
        await page.locator('#fs-mobile-list').click();
        await page.locator('#fs-page-next').click(); assert.match(await page.locator('#fs-page-label').innerText(), /51/);
        await settledClick(page.locator('#visualizerTableBody .fs-entry-actions').first());
        await snapshot(run, 'enlarged-list-actions', 390, 'emeraldLight', 'classic'); await closeActions(page);
        await page.locator('#fs-page-prev').click();
        await page.evaluate(() => document.querySelector('#panel-visualizer').style.fontSize = '');
      });
      await check('A malformed replacement preserves map accounting and lock prevents retained action callbacks from restoring private data', async () => {
        await page.locator('#visualizerPathInput').fill(scanRoot); const total = await page.evaluate(() => TLIFreeSpace.getState().mapView.total);
        run.malformed(); await page.locator('#visualizerScanBtn').click();
        await page.waitForFunction(() => document.querySelector('#visualizerStatus').textContent.includes('exceed'));
        assert.equal(await page.evaluate(() => TLIFreeSpace.getState().mapView.total), total);
        await mapSurface(page); await settledRightClick(vhd(page));
        await menu(page).getByRole('button', { name: 'Copy path', exact: true }).evaluate(element => { window.__staleLockedMapAction = element; });
        const copied = await page.evaluate(() => __mapClipboard.length);
        await page.evaluate(() => { window.dispatchEvent(new CustomEvent('tli-session-locked')); window.__staleLockedMapAction.click(); });
        assert.equal(await menu(page).isVisible(), false); assert.equal(await page.evaluate(() => __mapClipboard.length), copied);
        assert.equal(await page.locator('#vis4-treemap-container').textContent(), '');
        assert.equal(await page.locator('#visualizerDetailsPath').textContent(), '');
        assert.equal(await page.locator('#fs-map-breadcrumbs').textContent(), '');
        assert.equal(await page.evaluate(() => TLIFreeSpace.getState().observation), null); assertNoActions(run);
      });
    }
    assertNoActions(run); report.errors.push(...run.errors); assert.deepEqual(report.errors, []);
    report.completed = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1;
    if (run) { const file = path.join(output, 'failure.png'); await run.page.screenshot({ path: file }).catch(() => {}); if (fs.existsSync(file)) report.failure_screenshot = { file, sha256: hash(file) }; }
  }
  finally {
    if (run) { report.requests.push(...run.records); report.errors.push(...run.errors.filter(error => !report.errors.includes(error))); await run.context.close(); }
    await browser.close(); report.finished_at = new Date().toISOString();
    report.source_after = fingerprintFiles(source); report.source_unchanged = JSON.stringify(report.source_before) === JSON.stringify(report.source_after);
    if (!report.source_unchanged) { report.completed = false; report.source_error = 'Frontend source changed during the browser run. Repeat against a frozen source.'; process.exitCode = 1; }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ output, completed: report.completed, checks: report.checks.length, layouts: report.layouts.length, screenshots: report.screenshots.length, source_unchanged: report.source_unchanged, error: report.error, source_error: report.source_error }));
})();
