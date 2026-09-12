import { useEffect, useRef, useState } from 'react';
import { Modal, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCompanion, errorText } from './state';
import { Button, Card, Copy, Label, Notice, Row, Screen, Section, useTheme } from './ui';
import { CaseReview, caseLinkKey, type SelectedCase } from './case-context';
import type { TroubleshootingCase } from './cases';
import { formatTime } from './protocol';
import { ReportFacts } from './report-facts-view';

export function CaseContextReview({ caseId, close, used, guidance }: { caseId?: string; close: () => void; used?: () => void; guidance?: (selection: SelectedCase, saved: TroubleshootingCase) => void }) {
  const state = useCompanion(), t = useTheme(), review = useRef(new CaseReview());
  const [, render] = useState(0), [error, setError] = useState('');
  const session = useRef({ client: state.client, foreground: state.foreground, id: caseId });
  session.current = { client: state.client, foreground: state.foreground, id: caseId };
  const update = () => render(n => n + 1);
  const requestClose = () => { review.current.close(); update(); close(); };
  const load = async () => {
    const api = state.client, id = caseId, owned = review.current;
    if (!api || !id || !state.foreground || state.connection !== 'connected' || owned.busy) return;
    const current = () => owned === review.current && session.current.client === api && session.current.foreground && session.current.id === id;
    setError(''); const pending = owned.load(api, id, current); update();
    try { await pending; } catch (e) { if (current()) setError(errorText(e) + ' Previous choices are retained; check the saved version again before using them.'); }
    finally { if (current()) update(); }
  };
  useEffect(() => { review.current.clear(); review.current = new CaseReview(); setError(''); update(); if (!state.client || !state.foreground) close(); }, [state.client, state.foreground]);
  useEffect(() => { if (caseId) void load(); return () => review.current.close(); }, [caseId, state.client, state.foreground]);
  const r = review.current, row = r.row, enabled = !!caseId && !!state.client && state.foreground && state.connection === 'connected' && !state.sending && !state.loadingConversation;
  const change = (work: () => void) => { if (!enabled || r.busy) return; try { work(); setError(''); } catch (e) { setError(errorText(e)); } update(); };
  const use = () => { if (!enabled || r.busy || !r.checked || !r.row) return; try { const selection = r.selection(); if (guidance) guidance(selection, r.row); else state.selectCase(selection); requestClose(); used?.(); } catch (e) { setError(errorText(e)); } };
  const preview = async () => {
    const api = state.client, id = caseId, owned = review.current;
    if (!enabled || !api || owned.busy) return;
    const current = () => owned === review.current && session.current.client === api && session.current.foreground && session.current.id === id;
    setError(''); const pending = owned.previewReport(api, current); update();
    try { await pending; } catch (e) { if (current()) setError(errorText(e) + ' Your selections remain; nothing was sent to Chat.'); }
    finally { if (current()) update(); }
  };
  return <Modal visible={!!caseId} animationType="slide" onRequestClose={requestClose}><SafeAreaView style={{ flex: 1, backgroundColor: t.background }}><Screen>
    <Section title={guidance ? 'Review a next check' : 'Ask about a saved case'} detail={guidance ? 'Choose the saved details this guidance will use.' : 'Review exactly what this question will share.'} />
    <Copy muted>Title, symptom and computer are included. Choose up to eight whole steps and eight evidence-link descriptions, plus the resolution if useful. Source bodies stay excluded. You can separately review bounded facts from one current linked report.</Copy>
    <Notice>{guidance ? 'This reads saved details and available check choices. No AI request, new measurement, repair or Chat attachment. Running a suggested check requires a separate review and Run.' : 'No step runs and no message is sent by this review. Your eventual question and answer may quote these details and are saved in chat history.'}</Notice>
    {r.busy && <Notice>Checking the current saved case…</Notice>}{!!error && <Notice error>{error}</Notice>}
    {row && row.id === caseId && <>
      <Card><Label>Current saved version</Label><Copy size={22} weight="600">{row.title}</Copy><Copy selectable>{row.symptom}</Copy><Copy muted>{row.computer ? `${row.computer.name} · ${row.computer.id}` : 'No computer association'} · {row.status === 'resolved' ? 'User-marked resolved' : 'Open'}{row.archived ? ' · Archived' : ''} · {formatTime(row.updated_at)}</Copy><Copy selectable muted size={12}>Revision {row.revision}</Copy></Card>
      <Section title="Choose whole steps" detail="Planned and skipped steps do not prove anything ran." />
      {!row.steps.length && <Copy muted>No recorded steps.</Copy>}{row.steps.map(step => <Card key={step.id}><Row><Switch accessibilityLabel={`Include step: ${step.text}`} value={r.steps.includes(step.id)} disabled={!enabled || r.busy || !r.checked} onValueChange={value => change(() => r.toggle('step', step.id, value))} /><Copy style={{ flex: 1 }}>{step.status}: {step.text}</Copy></Row><Copy selectable muted>{step.outcome || 'No outcome recorded.'}</Copy></Card>)}
      <Card><Row><Switch accessibilityLabel="Include the user-recorded resolution" value={r.resolution} disabled={!enabled || r.busy || !r.checked} onValueChange={value => change(() => { r.resolution = value; r.invalidatePreview(); })} /><Copy style={{ flex: 1 }}>Include the user-recorded resolution</Copy></Row><Copy selectable>{row.resolution || 'No resolution text recorded.'}</Copy><Copy muted>A recorded improvement is historical context, not an independent test or current health reading.</Copy></Card>
      <Section title="Choose link descriptions" detail="Only the label, revision and availability are shared. Source bodies stay excluded." />
      {!row.evidence.length && <Copy muted>No evidence links.</Copy>}{row.evidence.map(link => <Card key={caseLinkKey(link)}><Row><Switch accessibilityLabel={`Include link description: ${link.label || link.id}`} value={r.links.includes(caseLinkKey(link))} disabled={!enabled || r.busy || !r.checked} onValueChange={value => change(() => r.toggle('link', caseLinkKey(link), value))} /><Copy style={{ flex: 1 }}>{link.label || link.id}</Copy></Row><Copy muted>{link.kind} · {link.availability} · body excluded</Copy></Card>)}
      <Section title="Optional saved report facts" detail="Select one current report link above, then preview its bounded observations. No new check runs." />
      {!r.reportSupported && <Copy muted>This host does not advertise reviewed case-report facts. Link descriptions remain available.</Copy>}
      {row.evidence.filter(link => link.kind === 'report' && r.links.includes(caseLinkKey(link))).map(link => <Row key={'facts-' + caseLinkKey(link)}><Switch accessibilityLabel={`Review facts from report: ${link.label || link.id}`} value={r.reportKey === caseLinkKey(link)} disabled={!enabled || r.busy || !r.checked || !r.reportSupported || link.availability !== 'current'} onValueChange={value => change(() => r.chooseReport(value ? caseLinkKey(link) : undefined))} /><Copy style={{ flex: 1 }}>{link.label || link.id}{link.availability !== 'current' ? ' · current revision unavailable' : ''}</Copy></Row>)}
      {!!r.reportKey && <Button secondary title="Preview selected report facts" disabled={!enabled || r.busy || !r.checked} busy={r.busy} onPress={() => void preview()} />}
      {r.preview && <ReportFacts value={r.preview} />}
      <Copy muted>{r.steps.length} steps and {r.links.length} link descriptions selected · resolution {r.resolution ? 'included' : 'excluded'}. Earlier chat and automatic saved-note recall are excluded.</Copy>
      <Row><Switch accessibilityLabel="I reviewed this case selection" value={r.acknowledged} disabled={!enabled || r.busy || !r.checked || !!r.reportKey && !r.preview} onValueChange={value => change(() => { r.acknowledged = value; })} /><Copy style={{ flex: 1 }}>I reviewed these saved details and the exact selected items{r.reportKey ? ', including the displayed report facts' : ''}.</Copy></Row>
    </>}
    <Button title={guidance ? 'Use selection for next-check guidance' : 'Use selection in Ask'} disabled={!enabled || r.busy || !r.checked || !r.acknowledged} onPress={use} />
    <Button secondary title="Check saved case again" disabled={!enabled || r.busy} onPress={() => void load()} />
    <Button secondary title="Cancel case review" onPress={requestClose} />
  </Screen></SafeAreaView></Modal>;
}
