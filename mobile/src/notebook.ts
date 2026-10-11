import type { ChatContext, Note, NoteContext, NoteRef, NoteSummary } from './types';

export const NOTE_LIMIT = 4;
export const noteTitle = (note: Pick<Note, 'title'>) => note.title?.trim() || 'Untitled note';
export function noteSourceLabel(source?: string) { return source === 'chat_ai' ? 'Saved AI suggestion' : source === 'chat_user' ? 'Saved user statement' : source === 'user' ? 'User-saved' : source === 'user_confirmation' ? 'User-confirmed fix' : source === 'legacy_device' ? 'Earlier device memory' : !source || source === 'user_memory' ? 'Saved memory (source not recorded)' : 'Source unknown'; }
export function noteSummary(note: Note): NoteSummary {
  return { id: note.id, revision: note.revision, title: noteTitle(note), source: note.source, category: note.category, updated_at: note.updated_at, device_id: note.device_id };
}
export function canAttachNote(note: NoteRef): boolean { return !note.id.startsWith('device-') && /^[a-f0-9]{64}$/.test(note.revision); }
export function validateNoteContext(context: ChatContext): void {
  const refs = context.note_refs;
  if (!refs?.length) return;
  if (refs.length > NOTE_LIMIT) throw new Error('Attach at most four notes to one question.');
  if (new Set(refs.map(note => note.id)).size !== refs.length || refs.some(note => !canAttachNote(note))) throw new Error('Review these notes in Notes & fixes and attach their current versions again. Legacy notes must be saved as owned notes first.');
  if (context.photo || context.screenshot || context.target_id || context.diagnostic_id || context.image_provider_key) throw new Error('Notes need their own question. Remove the photo, device and report context, or remove the attached notes before sending.');
}
export function selectNoteSummaries(notes: Note[]): NoteSummary[] {
  const summaries = notes.map(noteSummary);
  validateNoteContext({ note_refs: summaries });
  return summaries;
}
export function noteReceiptText(receipt?: NoteContext): string | undefined {
  if (!receipt || receipt.actions_performed !== false || !Array.isArray(receipt.notes) || !receipt.notes.length || receipt.notes.length > 4 || receipt.notes.some(note => !note || typeof note.id !== 'string' || !canAttachNote(note) || typeof note.title !== 'string' || note.title.length > 120)) return;
  return `Notes provided to AI · ${receipt.notes.map(note => note.title || 'Untitled note').join(', ')} · Saved information, not measured health. No actions performed.`;
}
export function noteVersionStatus(note: Note | undefined, reviewed: NoteRef): 'current' | 'edited' | 'unavailable' { return !note ? 'unavailable' : note.revision === reviewed.revision ? 'current' : 'edited'; }
export function filterNotes(notes: Note[], query: string): Note[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter(note => words.every(word => `${noteTitle(note)} ${note.text} ${note.category} ${note.device_id || ''}`.toLocaleLowerCase().includes(word)));
}
export function confirmedSavedNote(value: unknown, text: string, expectedId?: string): Note {
  const note = value as Note | undefined;
  if (!note || typeof note.id !== 'string' || !canAttachNote(note) || note.text !== text || expectedId && !expectedId.startsWith('device-') && note.id !== expectedId) throw new Error('TLI did not confirm the saved note.');
  return note;
}
export function confirmNoteDeletion(value: unknown, id: string): void {
  const result = value as { id?: string; deleted?: boolean } | undefined;
  if (!result || result.id !== id || result.deleted !== true) throw new Error('TLI did not confirm that this note was deleted.');
}
