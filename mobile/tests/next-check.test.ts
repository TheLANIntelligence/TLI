import test from 'node:test';
import assert from 'node:assert/strict';
import { NextCheckReview, nextCheck } from '../src/next-check';
import { PreviewCases, PREVIEW_CASE } from '../src/cases-preview';
import { caseBody, draftCase, validateCase } from '../src/cases';
import { casePointer, type SelectedCase } from '../src/case-context';
import { checkRequest } from '../src/guided-checks';
import { previewCheckOptions, PREVIEW_COMPUTER } from '../src/guided-checks-preview';
import { readFileSync } from 'node:fs';

test('actual isolated backend next-check response matches mobile selection, facts and run binding', async () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/next-check.json', import.meta.url), 'utf8'));
  assert.equal(f.synthetic_only, true);
  assert.deepEqual(validateCase({ ok: true, protocol: 'tli-cases-v1', case: f.case }), f.case);
  const selected = { title: f.case.title, updated_at: f.case.updated_at, ref: casePointer(f.request.case_ref) };
  const response = nextCheck(f.response, selected, f.case);
  assert.ok(response.facts); assert.deepEqual(response.steps, f.request.case_ref.step_ids.map((id: string) => f.case.steps.find((s: any) => s.id === id)));
  const option = response.options!.options.find(o => o.id === response.suggestion?.option_id)!;
  const expected = checkRequest(option, false, f.diagnostic_request.request_id);
  assert.deepEqual({ ...expected, next_check_ref: { case_ref: f.request.case_ref, selection_sha256: response.selection_sha256, option_id: option.id } }, f.diagnostic_request);
});

function fixture() {
  const store = new PreviewCases(), route = '/api/intelligence/cases/' + PREVIEW_CASE;
  let row = validateCase(store.request(route, 'GET', {}));
  row = validateCase(store.request(route, 'PUT', caseBody({ ...draftCase(row), symptom: 'Slow during exports', steps: [{ id: 'tried', text: 'Close one browser tab', status: 'tried', outcome: 'Export still slow.' }, { id: 'skip', text: 'Update driver', status: 'skipped', outcome: 'Not attempted.' }] }, row)));
  const selected: SelectedCase = { title: row.title, updated_at: row.updated_at, ref: { id: row.id, revision: row.revision, step_ids: ['tried', 'skip'], include_resolution: false, evidence_refs: [] } };
  const response = () => structuredClone(store.request('/api/intelligence/cases/next-check', 'POST', { case_ref: selected.ref })) as any;
  const calls: { path: string; method: string; body?: any }[] = [];
  let handler = async (path: string, method: string, body: any): Promise<any> => path.includes('/diagnostics/options') ? previewCheckOptions(PREVIEW_COMPUTER) : store.request(path, method, body);
  const api = { json: async <T>(path: string, method = 'GET', body = {}): Promise<T> => { calls.push({ path, method, body }); return handler(path, method, body); } };
  return { row, selected, response, store, calls, api, review: new NextCheckReview(), handler: (f: typeof handler) => handler = f };
}
test('next-check review is explicit, preserves selected tried/skipped outcomes and never starts a check', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  const r = await f.review.review(f.api, f.selected, f.row, () => true);
  assert.deepEqual(r.steps, f.row.steps); assert.equal(r.suggestion?.option_id, 'system');
  assert.deepEqual(f.calls.map(c => [c.path, c.method]), [['/api/intelligence/cases/capabilities', 'GET'], ['/api/intelligence/cases/next-check', 'POST']]);
  assert.deepEqual(f.calls[1]!.body, { case_ref: casePointer(f.selected.ref) }); assert.doesNotMatch(JSON.stringify(f.calls), /Slow during|Export still|Update driver/);
  assert.throws(() => f.review.runRef(r.options!.options[0]!), /Review/);
  const reviewed = await f.review.reviewSuggested(f.api, PREVIEW_COMPUTER, () => true);
  const run = { ...checkRequest(reviewed.option, false, 'once'), next_check_ref: f.review.runRef(reviewed.option) };
  assert.equal(f.calls.length, 3); assert.ok(f.calls[2]!.path.includes('include_peer_observation=true'));
  assert.deepEqual(run.next_check_ref.case_ref, f.selected.ref); assert.equal(run.internet, false); assert.equal(run.expected_host_id, 'sample-home');
});
test('guidance requires exact selection, saved case identity, receipt computer and every selected step field', () => {
  const f = fixture();
  const patches = [ (r: any) => r.guidance.selection.step_ids.reverse(), (r: any) => r.guidance.selection.include_resolution = true, (r: any) => r.case_context.computer_id = 'other', (r: any) => r.case_context.title = 'Other case', (r: any) => r.guidance.steps[1].status = 'tried', (r: any) => r.guidance.steps[0].outcome = 'Fixed', (r: any) => r.guidance.steps.pop(), (r: any) => r.guidance.steps[0].text = 'Reboot', (r: any) => r.evidence_context.sources[0].revision = '9'.repeat(64) ];
  for (const patch of patches) { const r = f.response(); patch(r); assert.throws(() => nextCheck(r, f.selected, f.row)); }
  assert.throws(() => nextCheck(f.response(), f.selected, { ...f.row, revision: '9'.repeat(64) }));
});
test('malformed guidance, bounds, invented source handles and unavailable/performance suggestions fail closed', () => {
  const f = fixture();
  for (const patch of [(r: any) => r.actions_performed = true, (r: any) => r.guidance.selection_sha256 = 'oops', (r: any) => r.guidance.known[0].source = 'R1', (r: any) => r.guidance.known[0].text = 'x'.repeat(4001), (r: any) => r.guidance.missing.push(...Array(8).fill(r.guidance.missing[0])), (r: any) => r.guidance.suggestion.option_id = 'performance', (r: any) => r.guidance.check_options.options[0].available = false, (r: any) => r.guidance.check_options.computer_id = 'other', (r: any) => r.guidance.status = 'healthy', (r: any) => r.guidance.check_options = null]) {
    const r = f.response(); patch(r); assert.throws(() => nextCheck(r, f.selected, f.row));
  }
});
test('no suggestion is a usable review state and never enables Run; no computer is not a host fallback', () => {
  const f = fixture(), r = f.response(); r.guidance.status = 'unavailable'; r.guidance.suggestion = null;
  assert.equal(nextCheck(r, f.selected, f.row).suggestion, null);
  const saved = { ...f.row, computer: null }; r.case_context.computer_id = null; r.guidance.check_options = null;
  assert.equal(nextCheck(r, f.selected, saved).options, null);
  r.guidance.check_options = previewCheckOptions(null); assert.throws(() => nextCheck(r, f.selected, saved));
});
test('exact selected report facts remain independently bound to report revision, target and historical time', () => {
  const f = fixture(), link = f.row.evidence[0]!;
  const selected = { ...f.selected, ref: { ...f.selected.ref, evidence_refs: [{ kind: 'report' as const, id: link.id, revision: link.revision }], report_refs: [{ kind: 'report' as const, id: link.id, revision: link.revision }] } };
  const r = f.store.request('/api/intelligence/cases/next-check', 'POST', { case_ref: selected.ref }) as any;
  assert.equal(nextCheck(r, selected, f.row).facts?.status, 'stopped');
  for (const patch of [{ report_id: 'other' }, { target: { id: 'other', name: 'Same name' } }, { recorded_at: '2026-01-01T00:00:00Z' }]) { const changed = structuredClone(r); Object.assign(changed.evidence_context.recorded_report, patch); assert.throws(() => nextCheck(changed, selected, f.row)); }
});
test('old host capability stops before guidance POST; failed replacement retains the prior card but revokes Run', async () => {
  const f = fixture(); await f.review.review(f.api, f.selected, f.row, () => true); const prior = f.review.result;
  f.handler(async () => ({ ok: true, protocol: 'tli-cases-v1', actions_performed: false }));
  await assert.rejects(f.review.review(f.api, f.selected, f.row, () => true), /does not support/); assert.equal(f.calls.length, 3); assert.equal(f.review.result, prior); assert.equal(f.review.current, false);
  await assert.rejects(f.review.reviewSuggested(f.api, PREVIEW_COMPUTER, () => true));
});
test('a changed or unavailable suggested scope requires renewed guidance without check POST or replay', async () => {
  for (const change of ['host', 'scope', 'available']) {
    const f = fixture(); await f.review.review(f.api, f.selected, f.row, () => true);
    f.handler(async () => { const o = previewCheckOptions(PREVIEW_COMPUTER); if (change === 'scope') o.options[0]!.scope_revision = '9'.repeat(64); if (change === 'available') o.options[0]!.available = false; if (change === 'host') o.host = { id: 'other', name: 'Same name' }; return o; });
    await assert.rejects(f.review.reviewSuggested(f.api, PREVIEW_COMPUTER, () => true)); assert.equal(f.review.current, false); assert.equal(f.calls.length, 3);
  }
});
for (const stage of ['capability', 'guidance', 'scope']) test('late ' + stage + ' response cannot repopulate private review after close/background/lock', async () => {
  const f = fixture(); if (stage === 'scope') await f.review.review(f.api, f.selected, f.row, () => true);
  let release!: (v: any) => void;
  f.handler(async path => stage === 'guidance' && path.endsWith('capabilities') ? f.store.request(path, 'GET', {}) : new Promise(r => release = r));
  const pending = stage === 'scope' ? f.review.reviewSuggested(f.api, PREVIEW_COMPUTER, () => true) : f.review.review(f.api, f.selected, f.row, () => true);
  await new Promise(r => setImmediate(r)); await assert.rejects(f.review.review(f.api, f.selected, f.row, () => true), /Wait/);
  const count = f.calls.length; f.review.invalidate(true); release(stage === 'scope' ? previewCheckOptions(PREVIEW_COMPUTER) : stage === 'guidance' ? f.response() : f.store.request('/api/intelligence/cases/capabilities', 'GET', {}));
  await assert.rejects(pending, /no longer current/); assert.equal(f.review.result, undefined); assert.equal(f.calls.length, count); assert.equal(f.review.current, false);
});
test('409 guidance conflict retains saved evidence and selections, with no automatic retry', async () => {
  const f = fixture(); await f.review.review(f.api, f.selected, f.row, () => true); const previous = f.review.result, selection = structuredClone(f.selected);
  f.handler(async path => { if (path.endsWith('capabilities')) return f.store.request(path, 'GET', {}); throw Error('409 saved case changed'); });
  await assert.rejects(f.review.review(f.api, f.selected, f.row, () => true), /409/); assert.equal(f.review.result, previous); assert.deepEqual(f.selected, selection); assert.equal(f.review.current, false); assert.equal(f.calls.length, 4);
});
