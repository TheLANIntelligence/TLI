/* Real TLI SPA, synthetic Vault only. Never starts TLI or opens household data. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.argv.includes('--label')) process.argv.push('--label', 'vault-workspace');
const { makePage, layout, fingerprintFiles, source } = require('./verify_anniversary_ui_browser.cjs');
const { contrast, textScale, measuredLayout } = require('./verify_anniversary_themes_browser.cjs');
const baseline = process.argv.includes('--before');
const output = path.join(__dirname, '../build_work/vault-rebuild', `${baseline ? 'before' : 'after'}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, { recursive: true });
const report = { source, output, synthetic: true, baseline, hashesAtStart: fingerprintFiles(source), states: [], layouts: [], contrast: [], labels: [], keyboard: [], behaviors: [], calls: [], errors: [], failures: [],
  limitations: ['All requests are intercepted; no live host, files, credentials, inference or devices are used.', 'Browser fixture checks are not physical-phone, assistive-technology or cryptographic acceptance.'] };
const fileName = 'Studio_passport_and_household_warranty_scans_synthetic_demo_pdf';
const secretValue = 'SYNTHETIC_PRIVATE_SECRET_DO_NOT_PERSIST';
const noteBody = 'SYNTHETIC_PRIVATE_NOTE_DO_NOT_PERSIST\nSpare drive location: studio drawer.\nThis is fixture text, not household data.';
const sampleFiles = () => [
  { id: fileName, name: fileName, size: 1540096, size_display: '1.47 MB' },
  { id: 'Recovery_document_example_only_txt', name: 'Recovery_document_example_only_txt', size: 2341, size_display: '2.3 KB' },
  { id: 'Family_archive_' + 'very_long_filename_'.repeat(12) + 'zip', name: 'Family_archive_' + 'very_long_filename_'.repeat(12) + 'zip', size: 8392704, size_display: '8.00 MB' },
];
const sampleNotes = () => [
  { id: '__note_Studio_recovery_details', title: 'Studio_recovery_details', content: noteBody, size: 345 },
  { id: '__note_Private_setup', title: 'Private_setup', content: 'Synthetic second note.', size: 123 },
];

async function vaultPage(browser, width = 1440, theme = 'emeraldLight', initial = 'locked') {
  const run = await makePage(browser, width, theme), { page, context } = run;
  const state = { initialized: true, unlocked: initial === 'unlocked', failed_attempts: 0, locked_until: null, unavailable: initial === 'unavailable', files: sampleFiles(), secrets: { studio_wifi: secretValue, recovery_hint: 'Synthetic cabinet label' }, notes: sampleNotes(), faults: new Map(), gates: new Map(), calls: [], unexpected: [], dialogs: [] };
  if (initial === 'setup') state.initialized = false;
  if (initial === 'bad-passphrase') state.failed_attempts = 3;
  if (initial === 'lockout') { state.failed_attempts = 10; state.locked_until = new Date(Date.now() + 240000).toISOString(); }
  state.fail = (method, pathname, status = 503, body = { detail: 'Synthetic operation failed. Previous data retained.' }) => state.faults.set(`${method} ${pathname}`, { status, body });
  state.defer = (method, pathname) => { let release; const promise = new Promise(resolve => { release = resolve; }); const gate = { promise, release }; state.gates.set(`${method} ${pathname}`, gate); return gate; };
  state.confirmAnswers = [];
  page.on('dialog', dialog => { state.dialogs.push(dialog.message()); const accept = state.confirmAnswers.length ? state.confirmAnswers.shift() : true; (accept ? dialog.accept() : dialog.dismiss()).catch(() => {}); });
  await context.route('**/vault/**', async route => {
    const req = route.request(), url = new URL(req.url()), pathname = decodeURIComponent(url.pathname), method = req.method(), key = `${method} ${pathname}`;
    if (url.hostname !== 'tli-ui.test') return route.abort('blockedbyclient');
    let body = {}; try { body = req.postDataJSON() || {}; } catch {}
    state.calls.push({ method, path: pathname, body: method === 'POST' && pathname === '/vault/unlock' ? '[synthetic passphrase omitted]' : body });
    const gate = state.gates.get(key); if (gate) { state.gates.delete(key); await gate.promise; }
    const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const fault = state.faults.get(key); if (fault) { state.faults.delete(key); return respond(fault.body, fault.status); }
    if (pathname === '/vault/status') return state.unavailable ? respond({ detail: 'Synthetic Vault unavailable' }, 503) : respond({ initialized: state.initialized, unlocked: state.unlocked, failed_attempts: state.failed_attempts, locked_until: state.locked_until });
    if (pathname === '/vault/unlock') {
      if (body.password !== 'synthetic-demo-passphrase') { state.failed_attempts += 1; return respond({ detail: { success: false, message: 'Wrong passphrase', remaining_attempts: 10 - state.failed_attempts } }, 403); }
      state.unlocked = true; state.failed_attempts = 0; state.locked_until = null; return respond({ success: true });
    }
    if (pathname === '/vault/lock') { state.unlocked = false; return respond({ ok: true }); }
    if (!state.unlocked) return respond({ detail: 'Vault is locked for this user' }, 403);
    if (pathname === '/vault/list') return respond({ files: state.files });
    if (pathname === '/vault/secrets') return respond({ keys: Object.keys(state.secrets) });
    if (pathname === '/vault/notes') return respond({ notes: state.notes.map(({ content, ...note }) => note) });
    if (pathname === '/vault/upload') { state.files.push({ id: 'uploaded_fixture_txt', name: 'uploaded_fixture_txt', size: 123, size_display: '123 B' }); return respond({ ok: true, file_id: 'uploaded_fixture_txt' }); }
    if (pathname === '/vault/delete_file') { const prior = state.files.length; state.files = state.files.filter(file => file.id !== body.file_id); return respond({ ok: true, deleted: state.files.length < prior }); }
    if (pathname.startsWith('/vault/secret/')) {
      const name = pathname.slice('/vault/secret/'.length);
      if (method === 'GET') return Object.hasOwn(state.secrets, name) ? respond({ key: name, value: state.secrets[name] }) : respond({ detail: 'Secret not found' }, 404);
      if (method === 'POST') { state.secrets[name] = body.value; return respond({ ok: true, key: name }); }
      if (method === 'DELETE') { const existed = Object.hasOwn(state.secrets, name); delete state.secrets[name]; return respond({ ok: true, existed }); }
    }
    if (pathname === '/vault/note' && method === 'POST') {
      const id = '__note_' + body.title.trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
      state.notes = state.notes.filter(note => note.id !== id); state.notes.push({ id, title: body.title, content: body.content, size: body.content.length + 64 });
      return respond({ ok: true, id, title: body.title });
    }
    if (pathname.startsWith('/vault/note/')) {
      const id = pathname.slice('/vault/note/'.length), note = state.notes.find(note => note.id === id);
      if (method === 'GET') return note ? respond(note) : respond({ detail: 'Note not found' }, 404);
      if (method === 'DELETE') { if (!note) return respond({ detail: 'Note not found' }, 404); state.notes = state.notes.filter(note => note.id !== id); return respond({ ok: true }); }
    }
    if (pathname === '/vault/get_file') return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="synthetic-demo.txt"' }, body: 'Synthetic downloadable contents' });
    state.unexpected.push({ method, path: pathname }); return respond({ detail: 'Unexpected synthetic Vault operation refused' }, 409);
  });
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
  await page.waitForTimeout(80);
  return { ...run, state };
}

async function record(run) {
  report.calls.push(...run.state.calls); report.errors.push(...run.errors); report.failures.push(...run.state.unexpected);
  const forbidden = run.calls.filter(call => !['GET', 'HEAD'].includes(call.method));
  assert.equal(forbidden.length, 0, 'Unexpected action outside the synthetic Vault fixture');
  await run.context.close();
}

async function fullWorkspaceCapture(page, filename) {
  const viewport = page.viewportSize();
  const height = await page.evaluate(() => { const panel = document.getElementById('panel-vault'); return Math.min(3000, Math.max(innerHeight, panel.scrollHeight + innerHeight - panel.clientHeight + 80)); });
  await page.setViewportSize({ width: viewport.width, height });
  await page.evaluate(() => { for (const el of document.querySelectorAll('.main-scroll,#panel-vault')) el.scrollTop = 0; window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(output, filename), fullPage: true });
  await page.setViewportSize(viewport);
}

async function visualChecks(browser) {
  for (const width of [1440, 1024, 390, 320]) for (const theme of ['emeraldLight', 'midnight']) {
    const run = await vaultPage(browser, width, theme), { page, state } = run;
    for (const view of ['setup', 'locked', 'bad-passphrase', 'lockout', 'unavailable', 'unlocked']) {
      await page.locator('.tli-toast-close').evaluateAll(buttons => buttons.forEach(button => button.click()));
      await page.waitForTimeout(180);
      Object.assign(state, { initialized: view !== 'setup', unlocked: view === 'unlocked', failed_attempts: view === 'bad-passphrase' ? 3 : view === 'lockout' ? 10 : 0, locked_until: view === 'lockout' ? new Date(Date.now() + 240000).toISOString() : null, unavailable: view === 'unavailable' });
      await page.evaluate(() => fetchVaultStatus()); await page.waitForTimeout(30);
      report.states.push({ width, theme, view, pill: await page.locator('#vault-status-pill').innerText(), state: await page.locator('#vault-status-pill').getAttribute('data-state') });
      report.layouts.push({ width, theme, view, ...await layout(page, 'panel-vault') });
      if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(output, `${view}-${width}-${theme}.png`), fullPage: true });
    }
    for (const tab of ['files', 'secrets', 'notes']) {
      await page.locator(`[data-vault-tab="${tab}"]`).click();
      if (tab === 'notes') await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click();
      report.layouts.push({ width, theme, view: tab, ...await layout(page, 'panel-vault') });
      report.labels.push({ width, theme, view: tab, missing: await page.evaluate(() => [...document.querySelectorAll('#panel-vault input, #panel-vault select, #panel-vault textarea')].filter(window.__themeAuditVisible).filter(el => !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.labels?.length).map(el => el.id)) });
      report.contrast.push({ width, theme, view: tab, ...await contrast(page, 'panel-vault') });
      if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(output, `${tab}-${width}-${theme}.png`), fullPage: true });
      if (!baseline && tab === 'notes' && [1440, 390].includes(width)) await fullWorkspaceCapture(page, `notes-full-${width}-${theme}.png`);
    }
    if (width === 320) {
      await textScale(page, 'panel-vault', true);
      report.layouts.push({ width, theme, view: 'notes-text200', ...await measuredLayout(page, 'panel-vault') });
      await page.screenshot({ path: path.join(output, `notes-text200-${width}-${theme}.png`), fullPage: true });
      await textScale(page, 'panel-vault', false);
    }
    await record(run);
  }
}

async function waitCalls(page, state, method, pathname, count = 1) {
  const deadline = Date.now() + 4000;
  while (state.calls.filter(call => call.method === method && call.path === pathname).length < count && Date.now() < deadline) await page.waitForTimeout(20);
  assert.equal(state.calls.filter(call => call.method === method && call.path === pathname).length, count, `${method} ${pathname} should run exactly ${count} time(s)`);
}
async function privateClear(page) {
  const current = await page.evaluate(() => ({ text: document.getElementById('panel-vault').textContent, values: [...document.querySelectorAll('#panel-vault input, #panel-vault textarea')].map(el => el.value), editor: document.getElementById('vault-note-editor').dataset.noteId, files: document.getElementById('vault-files-list').textContent, secrets: document.getElementById('vault-secrets-list').textContent, notes: document.getElementById('vault-notes-list').textContent, storage: JSON.stringify({ ...localStorage, ...sessionStorage }) }));
  for (const value of [secretValue, noteBody]) { assert.ok(!current.text.includes(value)); assert.ok(current.values.every(item => !item.includes(value))); assert.ok(!current.storage.includes(value)); }
  assert.ok(!current.files.includes(fileName)); assert.ok(!current.secrets.includes('studio_wifi')); assert.ok(!current.notes.includes('Studio_recovery_details'));
  assert.ok(!current.editor, 'Locked editor must not retain note identity');
}
async function behaviors(browser) {
  async function check(name, fn, options = {}) {
    const run = await vaultPage(browser, options.width || 1440, options.theme || 'emeraldLight', options.state || 'unlocked');
    try { await fn(run); report.behaviors.push({ name, passed: true }); }
    catch (error) { report.behaviors.push({ name, passed: false, error: error.stack }); await run.page.screenshot({ path: path.join(output, `failure-${name.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }); }
    finally { await record(run); }
  }
  await check('Duplicate unlock has one request and one collection refresh', async ({ page, state }) => {
    await page.evaluate(() => setupVaultPanel());
    const gate = state.defer('POST', '/vault/unlock'); state.calls.length = 0;
    await page.locator('#vault-password').fill('synthetic-demo-passphrase');
    await page.evaluate(() => { const el = document.getElementById('vault-unlock-btn'); el.click(); el.click(); });
    await waitCalls(page, state, 'POST', '/vault/unlock'); gate.release();
    await page.waitForFunction(() => document.getElementById('vault-status-pill').dataset.state === 'unlocked');
    await page.waitForFunction(() => document.getElementById('vault-files-list').textContent.includes('Studio_passport'));
    for (const route of ['/vault/list', '/vault/secrets', '/vault/notes']) assert.equal(state.calls.filter(call => call.path === route).length, 1, 'One successful unlock must refresh each collection once');
    assert.equal(await page.locator('#vault-password').inputValue(), '');
  }, { state: 'locked' });
  await check('File search sorts locally and preserves list after refresh failure', async ({ page, state }) => {
    state.calls.length = 0;
    await page.locator('#vault-files-search').fill('passport');
    assert.equal(await page.locator('.vault-file-row:visible').count(), 1);
    await page.locator('#vault-files-search').fill('');
    await page.locator('#vault-files-sort').selectOption('size');
    assert.match(await page.locator('.vault-file-row').first().innerText(), /Family_archive/);
    assert.equal(state.calls.length, 0, 'Filtering and sorting should not fetch or run actions');
    state.fail('GET', '/vault/list'); await page.evaluate(() => refreshVaultFiles());
    assert.equal(await page.locator('.vault-file-row').count(), 3, 'Failed refresh preserves previous known results');
    assert.match(await page.locator('#vault-files-status').innerText(), /fail|could not|unavailable|previous/i);
  });
  await check('Failed file deletion retains row, explicit retry deletes once', async ({ page, state }) => {
    const row = page.locator('.vault-file-row').filter({ hasText: fileName });
    state.calls.length = 0; state.fail('POST', '/vault/delete_file', 200, { ok: false, detail: 'Synthetic removal refused' });
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await waitCalls(page, state, 'POST', '/vault/delete_file'); await page.waitForTimeout(80);
    assert.equal(await row.count(), 1); assert.equal(state.files.length, 3);
    const gate = state.defer('POST', '/vault/delete_file');
    await row.getByRole('button', { name: 'Delete', exact: true }).evaluate(el => { el.click(); el.click(); });
    await waitCalls(page, state, 'POST', '/vault/delete_file', 2); gate.release();
    await page.waitForFunction(name => !document.getElementById('vault-files-list').textContent.includes(name), fileName);
    assert.equal(state.files.length, 2);
  });
  await check('File upload failure preserves choice and duplicate retry runs once', async ({ page, state }) => {
    await page.locator('#vault-tab-files details').filter({ has: page.locator('#vault-file-input') }).locator('summary').click();
    await page.locator('#vault-file-input').setInputFiles({ name: 'uploaded-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Only synthetic fixture data') });
    state.calls.length = 0; state.fail('POST', '/vault/upload');
    await page.locator('#vault-upload-btn').click(); await waitCalls(page, state, 'POST', '/vault/upload');
    await page.waitForFunction(() => /failed/i.test(document.getElementById('vault-message').textContent));
    assert.equal(await page.locator('#vault-file-input').evaluate(el => el.files.length), 1);
    const gate = state.defer('POST', '/vault/upload');
    await page.locator('#vault-upload-btn').evaluate(el => { el.click(); el.click(); });
    await waitCalls(page, state, 'POST', '/vault/upload', 2); gate.release();
    await page.waitForFunction(() => document.getElementById('vault-file-input').files.length === 0);
    assert.equal(state.files.filter(file => file.id === 'uploaded_fixture_txt').length, 1);
  });
  await check('Secret save and delete preserve input and rows after rejected results', async ({ page, state }) => {
    await page.locator('[data-vault-tab="secrets"]').click();
    await page.locator('#vault-tab-secrets details').filter({ has: page.locator('#vault-secret-key-input') }).locator('summary').click();
    await page.locator('#vault-secret-key-input').fill('new_fixture_key'); await page.locator('#vault-secret-val-input').fill(secretValue);
    state.calls.length = 0; state.fail('POST', '/vault/secret/new_fixture_key', 200, { ok: false, detail: 'Synthetic store unavailable' });
    await page.locator('#vault-secret-add-btn').click(); await waitCalls(page, state, 'POST', '/vault/secret/new_fixture_key');
    await page.waitForFunction(() => /fail|could not|unavailable/i.test(document.getElementById('vault-secret-status').textContent));
    assert.equal(await page.locator('#vault-secret-val-input').inputValue(), secretValue);
    const gate = state.defer('POST', '/vault/secret/new_fixture_key');
    await page.locator('#vault-secret-add-btn').evaluate(el => { el.click(); el.click(); });
    await waitCalls(page, state, 'POST', '/vault/secret/new_fixture_key', 2); gate.release();
    await page.waitForFunction(() => document.getElementById('vault-secret-val-input').value === '');
    const row = page.locator('.vault-secret-row').filter({ hasText: 'new_fixture_key' });
    assert.equal(await row.count(), 1); assert.ok(!(await row.innerText()).includes(secretValue));
    state.fail('DELETE', '/vault/secret/new_fixture_key', 200, { ok: false, detail: 'Synthetic delete refused' });
    await row.getByRole('button', { name: 'Delete', exact: true }).click(); await waitCalls(page, state, 'DELETE', '/vault/secret/new_fixture_key'); await page.waitForTimeout(80);
    assert.equal(await row.count(), 1); assert.equal(state.secrets.new_fixture_key, secretValue);
  });
  await check('Notes preserve failed draft and successful save establishes saved identity', async ({ page, state }) => {
    await page.locator('[data-vault-tab="notes"]').click(); await page.locator('#vault-newnote-btn').click();
    await page.locator('#vault-note-title-input').fill('New synthetic note'); await page.locator('#vault-note-body').fill(noteBody + '\nUnsaved edit');
    state.calls.length = 0; state.fail('POST', '/vault/note');
    await page.locator('#vault-note-save-btn').click(); await waitCalls(page, state, 'POST', '/vault/note');
    await page.waitForFunction(() => /fail|could not/i.test(document.getElementById('vault-note-status').textContent));
    assert.equal(await page.locator('#vault-note-title-input').inputValue(), 'New synthetic note');
    assert.equal(await page.locator('#vault-note-body').inputValue(), noteBody + '\nUnsaved edit');
    const gate = state.defer('POST', '/vault/note');
    await page.locator('#vault-note-save-btn').evaluate(el => { el.click(); el.click(); });
    await waitCalls(page, state, 'POST', '/vault/note', 2); gate.release();
    await page.waitForFunction(() => document.getElementById('vault-note-editor').dataset.noteId === '__note_New_synthetic_note');
    assert.equal(state.notes.filter(note => note.id === '__note_New_synthetic_note').length, 1);
    state.fail('DELETE', '/vault/note/__note_New_synthetic_note');
    await page.locator('#vault-note-delete-btn').click(); await waitCalls(page, state, 'DELETE', '/vault/note/__note_New_synthetic_note'); await page.waitForTimeout(80);
    assert.equal(await page.locator('#vault-note-body').inputValue(), noteBody + '\nUnsaved edit');
    assert.equal(await page.locator('#vault-note-editor').isVisible(), true);
  });
  await check('Session lock clears decrypted values and ignores late note response', async ({ page, state }) => {
    await page.locator('[data-vault-tab="secrets"]').click(); await page.locator('.vault-secret-row').filter({ hasText: 'studio_wifi' }).getByRole('button', { name: /^Show/ }).click();
    await page.waitForFunction(value => document.getElementById('vault-secrets-list').textContent.includes(value), secretValue);
    await page.locator('[data-vault-tab="notes"]').click();
    const gate = state.defer('GET', '/vault/note/__note_Studio_recovery_details'); state.fail('GET', '/vault/note/__note_Studio_recovery_details', 200, state.notes[0]);
    await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click(); await waitCalls(page, state, 'GET', '/vault/note/__note_Studio_recovery_details');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tli-session-locked')));
    gate.release(); await page.waitForTimeout(120); await privateClear(page);
  });
  await check('Rejected locked credential response clears all private state', async ({ page, state }) => {
    await page.locator('[data-vault-tab="notes"]').click(); await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click();
    await page.waitForFunction(value => document.getElementById('vault-note-body').value === value, noteBody);
    state.unlocked = false; state.fail('GET', '/vault/secrets', 401, { detail: 'Synthetic session expired' });
    await page.evaluate(() => refreshVaultSecrets()); await privateClear(page);
    assert.ok(['unavailable', 'locked'].includes(await page.locator('#vault-status-pill').getAttribute('data-state')));
  });
  await check('Visible access recheck preserves draft and clears expired owner access', async ({ page, state }) => {
    await page.locator('[data-vault-tab="notes"]').click(); await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click();
    await page.waitForFunction(value => document.getElementById('vault-note-body').value === value, noteBody);
    await page.locator('#vault-note-body').fill(noteBody + '\nAn unsaved draft'); state.calls.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await waitCalls(page, state, 'GET', '/vault/status'); await page.waitForTimeout(50);
    assert.equal(await page.locator('#vault-note-body').inputValue(), noteBody + '\nAn unsaved draft');
    assert.deepEqual(state.calls.map(call => call.path), ['/vault/status'], 'A visibility recheck must not reload private collections or replace drafts');
    state.unlocked = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await waitCalls(page, state, 'GET', '/vault/status', 2); await page.waitForTimeout(50);
    await privateClear(page);
  });
  await check('Lock clears immediately and reports unconfirmed server outcome', async ({ page, state }) => {
    await page.locator('[data-vault-tab="notes"]').click(); await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click();
    await page.waitForFunction(value => document.getElementById('vault-note-body').value === value, noteBody);
    const gate = state.defer('POST', '/vault/lock'); state.fail('POST', '/vault/lock');
    await page.locator('#vault-lock-btn').click(); await waitCalls(page, state, 'POST', '/vault/lock'); await privateClear(page);
    gate.release(); await page.waitForTimeout(150);
    assert.notEqual(await page.locator('#vault-status-pill').getAttribute('data-state'), 'unlocked'); await privateClear(page);
  });
  await check('Command palette uses the same confirmed Vault lock', async ({ page, state }) => {
    await page.locator('[data-vault-tab="notes"]').click(); await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click();
    await page.waitForFunction(value => document.getElementById('vault-note-body').value === value, noteBody);
    const gate = state.defer('POST', '/vault/lock'); state.calls.length = 0;
    await page.keyboard.press('Control+k'); await page.locator('#tli-cmd-input').fill('Lock Vault');
    await page.locator('.tli-cmd-item').filter({ hasText: 'Lock Vault' }).click();
    await waitCalls(page, state, 'POST', '/vault/lock'); await privateClear(page); gate.release();
    await page.waitForFunction(() => document.getElementById('vault-status-pill').dataset.state === 'locked');
    assert.equal(state.calls.filter(call => call.path === '/vault/lock').length, 1);
  });
  await check('Tabs support arrow, Home and End keyboard navigation on phone', async ({ page }) => {
    const files = page.locator('[data-vault-tab="files"]'); await files.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('[data-vault-tab="secrets"]').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End'); assert.equal(await page.locator('[data-vault-tab="notes"]').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home'); assert.equal(await files.getAttribute('aria-selected'), 'true');
    report.keyboard.push({ width: 320, arrowHomeEnd: true });
  }, { width: 320, theme: 'midnight' });
  await check('Lockout disables unlock and retains honest retry information', async ({ page, state }) => {
    assert.equal(await page.locator('#vault-unlock-btn').isDisabled(), true);
    assert.match(await page.locator('#vault-auth-hint').innerText(), /try again|wait|minute/i);
    state.calls.length = 0;
    await page.locator('#vault-password').evaluate(el => { el.value = 'synthetic-demo-passphrase'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await page.waitForTimeout(80);
    assert.equal(state.calls.filter(call => call.path === '/vault/unlock').length, 0);
  }, { state: 'lockout' });
  await check('Cancelling a colliding note title preserves draft and saved note', async ({ page, state }) => {
    await page.locator('[data-vault-tab="notes"]').click(); await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click();
    await page.waitForFunction(value => document.getElementById('vault-note-body').value === value, noteBody);
    await page.locator('#vault-note-title-input').fill('Private_setup'); await page.locator('#vault-note-body').fill('Preserve this cancelled draft');
    state.calls.length = 0; state.confirmAnswers.push(false); await page.locator('#vault-note-save-btn').click(); await page.waitForTimeout(80);
    assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(await page.locator('#vault-note-body').inputValue(), 'Preserve this cancelled draft');
    assert.equal(state.notes.find(note => note.id === '__note_Private_setup').content, 'Synthetic second note.');
  });
  await check('Large collection and markup-like names remain readable local data', async ({ page, state }) => {
    state.files = Array.from({ length: 500 }, (_, index) => ({ id: `archive-${String(index).padStart(3, '0')}.txt`, name: `archive-${String(index).padStart(3, '0')}.txt`, size: index + 1, size_display: `${index + 1} B` }));
    state.files.push({ id: '<img src=x onerror="window.__vaultInjected=true">.txt', name: '<img src=x onerror="window.__vaultInjected=true">.txt', size: 100, size_display: '100 B' });
    await page.evaluate(() => refreshVaultFiles());
    assert.equal(await page.locator('.vault-file-row').count(), 200, 'Large collections should have a bounded rendered list');
    assert.match(await page.locator('#vault-files-list').innerText(), /200 of 501/);
    await page.locator('#vault-files-search').fill('archive-499'); assert.equal(await page.locator('.vault-file-row:visible').count(), 1);
    await page.locator('#vault-files-search').fill('does-not-exist'); assert.equal(await page.locator('.vault-file-row:visible').count(), 0);
    await page.locator('#vault-files-search').fill('<img'); assert.equal(await page.locator('.vault-file-row:visible').count(), 1);
    assert.equal(await page.evaluate(() => window.__vaultInjected), undefined);
    assert.equal(await page.locator('#vault-files-list img').count(), 0);
    report.layouts.push({ width: 320, theme: 'emeraldLight', view: 'large-markup-name', ...await measuredLayout(page, 'panel-vault') });
  }, { width: 320 });
}

async function paletteChecks(browser) {
  for (const width of [1440, 320]) {
    const run = await vaultPage(browser, width, 'emeraldLight', 'unlocked'), { page } = run;
    const themes = await page.evaluate(() => window.TLIThemes.themes.map(({ id, name }) => ({ id, name })));
    for (const theme of themes) {
      await page.evaluate(id => applyTheme(id), theme.id);
      for (const view of ['files', 'secrets', 'notes']) {
        await page.locator(`[data-vault-tab="${view}"]`).click();
        await page.locator(`#vault-tab-${view} details`).evaluateAll(items => items.forEach(item => { item.open = true; }));
        if (view === 'notes') await page.locator('.vault-note-item').filter({ hasText: 'Studio_recovery_details' }).click();
        report.layouts.push({ width, theme: theme.id, view: `${view}-palette`, ...await measuredLayout(page, 'panel-vault') });
        report.contrast.push({ width, theme: theme.id, view: `${view}-palette`, ...await contrast(page, 'panel-vault') });
      }
    }
    await record(run);
  }
}

function reviewGallery() {
  const parent = path.resolve(__dirname, '../build_work/vault-rebuild');
  const after = path.basename(output), before = 'before-2026-09-07T22-36-08-229Z';
  const rows = ['locked', 'files', 'secrets', 'notes'].map(view => `<section><h2>${view[0].toUpperCase() + view.slice(1)}</h2><div class="pair"><figure><figcaption>Before · Emerald Light · desktop</figcaption><a href="${before}/${view}-1440-emeraldLight.png"><img src="${before}/${view}-1440-emeraldLight.png" alt="Previous Vault ${view} view"></a></figure><figure><figcaption>After · Emerald Light · desktop</figcaption><a href="${after}/${view === 'notes' ? 'notes-full' : view}-1440-emeraldLight.png"><img src="${after}/${view === 'notes' ? 'notes-full' : view}-1440-emeraldLight.png" alt="Refreshed Vault ${view} view"></a></figure></div></section>`).join('');
  const mobile = ['files', 'secrets', 'notes'].map(view => `<figure><figcaption>${view} · 390px · Midnight</figcaption><a href="${after}/${view === 'notes' ? 'notes-full' : view}-390-midnight.png"><img src="${after}/${view === 'notes' ? 'notes-full' : view}-390-midnight.png" alt="Phone width Vault ${view} view"></a></figure>`).join('');
  fs.writeFileSync(path.join(parent, 'review.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TLI Vault · Before & after</title><style>body{margin:0;background:#f4f7f6;color:#20372e;font:16px/1.5 system-ui,sans-serif}main{max-width:1600px;margin:auto;padding:36px}h1{font-size:36px;margin-bottom:8px}h2{margin-top:48px}p{max-width:820px;color:#52675c}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}figure{margin:0;min-width:0}figcaption{padding:12px 0;color:#52675c}img{display:block;width:100%;border:1px solid #dce5e0;border-radius:14px}a{color:#087d5c}.mobile{display:grid;grid-template-columns:repeat(3,minmax(0,390px));gap:22px}.mobile img{max-width:390px}@media(max-width:800px){main{padding:18px}.pair,.mobile{grid-template-columns:1fr}}</style></head><body><main><h1>Your private Vault, rebuilt</h1><p>Actual browser screenshots from isolated fixtures. Names, files, secrets and notes here are synthetic. No live TLI data was opened or changed.</p><p><a href="${after}/report.json">Read the automated browser report</a></p>${rows}<section><h2>On a smaller screen</h2><div class="mobile">${mobile}</div></section></main></body></html>`);
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { await visualChecks(browser); if (!baseline) { await paletteChecks(browser); await behaviors(browser); } }
  finally {
    await browser.close();
    report.hashes = fingerprintFiles(source);
    report.changedDuringRun = [...new Set([...Object.keys(report.hashesAtStart), ...Object.keys(report.hashes)])].filter(file => report.hashesAtStart[file] !== report.hashes[file]);
    report.overflow = report.layouts.filter(item => item.overflow?.length || item.documentWidth > item.width + 2);
    report.duplicateIds = report.layouts.filter(item => item.duplicateIds?.length);
    report.contrastFailures = report.contrast.filter(item => item.findings.length);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (!baseline) reviewGallery();
    console.log(JSON.stringify({ output, baseline, states: report.states.length, layouts: report.layouts.length, errors: report.errors, overflow: report.overflow.length, changedDuringRun: report.changedDuringRun }));
  }
  if (!baseline) { assert.equal(report.errors.length, 0); assert.equal(report.failures.length, 0); assert.equal(report.overflow.length, 0); assert.equal(report.duplicateIds.length, 0); assert.equal(report.contrastFailures.length, 0); assert.deepEqual(report.labels.filter(item => item.missing.length), []); assert.equal(report.changedDuringRun.length, 0); assert.deepEqual(report.behaviors.filter(item => !item.passed), []); }
}
module.exports = { vaultPage, output, report };
if (require.main === module) main().catch(error => { fs.writeFileSync(path.join(output, 'error.txt'), error.stack); console.error(error); process.exitCode = 1; });


