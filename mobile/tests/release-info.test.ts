import test from 'node:test';
import assert from 'node:assert/strict';
import { hostRelease, nativeBuildLabel, releaseLabel, ReleaseReview } from '../src/release-info';
const release = () => ({ schema_version: 1, protocol: 'dependable-computers-v1', source_id: 'a'.repeat(64), backend_id: 'b'.repeat(64), frontend_id: 'c'.repeat(64), started_at: '2026-09-09T12:00:00Z', checked_at: '2026-09-09T12:01:00Z', identity_scope: 'Application only; excludes user data and models.', capabilities: ['case_report_review_v1'], compatibility: { state: 'matched', reasons: [] } });
test('build display uses native facts and never fabricates a native version for web or missing values', () => {
  assert.match(nativeBuildLabel({ nativeApplicationVersion: '0.1.0', nativeBuildVersion: '6', applicationId: 'com.thelegatointelligence.companion.beta' }).label, /0.1.0 · build 6/);
  assert.match(nativeBuildLabel({ nativeApplicationVersion: null, nativeBuildVersion: null, applicationId: null }).label, /version unavailable · build unavailable/);
  assert.match(nativeBuildLabel({ nativeApplicationVersion: '0.1.0', nativeBuildVersion: '6', applicationId: 'fake' }, true).label, /no installed native build/);
});
test('host identity state is not a claim of phone feature or model quality acceptance', () => {
  assert.equal(releaseLabel(hostRelease({ release: release() })), 'Host application files match its startup identity');
  assert.equal(releaseLabel(hostRelease({ release: { ...release(), compatibility: { state: 'restart_required', reasons: ['Files changed after startup.'] } } })), 'Host restart required');
  for (const value of [{}, { release: { ...release(), source_id: null } }, { release: { ...release(), protocol: 'new' } }, { release: { ...release(), checked_at: 'bad' } }]) assert.equal(releaseLabel(hostRelease(value)), 'Host release compatibility unknown');
});
test('release check is explicit GET-only and coalesces duplicate clicks', async () => {
  const review = new ReleaseReview(); let resolve!: (v: unknown) => void; const calls: string[] = [];
  const api = { json: (path: string) => { calls.push(path); return new Promise(r => { resolve = r; }); } };
  assert.deepEqual(calls, []); const pending = review.check(api, () => true); await review.check(api, () => true); assert.equal(calls.length, 1);
  resolve({ release: release() }); await pending; assert.ok(review.value); assert.equal(review.busy, false); assert.deepEqual(calls, ['/api/diagnostics/version']);
});
test('background, unmount and replacement pairing discard late release observations without replay', async () => {
  for (const lifecycle of ['suspend', 'clear'] as const) {
    const review = new ReleaseReview(); let resolve!: (v: unknown) => void; let calls = 0;
    const pending = review.check({ json: () => { calls++; return new Promise(r => { resolve = r; }); } }, () => true);
    review[lifecycle](); resolve({ release: release() }); await pending; assert.equal(review.value, undefined); assert.equal(calls, 1); assert.equal(review.busy, false);
  }
});
test('failed replacement check retains earlier identity as stale rather than marking current', async () => {
  const review = new ReleaseReview(); await review.check({ json: async () => ({ release: release() }) }, () => true);
  await review.check({ json: async () => { throw Error('offline'); } }, () => true);
  assert.ok(review.value); assert.equal(review.stale, true); assert.match(review.error, /could not be read/);
  await review.check({ json: async () => ({ version: 'old host' }) }, () => true); assert.equal(review.value, undefined); assert.match(review.error, /unknown/);
});
