import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, useRouter } from 'expo-router';
import { useCompanion, errorText } from '../src/state';
import { AIReadinessNotice, Button, Card, Copy, IconButton, Label, Notice, Row, Screen, Section, useTheme } from '../src/ui';
import { useAppearance } from '../src/appearance';
import { PALETTES, paletteById, type PaletteId, type Theme } from '../src/theme';
import { formatTime } from '../src/protocol';
import { privateNetworkPlan, PRIVATE_NETWORK_STEPS, PRIVATE_NETWORK_LINKS, PRIVATE_NETWORK_LIMIT } from '../src/remote-access';
import { ReleaseInfo } from '../src/release-info-view';
import { HostStartCard } from '../src/host-start-view';

export default function SettingsScreen() {
  const state = useCompanion(), router = useRouter(); const [error, setError] = useState('');
  const [showRemote, setShowRemote] = useState(false), [advanced, setAdvanced] = useState(false), [connectionDetails, setConnectionDetails] = useState(false);
  const refreshing = useRef<Promise<void> | null>(null);
  useEffect(() => { setShowRemote(false); setAdvanced(false); setConnectionDetails(false); }, [state.foreground, state.pairing?.device_id]);
  const checkConnection = () => { if (refreshing.current || !state.foreground || state.pairingPhase !== 'idle' || state.sending || state.client?.hasActiveMutations) return; refreshing.current = state.refresh().finally(() => { refreshing.current = null; }); };
  const plan = privateNetworkPlan(state.pairing?.origin || '');
  if (!state.pairing) return <Redirect href="/pair" />;
  return <Screen><Section title="Connection and settings" detail="Your TLI computer, app updates and preferences." />
    <Card><Label>Your computer</Label><Copy size={25} weight="600">{state.bootstrap?.node.name || state.pairing.node_name}</Copy>
      <Copy>{state.connection === 'connected' && state.foreground ? 'Connected securely' : state.connection === 'checking' ? 'Checking connection…' : state.connectionProblem?.title || 'Connection check needed'}</Copy>
      {!!state.connectionError && <Notice error>{state.connectionError}</Notice>}
      <Copy muted size={13}>Use your home Wi-Fi and keep TLI running on this computer. Conversations stay saved there when the phone disconnects.</Copy>
      <Button secondary title="Check connection" busy={state.connection === 'checking'} disabled={state.pairingPhase !== 'idle' || !state.foreground || state.sending || state.client?.hasActiveMutations} onPress={checkConnection} />
      {state.connectionProblem?.kind === 'permission' && <Button secondary title="Open phone settings" onPress={() => void Linking.openSettings()} />}
      <Button secondary title="Scan a new connection code" icon="qr-code-outline" disabled={state.pairingPhase !== 'idle' || state.sending} onPress={() => router.push({ pathname: '/pair', params: { replace: '1' } })} />
      <Button secondary title={connectionDetails ? 'Hide connection details' : 'Connection details'} onPress={() => setConnectionDetails(value => !value)} />
      {connectionDetails && <><Copy size={12} muted>Latest check started {formatTime(state.connectionAttemptAt)}</Copy><Copy size={12} muted>Last connected {formatTime(state.checkedAt)}</Copy><Copy size={13} muted selectable>{state.pairing.origin}</Copy><AIReadinessNotice /></>}
    </Card>
    <ReleaseInfo />
    <AppearanceSettings />
    <Card><Label>Advanced connection</Label><Copy muted size={13}>Optional computer-start and externally managed network settings.</Copy><Button secondary title={advanced ? 'Hide advanced connection' : 'Advanced connection options'} onPress={() => setAdvanced(value => !value)} /></Card>
    {advanced && <><HostStartCard />
      <Card><Label>Existing private-network setup</Label><Copy muted>This beta is designed for home Wi-Fi. An existing external private-network setup can use the saved connection; this guide does not configure remote access.</Copy><Button secondary title={showRemote ? 'Hide private network setup' : 'Show private network setup'} icon="globe-outline" onPress={() => setShowRemote(value => !value)} />
        {showRemote && state.foreground && <><Notice>{PRIVATE_NETWORK_LIMIT}</Notice><Copy muted>{plan.reason}</Copy>{plan.eligible && <><Label>Keep this pairing address</Label><Copy selectable>{plan.origin}</Copy><Copy selectable>Single-host route: {plan.route}</Copy><Copy>Allowed transport: TCP port {plan.port}</Copy></>}{PRIVATE_NETWORK_STEPS.map((step, index) => <Copy key={step} size={14}>{index + 1}. {step}</Copy>)}
          <Button title="Check this paired connection" busy={state.connection === 'checking'} disabled={!plan.eligible || state.pairingPhase !== 'idle' || state.sending || state.client?.hasActiveMutations} onPress={checkConnection} />
          <Copy size={13} muted>Last paired-host response: {formatTime(state.checkedAt)}. Host access and AI readiness are separate. This guide does not change or renew your TLS certificate.</Copy>
          <Copy size={13} muted>Remote traffic crosses the Internet through your chosen encrypted private network. Its account, route and gateway are managed outside TLI. Do not publish TLI through a public tunnel or disable certificate verification.</Copy>
          {PRIVATE_NETWORK_LINKS.map(link => <Button key={link.url} secondary title={link.title} onPress={() => void Linking.openURL(link.url).catch(() => setError('The setup reference could not be opened. Try again when ready.'))} />)}</>}
      </Card>
    </>}
    <Card><Label>Privacy</Label><Copy muted size={13}>The phone keeps its connection credential in protected storage. Your conversations and notes belong to your TLI account. Photos are sent only after review and Send, with no image retention. Messages and commands are never queued for later delivery.</Copy><Copy muted size={13}>Keyboard dictation is provided by your keyboard app and follows its privacy settings. Review the text before sending it to TLI.</Copy></Card>
    <Button secondary title="Forget this TLI" icon="unlink-outline" onPress={() => Alert.alert('Forget this TLI?', 'This removes the saved connection and conversation view from this phone. To end its access on the computer, remove the phone from Connect phone in TLI. You can connect again with a new code.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Forget TLI', style: 'destructive', onPress: () => void state.forget().catch(error => setError(errorText(error))) }])} />
    {!!error && <Notice error>{error}</Notice>}
  </Screen>;
}
function PalettePreview({ theme }: { theme: Theme }) {
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ backgroundColor: theme.background, height: 86, borderRadius: 12, overflow: 'hidden', flexDirection: 'row', borderWidth: 1, borderColor: theme.border }}>
    <View style={{ width: 22, backgroundColor: theme.nav, padding: 6, gap: 5 }}><View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: theme.glow }} /><View style={{ width: 10, height: 3, borderRadius: 2, backgroundColor: theme.navMuted }} /></View>
    <View style={{ padding: 8, gap: 6, flex: 1 }}><View style={{ backgroundColor: theme.hero, borderRadius: 7, padding: 9, gap: 5 }}><View style={{ height: 4, borderRadius: 2, width: '65%', backgroundColor: theme.heroText }} /><View style={{ height: 3, borderRadius: 2, width: '86%', backgroundColor: theme.heroMuted }} /></View><View style={{ flexDirection: 'row', gap: 5 }}><View style={{ flex: 1, height: 17, borderRadius: 5, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }} /><View style={{ width: 27, height: 17, borderRadius: 5, backgroundColor: theme.accent }} /></View></View>
  </View>;
}

function AppearanceSettings() {
  const appearance = useAppearance(), t = useTheme();
  const [open, setOpen] = useState(false), [filter, setFilter] = useState<'all' | 'light' | 'dark'>('all');
  const disabled = !appearance.loaded || appearance.saving;
  const selected = paletteById(appearance.preference.palette), followsSystem = appearance.preference.mode === 'system';
  const choices = PALETTES.filter(palette => filter === 'all' || palette.dark === (filter === 'dark'));
  const choose = (id: PaletteId) => { void appearance.selectPalette(id); };
  return <Card><Label>Appearance</Label><Row style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}><View style={{ flex: 1, gap: 4 }}><Copy size={22} weight="600">{t.name}</Copy><Copy size={13} muted>{followsSystem ? `Following your phone · saved palette: ${selected.name}` : 'Your colors, throughout TLI.'}</Copy></View><Ionicons name="color-palette-outline" size={26} color={t.accent} /></Row><PalettePreview theme={t} />
    <Row style={{ justifyContent: 'space-between' }}><View style={{ flex: 1, gap: 4 }}><Copy weight="600">Match my phone</Copy><Copy size={12} muted>Emerald Light by day, Midnight in dark mode. Your chosen palette stays saved.</Copy></View><Switch accessibilityLabel="Match my phone appearance" value={followsSystem} disabled={disabled} trackColor={{ false: t.borderStrong, true: t.accent }} thumbColor={followsSystem ? t.contrast : t.card} onValueChange={enabled => { void appearance.followSystem(enabled); }} /></Row>
    <Button secondary title="Choose a theme" icon="color-palette-outline" disabled={!appearance.loaded} onPress={() => { setFilter('all'); setOpen(true); }} />
    <Copy size={12} muted>23 palettes · saved on this phone · available offline</Copy>{!!appearance.error && <Notice error>{appearance.error}</Notice>}
    <Modal visible={open} animationType="none" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}><SafeAreaView style={{ flex: 1, backgroundColor: t.background }}><Screen>
      <Row style={{ justifyContent: 'space-between' }}><View style={{ flex: 1 }}><Section title="Make TLI yours" detail="Color with a little more character." /></View><IconButton icon="close-outline" label="Close appearance" onPress={() => setOpen(false)} /></Row>
      <Copy muted size={13}>Choose a palette to stop following your phone. Appearance changes keep your current work in place.</Copy>
      <Row style={{ gap: 8 }}>{(['all', 'light', 'dark'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: filter === value }} accessibilityLabel={`${value === 'all' ? 'All' : value === 'light' ? 'Light' : 'Dark'} themes`} onPress={() => setFilter(value)} style={{ flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: filter === value ? t.accent : t.card, borderWidth: 1, borderColor: filter === value ? t.accent : t.border }}><Copy size={14} weight="600" style={{ color: filter === value ? t.contrast : t.text }}>{value === 'all' ? 'All' : value === 'light' ? 'Light' : 'Dark'}</Copy></Pressable>)}</Row>
      {!!appearance.error && <Notice error>{appearance.error}</Notice>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{choices.map(palette => {
        const active = !followsSystem && selected.id === palette.id, theme = paletteById(palette.id);
        return <Pressable key={palette.id} accessibilityRole="button" accessibilityLabel={`${palette.name}, ${palette.dark ? 'dark' : 'light'} theme`} accessibilityState={{ selected: active, disabled, busy: appearance.saving }} disabled={disabled} onPress={() => choose(palette.id)} style={({ pressed }) => ({ flexGrow: 1, flexBasis: '44%', minWidth: 112, maxWidth: '100%', gap: 10, padding: 10, borderWidth: active ? 2 : 1, borderColor: active ? t.accent : t.border, borderRadius: 17, backgroundColor: t.card, opacity: pressed ? 0.8 : 1 })}><PalettePreview theme={theme} /><Row style={{ gap: 5 }}><Copy size={13} weight="600" style={{ flex: 1 }}>{palette.name}</Copy>{active && <Ionicons name="checkmark-circle" size={18} color={t.accent} />}</Row></Pressable>;
      })}</View>
      <Button title="Done" onPress={() => setOpen(false)} />
    </Screen></SafeAreaView></Modal>
  </Card>;
}

