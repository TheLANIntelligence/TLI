import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useCompanion, errorText } from './state';
import { Button, Card, Copy, IconButton, Notice, Row } from './ui';
import { outcome, formatTime } from './protocol';
import type { Device, Result, Scene } from './types';

export function Receipt({ result, at }: { result: Result; at?: string }) {
  return <Notice><Copy weight="600" size={15}>{outcome(result)}</Copy>{at && <Copy muted size={12}>{formatTime(at)}</Copy>}{(result.summary || result.error) && <Copy size={14}>{result.summary || result.error}</Copy>}{result.results?.map((row, index) => <Copy key={index} size={13}>{row.ok === true ? '✓' : '×'} {row.device_id || 'Device'} · {row.summary || row.error || row.capability || (row.ok ? 'Completed' : 'Failed')}</Copy>)}</Notice>;
}
export function SceneCard({ scene }: { scene: Scene }) {
  const { client, connection, foreground, preferences, savePreferences } = useCompanion();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<Result>(), [at, setAt] = useState<string>();
  const running = useRef(false);
  const favorite = preferences.favorite_scenes.includes(scene.scene_id);
  const run = async () => {
    if (!client || running.current) return;
    running.current = true;
    setBusy(true); setError(''); setResult(undefined);
    try { setResult(await client.json<Result>('/homepower/scenes/run', 'POST', { scene_id: scene.scene_id, dry_run: false })); setAt(new Date().toISOString()); }
    catch (error) { setError(`${errorText(error)} The outcome may be unknown. Check the devices before running this scene again.`); }
    finally { running.current = false; setBusy(false); }
  };
  return <Card><Row><View style={{ flex: 1 }}><Copy size={20} weight="600">{scene.name}</Copy>{scene.description && <Copy size={14} muted>{scene.description}</Copy>}</View><IconButton icon={favorite ? 'star' : 'star-outline'} label={`${favorite ? 'Remove' : 'Add'} ${scene.name} ${favorite ? 'from' : 'to'} favorites`} selected={favorite} disabled={connection !== 'connected'} onPress={() => void savePreferences({ favorite_scenes: favorite ? preferences.favorite_scenes.filter(id => id !== scene.scene_id) : [...preferences.favorite_scenes, scene.scene_id] }).catch(error => setError(errorText(error)))} /></Row><Button title={scene.enabled === false ? 'Scene disabled' : 'Run scene'} icon="play-outline" busy={busy} disabled={scene.enabled === false || connection !== 'connected' || !foreground} onPress={() => void run()} />{result && <Receipt result={result} at={at} />}{!!error && <Notice error>{error}</Notice>}</Card>;
}
export function DeviceCard({ device }: { device: Device }) {
  const router = useRouter(); const { preferences, savePreferences, connection } = useCompanion(); const favorite = preferences.favorite_devices.includes(device.id);
  const [error, setError] = useState('');
  return <Card><Row><View style={{ flex: 1 }}><Copy weight="600" size={18}>{device.name}</Copy><Copy muted size={13}>{device.room || 'No room assigned'} · {device.kind.replace('_', ' ')}</Copy></View><IconButton icon={favorite ? 'star' : 'star-outline'} label={`${favorite ? 'Remove' : 'Add'} ${device.name} ${favorite ? 'from' : 'to'} favorites`} selected={favorite} disabled={connection !== 'connected'} onPress={() => void savePreferences({ favorite_devices: favorite ? preferences.favorite_devices.filter(id => id !== device.id) : [...preferences.favorite_devices, device.id] }).catch(error => setError(errorText(error)))} /></Row><Button secondary title="View device" icon="chevron-forward" onPress={() => router.push({ pathname: '/device/[id]', params: { id: device.id } })} />{!!error && <Notice error>{error}</Notice>}</Card>;
}
