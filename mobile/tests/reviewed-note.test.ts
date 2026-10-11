import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmReviewedNote, newCopyProposal, reviewedNoteBody, ReviewGate, selectUpdateTarget, updateTarget, validateNotePreview } from '../src/reviewed-note';
import type { Note, SourceRef } from '../src/types';
const revision = 'a'.repeat(64), source: SourceRef = { conversation_id: 'saved', message_index: 1, revision };
const original: Note = { id: 'f-owned', title: 'Printer', text: 'Before', category: 'device', source: 'user_confirmation', device_id: 'retired-computer', revision };
const proposal = { title: 'Printer fix', text: 'Check paper tray', category: 'general', device_id: null };
test('preview must match exact saved message and source role', () => {
  const value = { source: { ...source, role: 'assistant' }, source_kind: 'ai_suggestion', text: 'Original answer', suggested_text: 'Check paper tray', suggested_title: 'Printer', requires_excerpt: false };
  assert.equal(validateNotePreview(value, source).text, 'Original answer');
  for (const next of [{ ...value, source: { ...value.source, message_index: 0 } }, { ...value, source_kind: 'user_statement' }, { ...value, text: '' }]) assert.throws(() => validateNotePreview(next, source));
});
test('reviewed update carries exact current revision, existing association and deliberate new source', () => {
  const selected = selectUpdateTarget(proposal, original), body = reviewedNoteBody(source, selected, true, original);
  assert.equal(body.note_id, original.id); assert.equal(body.expected_revision, revision); assert.equal(body.device_id, 'retired-computer'); assert.equal(body.reviewed, true);
  assert.throws(() => reviewedNoteBody(source, selected, false, original));
  assert.deepEqual(body.source_ref, source);
});
test('legacy category and retired computer preserved only for update; switching to new removes both', () => {
  const target = { ...original, category: 'old-profile' };
  const selected = selectUpdateTarget(proposal, target); assert.equal(reviewedNoteBody(source, selected, true, target).category, 'old-profile');
  const newCopy = newCopyProposal(selected); assert.equal(newCopy.category, 'general'); assert.equal(newCopy.device_id, null); assert.equal(newCopy.text, proposal.text); assert.equal(newCopy.title, proposal.title);
  assert.throws(() => reviewedNoteBody(source, selected, true));
  assert.equal(selectUpdateTarget(proposal, { ...original, category: 'verified_fix' }).category, 'general');
});
test('unsupported targets are excluded and old untitled notes are normalized', () => {
  assert.equal(updateTarget({ ...original, title: undefined as never })?.title, '');
  assert.equal(updateTarget({ ...original, id: 'device-legacy' }), undefined);
  assert.equal(updateTarget({ ...original, revision: '' }), undefined);
});
test('success requires truthful update confirmation and matching saved content', () => {
  const body = reviewedNoteBody(source, proposal, true, original), saved = { ...original, ...proposal, source: 'chat_ai', revision: 'b'.repeat(64) };
  assert.equal(confirmReviewedNote({ ok: true, updated_existing: true, already_saved: false, note: saved }, body).id, original.id);
  for (const value of [{ ok: true, note: saved }, { ok: true, updated_existing: true, already_saved: false, note: { ...saved, text: 'Different' } }, { ok: true, updated_existing: true, already_saved: true, note: saved }]) assert.throws(() => confirmReviewedNote(value, body));
});
test('duplicate review guard stays reserved until settle and rejects late private responses', () => {
  const gate = new ReviewGate(), ticket = gate.begin(); assert.throws(() => gate.begin()); assert.equal(gate.current(ticket), true);
  gate.invalidate(); assert.equal(gate.current(ticket), false); assert.equal(gate.busy, true); assert.throws(() => gate.begin());
  gate.finish(ticket); const next = gate.begin(); gate.finish(ticket); assert.equal(gate.current(next), true); gate.finish(next); assert.equal(gate.busy, false);
});
