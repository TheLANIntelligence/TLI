import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorText, useCompanion } from './state';
import { Button, Card, Copy, IconButton, Label, Notice, Row, Screen, Section, styles, useTheme } from './ui';
import { imageTasks } from './screenshot-help';
import { formatTime } from './protocol';
import type { ImageTask, Photo, ScreenshotReview } from './types';

export function useImageReview(photo?: Photo) {
  const { client, connection, foreground } = useCompanion();
  const [snapshot, setSnapshot] = useState<{ client: typeof client; photo: Photo; data: ScreenshotReview }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const epoch = useRef(0);
  const reload = useCallback(async () => {
    const token = ++epoch.current; setSnapshot(undefined); setError('');
    if (!photo || !client || connection !== 'connected' || !foreground) { setBusy(false); return; }
    setBusy(true);
    try {
      const data = await client.json<ScreenshotReview>('/api/intelligence/screenshots/context');
      if (token === epoch.current) setSnapshot({ client, photo, data });
    } catch (error) {
      if (token === epoch.current) setError(`Could not review the AI destination. ${errorText(error)}`);
    } finally { if (token === epoch.current) setBusy(false); }
  }, [photo, client, connection, foreground]);
  useEffect(() => { void reload(); return () => { ++epoch.current; }; }, [reload]);
  // A previous phone session or attachment cannot authorize this upload.
  return { data: snapshot?.client === client && snapshot.photo === photo ? snapshot.data : undefined, busy, error, reload };
}

type Props = {
  photo: Photo; open: boolean; onClose: () => void; disabled: boolean;
  review: ReturnType<typeof useImageReview>; task: ImageTask; setTask: (task: ImageTask) => void;
  computer: string; setComputer: (id: string) => void; other: string; setOther: (name: string) => void;
  reportId?: string; clearReport: () => void;
};

export function ImageDestination({ review }: { review: ReturnType<typeof useImageReview> }) {
  const provider = review.data?.provider;
  if (review.busy) return <Copy size={13} muted>Checking the photo’s AI destination…</Copy>;
  if (review.error || !provider) return <Notice error>{review.error || review.data?.reason || 'Photo destination has not been checked.'}</Notice>;
  return <View style={{ gap: 4 }}><Copy size={13} weight="600">Send to {provider.provider} · {provider.model}</Copy><Copy size={12} muted>On {provider.destination}{provider.port ? `:${provider.port}` : ''} · checked {formatTime(review.data?.checked_at)}</Copy></View>;
}

export function PhotoReview({ photo, open, onClose, disabled, review, task, setTask, computer, setComputer, other, setOther, reportId, clearReport }: Props) {
  const t = useTheme();
  const choice = (label: string, selected: boolean, choose: () => void, key = label) => <Pressable key={key} accessibilityRole="radio" accessibilityLabel={label} aria-checked={selected} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={choose} style={{ minHeight: 48, padding: 13, borderRadius: 14, borderWidth: selected ? 2 : 1, borderColor: selected ? t.emerald : t.border, backgroundColor: selected ? t.soft : t.card }}><Copy size={15} weight={selected ? '600' : '400'}>{selected ? '✓ ' : ''}{label}</Copy></Pressable>;
  return <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, backgroundColor: t.background }}><Screen contentContainerStyle={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}>
    <Row style={{ justifyContent: 'space-between' }}><Section title="Review your image" /><IconButton icon="close-outline" label="Close image review" onPress={onClose} /></Row>
    <Image source={{ uri: photo.uri }} resizeMode="contain" style={{ width: '100%', aspectRatio: photo.width / photo.height, maxHeight: 440, backgroundColor: t.soft, borderRadius: 14 }} accessibilityLabel="Full image preview before sending" />
    <Copy size={14} muted>This image is sent only when you press Send. TLI keeps no image copy; your AI provider may have its own retention settings. Check for private details before sharing.</Copy>
    <Card><Label>AI destination</Label><ImageDestination review={review} />{review.data?.provider?.note && <Copy size={13} muted>{review.data.provider.note}</Copy>}<Button secondary title="Recheck AI destination" busy={review.busy} disabled={disabled} onPress={() => void review.reload()} /></Card>
    <Section title="What kind of help?" />
    {imageTasks.map(item => choice(item.label, task === item.id, () => setTask(item.id)))}
    {task !== 'photo' && <>
      <Section title="Computer shown" detail="Your selection identifies the screenshot’s subject. The phone and the TLI host may be different computers." />
      {choice('Unknown computer', computer === 'unknown', () => setComputer('unknown'))}
      {review.data?.computers.map(item => choice(`${item.name}${item.node_id === review.data?.host.id ? ' · TLI host' : ''}${review.data!.computers.filter(peer => peer.name === item.name).length > 1 ? ` · ${item.id}` : ''}`, computer === item.id, () => setComputer(item.id), item.id))}
      {choice('Another computer', computer === 'other', () => setComputer('other'))}
      {computer === 'other' && <TextInput accessibilityLabel="Name of computer shown" placeholder="Computer name" maxLength={120} editable={!disabled} value={other} onChangeText={setOther} style={[styles.input, { color: t.text, backgroundColor: t.card, borderColor: t.border }]} placeholderTextColor={t.muted} />}
      <Copy size={14} muted>Guidance uses this snapshot. It cannot watch your screen, click controls or run repairs. Attach the next screen after taking a step.</Copy>
    </>}
    {reportId && <Card><Copy size={14}>A saved diagnostic is attached. Screenshot guidance can use it only when it measures the computer selected above.</Copy><Button secondary title="Remove attached diagnostic" disabled={disabled} onPress={clearReport} /></Card>}
    <Button title="Done reviewing" onPress={onClose} />
  </Screen></SafeAreaView></Modal>;
}
