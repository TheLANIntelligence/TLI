import { useEffect, useRef, useState } from 'react';
import { Switch } from 'react-native';
import { useCompanion, errorText } from './state';
import { Button, Card, Copy, Label, Notice, Row } from './ui';
import { ReviewGate } from './reviewed-note';
import { checkOptions, checkReport, checkRequest, type CheckOptions, type CheckOption } from './guided-checks';
import { validateEvidence, type CaseLink, type TroubleshootingCase } from './cases';
import { formatTime } from './protocol';
import type { Client } from './client';
import type { Report } from './types';
import { ReportFacts } from './report-facts-view';
import { NextCheckReview } from './next-check';
import { CaseContextReview } from './case-context-review';
import type { SelectedCase } from './case-context';

export function GuidedChecks({ computerId, disabled, onEvidence, savedCase, dirty = false }: { computerId: string | null; disabled: boolean; onEvidence: (link: CaseLink) => void; savedCase?: TroubleshootingCase; dirty?: boolean }) {
  const state = useCompanion();
  const [choices, setChoices] = useState<CheckOptions>(), [selected, setSelected] = useState<CheckOption>(), [internet, setInternet] = useState(false);
  const [report, setReport] = useState<Report>(), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false), [uncertain, setUncertain] = useState(false);
  const gate = useRef(new ReviewGate()), apiRef = useRef(state.client), foreground = useRef(state.foreground), request = useRef('');
  const guidance = useRef(new NextCheckReview()), [selectCase, setSelectCase] = useState(false), [suggested, setSuggested] = useState(false);
  const contextKey = JSON.stringify([computerId, savedCase?.id, savedCase?.revision, dirty]), context = useRef(contextKey); context.current = contextKey;
  apiRef.current = state.client; foreground.current = state.foreground;
  useEffect(() => {
    gate.current.invalidate(); gate.current = new ReviewGate(); guidance.current.invalidate(!state.foreground || !state.client); setBusy(false); setChoices(undefined); setSelected(undefined); setSuggested(false); setSelectCase(false); request.current = ''; setUncertain(false);
    if (!state.foreground || !state.client) { setReport(undefined); setMessage(''); }
    else setMessage('Review check choices for the selected computer. No check runs automatically.');
    return () => gate.current.invalidate();
  }, [state.client, state.foreground, contextKey]);
  const enabled = !disabled && !busy && !!state.client && state.foreground && state.connection === 'connected';
  const operation = async (work: (api: Client, current: () => boolean) => Promise<void>) => {
    if (!enabled || !state.client || gate.current.busy) return;
    const api = state.client, owned = gate.current, ticket = owned.begin(), key = context.current; setBusy(true); setError(false);
    const current = () => owned === gate.current && owned.current(ticket) && apiRef.current === api && foreground.current && context.current === key;
    try { await work(api, current); } catch (e) { if (current()) { setError(true); setMessage(`${errorText(e)} Nothing is retried automatically.`); } }
    finally { const valid = current(); owned.finish(ticket); if (valid) setBusy(false); }
  };
  const review = () => operation(async (api, current) => {
    setSelected(undefined); setSuggested(false);
    const value = await api.json('/api/intelligence/diagnostics/options?include_peer_observation=true' + (computerId ? `&computer_id=${encodeURIComponent(computerId)}` : ''));
    if (!current()) return;
    setChoices(checkOptions(value, computerId)); setSelected(undefined); setUncertain(false); request.current = '';
    setMessage('Choose a check and review its host, target and scope. Nothing has run.');
  });
  const reviewGuidance = (selection: SelectedCase, saved: TroubleshootingCase) => {
    if (!enabled || dirty || !savedCase || saved.id !== savedCase.id || saved.revision !== savedCase.revision || (saved.computer?.id ?? null) !== computerId) throw new Error('The saved case changed. Save or discard your draft and review its current version first.');
    setSelected(undefined); setSuggested(false);
    void operation(async (api, current) => {
      await guidance.current.review(api, selection, saved, current);
      if (current()) setMessage('Guidance uses only the reviewed saved details. No new check or AI request ran.');
    });
  };
  const reviewSuggestion = () => operation(async (api, current) => {
    if (dirty || !savedCase) throw new Error('Save or discard the edited case before reviewing a suggested check.');
    setSelected(undefined); setSuggested(false);
    const next = await guidance.current.reviewSuggested(api, computerId, current);
    if (!current()) return;
    setChoices(next.options); setSelected(next.option); setSuggested(true); setInternet(false); request.current = ''; setUncertain(false);
    setMessage('The suggested check scope was checked again. Review it below, then choose Run this check.');
  });
  const run = () => operation(async (api, current) => {
    if (!selected || uncertain) return;
    request.current ||= `phone-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = checkRequest(selected, internet, request.current);
    if (suggested) body.next_check_ref = guidance.current.runRef(selected);
    setMessage('Running the reviewed check. Earlier results remain below.');
    try {
      const value = await api.json('/api/intelligence/diagnostics', 'POST', body);
      if (!current()) return;
      setReport(checkReport(value, body, selected)); setSelected(undefined); setSuggested(false); guidance.current.invalidate(); request.current = ''; setUncertain(false);
      setMessage('Report saved. Review it before adding a link to this problem. No repair was performed.');
    } catch (e) { if (current()) { setUncertain(true); guidance.current.invalidate(); } throw e; }
  });
  const link = () => operation(async (api, current) => {
    if (!report) return;
    try {
      const value = await api.json('/api/intelligence/cases/evidence/review', 'POST', { kind: 'report', id: report.id });
      if (!current()) return;
      onEvidence(validateEvidence(value, { kind: 'report', id: report.id }));
      setMessage('Report saved. Its reviewed link is below; add it to the draft, then save the problem.');
    } catch (e) { throw new Error(`Report saved; problem link not saved. ${errorText(e)}`); }
  });
  const next = guidance.current.result;
  return <Card><Label>Choose the next useful check</Label><Copy muted>Review the executing host and measured target. Running saves a report; linking it and saving this problem are separate actions.</Copy>
    {!!message && <Notice error={error}>{message}</Notice>}
    <Button secondary title="Review next-check guidance" disabled={!enabled || !savedCase || dirty} onPress={() => { setSelected(undefined); setSuggested(false); setSelectCase(true); }} />
    {(!savedCase || dirty) && <Copy muted size={13}>Save or discard the edited record before using saved-case guidance. Your draft is unchanged.</Copy>}
    {next && <Card><Label>From the reviewed saved case</Label><Copy muted size={12}>{next.receipt.title} · {formatTime(next.checked_at)} · {next.receipt.computer_id || 'No computer association'}</Copy>
      {!guidance.current.current && <Notice>Earlier guidance retained. Review the saved case again before using its suggestion.</Notice>}
      <Label>Known · saved details</Label>{next.known.map(row => <Copy selectable key={row.id}>{row.label}: {row.text} [{row.source}]{row.recorded_at ? ` · ${formatTime(row.recorded_at)}` : ''}</Copy>)}
      {next.facts && <ReportFacts value={next.facts} compact />}
      <Label>Missing from this selection</Label>{next.missing.length ? next.missing.map(row => <Copy key={row.id}>{row.text}</Copy>) : <Copy muted>No additional missing item was listed. This is not proof of current health.</Copy>}
      <Label>Recorded steps</Label>{next.steps.length ? next.steps.map(step => <Copy selectable key={step.id}>{step.status}: {step.text}{'\n'}{step.outcome || 'No outcome recorded.'}</Copy>) : <Copy muted>No steps were selected. Unselected steps were not used.</Copy>}
      <Label>Suggested next observation</Label>{next.suggestion ? <><Copy>{next.suggestion.rationale}</Copy><Copy muted>{next.options?.options.find(o => o.id === next.suggestion?.option_id)?.title}</Copy><Button secondary title="Review suggested check" disabled={!enabled || dirty || !guidance.current.current} onPress={() => void reviewSuggestion()} /></> : <Copy muted>No available check was suggested for this selection.</Copy>}
      {next.limitations.map((line, i) => <Copy muted size={13} key={i}>{line}</Copy>)}
    </Card>}
    {!computerId && <Copy muted>Choose the computer involved before running a check.</Copy>}
    <Button secondary title="Review available checks" disabled={!enabled} busy={busy} onPress={() => void review()} />
    {choices && <Copy muted size={12}>Choices checked {formatTime(choices.checked_at)} · TLI host: {choices.host.name} ({choices.host.id})</Copy>}
    {choices?.options.map(option => <Card key={option.id}><Copy weight="600">{option.title}</Copy><Copy>{option.detail}</Copy><Copy muted size={12}>Runs on {option.execution_host.name} · measures {option.measured_target.name} ({option.measured_target.id})</Copy>
      {!option.available && <Copy muted>{option.reason}</Copy>}
      {option.kind === 'performance' ? <Copy muted size={13}>Start application observations in the desktop browser. Saved performance reports are available in Computers on this phone.</Copy> : <Button secondary title="Review this check" disabled={!enabled || !option.available} onPress={() => { setSelected(option); setSuggested(false); setInternet(false); request.current = ''; setUncertain(false); setMessage('Review the scope, then choose Run this check.'); }} />}
    </Card>)}
    {selected && <Card><Label>{selected.title}</Label><Copy>{selected.detail}</Copy><Copy muted>Executing host: {selected.execution_host.name} ({selected.execution_host.id}). Target: {selected.measured_target.name} ({selected.measured_target.id}).</Copy>
      {selected.kind === 'peer_system' && <><Copy selectable muted size={12}>Reviewed peer fingerprint: {selected.execution_host.identity_fingerprint}</Copy><Notice>One resource observation from this selected peer. No disk, network, process, repair or phone measurements. No local-host fallback.</Notice></>}
      {selected.kind === 'network' && !suggested && <Row><Switch accessibilityLabel="Include internet checks" value={internet} disabled={!enabled} onValueChange={value => { setInternet(value); request.current = ''; }} /><Copy style={{ flex: 1 }}>{selected.internet_detail}</Copy></Row>}
      {suggested && <Copy muted size={13}>Bound to the reviewed saved case and selected evidence. The host rechecks these revisions before running. Internet checks are excluded.</Copy>}
      <Copy muted size={13}>No repairs or restarts. Leaving this view does not cancel server work.</Copy><Button title="Run this check" disabled={!enabled || uncertain} busy={busy} onPress={() => void run()} />
      <Button secondary title="Cancel check review" disabled={!enabled} onPress={() => { setSelected(undefined); setSuggested(false); setMessage('Review closed. No new check was requested.'); }} />
    </Card>}
    {uncertain && <Notice error>Check saved reports in Computers before deliberately starting a new check. The previous request will not replay on reconnect.</Notice>}
    {report && <Card><Label>Last saved report</Label><Copy muted>{report.scope}</Copy><ReportFacts value={report.recorded_facts} expected={{ reportId: report.id, hostId: report.host?.id ?? null, targetId: report.target?.id ?? null }} compact /><Button secondary title="Review report link for this problem" disabled={!enabled} onPress={() => void link()} /></Card>}
    <CaseContextReview caseId={selectCase ? savedCase?.id : undefined} close={() => setSelectCase(false)} guidance={reviewGuidance} />
  </Card>;
}
