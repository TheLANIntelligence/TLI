import { useEffect, useRef, useState } from 'react';
import { Modal, Switch, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCompanion, errorText } from './state';
import { Button, Card, Copy, Label, Notice, Row, Screen, Section, styles, useTheme } from './ui';
import { confirmReviewedNote, newCopyProposal, reviewedNoteBody, ReviewGate, selectUpdateTarget, updateTarget, validateNotePreview, type NotePreview, type NoteProposal } from './reviewed-note';
import { confirmDiscard } from './private-draft';
import type { Device, Note, SourceRef } from './types';

export function SaveNoteReview({ source, close }: { source?: SourceRef; close: () => void }) {
  const state = useCompanion(), t = useTheme();
  const [preview, setPreview] = useState<NotePreview>(), [proposal, setProposal] = useState<NoteProposal>(), [notes, setNotes] = useState<Note[]>([]), [devices, setDevices] = useState<Device[]>([]);
  const [mode, setMode] = useState<'new' | 'update'>('new'), [target, setTarget] = useState<Note>(), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<Note>();
  const gate = useRef(new ReviewGate()), currentClient = useRef(state.client), foreground = useRef(state.foreground);
  currentClient.current = state.client; foreground.current = state.foreground;
  const clear = () => { gate.current.invalidate(); gate.current = new ReviewGate(); setBusy(false); setPreview(undefined); setProposal(undefined); setNotes([]); setDevices([]); setTarget(undefined); setAck(false); setError(''); setSaved(undefined); setMode('new'); };
  useEffect(() => { if (!state.foreground || !state.client) { clear(); close(); } }, [state.foreground, state.client]);
  useEffect(() => {
    clear(); if (!source || !state.client || !state.foreground) return;
    const api = state.client, ticket = gate.current.begin(); setBusy(true);
    void api.json('/api/intelligence/memory/from-chat/preview', 'POST', { source_ref: source }).then(value => {
      if (!gate.current.current(ticket) || currentClient.current !== api || !foreground.current) return;
      const p = validateNotePreview(value, source); setPreview(p); setProposal({ title: p.suggested_title, text: p.suggested_text, category: 'general', device_id: null });
    }).catch(e => { if (gate.current.current(ticket) && currentClient.current === api) setError(errorText(e)); }).finally(() => { const current = gate.current.current(ticket); gate.current.finish(ticket); if (current) setBusy(false); });
    return () => gate.current.invalidate();
  }, [source, state.client, state.foreground]);
  const loadTargets = async () => {
    if (!state.client || gate.current.busy) return;
    const api = state.client, ticket = gate.current.begin(); setBusy(true); setError('');
    try {
      const result = await api.json<{ facts: Note[] }>('/api/intelligence/memory');
      if (!gate.current.current(ticket) || currentClient.current !== api || !foreground.current) return;
      if (!Array.isArray(result?.facts)) throw new Error('The note list was unavailable. Your proposed text is unchanged.');
      setNotes(result.facts.map(updateTarget).filter((n): n is Note => !!n).slice(0, 200)); setTarget(undefined); setAck(false);
      // Device association remains optional; failed inventory cannot overwrite it.
      try { const inventory = await api.json<{ devices: Device[] }>('/api/intelligence/devices'); if (gate.current.current(ticket) && currentClient.current === api && foreground.current && Array.isArray(inventory?.devices)) setDevices(inventory.devices.slice(0, 100)); } catch {}
    } catch (e) { if (gate.current.current(ticket)) setError(errorText(e)); }
    finally { const current = gate.current.current(ticket); gate.current.finish(ticket); if (current) setBusy(false); }
  };
  const loadDevices = async () => {
    if (!state.client || gate.current.busy || !state.foreground) return;
    const api = state.client, ticket = gate.current.begin(); setBusy(true); setError('');
    try { const result = await api.json<{ devices: Device[] }>('/api/intelligence/devices'); if (gate.current.current(ticket) && currentClient.current === api && foreground.current) { if (!Array.isArray(result?.devices)) throw new Error('Computer choices unavailable. Existing association is unchanged.'); setDevices(result.devices.slice(0, 100)); } }
    catch (e) { if (gate.current.current(ticket)) setError(errorText(e)); }
    finally { const current = gate.current.current(ticket); gate.current.finish(ticket); if (current) setBusy(false); }
  };
  const save = async () => {
    if (!source || !proposal || !state.client || gate.current.busy || !state.foreground || state.connection !== 'connected' || mode === 'update' && !target) return;
    const api = state.client, ticket = gate.current.begin(); setBusy(true); setError('');
    try {
      const body = reviewedNoteBody(source, proposal, ack, mode === 'update' ? target : undefined);
      const value = await api.json('/api/intelligence/memory/from-chat/save', 'POST', body);
      if (!gate.current.current(ticket) || currentClient.current !== api || !foreground.current) return;
      setSaved(confirmReviewedNote(value, body)); setAck(false);
    } catch (e) {
      if (gate.current.current(ticket) && currentClient.current === api) { setError(`${errorText(e)} Saving was not confirmed. Your draft is retained. Check Notes & fixes before a fresh review; nothing is retried automatically.`); setAck(false); if (mode === 'update') setTarget(undefined); }
    } finally { const current = gate.current.current(ticket); gate.current.finish(ticket); if (current) setBusy(false); }
  };
  const requestClose = () => { if (busy) return; if (proposal && !saved) confirmDiscard(close); else close(); };
  const input = [styles.input, { borderColor: t.border, color: t.text, backgroundColor: t.background }];
  return <Modal visible={!!source} animationType="slide" onRequestClose={requestClose}><SafeAreaView style={{ flex: 1, backgroundColor: t.background }}><Screen><Section title="Save to Notes & fixes" detail="Review a saved answer before creating a note or replacing an existing one." />
    {busy && <Notice>Checking your reviewed request…</Notice>}{!!error && <Notice error>{error}</Notice>}
    {saved ? <Card><Copy weight="600">{mode === 'update' ? 'Existing note updated' : 'Note saved'}</Copy><Copy>{saved.title || 'Untitled note'}</Copy><Copy muted>No device action or confirmed fix was recorded.</Copy><Button title="Done" onPress={close} /></Card> : preview && proposal ? <>
      <Card><Label>Original saved message</Label><Copy selectable>{preview.text}</Copy><Copy muted size={13}>{preview.source_kind === 'ai_suggestion' ? 'Saved AI suggestion. Review it for accuracy; it is not a confirmed fix.' : 'Your saved statement.'} Updating an existing note replaces its source and removes any prior confirmed-fix status.</Copy></Card>
      <Row style={{ flexWrap: 'wrap' }}><Button secondary={mode !== 'new'} title="Create new note" disabled={busy} onPress={() => { setMode('new'); setTarget(undefined); setProposal(newCopyProposal(proposal)); setAck(false); }} /><Button secondary={mode !== 'update'} title="Update existing note" disabled={busy} onPress={() => { setMode('update'); setTarget(undefined); setAck(false); void loadTargets(); }} /></Row>
      {mode === 'update' && <Card><Label>Choose the note to replace</Label><Button secondary title="Refresh current notes" disabled={busy} onPress={() => void loadTargets()} />{notes.map(note => <Button key={note.id} secondary={target?.id !== note.id} title={`${note.title || 'Untitled note'} · ${note.id}`} disabled={busy} onPress={() => { setTarget(note); setProposal(selectUpdateTarget(proposal, note)); setAck(false); }} />)}{!busy && !notes.length && <Copy muted>No supported owned notes available for updating.</Copy>}</Card>}
      {!!target && <Card><Label>Before · current saved version</Label><Copy weight="600">{target.title || 'Untitled note'}</Copy><Copy selectable>{target.text}</Copy><Copy muted>{target.category} · {target.device_id || 'No computer association'} · source {target.source}</Copy><Copy muted size={12}>Revision {target.revision}. Original creation time and note ID are retained.</Copy></Card>}
      <Card><Label>{mode === 'update' ? 'After · proposed replacement' : 'Your proposed note'}</Label><TextInput accessibilityLabel="Reviewed note title" value={proposal.title} maxLength={120} editable={!busy} onChangeText={title => { setProposal({ ...proposal, title }); setAck(false); }} style={input} /><TextInput accessibilityLabel="Reviewed note text" multiline value={proposal.text} maxLength={2000} editable={!busy} onChangeText={text => { setProposal({ ...proposal, text }); setAck(false); }} style={[...input, { minHeight: 140 }]} /><Copy muted size={12}>{proposal.text.length} / 2,000 characters</Copy><Copy muted>Category: {proposal.category}</Copy><Row style={{ flexWrap: 'wrap' }}>{['general', 'preference', 'device'].map(category => <Button key={category} title={category} secondary={proposal.category !== category} disabled={busy} onPress={() => { setProposal({ ...proposal, category }); setAck(false); }} />)}</Row><Copy muted>Computer association: {proposal.device_id || 'None'}</Copy><Button secondary title="Load computer associations" disabled={busy} onPress={() => void loadDevices()} /><Button secondary title="No computer association" disabled={busy} onPress={() => { setProposal({ ...proposal, device_id: null }); setAck(false); }} />{devices.map(device => <Button key={device.id} secondary title={`${device.name} · ${device.id}`} disabled={busy} onPress={() => { setProposal({ ...proposal, device_id: device.id }); setAck(false); }} />)}
      <Row><Switch accessibilityLabel="I reviewed the source and proposed note" value={ack} disabled={busy} onValueChange={setAck} /><Copy style={{ flex: 1 }}>I reviewed the source and proposed note{mode === 'update' ? ', including the exact note being replaced' : ''}.</Copy></Row><Button title={mode === 'update' ? 'Save reviewed replacement' : 'Save reviewed new note'} busy={busy} disabled={!ack || !proposal.text.trim() || mode === 'update' && !target || state.connection !== 'connected'} onPress={() => void save()} /></Card>
    </> : null}<Button secondary title={saved ? 'Close' : 'Close review'} disabled={busy} onPress={requestClose} /><Copy muted size={12}>This private draft is cleared when the app backgrounds, the pairing changes or you close it. Closing does not undo a save already sent.</Copy></Screen></SafeAreaView></Modal>;
}
