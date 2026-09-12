/* The real SPA with intercepted HTTPS requests and synthetic Vault receipts only.
 * Does not start TLI, read an archive or download a file onto this computer. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (!process.argv.includes('--label')) process.argv.push('--label', 'vault-backups');
const { makePage, fingerprintFiles, source } = require('./verify_anniversary_ui_browser.cjs');
const { contrast, textScale, measuredLayout } = require('./verify_anniversary_themes_browser.cjs');
const output = path.join(__dirname, '../build_work/anniversary-continuity/vault-browser', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });
const report = { source, output, synthetic: true, hashesAtStart: fingerprintFiles(source), behaviors: [], layouts: [], contrast: [], labels: [], calls: [], errors: [], unexpected: [], screenshots: [],
  limitations: ['All network requests are intercepted. No live host, files, passwords, inference or devices are used.', 'The browser download click is prevented and recorded; no archive is downloaded or read.', 'Browser fixtures do not replace physical-phone, assistive-technology, cryptographic or large-archive acceptance.'] };
const protocol = 'tli-vault-backup-v1';
const password = 'synthetic-archive-password';
const vaultPassword = 'synthetic-new-vault-passphrase';
const destination = 'J:\\Synthetic acceptance only\\' + 'Separate Vault recovery folder '.repeat(4) + '\\copy';
const downloadUrl = '/vault/backups/download/' + 'a'.repeat(43);
const caps = { ok: true, protocol, limits: { archive_bytes: 4400000000, file_bytes: 262144000, total_bytes: 4294967296, entries: 10000 }, recovery_available: true };
const receipt = () => ({ ok: true, protocol, checked_at: '2026-09-08T16:32:00Z', created_at: '2026-09-08T16:30:00Z', counts: { file: 12, note: 4, secrets: 3, logins: 2 }, entries: 18, total_bytes: 9283712, checks: { archive_authenticated: true, all_entries_readable: true, entry_hashes: true }, restored: false });
const preparedReceipt = () => ({ ...receipt(), archive_sha256: 'b'.repeat(64), archive_bytes: 9284096, download_url: downloadUrl, expires_in_seconds: 600, downloaded: false });
const reviewedReceipt = () => ({ ...receipt(), review_token: 'r'.repeat(43), destination, reviewed: true, created: false, recovered_owner: 'local', expires_in_seconds: 600 });
const recoveredReceipt = () => ({ ...receipt(), destination, created: true, recovered_owner: 'local', readback: { ok: true, reader: 'current-application', checks: Object.fromEntries(['passphrase_authenticated', 'current_readers', 'exact_content', 'owner_mapping', 'locked_without_sessions', 'files_unchanged'].map(key => [key, true])) } });

async function fixture(browser, width = 1440, theme = 'emeraldLight', opened = true) {
  const run = await makePage(browser, width, theme), { page, context } = run;
  const state = { unlocked: true, prepared: null, calls: [], unexpected: [], faults: new Map(), gates: new Map() };
  state.fail = (method, url, body = { ok: false, detail: 'Synthetic request failed. Existing data was preserved.' }, status = 503) => state.faults.set(`${method} ${url}`, { status, body });
  state.defer = (method, url) => { let release; const promise = new Promise(resolve => { release = resolve; }); const gate = { promise, release }; state.gates.set(`${method} ${url}`, gate); return gate; };
  await context.addInitScript(() => {
    window.__vaultDownloadIntents = [];
    document.addEventListener('click', event => {
      const link = event.target.closest?.('#vb-download');
      if (link) { event.preventDefault(); window.__vaultDownloadIntents.push(link.getAttribute('href')); }
    }, true);
  });
  await context.route('**/vault/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname, key = `${method} ${pathname}`;
    if (url.hostname !== 'tli-ui.test') return route.abort('blockedbyclient');
    state.calls.push({ method, path: pathname }); // Never record upload bytes or passwords.
    const gate = state.gates.get(key); if (gate) { state.gates.delete(key); await gate.promise; }
    const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
    const fault = state.faults.get(key); if (fault) { state.faults.delete(key); return respond(fault.body, fault.status); }
    if (method === 'GET' && pathname === '/vault/status') return respond({ initialized: true, unlocked: state.unlocked, failed_attempts: 0, locked_until: null });
    if (method === 'POST' && pathname === '/vault/lock') { state.unlocked = false; return respond({ ok: true }); }
    if (method === 'POST' && pathname === '/vault/unlock') { state.unlocked = true; return respond({ success: true }); }
    if (method === 'GET' && pathname === '/vault/list') return respond({ files: [] });
    if (method === 'GET' && pathname === '/vault/secrets') return respond({ keys: [] });
    if (method === 'GET' && pathname === '/vault/notes') return respond({ notes: [] });
    if (method === 'GET' && pathname === '/vault/backups/capabilities') return respond(caps);
    if (method === 'POST' && pathname === '/vault/backups/check') return respond({ ...receipt(), checked: true, source_unchanged: true, archive_created: false });
    if (method === 'POST' && pathname === '/vault/backups/create') { state.prepared = preparedReceipt(); return respond(state.prepared); }
    if (method === 'GET' && pathname === '/vault/backups/prepared') return respond(state.prepared ? { ...state.prepared, prepared: true } : { ok: true, protocol, prepared: false });
    if (method === 'DELETE' && pathname === downloadUrl) { state.prepared = null; return respond({ ok: true, discarded: true }); }
    if (method === 'POST' && pathname === '/vault/backups/verify') return respond(receipt());
    if (method === 'POST' && pathname === '/vault/backups/recovery/review') return respond(reviewedReceipt());
    if (method === 'POST' && pathname === '/vault/backups/recovery/create') return respond(recoveredReceipt());
    state.unexpected.push({ method, path: pathname });
    return respond({ ok: false, detail: 'Unexpected synthetic Vault operation refused.' }, 409);
  });
  await page.goto('https://tli-ui.test/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof switchPanel === 'function' && typeof fetchVaultStatus === 'function');
  await page.evaluate(async () => { switchPanel('panel-vault'); await fetchVaultStatus(); });
  await page.evaluate(() => {
    window.__themeAuditVisible = el => {
      if (el.closest('[hidden],.hidden,[aria-hidden="true"]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
        if (Number(getComputedStyle(ancestor).opacity) === 0) return false;
        if (ancestor !== el && ancestor.tagName === 'DETAILS' && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(el)) return false;
      }
      return true;
    };
  });
  if (opened) await open(page);
  return { ...run, state };
}
async function open(page) {
  await page.locator('#vault-backups > summary').click();
  await page.waitForFunction(() => document.getElementById('vb-capability').textContent.includes('are supported'));
  await page.waitForFunction(() => !document.getElementById('vb-check').disabled);
}
async function idle(page) { await page.waitForFunction(() => document.getElementById('vb-stop').hidden); }
async function create(page) {
  await page.locator('#vb-create-password').fill(password);
  await page.locator('#vb-create-confirm').fill(password);
  await page.locator('#vb-scope-confirm').check();
  await page.locator('#vb-create').click();
}
async function archive(page) {
  await page.locator('#vb-file').setInputFiles({ name: 'synthetic.tlivaultbackup', mimeType: 'application/octet-stream', buffer: Buffer.from('SYNTHETIC_ENCRYPTED_ARCHIVE_FIXTURE_ONLY') });
  await page.locator('#vb-archive-password').fill(password);
}
async function review(page) {
  await archive(page);
  await page.locator('#vb-destination').fill(destination);
  await page.locator('#vb-review').click(); await idle(page);
}
async function recover(page) {
  await page.locator('#vb-new-password').fill(vaultPassword);
  await page.locator('#vb-new-confirm').fill(vaultPassword);
  await page.locator('#vb-recovery-confirm').check();
  await page.locator('#vb-recover').click(); await idle(page);
}
async function waitCall(page, state, method, pathname, expected = 1) {
  const until = Date.now() + 5000;
  while (state.calls.filter(call => call.method === method && call.path === pathname).length < expected && Date.now() < until) await page.waitForTimeout(20);
  assert.equal(state.calls.filter(call => call.method === method && call.path === pathname).length, expected, `${method} ${pathname} count`);
}
async function privateClear(page) {
  const value = await page.evaluate(() => ({ values: [...document.querySelectorAll('#vault-backups input:not([type=checkbox])')].map(el => el.value), checked: [...document.querySelectorAll('#vault-backups input[type=checkbox]')].some(el => el.checked), text: document.getElementById('vault-backups').textContent, href: document.getElementById('vb-download').getAttribute('href'), storage: JSON.stringify({ ...localStorage, ...sessionStorage }) }));
  assert.ok(value.values.every(item => !item), 'All private backup inputs must clear');
  assert.equal(value.checked, false, 'Review confirmations must clear');
  assert.equal(value.href, null);
  for (const sensitive of [password, vaultPassword, destination, downloadUrl]) {
    assert.ok(!value.text.includes(sensitive)); assert.ok(!value.storage.includes(sensitive));
  }
}
async function finish(run) {
  for (const gate of run.state.gates.values()) gate.release();
  report.calls.push(...run.state.calls); report.errors.push(...run.errors); report.unexpected.push(...run.state.unexpected);
  report.unexpected.push(...run.calls.filter(call => !['GET', 'HEAD'].includes(call.method)));
  await run.context.close();
}
async function capture(page, name) {
  const viewport = page.viewportSize();
  // The SPA owns a scrolling content region. Expand the viewport around the
  // actual enlarged panel so locator screenshots do not contain clipped blanks.
  const height = await page.locator('#vault-backups').evaluate(el => Math.min(24000, Math.max(1600, el.scrollHeight + 1000)));
  await page.setViewportSize({ width: viewport.width, height });
  await page.evaluate(() => { for (const el of document.querySelectorAll('.main-scroll,#panel-vault')) el.scrollTop = 0; window.scrollTo(0, 0); });
  const file = `${name}.png`;
  await page.locator('#vault-backups').screenshot({ path: path.join(output, file) });
  report.screenshots.push(file);
  await page.setViewportSize(viewport);
}
async function behaviors(browser) {
  async function check(name, action, opened = true) {
    const run = await fixture(browser, 1440, 'emeraldLight', opened);
    try { await action(run); report.behaviors.push({ name, passed: true }); }
    catch (error) { report.behaviors.push({ name, passed: false, error: error.stack }); await run.page.screenshot({ path: path.join(output, `failed-${name.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }); }
    finally { await finish(run); }
  }
  await check('Opening support performs no private check or mutation', async ({ page, state }) => {
    assert.equal(state.calls.filter(call => call.path.startsWith('/vault/backups')).length, 0);
    await open(page);
    assert.deepEqual(state.calls.filter(call => call.path.startsWith('/vault/backups')), [{ method: 'GET', path: '/vault/backups/capabilities' }]);
    assert.match(await page.locator('.vb-scope').textContent(), /other accounts.*Notes & fixes.*chat history.*PIN.*identity.*phone pairings/);
  }, false);
  await check('Check has working feedback, duplicate protection and retained failure results', async ({ page, state }) => {
    const gate = state.defer('POST', '/vault/backups/check');
    await page.locator('#vb-check').click(); await waitCall(page, state, 'POST', '/vault/backups/check');
    assert.match(await page.locator('#vb-check-result').innerText(), /Working/);
    await page.locator('#vb-check').dispatchEvent('click');
    gate.release(); await idle(page);
    assert.match(await page.locator('#vb-check-result').innerText(), /No backup was created/);
    const before = await page.locator('#vb-check-result').innerText();
    state.fail('POST', '/vault/backups/check'); await page.locator('#vb-check').click(); await idle(page);
    assert.equal(await page.locator('#vb-check-result').innerText(), before);
    assert.match(await page.locator('#vb-error').innerText(), /No automatic retry/);
    await waitCall(page, state, 'POST', '/vault/backups/check', 2);
  });
  await check('Create prepares once and download is an explicit unconfirmed browser intent', async ({ page, state }) => {
    const gate = state.defer('POST', '/vault/backups/create');
    await create(page); await waitCall(page, state, 'POST', '/vault/backups/create');
    await page.locator('#vb-create').dispatchEvent('click'); gate.release(); await idle(page);
    assert.equal(await page.locator('#vb-download').getAttribute('href'), downloadUrl);
    assert.match(await page.locator('#vb-create-result').innerText(), /not confirmed a saved copy/);
    assert.equal(await page.locator('#vb-create-password').inputValue(), '');
    await page.locator('#vb-download').click();
    assert.match(await page.locator('#vb-create-result').innerText(), /cannot confirm.*saved/);
    assert.deepEqual(await page.evaluate(() => window.__vaultDownloadIntents), [downloadUrl]);
    assert.equal(state.calls.filter(call => call.path === downloadUrl).length, 0);
    await waitCall(page, state, 'POST', '/vault/backups/create');
  });
  await check('Prepared lookup is explicit, survives navigation and supports deliberate discard', async ({ page, state }) => {
    await create(page); await idle(page);
    await page.evaluate(() => switchPanel('panel-main')); await privateClear(page);
    await page.evaluate(() => switchPanel('panel-vault'));
    await page.locator('#vb-prepared').click(); await idle(page);
    assert.equal(await page.locator('#vb-download').getAttribute('href'), downloadUrl);
    await waitCall(page, state, 'GET', '/vault/backups/prepared');
    await waitCall(page, state, 'POST', '/vault/backups/create');
    state.fail('DELETE', downloadUrl); await page.locator('#vb-discard').click(); await idle(page);
    assert.equal(await page.locator('#vb-download').getAttribute('href'), downloadUrl);
    await page.locator('#vb-discard').click(); await idle(page);
    assert.equal(await page.locator('#vb-download').isVisible(), false);
    assert.match(await page.locator('#vb-create-result').innerText(), /Existing saved archives are unchanged/);
    await page.locator('#vb-prepared').click(); await idle(page);
    assert.match(await page.locator('#vb-create-result').innerText(), /No prepared download/);
  });
  await check('Failed create preserves previous prepared result and the entered retry draft', async ({ page, state }) => {
    await create(page); await idle(page); const before = await page.locator('#vb-create-result').innerText();
    state.fail('POST', '/vault/backups/create'); await create(page); await idle(page);
    assert.equal(await page.locator('#vb-create-result').innerText(), before);
    assert.equal(await page.locator('#vb-create-password').inputValue(), password);
    assert.equal(await page.locator('#vb-download').getAttribute('href'), downloadUrl);
  });
  await check('Verify has accurate non-restoration result and keeps it after rejection', async ({ page, state }) => {
    await archive(page); await page.locator('#vb-verify').click(); await idle(page);
    const before = await page.locator('#vb-verify-result').innerText(); assert.match(before, /No data was restored/);
    state.fail('POST', '/vault/backups/verify', { ok: false, detail: 'Wrong archive password.' }, 422);
    await page.locator('#vb-verify').click(); await idle(page);
    assert.equal(await page.locator('#vb-verify-result').innerText(), before);
    assert.match(await page.locator('#vb-error').innerText(), /Wrong archive password/);
    assert.equal(await page.locator('#vb-file').evaluate(el => el.files.length), 1);
  });
  await check('Review is explicit and any changed target invalidates recovery authority', async ({ page, state }) => {
    await review(page);
    assert.match(await page.locator('#vb-review-result').innerText(), /No folder has been created/);
    assert.equal(state.calls.filter(call => call.path === '/vault/backups/recovery/create').length, 0);
    assert.equal(await page.locator('#vb-recover').isEnabled(), true);
    await page.locator('#vb-destination').fill(destination + '-changed');
    assert.equal(await page.locator('#vb-recover').isEnabled(), false);
    assert.equal(await page.locator('#vb-review-result').innerText(), '');
    await page.locator('#vb-recover').dispatchEvent('click');
    assert.equal(state.calls.filter(call => call.path === '/vault/backups/recovery/create').length, 0);
  });
  await check('Failed replacement review retains prior reviewed path without creating anything', async ({ page, state }) => {
    await review(page); const before = await page.locator('#vb-review-result').innerText();
    state.fail('POST', '/vault/backups/recovery/review'); await page.locator('#vb-review').click(); await idle(page);
    assert.equal(await page.locator('#vb-review-result').innerText(), before);
    assert.equal(state.calls.filter(call => call.path === '/vault/backups/recovery/create').length, 0);
  });
  await check('Recovery requires current-reader evidence and successful replacement clears private inputs', async ({ page, state }) => {
    await review(page);
    state.fail('POST', '/vault/backups/recovery/create', { ...recoveredReceipt(), readback: { ok: true, reader: 'current-application', checks: {} } }, 200);
    await recover(page);
    assert.equal(await page.locator('#vb-recover-result').innerText(), '');
    assert.match(await page.locator('#vb-error').innerText(), /not both confirmed/);
    assert.equal(await page.locator('#vb-recover').isEnabled(), false);
    await review(page); await recover(page);
    const before = await page.locator('#vb-recover-result').innerText();
    assert.match(before, /starts locked.*not replaced or activated/);
    for (const id of ['vb-new-password', 'vb-new-confirm', 'vb-archive-password', 'vb-file']) assert.equal(await page.locator('#' + id).inputValue(), '');
    await review(page); state.fail('POST', '/vault/backups/recovery/create'); await recover(page);
    assert.equal(await page.locator('#vb-recover-result').innerText(), before);
    assert.equal(await page.locator('#vb-recover').isEnabled(), false);
  });
  await check('Stop waiting does not claim cancellation or accept late completion', async ({ page, state }) => {
    await archive(page); const gate = state.defer('POST', '/vault/backups/verify');
    await page.locator('#vb-verify').click(); await waitCall(page, state, 'POST', '/vault/backups/verify');
    await page.locator('#vb-stop').click(); gate.release(); await idle(page);
    assert.equal(await page.locator('#vb-verify-result').innerText(), '');
    assert.match(await page.locator('#vb-error').innerText(), /Server work may still finish/);
    assert.equal(await page.locator('#vb-file').inputValue(), '');
    await waitCall(page, state, 'POST', '/vault/backups/verify');
  });
  await check('Session lock clears sensitive state and ignores a late completed create', async ({ page, state }) => {
    await review(page); const gate = state.defer('POST', '/vault/backups/create');
    await create(page); await waitCall(page, state, 'POST', '/vault/backups/create');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tli-session-locked')));
    gate.release(); await idle(page); await privateClear(page);
    assert.equal(await page.locator('#vb-create-result').textContent(), '');
    assert.equal(await page.locator('#vb-create').isEnabled(), false);
  });
  await check('Vault lock clears receipts and download authority without discarding the server archive', async ({ page, state }) => {
    await create(page); await idle(page); await page.locator('#vault-lock-btn').click();
    await page.waitForFunction(() => document.getElementById('vault-status-pill').dataset.state === 'locked');
    await privateClear(page);
    assert.equal(state.calls.filter(call => call.method === 'DELETE').length, 0);
    assert.ok(state.prepared);
  });
  await check('Unreadable or false successful HTTP receipts do not replace a verified result', async ({ page, state }) => {
    await archive(page); await page.locator('#vb-verify').click(); await idle(page);
    const before = await page.locator('#vb-verify-result').innerText();
    state.fail('POST', '/vault/backups/verify', { ok: false, detail: 'Synthetic incomplete operation.' }, 200);
    await page.locator('#vb-verify').click(); await idle(page);
    assert.equal(await page.locator('#vb-verify-result').innerText(), before);
    assert.match(await page.locator('#vb-error').innerText(), /incomplete operation/);
  });
  for (const status of [401, 403]) await check(`HTTP ${status} clears expired backup access and all private inputs immediately`, async ({ page, state }) => {
    await create(page); await idle(page); await review(page);
    state.fail('POST', '/vault/backups/create', { ok: false, detail: 'Synthetic access expired.' }, status);
    await create(page); await idle(page); await privateClear(page);
    assert.equal(await page.locator('#vb-create-result').textContent(), '');
    assert.equal(await page.locator('#vb-review-result').textContent(), '');
    assert.notEqual(await page.locator('#vault-status-pill').getAttribute('data-state'), 'unlocked');
    await waitCall(page, state, 'POST', '/vault/backups/create', 2);
  });
}
async function visuals(browser) {
  for (const width of [1440, 768, 390, 320]) for (const theme of ['emeraldLight', 'midnight', 'classicTli']) {
    const run = await fixture(browser, width, theme), { page, state } = run;
    try {
      await page.locator('#vb-check').click(); await idle(page);
      await create(page); await idle(page);
      await archive(page); await page.locator('#vb-verify').click(); await idle(page);
      await review(page);
      state.fail('POST', '/vault/backups/verify', { ok: false, detail: 'The selected archive could not be authenticated. Check its password and retry deliberately.' }, 422);
      await page.locator('#vb-verify').click(); await idle(page);
      // Synthetic password inputs remain masked; do not invalidate the reviewed target.
      const checks = { width, theme, view: 'reviewed-with-retained-results', ...await measuredLayout(page, 'vault-backups') };
      report.layouts.push(checks);
      report.labels.push({ width, theme, missing: await page.evaluate(() => [...document.querySelectorAll('#vault-backups input')].filter(window.__themeAuditVisible).filter(el => !el.labels?.length && !el.getAttribute('aria-label')).map(el => el.id)) });
      const consentRows = await page.evaluate(() => [...document.querySelectorAll('#vault-backups input[type=checkbox]')].map(el => {
        const box = el.getBoundingClientRect(), label = el.parentElement, span = label.querySelector('span').getBoundingClientRect();
        return { id: el.id, display: getComputedStyle(label).display, width: box.width, height: box.height, besideLabel: span.left > box.left };
      }));
      for (const row of consentRows) { assert.equal(row.display, 'flex'); assert.ok(row.width <= 24 && row.height <= 24 && row.besideLabel, 'Consent checkbox should sit beside its label, independent of legacy Vault fields'); }
      report.contrast.push({ width, theme, ...await contrast(page, 'vault-backups') });
      await capture(page, `vault-backups-${width}-${theme}`);
      await page.locator('#vb-refresh').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'vb-check', 'Keyboard reaches the next enabled action');
      if (width === 320) {
        await textScale(page, 'vault-backups', true);
        report.layouts.push({ width, theme, view: 'text200', ...await measuredLayout(page, 'vault-backups') });
        await capture(page, `vault-backups-text200-${width}-${theme}`);
        if (theme === 'midnight') {
          for (const index of [1, 3]) {
            const file = `vault-backups-text200-${width}-${theme}-card${index + 1}.png`;
            const viewport = page.viewportSize(), card = page.locator('.vb-card').nth(index);
            await page.setViewportSize({ width, height: await card.evaluate(el => el.scrollHeight + 800) });
            await card.screenshot({ path: path.join(output, file) });
            await page.setViewportSize(viewport);
            report.screenshots.push(file);
          }
        }
        await textScale(page, 'vault-backups', false);
      }
      if ((width === 1440 && theme === 'midnight') || (width === 390 && theme === 'emeraldLight')) {
        await recover(page);
        assert.match(await page.locator('#vb-recover-result').innerText(), /starts locked.*not replaced/);
        await capture(page, `vault-recovered-${width}-${theme}`);
      }
    } catch (error) { report.behaviors.push({ name: `visual ${width} ${theme}`, passed: false, error: error.stack }); }
    finally { await finish(run); }
  }
}
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { await behaviors(browser); if (!process.argv.includes('--behaviors-only')) await visuals(browser); }
  finally { await browser.close(); }
  report.hashesAtEnd = fingerprintFiles(source);
  report.changedDuringRun = [...new Set([...Object.keys(report.hashesAtStart), ...Object.keys(report.hashesAtEnd)])].filter(file => report.hashesAtStart[file] !== report.hashesAtEnd[file]);
  report.failedBehaviors = report.behaviors.filter(item => !item.passed);
  report.overflow = report.layouts.filter(item => item.overflow?.length || item.documentWidth > item.width + 2);
  report.screenshotHashes = Object.fromEntries(report.screenshots.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')]));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, behaviors: report.behaviors.length, failed: report.failedBehaviors.length, layouts: report.layouts.length, overflow: report.overflow.length, errors: report.errors.length, unexpected: report.unexpected.length, contrast: report.contrast.reduce((sum, item) => sum + item.findings.length, 0), changedDuringRun: report.changedDuringRun }));
  assert.equal(report.failedBehaviors.length, 0, 'Vault browser behavior failed; inspect report');
  assert.equal(report.overflow.length, 0, 'Vault controls or results overflow the viewport');
  assert.equal(report.labels.flatMap(item => item.missing).length, 0, 'Visible input without a label');
  assert.equal(report.layouts.flatMap(item => item.duplicateIds || []).length, 0, 'Duplicate DOM identity');
  assert.equal(report.contrast.flatMap(item => item.findings).length, 0, 'Insufficient solid-background text contrast');
  assert.equal(report.errors.length, 0, 'Uncaught SPA error');
  assert.equal(report.unexpected.length, 0, 'Unexpected operation or non-fixture request');
  assert.equal(report.changedDuringRun.length, 0, 'Source changed during capture; rerun the candidate');
}
module.exports = { fixture, receipt, preparedReceipt, review, create, idle, privateClear, output };
if (require.main === module) main().catch(error => { fs.writeFileSync(path.join(output, 'error.txt'), error.stack); console.error(error); process.exitCode = 1; });
