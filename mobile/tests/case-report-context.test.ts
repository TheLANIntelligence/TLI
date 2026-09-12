import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseReview, caseLinkKey, casePointer, checkCaseCapability, confirmCaseReceipt, validCaseRef } from '../src/case-context';
import { answerReport, evidenceLines } from '../src/answer-evidence';
const id = 'case-' + 'a'.repeat(32), revision = 'b'.repeat(64), reportRevision = 'c'.repeat(64), stamp = '2026-09-09T12:00:00Z';
const link = { kind: 'report' as const, id: 'report-a', revision: reportRevision, label: 'Saved host resources', availability: 'current' as const, linked_at: stamp };
const row = { id, revision, title: 'Slow desktop', symptom: 'Build slow', computer: { id: 'host-a', name: 'Studio', node_id: 'host-a' }, status: 'open', archived: false, created_at: stamp, updated_at: stamp, resolution: '', steps: [{ id: 's1', text: 'Review saved check', status: 'planned', outcome: '' }], evidence: [link] };
const capability = { ok: true, protocol: 'tli-cases-v1', actions_performed: false, case_context: 'tli-case-context-v1', case_report_context: 'tli-case-report-context-v1', max_case_reports: 1 };
function response(ref: any) {
  const facts = { version: 1, basis: 'saved_report', report_id: link.id, kind: 'system', host: { id: 'host-a', name: 'Studio' }, target: { id: 'host-a', name: 'Studio' }, process: null, recorded_at: stamp, started_at: null, finished_at: null, duration_seconds: null, requested_duration_seconds: null, status: 'partial', status_label: 'Some checks unavailable', recorded_samples: null, expected_samples: null, raw_samples_included: 0, checks: [{ id: 'cpu', label: 'CPU', status: 'unavailable', detail: 'No sample retained.', scope: 'host' }], omitted_checks: 0, measurements: [], limitations: ['Saved observations only.'] };
  return { ...capability, checked_at: stamp, case_context: { schema_version: 1, id, revision, title: row.title, updated_at: stamp, computer_id: 'host-a', status: 'open', archived: false, steps: ref.step_ids.map((id: string) => ({ id, status: 'planned' })), omitted_step_count: 1 - ref.step_ids.length, resolution_included: ref.include_resolution, evidence_links: [link], omitted_link_count: 0, linked_bodies_included: false, actions_performed: false, included_reports: [{ id: link.id, revision: reportRevision, handle: 'R1', host_id: 'host-a', target_id: 'host-a', recorded_at: stamp }] }, evidence_context: { version: 1, interpretation: 'backend', sources: [{ handle: 'C1', kind: 'case', id, revision, label: row.title, provenance: 'user_case', ranges: [] }, { handle: 'R1', kind: 'report', id: link.id, revision: reportRevision, host_id: 'host-a', target_id: 'host-a', label: link.label, provenance: 'diagnostic', ranges: [] }], citations: [], citations_checked: true, invalid_citations: 0, recorded_report: facts } };
}
function fixture() {
  const calls: { path: string; method: string; body?: any }[] = []; const review = new CaseReview();
  let handler = async (path: string, body?: any): Promise<any> => path.endsWith('/capabilities') ? capability : path.endsWith('/context-review') ? response(body.case_ref) : { ...capability, case: row };
  const api = { json: async <T>(path: string, method = 'GET', body?: any): Promise<T> => { calls.push({ path, method, body }); return handler(path, body); } };
  return { review, calls, api, handler: (next: typeof handler) => handler = next };
}
async function select(f: ReturnType<typeof fixture>) { await f.review.load(f.api, id, () => true); f.review.toggle('link', caseLinkKey(link), true); f.review.chooseReport(caseLinkKey(link)); }
test('one selected report requires explicit preview and separate acknowledgement; no navigation inference or body copying', async () => {
  const f = fixture(); await select(f); assert.deepEqual(f.calls.map(c => c.method), ['GET', 'GET']);
  f.review.acknowledged = true; assert.throws(() => f.review.selection(), /Preview/);
  await f.review.previewReport(f.api, () => true); assert.equal(f.review.acknowledged, false); f.review.acknowledged = true;
  const selected = f.review.selection(); assert.deepEqual(selected.ref.report_refs, [{ kind: 'report', id: link.id, revision: reportRevision }]);
  assert.doesNotMatch(JSON.stringify(selected), /No sample|measurements|Build slow/); assert.deepEqual(f.calls.map(c => c.method), ['GET', 'GET', 'GET', 'POST']);
  const result = response(selected.ref); confirmCaseReceipt(selected.ref, result.case_context, result.evidence_context); assert.equal(answerReport(result).facts?.status, 'partial');
  assert.match(evidenceLines(result).join(' '), /Bounded facts from one explicitly reviewed saved report/);
});
test('changing steps, links or resolution invalidates the exact reviewed facts', async () => {
  const f = fixture(); await select(f); await f.review.previewReport(f.api, () => true); f.review.toggle('step', 's1', true); assert.equal(f.review.preview, undefined);
  f.review.acknowledged = true; assert.throws(() => f.review.selection(), /Preview/);
  await f.review.previewReport(f.api, () => true); f.review.resolution = true; f.review.acknowledged = true; assert.throws(() => f.review.selection(), /Preview/);
  f.review.toggle('link', caseLinkKey(link), false); assert.equal(f.review.reportKey, undefined);
});
test('preview conflicts retain selections and cannot approve or retry automatically', async () => {
  const f = fixture(); await select(f); f.handler(async path => { if (path.endsWith('capabilities')) return capability; throw Error('409 saved source changed'); });
  await assert.rejects(f.review.previewReport(f.api, () => true), /409/); assert.equal(f.review.reportKey, caseLinkKey(link)); assert.equal(f.review.links.length, 1); assert.equal(f.review.preview, undefined); assert.equal(f.calls.length, 4);
});
test('late preview is discarded on close/lock and a second preview coalesces before POST', async () => {
  const f = fixture(); await select(f); let release!: (v: unknown) => void;
  f.handler(async path => path.endsWith('capabilities') ? capability : new Promise(resolve => { release = resolve; }));
  const pending = f.review.previewReport(f.api, () => true); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.review.previewReport(f.api, () => true)); f.review.clear(); release(response({ step_ids: [], include_resolution: false }));
  await assert.rejects(pending, /no longer current/); assert.equal(f.review.preview, undefined); assert.equal(f.review.row, undefined); assert.equal(f.calls.length, 4);
});
test('vanished capability fails before report POST and before sending a case question', async () => {
  const f = fixture(); await select(f); f.handler(async () => ({ ...capability, case_report_context: undefined }));
  await assert.rejects(f.review.previewReport(f.api, () => true), /does not support/); assert.equal(f.calls.length, 3);
  await assert.rejects(checkCaseCapability(f.api, () => true, true), /No case question was sent/);
});
test('report requests must be exact selected pointers; facts bind revision, case, host, target and time', async () => {
  const ref = { id, revision, step_ids: [], include_resolution: false, evidence_refs: [{ kind: 'report' as const, id: link.id, revision: reportRevision }], report_refs: [{ kind: 'report' as const, id: link.id, revision: reportRevision }] };
  for (const patch of [{ evidence_refs: [] }, { report_refs: [{ ...ref.report_refs[0], revision: 'd'.repeat(64) }] }, { report_refs: [...ref.report_refs, ...ref.report_refs] }]) assert.equal(validCaseRef({ ...ref, ...patch }), false);
  assert.doesNotMatch(JSON.stringify(casePointer({ ...ref, report_refs: [{ ...ref.report_refs[0], body: 'private' } as any] })), /private/);
  for (const patch of [{ report_id: 'other' }, { host: { id: 'other', name: 'Studio' } }, { target: null }, { recorded_at: '2026-09-09T13:00:00Z' }]) {
    const result = response(ref); Object.assign(result.evidence_context.recorded_report, patch);
    assert.throws(() => confirmCaseReceipt(ref, result.case_context, result.evidence_context), /exact reviewed report/); assert.equal(answerReport(result).facts, undefined);
  }
  const result = response(ref); result.evidence_context.sources[1]!.revision = 'e'.repeat(64); assert.throws(() => confirmCaseReceipt(ref, result.case_context, result.evidence_context));
  const duplicate = response(ref); duplicate.evidence_context.sources.push(duplicate.evidence_context.sources[1]!); assert.throws(() => confirmCaseReceipt(ref, duplicate.case_context, duplicate.evidence_context));
  const changed = response(ref); changed.case_context.evidence_links = [{ ...link, availability: 'changed' } as any]; assert.throws(() => confirmCaseReceipt(ref, changed.case_context, changed.evidence_context));
  assert.throws(() => confirmCaseReceipt({ ...ref, report_refs: [] }, result.case_context, result.evidence_context));
});
