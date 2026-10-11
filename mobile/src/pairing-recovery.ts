import { Client, type Transport } from './client';
import { ConnectionError, connectionIssue, readConnection } from './connection';
import { parsePairingCode, validateOrigin } from './protocol';
import type { Pairing, PairingCode } from './types';
import { HOST_START_STORAGE_KEY } from './host-start';

export const PAIRING_STORAGE_KEY = 'tli.pairing.envelope';
export type PairingStore = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
/** One durable write order for pairing selection, helper grants and erasure. */
export function orderedPairingStore(store: PairingStore): PairingStore {
  let pending = Promise.resolve();
  function write(work: () => Promise<void>) { const next = pending.then(work); pending = next.catch(() => {}); return next; }
  return { get: key => store.get(key), set: (key, value) => write(() => store.set(key, value)), remove: key => write(() => store.remove(key)) };
}
const storageError = (detail: string) => new ConnectionError({ kind: 'storage', title: 'Pairing could not be saved securely', detail });
const safeString = (value: unknown, min = 1, max = 256): value is string => typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f]/.test(value);
export function validateSavedPairing(value: unknown): Pairing {
  const saved = value as Pairing | undefined;
  if (!saved || saved.version !== 1 || !safeString(saved.origin) || !safeString(saved.node_id) || !safeString(saved.node_name) || !safeString(saved.device_id) || !safeString(saved.owner_id) || !safeString(saved.credential, 20) || !safeString(saved.certificate_der, 128, 12000) || !/^[A-Za-z0-9+/]+={0,2}$/.test(saved.certificate_der)) throw storageError('The stored pairing is incomplete. Its existing files were kept. Review a fresh desktop code to replace it.');
  return { version: 1, origin: validateOrigin(saved.origin), certificate_der: saved.certificate_der, node_id: saved.node_id, node_name: saved.node_name, device_id: saved.device_id, owner_id: saved.owner_id, credential: saved.credential };
}
export async function loadSavedPairing(store: PairingStore): Promise<Pairing | null> {
  const envelope = await store.get(PAIRING_STORAGE_KEY);
  if (envelope !== null) {
    let value;
    try { value = JSON.parse(envelope); } catch { throw storageError('The saved pairing envelope could not be read. It was kept unchanged; review a new desktop code to replace it.'); }
    if (!value || value.schema_version !== 1 || !Object.hasOwn(value, 'pairing')) throw storageError('The saved pairing format is unsupported. It was kept unchanged.');
    return value.pairing === null ? null : validateSavedPairing(value.pairing);
  }
  const [raw, credential] = await Promise.all([store.get('tli.pairing'), store.get('tli.credential')]);
  if (raw === null && credential === null) return null;
  if (!raw || !credential) throw storageError('The earlier pairing is incomplete. Review a new desktop code; no stored credential was replaced.');
  try { return validateSavedPairing({ ...JSON.parse(raw), credential }); } catch (error) { if (error instanceof ConnectionError) throw error; throw storageError('The earlier pairing could not be read. Review a new desktop code to replace it.'); }
}
export async function savePairing(store: PairingStore, pairing: Pairing | null) {
  // A single protected item changes the durable selection. Old formats are read
  // only when this envelope is absent, never when it is corrupt or a tombstone.
  await store.set(PAIRING_STORAGE_KEY, JSON.stringify({ schema_version: 1, pairing }));
}
export async function clearSavedPairing(store: PairingStore) {
  await savePairing(store, null);
  const cleanup = await Promise.allSettled([store.remove('tli.pairing'), store.remove('tli.credential'), store.remove(HOST_START_STORAGE_KEY)]);
  return { legacy_removed: cleanup.every(item => item.status === 'fulfilled') };
}
// One session owns the singleton transport and durable pairing selection.
// Reserve synchronously, including cleanup after revocation or Forget, so an
// older cleanup can never outlive a newly committed replacement.
export class PairingTransitions {
  private active = false;
  get busy() { return this.active; }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('The previous connection change is still finishing. Wait before changing the pairing again.');
    this.active = true;
    try { return await work(); } finally { this.active = false; }
  }
}
export async function clearPairingAndReset(store: PairingStore | null, transport: Transport, pendingTransport?: Promise<void> | null) {
  // A reset failure must not release the session while protected-storage
  // cleanup is still pending, or the reverse.
  const [storage, reset] = await Promise.allSettled([
    store ? clearSavedPairing(store) : Promise.resolve({ legacy_removed: true }),
    Promise.resolve().then(async () => { await pendingTransport?.catch(() => {}); await transport.reset(); }),
  ]);
  return { storage, reset };
}
export type PairingPhase = 'idle' | 'verifying' | 'saving';
export class PairingReplacementError extends ConnectionError {
  constructor(error: unknown, readonly recovery: { transport_restored: boolean; storage_restored?: boolean; previous_kept: boolean }) {
    const issue = connectionIssue(error);
    super({ ...issue, detail: `${issue.detail}${recovery.previous_kept ? recovery.transport_restored ? ' Your previous pairing is still selected.' : ' Your previous pairing is kept, but its secure connection could not be restored. Check its address and explicitly reconnect.' : ''}${recovery.storage_restored === false ? ' Secure storage recovery also failed; the saved connection could not be confirmed. Your previous credentials remain available in this session.' : ''}` });
  }
}
type Attempt = { cancelled: boolean; phase: PairingPhase; client?: Client };
export class PairingReplacement {
  private attempt?: Attempt;
  get busy() { return !!this.attempt; }
  get phase(): PairingPhase { return this.attempt?.phase || 'idle'; }
  cancel(): boolean {
    if (!this.attempt || this.attempt.phase === 'saving') return false;
    this.attempt.cancelled = true; this.attempt.client?.cancelAll(); return true;
  }
  async run(options: { raw: string; name: string; platform: 'ios' | 'android'; transport: Transport; store: PairingStore; previous: Pairing | null; previousClient: Client | null; isCurrent: () => boolean; onPhase?: (phase: PairingPhase) => void }) {
    if (this.attempt) throw new Error('The previous pairing attempt is still finishing. Wait before trying another code.');
    if (options.previousClient?.hasActiveMutations) throw new Error('Wait for the current message or action to finish before replacing this connection.');
    const code: PairingCode = parsePairingCode(options.raw);
    if (!safeString(options.name.trim(), 1, 80)) throw new Error('Give this phone a name of 1–80 characters without control characters.');
    const attempt: Attempt = { cancelled: false, phase: 'verifying' }; this.attempt = attempt;
    const assertCurrent = () => { if (attempt.cancelled || !options.isCurrent()) throw Object.assign(new Error('Pairing verification was cancelled or interrupted. Review the code and try again when ready.'), { code: 'E_CANCELLED' }); };
    let storageRestored: boolean | undefined;
    let previousEnvelope: string | null, previousPaused = false;
    options.onPhase?.('verifying');
    try {
      assertCurrent();
      // Preserve exact storage, including an unreadable envelope or absence
      // which leaves the legacy two-key layout authoritative. A failed attempt
      // must not turn bad-but-preserved storage into a new tombstone.
      try { previousEnvelope = await options.store.get(PAIRING_STORAGE_KEY); }
      catch { throw storageError('The existing protected pairing could not be read for recovery. It was left unchanged; no replacement was attempted.'); }
      assertCurrent();
      options.previousClient?.pause(); previousPaused = true;
      await options.transport.configure({ origin: code.origin, certificateDer: code.certificate_der }); assertCurrent();
      const invite = new Client(options.transport, ''); attempt.client = invite;
      const redeemed = await invite.json<{ node: { id: string; name: string }; device_id: string; owner_id: string; credential: string }>('/api/companion/v1/pairings/redeem', 'POST', { token: code.token, name: options.name.trim(), platform: options.platform });
      assertCurrent();
      if (!redeemed?.node || redeemed.node.id !== code.node_id) throw new ConnectionError({ kind: 'trust', title: 'Pairing identity mismatch', detail: 'The pairing response does not match the reviewed TLI. Create and review a fresh desktop code.' });
      const pairing = validateSavedPairing({ version: 1, origin: code.origin, certificate_der: code.certificate_der, node_id: redeemed.node.id, node_name: redeemed.node.name, device_id: redeemed.device_id, owner_id: redeemed.owner_id, credential: redeemed.credential });
      const candidate = new Client(options.transport, pairing.credential); attempt.client = candidate;
      const checked = await readConnection(candidate, pairing); assertCurrent();
      // The reviewed commit is one non-cancellable secure-store write. Requests
      // are already complete; app backgrounding here cannot replay anything.
      attempt.phase = 'saving'; options.onPhase?.('saving');
      try { await savePairing(options.store, pairing); }
      catch {
        try {
          if (previousEnvelope === null) await options.store.remove(PAIRING_STORAGE_KEY);
          else await options.store.set(PAIRING_STORAGE_KEY, previousEnvelope);
          storageRestored = true;
        } catch { storageRestored = false; }
        throw storageError('The new pairing could not be saved securely. It was not selected for this session.');
      }
      return { pairing, ...checked };
    } catch (error) {
      attempt.client?.cancelAll();
      let restored = !previousPaused;
      if (previousPaused) {
        try {
          if (options.previous) await options.transport.configure({ origin: options.previous.origin, certificateDer: options.previous.certificate_der });
          else await options.transport.reset();
          options.previousClient?.resume(); restored = true;
        } catch { /* Keep the previous credential, but never claim restored transport. */ }
      }
      throw new PairingReplacementError(error, { transport_restored: restored, storage_restored: storageRestored, previous_kept: !!options.previous });
    } finally { this.attempt = undefined; options.onPhase?.('idle'); }
  }
}
