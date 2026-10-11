// Synthetic, in-memory Notebook data for the browser-only product preview.
// Nothing here reads an account, writes storage, or opens a network connection.
import { noteSummary, validateNoteContext } from './notebook';
import type { Note, NoteContext, NoteRef } from './types';

export class PreviewNotebookError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export class PreviewNotebook {
  private version = 2;
  private facts: Note[] = [
    { id: 'f-sample-printer', revision: '1'.padStart(64, '0'), title: 'Studio printer paper', text: 'The sample Studio printer uses A4 paper in tray one. Check the tray label before buying paper.', category: 'device', device_id: 'sample-printer', source: 'user', created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-01T12:00:00Z' },
    { id: 'f-sample-work', revision: '2'.padStart(64, '0'), title: 'Quiet work sessions', text: 'I prefer a short explanation and one clear next step while working.', category: 'preference', source: 'user', created_at: '2026-09-02T12:00:00Z', updated_at: '2026-09-02T12:00:00Z' },
  ];
  private revision() { return (++this.version).toString(16).padStart(64, '0'); }
  saveChat(body: Record<string, unknown>, source: 'chat_ai' | 'chat_user') {
    const id = typeof body.note_id === 'string' ? body.note_id : undefined;
    if (body.reviewed !== true) throw new PreviewNotebookError('Review this saved note first.', 422);
    const value = this.request(id ? `/api/intelligence/memory/${encodeURIComponent(id)}` : '/api/intelligence/memory', id ? 'PATCH' : 'POST', body) as Note;
    const saved = { ...value, source }; this.facts = this.facts.map(note => note.id === value.id ? saved : note);
    return { ok: true, already_saved: false, ...(id ? { updated_existing: true } : {}), note: saved };
  }
  request(path: string, method: string, body: Record<string, unknown>): unknown | undefined {
    if (path === '/api/intelligence/memory' && method === 'GET') return { facts: this.facts.map(note => ({ ...note })) };
    const match = /^\/api\/intelligence\/memory\/([^/?]+)(?:\?(.*))?$/.exec(path);
    if (path !== '/api/intelligence/memory' && !match) return;
    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') throw new PreviewNotebookError('Unsupported sample Notebook request.', 405);
    const original = match ? this.facts.find(note => note.id === decodeURIComponent(match[1]!)) : undefined;
    if (match && !original) throw new PreviewNotebookError('This note is no longer available in your account.', 404);
    const expected = method === 'DELETE' ? new URLSearchParams(match?.[2]).get('expected_revision') : body.expected_revision;
    if (original && expected !== original.revision) throw new PreviewNotebookError('This note changed. Refresh and review its current version before trying again.', 409);
    if (method === 'DELETE') { this.facts = this.facts.filter(note => note !== original); return { id: original!.id, deleted: true }; }
    if (/simulate save failure/i.test(String(body.title))) throw new PreviewNotebookError('Sample note save failed. No note was changed.', 503);
    const text = String(body.text ?? '').trim(), title = String(body.title ?? '').trim();
    const category = String(body.category ?? original?.category ?? 'general');
    if (!text || text.length > 2000 || title.length > 120 || body.category && !['general', 'preference', 'device'].includes(category)) throw new PreviewNotebookError('Review the note text, title and category.', 422);
    const revision = this.revision(), timestamp = new Date().toISOString();
    const note: Note = { id: original?.id || `f-sample-${this.version}`, revision, title, text, category, source: 'user', device_id: body.device_id === undefined ? original?.device_id ?? null : typeof body.device_id === 'string' ? body.device_id : null, created_at: original?.created_at || timestamp, updated_at: timestamp };
    if (original) this.facts = this.facts.map(item => item === original ? note : item); else this.facts.unshift(note);
    return { ...note };
  }
  resolve(body: Record<string, unknown>): NoteContext | undefined {
    const refs = body.note_refs as NoteRef[] | undefined;
    if (!refs?.length) return;
    try { validateNoteContext({ note_refs: refs, photo: body.image_b64 ? {} as never : undefined, screenshot: body.screenshot as never, target_id: body.target_id as string, diagnostic_id: body.diagnostic_id as string, image_provider_key: body.image_provider_key as string }); }
    catch (error) { throw new PreviewNotebookError(error instanceof Error ? error.message : 'Review selected notes.', 422); }
    const selected = refs.map(ref => {
      const note = this.facts.find(note => note.id === ref.id);
      if (!note) throw new PreviewNotebookError('A selected note is no longer available. Open Notebook to review your selection.', 404);
      if (note.revision !== ref.revision) throw new PreviewNotebookError('A selected note changed. Open Notebook and select its current version.', 409);
      return noteSummary(note);
    });
    return { notes: selected, actions_performed: false };
  }
}
