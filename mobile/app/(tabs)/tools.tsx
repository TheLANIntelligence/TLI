import { useRouter } from 'expo-router';
import { useCompanion, useResource } from '../../src/state';
import { Button, Card, ConnectionNotice, Copy, Label, Notice, Screen, Section } from '../../src/ui';
import type { HostRun } from '../../src/workspace-model';

export default function ToolsScreen() {
  const router = useRouter(), state = useCompanion();
  return <Screen>
    <Section title="More from your TLI" detail="Create something, use connected tools, or manage your connection." />
    <ConnectionNotice />
    {state.workspaceNotice && <Notice>{state.workspaceNotice}</Notice>}
    <Card><Label>Create</Label><Button title="Build a small app" icon="code-slash-outline" onPress={() => router.push('/builder')} /><Copy muted size={14}>Describe an idea and continue working on the same saved app from your computer.</Copy></Card>
    {!!state.bootstrap?.capabilities.host_runs && <RecentWork />}
    <Card><Label>Your connected home</Label>
      <Button secondary title="Today and favorites" icon="sunny-outline" onPress={() => router.push('/today')} />
      <Button secondary title="Home and devices" icon="home-outline" onPress={() => router.push('/home')} />
      <Button secondary title="Computers and reports" icon="desktop-outline" onPress={() => router.push('/computers')} />
      <Button secondary title="Troubleshooting" icon="construct-outline" onPress={() => router.push('/cases')} />
    </Card>
    <Card><Label>Settings and saved data</Label>
      <Button secondary title="Connection and settings" icon="options-outline" onPress={() => router.push('/settings')} />
      <Button secondary title="Data & Recovery" icon="document-text-outline" onPress={() => router.push('/data-recovery')} />
    </Card>
  </Screen>;
}

function RecentWork() {
  const router = useRouter(), runs = useResource<{ runs: HostRun[] }>('/api/runs');
  return <Card><Label>Recent work on your TLI</Label>
    {runs.error && <Notice error>{runs.error}</Notice>}
    {runs.data?.runs.slice(0, 8).map(run => <Button key={run.id} secondary title={`${run.kind === 'chat' ? 'Answer' : 'App'} · ${run.status}`} onPress={() => run.kind === 'chat' ? router.push({ pathname: '/ask', params: { run: run.id } }) : router.push({ pathname: '/builder', params: { run: run.id } })} />)}
    {runs.data && !runs.data.runs.length && <Copy muted size={14}>Your accepted answers and app projects will appear here.</Copy>}
    <Button secondary title="Refresh saved work" busy={runs.busy} onPress={() => void runs.reload()} />
  </Card>;
}
