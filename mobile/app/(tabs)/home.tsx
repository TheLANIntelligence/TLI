import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useResource } from '../../src/state';
import { Button, Hero, ConnectionNotice, Copy, Notice, Row, Screen, Section, useTheme } from '../../src/ui';
import { DeviceCard, SceneCard } from '../../src/home-ui';
import { formatTime } from '../../src/protocol';
import type { Device, Scene } from '../../src/types';

export default function HomeScreen() {
  const t = useTheme(); const [room, setRoom] = useState('All rooms');
  const inventory = useResource<{ devices: Device[] }>('/api/intelligence/devices');
  const scenes = useResource<{ scenes: Scene[] }>('/homepower/scenes');
  const rooms = ['All rooms', ...new Set(inventory.data?.devices.map(d => d.room || 'Unassigned') || [])];
  return <View style={{ flex: 1 }}><ConnectionNotice /><Screen refreshControl={<RefreshControl refreshing={inventory.busy || scenes.busy} onRefresh={() => { void inventory.reload(); void scenes.reload(); }} tintColor={t.emerald} />}>
    <Hero eyebrow="Your connected home" title="Make yourself comfortable." detail="Your rooms, devices, and familiar routines. Connected through your TLI." icon="home-outline" />
    <Copy size={12} muted>{inventory.checkedAt ? `${inventory.stale ? 'Out of date · ' : ''}Inventory checked ${formatTime(inventory.checkedAt)}` : 'Inventory has not been checked.'}</Copy>
    <Row style={{ flexWrap: 'wrap' }}>{rooms.map(value => <Button key={value} secondary={room !== value} title={value} onPress={() => setRoom(value)} />)}</Row>
    {rooms.filter(value => value !== 'All rooms' && (room === 'All rooms' || value === room)).map(value => <View key={value} style={{ gap: 14 }}><Row><Copy size={18} weight="600">{value}</Copy><View style={{ flex: 1, height: 1, backgroundColor: t.border }} /></Row>{(inventory.data?.devices || []).filter(device => (device.room || 'Unassigned') === value).map(device => <DeviceCard key={device.id} device={device} />)}</View>)}
    {inventory.data?.devices.length === 0 && <Notice>Add devices in your TLI desktop to see them here.</Notice>}
    <Section title="Scenes" detail="Run a familiar routine and see how each action went." />
    {scenes.data?.scenes.map(scene => <SceneCard key={scene.scene_id} scene={scene} />)}
    {scenes.data?.scenes.length === 0 && <Notice>Create a scene in Home Automation on your TLI desktop.</Notice>}
    {!!(inventory.error || scenes.error) && <Notice error>{inventory.error || scenes.error}</Notice>}
  </Screen></View>;
}
