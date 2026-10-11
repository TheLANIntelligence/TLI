import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCompanion, useResource } from '../../src/state';
import { Button, Card, ConnectionNotice, Copy, Label, Notice, Screen } from '../../src/ui';
import { formatTime } from '../../src/protocol';
import type { Report } from '../../src/types';
import { ReportFacts } from '../../src/report-facts-view';

export default function ReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(), router = useRouter(); const { pairing } = useCompanion();
  const report = useResource<Report>(`/api/intelligence/diagnostics/${encodeURIComponent(id)}`);
  const data = report.data?.id === id ? report.data : undefined;
  if (!pairing) return <Redirect href="/pair" />;
  return <View style={{ flex: 1 }}><ConnectionNotice /><Screen>{data ? <><Label>Saved {data.kind} report</Label><ReportFacts value={data.recorded_facts} expected={{ reportId: id, hostId: data.host?.id ?? null, targetId: data.target?.id ?? null }} />{data.scope && <Notice>{data.scope}</Notice>}{data.recorded_facts === undefined && <><Notice>This older host did not provide a structured summary. Legacy check descriptions are shown below; completion, coverage and process identity are unknown.</Notice>{Array.isArray(data.checks) && data.checks.slice(0, 64).filter(c => c && typeof c.label === 'string' && typeof c.detail === 'string').map((check, i) => <Card key={i}><Copy weight="600">Recorded check · {check.label.slice(0, 240)}</Copy><Copy muted>{check.detail.slice(0, 1000)}</Copy></Card>)}</>}<Button secondary title="Link report to Troubleshooting" onPress={() => router.push({ pathname: '/cases', params: { kind: 'report', evidence: data.id } })} /><Button title="Discuss this report with TLI" icon="sparkles-outline" onPress={() => router.push({ pathname: '/ask', params: { report: data.id, target: data.target?.id, prompt: 'Explain this diagnostic report and what I should check next.' } })} /></> : <Notice>{report.error || 'Loading diagnostic evidence…'}</Notice>}{data && report.error && <Notice error>{report.error}</Notice>}</Screen></View>;
}
