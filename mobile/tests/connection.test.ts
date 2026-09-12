import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, Client, type NativeRequest, type NativeResponse, type Transport } from '../src/client';
import { connectionIssue, LatestConnectionCheck, readConnection, validateBootstrap } from '../src/connection';
import { clearPairingAndReset, clearSavedPairing, loadSavedPairing, PAIRING_STORAGE_KEY, PairingReplacement, PairingReplacementError, PairingTransitions, savePairing, type PairingStore } from '../src/pairing-recovery';
import type { Bootstrap, Pairing } from '../src/types';

const old: Pairing = { version: 1, origin: 'https://192.168.1.10:8000', certificate_der: 'A'.repeat(256), node_id: 'old-home', node_name: 'Previous TLI', device_id: 'comp_old', owner_id: 'owner-old', credential: 'tlic_' + 'x'.repeat(40) };
const next: Pairing = { ...old, origin: 'https://192.168.1.20:8000', certificate_der: 'B'.repeat(256), node_id: 'new-home', node_name: 'Reviewed TLI', device_id: 'comp_new', owner_id: 'owner-new', credential: 'tlic_' + 'y'.repeat(40) };
const code = JSON.stringify({ version: 1, origin: next.origin, certificate_der: next.certificate_der, node_id: next.node_id, node_name: next.node_name, token: 'a'.repeat(32), expires_at: Date.now() / 1000 + 3600 });
const prefs = { favorite_devices: [], favorite_scenes: [], theme: 'system' };
const boot = (pairing = next, status: 'available' | 'unavailable' | 'unknown' = 'available'): Bootstrap => ({ api_version: 1, node: { id: pairing.node_id, name: pairing.node_name }, capabilities: { vision: false, chat: status === 'available' }, chat: { path: '/api/ai/chat/stream', streaming: true }, ai: { status, provider: 'bundled', detail: status === 'available' ? 'Runtime responded.' : 'Model not ready.', checked_at: '2026-09-07T12:00:00Z' } });
const response = (value: unknown, status = 200): NativeResponse => ({ status, headers: {}, body: JSON.stringify(value) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class MemoryStore implements PairingStore {
  values = new Map<string, string>(); writes: { key: string; value: string }[] = [];
  async get(key: string) { return this.values.get(key) ?? null; }
  write: (key: string, value: string) => Promise<void> = async (key, value) => { this.values.set(key, value); };
  async set(key: string, value: string) { this.writes.push({ key, value }); await this.write(key, value); }
  async remove(key: string) { this.values.delete(key); }
}
class FakeTransport implements Transport {
  requests: NativeRequest[] = []; configured: string[] = []; cancelled: string[] = []; origin = old.origin;
  configureCall: (origin: string) => Promise<void> = async () => {};
  async configure(options: { origin: string }) { this.configured.push(options.origin); await this.configureCall(options.origin); this.origin = options.origin; }
  async reset() { this.origin = ''; }
  cancel(id: string) { this.cancelled.push(id); }
  addListener() { return { remove() {} }; }
  respond: (request: NativeRequest) => Promise<NativeResponse> = async request => request.path.endsWith('/redeem') ? response({ node: { id: next.node_id, name: next.node_name }, device_id: next.device_id, owner_id: next.owner_id, credential: next.credential }) : request.path.endsWith('/bootstrap') ? response(boot()) : response(prefs);
  async request(request: NativeRequest) { this.requests.push(request); return this.respond(request); }
}
async function harness() {
  const store = new MemoryStore(); await savePairing(store, old); store.writes = [];
  const transport = new FakeTransport(), replacement = new PairingReplacement(); let revoked = 0;
  const client = new Client(transport, old.credential, () => revoked++);
  let current = true;
  const options = { raw: code, name: 'My phone', platform: 'ios' as const, transport, store, previous: old, previousClient: client, isCurrent: () => current };
  return { store, transport, replacement, client, options, get revoked() { return revoked; }, background() { current = false; }, run() { return replacement.run(options); } };
}

test('AI readiness cannot turn a valid host connection into an offline result', async () => {
  for (const status of ['available', 'unavailable', 'unknown'] as const) {
    const transport = new FakeTransport(); transport.respond = async request => response(request.path.endsWith('/bootstrap') ? boot(next, status) : prefs);
    const result = await readConnection(new Client(transport, next.credential), next);
    assert.equal(result.bootstrap.ai?.status, status); assert.equal(transport.requests.length, 2);
  }
  const legacy = boot(); delete legacy.ai; assert.equal(validateBootstrap(legacy, next.node_id).ai, undefined);
});

test('connection problems distinguish trust, network, credential, permission and incompatible responses', () => {
  for (const [code, kind] of [['E_TLS_TRUST', 'trust'], ['E_CERTIFICATE', 'trust'], ['E_NETWORK', 'unreachable'], ['E_TIMEOUT', 'unreachable'], ['E_LOCAL_NETWORK_PERMISSION', 'permission'], ['E_CANCELLED', 'cancelled']] as const) assert.equal(connectionIssue({ code }).kind, kind);
  assert.equal(connectionIssue(new ApiError('Revoked', 401)).kind, 'credential');
  assert.equal(connectionIssue(new ApiError('Host check failed', 503)).kind, 'server');
  for (const candidate of [{ ...boot(), api_version: 2 }, { ...boot(), capabilities: {} }]) assert.throws(() => validateBootstrap(candidate, next.node_id), error => connectionIssue(error).kind === 'incompatible');
  assert.throws(() => validateBootstrap(boot(old), next.node_id), error => connectionIssue(error).kind === 'trust');
});

test('latest refresh wins within one pairing and background invalidates pending observations', async () => {
  const checks = new LatestConnectionCheck(), first = deferred<Bootstrap>(), second = deferred<Bootstrap>();
  let visible: Bootstrap | undefined;
  const observe = async (value: Promise<Bootstrap>, ticket: number) => { const data = await value; if (checks.accepts(ticket, true)) visible = validateBootstrap(data, next.node_id); };
  const one = observe(first.promise, checks.begin()), two = observe(second.promise, checks.begin());
  second.resolve(boot(next, 'unavailable')); await two; first.resolve(boot(next, 'available')); await one;
  assert.equal(visible?.ai?.status, 'unavailable');
  const backgroundTicket = checks.begin(); checks.invalidate(); assert.equal(checks.accepts(backgroundTicket, true), false);
  assert.equal(checks.accepts(checks.begin(), false), false);
});

test('a paused old client rejects new requests and ignores late revocation after being resumed', async () => {
  const h = await harness(), pending = deferred<NativeResponse>();
  h.transport.respond = () => pending.promise;
  const oldRead = h.client.json('/api/intelligence/devices');
  h.client.pause(); await assert.rejects(h.client.json('/api/companion/v1/bootstrap'), /replacement is in progress/);
  h.client.resume(); pending.resolve(response({ detail: 'Late old credential result' }, 401)); await assert.rejects(oldRead, /Late old credential/);
  assert.equal(h.revoked, 0); assert.equal(h.transport.requests.length, 1);
});

test('legacy storage remains readable but corrupt or forgotten envelopes never fall back to stale credentials', async () => {
  const store = new MemoryStore(), { credential, ...publicPairing } = old;
  store.values.set('tli.pairing', JSON.stringify(publicPairing)); store.values.set('tli.credential', credential);
  assert.deepEqual(await loadSavedPairing(store), old); assert.equal(store.writes.length, 0);
  store.values.set(PAIRING_STORAGE_KEY, 'corrupt'); await assert.rejects(loadSavedPairing(store), /envelope could not be read/);
  await savePairing(store, null); assert.equal(await loadSavedPairing(store), null);
  await savePairing(store, next); assert.deepEqual(await loadSavedPairing(store), next);
  await clearSavedPairing(store); assert.equal(await loadSavedPairing(store), null); assert.equal(store.values.has('tli.credential'), false);
});

test('replacement verifies identity and owner access before the single durable selection write', async () => {
  const h = await harness();
  h.store.write = async (key, value) => { assert.equal(h.transport.requests.length, 3); assert.equal(h.replacement.phase, 'saving'); h.store.values.set(key, value); };
  const result = await h.run();
  assert.deepEqual(result.pairing, next); assert.deepEqual(await loadSavedPairing(h.store), next);
  assert.deepEqual(h.transport.configured, [next.origin]); assert.equal(h.store.writes.length, 1);
  assert.equal(h.transport.requests[0]!.headers.Authorization, undefined);
  assert.equal(h.transport.requests[1]!.headers.Authorization, `Bearer ${next.credential}`);
  assert.equal(h.revoked, 0); assert.equal(h.replacement.busy, false);
});

test('candidate revocation or incompatible bootstrap restores old transport and never invalidates its credential', async () => {
  for (const fault of ['revoked', 'version', 'identity']) {
    const h = await harness(), normal = h.transport.respond;
    h.transport.respond = request => request.path.endsWith('/bootstrap') ? Promise.resolve(fault === 'revoked' ? response({ detail: 'Candidate rejected' }, 401) : response(fault === 'version' ? { ...boot(), api_version: 2 } : boot(old))) : normal(request);
    await assert.rejects(h.run(), error => error instanceof PairingReplacementError && error.recovery.transport_restored);
    assert.deepEqual(await loadSavedPairing(h.store), old); assert.deepEqual(h.transport.configured, [next.origin, old.origin]); assert.equal(h.revoked, 0); assert.equal(h.store.writes.length, 0);
  }
});

test('failed trust validation restores the previous client without issuing a redeem request', async () => {
  const h = await harness(); h.transport.configureCall = async origin => { if (origin === next.origin) throw Object.assign(new Error('Certificate mismatch'), { code: 'E_TLS_TRUST' }); };
  await assert.rejects(h.run(), error => error instanceof PairingReplacementError && error.issue.kind === 'trust' && error.recovery.transport_restored);
  assert.equal(h.transport.requests.length, 0); assert.deepEqual(await loadSavedPairing(h.store), old);
  await h.client.json('/api/companion/v1/preferences'); assert.equal(h.transport.requests.length, 1);
});

test('cancelled verification stays busy until late redemption settles and cannot save the candidate', async () => {
  const h = await harness(), pending = deferred<NativeResponse>(); h.transport.respond = () => pending.promise;
  const running = h.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replacement.cancel(), true); assert.equal(h.replacement.busy, true);
  await assert.rejects(h.run(), /still finishing/);
  pending.resolve(response({ node: { id: next.node_id, name: next.node_name }, device_id: next.device_id, owner_id: next.owner_id, credential: next.credential }));
  await assert.rejects(running, error => error instanceof PairingReplacementError && error.issue.kind === 'cancelled');
  assert.equal(h.transport.requests.length, 1); assert.equal(h.store.writes.length, 0); assert.deepEqual(await loadSavedPairing(h.store), old); assert.equal(h.transport.origin, old.origin);
});

test('background interruption before commit retains the old pairing even when candidate checks finish', async () => {
  const h = await harness(), pending = deferred<NativeResponse>(), normal = h.transport.respond;
  h.transport.respond = request => request.path.endsWith('/bootstrap') ? pending.promise : normal(request);
  const running = h.run(); await new Promise(resolve => setImmediate(resolve)); h.background(); pending.resolve(response(boot()));
  await assert.rejects(running, error => error instanceof PairingReplacementError && error.issue.kind === 'cancelled');
  assert.deepEqual(await loadSavedPairing(h.store), old); assert.equal(h.store.writes.length, 0);
});

test('a failed durable write rolls back even if storage changed before reporting its error', async () => {
  const h = await harness(); let writes = 0;
  h.store.write = async (key, value) => { h.store.values.set(key, value); if (++writes === 1) throw new Error('Write outcome uncertain'); };
  await assert.rejects(h.run(), error => error instanceof PairingReplacementError && error.recovery.storage_restored === true);
  assert.deepEqual(await loadSavedPairing(h.store), old); assert.equal(h.store.writes.length, 2); assert.equal(h.transport.origin, old.origin);
});

test('failed storage rollback and failed old transport restoration are reported separately with credentials preserved', async () => {
  const h = await harness(); h.store.write = async () => { throw new Error('Protected storage unavailable'); };
  h.transport.configureCall = async origin => { if (origin === old.origin) throw Object.assign(new Error('Old certificate invalid'), { code: 'E_TLS_TRUST' }); };
  await assert.rejects(h.run(), error => error instanceof PairingReplacementError && error.recovery.storage_restored === false && !error.recovery.transport_restored && error.recovery.previous_kept && /storage recovery also failed/.test(error.message));
  assert.deepEqual(await loadSavedPairing(h.store), old);
  await assert.rejects(h.client.json('/api/intelligence/devices'), /replacement is in progress/);
});

test('saving is a non-cancellable reviewed commit and no request is replayed afterward', async () => {
  const h = await harness(), pending = deferred<void>();
  h.store.write = async (key, value) => { await pending.promise; h.store.values.set(key, value); };
  const running = h.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.replacement.phase, 'saving'); assert.equal(h.replacement.cancel(), false); h.background();
  pending.resolve(); const result = await running;
  assert.deepEqual(result.pairing, next); assert.deepEqual(await loadSavedPairing(h.store), next); assert.equal(h.transport.requests.length, 3);
});

test('replacement waits for in-flight actions and does not cancel or replay them', async () => {
  const h = await harness(), pending = deferred<NativeResponse>(); h.transport.respond = () => pending.promise;
  const action = h.client.json('/homepower/scenes/run', 'POST', { scene_id: 'existing' });
  await assert.rejects(h.run(), /current message or action/); assert.equal(h.transport.configured.length, 0); assert.equal(h.transport.cancelled.length, 0);
  pending.resolve(response({ ok: true })); await action; assert.equal(h.client.hasActiveMutations, false); assert.equal(h.transport.requests.length, 1);
});

test('unused legacy-key cleanup failures cannot resurrect a forgotten pairing', async () => {
  const store = new MemoryStore(); await savePairing(store, old);
  const { credential, ...publicPairing } = old;
  store.values.set('tli.pairing', JSON.stringify(publicPairing)); store.values.set('tli.credential', credential);
  store.remove = async () => { throw new Error('Cleanup unavailable'); };
  assert.equal((await clearSavedPairing(store)).legacy_removed, false);
  assert.equal(await loadSavedPairing(store), null); assert.equal(store.values.has('tli.credential'), true);
});

test('failed replacement preserves an unreadable prior envelope byte-for-byte instead of creating a tombstone', async () => {
  const h = await harness(), original = ' { malformed but preserved pairing\r\n';
  h.store.values.set(PAIRING_STORAGE_KEY, original); let writes = 0;
  h.store.write = async (key, value) => { h.store.values.set(key, value); if (++writes === 1) throw new Error('Write outcome uncertain'); };
  await assert.rejects(h.replacement.run({ ...h.options, previous: null, previousClient: null }), error => error instanceof PairingReplacementError && error.recovery.storage_restored === true);
  assert.equal(h.store.values.get(PAIRING_STORAGE_KEY), original);
  assert.equal(h.store.writes[1]!.value, original);
});

test('rollback restores envelope absence and leaves legacy pairing bytes authoritative', async () => {
  const h = await harness(), { credential, ...publicPairing } = old;
  const original = JSON.stringify(publicPairing, null, 3) + '\r\n';
  h.store.values.delete(PAIRING_STORAGE_KEY);
  h.store.values.set('tli.pairing', original); h.store.values.set('tli.credential', credential);
  h.store.write = async (key, value) => { h.store.values.set(key, value); throw new Error('Uncertain candidate write'); };
  await assert.rejects(h.run(), error => error instanceof PairingReplacementError && error.recovery.storage_restored === true);
  assert.equal(h.store.values.has(PAIRING_STORAGE_KEY), false);
  assert.equal(h.store.values.get('tli.pairing'), original); assert.equal(h.store.values.get('tli.credential'), credential);
  assert.deepEqual(await loadSavedPairing(h.store), old);
});

test('snapshot read failure refuses replacement before transport changes or stored writes', async () => {
  const h = await harness(); h.store.get = async () => { throw new Error('Protected storage read unavailable'); };
  await assert.rejects(h.run(), error => error instanceof PairingReplacementError && error.issue.kind === 'storage');
  assert.equal(h.transport.configured.length, 0); assert.equal(h.transport.requests.length, 0); assert.equal(h.store.writes.length, 0);
  await h.client.json('/api/companion/v1/preferences'); assert.equal(h.transport.requests.length, 1);
});

test('late revocation cleanup cannot erase a fresh pairing even when transport reset finishes first', async () => {
  const h = await harness(), transitions = new PairingTransitions(), pendingWrite = deferred<void>();
  h.store.write = async (key, value) => { await pendingWrite.promise; h.store.values.set(key, value); };
  const cleanup = transitions.run(() => clearPairingAndReset(h.store, h.transport));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.transport.origin, ''); assert.equal(transitions.busy, true);
  await assert.rejects(transitions.run(() => h.run()), /still finishing/);
  await assert.rejects(transitions.run(() => clearSavedPairing(h.store)), /still finishing/);
  assert.equal(h.transport.requests.length, 0);
  pendingWrite.resolve(); await cleanup;
  assert.equal(await loadSavedPairing(h.store), null);
  const result = await transitions.run(() => h.run());
  assert.deepEqual(result.pairing, next); assert.deepEqual(await loadSavedPairing(h.store), next);
  assert.equal(h.transport.origin, next.origin); assert.equal(transitions.busy, false);
});

test('cleanup failures cannot release a pairing transition while the other cleanup is still pending', async () => {
  const h = await harness(), transitions = new PairingTransitions(), pendingReset = deferred<void>();
  h.store.write = async () => { throw new Error('Protected storage unavailable'); };
  h.transport.reset = () => pendingReset.promise;
  const cleanup = transitions.run(() => clearPairingAndReset(h.store, h.transport));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transitions.busy, true);
  await assert.rejects(transitions.run(() => h.run()), /still finishing/);
  pendingReset.resolve(); const result = await cleanup;
  assert.equal(result.storage.status, 'rejected'); assert.equal(result.reset.status, 'fulfilled'); assert.equal(transitions.busy, false);
});

test('revocation reset waits for an earlier transport configuration and blocks replacement until it settles', async () => {
  const h = await harness(), transitions = new PairingTransitions(), pendingConfigure = deferred<void>(), order: string[] = [];
  h.transport.configureCall = async () => { await pendingConfigure.promise; order.push('configured'); };
  h.transport.reset = async () => { order.push('reset'); h.transport.origin = ''; };
  const configuring = h.transport.configure({ origin: old.origin });
  const cleanup = transitions.run(() => clearPairingAndReset(h.store, h.transport, configuring));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, []); assert.equal(transitions.busy, true);
  await assert.rejects(transitions.run(() => h.run()), /still finishing/);
  pendingConfigure.resolve(); await cleanup;
  assert.deepEqual(order, ['configured', 'reset']); assert.equal(h.transport.origin, '');
});

test('forget reserves the session and invalidates pending checks before waiting for protected storage', async () => {
  const h = await harness(), transitions = new PairingTransitions(), checks = new LatestConnectionCheck(), pendingWrite = deferred<void>();
  const priorCheck = checks.begin();
  h.store.write = async (key, value) => { await pendingWrite.promise; h.store.values.set(key, value); };
  const forgetting = transitions.run(async () => { checks.invalidate(); h.client.pause(); await clearSavedPairing(h.store); await h.transport.reset(); });
  assert.equal(checks.accepts(priorCheck, true), false);
  await assert.rejects(transitions.run(() => h.run()), /still finishing/);
  await assert.rejects(h.client.json('/api/companion/v1/bootstrap'), /replacement is in progress/);
  pendingWrite.resolve(); await forgetting;
  assert.equal(await loadSavedPairing(h.store), null); assert.equal(h.transport.origin, '');
});


test('transport timeout, connection failure and missing route have evidence-specific recovery', () => {
  for (const [code, title] of [['E_TIMEOUT', 'did not respond in time'], ['E_CONNECT', 'Could not connect'], ['E_NO_ROUTE', 'No network path'], ['E_OFFLINE', 'No network path']]) {
    const issue = connectionIssue(Object.assign(new Error('native'), { code }));
    assert.match(issue.title, new RegExp(title!)); assert.equal(issue.kind, 'unreachable'); assert.doesNotMatch(issue.detail, /permission denied|AI is offline/i);
  }
});
