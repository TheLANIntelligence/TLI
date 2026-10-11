/*
 * Exercise the real SPA with stateful, intercepted onboarding responses.
 * No application server, model download, inference, or device action runs.
 * Usage: node scripts/verify_onboarding_browser.cjs [--quick] [--source PATH] [--only REGEX]
 * Requires Playwright and a local Edge installation, as the anniversary suite does.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixtures: baseFixtures, layout, fingerprintFiles, source } = require('./verify_anniversary_ui_browser.cjs');

const output = path.join(path.resolve(__dirname, '..'), 'build_work', 'onboarding-ui', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });
const reports = [];
const onlyIndex = process.argv.indexOf('--only');
const caseFilter = onlyIndex < 0 ? null : new RegExp(process.argv[onlyIndex + 1]);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const aiMutation = /^\/api\/ai\/(?:model\/download(?:\/cancel)?|models\/(?:select|check))$/;
const allowedMutation = /^(?:\/system\/(?:onboarding\/(?:start|complete)|node\/name|pin\/(?:set|verify))|\/device\/nickname|\/api\/ai\/(?:model\/download(?:\/cancel)?|models\/(?:select|check)))$/;
const missingRuntime = { ok: true, healthy: false, running: false, model_exists: false, exists: false, state: 'missing_model', status: 'missing', provider: 'bundled', selected_preset: 'standard', active_preset: 'standard' };
const now = new Date().toISOString();
const model = {
  id: 'standard', name: 'Everyday local AI', description: 'Synthetic model for onboarding verification.',
  filename: 'fixture-only.gguf', size_human: '2 GB', size_gb: 2, size_bytes: 2147483648,
  ram_gb: 8, min_ram_gb: 8, quantization: 'Q4_K_M', is_selected: true,
  running: false, downloaded: false, installation_complete: false,
  compatibility: { state: 'compatible', checked_at: now, reasons: ['Meets conservative resource estimates.'], selectable: true, download_allowed: true, installation: { complete: false, components: [] } },
};

function json(body, status = 200) { return { status, contentType: 'application/json', body: JSON.stringify(body) }; }
function mutations(run, pathname) { return run.calls.filter(c => c.method === 'POST' && (!pathname || c.path === pathname)); }
function count(run, pathname, method = 'POST') { return run.calls.filter(c => c.method === method && c.path === pathname).length; }
const next = page => page.locator('#tli-onboard-next');

// The existing anniversary makePage intentionally marks onboarding complete and
// rejects mutations. Share its real-SPA fixtures and layout checks, but preserve
// fresh-install semantics here and allow only explicit synthetic setup requests.
async function makePage(browser, options = {}) {
  const { width = 1440, theme = 'midnight', seen = false, complete = false, pinEnabled = false, aiReady = false, installed = false, overrides = {}, height = 1000 } = options;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { complete, started: false, pinEnabled, aiReady, name: 'Studio', download: { ok: true, status: 'idle', state: 'idle', in_progress: false, active: false } };
  const run = { context, state, calls: [], errors: [], unknown: [], external: [], overrides };
  await context.addInitScript(({ theme, seen }) => {
    if (localStorage.getItem('fixture_initialized')) return;
    localStorage.setItem('fixture_initialized', '1');
    if (seen) localStorage.setItem('tli_onboard_seen_v1', '1');
    localStorage.setItem('tli_settings', JSON.stringify({ defaultTheme: theme, searchEnabled: false, defaultBrain: 'bundled' }));
    sessionStorage.setItem('tli_session_unlocked', '1');
  }, { theme, seen });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = decodeURIComponent(url.pathname);
    let body = null;
    try { body = request.postDataJSON(); } catch {}
    const call = { method: request.method(), path: pathname, body, at: Date.now() };
    run.calls.push(call);
    if (url.hostname !== 'tli-ui.test') { run.external.push(url.origin + pathname); return route.abort('blockedbyclient'); }
    const file = path.resolve(source, 'frontend', '.' + (pathname === '/' ? '/index.html' : pathname));
    if (['GET', 'HEAD'].includes(call.method) && file.startsWith(path.join(source, 'frontend') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    }
    const override = run.overrides[`${call.method} ${pathname}`] ?? run.overrides[pathname];
    if (override !== undefined) {
      const response = typeof override === 'function' ? await override({ run, call, request }) : override;
      if (response !== undefined) return route.fulfill(response && Object.hasOwn(response, 'contentType') ? response : json(response));
    }
    if (call.method === 'POST') {
      if (!allowedMutation.test(pathname)) return route.fulfill(json({ ok: false, detail: 'Synthetic fixture: operation prohibited.' }, 409));
      if (pathname === '/system/onboarding/start') state.started = true;
      if (pathname === '/system/onboarding/complete') state.complete = true;
      if (pathname === '/system/pin/set') state.pinEnabled = true;
      if (pathname === '/system/node/name') state.name = body.name;
      if (pathname === '/api/ai/model/download') state.download = { ok: true, status: 'downloading', state: 'downloading', in_progress: true, active: true, bytes_done: 32, bytes_total: 100, progress: 32, preset_id: 'standard' };
      if (pathname === '/api/ai/model/download/cancel') state.download = { ok: true, status: 'cancelled', state: 'cancelled', in_progress: false, active: false };
      if (/\/models\/(?:select|check)$/.test(pathname)) { state.aiReady = true; return route.fulfill(json({ ok: true, healthy: true })); }
      return route.fulfill(json({ ok: true, node_name: state.name, ...((pathname === '/api/ai/model/download') ? { status: 'started', preset_id: 'standard' } : {}) }));
    }
    const fresh = {
      '/system/onboarding/status': { complete: state.complete, started: state.started },
      '/system/pin/status': { enabled: state.pinEnabled },
      '/agent/ping': { ...baseFixtures['/agent/ping'], node_name: state.name },
      '/system/node': { ...baseFixtures['/system/node'], node_name: state.name },
      '/api/ai/model/download/status': state.download,
      '/api/ai/model/progress': state.download,
      '/api/ai/models/presets': { ok: true, active: 'standard', presets: [{ ...model, running: state.aiReady, is_active: state.aiReady, downloaded: state.aiReady || installed, installation_complete: state.aiReady || installed, compatibility: { ...model.compatibility, installation: { complete: state.aiReady || installed, components: [] } } }] },
      '/system/summary': { ok: true, ram_gb: 32, total_ram_gb: 32, cpu: '8-core processor', os: 'Windows', free_disk_gb: 130 },
      '/setup/autodetect': { ok: true, ai: { available: aiReady, healthy: aiReady }, devices: [], nodes: [], lan_ip: '192.0.2.10' },
      '/health/llm': { ok: false, healthy: false, online: false },
      '/health/lmstudio/report': { ok: false, healthy: false, online: false, models: [] },
      '/device/nickname': { nickname: state.name },
    };
    if (!state.aiReady) for (const key of ['/api/ai/status', '/api/ai/bundled/status', '/api/ai/model/info']) fresh[key] = { ...missingRuntime, exists: installed, model_exists: installed };
    const response = fresh[pathname] ?? baseFixtures[pathname];
    if (response !== undefined) return route.fulfill(json(response));
    run.unknown.push(pathname);
    return route.fulfill(json({ ok: false, detail: 'Synthetic service unavailable.' }, 503));
  });
  run.page = await context.newPage();
  run.page.setDefaultTimeout(6000);
  run.page.on('pageerror', error => run.errors.push(error.stack || error.message));
  await run.page.goto('http://tli-ui.test/', { waitUntil: 'load' });
  await run.page.waitForFunction(() => typeof window.TLIOnboarding?.open === 'function');
  if (!complete) {
    await run.page.locator('#tli-onboard').waitFor({ state: 'visible' });
    await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next')?.disabled);
  }
  return run;
}

async function waitStep(run, step) {
  await run.page.waitForFunction(step => document.querySelector('#tli-onboard')?.dataset.step === String(step), step);
  const selectors = ['#tli-onboard-next', '#onboard-node-name', '[data-onboard-security]', '#onboard-ai-refresh', '[data-onboard-destination]'];
  if (step !== 2 || !run.state.pinEnabled) await run.page.locator(selectors[step]).first().waitFor({ state: 'visible' });
  if (step === 0) assert.match(await next(run.page).innerText(), /begin/i);
}
async function reachAccess(run) {
  await next(run.page).click(); await waitStep(run, 1);
  await run.page.locator('#onboard-node-name').fill('My creative studio');
  await next(run.page).click(); await waitStep(run, 2);
}
async function reachAI(run) {
  await reachAccess(run);
  const open = run.page.locator('[data-onboard-security="open"]');
  if (await open.count()) await open.click();
  await next(run.page).click(); await waitStep(run, 3);
  await run.page.waitForFunction(() => !!document.querySelector('#onboard-ai-action') || /ready/i.test(document.querySelector('#tli-onboard-dyn')?.textContent || ''));
}
async function reachLaunch(run) {
  await reachAI(run);
  await next(run.page).click(); await waitStep(run, 4);
}
async function noCompletion(run) {
  assert.equal(count(run, '/system/onboarding/complete'), 0, 'Incomplete setup must not attempt completion');
  assert.equal(await run.page.locator('#tli-onboard').isVisible(), true, 'Incomplete setup remains visible');
  assert.notEqual(await run.page.evaluate(() => localStorage.getItem('tli_onboard_seen_v1')), '1', 'Failed setup must not store a completion hint');
}
async function errorVisible(run) {
  await run.page.waitForFunction(() => !!document.querySelector('#tli-onboard-status')?.textContent.trim());
  assert.equal(await run.page.locator('#tli-onboard-status').isVisible(), true);
}
async function runCase(browser, name, options, work) {
  if (caseFilter && !caseFilter.test(name)) return;
  const run = await makePage(browser, options);
  const report = { name, passed: false };
  try {
    await work(run);
    assert.deepEqual(run.errors, [], 'SPA page errors');
    assert.deepEqual(mutations(run).filter(c => !allowedMutation.test(c.path)), [], 'Unexpected action requests');
    report.passed = true;
  } catch (error) {
    report.error = error.stack || error.message;
    await run.page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
  } finally {
    Object.assign(report, { calls: run.calls, errors: run.errors, unknown: [...new Set(run.unknown)], blockedExternal: [...new Set(run.external)] });
    reports.push(report);
    await run.context.close();
    console.log(`${report.passed ? 'PASS' : 'FAIL'} ${name}${report.error ? '\n' + report.error : ''}`);
  }
}

async function assertFocusTrap(page) {
  const candidates = await page.locator('#tli-onboard').evaluate(root => [...root.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').length);
  assert.ok(candidates > 1, 'Dialog has keyboard controls');
  await page.locator('#tli-onboard-close').focus();
  for (let i = 0; i < candidates + 2; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#tli-onboard').contains(document.activeElement)), true, 'Tab focus escapes onboarding');
  }
  for (let i = 0; i < candidates + 2; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#tli-onboard').contains(document.activeElement)), true, 'Reverse Tab focus escapes onboarding');
  }
}

async function main() {
  const hashesAtStart = fingerprintFiles(source);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await runCase(browser, 'fresh-install-without-ai', {}, async run => {
      assert.equal(mutations(run).length, 0, 'Welcome must not mutate host settings');
      await reachLaunch(run);
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0, 'AI setup must require an explicit action');
      assert.equal(count(run, '/system/pin/set'), 0, 'Open access must not set a PIN');
      assert.equal(mutations(run)[0].path, '/system/onboarding/start', 'Persist onboarding start before changing settings');
      assert.match(await run.page.locator('#onboard-summary').innerText(), /My creative studio/, 'Summary reflects the saved computer name');
      assert.match(await run.page.locator('#tli-onboard-dyn').innerText(), /not (?:ready|set up|downloaded)|later|needs|available after|download|not configured|setup pending/i, 'Missing AI must be disclosed');
      assert.equal(await run.page.locator('[data-onboard-destination="dashboard"]').getAttribute('aria-pressed'), 'true', 'Without ready AI, launch defaults to dashboard');
      await next(run.page).click();
      await run.page.locator('#tli-onboard').waitFor({ state: 'hidden' });
      assert.equal(count(run, '/system/onboarding/complete'), 1);
      assert.equal(run.state.complete, true);
      assert.equal(await run.page.locator('#panel-dashboard2').isVisible(), true);
      await run.page.reload({ waitUntil: 'load' });
      await run.page.waitForTimeout(200);
      assert.equal(await run.page.locator('#tli-onboard').isVisible(), false, 'Persisted completion survives reload');
    });
    await runCase(browser, 'ready-ai-launches-chat', { aiReady: true }, async run => {
      await reachLaunch(run);
      assert.equal(await run.page.locator('[data-onboard-destination="chat"]').getAttribute('aria-pressed'), 'true');
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0);
      await next(run.page).click();
      await run.page.locator('#tli-onboard').waitFor({ state: 'hidden' });
      assert.equal(await run.page.locator('#panel-main').isVisible(), true);
    });
    await runCase(browser, 'server-overrides-browser-seen', { seen: true }, async run => {
      await waitStep(run, 0);
      assert.equal(await run.page.locator('#tli-onboard').isVisible(), true);
    });
    await runCase(browser, 'server-completion-without-browser-hint', { complete: true }, async run => {
      await run.page.waitForTimeout(250);
      assert.equal(await run.page.locator('#tli-onboard').isVisible(), false);
      assert.equal(mutations(run).length, 0);
    });
    await runCase(browser, 'unavailable-status-can-retry', { overrides: { 'GET /system/onboarding/status': json({ ok: false, detail: 'Synthetic status unavailable.' }, 503) } }, async run => {
      await errorVisible(run);
      assert.equal(mutations(run).length, 0);
      assert.match(await next(run.page).innerText(), /try|retry/i);
      delete run.overrides['GET /system/onboarding/status'];
      await next(run.page).click(); await waitStep(run, 0);
      assert.equal(await run.page.locator('#tli-onboard-status').innerText(), '');
    });
    await runCase(browser, 'theme-preview-persists', {}, async run => {
      await next(run.page).click(); await waitStep(run, 1);
      await run.page.locator('[data-onboard-theme="emeraldLight"]').click();
      assert.equal(await run.page.evaluate(() => document.documentElement.dataset.theme), 'emeraldLight');
      assert.equal(await run.page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings')).defaultTheme), 'emeraldLight');
      await run.page.locator('[data-onboard-theme="midnight"]').click();
      assert.equal(await run.page.evaluate(() => document.documentElement.dataset.theme), 'midnight');
      assert.equal(await run.page.evaluate(() => JSON.parse(localStorage.getItem('tli_settings')).defaultTheme), 'midnight');
      assert.equal(count(run, '/system/onboarding/complete'), 0);
    });
    await runCase(browser, 'pause-and-resume', {}, async run => {
      await next(run.page).click(); await waitStep(run, 1);
      await run.page.locator('#onboard-node-name').fill('Unfinished studio');
      await run.page.locator('#tli-onboard-close').click();
      await run.page.locator('#tli-onboard').waitFor({ state: 'hidden' });
      assert.equal(count(run, '/system/onboarding/complete'), 0);
      assert.notEqual(await run.page.evaluate(() => localStorage.getItem('tli_onboard_seen_v1')), '1');
      await run.page.evaluate(() => window.TLIOnboarding.open());
      await run.page.locator('#tli-onboard').waitFor({ state: 'visible' });
      await waitStep(run, 1);
      assert.equal(await run.page.locator('#onboard-node-name').inputValue(), 'Unfinished studio');
      await run.page.keyboard.press('Escape');
      await run.page.locator('#tli-onboard').waitFor({ state: 'hidden' });
      assert.equal(count(run, '/system/onboarding/complete'), 0, 'Escape pauses without completion');
    });
    for (const failedPath of ['/system/onboarding/start', '/system/node/name']) {
      await runCase(browser, failedPath.endsWith('start') ? 'start-persistence-failure' : 'name-persistence-failure', { overrides: { [`POST ${failedPath}`]: json({ ok: false, detail: 'Synthetic persistence failure.' }, 503) } }, async run => {
        await next(run.page).click();
        if (!failedPath.endsWith('start')) {
          await waitStep(run, 1);
          await run.page.locator('#onboard-node-name').fill('New studio name');
          await next(run.page).click();
        }
        await errorVisible(run);
        assert.equal(await run.page.locator('#tli-onboard').getAttribute('data-step'), failedPath.endsWith('start') ? '0' : '1');
        await noCompletion(run);
        if (failedPath.endsWith('start')) assert.equal(count(run, '/system/node/name'), 0);
      });
    }
    for (const status of [503, 200]) {
      await runCase(browser, `completion-rejected-${status}`, { overrides: { 'POST /system/onboarding/complete': json({ ok: false, detail: 'Synthetic completion failure.' }, status) } }, async run => {
        await reachLaunch(run); await next(run.page).click(); await errorVisible(run);
        assert.equal(await run.page.locator('#tli-onboard').isVisible(), true);
        assert.equal(await run.page.locator('[data-onboard-destination]').count(), 4);
        assert.notEqual(await run.page.evaluate(() => localStorage.getItem('tli_onboard_seen_v1')), '1');
      });
    }
    await runCase(browser, 'pin-mismatch', {}, async run => {
      await reachAccess(run); await run.page.locator('[data-onboard-security="pin"]').click();
      await run.page.locator('#onboard-pin').fill('123456'); await run.page.locator('#onboard-pin2').fill('654321');
      await next(run.page).click(); await errorVisible(run);
      assert.equal(count(run, '/system/pin/set'), 0); await noCompletion(run);
    });
    for (const suffix of ['set', 'verify']) {
      await runCase(browser, `pin-${suffix}-failure`, { overrides: { [`POST /system/pin/${suffix}`]: json({ ok: false, detail: `Synthetic PIN ${suffix} failure.` }, 403) } }, async run => {
        await reachAccess(run); await run.page.locator('[data-onboard-security="pin"]').click();
        await run.page.locator('#onboard-pin').fill('123456'); await run.page.locator('#onboard-pin2').fill('123456');
        await next(run.page).click(); await errorVisible(run);
        await noCompletion(run);
        assert.equal(count(run, `/system/pin/${suffix}`), 1);
        if (suffix === 'set') assert.equal(count(run, '/system/pin/verify'), 0);
      });
    }
    await runCase(browser, 'pin-success', {}, async run => {
      await reachAccess(run); await run.page.locator('[data-onboard-security="pin"]').click();
      await run.page.locator('#onboard-pin').fill('123456'); await run.page.locator('#onboard-pin2').fill('123456');
      await next(run.page).click(); await waitStep(run, 3);
      assert.deepEqual(mutations(run).filter(c => c.path.startsWith('/system/pin/')).map(c => c.path), ['/system/pin/set', '/system/pin/verify']);
      assert.equal(await run.page.locator('#onboard-pin').count(), 0, 'PIN must not remain in later step DOM');
      const previousMutations = mutations(run).length;
      await run.page.reload({waitUntil:'load'});
      await waitStep(run, 3);
      await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next').disabled);
      assert.equal(mutations(run).length, previousMutations, 'Reload must preserve progress without repeating PIN setup');
      assert.equal(count(run, '/system/onboarding/complete'), 0, 'Setting a PIN must not complete setup after reload');
      assert.equal(await run.page.locator('#onboard-pin').count(), 0);
    });
    await runCase(browser, 'existing-pin-is-preserved', { pinEnabled: true }, async run => {
      await reachAccess(run);
      assert.equal(await run.page.locator('#onboard-pin').count(), 0);
      assert.match(await run.page.locator('#tli-onboard-dyn').innerText(), /already set|existing PIN/i);
      await next(run.page).click(); await waitStep(run, 3);
      assert.equal(mutations(run).filter(c => c.path.startsWith('/system/pin/')).length, 0);
    });
    await runCase(browser, 'pin-lock-focus-takes-priority', {pinEnabled:true}, async run => {
      await reachAI(run);
      await run.page.evaluate(() => window.dispatchEvent(new CustomEvent('tli-session-locked')));
      await run.page.locator('#tli-lock-screen').waitFor({state:'visible'});
      await run.page.waitForFunction(() => document.querySelector('#tli-lock-screen').contains(document.activeElement));
      assert.equal(await run.page.locator('#tli-onboard').evaluate(el => el.inert), true);
      for (let i = 0; i < 5; i++) {
        await run.page.keyboard.press('Tab');
        assert.equal(await run.page.evaluate(() => document.querySelector('#tli-lock-screen').contains(document.activeElement)), true, 'PIN lock retains focus ahead of setup');
      }
      await run.page.locator('#tli-lock-input').fill('123456');
      await run.page.locator('#tli-lock-submit').click();
      await run.page.locator('#tli-lock-screen').waitFor({state:'hidden'});
      await waitStep(run, 3);
      assert.equal(await run.page.locator('#tli-onboard').evaluate(el => el.inert), false);
      assert.equal(await run.page.evaluate(() => document.querySelector('#tli-onboard').contains(document.activeElement)), true);
      assert.equal(count(run, '/system/onboarding/complete'), 0);
    });
    await runCase(browser, 'late-ai-response-after-back', {}, async run => {
      await reachAccess(run); await run.page.locator('[data-onboard-security="open"]').click();
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      let requested = false;
      run.overrides['GET /api/ai/models/presets'] = async () => { requested = true; await pending; return { presets: [model], active: 'standard' }; };
      await next(run.page).click();
      await run.page.waitForTimeout(80);
      assert.equal(requested, true, 'AI discovery has an in-flight request');
      await run.page.locator('#tli-onboard-back').click(); await waitStep(run, 2);
      release(); await run.page.waitForTimeout(200);
      assert.equal(await run.page.locator('[data-onboard-security]').first().isVisible(), true, 'Late result must not overwrite the access step');
      assert.equal(await run.page.locator('#onboard-ai-action').count(), 0);
    });
    await runCase(browser, 'installed-model-activation-is-explicit', { installed: true }, async run => {
      await reachAI(run);
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0);
      assert.match(await run.page.locator('#onboard-ai-action').innerText(), /use/i);
      await run.page.locator('#onboard-ai-action').click();
      await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next').disabled);
      assert.equal(count(run, '/api/ai/models/select'), 1);
      assert.equal(count(run, '/api/ai/models/check'), 0);
      await next(run.page).click(); await waitStep(run, 4);
      assert.equal(await run.page.locator('[data-onboard-destination="chat"]').getAttribute('aria-pressed'), 'true');
    });
    await runCase(browser, 'unconfirmed-activation-is-not-ready', { installed: true, overrides: { 'POST /api/ai/models/select': { ok: true, healthy: false } } }, async run => {
      await reachAI(run); await run.page.locator('#onboard-ai-action').click(); await errorVisible(run);
      await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next').disabled);
      assert.match(await run.page.locator('#tli-onboard-status').innerText(), /not confirmed/i);
      await next(run.page).click(); await waitStep(run, 4);
      assert.equal(await run.page.locator('[data-onboard-destination="dashboard"]').getAttribute('aria-pressed'), 'true');
    });
    await runCase(browser, 'cancel-download-is-explicit', {}, async run => {
      await reachAI(run); await run.page.locator('#onboard-ai-action').click();
      await run.page.locator('#onboard-ai-cancel').waitFor({state:'visible'});
      await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next').disabled);
      assert.equal(count(run, '/api/ai/model/download/cancel'), 0);
      await run.page.locator('#onboard-ai-cancel').click();
      await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next').disabled);
      assert.equal(count(run, '/api/ai/model/download/cancel'), 1);
      assert.match(await run.page.locator('#tli-onboard-dyn').innerText(), /cancelled/i);
    });
    for (const terminal of ['done', 'error', 'cancelled']) {
      await runCase(browser, `download-${terminal}-not-ready`, {}, async run => {
        await reachAI(run);
        assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0);
        await run.page.locator('#onboard-ai-action').click();
        await run.page.locator('#onboard-ai-cancel').waitFor({state:'visible'});
        await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next').disabled);
        assert.equal(count(run, '/api/ai/model/download'), 1, 'Download requires the explicit action');
        const previousPolls = count(run, '/api/ai/model/download/status', 'GET');
        run.state.download = { ok: true, status: terminal, state: terminal, in_progress: false, active: false, error: terminal === 'error' ? 'Synthetic transfer failure.' : null, bytes_done: terminal === 'done' ? 100 : 32, bytes_total: 100 };
        const deadline = Date.now() + 6000;
        while (count(run, '/api/ai/model/download/status', 'GET') <= previousPolls && Date.now() < deadline) await run.page.waitForTimeout(100);
        assert.ok(count(run, '/api/ai/model/download/status', 'GET') > previousPolls, 'Download progress is polled');
        await run.page.waitForTimeout(100);
        await next(run.page).click(); await waitStep(run, 4);
        assert.equal(await run.page.locator('[data-onboard-destination="dashboard"]').getAttribute('aria-pressed'), 'true', 'A terminal download state does not prove runtime readiness');
        assert.equal(count(run, '/api/ai/models/select'), 0, 'Download does not silently activate AI');
        assert.equal(count(run, '/api/ai/models/check'), 0);
      });
    }
    const widths = process.argv.includes('--quick') ? [1440, 390] : [1440, 768, 390, 320];
    for (const width of widths) for (const theme of ['emeraldLight', 'midnight']) {
      await runCase(browser, `layout-${width}-${theme}`, { width, theme, height: width < 500 ? 844 : 1000 }, async run => {
        const views = [];
        for (let step = 0; step < 5; step++) {
          await waitStep(run, step);
          const check = await layout(run.page, 'tli-onboard');
          assert.deepEqual(check.overflow, [], `Controls overflow on step ${step}`);
          assert.ok(check.documentWidth <= check.width + 2, `Page overflows on step ${step}`);
          assert.deepEqual(check.duplicateIds, [], `Duplicate IDs on step ${step}`);
          await assertFocusTrap(run.page);
          assert.equal(await run.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
          const accessibility = await run.page.locator('#tli-onboard').evaluate(root => {
            const durations = value => value.split(',').map(part => parseFloat(part) || 0);
            const animated = [...root.querySelectorAll('*')].filter(el => {
              const css = getComputedStyle(el);
              return durations(css.animationDuration).some(n => n > 0.01) || durations(css.transitionDuration).some(n => n > 0.01);
            }).map(el => el.id || el.className);
            const footer = root.querySelector('.onboarding-footer').getBoundingClientRect();
            return { animated, footerVisible: footer.top >= 0 && footer.bottom <= innerHeight + 2 };
          });
          assert.deepEqual(accessibility.animated, [], 'Reduced motion suppresses onboarding animation and transitions');
          assert.equal(accessibility.footerVisible, true, 'Navigation remains visible at this viewport height');
          await run.page.locator('#tli-onboard-step-title').focus();
          await run.page.locator('.onboarding-content').evaluate(el => { el.scrollTop = 0; });
          await run.page.screenshot({ path: path.join(output, `step-${step}-${width}-${theme}.png`) });
          views.push({ step, ...check });
          if (step === 1) await run.page.locator('#onboard-node-name').fill('My studio');
          if (step === 2) await run.page.locator('[data-onboard-security="open"]').click();
          if (step < 4) await next(run.page).click();
        }
        reports.push({ name: `views-${width}-${theme}`, passed: true, views });
      });
    }
  } finally { await browser.close(); }
  const hashesAtEnd = fingerprintFiles(source);
  const changedDuringRun = [...new Set([...Object.keys(hashesAtStart), ...Object.keys(hashesAtEnd)])].filter(file => hashesAtStart[file] !== hashesAtEnd[file]);
  const report = { source, output, synthetic: true, createdAt: new Date().toISOString(), changedDuringRun, reports, failed: reports.filter(r => !r.passed).map(r => r.name) };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, scenarios: reports.filter(r => !r.views).length, views: reports.reduce((sum, r) => sum + (r.views?.length || 0), 0), failed: report.failed, changedDuringRun }));
  assert.equal(report.failed.length, 0, 'Onboarding browser scenarios failed');
  assert.ok(reports.length > 0, 'No scenarios matched the filter');
  assert.deepEqual(changedDuringRun, [], 'Frontend changed during browser verification; rerun the final candidate');
}

module.exports = { makePage, model, missingRuntime };
if (require.main === module) main().catch(error => { fs.writeFileSync(path.join(output, 'error.txt'), error.stack || error.message); console.error(error); process.exitCode = 1; });
