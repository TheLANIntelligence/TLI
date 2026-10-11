import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseReview, caseLinkKey, casePointer, confirmCaseReceipt, validCaseRef, validCaseReceipt, validateCaseContext } from '../src/case-context';
import { answerEvidence, evidenceLines, evidenceSources } from '../src/answer-evidence';
import type { TroubleshootingCase } from '../src/cases';
import type { ChatContext } from '../src/types';
import { PreviewCases, PREVIEW_CASE } from '../src/cases-preview';
const id = 'case-' + 'a'.repeat(32), revision = 'b'.repeat(64), stamp = '2026-09-08T12:00:00Z';
const row = (): TroubleshootingCase => ({ id, revision, title: 'Printer paused', symptom: 'Half a page printed', computer: { id: 'computer-one', name: 'Desk', node_id: null }, status: 'open', archived: false, created_at: stamp, updated_at: stamp, resolution: 'UNSELECTED_RESOLUTION', steps: [{ id: 'step-one', text: 'Restart app', status: 'planned', outcome: 'Not tried' }], evidence: [{ kind: 'note', id: 'note-one', revision: 'c'.repeat(64), label: 'Cable note', availability: 'unavailable', linked_at: stamp }] });
const capability = { ok: true, protocol: 'tli-cases-v1', case_context: 'tli-case-context-v1', actions_performed: false };
function fixture() { const requests: string[] = []; let handler = async (url: string): Promise<any> => url.endsWith('capabilities') ? capability : { ...capability, case: row() }; return { review: new CaseReview(), requests, handler: (next: typeof handler) => handler = next, api: { json: async <T>(url: string): Promise<T> => { requests.push(url); return handler(url); } } }; }
const ref = () => ({ id, revision, step_ids: ['step-one'], include_resolution: false, evidence_refs: [{ kind: 'note' as const, id: 'note-one', revision: 'c'.repeat(64) }] });
export const receipt = () => ({ schema_version: 1 as const, id, revision, title: 'Printer paused', updated_at: stamp, computer_id: 'computer-one', status: 'open' as const, archived: false, steps: [{ id: 'step-one', status: 'planned' as const }], omitted_step_count: 0, resolution_included: false, evidence_links: row().evidence, omitted_link_count: 0, linked_bodies_included: false as const, actions_performed: false as const });

test('review uses reads only and explicit whole selections produce pointer-only ephemeral context', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0); await f.review.load(f.api, id, () => true);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.review.steps, []); assert.deepEqual(f.review.links, []); assert.equal(f.review.resolution, false);
  assert.throws(() => f.review.selection(), /acknowledge/);
  f.review.toggle('step', 'step-one', true); f.review.toggle('link', caseLinkKey(row().evidence[0]!), true); f.review.acknowledged = true;
  const chosen = f.review.selection(); assert.deepEqual(chosen.ref, ref()); assert.doesNotMatch(JSON.stringify(chosen), /Half a page|Restart app|Not tried|UNSELECTED_RESOLUTION|availability|linked_at/);
  assert.equal(f.requests.length, 2); assert.equal(f.review.row!.computer!.node_id, null);
});

test('failed replacement preserves choices but cannot approve until a fresh checked revision', async () => {
  const f = fixture(); await f.review.load(f.api, id, () => true); f.review.toggle('step', 'step-one', true); f.review.acknowledged = true;
  f.handler(async () => { throw new Error('Unavailable'); }); await assert.rejects(f.review.load(f.api, id, () => true));
  assert.deepEqual(f.review.steps, ['step-one']); assert.throws(() => f.review.selection(), /Check and acknowledge/);
  f.handler(async url => url.endsWith('capabilities') ? capability : { ...capability, case: { ...row(), revision: 'd'.repeat(64) } });
  await f.review.load(f.api, id, () => true); assert.equal(f.review.acknowledged, false); f.review.acknowledged = true; assert.equal(f.review.selection().ref.revision, 'd'.repeat(64));
});

for (const boundary of ['close', 'clear', 'session']) test('late read cannot populate or approve after ' + boundary, async () => {
  const f = fixture(); let release!: (value: unknown) => void, current = true;
  f.handler(() => new Promise(resolve => { release = resolve; })); const pending = f.review.load(f.api, id, () => current);
  if (boundary === 'close') f.review.close(); else if (boundary === 'clear') f.review.clear(); else current = false;
  release(capability); await assert.rejects(pending, /no longer current/); assert.equal(f.requests.length, 1); assert.equal(f.review.row, undefined); assert.throws(() => f.review.selection());
});

test('late source read and duplicate review cannot replace cleared private details', async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  f.handler(async url => url.endsWith('capabilities') ? capability : new Promise(resolve => { release = resolve; }));
  const pending = f.review.load(f.api, id, () => true); await new Promise(r => setImmediate(r));
  await assert.rejects(f.review.load(f.api, id, () => true), /Wait/); f.review.clear(); release({ ...capability, case: row() }); await assert.rejects(pending);
  assert.equal(f.requests.length, 2); assert.equal(f.review.row, undefined);
});

test('closed review retains in-memory draft but forced approval fails', async () => {
  const f = fixture(); await f.review.load(f.api, id, () => true); f.review.toggle('step', 'step-one', true); f.review.acknowledged = true; f.review.close();
  assert.throws(() => f.review.selection()); assert.deepEqual(f.review.steps, ['step-one']); await f.review.load(f.api, id, () => true); assert.equal(f.review.acknowledged, false);
  f.review.clear(); assert.equal(f.review.row, undefined); assert.deepEqual(f.review.steps, []);
});

test('limit eight is whole-item and every accepted change requires acknowledgement again', async () => {
  const f = fixture(), many = row(); many.steps = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, text: 'Whole step ' + i, status: 'planned', outcome: 'Whole outcome' }));
  f.handler(async url => url.endsWith('capabilities') ? capability : { ...capability, case: many }); await f.review.load(f.api, id, () => true);
  for (let i = 0; i < 8; i++) f.review.toggle('step', 's' + i, true); f.review.acknowledged = true;
  assert.throws(() => f.review.toggle('step', 's8', true), /up to eight/); assert.equal(f.review.steps.length, 8);
  f.review.toggle('step', 's0', false); assert.equal(f.review.acknowledged, false);
});

for (const extra of [{ note_refs: [{ id: 'note', revision }] }, { target_id: 'host' }, { diagnostic_id: 'report' }, { image_provider_key: revision }, { photo: { base64: 'private' } }]) test('context conflict preserves existing selections: ' + Object.keys(extra)[0], () => {
  const context = { case_ref: ref(), ...extra } as ChatContext, before = JSON.stringify(context);
  assert.throws(() => validateCaseContext(context), /on its own/); assert.equal(JSON.stringify(context), before);
});

test('invalid reference cannot carry bodies, duplicate pointers or unresolved status as verified receipt', () => {
  assert.equal(validCaseRef({ ...ref(), include_resolution: 'false' }), false);
  assert.equal(validCaseRef({ ...ref(), step_ids: ['same', 'same'] }), false);
  assert.equal(validCaseRef({ ...ref(), evidence_refs: [{ ...ref().evidence_refs[0], message_index: 4 }] }), false);
  assert.doesNotMatch(JSON.stringify(casePointer({ ...ref(), symptom: 'PRIVATE' } as any)), /PRIVATE/);
  assert.throws(() => validateCaseContext({ case_ref: ref() }, 'Show [vault:secret]'), /on its own/);
  for (const patch of [{ actions_performed: true }, { linked_bodies_included: true }, { omitted_step_count: 30 }, { revision: 'd'.repeat(64) }]) assert.throws(() => confirmCaseReceipt(ref(), { ...receipt(), ...patch }));
  assert.equal(validCaseReceipt(receipt()), true); confirmCaseReceipt(ref(), receipt());
});

test('C1 and saved outcome receipts display historical scope without claiming new observations', () => {
  const source = { handle: 'C1', kind: 'case', id, revision, label: 'Printer paused', provenance: 'user_case', saved_at: stamp, ranges: [] };
  const value = { case_context: receipt(), evidence_context: { version: 1, interpretation: 'backend', sources: [source], citations_checked: true, citations: [{ reference: '[C1]', handle: 'C1' }], invalid_citations: 0 } };
  assert.deepEqual(answerEvidence(value), value); const text = evidenceLines(value).join(' ');
  assert.match(text, /Backend summary of supplied saved records.*No new check or repair ran.*User-recorded troubleshooting.*0 omitted.*resolution excluded.*unavailable when prepared/);
  assert.doesNotMatch(text, /Backend observation summary|Host observation/); assert.equal(evidenceSources(value).length, 1);
  assert.equal(evidenceSources({ evidence_context: { ...value.evidence_context, sources: [{ ...source, revision: undefined }] } }).length, 0);
  assert.match(evidenceLines({ case_context: { ...receipt(), linked_bodies_included: true } }).join(' '), /could not be checked/);
});

test('compiled-preview fixture round-trips the actual read, selection and response validators', async () => {
  const store = new PreviewCases(), review = new CaseReview(), api = { json: async <T>(path: string): Promise<T> => store.request(path, 'GET', {}) as T };
  await review.load(api, PREVIEW_CASE, () => true); review.toggle('step', 'step-one', true); review.acknowledged = true;
  const selection = review.selection(), metadata = store.context({ case_ref: selection.ref });
  confirmCaseReceipt(selection.ref, metadata?.case_context); assert.equal(evidenceSources(metadata!)[0]?.kind, 'case');
  assert.throws(() => store.context({ case_ref: { ...selection.ref, revision: 'f'.repeat(64) } }), /changed/);
});
