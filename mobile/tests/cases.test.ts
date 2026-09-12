import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_PROTOCOL, caseBody, draftCase, emptyCase, validateCase, validateEvidence, linkPointer, evidenceAvailability, validCaseSummary } from '../src/cases';
const revision = 'a'.repeat(64), date = '2026-09-08T12:00:00Z';
const record = { ...emptyCase(), id: 'case-one', title: 'Printer pause', computer: null, created_at: date, updated_at: date, revision };
test('case saves contain only reviewed link pointers and revision, never source bodies or execution instructions', () => {
  const draft = { ...emptyCase(), title: 'Printer pause', evidence: [{ kind: 'note' as const, id: 'f-one', revision, label: 'Private title', availability: 'changed' as const }] };
  const body = caseBody(draft, record); assert.equal(body.expected_revision, revision); assert.deepEqual(body.evidence, [{ kind: 'note', id: 'f-one', revision }]);
  assert.equal('run' in body, false); assert.equal('note_text' in body.evidence[0]!, false);
  assert.equal(caseBody(draft, undefined, 'request-one').request_id, 'request-one');
});
test('resolved is deliberate and requires a user outcome', () => {
  assert.throws(() => caseBody({ ...emptyCase(), title: 'Problem', status: 'resolved' }));
  assert.equal(caseBody({ ...emptyCase(), title: 'Problem', status: 'resolved', resolution: 'Replaced cable; retested successfully.' }).status, 'resolved');
});
test('case and evidence limits reject malformed data before mutation', () => {
  assert.throws(() => caseBody({ ...emptyCase(), title: 'x'.repeat(121) }));
  assert.throws(() => caseBody({ ...emptyCase(), title: 'x', steps: [{ id: 's', text: '', status: 'planned', outcome: '' }] }));
  assert.throws(() => caseBody({ ...emptyCase(), title: 'x', evidence: [{ kind: 'chat', id: 'c', revision }] }));
});
test('readback requires supported schema and preserves old evidence revisions', () => {
  const value = { ...record, evidence: [{ kind: 'report' as const, id: 'report-one', revision, availability: 'unavailable' as const }] };
  assert.deepEqual(draftCase(validateCase({ ok: true, protocol: CASE_PROTOCOL, case: value })).evidence, value.evidence);
  assert.throws(() => validateCase({ ok: true, protocol: 'wrong', case: value }));
  assert.throws(() => validateCase({ ok: true, protocol: CASE_PROTOCOL, case: { ...value, revision: 'bad' } }));
});
test('reviewed evidence must match exact source and chat message', () => {
  const requested = { kind: 'chat', id: 'c', message_index: 3 }, evidence = { ...requested, revision, label: 'Saved reply' };
  assert.deepEqual(linkPointer(validateEvidence({ ok: true, protocol: CASE_PROTOCOL, evidence }, requested)), { ...requested, revision });
  assert.throws(() => validateEvidence({ ok: true, protocol: CASE_PROTOCOL, evidence: { ...evidence, message_index: 4 } }, requested));
});

test('matching evidence is labelled as saved-source agreement, never current health', () => {
  assert.equal(evidenceAvailability({ kind: 'note', id: 'n', revision, availability: 'current' }), 'Matches saved source');
  assert.equal(validCaseSummary({ ...record, computer: { id: 'x', name: {}, node_id: 'x' } }), false);
  assert.equal(validCaseSummary({ ...record, updated_at: 'bad' }), false);
});
