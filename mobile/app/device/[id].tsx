import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCompanion, useResource, errorText } from '../../src/state';
import { Button, Card, ConnectionNotice, Copy, Label, Notice, Screen, Section, useTheme } from '../../src/ui';
import { Receipt } from '../../src/home-ui';
import { formatTime } from '../../src/protocol';
import type { Device, PowerDevice, Report, Result } from '../../src/types';

export default function DeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); const { pairing } = useCompanion();
  const inventory = useResource<{ devices: Device[] }>('/api/intelligence/devices');
  if (!pairing) return <Redirect href="/pair" />;
  const device = inventory.data?.devices.find(d => d.id === id);
  return <View style={{ flex: 1 }}><ConnectionNotice /><Screen>{device ? <Details key={device.id} device={device} /> : <><Notice>{inventory.error || (inventory.busy ? 'Looking up this device…' : 'This device is no longer registered with TLI.')}</Notice><Button secondary title="Refresh devices" onPress={() => void inventory.reload()} /></>}</Screen></View>;
}

function Details({ device }: { device: Device }) {
  const router = useRouter(); const { client, connection, foreground } = useCompanion();
  const reports = useResource<{ reports: Report[] }>('/api/intelligence/diagnostics');
  const [checking, setChecking] = useState(false), [error, setError] = useState('');
  const history = reports.data?.reports.filter(report => report.target?.id === device.id) || [];
  return <><Stack.Screen options={{ title: device.name }} /><Label>{device.room || 'Your home'} · {device.kind.replace('_', ' ')}</Label><Copy size={32} weight="600">{device.name}</Copy>
    {device.source === 'homepower' ? <Controls device={device} /> : <Card><Copy muted>{device.status === undefined || device.status === null ? 'No current status reading is available for this device.' : `Last reported status: ${typeof device.status === 'string' ? device.status : JSON.stringify(device.status)}`}</Copy><Copy size={12} muted>{device.observed_at ? `Observed ${formatTime(device.observed_at)}. This saved reading may be out of date.` : 'No observation time is available.'}</Copy></Card>}
    <Button title="Ask TLI about this device" icon="sparkles-outline" onPress={() => router.push({ pathname: '/ask', params: { target: device.id, ...(history[0] ? { report: history[0].id } : {}), prompt: `Help me with ${device.name}.` } })} />
    <Section title="Diagnostic evidence" detail="Read-only checks from your TLI host." />
    <Button secondary title="Run device checks" icon="pulse-outline" busy={checking} disabled={connection !== 'connected' || !foreground} onPress={() => {
      if (!client) return; setChecking(true); setError('');
      void client.json<Report>('/api/intelligence/diagnostics', 'POST', { kind: 'device', target_id: device.id, internet: false }).then(report => { router.push({ pathname: '/report/[id]', params: { id: report.id } }); void reports.reload(); }).catch(error => setError(errorText(error))).finally(() => setChecking(false));
    }} />
    {history.slice(0, 5).map(report => <Card key={report.id}><Copy weight="600">Device check · {formatTime(report.created_at || report.checked_at)}</Copy><Copy muted size={14}>{report.checks.filter(c => c.status === 'pass').length} of {report.checks.length} checks passed</Copy><Button secondary title="View report" onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })} /></Card>)}
    {!history.length && <Copy muted>No saved device checks yet. You can also attach a photo in Ask TLI.</Copy>}{!!(error || reports.error) && <Notice error>{error || reports.error}</Notice>}
  </>;
}

function Controls({ device }: { device: Device }) {
  const t = useTheme(); const { client, connection, foreground } = useCompanion(); const registry = useResource<{ devices: PowerDevice[] }>('/homepower/devices');
  // Canonical intelligence IDs are not the HomePower IDs accepted by drivers.
  const sourceId = device.source_id;
  const status = useResource<Result>(`/homepower/devices/${encodeURIComponent(sourceId)}/status`);
  const capabilities = registry.data?.devices.find(d => d.device_id === sourceId)?.capabilities || [];
  const [busy, setBusy] = useState(false), [result, setResult] = useState<Result>(), [error, setError] = useState(''), [at, setAt] = useState<string>();
  const running = useRef(false);
  const [expired, setExpired] = useState(true);
  useEffect(() => {
    const until = status.checkedAt ? Date.parse(status.checkedAt) + 60_000 - Date.now() : 0;
    setExpired(!Number.isFinite(until) || until <= 0);
    if (!Number.isFinite(until) || until <= 0) return;
    const timer = setTimeout(() => setExpired(true), until);
    return () => clearTimeout(timer);
  }, [status.checkedAt]);
  const fresh = !expired && !status.stale && !status.busy && !busy && !error && status.data?.ok === true && typeof status.data?.on === 'boolean';
  const illuminated = fresh && status.data?.on === true;
  const execute = async (capability: string) => {
    if (!client || running.current) return; running.current = true; setBusy(true); setError(''); setResult(undefined);
    try { setResult(await client.json<Result>(`/homepower/devices/${encodeURIComponent(sourceId)}/execute`, 'POST', { capability })); setAt(new Date().toISOString()); await status.reload(); }
    catch (error) { setError(`${errorText(error)} The action outcome is unknown. Refresh the device status before trying again.`); }
    finally { running.current = false; setBusy(false); }
  };
  return <Card variant={illuminated ? 'hero' : undefined}><Copy size={12} weight="700" style={{ color: illuminated ? t.heroMuted : t.muted, letterSpacing: 1.5 }}>DEVICE STATUS</Copy><Copy size={28} weight="600" style={{ color: illuminated ? t.heroText : t.text }}>{busy ? 'Updating device…' : status.busy ? 'Checking device…' : fresh ? status.data!.on ? 'On · verified' : 'Off · verified' : 'State needs checking'}</Copy><Copy style={{ color: illuminated ? t.heroMuted : t.muted }}>{status.data?.summary || status.data?.error || 'Status unavailable'}</Copy><Copy size={12} style={{ color: illuminated ? t.heroMuted : t.muted }}>{status.checkedAt ? `${!fresh ? 'Earlier reading · ' : ''}Checked ${formatTime(status.checkedAt)}` : 'No status observation yet.'}</Copy>
    {(['switch.on', 'switch.off'] as const).filter(cap => capabilities.includes(cap)).map(cap => <Button key={cap} secondary={cap === 'switch.off'} title={cap === 'switch.on' ? 'Turn on' : 'Turn off'} icon="power-outline" disabled={connection !== 'connected' || !foreground || busy} onPress={() => void execute(cap)} />)}
    {!capabilities.some(cap => cap === 'switch.on' || cap === 'switch.off') && <Copy muted size={14}>Switch controls are unavailable for this device.</Copy>}
    <Button secondary title="Refresh status" busy={status.busy} onPress={() => void status.reload()} />
    {result && <Receipt result={result} at={at} />}{!!(error || status.error || registry.error) && <Notice error>{error || status.error || registry.error}</Notice>}
  </Card>;
}
