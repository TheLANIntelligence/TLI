import assert from 'node:assert/strict';
import test from 'node:test';
import { canAttachNote, confirmNoteDeletion, confirmedSavedNote, filterNotes, noteReceiptText, noteSourceLabel, noteSummary, noteVersionStatus, selectNoteSummaries, validateNoteContext } from '../src/notebook';
import { PreviewNotebook, PreviewNotebookError } from '../src/notebook-preview';
import type { ChatContext, Note, NoteContext } from '../src/types';

const note: Note = { id: 'f-owned', revision: 'a'.repeat(64), title: 'Printer paper', text: 'Only A4 paper fits this tray.', source: 'user', category: 'device', device_id: 'printer', updated_at: '2026-09-01T12:00:00Z' };
test('reviewed selection stores metadata without note bodies and requires explicit owned revisions', () => {
  const selected = selectNoteSummaries([note]);
  assert.equal(selected[0]!.title, 'Printer paper');
  assert.equal('text' in selected[0]!, false);
  assert.equal(noteSummary({ ...note, title: '' }).title, 'Untitled note');
  assert.equal(canAttachNote({ ...note, id: 'device-old' }), false);
  assert.throws(() => selectNoteSummaries([{ ...note, id: 'device-old' }]), /Legacy notes/);
  for (const revision of ['', 'x'.repeat(64), 'A'.repeat(64)]) assert.throws(() => selectNoteSummaries([{ ...note, revision }]), /Review these notes/);
  assert.throws(() => selectNoteSummaries([note, note]), /Review these notes/);
  assert.equal(selectNoteSummaries(Array.from({ length: 4 }, (_, id) => ({ ...note, id: `f-${id}` }))).length, 4);
  assert.throws(() => selectNoteSummaries(Array.from({ length: 5 }, (_, id) => ({ ...note, id: `f-${id}` }))), /at most four/);
});

test('notes refuse photos, screenshots and implicit diagnostic/device context', () => {
  const incompatible: ChatContext[] = [{ target_id: 'printer' }, { diagnostic_id: 'report' }, { image_provider_key: 'b'.repeat(64) }, { screenshot: { task: 'explain', provider_key: 'b'.repeat(64) } }, { photo: { uri: 'fixture', base64: 'fixture', mime: 'image/jpeg', width: 1, height: 1 } }];
  for (const context of incompatible) assert.throws(() => validateNoteContext({ ...context, note_refs: [note] }), /Remove the photo, device and report/);
  for (const context of incompatible) assert.doesNotThrow(() => validateNoteContext(context));
});

test('receipt status distinguishes exact revision, edited and unavailable without copying old content', () => {
  assert.equal(noteVersionStatus(note, note), 'current');
  assert.equal(noteVersionStatus({ ...note, revision: 'b'.repeat(64) }, note), 'edited');
  assert.equal(noteVersionStatus(undefined, note), 'unavailable');
  const receipt: NoteContext = { notes: [noteSummary(note)], actions_performed: false };
  assert.match(noteReceiptText(receipt)!, /Notes provided to AI/);
  assert.match(noteReceiptText(receipt)!, /No actions performed/);
  assert.equal(noteReceiptText(receipt)!.includes(note.text), false);
  assert.equal(noteReceiptText({ notes: [], actions_performed: false }), undefined);
  assert.equal(noteSourceLabel('user'), 'User-saved');
  assert.equal(noteSourceLabel('user_confirmation'), 'User-confirmed fix');
  assert.equal(noteSourceLabel('user_memory'), 'Saved memory (source not recorded)');
  assert.equal(noteSourceLabel('new-unknown'), 'Source unknown');
});

test('Notebook search combines title, text and category terms without changing source order', () => {
  const notes = [note, { ...note, id: 'f-second', title: 'Work preference', text: 'Keep answers brief.', category: 'preference' }];
  assert.deepEqual(filterNotes(notes, ' PAPER a4 ').map(note => note.id), ['f-owned']);
  assert.deepEqual(filterNotes(notes, 'preference brief').map(note => note.id), ['f-second']);
  assert.deepEqual(filterNotes(notes, 'missing'), []);
  assert.deepEqual(filterNotes(notes, ''), notes);
});

test('synthetic preview installs no storage and enforces stale edit/delete/selection reviews', () => {
  const preview = new PreviewNotebook();
  const saved = preview.request('/api/intelligence/memory', 'POST', { title: 'A useful note', text: 'Fixture content', category: 'general' }) as Note;
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  const context = preview.resolve({ note_refs: [{ id: saved.id, revision: saved.revision }] })!;
  assert.equal('text' in context.notes[0]!, false);
  const changed = preview.request(`/api/intelligence/memory/${saved.id}`, 'PATCH', { title: 'Updated', text: 'New content', category: 'general', expected_revision: saved.revision }) as Note;
  assert.notEqual(changed.revision, saved.revision);
  assert.equal(context.notes[0]!.title, 'A useful note');
  for (const operation of [
    () => preview.request(`/api/intelligence/memory/${saved.id}`, 'PATCH', { text: 'Overwrite?', expected_revision: saved.revision }),
    () => preview.request(`/api/intelligence/memory/${saved.id}?expected_revision=${saved.revision}`, 'DELETE', {}),
    () => preview.resolve({ note_refs: [saved] }),
  ]) assert.throws(operation, error => error instanceof PreviewNotebookError && error.status === 409);
  const listed = preview.request('/api/intelligence/memory', 'GET', {}) as { facts: Note[] };
  assert.equal(listed.facts.find(note => note.id === saved.id)!.text, 'New content');
  preview.request(`/api/intelligence/memory/${saved.id}?expected_revision=${changed.revision}`, 'DELETE', {});
  assert.throws(() => preview.resolve({ note_refs: [changed] }), error => error instanceof PreviewNotebookError && error.status === 404);
});

test('preview save failures leave existing notes and reviewed revision unchanged', () => {
  const preview = new PreviewNotebook();
  const initial = preview.request('/api/intelligence/memory', 'GET', {}) as { facts: Note[] };
  const selected = initial.facts[0]!;
  assert.throws(() => preview.request(`/api/intelligence/memory/${selected.id}`, 'PATCH', { title: 'simulate save failure', text: 'Do not lose draft', expected_revision: selected.revision }), /Sample note save failed/);
  assert.deepEqual(preview.request('/api/intelligence/memory', 'GET', {}), initial);
  for (const extra of [{ target_id: 'sample-printer' }, { image_b64: 'fixture' }]) assert.throws(() => preview.resolve({ note_refs: [selected], ...extra }), /Notes need their own question/);
});

test('empty or mismatched mutation results cannot claim success and discard the editor', () => {
  for (const response of [undefined, {}, { ...note, revision: '' }, { ...note, text: 'Different content' }, { ...note, id: 'f-wrong' }]) assert.throws(() => confirmedSavedNote(response, note.text, note.id), /did not confirm/);
  assert.deepEqual(confirmedSavedNote(note, note.text, note.id), note);
  for (const response of [undefined, {}, { id: note.id, deleted: false }, { id: 'f-wrong', deleted: true }]) assert.throws(() => confirmNoteDeletion(response, note.id), /did not confirm/);
  assert.doesNotThrow(() => confirmNoteDeletion({ id: note.id, deleted: true }, note.id));
});
