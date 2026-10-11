import type { Note, SourceRef } from './types';
import { validSourceRef } from './answer-evidence';
import { canAttachNote, confirmedSavedNote } from './notebook';

export type NotePreview = { source: SourceRef & { role: 'user' | 'assistant' }; source_kind: 'ai_suggestion' | 'user_statement'; text: string; suggested_text: string; suggested_title: string; requires_excerpt: boolean };
export type NoteProposal = { title: string; text: string; category: string; device_id: string | null };
export function validateNotePreview(value: unknown, ref: SourceRef): NotePreview {
  const p = value as NotePreview;
  if (!p || !validSourceRef(p.source) || p.source.conversation_id !== ref.conversation_id || p.source.message_index !== ref.message_index || p.source.revision !== ref.revision || !['user', 'assistant'].includes(p.source.role) || p.source_kind !== (p.source.role === 'assistant' ? 'ai_suggestion' : 'user_statement') || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 32000 || typeof p.suggested_text !== 'string' || p.suggested_text.length > 2000 || typeof p.suggested_title !== 'string' || p.suggested_title.length > 120) throw new Error('The host did not confirm this saved message. Reopen the conversation and review again.');
  return p;
}
export function updateTarget(value: Note): Note | undefined {
  if (!value || typeof value.id !== 'string' || !canAttachNote(value) || typeof value.text !== 'string' || value.text.length > 2000 || typeof value.category !== 'string' || value.category.length > 64 || value.device_id != null && typeof value.device_id !== 'string') return;
  return { ...value, title: value.title || '' };
}
export function selectUpdateTarget(proposal: NoteProposal, target: Note): NoteProposal { return { ...proposal, category: target.category === 'verified_fix' ? 'general' : target.category, device_id: target.device_id || null }; }
export function newCopyProposal(proposal: NoteProposal): NoteProposal { return { ...proposal, category: ['general', 'preference', 'device'].includes(proposal.category) ? proposal.category : 'general', device_id: null }; }
export function reviewedNoteBody(ref: SourceRef, proposal: NoteProposal, acknowledged: boolean, target?: Note) {
  if (!validSourceRef(ref) || !acknowledged || !proposal.text.trim() || proposal.text.trim().length > 2000 || proposal.title.trim().length > 120) throw new Error('Review the source and the note text before saving.');
  if (target && !updateTarget(target)) throw new Error('Refresh and review the current note before updating it.');
  if (!['general', 'preference', 'device'].includes(proposal.category) && (!target || proposal.category !== target.category || proposal.category === 'verified_fix')) throw new Error('Choose a supported category for this note.');
  return { source_ref: { ...ref }, ...proposal, title: proposal.title.trim(), text: proposal.text.trim(), reviewed: true, ...(target ? { note_id: target.id, expected_revision: target.revision } : {}) };
}
export function confirmReviewedNote(value: unknown, body: ReturnType<typeof reviewedNoteBody>): Note {
  const result = value as { ok?: boolean; note?: Note; updated_existing?: boolean; already_saved?: boolean };
  if (result?.ok !== true || body.note_id && (result.updated_existing !== true || result.already_saved !== false)) throw new Error('Saving was not confirmed. Check Notes & fixes before reviewing another save.');
  const note = confirmedSavedNote(result.note, body.text, body.note_id);
  if (note.title !== body.title || note.category !== body.category || (note.device_id || null) !== body.device_id) throw new Error('The host returned a different saved note. Review Notes & fixes before continuing.');
  return note;
}
/** A stale response cannot publish into another private review. */
export class ReviewGate {
  private epoch = 0; private active?: object;
  get busy() { return !!this.active; }
  begin() { if (this.active) throw new Error('Wait for the current request to finish.'); const ticket = { epoch: this.epoch }; this.active = ticket; return ticket; }
  current(ticket: { epoch: number }) { return this.active === ticket && ticket.epoch === this.epoch; }
  invalidate() { this.epoch++; }
  finish(ticket: object) { if (this.active === ticket) this.active = undefined; }
}
