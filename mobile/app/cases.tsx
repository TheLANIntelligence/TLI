import { useEffect, useRef, useState } from 'react';
import { Switch, TextInput, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCompanion, errorText } from '../src/state';
import { Button, Card, ConnectionNotice, Copy, Label, Notice, Row, Screen, Section, styles, useTheme } from '../src/ui';
import { CASE_PROTOCOL, evidenceAvailability, validCaseSummary, caseBody, draftCase, emptyCase, validateCase, validateEvidence, type CaseDraft, type CaseLink, type CaseSummary, type TroubleshootingCase } from '../src/cases';
import { ReviewGate } from '../src/reviewed-note';
import { confirmDiscard, useProtectedDraft } from '../src/private-draft';
import { formatTime } from '../src/protocol';
import type { Device, Note, Report } from '../src/types';
import { GuidedChecks } from '../src/guided-checks-view';
import { CaseContextReview } from '../src/case-context-review';

export default function CasesScreen() {
  const state = useCompanion(), router = useRouter(), t = useTheme();
  const params = useLocalSearchParams<{ id?: string; computer?: string; kind?: string; evidence?: string; message_index?: string }>();
  const [askCase, setAskCase] = useState<string>();
  const [items, setItems] = useState<CaseSummary[]>([]), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('open'), [original, setOriginal] = useState<TroubleshootingCase>(), [draft, setDraft] = useState<CaseDraft>(), [ack, setAck] = useState(false), [conflict, setConflict] = useState<TroubleshootingCase>();
  const [computers, setComputers] = useState<Device[]>([]), [sources, setSources] = useState<Array<{ kind: 'note' | 'report'; id: string; title: string }>>([]);
  const [reviewedLink, setReviewedLink] = useState<CaseLink>();
  const gate = useRef(new ReviewGate()), apiRef = useRef(state.client), foreground = useRef(state.foreground), request = useRef('');
  const pendingCheckReport = useRef<string | undefined>(undefined);
  apiRef.current = state.client; foreground.current = state.foreground;
  const dirty = !!draft && (!original || JSON.stringify(draft) !== JSON.stringify(draftCase(original)));
  useProtectedDraft(dirty, busy, !!state.client && state.foreground);
  const enabled = !!state.client && state.foreground && state.connection === 'connected' && !busy;
  const input = [styles.input, { borderColor: t.border, color: t.text, backgroundColor: t.card }];
  const run = async (work: (api: NonNullable<typeof state.client>, current: () => boolean) => Promise<void>, saving = false) => {
    if (!state.client || !state.foreground || gate.current.busy || state.connection !== 'connected') return;
    const api = state.client, owned = gate.current, ticket = owned.begin(); setBusy(true); setError('');
    const current = () => owned === gate.current && owned.current(ticket) && apiRef.current === api && foreground.current;
    try { await work(api, current); } catch (e) { if (current()) { setError(`${saving && pendingCheckReport.current && draft?.evidence.some(link => link.kind === 'report' && link.id === pendingCheckReport.current) ? 'Report saved; problem link not saved. ' : ''}${errorText(e)} No request is retried automatically.`); setAck(false); } }
    finally { const valid = current(); owned.finish(ticket); if (valid) setBusy(false); }
  };
  const refresh = () => run(async (api, current) => {
    const capability = await api.json<{ ok?: boolean; protocol?: string }>('/api/intelligence/cases/capabilities');
    if (!current()) return;
    if (capability?.ok !== true || capability.protocol !== CASE_PROTOCOL) throw new Error('This host does not support the shared Troubleshooting workspace. Update the host first.');
    const result = await api.json<{ ok: boolean; protocol: string; items: CaseSummary[] }>(`/api/intelligence/cases?status=${filter}&limit=50&q=${encodeURIComponent(query.slice(0, 120))}`);
    if (!current()) return;
    if (!result?.ok || result.protocol !== CASE_PROTOCOL || !Array.isArray(result.items) || !result.items.every(validCaseSummary)) throw new Error('The case list is unavailable. Previous records are retained.');
    setItems(result.items.slice(0, 50)); setReady(true);
  });
  useEffect(() => {
    gate.current.invalidate(); gate.current = new ReviewGate(); pendingCheckReport.current = undefined; setBusy(false); setDraft(undefined); setOriginal(undefined); setConflict(undefined); setReviewedLink(undefined); setSources([]); setComputers([]); setAck(false); setReady(false); setItems([]); setError(''); setNotice('');
    if (state.client && state.foreground && state.connection === 'connected') void refresh();
    return () => gate.current.invalidate();
  }, [state.client, state.foreground]);
  const edit = (next: CaseDraft) => { setDraft(next); setAck(false); setNotice(''); };
  const open = (id: string) => {
    if (dirty) { setError('Save or discard your current draft before opening another record.'); return; }
    void run(async (api, current) => { const next = validateCase(await api.json(`/api/intelligence/cases/${encodeURIComponent(id)}`)); if (!current()) return; pendingCheckReport.current = undefined; setOriginal(next); setDraft(draftCase(next)); setConflict(undefined); setAck(false); setReviewedLink(undefined); setNotice(''); });
  };
  useEffect(() => { if (params.id && ready && !busy) { open(params.id); router.setParams({ id: undefined }); } }, [params.id, ready, busy]);
  const loadChoices = () => run(async (api, current) => {
    const inventory = await api.json<{ devices: Device[] }>('/api/intelligence/devices');
    if (!current()) return;
    if (!Array.isArray(inventory?.devices)) throw new Error('The computer list is unavailable. The saved association is unchanged.');
    setComputers(inventory.devices.filter(d => d.kind === 'computer').slice(0, 100));
    const notes = await api.json<{ facts: Note[] }>('/api/intelligence/memory');
    if (!current()) return;
    const reports = await api.json<{ reports: Report[] }>('/api/intelligence/diagnostics');
    if (!current()) return;
    setSources([...(Array.isArray(notes?.facts) ? notes.facts.slice(0, 100).map(n => ({ kind: 'note' as const, id: n.id, title: n.title || 'Untitled note' })) : []), ...(Array.isArray(reports?.reports) ? reports.reports.slice(0, 100).map(r => ({ kind: 'report' as const, id: r.id, title: `${r.kind} · ${r.target?.name || r.host?.name || 'Unknown target'} · ${formatTime(r.created_at || r.checked_at)}` })) : [])]);
  });
  const reviewLink = (requested: { kind: string; id: string; message_index?: number }) => run(async (api, current) => { const result = validateEvidence(await api.json('/api/intelligence/cases/evidence/review', 'POST', { kind: requested.kind, id: requested.id, ...(requested.kind === 'chat' ? { message_index: requested.message_index } : {}) }), requested); if (current()) setReviewedLink(result); });
  const save = () => run(async (api, current) => {
    if (!draft || !ack) throw new Error('Review the changes before saving.');
    if (!request.current) request.current = `phone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = caseBody(draft, original, request.current);
    const value = await api.json(original ? `/api/intelligence/cases/${encodeURIComponent(original.id)}` : '/api/intelligence/cases', original ? 'PUT' : 'POST', body);
    if (!current()) return;
    const next = validateCase(value); pendingCheckReport.current = undefined; setOriginal(next); setDraft(draftCase(next)); setAck(false); setConflict(undefined); setNotice('Troubleshooting record saved. Saving did not run diagnostics, AI requests or device actions.'); request.current = '';
  }, true);
  const inspectConflict = () => run(async (api, current) => { if (!original) return; const latest = validateCase(await api.json(`/api/intelligence/cases/${encodeURIComponent(original.id)}`)); if (current()) { setConflict(latest); setAck(false); } });
  const leaveDraft = () => { const action = () => { pendingCheckReport.current = undefined; setDraft(undefined); setOriginal(undefined); setConflict(undefined); setReviewedLink(undefined); setAck(false); request.current = ''; void refresh(); }; if (dirty) confirmDiscard(action); else action(); };
  const openSource = (link: CaseLink) => {
    if (dirty) { setError('Save or discard your draft before opening linked evidence.'); return; }
    if (link.kind === 'note') router.push({ pathname: '/notebook', params: { note: link.id, revision: link.revision } });
    else if (link.kind === 'report') router.push({ pathname: '/report/[id]', params: { id: link.id } });
    else router.push({ pathname: '/ask', params: { conversation: link.id } });
  };
  if (!state.pairing) return <Redirect href="/pair" />;
  return <View style={{ flex: 1 }}><ConnectionNotice /><Screen><Section title="Troubleshooting" detail="Keep the symptom, reviewed evidence, steps you tried and what worked in one shared record." /><Copy muted size={13}>This workspace records your investigation. It never runs steps or sends a case to AI automatically. Private drafts clear when the app backgrounds or the pairing changes.</Copy>
    {!!error && <Notice error>{error}{draft ? ' Your draft is retained; check the saved record before another save.' : ''}</Notice>}{!!notice && <Notice>{notice}</Notice>}
    {!draft ? <><Row style={{ flexWrap: 'wrap' }}>{['open', 'resolved', 'archived'].map(status => <Button key={status} title={status} secondary={filter !== status} disabled={busy} onPress={() => setFilter(status)} />)}</Row><TextInput accessibilityLabel="Search Troubleshooting" value={query} maxLength={120} onChangeText={setQuery} placeholder="Search saved records" placeholderTextColor={t.muted} style={input} /><Button secondary title="Search and refresh records" busy={busy} disabled={!enabled} onPress={() => void refresh()} /><Button title="New Troubleshooting record" disabled={!enabled || !ready} onPress={() => { setOriginal(undefined); edit({ ...emptyCase(), computer_id: params.computer || null }); request.current = ''; }} />{params.evidence && <Notice>Choose or create a record to review the requested evidence link. Nothing has been attached.</Notice>}{items.map(item => <Card key={item.id}><Label>{item.archived ? 'Archived' : item.status}</Label><Copy size={22} weight="600">{item.title}</Copy><Copy muted numberOfLines={3}>{item.symptom}</Copy><Copy muted size={12}>{item.computer ? `${item.computer.name} · ${item.computer.id}` : 'No computer association'} · updated {formatTime(item.updated_at)}</Copy><Button secondary title="Open record" disabled={!enabled} onPress={() => open(item.id)} /></Card>)}{ready && !items.length && <Notice>No records in this result. Other filters may contain saved work.</Notice>}</> : <>
      <Card><Label>{original ? 'Edit shared record' : 'New shared record'}</Label><TextInput accessibilityLabel="Troubleshooting title" placeholder="What are you working through?" placeholderTextColor={t.muted} value={draft.title} maxLength={120} editable={!busy} onChangeText={title => edit({ ...draft, title })} style={input} /><TextInput accessibilityLabel="Symptom" placeholder="What happened and when?" placeholderTextColor={t.muted} multiline value={draft.symptom} maxLength={4000} editable={!busy} onChangeText={symptom => edit({ ...draft, symptom })} style={[...input, { minHeight: 120 }]} /><Copy muted>Computer: {original?.computer?.id === draft.computer_id ? `${original.computer.name} · ${draft.computer_id}` : draft.computer_id || 'Not assigned'}</Copy><Button secondary title="Load computers and saved evidence" busy={busy} disabled={!enabled} onPress={() => void loadChoices()} /><Button secondary title="No computer association" disabled={!enabled} onPress={() => edit({ ...draft, computer_id: null })} />{computers.map(computer => <Button key={computer.id} secondary={draft.computer_id !== computer.id} title={`${computer.name} · ${computer.id}`} disabled={!enabled} onPress={() => edit({ ...draft, computer_id: computer.id })} />)}</Card>
      <Copy muted size={13}>Describe → Choose computer → Review a check → Run → Review evidence → Record what helped</Copy>
      <GuidedChecks key={original?.id || 'new'} computerId={draft.computer_id} savedCase={original} dirty={dirty} disabled={!enabled} onEvidence={link => { pendingCheckReport.current = link.id; setReviewedLink(link); }} />
      <Card><Label>Evidence · links to saved sources</Label><Copy muted size={13}>Changed or deleted sources are marked when the host reads this record. Existing links preserve their reviewed revision; refreshing never silently replaces evidence.</Copy>{draft.evidence.map((link, index) => <View key={`${link.kind}:${link.id}:${index}`} style={{ gap: 8 }}><Copy>{link.label || link.id} · {link.kind}</Copy><Copy muted size={12}>{evidenceAvailability(link)} · revision {link.revision}</Copy><Button secondary title="Open source" disabled={!enabled || link.availability === 'unavailable'} onPress={() => openSource(link)} /><Button secondary title="Remove link from this record" disabled={!enabled} onPress={() => edit({ ...draft, evidence: draft.evidence.filter((_, i) => i !== index) })} /></View>)}
      {params.evidence && ['note', 'report', 'chat'].includes(params.kind || '') && <Button secondary title="Review requested evidence link" disabled={!enabled} onPress={() => void reviewLink({ kind: params.kind!, id: params.evidence!, ...(params.kind === 'chat' ? { message_index: Number(params.message_index) } : {}) })} />}
      {sources.map(source => <Button key={`${source.kind}:${source.id}`} secondary title={`Review ${source.kind}: ${source.title}`} disabled={!enabled || draft.evidence.length >= 32} onPress={() => void reviewLink(source)} />)}
      {reviewedLink && <Card><Label>Reviewed source</Label><Copy>{reviewedLink.label}</Copy><Copy selectable muted size={12}>{reviewedLink.kind} · {reviewedLink.id} · revision {reviewedLink.revision}</Copy><Button title="Add reviewed link to draft" disabled={!enabled || draft.evidence.length >= 32} onPress={() => { if (!draft.evidence.some(e => e.kind === reviewedLink.kind && e.id === reviewedLink.id && e.message_index === reviewedLink.message_index)) edit({ ...draft, evidence: [...draft.evidence, reviewedLink] }); setReviewedLink(undefined); }} /><Button secondary title="Cancel link review" disabled={busy} onPress={() => setReviewedLink(undefined)} /></Card>}</Card>
      <Card><Label>Steps · recorded, never executed here</Label>{draft.steps.map((step, index) => <View key={step.id} style={{ gap: 8 }}><TextInput accessibilityLabel={`Step ${index + 1}`} value={step.text} maxLength={1000} editable={!busy} multiline style={input} onChangeText={text => edit({ ...draft, steps: draft.steps.map((s, i) => i === index ? { ...s, text } : s) })} /><Row style={{ flexWrap: 'wrap' }}>{(['planned', 'tried', 'skipped'] as const).map(status => <Button key={status} secondary={step.status !== status} title={status} disabled={busy} onPress={() => edit({ ...draft, steps: draft.steps.map((s, i) => i === index ? { ...s, status } : s) })} />)}</Row><TextInput accessibilityLabel={`Outcome for step ${index + 1}`} placeholder="What happened?" placeholderTextColor={t.muted} value={step.outcome} maxLength={2000} multiline editable={!busy} style={input} onChangeText={outcome => edit({ ...draft, steps: draft.steps.map((s, i) => i === index ? { ...s, outcome } : s) })} /><Button secondary title="Remove step" disabled={busy} onPress={() => edit({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })} /></View>)}<Button secondary title="Add a step to record" disabled={!enabled || draft.steps.length >= 30} onPress={() => edit({ ...draft, steps: [...draft.steps, { id: `step-${Date.now()}-${draft.steps.length}`, text: '', status: 'planned', outcome: '' }] })} /></Card>
      <Card><Label>Outcome</Label><Row><Switch accessibilityLabel="I confirmed this issue is resolved" value={draft.status === 'resolved'} disabled={busy} onValueChange={value => edit({ ...draft, status: value ? 'resolved' : 'open' })} /><Copy style={{ flex: 1 }}>I confirmed this issue is resolved</Copy></Row><TextInput accessibilityLabel="Resolution" placeholder="What worked? Required when resolved." placeholderTextColor={t.muted} value={draft.resolution} maxLength={2000} editable={!busy} multiline onChangeText={resolution => edit({ ...draft, resolution })} style={[...input, { minHeight: 110 }]} /><Row><Switch accessibilityLabel="Archive this record" value={draft.archived} disabled={busy} onValueChange={archived => edit({ ...draft, archived })} /><Copy style={{ flex: 1 }}>Archive this record</Copy></Row></Card>
      {original && <><Button secondary title="Check current saved version" disabled={!enabled} onPress={() => void inspectConflict()} /><Button secondary title="Ask about this case…" disabled={!enabled} onPress={() => { if (dirty) { setError('Save or discard the edited case before reviewing it for Ask. Your draft is unchanged.'); return; } setAskCase(original.id); }} /></>}
      {conflict && <Card><Label>Current host version · your draft is unchanged</Label><Copy weight="600">{conflict.title}</Copy><Copy>{conflict.symptom}</Copy><Copy muted>{conflict.status} · {formatTime(conflict.updated_at)} · {conflict.steps.length} steps · {conflict.evidence.length} evidence links</Copy><Copy>{conflict.resolution || 'No resolution recorded'}</Copy><Button secondary title="Discard draft and load this version" disabled={!enabled} onPress={() => confirmDiscard(() => { setOriginal(conflict); setDraft(draftCase(conflict)); setConflict(undefined); setAck(false); })} /></Card>}
      <Row><Switch accessibilityLabel="I reviewed this Troubleshooting record" value={ack} disabled={busy} onValueChange={setAck} /><Copy style={{ flex: 1 }}>I reviewed these changes and the exact evidence links.</Copy></Row><Button title="Save reviewed record" busy={busy} disabled={!enabled || !ack || !draft.title.trim()} onPress={() => void save()} /><Button secondary title="Back to records" disabled={busy} onPress={leaveDraft} />
    </>}
  </Screen><CaseContextReview caseId={askCase} close={() => setAskCase(undefined)} used={() => router.push('/ask')} /></View>;
}
