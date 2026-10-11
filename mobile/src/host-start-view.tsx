import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import NativeTransport from '../modules/tli-transport/index';
import { useCompanion, pairingStore } from './state';
import { HostStartController, type HelperTransport, type HostStartView } from './host-start';
import { Button, Card, Copy, Label, Notice } from './ui';
import { formatTime } from './protocol';

export function HostStartCard() {
  const state = useCompanion(), latest = useRef(state); latest.current = state;
  const [view, setView] = useState<HostStartView>({ phase: 'unconfigured', detail: 'Loading saved Host Start setup…', configured: false });
  const controller = useRef<HostStartController | undefined>(undefined);
  const supported = Platform.OS !== 'web' && typeof (NativeTransport as unknown as Partial<HelperTransport>).requestHelper === 'function';
  useEffect(() => {
    if (!state.pairing || !state.client || !supported) return;
    const pairing = state.pairing;
    const control = new HostStartController({ pairing, api: state.client, transport: NativeTransport as unknown as HelperTransport, store: pairingStore,
      current: () => latest.current.isCurrentPairing(pairing) && AppState.currentState === 'active', publish: setView });
    controller.current = control; void control.load();
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') control.suspend(); });
    return () => { control.suspend(); controller.current = undefined; subscription.remove(); };
  }, [state.pairing, state.client, supported]);
  const busy = ['reviewing', 'saving', 'checking'].includes(view.phase) || view.phase === 'starting' && !view.checkedAt;
  const ready = view.phase === 'running' && state.foreground && state.connection === 'connected' && !!state.checkedAt && !!view.checkedAt && Date.parse(state.checkedAt) >= Date.parse(view.checkedAt);
  const disabled = !state.foreground || state.pairingPhase !== 'idle' || state.sending || !!state.client?.hasActiveMutations || busy;
  if (!supported) return <Card><Label>Start TLI from your phone</Label><Copy muted>{Platform.OS === 'web' ? 'Host Start is available in a compatible installed Companion app. This preview does not contact a helper.' : 'This Companion build does not include the independent Host Start connection. Install a compatible client release before enabling it.'}</Copy><Copy muted>On the computer, open Phone Companion → Start TLI from your phone to review setup. The computer must remain awake and signed in.</Copy></Card>;
  return <Card><Label>Start TLI from your phone</Label><Copy muted>A separate, verified helper can start TLI while the computer is awake and its user is signed in. It cannot wake or power on the computer.</Copy>
    <Notice error={['error', 'unreachable'].includes(view.phase)}>{ready ? 'TLI is ready on this phone: the paired main connection was verified. AI readiness is shown separately below.' : view.detail}</Notice>
    {!!view.origin && <Copy size={12} selectable>Saved helper: {view.origin}</Copy>}
    {!!view.checkedAt && <Copy muted size={12}>Helper checked {formatTime(view.checkedAt)}. This is not a continuing availability check.</Copy>}
    {view.phase === 'review' && view.review ? <><Copy weight="600">Review this connection</Copy><Copy selectable>{view.review.origin}</Copy><Copy size={12} selectable>Computer: {view.review.node_id}{'\n'}Helper: {view.review.helper_id}{'\n'}Certificate fingerprint: {view.review.certificate_sha256}</Copy><Copy muted>The helper uses this pairing’s existing certificate. A separate start-only credential will be kept in protected phone storage. Your main TLI connection stays unchanged.</Copy><Button title="Allow Host Start on this phone" disabled={disabled} onPress={() => void controller.current?.allow()} /><Button secondary title="Cancel review" disabled={busy} onPress={() => controller.current?.cancelReview()} /></> : <>
      {view.configured && <Button secondary title="Check helper status" busy={view.phase === 'checking'} disabled={disabled} onPress={() => void controller.current?.check()} />}
      {view.phase === 'stopped' && view.canStart && <Button title="Start TLI" disabled={disabled} onPress={() => void controller.current?.start()} />}
      {view.phase === 'running' && <Button title="Check paired TLI connection" disabled={disabled || state.connection === 'checking'} onPress={() => void state.refresh()} />}
      <Button secondary title={view.configured ? 'Review updated Host Start setup' : 'Review Host Start setup'} disabled={disabled || state.connection !== 'connected'} onPress={() => void controller.current?.reviewSetup()} />
    </>}
    {!view.configured && <Copy muted>Enable the helper on the desktop first, then review it here while TLI is online. If both TLI and its helper are unreachable, use the computer to restore access.</Copy>}
    <Copy muted size={12}>Away from home, your private-network route must allow this exact helper address and port as well as TLI’s port. Start requests are never queued or automatically retried.</Copy>
  </Card>;
}
