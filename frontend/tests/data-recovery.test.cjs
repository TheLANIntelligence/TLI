const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const script = fs.readFileSync(path.join(__dirname, '../js/data-recovery.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const report = () => ({ schema_version: 1, checked_at: '2026-09-08T14:30:00Z', host: { id: 'host-fixture', name: 'Office TLI' },
  scope: 'Current account only. Vault files and other saved data are not inspected.',
  checks: [{ id: 'notebook', label: 'Household Notebook', status: 'readable', detail: 'Your saved notes can be read.' },
    { id: 'conversations', label: 'Conversations', status: 'not_created', detail: 'No conversation file has been created.' },
    { id: 'diagnostics', label: 'Diagnostic history', status: 'unavailable', detail: 'Saved history could not be read. Preserve the original files.' }],
  backup: { status: 'unknown', detail: 'TLI has not verified a backup of this installation.' },
  guidance: { summary: 'Make a separate copy before attempting recovery.',
    steps: ['Stop TLI normally before copying files.', 'Copy the complete installation data and its key files. Include legacy vault_meta.json from the launch folder.', 'Verify a separate restored copy before replacing an existing installation.'],
    limitations: ['On Windows, protected keys can require the original Windows account and computer.', 'This check does not inspect Vault contents or prove a backup can be restored.'] } });
function descendants(n) { return n.children.flatMap(child => [child, ...descendants(child)]); }
function text(n) { return [n.textContent, ...descendants(n).map(c => c.textContent)].join(' '); }
function fixture() {
  const nodes = {}, calls = [], events = {}, downloads = [], revoked = [];
  let handler = async () => ({ data: report() });
  function element(tag) {
    const n = { tag, textContent: '', children: [], hidden: false, disabled: false, attrs: {}, handlers: {},
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; delete this[k]; }, classList: { toggle() {} },
      addEventListener(event, fn) { (this.handlers[event] ||= []).push(fn); },
      fire(event) { return Promise.all((this.handlers[event] || []).map(fn => fn({}))); },
      click() { if (this.tag === 'a' && !this.hidden) downloads.push(this.href); return this.disabled ? Promise.resolve() : this.fire('click'); },
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = n; }, get() { return Object.keys(nodes).find(id => nodes[id] === n); } });
    return n;
  }
  nodes['panel-settings'] = element('section');
  const location = { protocol: 'https:', hostname: 'fixture.invalid' };
  const ctx = vm.createContext({ Date, AbortController, TextEncoder, Uint8Array, Blob, FormData, crypto: webcrypto, location,
    URL: { createObjectURL: () => 'blob:fixture-' + downloads.length, revokeObjectURL: url => revoked.push(url) },
    document: { readyState: 'complete', createElement: element, getElementById: id => nodes[id] || null, addEventListener: (event, fn) => (events[event] ||= []).push(fn) },
    window: { addEventListener: (event, fn) => (events[event] ||= []).push(fn) },
    fetch: async (url, options) => { calls.push({ url, options }); const reply = await handler(url, options); return { ok: (reply.status || 200) === 200, status: reply.status || 200,
      headers: { get: key => Object.entries(reply.headers || {}).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? null },
      blob: async () => reply.blob, json: async () => { if (reply.invalidJSON) throw new Error('Bad JSON'); return reply.data; } }; },
  });
  vm.runInContext(script, ctx);
  return { nodes, calls, events, downloads, revoked, location, context:ctx, document: ctx.document, window: ctx.window, handler(fn) { handler = fn; }, check: () => nodes['data-recovery-check'].click(), root: nodes['data-recovery-settings'] };
}

test('opening Data & Recovery performs no automatic reads or actions', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.nodes['data-recovery-report'].hidden, true);
  f.root.open = true; await f.root.fire('toggle'); assert.equal(f.calls.length, 0);
  assert.match(text(f.root), /does not create or verify a backup/);
  assert.equal(descendants(f.root).filter(n => n.tag === 'button').length, 6);
  assert.match(text(f.root), /Back up notes, chats & reports.*not a whole-installation backup/);
  assert.equal(f.nodes['backup-download'].hidden, true);
});

test('saved-notes shortcut opens the existing Notebook without checking, backing up or selecting context', async () => {
  const f = fixture(), opens = [];
  f.window.TLINotebook = { open: (...args) => opens.push(args), requestContext: () => assert.fail('Opening notes must not prepare chat context') };
  assert.match(text(f.root), /Notes & fixes holds details you choose to keep/);
  assert.match(text(f.root), /Chat history keeps the conversation itself/);
  assert.match(text(f.root), /does not automatically turn it into a note/);
  await f.nodes['data-recovery-open-notes'].click();
  assert.deepEqual(opens, [[]]); assert.equal(f.calls.length, 0);
  delete f.window.TLINotebook; await f.nodes['data-recovery-open-notes'].click();
  assert.match(f.nodes['data-recovery-status'].textContent, /Notes & fixes is unavailable/);
  assert.equal(f.calls.length, 0);
});

test('one explicit check sends one authenticated GET shape with no payload despite duplicate clicks', async () => {
  const f = fixture(); let resolve;
  f.handler(() => new Promise(done => { resolve = done; }));
  const check = f.check(); await tick(); await f.check();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/intelligence/data-health');
  assert.equal(f.calls[0].options.method, 'GET'); assert.equal(f.calls[0].options.cache, 'no-store'); assert.equal(f.calls[0].options.body, undefined);
  assert.equal(f.nodes['data-recovery-check'].disabled, true);
  resolve({ data: report() }); await check;
  assert.equal(f.nodes['data-recovery-check'].disabled, false); assert.equal(f.nodes['data-recovery-report'].hidden, false);
});

test('readable, unavailable and not-created states retain scope, checked time and unknown backup status', async () => {
  const f = fixture(); await f.check();
  const displayed = text(f.nodes['data-recovery-report']);
  assert.match(displayed, /Office TLI.*Last completed check/); assert.match(displayed, /Readable.*Not created.*Unavailable/);
  assert.match(displayed, /Vault files.*not inspected/); assert.match(displayed, /Backup status: unknown/);
  assert.match(displayed, /original Windows account and computer/); assert.match(displayed, /legacy vault_meta.json/);
  assert.match(f.nodes['data-recovery-status'].textContent, /unavailable or unchecked data/);
});

test('bounded checks show not-checked separately, and all-readable still makes no backup claim', async () => {
  const f = fixture(), data = report();
  data.checks[2] = { ...data.checks[2], status: 'not_checked', detail: 'The saved file exceeds the size limit for this check.' };
  f.handler(async () => ({ data })); await f.check();
  assert.match(text(f.nodes['data-recovery-report']), /Not checked.*exceeds the size limit/);
  data.checks = data.checks.map(check => ({ ...check, status: 'readable' })); await f.check();
  assert.match(f.nodes['data-recovery-status'].textContent, /backup has not been verified/);
});

test('server and connection failures retain the previous timestamped results without marking them current', async () => {
  const f = fixture(); await f.check(); const original = text(f.nodes['data-recovery-report']);
  for (const handler of [async () => ({ status: 503, data: { detail: 'Storage not reachable' } }), async () => { throw new Error('Offline'); }]) {
    f.handler(handler); await f.check();
    assert.equal(text(f.nodes['data-recovery-report']), original);
    assert.match(f.nodes['data-recovery-status'].textContent, /Previous results.*out of date/); assert.equal(f.nodes['data-recovery-check'].disabled, false);
  }
  assert.equal(f.calls.length, 3, 'No automatic retry');
});

test('malformed success cannot turn missing checks or invented backup status into a result', async () => {
  const malformed = [null, {}, { ...report(), schema_version: 2 }, { ...report(), checked_at: 'not a date' },
    { ...report(), checks: [] }, { ...report(), checks: [report().checks[0], report().checks[0], report().checks[2]] },
    { ...report(), checks: report().checks.map(check => ({ ...check, status: 'healthy' })) },
    { ...report(), backup: { status: 'verified', detail: 'A backup exists' } }, { ...report(), guidance: { ...report().guidance, steps: [] } }];
  for (const data of malformed) {
    const f = fixture(); f.handler(async () => ({ data })); await f.check();
    assert.equal(f.nodes['data-recovery-report'].hidden, true); assert.match(f.nodes['data-recovery-status'].textContent, /incomplete saved-data check/);
    assert.equal(f.calls.length, 1); assert.equal(f.nodes['data-recovery-check'].disabled, false);
  }
  const f = fixture(); f.handler(async () => ({ invalidJSON: true })); await f.check();
  assert.match(f.nodes['data-recovery-status'].textContent, /incomplete saved-data check/);
});

test('server-supplied host labels, check details and guidance are inert text', async () => {
  const f = fixture(), data = report(); data.host.name = '<img src=x onerror=alert(1)>';
  data.checks[0].detail = '<script>alert(1)</script>'; data.guidance.steps[0] = '<a href=https://example.invalid>Download a tool</a>';
  f.handler(async () => ({ data })); await f.check();
  assert.match(text(f.nodes['data-recovery-report']), /<img.*<script.*<a href=/);
  assert.ok(descendants(f.root).every(n => n.innerHTML === undefined)); assert.ok(descendants(f.nodes['data-recovery-report']).every(n => !['a', 'img', 'script'].includes(n.tag)));
});

test('authentication failure clears prior host results and manual guidance', async () => {
  const f = fixture(); await f.check(); f.handler(async () => ({ status: 401, data: { detail: 'Unlock TLI' } })); await f.check();
  assert.equal(f.nodes['data-recovery-report'].children.length, 0); assert.equal(f.nodes['data-recovery-report'].hidden, true);
  assert.match(f.nodes['data-recovery-status'].textContent, /Unlock TLI/); assert.equal(f.nodes['data-recovery-check'].disabled, false);
});

test('session changes cancel a pending read and ignore its result after another check succeeds', async () => {
  const f = fixture(); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; })); const pending = f.check(); await tick();
  for (const clear of f.events['tli-session-locked']) clear(); assert.equal(f.calls[0].options.signal.aborted, true);
  const current = report(); current.host.name = 'New account host'; f.handler(async () => ({ data: current })); await f.check();
  finish({ data: report() }); await pending;
  assert.match(text(f.nodes['data-recovery-report']), /New account host/); assert.doesNotMatch(text(f.nodes['data-recovery-report']), /Office TLI/);
  assert.equal(f.nodes['data-recovery-check'].disabled, false);
});

test('leaving the page clears loaded metadata and reopening details never rechecks by itself', async () => {
  const f = fixture(); await f.check(); for (const clear of f.events.pagehide) clear();
  assert.equal(f.nodes['data-recovery-report'].children.length, 0);
  f.root.open = false; await f.root.fire('toggle'); f.root.open = true; await f.root.fire('toggle');
  assert.equal(f.calls.length, 1);
});

const passphrase = 'Synthetic passphrase 2026';
function readyCreate(f, format = '') {
  // Existing tests continue to exercise the explicitly selected v1 format.
  f.nodes['backup-format'].value = format;
  f.nodes['backup-password'].value = passphrase;
  f.nodes['backup-confirm-password'].value = passphrase;
  f.nodes['backup-review'].checked = true;
}

test('saved-work create explicitly negotiates v2 and rejects a v1 response', async () => {
  const f = fixture(); assert.equal(f.nodes['backup-format'].value, 'saved-work-v2'); readyCreate(f, 'saved-work-v2');
  f.handler(async () => archiveResponse()); await f.nodes['backup-create'].click();
  assert.equal(JSON.parse(f.calls[0].options.body).format, 'saved-work-v2'); assert.equal(f.downloads.length, 0);
  assert.match(f.nodes['backup-create-status'].textContent, /unsupported backup response/);
  readyCreate(f, 'saved-work-v2'); const response = archiveResponse(); response.headers['X-TLI-Backup-Protocol'] = 'tli-saved-work-backup-v2';
  f.handler(async () => response); await f.nodes['backup-create'].click(); assert.equal(f.downloads.length, 1);
  assert.match(f.nodes['backup-download'].download, /TLI-Saved-work/);
  await f.nodes['backup-format'].fire('change'); assert.equal(f.nodes['backup-review'].checked, false);
});

test('v2 verification reports troubleshooting and rejects missing or unexpected count areas', async () => {
  const data = verification(); data.schema_version = 2; data.protocol = 'tli-saved-work-backup-v2'; data.recovery_scope = 'Saved work backup'; data.counts.cases = 2;
  Object.assign(data.manifest, {schema_version:2,protocol:data.protocol,scope:data.recovery_scope});
  data.manifest.entries.push({name:'cases.json',bytes:256,sha256:'c'.repeat(64),records:2});
  const f = fixture(); readyVerify(f); f.handler(async()=>({data})); await f.nodes['backup-verify'].click();
  assert.match(text(f.nodes['backup-verification-report']), /Troubleshooting problems: 2/);
  for(const mutation of [d=>delete d.counts.cases,d=>d.counts.extra=1,d=>d.schema_version=1]) {
    const g=fixture();readyVerify(g);const damaged=structuredClone(data);mutation(damaged);g.handler(async()=>({data:damaged}));await g.nodes['backup-verify'].click();
    assert.equal(g.nodes['backup-verification-report'].hidden,true);
  }
});

test('v2 recovery requires matching troubleshooting counts in review and current-reader receipt', async () => {
  const f=fixture();readyRecovery(f);const review=recoveryReview();review.counts={...review.counts,cases:3};
  f.handler(async()=>({data:review}));await f.nodes['recovery-copy-review'].click();await acknowledgeRecovery(f);
  const completed=recoveryReceipt();completed.counts={...completed.counts,cases:3};completed.readback.counts={...completed.readback.counts,cases:2};
  f.handler(async()=>({data:completed}));await f.nodes['recovery-copy-create'].click();
  assert.equal(f.nodes['recovery-copy-receipt'].hidden,true);assert.match(f.nodes['recovery-copy-status'].textContent,/complete recovery receipt/);
});
function archiveResponse() {
  const bytes = Buffer.alloc(512, 73);
  return { blob: new Blob([bytes]), headers: { 'X-TLI-Backup-Protocol': 'tli-notebook-history-backup-v1',
    'X-TLI-Backup-SHA256': createHash('sha256').update(bytes).digest('hex'), 'Content-Type': 'application/vnd.tli.notebook-history-backup' } };
}
function readyVerify(f) {
  f.nodes['backup-file'].files = [new File([Buffer.alloc(512, 73)], 'sample.tlibackup')];
  f.nodes['backup-verify-password'].value = passphrase;
}
function verification() {
  const counts = { notebook: 2, conversations: 1, diagnostics: 0 };
  return { ok: true, schema_version: 1, protocol: 'tli-notebook-history-backup-v1', checked_at: '2026-09-08T14:30:00Z',
    archive_sha256: 'a'.repeat(64), archive_integrity: 'verified', contents_readable: true, restored_live: false,
    recovery_scope: 'Notebook & history backup', detail: 'The uploaded archive was read in an isolated encrypted copy. No live restoration was performed.',
    source: { owner_id: 'fixture-owner', tli_version: '1.0', source_host: { id: 'fixture-host', name: 'Sample host' }, exported_at: '2026-09-07T14:30:00Z' }, counts,
    manifest: { schema_version: 1, protocol: 'tli-notebook-history-backup-v1', scope: 'Notebook & history backup', created_at: '2026-09-07T14:30:00Z',
      included: ['All saved Notebook and AI history for this account'], excluded: ['Vault, credentials, pairing, other owners and outside files'], limitations: ['No live restoration or whole-installation backup'],
      entries: ['account.json', 'notebook.json', 'conversations.json', 'diagnostics.json'].map(name => ({ name, bytes: 64, sha256: 'b'.repeat(64), records: name === 'account.json' ? 1 : counts[name.slice(0, -5)] })) } };
}

test('archive creation requires matching password and explicit scope review before any request', async () => {
  const f = fixture(); readyCreate(f);
  f.nodes['backup-password'].value = 'short'; await f.nodes['backup-create'].click();
  assert.match(f.nodes['backup-create-status'].textContent, /12 characters/);
  readyCreate(f); f.nodes['backup-confirm-password'].value = 'Different password'; await f.nodes['backup-create'].click();
  assert.match(f.nodes['backup-create-status'].textContent, /do not match/);
  readyCreate(f); f.nodes['backup-review'].checked = false; await f.nodes['backup-create'].click();
  assert.match(f.nodes['backup-create-status'].textContent, /acknowledge/);
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
});

test('plain HTTP LAN connections never submit a backup password', async () => {
  const f = fixture(); readyCreate(f); readyVerify(f); f.location.protocol = 'http:';
  await f.nodes['backup-create'].click(); await f.nodes['backup-verify'].click();
  assert.equal(f.calls.length, 0);
  assert.match(f.nodes['backup-create-status'].textContent, /secure HTTPS/);
  assert.match(f.nodes['backup-verify-status'].textContent, /secure HTTPS/);
});

test('one create click prepares one encrypted download without claiming that it was saved or restored', async () => {
  const f = fixture(); readyCreate(f); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.nodes['backup-create'].click(); await tick();
  await f.nodes['backup-create'].click(); await f.nodes['backup-verify'].click();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/intelligence/backups/create');
  const body = JSON.parse(f.calls[0].options.body);
  assert.equal(body.password, passphrase); assert.match(body.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(f.calls[0].options.cache, 'no-store');
  assert.equal(f.calls[0].options.redirect, 'error');
  finish(archiveResponse()); await pending;
  assert.equal(f.downloads.length, 1); assert.equal(f.nodes['backup-download'].hidden, false);
  assert.match(f.nodes['backup-create-status'].textContent, /download was requested.*Check that the file was saved.*live restore has not been tested/);
  assert.equal(f.nodes['backup-password'].value, ''); assert.equal(f.nodes['backup-confirm-password'].value, '');
  assert.equal(f.nodes['backup-create'].disabled, false); assert.equal(f.nodes['backup-verify'].disabled, false);
  assert.equal(f.nodes['backup-verification-report'].hidden, true);
});

test('invalid protocol, wrong transfer checksum and failed responses never download or auto-retry', async () => {
  for (const kind of ['protocol', 'checksum', 'failure', 'size']) {
    const f = fixture(); readyCreate(f); const reply = archiveResponse();
    if (kind === 'protocol') reply.headers['X-TLI-Backup-Protocol'] = 'unsupported';
    if (kind === 'checksum') reply.headers['X-TLI-Backup-SHA256'] = 'a'.repeat(64);
    if (kind === 'failure') { reply.status = 503; reply.data = { detail: 'Saved data is unavailable' }; }
    if (kind === 'size') reply.blob = new Blob(['too small']);
    f.handler(async () => reply); await f.nodes['backup-create'].click();
    assert.equal(f.calls.length, 1); assert.equal(f.downloads.length, 0);
    assert.equal(f.nodes['backup-download'].hidden, true);
    assert.match(f.nodes['backup-create-status'].textContent, /No automatic retry/);
    assert.equal(f.nodes['backup-password'].value, '');
  }
});

test('failed later creation retains only the previous encrypted download link', async () => {
  const f = fixture(); readyCreate(f); f.handler(async () => archiveResponse()); await f.nodes['backup-create'].click();
  const previous = f.nodes['backup-download'].href;
  readyCreate(f); f.handler(async () => ({ status: 503, data: { detail: 'Unavailable' } })); await f.nodes['backup-create'].click();
  assert.equal(f.nodes['backup-download'].href, previous);
  assert.match(f.nodes['backup-create-status'].textContent, /previous archive download link remains/);
  assert.equal(f.downloads.length, 1);
});

test('locked session discards a late archive and clears passwords and previous download URLs', async () => {
  const f = fixture(); readyCreate(f); f.handler(async () => archiveResponse()); await f.nodes['backup-create'].click();
  readyCreate(f); let finish; f.handler(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.nodes['backup-create'].click(); await tick();
  for (const clear of f.events['tli-session-locked']) clear();
  assert.equal(f.calls[1].options.signal.aborted, true);
  finish(archiveResponse()); await pending;
  assert.equal(f.downloads.length, 1); assert.equal(f.revoked.length, 1);
  assert.equal(f.nodes['backup-download'].hidden, true); assert.equal(f.nodes['backup-password'].value, '');
});

test('verification requires a bounded archive and sends only an explicit selected file', async () => {
  const f = fixture(); readyVerify(f);
  f.nodes['backup-file'].files = [{ name: 'file.zip', size: 512 }]; await f.nodes['backup-verify'].click();
  f.nodes['backup-file'].files = [{ name: 'file.tlibackup', size: 64 * 1024 * 1024 + 1 }]; await f.nodes['backup-verify'].click();
  assert.equal(f.calls.length, 0);
  readyVerify(f); f.handler(async () => ({ data: verification() })); await f.nodes['backup-verify'].click();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/intelligence/backups/verify');
  const form = f.calls[0].options.body;
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(form.get('password'), passphrase); assert.equal(form.get('file').name, 'sample.tlibackup');
  assert.equal(f.nodes['backup-verify-password'].value, ''); assert.equal(f.downloads.length, 0);
  assert.match(text(f.nodes['backup-verification-report']), /Archive integrity: verified.*Saved contents: readable.*Live restoration: not performed/);
  assert.match(text(f.nodes['backup-verification-report']), /fixture-owner.*Sample host/);
  assert.match(text(f.nodes['backup-verification-report']), /Full archive manifest.*account.json.*SHA-256.*Excluded/);
});

test('duplicate verify clicks cannot start another upload while an operation is pending', async () => {
  const f = fixture(); readyVerify(f); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.nodes['backup-verify'].click(); await tick(); await f.nodes['backup-verify'].click(); await f.nodes['backup-create'].click();
  assert.equal(f.calls.length, 1);
  finish({ data: verification() }); await pending;
  assert.equal(f.nodes['backup-verify'].disabled, false);
});

test('malformed verification and invented live restore cannot appear successful', async () => {
  const data = verification();
  for (const invalid of [null, {}, { ...data, restored_live: true }, { ...data, contents_readable: false },
    { ...data, archive_integrity: 'unknown' }, { ...data, counts: { ...data.counts, notebook: -1 } },
    { ...data, manifest: { ...data.manifest, entries: [] } }]) {
    const f = fixture(); readyVerify(f); f.handler(async () => ({ data: invalid })); await f.nodes['backup-verify'].click();
    assert.equal(f.nodes['backup-verification-report'].hidden, true);
    assert.match(f.nodes['backup-verify-status'].textContent, /incomplete archive verification/);
    assert.equal(f.calls.length, 1);
  }
});

test('failed later verification labels the previous result instead of certifying this attempt', async () => {
  const f = fixture(); readyVerify(f); f.handler(async () => ({ data: verification() })); await f.nodes['backup-verify'].click();
  const original = text(f.nodes['backup-verification-report']);
  readyVerify(f); f.handler(async () => ({ status: 422, data: { detail: 'Incorrect password or changed file' } })); await f.nodes['backup-verify'].click();
  assert.equal(text(f.nodes['backup-verification-report']), original);
  assert.match(f.nodes['backup-verify-status'].textContent, /previous verification remains.*does not describe this attempt/);
  assert.equal(f.calls.length, 2);
});

test('uploaded metadata and manifest text render literally without HTML execution', async () => {
  const f = fixture(), data = verification(); data.source.owner_id = '<img onerror=alert(1)>'; data.manifest.included = ['<script>ignored</script>'];
  readyVerify(f); f.handler(async () => ({ data })); await f.nodes['backup-verify'].click();
  assert.match(text(f.nodes['backup-verification-report']), /<img.*<script>/);
  assert.ok(descendants(f.nodes['backup-verification-report']).every(n => !['img', 'script'].includes(n.tag) && n.innerHTML === undefined));
});

test('logout and page exit invalidate an in-flight verification and remove its prior report', async () => {
  const f = fixture(); readyVerify(f); let finish;
  f.handler(() => new Promise(resolve => { finish = resolve; })); const pending = f.nodes['backup-verify'].click(); await tick();
  for (const clear of f.events.pagehide) clear(); finish({ data: verification() }); await pending;
  assert.equal(f.nodes['backup-verification-report'].hidden, true);
  assert.equal(f.nodes['backup-verify-password'].value, '');
  assert.equal(f.calls[0].options.signal.aborted, true);
});
const recoveryBytes=Buffer.alloc(512,73), recoveryHash=createHash('sha256').update(recoveryBytes).digest('hex');
function readyRecovery(f,destination='C:\\TLI-Recovery\\Anniversary copy') {
 f.nodes['recovery-copy-file'].files=[new File([recoveryBytes],'sample.tlibackup')];
 f.nodes['recovery-copy-password'].value=passphrase;f.nodes['recovery-copy-destination'].value=destination;
 f.nodes['recovery-copy-settings'].open=true;
}
function recoveryReview(){return{ok:true,schema_version:1,scope:'separate-data-copy',destination:'C:\\TLI-Recovery\\Anniversary copy',archive_sha256:recoveryHash,source:verification().source,counts:verification().counts,owner_mapping:{source_owner:'fixture-owner',target_owner:'local'},activated:false,review_token:'fixture-review-token',checked_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),included:['Notes, conversations and reports'],excluded:['Vault and credentials'],limitations:['No automatic activation'],required_free_bytes:1024,available_free_bytes:8192};}
function recoveryReceipt(){const review=recoveryReview();return{...review,completed_at:new Date().toISOString(),readback:{ok:true,schema_version:1,reader:'current-application',owner:'local',counts:review.counts,checks:{encrypted_payloads:true,current_readers:true,record_identifiers:true,stored_metadata:true,owner_mapping:true,files_unchanged:true},checked_at:new Date().toISOString()}};}
async function inspectRecovery(f){f.handler(async()=>({data:recoveryReview()}));await f.nodes['recovery-copy-review'].click();}
async function acknowledgeRecovery(f){f.nodes['recovery-copy-ack'].checked=true;await f.nodes['recovery-copy-ack'].fire('change');}

test('separate recovery is secondary, explicitly reviewed and never starts on opening',async()=>{
 const f=fixture();readyRecovery(f);await f.nodes['recovery-copy-settings'].fire('toggle');
 assert.equal(f.calls.length,0);assert.equal(f.nodes['recovery-copy-create'].disabled,true);
 assert.match(text(f.root),/new folder on the computer hosting TLI.*not replace your current data/);
 await inspectRecovery(f);assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/recovery\/review$/);
 assert.equal(f.calls[0].options.body.get('password'),passphrase);assert.equal(f.calls[0].options.body.has('review_token'),false);
 assert.match(text(f.nodes['recovery-copy-review-result']),/fixture-owner.*fresh local owner.*Notes & fixes records: 2.*Excluded: Vault/s);
 assert.equal(f.nodes['recovery-copy-create'].disabled,true);await f.nodes['recovery-copy-create'].click();assert.equal(f.calls.length,1);
});
test('explicit acknowledged create resubmits the reviewed file and token once and cannot activate TLI',async()=>{
 const f=fixture();readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);let done;
 f.handler(()=>new Promise(resolve=>done=resolve));const pending=f.nodes['recovery-copy-create'].click();await tick();
 await f.nodes['recovery-copy-create'].click();await f.nodes['recovery-copy-review'].click();assert.equal(f.calls.length,2);
 const form=f.calls[1].options.body;assert.equal(form.get('password'),passphrase);assert.equal(form.get('review_token'),'fixture-review-token');assert.equal(form.get('destination'),recoveryReview().destination);
 assert.equal(form.get('file').size,recoveryBytes.length);assert.notEqual(form.get('request_id'),f.calls[0].options.body.get('request_id'));
 done({data:recoveryReceipt()});await pending;assert.match(text(f.nodes['recovery-copy-receipt']),/Current application readers reopened.*not activated/);
 assert.equal(f.nodes['recovery-copy-password'].value,'');assert.equal(f.nodes['recovery-copy-create'].disabled,true);assert.equal(f.nodes['recovery-copy-review-result'].hidden,true);assert.equal(f.downloads.length,0);
});
for(const field of ['file','password','destination'])test(`changing ${field} invalidates review even without a browser input event`,async()=>{
 const f=fixture();readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);
 if(field==='file')f.nodes['recovery-copy-file'].files=[new File([recoveryBytes],'other.tlibackup')];
 else f.nodes[`recovery-copy-${field}`].value+=' different';
 await f.nodes['recovery-copy-create'].click();assert.equal(f.calls.length,1);assert.equal(f.nodes['recovery-copy-review-result'].hidden,true);assert.match(f.nodes['recovery-copy-status'].textContent,/changed.*Review the copy again/);
});
test('review validates transport, file, password and an absolute host path before sending',async()=>{
 const f=fixture();readyRecovery(f);f.location.protocol='http:';await f.nodes['recovery-copy-review'].click();assert.equal(f.calls.length,0);
 f.location.protocol='https:';f.nodes['recovery-copy-destination'].value='relative-folder';await f.nodes['recovery-copy-review'].click();assert.equal(f.calls.length,0);
 for(const invalid of ['//server/share/new','\\\\server\\share\\new','C:\\'+'x'.repeat(1024)]){f.nodes['recovery-copy-destination'].value=invalid;await f.nodes['recovery-copy-review'].click();assert.equal(f.calls.length,0);}
 readyRecovery(f);f.nodes['recovery-copy-password'].value='short';await f.nodes['recovery-copy-review'].click();assert.equal(f.calls.length,0);
 readyRecovery(f);f.nodes['recovery-copy-file'].files=[new File(['small'],'bad.tlibackup')];await f.nodes['recovery-copy-review'].click();assert.equal(f.calls.length,0);
});
for(const kind of ['checksum','account','expired','activated','source','scope'])test(`an invalid ${kind} review cannot expose Create`,async()=>{
 const f=fixture();readyRecovery(f);const data=recoveryReview();
 if(kind==='checksum')data.archive_sha256='b'.repeat(64);if(kind==='account')data.owner_mapping.target_owner='current-account';if(kind==='expired')data.expires_at='2001-01-01T00:00:00Z';if(kind==='activated')data.activated=true;if(kind==='source')delete data.source;if(kind==='scope')delete data.excluded;
 f.handler(async()=>({data}));await f.nodes['recovery-copy-review'].click();assert.equal(f.nodes['recovery-copy-create'].disabled,true);assert.equal(f.nodes['recovery-copy-review-result'].hidden,true);assert.match(f.nodes['recovery-copy-status'].textContent,/incomplete or expired/);
});
for(const kind of ['destination','counts','reader','owner','activated','checks','missing check'])test(`a mismatched ${kind} create receipt remains uncertain, without success or retry`,async()=>{
 const f=fixture();readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);const data=recoveryReceipt();
 if(kind==='destination')data.destination+='other';if(kind==='counts')data.counts.notebook++;if(kind==='reader')data.readback.reader='unproven';if(kind==='owner')data.readback.owner='other';if(kind==='activated')data.activated=true;if(kind==='checks')data.readback.checks.current_readers=false;if(kind==='missing check')delete data.readback.checks.files_unchanged;
 f.handler(async()=>({data}));await f.nodes['recovery-copy-create'].click();assert.equal(f.nodes['recovery-copy-receipt'].hidden,true);assert.match(f.nodes['recovery-copy-status'].textContent,/outcome is uncertain.*Nothing was retried/);assert.equal(f.calls.length,2);
});
test('network uncertainty and explicit failures retain the previous completed receipt and require fresh review',async()=>{
 const f=fixture();readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);f.handler(async()=>({data:recoveryReceipt()}));await f.nodes['recovery-copy-create'].click();const before=text(f.nodes['recovery-copy-receipt']);
 for(const network of [true,false]){readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);f.handler(async()=>{if(network)throw Error('Network lost');return{status:409,data:{detail:'Destination appeared'}};});await f.nodes['recovery-copy-create'].click();assert.equal(text(f.nodes['recovery-copy-receipt']),before);assert.match(f.nodes['recovery-copy-status'].textContent,/previous completed receipt remains/);assert.equal(f.nodes['recovery-copy-create'].disabled,true);}
 assert.equal(f.calls.length,6);
});
for(const leave of ['lock','close','panel','background'])test(`${leave} clears private recovery fields and ignores a late create without claiming cancellation`,async()=>{
 const f=fixture();readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);let done;
 f.handler(()=>new Promise(resolve=>done=resolve));const pending=f.nodes['recovery-copy-create'].click();await tick();
 if(leave==='lock')for(const fn of f.events['tli-session-locked'])fn();
 if(leave==='close'){f.nodes['recovery-copy-settings'].open=false;await f.nodes['recovery-copy-settings'].fire('toggle');}
 if(leave==='panel')for(const fn of f.events['tli-panel-switched'])fn({detail:{panelId:'panel-main'}});
 if(leave==='background'){f.document.hidden=true;for(const fn of f.events.visibilitychange)fn();}
 assert.equal(f.nodes['recovery-copy-password'].value,'');assert.equal(f.nodes['recovery-copy-file'].value,'');assert.equal(f.nodes['recovery-copy-destination'].value,'');assert.equal(f.calls[1].options.signal.aborted,true);
 done({data:recoveryReceipt()});await pending;assert.equal(f.nodes['recovery-copy-receipt'].hidden,true);assert.match(f.nodes['recovery-copy-status'].textContent,/may have completed.*Nothing was retried/);assert.doesNotMatch(f.nodes['recovery-copy-status'].textContent,/cancelled/);
});
test('review pending is reserved once and late unauthorized results cannot clear a newer unlocked review',async()=>{
 const f=fixture();readyRecovery(f);let done,started;const requestStarted=new Promise(resolve=>started=resolve);
 f.handler(()=>new Promise(resolve=>{done=resolve;started();}));const pending=f.nodes['recovery-copy-review'].click();await requestStarted;await f.nodes['recovery-copy-review'].click();assert.equal(f.calls.length,1);
 for(const fn of f.events['tli-session-locked'])fn();for(const fn of f.events['tli-session-unlocked'])fn();readyRecovery(f);await inspectRecovery(f);
 done({status:401,data:{detail:'Old session'}});await pending;assert.equal(f.nodes['recovery-copy-review-result'].hidden,false);assert.equal(f.calls.length,2);
});

test('failure before create request construction does not imply that a copy may exist',async()=>{
 const f=fixture();readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);f.context.crypto={subtle:webcrypto.subtle};
 await f.nodes['recovery-copy-create'].click();assert.equal(f.calls.length,1);assert.doesNotMatch(f.nodes['recovery-copy-status'].textContent,/outcome is uncertain/);assert.match(f.nodes['recovery-copy-status'].textContent,/secure browser context.*new review/);
});
test('an explicit unauthorized create clears private state without claiming uncertain execution',async()=>{
 const f=fixture();readyRecovery(f);await inspectRecovery(f);await acknowledgeRecovery(f);f.handler(async()=>({status:401,data:{detail:'Unlock TLI'}}));await f.nodes['recovery-copy-create'].click();
 assert.equal(f.nodes['recovery-copy-password'].value,'');assert.equal(f.nodes['recovery-copy-review-result'].hidden,true);assert.doesNotMatch(f.nodes['recovery-copy-status'].textContent,/may have completed/);assert.equal(f.nodes['recovery-copy-review'].disabled,true);
});
