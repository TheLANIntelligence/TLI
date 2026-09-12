import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCompanion, useResource, errorText } from '../src/state';
import { Button, Card, ConnectionNotice, Copy, IconButton, Label, Notice, Row, Screen, Section, styles, useTheme } from '../src/ui';
import { formatTime } from '../src/protocol';
import { canAttachNote, confirmNoteDeletion, confirmedSavedNote, filterNotes, NOTE_LIMIT, noteSummary, noteTitle, noteVersionStatus, noteSourceLabel, validateNoteContext } from '../src/notebook';
import { useProtectedDraft } from '../src/private-draft';
import type { Device, Note, NoteSummary } from '../src/types';

type Editor = { original?: Note; title: string; text: string; category: string; device_id: string };
const emptyEditor = (): Editor => ({ title: '', text: '', category: 'general', device_id: '' });
const editNote = (note: Note): Editor => ({ original: note, title: note.title || '', text: note.text, category: note.category, device_id: note.device_id || '' });
const categories = ['general', 'preference', 'device'];

export default function NotebookScreen() {
  const state = useCompanion(), t = useTheme(), router = useRouter();
  const params = useLocalSearchParams<{ note?: string; revision?: string }>();
  const notes = useResource<{ facts: Note[] }>('/api/intelligence/memory');
  const inventory = useResource<{ devices: Device[] }>('/api/intelligence/devices');
  const [query, setQuery] = useState(''), [detailId, setDetailId] = useState(params.note);
  const [editor, setEditor] = useState<Editor>(), [deleting, setDeleting] = useState<Note>();
  const [selected, setSelected] = useState<NoteSummary[]>(state.selectedNotes);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const active = useRef(true), mutation = useRef(false), clientRef = useRef(state.client), previousClient = useRef(state.client);
  clientRef.current = state.client;
  const enabled = !!state.client && state.connection === 'connected' && state.foreground && !busy;
  const facts = notes.data?.facts || [], detail = facts.find(note => note.id === detailId);
  useProtectedDraft(!!editor, busy, !!state.client && state.foreground);
  const input = [styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.card }];
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (previousClient.current !== state.client) { setEditor(undefined); setDeleting(undefined); setSelected([]); setDetailId(undefined); setError(''); setNotice(''); }
    previousClient.current = state.client;
  }, [state.client]);
  const toggle = (note: Note) => {
    const matching = selected.some(item => item.id === note.id && item.revision === note.revision);
    const next = selected.filter(item => item.id !== note.id);
    if (!matching) next.push(noteSummary(note));
    try { validateNoteContext({ note_refs: next }); setSelected(next); setError(''); } catch (error) { setError(errorText(error)); }
  };
  const attach = () => {
    try {
      if (notes.stale || !notes.data) throw new Error('Reconnect and refresh Notes & fixes before attaching notes.');
      if (selected.some(ref => noteVersionStatus(facts.find(note => note.id === ref.id), ref) !== 'current')) throw new Error('A selected note changed or is unavailable. Remove it or select its current version before attaching.');
      state.selectNotes(selected);
      router.back(); router.navigate('/(tabs)/ask');
    } catch (error) { setError(errorText(error)); }
  };
  const mutate = async (remove = false) => {
    if (!enabled || mutation.current || !state.client) return;
    const api = state.client, current = remove ? deleting : editor?.original;
    if (!remove && (!editor?.text.trim() || editor.text.trim().length > 2000 || editor.title.trim().length > 120)) { setError('Write a note of 1–2,000 characters and a title of up to 120 characters.'); return; }
    if (remove && !current) return;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const path = current ? `/api/intelligence/memory/${encodeURIComponent(current.id)}` : '/api/intelligence/memory';
      if (remove) confirmNoteDeletion(await api.json(`${path}?expected_revision=${encodeURIComponent(current!.revision)}`, 'DELETE'), current!.id);
      else {
        const entry = editor!;
        const body = { text: entry.text.trim(), title: entry.title.trim(),
          ...(!entry.original || entry.device_id !== (entry.original.device_id || '') ? { device_id: entry.device_id || null } : {}),
          ...(!entry.original || categories.includes(entry.category) || entry.category !== entry.original.category ? { category: entry.category } : {}),
          ...(entry.original ? { expected_revision: entry.original.revision } : {}) };
        const saved = confirmedSavedNote(await api.json(path, current ? 'PATCH' : 'POST', body), body.text, current?.id);
        if (active.current && clientRef.current === api) setDetailId(saved.id);
      }
      if (!active.current || clientRef.current !== api) return;
      setEditor(undefined); setDeleting(undefined); if (remove) setDetailId(undefined);
      setNotice(remove ? 'Note deleted from your TLI account. Earlier conversation receipts may still name its old version.' : 'Note saved to your TLI account. Relevant notes may be recalled when Use saved notes is on; explicit attachments select reviewed versions.');
      await notes.reload();
    } catch (error) { if (active.current && clientRef.current === api) setError(`${errorText(error)} ${remove ? 'Deletion was not confirmed.' : 'Your draft is still here.'} Refresh to check the saved version before retrying.`); }
    finally { mutation.current = false; if (active.current) setBusy(false); }
  };
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}><Screen><ConnectionNotice /><Section title="Notes & fixes" detail="Your notes, kept with your TLI account." />
    <Copy muted>Save useful details and preferences. These are user-saved notes, not measured device health. Use saved notes in Ask controls ordinary recall. Explicit attachments provide the versions you selected. Your account’s notes are private.</Copy>
    <Row style={{ flexWrap: 'wrap' }}><Button title="Add note" icon="add-outline" disabled={!enabled || !!editor} onPress={() => { setEditor(emptyEditor()); setDetailId(undefined); setDeleting(undefined); setError(''); setNotice(''); }} /><Button secondary title="Refresh notes" busy={notes.busy} disabled={!enabled} onPress={() => void notes.reload()} /></Row>
    {!!(notes.error || error) && <Notice error>{error || notes.error}</Notice>}{!!notice && <Notice>{notice}</Notice>}
    {notes.stale && notes.data && <Notice>Shown notes may be out of date. Reconnect and refresh before editing or attaching them.</Notice>}
    {editor && <Card><Section title={editor.original ? 'Edit note' : 'New note'} detail="Review this text before saving it to your TLI account." />
      <TextInput accessibilityLabel="Note title" placeholder="Title (optional)" placeholderTextColor={t.muted} maxLength={120} value={editor.title} editable={!busy} onChangeText={title => setEditor({ ...editor, title })} style={input} />
      <TextInput accessibilityLabel="Note text" placeholder="What would be useful to remember?" placeholderTextColor={t.muted} multiline maxLength={2000} value={editor.text} editable={!busy} onChangeText={text => setEditor({ ...editor, text })} style={[...input, { minHeight: 160, textAlignVertical: 'top' }]} />
      <Copy muted size={12}>{editor.text.length} / 2,000 characters</Copy><Label>Category</Label>
      {!categories.includes(editor.category) && <Copy muted>Existing category: {editor.category}. It will be kept unless you choose another.</Copy>}
      <Row style={{ flexWrap: 'wrap' }}>{categories.map(category => <Button key={category} secondary={editor.category !== category} title={category[0]!.toUpperCase() + category.slice(1)} disabled={busy} onPress={() => setEditor({ ...editor, category })} />)}</Row>
      <Label>Optional device association</Label><Copy muted size={13}>A label for this note. Attaching it does not run device checks or controls.</Copy>
      <Button secondary={!!editor.device_id} title="No device association" disabled={busy} onPress={() => setEditor({ ...editor, device_id: '' })} />
      {!!editor.device_id && !inventory.data?.devices.some(device => device.id === editor.device_id) && <Copy muted size={13}>Existing device: {editor.device_id} (not in the current inventory)</Copy>}
      {inventory.data?.devices.map(device => <Button key={device.id} title={`${editor.device_id === device.id ? '✓ ' : ''}${device.name}`} secondary={editor.device_id !== device.id} disabled={busy} onPress={() => setEditor({ ...editor, device_id: device.id })} />)}
      {!!inventory.error && <Copy muted size={12}>Device list unavailable. Existing association is preserved.</Copy>}
      <Button title="Save reviewed note" busy={busy} disabled={!enabled || notes.stale || !editor.text.trim()} onPress={() => void mutate()} /><Button secondary title="Cancel editing" disabled={busy} onPress={() => setEditor(undefined)} />
      {editor.original && facts.find(note => note.id === editor.original!.id)?.revision !== editor.original.revision && <Button secondary title="Load current saved version" disabled={busy} onPress={() => { const current = facts.find(note => note.id === editor.original!.id); if (current) { setEditor(editNote(current)); setError(''); } }} />}
    </Card>}
    {!editor && !!detailId && <Card>
      {detail ? <><Label>Saved note</Label><Copy size={24} weight="600">{noteTitle(detail)}</Copy><Copy selectable>{detail.text}</Copy><NoteDetails note={detail} />
        {!!params.revision && params.note === detail.id && params.revision !== detail.revision && <Notice>This note has been edited since that answer. This is its current saved version.</Notice>}
        <Button secondary title="Link note to Troubleshooting" disabled={!enabled || !!editor} onPress={() => router.push({ pathname: '/cases', params: { kind: 'note', evidence: detail.id } })} /><Button secondary title="Edit this note" disabled={!enabled || notes.stale} onPress={() => { setEditor(editNote(detail)); setDeleting(undefined); }} /><Button secondary title="Review deletion" disabled={!enabled || notes.stale} onPress={() => setDeleting(detail)} />
      </> : !notes.busy && notes.data ? <Notice>This note is no longer available in your account. It may have been deleted. The earlier answer’s receipt does not contain its saved text.</Notice> : <Copy muted>Loading the saved note…</Copy>}
      <Button secondary title="Close note" disabled={busy} onPress={() => { setDetailId(undefined); setDeleting(undefined); }} />
    </Card>}
    {deleting && <Card><Section title="Delete this note?" detail="Review the exact note below. Deletion is not automatically retried." /><Copy weight="600">{noteTitle(deleting)}</Copy><Copy selectable>{deleting.text}</Copy><Button title="Delete reviewed note" disabled={!enabled || notes.stale} busy={busy} onPress={() => void mutate(true)} /><Button secondary title="Keep note" disabled={busy} onPress={() => setDeleting(undefined)} /></Card>}
    <TextInput accessibilityLabel="Search notes" placeholder="Search title, text or category…" placeholderTextColor={t.muted} value={query} onChangeText={setQuery} style={input} />
    {filterNotes(facts, query).map(note => <Card key={note.id}><Copy size={20} weight="600">{noteTitle(note)}</Copy><Copy numberOfLines={3} muted>{note.text}</Copy><NoteDetails note={note} />
      <Button secondary title="Open note" accessibilityLabel={`Open note ${noteTitle(note)}`} onPress={() => { setDetailId(note.id); setEditor(undefined); setDeleting(undefined); setError(''); }} disabled={busy || !!editor} />
      <Button title={selected.some(item => item.id === note.id && item.revision === note.revision) ? '✓ Selected · remove' : selected.some(item => item.id === note.id) ? 'Select current version' : 'Select for question'} secondary={!selected.some(item => item.id === note.id && item.revision === note.revision)} disabled={!enabled || notes.stale || state.sending || !canAttachNote(note)} onPress={() => toggle(note)} />
      {!canAttachNote(note) && <Copy muted size={12}>Edit and save this legacy note before attaching it.</Copy>}
    </Card>)}
    {!notes.busy && notes.data && !filterNotes(facts, query).length && <Copy muted>{query ? 'No notes match your search.' : 'No notes yet. Add something you would like to refer to later.'}</Copy>}
    <Card><Label>{selected.length} of {NOTE_LIMIT} selected</Label><Copy muted size={14}>Attach these versions to your current Ask draft. Nothing is sent automatically. Questions with attached notes use the configured AI provider on this TLI; notes are not forwarded to mesh peers.</Copy>
      {selected.map(ref => <Row key={ref.id}><View style={{ flex: 1 }}><Copy size={14}>{ref.title}</Copy>{noteVersionStatus(facts.find(note => note.id === ref.id), ref) !== 'current' && <Copy size={12} style={{ color: t.amber }}>Changed or unavailable · select the current version above</Copy>}</View><IconButton icon="close-outline" label={`Remove selected note ${ref.title}`} disabled={busy} onPress={() => setSelected(selected.filter(item => item.id !== ref.id))} /></Row>)}
      <Button title={selected.length ? `Attach ${selected.length} ${selected.length === 1 ? 'note' : 'notes'} to Ask` : 'Return to Ask without notes'} disabled={!enabled || notes.stale || state.sending || state.loadingConversation || !!editor} onPress={attach} />
    </Card>
  </Screen></KeyboardAvoidingView>;
}

function NoteDetails({ note }: { note: Note }) { return <View style={{ gap: 3 }}><Copy muted size={12}>{noteSourceLabel(note.source)} · {note.category}</Copy><Copy muted size={12}>Created {note.created_at ? formatTime(note.created_at) : 'time unavailable'} · Updated {note.updated_at ? formatTime(note.updated_at) : 'time unavailable'}</Copy>{!!note.device_id && <Copy muted size={12}>Associated device: {note.device_id}</Copy>}</View>; }
