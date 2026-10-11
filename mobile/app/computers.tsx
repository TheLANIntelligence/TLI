import { View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useCompanion, useResource } from '../src/state';
import { AIReadinessNotice, Button, Card, ConnectionNotice, Copy, Label, Notice, Screen, Section } from '../src/ui';
import { formatTime } from '../src/protocol';
import type { Device, Report } from '../src/types';

export default function ComputersScreen() {
  const state = useCompanion(), router = useRouter();
  const inventory = useResource<{ devices: Device[]; scope?: string }>('/api/intelligence/devices');
  const reports = useResource<{ reports: Report[] }>('/api/intelligence/diagnostics');
  if (!state.pairing) return <Redirect href="/pair" />;
  const computers = inventory.data?.devices.filter(d => d.kind === 'computer') || [];
  return <View style={{ flex: 1 }}><ConnectionNotice /><Screen><Section title="Computers" detail="Computers registered with your paired TLI host. Opening this roster runs no diagnostic or device action." />
    <Card><Label>Paired TLI host</Label><Copy weight="600">{state.bootstrap?.node.name || state.pairing.node_name}</Copy><Copy selectable muted>{state.pairing.origin}</Copy><Copy muted size={12}>Host identity: {state.pairing.node_id} · last connection check {formatTime(state.checkedAt)}</Copy><AIReadinessNotice /></Card>
    <Button secondary title="Refresh roster and saved reports" busy={inventory.busy || reports.busy} disabled={state.connection !== 'connected'} onPress={() => { void inventory.reload(); void reports.reload(); }} />
    {(inventory.error || reports.error) && <Notice error>{inventory.error || reports.error}</Notice>}
    {inventory.stale && inventory.data && <Notice>Previously read roster. Reconnect and refresh for current information.</Notice>}
    {computers.map(computer => <Card key={computer.id}><Label>{computer.node_id === state.pairing!.node_id ? 'TLI host' : 'Registered computer'}</Label><Copy size={23} weight="600">{computer.name}</Copy><Copy muted selectable size={12}>{computer.id} · node {computer.node_id}</Copy><Copy muted size={13}>Observed {computer.observed_at ? formatTime(computer.observed_at) : 'time unavailable'}. Registration alone does not confirm connectivity or an installed AI model.</Copy><Copy muted size={13}>Reported capabilities: unavailable in this inventory.</Copy><Button secondary title="Open computer details" onPress={() => router.push({ pathname: '/device/[id]', params: { id: computer.id } })} /><Button secondary title="Start Troubleshooting record" onPress={() => router.push({ pathname: '/cases', params: { computer: computer.id } })} />{reports.data?.reports.filter(r => r.target?.id === computer.id || !r.target && computer.node_id === state.pairing!.node_id).slice(0, 8).map(report => <Button key={report.id} secondary title={`${report.kind} · ${formatTime(report.created_at || report.checked_at)}`} onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })} />)}</Card>)}
    {!inventory.busy && inventory.data && !computers.length && <Notice>No computers were returned by this host.</Notice>}
    <Section title="Saved diagnostic reports" detail="These are saved observations. Opening one does not rerun it." />{reports.data?.reports.slice(0, 50).map(report => <Button key={report.id} secondary title={`${report.target?.name || report.host?.name || 'Target not recorded'} · ${report.kind} · ${formatTime(report.created_at || report.checked_at)}`} onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })} />)}
  </Screen></View>;
}
