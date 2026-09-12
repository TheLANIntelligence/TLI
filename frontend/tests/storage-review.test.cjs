// Coverage/path helper regressions retained; job lifecycle tests live in free-space-workspace.test.cjs.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/free-space-fixture.cjs');
const context=()=>fixture().ctx;
test('review ranks real files and excludes protected subtrees and collapsed entries', () => {
  const ctx = context();
  const result = ctx.visReview({ path: 'C:\\', children: [
    { path: 'C:\\hiberfil.sys', name: 'hiberfil.sys', size: 1000 },
    { path: 'C:\\system', protected: true, children: [{ name: 'internal', size: 500 }] },
    { name: '(more)', synthetic: true, size: 10000 },
    { name: 'small.txt', path: 'C:\\small.txt', size: 10 },
    { name: 'installer.bin', path: 'C:\\installer.bin', size: 100 },
  ] });
  assert.equal(result.protectedBytes, 1500);
  assert.deepEqual(Array.from(result.files, file => file.name), ['installer.bin', 'small.txt']);
});


test('coverage distinguishes unknown, bounded and partial scans', () => {
  const ctx = context();
  assert.match(ctx.visCoverage(), /unknown/);
  assert.match(ctx.visCoverage({ partial: false }), /differ from space used/);
  const partial = ctx.visCoverage({ partial: true, denied: 3, depth_limited: 1, skipped: 2, entry_limited: true, time_limited: true });
  for (const text of ['3 unreadable', 'depth limit', '2 excluded', 'entry limit', 'time limit']) assert.ok(partial.includes(text));
});


test('cleanup explains partial and unknown estimates without promising freed space', () => {
  const ctx = context();
  assert.match(ctx.visCleanupCoverage({}), /unknown/);
  assert.match(ctx.visCleanupCoverage({ size_partial: false }), /not a promise of reclaimable/);
  const message = ctx.visCleanupCoverage({ size_partial: true,
    size_meta: { denied: 2, skipped: 1, time_limited: true, entry_limited: true, byte_limited: true } });
  for (const text of ['could not be read', 'links were skipped', 'time limit', 'entry limit', 'size limit']) {
    assert.ok(message.includes(text));
  }
});


test('duplicate coverage distinguishes full checks, partial results and older backends', () => {
  const ctx = context();
  assert.match(ctx.visDuplicateCoverage({}), /not been verified/);
  const message = ctx.visDuplicateCoverage({ verification: 'full_sha256', partial: true,
    time_limited: true, entry_limited: true, denied: 1, skipped: 2, changed: 1,
    hardlinks_skipped: 1, results_limited: true });
  for (const text of ['checked in full', 'Partial scan', 'time limit', 'entry limit', 'could not be read',
    'files changed', 'hard-link', 'largest 100', 'not guaranteed recoverable']) assert.ok(message.includes(text));
});


test('scan failures distinguish server, session, connection and display errors', () => {
  const ctx = context();
  assert.match(ctx.visScanFailure({status: 500}), /backend.*HTTP 500/);
  assert.doesNotMatch(ctx.visScanFailure({status: 500}), /permissions/);
  assert.match(ctx.visScanFailure({status: 401}), /session expired/);
  assert.match(ctx.visScanFailure({status: 403}), /denied access/);
  assert.match(ctx.visScanFailure({status: 422}), /rejected the scan request/);
  assert.match(ctx.visScanFailure({}), /connection failed/);
  assert.match(ctx.visScanFailure({}, true), /results could not be displayed/);
});


test('review navigation preserves Windows and POSIX roots', () => {
  const ctx = context();
  assert.equal(ctx.getParentFolderPath('C:\\review.zip'), 'C:\\');
  assert.equal(ctx.getParentFolderPath('/review.zip'), '/');
  assert.equal(ctx.getParentFolderPath('/home/user/review.zip'), '/home/user');
});

