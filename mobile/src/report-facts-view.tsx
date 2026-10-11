import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Copy, Label, Notice } from './ui';
import { measuredValue, recordedReport, reportIdentity, reportStatus, reportTime, type ReportBinding } from './report-facts';

export function ReportFacts({ value, expected, compact = false }: { value: unknown; expected?: ReportBinding; compact?: boolean }) {
  const [expanded, setExpanded] = useState(!compact), facts = recordedReport(value, expected);
  return <Card style={compact ? { padding: 12, gap: 7, borderRadius: 14 } : undefined}><Label>Recorded report facts</Label><Copy muted size={13}>Saved evidence, not current health or proof of a repair.</Copy>{!facts ? <Notice>A usable structured report summary is unavailable. Missing details do not establish completion or a different target.</Notice> : <>
    <Copy weight="600">{reportStatus(facts)}</Copy><Copy selectable size={compact ? 14 : 16}>Executing TLI host: {reportIdentity(facts.host)}</Copy>
    {facts.kind === 'performance' ? <Copy selectable size={compact ? 14 : 16}>Selected process: {facts.process?.name || 'Name not recorded'} · PID {facts.process?.pid ?? 'unknown'}</Copy> : <Copy selectable size={compact ? 14 : 16}>Measured subject: {facts.target ? reportIdentity(facts.target) : ['device', 'unknown'].includes(facts.kind) ? 'Subject not recorded; no different target assumed' : 'The executing TLI host'}</Copy>}
    <Copy muted size={13}>Report recorded: {reportTime(facts.recorded_at)}</Copy>
    {facts.kind === 'performance' && <Copy size={compact ? 14 : 16}>Sample coverage: {facts.recorded_samples ?? 'Unknown'} recorded · {facts.expected_samples ?? 'unknown'} planned</Copy>}
    {compact && <Button secondary title={expanded ? 'Hide measurement details' : 'Show measurements and limitations'} onPress={() => setExpanded(v => !v)} />}
    {expanded && <>
      {facts.kind === 'performance' && <><Copy selectable size={13}>Process start: {facts.process?.create_time == null ? 'Not recorded; no other process substituted' : `${new Date(facts.process.create_time * 1000).toLocaleString()} · recorded value ${facts.process.create_time}`}</Copy><Copy size={13}>Observation interval: {reportTime(facts.started_at)} → {reportTime(facts.finished_at)}</Copy><Copy size={13}>{facts.duration_seconds ?? 'Unknown'} s observed · {facts.requested_duration_seconds ?? 'Unknown'} s requested</Copy></>}
      {facts.measurements.map(m => <View key={m.key} style={{ gap: 3, marginVertical: 4 }}><Copy weight="600">{m.label}</Copy><Copy size={13}>{m.scope === 'host' ? 'Executing host' : 'Selected process'} · {m.valid_samples} usable of {facts.recorded_samples ?? 'unknown'} recorded samples</Copy><Copy size={14}>Mean {measuredValue(m.mean, m.unit)} · Minimum {measuredValue(m.minimum, m.unit)} · Maximum {measuredValue(m.maximum, m.unit)}</Copy></View>)}
      {facts.checks.map((c, i) => <View key={`${c.id}-${i}`} style={{ gap: 3, marginVertical: 4 }}><Copy weight="600">{{ pass: 'Recorded pass', fail: 'Recorded failure', unavailable: 'Unavailable', unknown: 'Unknown' }[c.status]} · {c.label}</Copy><Copy size={14}>{c.detail || 'Check details not recorded.'}</Copy><Copy muted size={12}>Scope: {{ host: 'executing host', host_to_device: 'host-to-device reachability', unknown: 'not recorded' }[c.scope]}</Copy></View>)}
      {!!facts.omitted_checks && <Copy>{facts.omitted_checks} additional saved checks omitted from this bounded summary.</Copy>}
      <Label>Coverage and limitations</Label>{facts.limitations.map((s, i) => <Copy key={i} muted size={13}>{s}</Copy>)}<Copy selectable muted size={12}>Saved report ID: {facts.report_id}</Copy>
    </>}
  </>}</Card>;
}
