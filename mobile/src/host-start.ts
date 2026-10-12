import { ApiError, type Client, type NativeRequest, type NativeResponse } from './client';
import { validateBootstrap } from './connection';
import { validateOrigin } from './protocol';
import type { Pairing } from './types';
import type { PairingStore } from './pairing-recovery';

export const HOST_START_STORAGE_KEY = 'tli.host-start.envelope';
const STATUS_PATH = '/host-control/v1/status', START_PATH = '/host-control/v1/start';
export type HostControl = { schema_version: 1; enabled: true; available: true; helper_id: string; node_id: string; origin: string; certificate_sha256: string; status_path: typeof STATUS_PATH; start_path: typeof START_PATH; mode: 'same_user_sign_in'; capabilities: { start_backend: true; wake_host: false }; reason: string };
type SavedControl = { schema_version: 1; pairing: { origin: string; certificate_der: string; node_id: string; device_id: string; owner_id: string }; host_control: HostControl; credential: string };
export type HostStatus = { schema_version: 1; helper_id: string; node_id: string; backend_state: 'running' | 'stopped' | 'starting' | 'unavailable'; can_start: boolean; reason: string; request_id?: string; duplicate?: boolean; accepted?: boolean };
export interface HelperTransport { requestHelper(configuration: { origin: string; certificateDer: string; certificateSha256: string }, request: NativeRequest): Promise<NativeResponse>; cancel(id: string): void | Promise<void> }
export type HostStartView = { phase: 'unconfigured' | 'idle' | 'reviewing' | 'review' | 'saving' | 'checking' | 'stopped' | 'starting' | 'running' | 'unavailable' | 'unreachable' | 'error'; detail: string; configured: boolean; review?: HostControl; origin?: string; checkedAt?: string; canStart?: boolean };
const safe = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
function binding(pairing: Pairing) { return { origin: pairing.origin, certificate_der: pairing.certificate_der, node_id: pairing.node_id, device_id: pairing.device_id, owner_id: pairing.owner_id }; }
function sameBinding(value: unknown, pairing: Pairing) { const expected = binding(pairing); return value && typeof value === 'object' && Object.entries(expected).every(([key, entry]) => (value as Record<string, unknown>)[key] === entry); }
export function validateHostControl(value: unknown, pairing: Pairing): HostControl {
  const d = value as HostControl | undefined;
  if (!d || d.schema_version !== 1 || d.enabled !== true || d.available !== true) throw new Error('Host Start is not configured on this computer. On the desktop, open Phone Companion → Start TLI from your phone.');
  if (!/^[0-9a-f]{32,64}$/.test(d.helper_id || '') || d.node_id !== pairing.node_id || !safe(d.node_id, 128) || !safe(d.reason, 1000) || !/^[a-fA-F0-9]{64}$/.test(d.certificate_sha256 || '') || d.status_path !== STATUS_PATH || d.start_path !== START_PATH || d.mode !== 'same_user_sign_in' || d.capabilities?.start_backend !== true || d.capabilities?.wake_host !== false) throw new Error('This TLI returned unsupported Host Start details. No helper connection was trusted.');
  const origin = validateOrigin(d.origin, pairing.version === 2), paired = new URL(validateOrigin(pairing.origin, pairing.version === 2)), helper = new URL(origin);
  if (helper.hostname !== paired.hostname || origin === pairing.origin) throw new Error('The helper must use a separate HTTPS port on the already paired computer. No new address was trusted.');
  // The independently pinned transport always uses the existing reviewed DER,
  // never a certificate or main-session credential supplied by this descriptor.
  return { schema_version: 1, enabled: true, available: true, helper_id: d.helper_id, node_id: d.node_id, origin, certificate_sha256: d.certificate_sha256.toLowerCase(), status_path: STATUS_PATH, start_path: START_PATH, mode: 'same_user_sign_in', capabilities: { start_backend: true, wake_host: false }, reason: d.reason };
}
export function validateHostStatus(value: unknown, control: HostControl, requestId?: string): HostStatus {
  const s = value as HostStatus | undefined;
  if (!s || s.schema_version !== 1 || s.helper_id !== control.helper_id || s.node_id !== control.node_id || !['running', 'stopped', 'starting', 'unavailable'].includes(s.backend_state) || typeof s.can_start !== 'boolean' || !safe(s.reason, 1000) || s.can_start && s.backend_state !== 'stopped' || requestId && (s.request_id !== requestId || typeof s.accepted !== 'boolean') || s.duplicate !== undefined && typeof s.duplicate !== 'boolean') throw new Error('The helper response did not confirm the reviewed computer and state. Check the desktop; no readiness was assumed.');
  return s;
}
function sameControl(a: HostControl, b: HostControl) { return ['helper_id', 'node_id', 'origin', 'certificate_sha256', 'status_path', 'start_path'].every(key => a[key as keyof HostControl] === b[key as keyof HostControl]); }
let sequence = 0;
const requestId = () => Date.now().toString(16).padStart(16, '0') + (++sequence).toString(16).padStart(8, '0') + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');

/** One reviewed, separately pinned helper. No global transport configuration. */
export class HostStartController {
  private saved?: SavedControl;
  private review?: HostControl;
  private epoch = 0;
  private pending?: string;
  private busy = false;
  private checked = 0;
  private status?: HostStatus;
  constructor(private options: { pairing: Pairing; api: Pick<Client, 'json'>; transport: HelperTransport; store: PairingStore; current(): boolean; publish(view: HostStartView): void }) {}
  private publish(phase: HostStartView['phase'], detail: string, extra: Partial<HostStartView> = {}) { this.options.publish({ phase, detail, configured: !!this.saved, origin: this.saved?.host_control.origin, ...extra }); }
  private current(epoch: number) { return this.epoch === epoch && this.options.current(); }
  suspend() { this.epoch++; this.review = undefined; this.status = undefined; this.checked = 0; if (this.pending) void this.options.transport.cancel(this.pending); this.publish(this.saved ? 'idle' : 'unconfigured', 'Check the helper again when you return. A pending start was not replayed.'); }
  async load() {
    const epoch = this.epoch;
    try {
      const raw = await this.options.store.get(HOST_START_STORAGE_KEY); if (!this.current(epoch)) return;
      if (raw) { const value = JSON.parse(raw) as SavedControl; if (value.schema_version === 1 && sameBinding(value.pairing, this.options.pairing) && /^tlih_[0-9a-f]{64}$/.test(value.credential)) this.saved = { ...value, host_control: validateHostControl(value.host_control, this.options.pairing) }; }
      this.publish(this.saved ? 'idle' : 'unconfigured', this.saved ? 'Saved helper connection. Check it to find out whether TLI is stopped.' : 'While TLI is online, review and enable its Host Start connection for this phone.');
    } catch { if (this.current(epoch)) this.publish('error', 'The saved helper connection could not be read. Keep TLI online and review its setup again.'); }
  }
  async reviewSetup() {
    if (this.busy || !this.options.current()) return; this.busy = true; const epoch = ++this.epoch;
    this.review = undefined; this.publish('reviewing', 'Reading Host Start details from your paired TLI…');
    try {
      const raw = await this.options.api.json<unknown>('/api/companion/v1/bootstrap'); if (!this.current(epoch)) return;
      validateBootstrap(raw, this.options.pairing.node_id);
      this.review = validateHostControl((raw as { host_control?: unknown }).host_control, this.options.pairing);
      this.publish('review', 'Allow this phone to check and start TLI through this separately pinned helper. The computer must be awake and its user signed in. This cannot wake or power on the computer.', { review: this.review });
    } catch (error) { if (this.current(epoch)) this.publish('error', error instanceof Error ? error.message : 'Host Start details could not be read.'); }
    finally { this.busy = false; }
  }
  async allow() {
    if (this.busy || !this.review || !this.options.current()) return; this.busy = true; const epoch = this.epoch, reviewed = this.review; this.publish('saving', 'Saving this reviewed helper connection securely…');
    try {
      const raw = await this.options.api.json<{ schema_version: number; host_control: unknown; credential: string }>('/api/host-control/v1/grant', 'POST', { helper_id: reviewed.helper_id, node_id: reviewed.node_id });
      if (!this.current(epoch)) return;
      const control = validateHostControl(raw.host_control, this.options.pairing);
      if (raw.schema_version !== 1 || !sameControl(control, reviewed) || !/^tlih_[0-9a-f]{64}$/.test(raw.credential || '')) throw new Error('The helper connection changed during review. Review it again; no changed connection was saved.');
      const candidate: SavedControl = { schema_version: 1, pairing: binding(this.options.pairing), host_control: control, credential: raw.credential };
      await this.options.store.set(HOST_START_STORAGE_KEY, JSON.stringify(candidate)); if (!this.current(epoch)) return;
      this.saved = candidate; this.review = undefined; this.publish('idle', 'Host Start saved for this phone. Check the helper when you need it. TLI has not been started.');
    } catch (error) { if (this.current(epoch)) this.publish('error', error instanceof Error ? error.message : 'The helper connection was not saved.'); }
    finally { this.busy = false; }
  }
  cancelReview() { this.review = undefined; this.publish(this.saved ? 'idle' : 'unconfigured', 'Review closed. No new helper connection was saved.'); }
  async check() { await this.request(false); }
  async start() { await this.request(true); }
  private async request(start: boolean) {
    if (this.busy || !this.saved || !this.options.current()) return;
    if (start && (!this.status?.can_start || this.status.backend_state !== 'stopped' || Date.now() - this.checked > 30000)) { this.publish('idle', 'Check the helper again before starting TLI.'); return; }
    this.busy = true; const epoch = ++this.epoch, saved = this.saved, id = 'host-start-' + requestId(); this.pending = id; this.status = undefined; this.checked = 0;
    const mutationId = start ? requestId() : undefined;
    this.publish(start ? 'starting' : 'checking', start ? 'Sending one Start TLI request…' : 'Checking the saved helper connection…');
    try {
      const response = await this.options.transport.requestHelper({ origin: saved.host_control.origin, certificateDer: this.options.pairing.certificate_der, certificateSha256: saved.host_control.certificate_sha256 }, { id, path: start ? START_PATH : STATUS_PATH + '?node_id=' + encodeURIComponent(saved.host_control.node_id) + '&helper_id=' + encodeURIComponent(saved.host_control.helper_id), method: start ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + saved.credential, Accept: 'application/json', 'Content-Type': 'application/json' }, ...(start ? { body: JSON.stringify({ request_id: mutationId, node_id: saved.host_control.node_id, helper_id: saved.host_control.helper_id }) } : {}) });
      if (!this.current(epoch)) return;
      if (![200, 202].includes(response.status)) throw new ApiError(response.status === 401 ? 'Host Start permission was rejected. Reconnect to your main TLI and review this phone’s access again.' : 'The helper could not confirm this request. Check its status before trying again.', response.status);
      const status = validateHostStatus(JSON.parse(response.body), saved.host_control, mutationId); this.status = status; this.checked = Date.now();
      const detail = status.backend_state === 'running' ? 'The helper confirms TLI is running. Check your paired TLI connection to confirm this phone can use it.' : status.backend_state === 'stopped' ? 'Helper reached securely. TLI is stopped.' : status.backend_state === 'starting' ? 'The helper reports TLI is starting. TLI is not ready yet; check again when you are ready.' : 'Helper reached, but TLI’s state is unavailable.';
      this.publish(status.backend_state, detail + ' ' + status.reason, { checkedAt: new Date(this.checked).toISOString(), canStart: status.can_start });
    } catch (error) {
      if (!this.current(epoch)) return;
      this.publish(error instanceof ApiError ? 'error' : 'unreachable', (start ? 'Start outcome is unconfirmed. It was not retried. Check status before another start. ' : 'The helper could not be verified or reached. This does not prove the computer is asleep or TLI is stopped. ') + (error instanceof Error ? error.message : 'Check the computer and network.'));
    } finally { if (this.pending === id) this.pending = undefined; this.busy = false; }
  }
}
