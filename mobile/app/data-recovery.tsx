import { useEffect, useRef, useState } from 'react';
import { Redirect } from 'expo-router';
import { useCompanion } from '../src/state';
import { Button, Card, ConnectionNotice, Copy, Label, Notice, Screen, Section, useTheme } from '../src/ui';
import { formatTime } from '../src/protocol';
import { DataHealthCheck, dataHealthLabel } from '../src/data-health';

export default function DataRecoveryScreen() {
  const state = useCompanion(), theme = useTheme();
  const [checks] = useState(() => new DataHealthCheck());
  const [result, setResult] = useState(checks.snapshot);
  const session = useRef({ client: state.client, hostId: state.pairing?.node_id, foreground: state.foreground, connected: state.connection === 'connected' });
  session.current = { client: state.client, hostId: state.pairing?.node_id, foreground: state.foreground, connected: state.connection === 'connected' };
  useEffect(() => checks.subscribe(setResult), [checks]);
  useEffect(() => { checks.clear(); return () => checks.clear(); }, [checks, state.client, state.pairing?.node_id]);
  useEffect(() => { if (!state.foreground || state.connection !== 'connected') checks.suspend(); }, [checks, state.foreground, state.connection]);
  if (!state.pairing) return <Redirect href="/pair" />;
  const data = result.checkedFor === state.client && result.data?.host.id === state.pairing.node_id ? result.data : undefined;
  const stale = !!data && (result.stale || !state.foreground || state.connection !== 'connected');
  const run = () => {
    const api = state.client, hostId = state.pairing?.node_id;
    if (!api || !hostId || !state.foreground || state.connection !== 'connected') return;
    void checks.check(api, hostId, () => session.current.client === api && session.current.hostId === hostId && session.current.foreground && session.current.connected);
  };
  return <Screen><ConnectionNotice /><Section title="Data & Recovery" detail="Check the saved data on your paired TLI." />
    <Card><Label>Keep a separate backup</Label><Copy>This phone is not a backup of your TLI.</Copy><Copy muted>These checks read selected data for your owner account on the TLI host. They do not check Vault contents, verify a backup, or restore anything.</Copy></Card>
    <Button title={data ? 'Check saved data again' : 'Check saved data'} icon="document-text-outline" busy={result.busy} disabled={!state.client || !state.foreground || state.connection !== 'connected'} onPress={run} />
    {!data && !result.busy && !result.error && <Copy muted>No checks have been requested in this view. Tap Check saved data to read the current status.</Copy>}
    {result.busy && <Notice>Reading selected data on your TLI. This does not change files.</Notice>}
    {!!result.error && <Notice error>{result.error}</Notice>}
    {stale && <Notice>{result.busy ? 'Earlier results are shown while this check runs.' : 'Previous checks are out of date. They are not a successful current check.'} Tap Check saved data again when connected.</Notice>}
    {data && <>
      <Card><Label>{stale ? 'Previous check' : 'Last completed check'}</Label><Copy weight="600">{data.host.name}</Copy><Copy muted size={13}>{formatTime(data.checked_at)}</Copy><Copy muted>{data.scope}</Copy></Card>
      {data.checks.map(check => <Card key={check.id}><Section title={check.label} /><Copy weight="600" style={{ color: check.status === 'unavailable' ? theme.danger : check.status === 'readable' ? theme.emerald : theme.amber }}>{dataHealthLabel(check.status)}{stale ? ' · previous result' : ''}</Copy><Copy muted>{check.detail}</Copy></Card>)}
      <Card><Section title="Backup status: unknown" /><Copy>{data.backup.detail}</Copy><Copy muted>A readable file is not evidence of a separate, recoverable backup.</Copy></Card>
      <Card><Section title="Manual backup and recovery" /><Copy>{data.guidance.summary}</Copy>{data.guidance.steps.map((step, index) => <Copy key={index}>{index + 1}. {step}</Copy>)}</Card>
      {!!data.guidance.limitations.length && <Card><Label>Scope and limits</Label>{data.guidance.limitations.map((limitation, index) => <Copy key={index} muted>{limitation}</Copy>)}</Card>}
    </>}
  </Screen>;
}
