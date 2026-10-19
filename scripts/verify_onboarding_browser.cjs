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
const music = page => page.locator('#onboard-music-audio');
async function musicPlaying(run) {
  await run.page.waitForFunction(() => {
    const player = document.querySelector('#onboard-music-audio');
    return player && !player.paused && player.readyState >= 2 && player.currentTime > 0 && document.querySelector('#onboard-music-toggle')?.getAttribute('aria-pressed') === 'true';
  });
  assert.equal(await run.page.locator('#onboard-music-toggle').getAttribute('aria-pressed'), 'true');
}
async function musicStopped(run) {
  await run.page.waitForFunction(() => document.querySelector('#onboard-music-audio')?.paused === true && document.querySelector('#onboard-music-toggle')?.getAttribute('aria-pressed') === 'false');
  assert.equal(await run.page.locator('#onboard-music-toggle').getAttribute('aria-pressed'), 'false');
}

// The existing anniversary makePage intentionally marks onboarding complete and
// rejects mutations. Share its real-SPA fixtures and layout checks, but preserve
// fresh-install semantics here and allow only explicit synthetic setup requests.
async function makePage(browser, options = {}) {
  const { width = 1440, theme = 'midnight', seen = false, complete = false, pinEnabled = false, aiReady = false, installed = false, overrides = {}, height = 1000, mediaMode = 'native' } = options;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { complete, started: false, pinEnabled, aiReady, name: 'Studio', download: { ok: true, status: 'idle', state: 'idle', in_progress: false, active: false } };
  const run = { context, state, calls: [], errors: [], unknown: [], external: [], overrides, mediaUnavailable: mediaMode === 'network-failure' };
  await context.addInitScript(({ theme, seen }) => {
    if (localStorage.getItem('fixture_initialized')) return;
    localStorage.setItem('fixture_initialized', '1');
    if (seen) localStorage.setItem('tli_onboard_seen_v1', '1');
    localStorage.setItem('tli_settings', JSON.stringify({ defaultTheme: theme, searchEnabled: false, defaultBrain: 'bundled' }));
    sessionStorage.setItem('tli_session_unlocked', '1');
  }, { theme, seen });
  await context.addInitScript(({ mode }) => {
    // Observe the actual browser player. Only policy/error fixtures replace play;
    // the normal suite still loads and decodes the repository's real MP3.
    const nativePlay = HTMLMediaElement.prototype.play;
    const nativePause = HTMLMediaElement.prototype.pause;
    const players = new Set();
    // CDP evaluation can itself mark userActivation active. Require an actual
    // trusted input event as well so polling never unlocks this policy fixture.
    let trustedGestureSeen = false;
    for (const type of ['pointerdown','mousedown','keydown','click']) {
      window.addEventListener(type, event => { if (event.isTrusted) trustedGestureSeen = true; }, true);
    }
    const fixture = { playCalls: [], pauseCalls: [], snapshot: () => [...players].map(player => ({
      src: player.currentSrc || player.src, paused: player.paused, muted: player.muted,
      volume: player.volume, duration: player.duration, readyState: player.readyState,
      currentTime: player.currentTime, error: player.error?.code || null,
    })) };
    const isIntro = player => /(?:^|\/)tli_intro\.mp3(?:\?|$)/.test(player.currentSrc || player.src || '');
    HTMLMediaElement.prototype.play = function () {
      if (!isIntro(this)) return nativePlay.call(this);
      players.add(this);
      const gesture = trustedGestureSeen && navigator.userActivation.isActive;
      fixture.playCalls.push({ gesture, mode });
      if (mode === 'blocked-until-gesture' && !gesture) {
        return Promise.reject(new DOMException('Synthetic autoplay policy requires a user gesture.', 'NotAllowedError'));
      }
      if (mode === 'failed') return Promise.reject(new DOMException('Synthetic media decode failure.', 'NotSupportedError'));
      return nativePlay.call(this);
    };
    HTMLMediaElement.prototype.pause = function () {
      if (isIntro(this)) { players.add(this); fixture.pauseCalls.push({ time: this.currentTime }); }
      return nativePause.call(this);
    };
    window.__onboardMedia = fixture;
  }, { mode: mediaMode });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = decodeURIComponent(url.pathname);
    let body = null;
    try { body = request.postDataJSON(); } catch {}
    const call = { method: request.method(), path: pathname, body, at: Date.now(), ...(request.headers().range ? {range:request.headers().range} : {}) };
    run.calls.push(call);
    if (url.hostname !== 'tli-ui.test') { run.external.push(url.origin + pathname); return route.abort('blockedbyclient'); }
    if (run.mediaUnavailable && pathname === '/assets/tli_intro.mp3') {
      return route.fulfill({status:404, contentType:'audio/mpeg', body:'Synthetic missing media'});
    }
    const file = path.resolve(source, 'frontend', '.' + (pathname === '/' ? '/index.html' : pathname));
    if (['GET', 'HEAD'].includes(call.method) && file.startsWith(path.join(source, 'frontend') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      if (path.extname(file) === '.mp3' && call.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(call.range);
        if (match) {
          const data = fs.readFileSync(file), start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : data.length - 1, data.length - 1);
          if (start > end) return route.fulfill({status:416, headers:{'content-range':`bytes */${data.length}`}, body:''});
          return route.fulfill({status:206, contentType:'audio/mpeg', headers:{'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${data.length}`}, body:data.subarray(start, end + 1)});
        }
      }
      return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    }
    const override = run.overrides[`${call.method} ${pathname}`] ?? run.overrides[pathname];
    if (override !== undefined) {
      const response = typeof override === 'function' ? await override({ run, call, request }) : override;
      if (response !== undefined) return route.fulfill(response && Object.hasOwn(response, 'contentType') ? response : json(response));
    }
    if (call.method === 'POST') {
      if (!allowedMutation.test(pathname)) return route.fulfill(json({ ok: false, detail: 'Synthetic fixture: operation prohibited.' }, 409));
      if (pathname === '/system/onboarding/start') {
        if (!state.complete) state.started = true;
        return route.fulfill(json({ ok: true, complete: state.complete, started: !state.complete && state.started }));
      }
      if (pathname === '/system/onboarding/complete') {
        state.complete = true; state.started = false;
        return route.fulfill(json({ ok: true }));
      }
      if (pathname === '/system/pin/set') state.pinEnabled = true;
      if (pathname === '/system/node/name') {
        state.name = body.name;
        return route.fulfill(json({ ok: true, node_name: state.name, node_id: baseFixtures['/agent/ping'].node_id }));
      }
      if (pathname === '/device/nickname') {
        state.name = body.nickname;
        return route.fulfill(json({ status: 'ok', nickname: state.name, device_id: 'default-device', node_id: baseFixtures['/agent/ping'].node_id }));
      }
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
      '/status': { ...baseFixtures['/status'], device_nickname: state.name },
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
    const media = await run.page.evaluate(() => ({players:window.__onboardMedia.snapshot(), playCalls:window.__onboardMedia.playCalls, pauseCalls:window.__onboardMedia.pauseCalls})).catch(() => null);
    Object.assign(report, { calls: run.calls, errors: run.errors, unknown: [...new Set(run.unknown)], blockedExternal: [...new Set(run.external)], media });
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
  // Exercise real playback while explicitly suppressing all desktop audio output.
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args:['--mute-audio','--autoplay-policy=no-user-gesture-required'] });
  try {
    await runCase(browser, 'fresh-install-without-ai', {}, async run => {
      assert.equal(mutations(run).length, 0, 'Welcome must not mutate host settings');
      assert.match(await run.page.locator('#tli-onboard-dyn').innerText(), /welcome setup works offline/i);
      await reachAI(run);
      const aiCopy = await run.page.locator('#tli-onboard-dyn').innerText();
      assert.match(aiCopy, /continue offline/i, 'AI setup can be deferred without internet');
      assert.match(aiCopy, /LM Studio/, 'Existing local providers remain an available path');
      await next(run.page).click(); await waitStep(run, 4);
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0, 'AI setup must require an explicit action');
      assert.equal(count(run, '/system/pin/set'), 0, 'Open access must not set a PIN');
      assert.equal(mutations(run)[0].path, '/system/onboarding/start', 'Persist onboarding start before changing settings');
      assert.match(await run.page.locator('#onboard-summary').innerText(), /My creative studio/, 'Summary reflects the saved computer name');
      assert.match(await run.page.locator('#tli-onboard-dyn').innerText(), /not (?:active|ready|set up|downloaded)|later|needs|available after|download|not configured|setup pending/i, 'Missing AI must be disclosed');
      assert.equal(await run.page.locator('[data-onboard-destination="dashboard"]').getAttribute('aria-pressed'), 'true', 'Without ready AI, launch defaults to dashboard');
      await next(run.page).click();
      await run.page.locator('#tli-onboard').waitFor({ state: 'hidden' });
      assert.equal(count(run, '/system/onboarding/complete'), 1);
      assert.equal(run.state.complete, true);
      assert.equal(await run.page.locator('#panel-dashboard2').isVisible(), true);
      await run.page.reload({ waitUntil: 'load' });
      await run.page.waitForTimeout(200);
      assert.equal(await run.page.locator('#tli-onboard').isVisible(), false, 'Persisted completion survives reload');
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0, 'Finishing and reloading must not download or activate AI');
      assert.equal(run.state.aiReady, false, 'Finishing welcome does not claim missing AI is ready');
      assert.deepEqual(run.external, [], 'Welcome completes using only the local host while external requests are blocked');
    });
    await runCase(browser, 'ready-ai-launches-chat', { aiReady: true }, async run => {
      await reachLaunch(run);
      assert.equal(await run.page.locator('[data-onboard-destination="chat"]').getAttribute('aria-pressed'), 'true');
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0);
      await next(run.page).click();
      await run.page.locator('#tli-onboard').waitFor({ state: 'hidden' });
      assert.equal(await run.page.locator('#panel-main').isVisible(), true);
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0, 'Completing welcome preserves the running model without activation or downloads');
      assert.equal(run.state.aiReady, true);
      assert.deepEqual(run.external, [], 'Keeping a ready local model requires no external request');
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
        if (failedPath.endsWith('start')) {
          assert.equal(count(run, '/system/node/name'), 0);
          assert.equal(count(run, failedPath), 1, 'An uncertain start is not retried automatically');
          assert.match(await next(run.page).innerText(), /Check saved setup/);
          const readsBefore = count(run, '/system/onboarding/status', 'GET');
          delete run.overrides[`POST ${failedPath}`];
          await next(run.page).click();
          await run.page.waitForFunction(() => document.querySelector('#tli-onboard-status')?.textContent.includes('Saved setup checked.'));
          assert.equal(count(run, '/system/onboarding/status', 'GET'), readsBefore + 1);
          assert.equal(count(run, failedPath), 1, 'Reconciliation does not repeat start or advance welcome');
          assert.equal(await run.page.locator('#tli-onboard').getAttribute('data-step'), '0');
          await next(run.page).click(); await waitStep(run, 1);
          assert.equal(count(run, failedPath), 2, 'A second start needs a deliberate continuation after checking saved state');
          assert.equal(count(run, '/system/node/name'), 0); await noCompletion(run);
        }
        else {
          assert.equal(count(run, '/system/node/name'), 1, 'An uncertain save is not retried automatically');
          assert.match(await next(run.page).innerText(), /Check saved name/);
          const readsBefore = count(run, '/status', 'GET');
          delete run.overrides[`POST ${failedPath}`];
          await next(run.page).click();
          await run.page.waitForFunction(() => document.querySelector('#tli-onboard-status')?.textContent.includes('Saved name checked.'));
          assert.ok(count(run, '/status', 'GET') > readsBefore, 'Explicit recovery reads the saved canonical name');
          assert.equal(count(run, '/system/node/name'), 1, 'Checking the saved name cannot repeat the write');
          assert.equal(await run.page.locator('#tli-onboard').getAttribute('data-step'), '1');
          assert.equal(await run.page.locator('#onboard-node-name').inputValue(), 'Studio');
          await run.page.locator('#onboard-node-name').fill('Deliberately saved studio');
          await next(run.page).click(); await waitStep(run, 2);
          assert.equal(count(run, '/system/node/name'), 2, 'A second write requires another explicit name submission');
          assert.equal(mutations(run, '/system/node/name')[1].body.name, 'Deliberately saved studio');
          assert.equal(run.state.name, 'Deliberately saved studio');
          await noCompletion(run);
        }
      });
    }
    for (const status of [503, 200]) {
      await runCase(browser, `completion-rejected-${status}`, { overrides: { 'POST /system/onboarding/complete': json({ ok: false, detail: 'Synthetic completion failure.' }, status) } }, async run => {
        await reachLaunch(run); await next(run.page).click(); await errorVisible(run);
        assert.equal(await run.page.locator('#tli-onboard').isVisible(), true);
        assert.equal(await run.page.locator('[data-onboard-destination]').count(), 4);
        assert.notEqual(await run.page.evaluate(() => localStorage.getItem('tli_onboard_seen_v1')), '1');
        assert.equal(count(run, '/system/onboarding/complete'), 1);
        assert.match(await next(run.page).innerText(), /Check saved setup/);
        const readsBefore = count(run, '/system/onboarding/status', 'GET');
        await next(run.page).click();
        await run.page.waitForFunction(() => document.querySelector('#tli-onboard-status')?.textContent.includes('Saved setup checked.'));
        assert.equal(count(run, '/system/onboarding/status', 'GET'), readsBefore + 1);
        assert.equal(count(run, '/system/onboarding/complete'), 1, 'Checking incomplete setup cannot replay completion');
        assert.equal(await run.page.locator('#tli-onboard').isVisible(), true);
        delete run.overrides['POST /system/onboarding/complete'];
        await next(run.page).click();
        await run.page.locator('#tli-onboard').waitFor({state:'hidden'});
        assert.equal(count(run, '/system/onboarding/complete'), 2, 'Completion requires another explicit click after the saved-state check');
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
    await runCase(browser, 'installed-custom-unknown-preferred-over-download', { overrides: {
      'GET /api/ai/models/presets': ({ run }) => ({ ok: true, active: run.state.aiReady ? 'custom-local' : 'standard', presets: [
        model,
        { ...model, id: 'custom-local', name: 'My existing local model', description: 'An installed custom GGUF with compatibility not yet checked.',
          is_selected: false, running: run.state.aiReady, is_active: run.state.aiReady, downloaded: true, installation_complete: true,
          compatibility: { state: 'unknown', checked_at: null, reasons: ['This custom model needs a local compatibility check.'], selectable: false, download_allowed: false, installation: { complete: true, components: [] } } },
      ] }),
      'GET /api/ai/status': ({ run }) => ({ ...missingRuntime, healthy: run.state.aiReady, running: run.state.aiReady, exists: true, model_exists: true, state: run.state.aiReady ? 'ready' : 'stopped', selected_preset: run.state.aiReady ? 'custom-local' : 'standard' }),
    } }, async run => {
      await reachAI(run);
      assert.equal(await run.page.locator('[data-onboard-model="custom-local"]').getAttribute('aria-pressed'), 'true', 'An installed unknown custom model is preferred over the first compatible undownloaded preset');
      assert.equal(await run.page.locator('[data-onboard-model="standard"]').getAttribute('aria-pressed'), 'false');
      assert.match(await run.page.locator('#onboard-ai-action').innerText(), /check and use this model/i);
      assert.equal(await run.page.locator('#onboard-ai-action').isEnabled(), true);
      assert.equal(mutations(run).filter(c => aiMutation.test(c.path)).length, 0, 'Discovery and preselection do not activate or download');
      await run.page.locator('#onboard-ai-action').click();
      await run.page.waitForFunction(() => !document.querySelector('#tli-onboard-next').disabled);
      assert.deepEqual(mutations(run).filter(c => aiMutation.test(c.path)).map(c => ({path:c.path,body:c.body})), [
        { path:'/api/ai/models/check', body:{preset_id:'custom-local'} },
      ], 'Explicit Check and use checks the installed custom model without a separate select or download');
      await next(run.page).click(); await waitStep(run, 4);
      assert.equal(await run.page.locator('[data-onboard-destination="chat"]').getAttribute('aria-pressed'), 'true', 'Confirmed local check enables the chat destination');
      await next(run.page).click();
      await run.page.locator('#tli-onboard').waitFor({state:'hidden'});
      assert.equal(run.state.complete, true);
      assert.equal(count(run, '/api/ai/model/download'), 0);
      assert.equal(count(run, '/api/ai/models/select'), 0);
      assert.equal(count(run, '/api/ai/models/check'), 1);
      assert.deepEqual(run.external, [], 'Using an installed model requires no external request');
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
    await runCase(browser, 'music-native-autoplay-and-single-player', {}, async run => {
      await musicPlaying(run);
      const playback = await music(run.page).evaluate(player => ({duration:player.duration, volume:player.volume, time:player.currentTime, loop:player.loop}));
      assert.ok(Number.isFinite(playback.duration) && playback.duration > 1, 'Bundled MP3 metadata decodes in the real browser');
      assert.ok(playback.volume > 0 && playback.volume <= 0.5, 'Music starts at a restrained volume');
      assert.equal(playback.loop, false, 'The intro ends naturally without an automatic replay');
      await run.page.waitForTimeout(150);
      assert.ok(await music(run.page).evaluate(player => player.currentTime) > playback.time, 'Real media playback advances');
      await reachLaunch(run);
      assert.ok(await music(run.page).evaluate(player => player.currentTime) > playback.time, 'Step changes do not restart the track');
      const observed = await run.page.evaluate(() => window.__onboardMedia.snapshot());
      assert.equal(observed.length, 1, 'Step changes reuse the same audio instance');
      assert.equal(observed.filter(player => !player.paused).length, 1, 'Exactly one soundtrack is playing');
      assert.equal(await run.page.locator('audio[src*="tli_intro.mp3"]').count(), 1);
      await next(run.page).click(); await run.page.locator('#tli-onboard').waitFor({state:'hidden'});
      await musicStopped(run);
    });
    await runCase(browser, 'music-blocked-autoplay-first-gesture', {mediaMode:'blocked-until-gesture'}, async run => {
      await run.page.waitForFunction(() => window.__onboardMedia.playCalls.length > 0);
      await musicStopped(run);
      assert.equal(await run.page.evaluate(() => window.__onboardMedia.playCalls[0].gesture), false);
      assert.match(await run.page.locator('#onboard-music-status').innerText(), /play|start|begin|music/i);
      await next(run.page).click(); await waitStep(run, 1); await musicPlaying(run);
      assert.equal(await run.page.evaluate(() => window.__onboardMedia.playCalls.some(call => call.gesture)), true, 'The retry occurs within the trusted click gesture');
      assert.equal(mutations(run).filter(call => aiMutation.test(call.path)).length, 0);
    });
    await runCase(browser, 'music-user-pause-persists', {}, async run => {
      await musicPlaying(run); await run.page.locator('#onboard-music-toggle').click(); await musicStopped(run);
      assert.equal(await run.page.evaluate(() => JSON.parse(localStorage.getItem('tli_onboard_music_v1')).muted), true);
      const attempts = await run.page.evaluate(() => window.__onboardMedia.playCalls.length);
      await next(run.page).click(); await waitStep(run, 1);
      await run.page.locator('#tli-onboard-back').click(); await waitStep(run, 0);
      await musicStopped(run);
      assert.equal(await run.page.evaluate(() => window.__onboardMedia.playCalls.length), attempts, 'Navigation respects a deliberate pause');
      await run.page.locator('#tli-onboard-close').click();
      await run.page.evaluate(() => window.TLIOnboarding.open()); await waitStep(run, 0); await musicStopped(run);
      await run.page.reload({waitUntil:'load'}); await waitStep(run, 0); await musicStopped(run);
      assert.equal(await run.page.evaluate(() => window.__onboardMedia.playCalls.length), 0, 'Reload respects saved music preference');
      await run.page.locator('#onboard-music-toggle').click(); await musicPlaying(run);
      assert.equal(await run.page.evaluate(() => JSON.parse(localStorage.getItem('tli_onboard_music_v1')).muted), false);
    });
    await runCase(browser, 'music-volume-and-zero-volume', {}, async run => {
      await musicPlaying(run);
      const volume = run.page.locator('#onboard-music-volume');
      await volume.focus(); await volume.press('Home');
      assert.equal(await music(run.page).evaluate(player => player.volume), 0, 'Minimum slider value silences the soundtrack');
      await volume.press('End');
      assert.equal(await music(run.page).evaluate(player => player.volume), 1);
      assert.equal(await run.page.evaluate(() => JSON.parse(localStorage.getItem('tli_onboard_music_v1')).volume), 1);
      await run.page.reload({waitUntil:'load'}); await waitStep(run, 0);
      assert.equal(await volume.inputValue(), '100');
      assert.equal(await music(run.page).evaluate(player => player.volume), 1);
    });
    await runCase(browser, 'music-close-and-reopen-waits-for-gesture', {}, async run => {
      await musicPlaying(run);
      await run.page.locator('#tli-onboard-close').click();
      await run.page.locator('#tli-onboard').waitFor({state:'hidden'}); await musicStopped(run);
      await run.page.evaluate(() => window.TLIOnboarding.open()); await waitStep(run, 0);
      await musicStopped(run);
      await run.page.locator('#onboard-music-toggle').click(); await musicPlaying(run);
      assert.equal(await run.page.evaluate(() => window.__onboardMedia.snapshot().length), 1);
    });
    await runCase(browser, 'music-tab-hide-stops-until-gesture', {}, async run => {
      await musicPlaying(run);
      await run.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {configurable:true, get:()=>true});
        Object.defineProperty(document, 'visibilityState', {configurable:true, get:()=> 'hidden'});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await musicStopped(run);
      await run.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {configurable:true, get:()=>false});
        Object.defineProperty(document, 'visibilityState', {configurable:true, get:()=> 'visible'});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await musicStopped(run);
      await run.page.locator('#onboard-music-toggle').click(); await musicPlaying(run);
    });
    await runCase(browser, 'music-lock-stops-until-gesture', {pinEnabled:true}, async run => {
      await musicPlaying(run);
      await run.page.evaluate(() => window.dispatchEvent(new CustomEvent('tli-session-locked')));
      await run.page.locator('#tli-lock-screen').waitFor({state:'visible'}); await musicStopped(run);
      await run.page.locator('#tli-lock-input').fill('123456'); await run.page.locator('#tli-lock-submit').click();
      await run.page.locator('#tli-lock-screen').waitFor({state:'hidden'}); await musicStopped(run);
      await run.page.locator('#onboard-music-toggle').click(); await musicPlaying(run);
    });
    for (const mediaMode of ['failed', 'network-failure']) {
      await runCase(browser, `music-${mediaMode}-is-nonblocking`, {mediaMode}, async run => {
        await run.page.waitForFunction(() => /unavailable|could not|cannot|unable|failed/i.test(document.querySelector('#onboard-music-status')?.textContent || ''));
        await musicStopped(run);
        assert.equal(await run.page.locator('#onboard-music-status').isVisible(), true);
        await reachLaunch(run); await next(run.page).click();
        await run.page.locator('#tli-onboard').waitFor({state:'hidden'});
        assert.equal(count(run, '/system/onboarding/complete'), 1, 'Audio failure does not block setup completion');
      });
    }
    await runCase(browser, 'music-network-recovery-explicit-retry', {mediaMode:'network-failure'}, async run => {
      await run.page.waitForFunction(() => /unavailable/i.test(document.querySelector('#onboard-music-status')?.textContent || ''));
      await musicStopped(run);
      run.mediaUnavailable = false;
      await run.page.locator('#onboard-music-toggle').click(); await musicPlaying(run);
      assert.ok(count(run, '/assets/tli_intro.mp3', 'GET') >= 2, 'Explicit retry reloads an asset that failed earlier');
    });
    await runCase(browser, 'music-natural-end-needs-explicit-replay', {}, async run => {
      await musicPlaying(run);
      await music(run.page).evaluate(player => { player.currentTime = player.duration - 0.1; });
      await run.page.waitForFunction(() => document.querySelector('#onboard-music-audio').ended);
      await musicStopped(run);
      assert.match(await run.page.locator('#onboard-music-toggle').innerText(), /replay/i);
      const attempts = await run.page.evaluate(() => window.__onboardMedia.playCalls.length);
      await next(run.page).click(); await waitStep(run, 1); await musicStopped(run);
      assert.equal(await run.page.evaluate(() => window.__onboardMedia.playCalls.length), attempts, 'Continue does not restart a finished intro');
      await run.page.locator('#onboard-music-toggle').click(); await musicPlaying(run);
      assert.equal(await music(run.page).evaluate(player => player.currentTime < player.duration / 2), true);
    });
    await runCase(browser, 'music-completed-install-is-silent', {complete:true}, async run => {
      await run.page.waitForTimeout(150);
      assert.equal(await run.page.locator('#tli-onboard').isVisible(), false);
      assert.equal(await music(run.page).evaluate(player => player.paused), true);
      assert.equal(await run.page.evaluate(() => window.__onboardMedia.playCalls.length), 0);
      assert.equal(count(run, '/assets/tli_intro.mp3', 'GET'), 0, 'Completed installs do not fetch onboarding audio');
    });
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
          assert.equal(await run.page.locator('#onboard-music-toggle').isVisible(), true, 'Music control remains available on each step');
          assert.equal(await run.page.locator('#onboard-music-volume').isVisible(), true, 'Volume control remains available at this width');
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
