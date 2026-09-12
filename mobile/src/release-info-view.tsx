import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import { useCompanion } from './state';
import { Button, Card, Copy, Label, Notice } from './ui';
import { nativeBuildLabel, releaseLabel, ReleaseReview } from './release-info';
import { formatTime } from './protocol';
export function ReleaseInfo() {
  const state = useCompanion(), [review] = useState(() => new ReleaseReview()), [, render] = useState(0), [details, setDetails] = useState(false);
  const current = useRef({ client: state.client, active: state.foreground && state.connection === 'connected' }); current.current = { client: state.client, active: state.foreground && state.connection === 'connected' };
  useEffect(() => { review.clear(); setDetails(false); render(v => v + 1); return () => review.clear(); }, [state.client, review]);
  useEffect(() => { if (!state.foreground || state.connection !== 'connected') { review.suspend(); setDetails(false); render(v => v + 1); } }, [state.foreground, state.connection, review]);
  const check = async () => { const api = state.client; if (!api || !current.current.active || review.busy || state.sending || api.hasActiveMutations) return; const run = review.check(api, () => current.current.client === api && current.current.active); render(v => v + 1); await run; if (current.current.client === api && current.current.active) render(v => v + 1); };
  const app = nativeBuildLabel(Application, Platform.OS === 'web'), host = review.value;
  return <Card><Label>App and host versions</Label><Copy weight="600">{app.label}</Copy><Copy selectable muted size={12}>{app.id}</Copy><Copy>{releaseLabel(host)}{review.stale && host ? ' · previous check' : ''}</Copy>
    <Copy muted size={13}>A matching host identity means its application files match startup. It does not certify every phone feature, model answer or physical device.</Copy>
    <Button secondary title="Check host release identity" busy={review.busy} disabled={!current.current.active || state.sending || state.client?.hasActiveMutations} onPress={() => void check()} />
    {!!review.error && <Notice error>{review.error}</Notice>}
    {host && <><Copy muted size={12}>Host started {formatTime(host.started_at)} · checked {formatTime(host.checked_at)}</Copy>{host.compatibility.reasons.map((s, i) => <Notice key={i}>{s}</Notice>)}<Button secondary title={details ? 'Hide release details' : 'Show release details'} onPress={() => setDetails(v => !v)} />{details && <><Copy muted size={12}>{host.identity_scope}</Copy>{(['source_id', 'backend_id', 'frontend_id'] as const).map(key => <Copy key={key} selectable size={12}>{key.replace('_id', '')}: {host[key] || 'Unknown'}</Copy>)}<Copy selectable size={12}>Advertised host capabilities: {host.capabilities.join(', ') || 'None recorded'}. Individual workflows recheck their required capability.</Copy></>}</>}
  </Card>;
}
