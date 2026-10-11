import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Redirect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCompanion, errorText } from '../src/state';
import { Button, Card, Copy, Hero, Label, Notice, Screen, styles, useTheme } from '../src/ui';
import { parsePairingCode } from '../src/protocol';
import { takePairingLink } from '../src/pairing-link';
import type { PairingCode } from '../src/types';

export default function PairScreen() {
  const router = useRouter(), navigation = useNavigation(), params = useLocalSearchParams<{ replace?: string; incoming?: string }>();
  const state = useCompanion(); const t = useTheme(); const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false), [code, setCode] = useState<{ raw: string; value: PairingCode }>();
  const [manual, setManual] = useState(false), [bundle, setBundle] = useState('');
  const [name, setName] = useState(Platform.OS === 'ios' ? 'My iPhone' : 'My Android');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false); const scanned = useRef(false), pairingBusy = useRef(false);
  const replacing = (params.replace === '1' || !!params.incoming) && !!state.pairing;
  const reviewedLink = useRef('');
  const cancel = useRef(state.cancelPairing); cancel.current = state.cancelPairing;
  const pending = useRef(state.hasPendingPairing); pending.current = state.hasPendingPairing;
  useEffect(() => () => { cancel.current(); }, []);
  usePreventRemove(busy, ({ data }) => {
    if (!pending.current()) { navigation.dispatch(data.action); return; }
    setError(cancel.current() ? 'Stopping verification. Wait for the previous connection to be restored, then return.' : 'The reviewed connection is being saved securely. Wait for this write to finish.');
  });
  const scan = async () => {
    setError(''); scanned.current = false;
    const allowed = permission?.granted || (await requestPermission()).granted;
    if (scanned.current || pairingBusy.current) return;
    if (!allowed) { setError('Camera access is needed to scan your TLI pairing code. Allow it in your phone settings.'); return; }
    setScanning(true);
  };
  const read = (raw: string) => {
    if (scanned.current || pairingBusy.current) return;
    scanned.current = true; setScanning(false);
    try { setCode({ raw, value: parsePairingCode(raw) }); setBundle(''); setManual(false); setError(''); }
    catch (error) { setCode(undefined); setError(errorText(error)); }
  };
  useEffect(() => {
    const id = params.incoming;
    if (!id || reviewedLink.current === id) return;
    reviewedLink.current = id;
    const invitation = takePairingLink(id);
    if (pairingBusy.current || pending.current()) { setError('Finish the current verification, then open a fresh invitation. The active connection was kept.'); return; }
    setCode(undefined); setScanning(false); setBundle(''); setManual(false);
    if (!invitation.raw) { setError(invitation.error || 'Open a fresh pairing invitation.'); return; }
    scanned.current = false;
    read(invitation.raw);
  }, [params.incoming]);
  if (state.pairing && !replacing) return <Redirect href="/" />;
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}><Screen>
    <Hero eyebrow="TLI Companion" title={replacing ? 'Review a replacement connection.' : 'A little closer to home.'} detail={replacing ? 'Your current pairing stays selected until the new connection is verified and saved securely.' : 'Your home intelligence, wherever you are on your home Wi-Fi.'} icon="link-outline" />
    {replacing && <Card><Label>Current pairing</Label><Copy weight="600">{state.pairing!.node_name}</Copy><Copy muted selectable size={13}>{state.pairing!.origin}</Copy><Copy muted size={13}>Read a fresh code from the intended TLI desktop. Failed or cancelled verification keeps these credentials.</Copy></Card>}
    {scanning ? <Card><View style={{ height: 300, borderRadius: 18, overflow: 'hidden' }}><CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={event => read(event.data)} /></View><Copy size={14} muted>Point your camera at the code on the TLI Phone Companion page.</Copy><Button secondary title="Cancel scan" onPress={() => setScanning(false)} /></Card> : code ? <Card>
      <Label>Review before connecting</Label><Copy size={26} weight="600">{code.value.node_name}</Copy><Copy muted>Confirm this name and address on your TLI desktop. Opening or scanning the invitation has not paired this phone. Your phone will trust the certificate supplied by this code only after you choose to connect.</Copy>
      <Copy selectable muted size={13}>{code.value.origin}</Copy>
      {replacing && <Copy muted size={13}>{code.value.certificate_der === state.pairing!.certificate_der ? 'The supplied certificate matches the current pairing.' : 'This code supplies a different certificate. Confirm this change on the intended TLI desktop before continuing.'}{code.value.node_id !== state.pairing!.node_id ? ' This is a different TLI installation; its shared conversations and notes belong to its account.' : ''}</Copy>}
      <Copy size={14} weight="600">Name this phone</Copy><TextInput accessibilityLabel="Phone name" value={name} onChangeText={setName} maxLength={80} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.background }]} />
      <Button title={replacing ? 'Verify and replace connection' : 'Connect to my TLI'} icon="link-outline" busy={busy} disabled={!state.foreground} onPress={() => { if (pairingBusy.current) return; pairingBusy.current = true; setBusy(true); setError(''); void state.pair(code.raw, name).then(() => router.replace(replacing ? '/settings' : '/ask')).catch(error => setError(errorText(error))).finally(() => { pairingBusy.current = false; setBusy(false); }); }} />
      {busy && <><Copy muted size={13}>{state.pairingPhase === 'saving' ? 'Verification passed. Finishing the protected storage write; keep the app open.' : 'Verifying the reviewed host and owner access. Existing requests are paused.'}</Copy><Button secondary title={state.pairingPhase === 'saving' ? 'Finishing secure save…' : 'Cancel verification'} disabled={state.pairingPhase === 'saving'} onPress={() => { if (state.cancelPairing()) setError('Stopping verification. Wait for the previous connection to be restored.'); }} /></>}
      <Button secondary title="Scan another code" disabled={busy} onPress={() => { setCode(undefined); void scan(); }} />
    </Card> : <Card><Label>Make yourself at home</Label><Copy size={22} weight="600">Pair once. Stay connected.</Copy><Copy muted>1. Join the same Wi-Fi as your TLI desktop.{ '\n\n' }2. Open Home & network → Phone Companion on TLI.{ '\n\n' }3. Create a pairing code, then scan it here. Your normal camera can also open its local pairing page.</Copy><Button title="Scan pairing code" icon="qr-code-outline" onPress={() => void scan().catch(error => setError(errorText(error)))} /><Button secondary title={manual ? 'Hide manual entry' : 'Enter pairing bundle or link'} onPress={() => { setManual(value => !value); setBundle(''); }} />{manual && <><Copy muted size={13}>Paste the complete pairing bundle or link from your desktop. Both use the same certificate checks as scanning.</Copy><TextInput accessibilityLabel="Pairing bundle" multiline autoCapitalize="none" autoCorrect={false} value={bundle} onChangeText={setBundle} maxLength={18000} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.background, height: 120, textAlignVertical: 'top' }]} /><Button title="Review pairing" disabled={!bundle.trim()} onPress={() => { scanned.current = false; read(bundle.trim()); }} /></>}</Card>}
    {!!(error || state.connectionError) && <Notice error>{error || state.connectionError}</Notice>}
    {permission && !permission.granted && !permission.canAskAgain && <Button secondary title="Open phone settings" onPress={() => void Linking.openSettings()} />}
    {replacing && <Button secondary title="Keep current pairing and return" disabled={busy} onPress={() => router.back()} />}
    <Copy size={13} muted>Private beta · Connect on your home Wi-Fi.{ '\n' }Your conversations and photos travel directly to your paired TLI. Photos are sent only when you choose Send.</Copy>
  </Screen></SafeAreaView>;
}
