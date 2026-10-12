import { View } from 'react-native';
import { useEffect,useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { useCompanion, useResource } from '../src/state';
import { AIReadinessNotice, Button, Card, ConnectionNotice, Copy, Label, Notice, Screen, Section } from '../src/ui';
import { formatTime } from '../src/protocol';
import type { Device, Report } from '../src/types';
import { connectionRows } from '../src/mesh-connections';

export default function ComputersScreen() {
  const state = useCompanion(), router = useRouter();
  const inventory = useResource<{ devices: Device[]; scope?: string }>('/api/intelligence/devices');
  const reports = useResource<{ reports: Report[] }>('/api/intelligence/diagnostics');
  if (!state.pairing) return <Redirect href="/pair" />;
  const computers = inventory.data?.devices.filter(d => d.kind === 'computer') || [];
  return <View style={{ flex: 1 }}><ConnectionNotice /><Screen><Section title="Computers" detail="Computers registered with your paired TLI host. Opening this roster runs no diagnostic or device action." />
    <Card><Label>Paired TLI host</Label><Copy weight="600">{state.bootstrap?.node.name || state.pairing.node_name}</Copy><Copy selectable muted>{state.pairing.origin}</Copy><Copy muted size={12}>Host identity: {state.pairing.node_id} · last connection check {formatTime(state.checkedAt)}</Copy><AIReadinessNotice /></Card>
    {state.bootstrap?.capabilities.connection_snapshots===true&&<MeshConnections/>}
    <Button secondary title="Refresh roster and saved reports" busy={inventory.busy || reports.busy} disabled={state.connection !== 'connected'} onPress={() => { void inventory.reload(); void reports.reload(); }} />
    {(inventory.error || reports.error) && <Notice error>{inventory.error || reports.error}</Notice>}
    {inventory.stale && inventory.data && <Notice>Previously read roster. Reconnect and refresh for current information.</Notice>}
    {computers.map(computer => <Card key={computer.id}><Label>{computer.node_id === state.pairing!.node_id ? 'TLI host' : 'Registered computer'}</Label><Copy size={23} weight="600">{computer.name}</Copy><Copy muted selectable size={12}>{computer.id} · node {computer.node_id}</Copy><Copy muted size={13}>Observed {computer.observed_at ? formatTime(computer.observed_at) : 'time unavailable'}. Registration alone does not confirm connectivity or an installed AI model.</Copy><Copy muted size={13}>Reported capabilities: unavailable in this inventory.</Copy><Button secondary title="Open computer details" onPress={() => router.push({ pathname: '/device/[id]', params: { id: computer.id } })} /><Button secondary title="Start Troubleshooting record" onPress={() => router.push({ pathname: '/cases', params: { computer: computer.id } })} />{reports.data?.reports.filter(r => r.target?.id === computer.id || !r.target && computer.node_id === state.pairing!.node_id).slice(0, 8).map(report => <Button key={report.id} secondary title={`${report.kind} · ${formatTime(report.created_at || report.checked_at)}`} onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })} />)}</Card>)}
    {!inventory.busy && inventory.data && !computers.length && <Notice>No computers were returned by this host.</Notice>}
    <Section title="Saved diagnostic reports" detail="These are saved observations. Opening one does not rerun it." />{reports.data?.reports.slice(0, 50).map(report => <Button key={report.id} secondary title={`${report.target?.name || report.host?.name || 'Target not recorded'} · ${report.kind} · ${formatTime(report.created_at || report.checked_at)}`} onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })} />)}
  </Screen></View>;
}

function MeshConnections(){
  const state=useCompanion(),result=useResource<unknown>('/api/lan/peers'),[now,setNow]=useState(Date.now);let rows:ReturnType<typeof connectionRows>=[],error='';
  useEffect(()=>{if(!state.foreground)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[state.foreground]);
  useEffect(()=>{if(!state.foreground||state.connection!=='connected'||result.busy)return;const timer=setInterval(()=>void result.reload(),5000);return()=>clearInterval(timer);},[state.foreground,state.connection,result.reload,result.busy]);
  if(result.data)try{rows=connectionRows(result.data,now);}catch(e){error=e instanceof Error?e.message:'Connection information unavailable.';}
  return <Card><Label>Saved and nearby connections</Label><Copy muted size={13}>Connection checks run on your home TLI. Review new sharing permissions on the computers.</Copy>
    {(result.error||error)&&<Notice error>{result.error||error}</Notice>}
    {result.stale&&<Notice>Previously read connection information. Reconnect and refresh for current status.</Notice>}
    {rows.map(peer=><View key={peer.id} style={{gap:4,marginVertical:8}}><Copy weight="600">{peer.name}</Copy><Copy>{result.stale?'Saved connection information':peer.state}</Copy><Copy muted size={13}>{peer.detail}</Copy>{!!peer.ready.length&&!result.stale&&<Copy muted size={13}>Ready: {peer.ready.join(' · ')}</Copy>}<Copy muted size={12}>Checked {formatTime(peer.checkedAt)}</Copy></View>)}
    <Button secondary title="Refresh connections" busy={result.busy} onPress={()=>void result.reload()}/>
  </Card>;
}
