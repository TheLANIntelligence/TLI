import { useEffect, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useCompanion, errorText } from '../src/state';
import { AIReadinessNotice, Button, Card, Copy, Label, Notice, Screen, Section } from '../src/ui';
import { formatTime } from '../src/protocol';
import { privateNetworkPlan, PRIVATE_NETWORK_STEPS, PRIVATE_NETWORK_LINKS, PRIVATE_NETWORK_LIMIT } from '../src/remote-access';
import { ReleaseInfo } from '../src/release-info-view';

export default function SettingsScreen() {
  const state = useCompanion(), router = useRouter(); const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [showRemote, setShowRemote] = useState(false), refreshing = useRef<Promise<void> | null>(null);
  useEffect(() => { setShowRemote(false); }, [state.foreground, state.pairing?.device_id]);
  const checkConnection = () => { if (refreshing.current || !state.foreground || state.pairingPhase !== 'idle' || state.sending || state.client?.hasActiveMutations) return; refreshing.current = state.refresh().finally(() => { refreshing.current = null; }); };
  const plan = privateNetworkPlan(state.pairing?.origin || '');
  if (!state.pairing) return <Redirect href="/pair" />;
  return <Screen><Section title="A place in your home." detail="Your connection, your preferences." />
    <Card><Label>Paired with</Label><Copy size={25} weight="600">{state.bootstrap?.node.name || state.pairing.node_name}</Copy><Copy>{state.connection === 'connected' ? 'Paired host reached over verified HTTPS' : state.connection === 'checking' ? 'Checking connection…' : state.connectionProblem?.title || 'Connection check needed'}</Copy><Copy size={12} muted>Latest connection check started {formatTime(state.connectionAttemptAt)}</Copy><Copy size={12} muted>Last connected {formatTime(state.checkedAt)}</Copy><Copy size={13} muted selectable>{state.pairing.origin}</Copy><Button secondary title="Refresh connection and capabilities" busy={state.connection === 'checking'} disabled={state.pairingPhase !== 'idle' || !state.foreground || state.sending || state.client?.hasActiveMutations} onPress={checkConnection} />{!!state.connectionError && <Notice error>{state.connectionError}</Notice>}<Button secondary title="Review replacement pairing" icon="qr-code-outline" disabled={state.pairingPhase !== 'idle' || state.sending} onPress={() => router.push({ pathname: '/pair', params: { replace: '1' } })} /></Card>
    <Card><Label>Away from home · optional</Label><Copy muted>Use your existing pairing through an externally managed private network. Opening this guide makes no connection changes.</Copy><Button secondary title={showRemote ? 'Hide private network setup' : 'Show private network setup'} icon="globe-outline" onPress={() => setShowRemote(value => !value)} />
      {showRemote && state.foreground && <><Notice>{PRIVATE_NETWORK_LIMIT}</Notice><Copy muted>{plan.reason}</Copy>{plan.eligible && <><Label>Keep this pairing address</Label><Copy selectable>{plan.origin}</Copy><Copy selectable>Single-host route: {plan.route}</Copy><Copy>Allowed transport: TCP port {plan.port}</Copy></>}{PRIVATE_NETWORK_STEPS.map((step, index) => <Copy key={step} size={14}>{index + 1}. {step}</Copy>)}
        <Button title="Check this paired connection" busy={state.connection === 'checking'} disabled={!plan.eligible || state.pairingPhase !== 'idle' || state.sending || state.client?.hasActiveMutations} onPress={checkConnection} />
        <Copy size={13} muted>Last paired-host response: {formatTime(state.checkedAt)}. Host access and AI readiness are separate. This guide does not change or renew your TLS certificate.</Copy>
        <Copy size={13} muted>Remote traffic crosses the Internet through your chosen encrypted private network. Its account, route and gateway are managed outside TLI. Do not publish TLI through a public tunnel or disable certificate verification.</Copy>
        {PRIVATE_NETWORK_LINKS.map(link => <Button key={link.url} secondary title={link.title} onPress={() => void Linking.openURL(link.url).catch(() => setError('The setup reference could not be opened. Try again when ready.'))} />)}</>}
    </Card>
    <Card><Label>Keep useful work together</Label><Button secondary title="Notes & fixes" icon="book-outline" onPress={() => router.push('/notebook')} /><Button secondary title="Computers and reports" icon="desktop-outline" onPress={() => router.push('/computers')} /><Button secondary title="Troubleshooting" icon="construct-outline" onPress={() => router.push('/cases')} /></Card>
    <Card><AIReadinessNotice /></Card>
    <ReleaseInfo />
    <Card><Label>Appearance</Label>{(['system', 'light', 'dark'] as const).map(theme => <Button key={theme} title={`${state.preferences.theme === theme ? '✓ ' : ''}${theme === 'system' ? 'Match my phone' : theme === 'light' ? 'Light' : 'Dark'}`} secondary={state.preferences.theme !== theme} disabled={saving || state.connection !== 'connected'} onPress={() => { setSaving(true); setError(''); void state.savePreferences({ theme }).catch(error => setError(errorText(error))).finally(() => setSaving(false)); }} />)}</Card>
    <Card><Label>Notes & fixes</Label><Copy muted>Your private saved details and preferences. Choose which notes to attach to a question.</Copy><Button secondary title="Open Notes & fixes" icon="book-outline" onPress={() => router.push('/notebook')} /></Card>
    <Card><Label>Data & Recovery</Label><Copy muted>Check selected saved data on your TLI and read manual backup guidance. This phone is not a backup.</Copy><Button secondary title="Open Data & Recovery" icon="document-text-outline" onPress={() => router.push('/data-recovery')} /></Card>
    <Card><Label>When you need a hand</Label><Copy muted>At home, use a network that can reach the paired address and allow local network access in phone settings. Away from home, check your configured private-network route and keep the TLI host and gateway running. If the address or certificate changed, review a new desktop pairing code; this app never bypasses trust checks.</Copy><Button secondary title="Open phone settings" onPress={() => void Linking.openSettings()} /></Card>
    <Card><Label>Privacy, by design</Label><Copy muted>This phone stores its revocable credential in protected platform storage. Conversations and reports belong to your TLI owner account. Photo uploads use zero retention; preview files are removed after submission or removal. Commands and messages are never queued for later delivery.</Copy></Card>
    <Button secondary title="Forget this TLI" icon="unlink-outline" onPress={() => Alert.alert('Forget this TLI?', 'This removes the credential and conversation view from this phone. Revoke the phone in Phone Companion on TLI desktop to end its server access. You can pair again with a new code.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Forget TLI', style: 'destructive', onPress: () => void state.forget().catch(error => setError(errorText(error))) }])} />
    {!!error && <Notice error>{error}</Notice>}<Copy size={12} muted>TLI Companion · Private beta 0.1.0{ '\n' }One owner. One paired TLI installation.</Copy>
  </Screen>;
}
