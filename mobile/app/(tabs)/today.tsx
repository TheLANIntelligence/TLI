import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useCompanion, useResource, errorText } from '../../src/state';
import { Button, Card, Hero, ConnectionNotice, Copy, Label, Notice, Row, Screen, Section, useTheme } from '../../src/ui';
import { SceneCard, DeviceCard } from '../../src/home-ui';
import { formatTime } from '../../src/protocol';
import type { Activity, ActivitySummary, Device, Scene } from '../../src/types';

export default function TodayScreen() {
  const t = useTheme(), router = useRouter(); const { client, preferences, connection } = useCompanion();
  const activity = useResource<ActivitySummary>('/dashboard/activity-summary');
  const inventory = useResource<{ devices: Device[] }>('/api/intelligence/devices');
  const scenes = useResource<{ scenes: Scene[] }>('/homepower/scenes');
  const [reviewing, setReviewing] = useState(false), [error, setError] = useState('');
  const favorites = inventory.data?.devices.filter(d => preferences.favorite_devices.includes(d.id)) || [];
  const favoriteScenes = scenes.data?.scenes.filter(s => preferences.favorite_scenes.includes(s.scene_id)) || [];
  const openActivity = (event: Activity) => {
    const detail = activity.data?.events.find(e => e.sequence === event.sequence) || event;
    const target = detail.actions?.find(a => a.target_id || a.device_id || a.conversation_id);
    if (target?.conversation_id) router.push({ pathname: '/ask', params: { conversation: target.conversation_id } });
    else if (target && inventory.data?.devices.some(d => d.id === (target.target_id || target.device_id))) router.push({ pathname: '/device/[id]', params: { id: (target.target_id || target.device_id)! } });
    else router.push({ pathname: '/ask', params: { prompt: `Help me understand this TLI update from ${formatTime(event.ts)}: ${event.title}. ${event.body || ''}` } });
  };
  return <View style={{ flex: 1 }}><ConnectionNotice /><Screen refreshControl={<RefreshControl refreshing={activity.busy} onRefresh={() => { void activity.reload(); void inventory.reload(); void scenes.reload(); }} tintColor={t.emerald} />}>
    <View style={{ gap: 6 }}><Label>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</Label><Copy size={26} weight="600">Today at your TLI</Copy><Copy muted size={15}>Saved activity, favorites and useful work.</Copy></View>
    <Hero eyebrow="Since your last review" title={activity.data ? activity.data.warning_count ? `${activity.data.warning_count} ${activity.data.warning_count === 1 ? 'update' : 'updates'} may need your attention.` : 'You’re caught up on warnings.' : 'Your TLI, at a glance.'} detail={activity.data ? activity.data.warning_count ? 'Review the recorded activity below when you’re ready.' : 'No warnings in the retained activity.' : 'Waiting for the latest activity from TLI.'} icon="pulse-outline">
      <Row style={{ alignItems: 'baseline', flexWrap: 'wrap' }}><Copy size={40} weight="600" tone="hero">{activity.data?.total ?? '—'}</Copy><Copy size={14} tone="heroMuted">recorded updates</Copy></Row><Copy size={12} tone="heroMuted">{activity.data ? `${activity.stale ? 'Out of date · ' : ''}Checked ${formatTime(activity.data.checked_at)}` : 'Status has not been checked.'}</Copy>
    </Hero>
    <Card><Label>Keep useful work together</Label><Button secondary title="Notes & fixes" icon="book-outline" onPress={() => router.push('/notebook')} /><Button secondary title="Computers and reports" icon="desktop-outline" onPress={() => router.push('/computers')} /><Button secondary title="Troubleshooting" icon="construct-outline" onPress={() => router.push('/cases')} /></Card>
    <Button title="Show TLI what you see" icon="camera-outline" onPress={() => router.push({ pathname: '/ask', params: { photo: 'choose' } })} />
    <Section title="Your favorites" detail="The things you reach for most." />
    {favoriteScenes.map(scene => <SceneCard key={scene.scene_id} scene={scene} />)}
    {favorites.map(device => <DeviceCard key={device.id} device={device} />)}
    {!favorites.length && !favoriteScenes.length && <Card><Copy muted>Star a device or scene in Home to keep it here.</Copy><Button secondary title="Explore Home" icon="home-outline" onPress={() => router.push('/home')} /></Card>}
    <Section title="Worth a look" />
    {activity.data?.groups.map(event => <Card key={event.sequence}><Label>{event.level === 'warn' || event.level === 'error' || event.level === 'critical' ? 'Needs attention' : event.category || 'Home update'}</Label><Copy size={20} weight="600">{event.title}</Copy>{!!event.body && <Copy muted size={15}>{event.body}</Copy>}<Copy size={12} muted>{formatTime(event.ts)}{(event.count || 0) > 1 ? ` · ${event.count} similar updates` : ''}</Copy><Button secondary title="Explore this update" onPress={() => openActivity(event)} /></Card>)}
    {activity.data && !activity.data.groups.length && <Copy muted>You’re caught up with the activity TLI has retained.</Copy>}
    {activity.data && <><Notice>{activity.data.coverage_note}</Notice><Button secondary title="Mark this activity reviewed" busy={reviewing} disabled={connection !== 'connected'} onPress={() => { if (!client || !activity.data) return; setReviewing(true); setError(''); void client.json('/dashboard/activity-summary/review', 'POST', activity.data.cursor).then(() => activity.reload()).catch(error => setError(errorText(error))).finally(() => setReviewing(false)); }} /></>}
    {!!(error || activity.error || inventory.error || scenes.error) && <Notice error>{error || activity.error || inventory.error || scenes.error}</Notice>}
  </Screen></View>;
}
