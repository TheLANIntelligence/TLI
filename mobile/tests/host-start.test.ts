import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HostStartController, HOST_START_STORAGE_KEY, validateHostControl, validateHostStatus, type HostStartView, type HostControl } from '../src/host-start';
import { clearSavedPairing, orderedPairingStore, savePairing } from '../src/pairing-recovery';
import type { Pairing } from '../src/types';
import type { NativeRequest } from '../src/client';

const pairing: Pairing = { version: 1, origin: 'https://192.168.1.5:8000', certificate_der: 'A'.repeat(160), node_id: 'computer-1', node_name: 'Home PC', device_id: 'phone-1', owner_id: 'owner-1', credential: 'main-credential-never-send-to-helper' };
const control: HostControl = { schema_version: 1, enabled: true, available: true, helper_id: 'a'.repeat(32), node_id: pairing.node_id, origin: 'https://192.168.1.5:8001', certificate_sha256: 'a'.repeat(64), status_path: '/host-control/v1/status', start_path: '/host-control/v1/start', mode: 'same_user_sign_in', capabilities: { start_backend: true, wake_host: false }, reason: 'Configured; listener not checked.' };
const credential = 'tlih_' + 'b'.repeat(64);
const stopped = { schema_version: 1, helper_id: control.helper_id, node_id: pairing.node_id, backend_state: 'stopped', can_start: true, reason: 'Owned backend is stopped.' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const values = new Map<string, string>(), main: { path: string; method?: string; body?: unknown }[] = [], helper: { configuration: unknown; request: NativeRequest }[] = [], cancelled: string[] = [], views: HostStartView[] = [];
  let current = true;
  const store = { get: async (key: string) => values.get(key) || null, set: async (key: string, value: string) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); } };
  let grant = { schema_version: 1, host_control: control, credential };
  let answer = async (request: NativeRequest) => ({ status: request.method === 'POST' ? 202 : 200, headers: {}, body: JSON.stringify(request.method === 'POST' ? { ...stopped, backend_state: 'starting', can_start: false, accepted: true, request_id: JSON.parse(request.body!).request_id } : stopped) });
  const controller = new HostStartController({ pairing, store, current: () => current, publish: view => views.push(view),
    api: { json: async <T>(path: string, method?: string, body?: unknown) => { main.push({ path, method, body }); return (path.endsWith('/bootstrap') ? { api_version: 1, node: { id: pairing.node_id, name: pairing.node_name }, capabilities: { vision: false }, host_control: control } : grant) as T; } },
    transport: { requestHelper: async (configuration, request) => { helper.push({ configuration, request }); return answer(request); }, cancel: id => { cancelled.push(id); } } });
  return { controller, values, store, main, helper, views, cancelled, get view() { return views.at(-1)!; }, setAnswer(fn: typeof answer) { answer = fn; }, setGrant(value: typeof grant) { grant = value; }, background() { current = false; controller.suspend(); }, async allow() { await controller.reviewSetup(); await controller.allow(); } };
}

test('review is read-only and permission is saved only after exact explicit grant review', async () => {
  const f = fixture(); await f.controller.load(); assert.equal(f.main.length, 0); assert.equal(f.helper.length, 0);
  await f.controller.reviewSetup(); assert.equal(f.view.phase, 'review'); assert.equal(f.values.size, 0); assert.deepEqual(f.main.map(x => x.path), ['/api/companion/v1/bootstrap']);
  await f.controller.allow(); assert.equal(f.view.configured, true); assert.equal(f.helper.length, 0);
  const saved = JSON.parse(f.values.get(HOST_START_STORAGE_KEY)!); assert.equal(saved.credential, credential); assert.equal(saved.pairing.certificate_der, pairing.certificate_der); assert.equal(saved.pairing.credential, undefined);
  assert.deepEqual(f.main[1], { path: '/api/host-control/v1/grant', method: 'POST', body: { helper_id: control.helper_id, node_id: pairing.node_id } });
});

test('descriptor cannot redirect a helper credential to another origin or trust identity', () => {
  for (const patch of [{ origin: pairing.origin }, { origin: 'https://192.168.1.8:8001' }, { origin: 'http://192.168.1.5:8001' }, { origin: 'https://user@192.168.1.5:8001' }, { origin: 'https://example.com:8001' }, { node_id: 'wrong' }, { start_path: '/api/actions' }, { certificate_sha256: 'bad' }, { capabilities: { start_backend: true, wake_host: true } }, { available: false }]) assert.throws(() => validateHostControl({ ...control, ...patch }, pairing));
});

test('helper requests pin the existing certificate and use only the restricted credential', async () => {
  const f = fixture(); await f.allow(); await f.controller.check();
  assert.equal(f.view.phase, 'stopped'); assert.equal(f.view.canStart, true);
  assert.deepEqual(f.helper[0]!.configuration, { origin: control.origin, certificateDer: pairing.certificate_der, certificateSha256: control.certificate_sha256 });
  assert.equal(f.helper[0]!.request.headers.Authorization, 'Bearer ' + credential);
  assert.ok(!JSON.stringify(f.helper).includes(pairing.credential));
  assert.equal(f.main.length, 2); assert.equal(f.helper[0]!.request.path, '/host-control/v1/status?node_id=computer-1&helper_id=' + control.helper_id);
});

test('start needs confirmed stopped state and duplicate taps cannot create duplicate mutations', async () => {
  const f = fixture(); await f.allow(); await f.controller.start(); assert.equal(f.helper.length, 0);
  await f.controller.check(); const pending = deferred<{ status: number; headers: {}; body: string }>(); f.setAnswer(() => pending.promise);
  const first = f.controller.start(); await f.controller.start(); assert.equal(f.helper.length, 2);
  const sent = JSON.parse(f.helper[1]!.request.body!); assert.match(sent.request_id, /^[a-f0-9]{32}$/);
  pending.resolve({ status: 202, headers: {}, body: JSON.stringify({ ...stopped, backend_state: 'starting', can_start: false, accepted: true, request_id: sent.request_id }) }); await first;
  assert.equal(f.view.phase, 'starting'); assert.match(f.view.detail, /not ready yet/); await f.controller.start(); assert.equal(f.helper.length, 2);
});

test('unreachable helper cannot be treated as backend stopped and failed start is not replayed', async () => {
  const f = fixture(); await f.allow(); f.setAnswer(async () => { throw new Error('No route'); }); await f.controller.check(); assert.equal(f.view.phase, 'unreachable'); assert.match(f.view.detail, /does not prove/); await f.controller.start(); assert.equal(f.helper.length, 1);
  f.setAnswer(async () => ({ status: 200, headers: {}, body: JSON.stringify(stopped) })); await f.controller.check(); f.setAnswer(async () => { throw new Error('Timeout'); }); await f.controller.start(); assert.match(f.view.detail, /unconfirmed.*not retried/); await f.controller.start(); assert.equal(f.helper.length, 3);
});

test('a running helper receipt is separate from a successful paired-main connection', async () => {
  const f = fixture(); await f.allow(); f.setAnswer(async () => ({ status: 200, headers: {}, body: JSON.stringify({ ...stopped, backend_state: 'running', can_start: false }) })); await f.controller.check();
  assert.equal(f.view.phase, 'running'); assert.match(f.view.detail, /Check your paired TLI connection/); assert.equal(f.main.length, 2); assert.equal(f.view.canStart, false);
});

test('identity, state, request receipt and permission contradictions cannot enable Start', () => {
  for (const patch of [{ node_id: 'wrong' }, { helper_id: 'wrong' }, { backend_state: 'running' }, { backend_state: 'asleep' }, { can_start: 'yes' }, { reason: '' }]) assert.throws(() => validateHostStatus({ ...stopped, ...patch }, control));
  assert.throws(() => validateHostStatus({ ...stopped, request_id: 'other' }, control, 'expected'));
});

test('backgrounding cancels helper request and discards late addresses and readiness', async () => {
  const f = fixture(); await f.allow(); const pending = deferred<{ status: number; headers: {}; body: string }>(); f.setAnswer(() => pending.promise);
  const checking = f.controller.check(); f.background(); const count = f.views.length; pending.resolve({ status: 200, headers: {}, body: JSON.stringify(stopped) }); await checking;
  assert.equal(f.cancelled.length, 1); assert.equal(f.views.length, count); assert.equal(f.view.canStart, undefined);
});

test('changed reviewed helper cannot be silently saved', async () => {
  const f = fixture(); await f.controller.reviewSetup(); f.setGrant({ schema_version: 1, host_control: { ...control, helper_id: 'c'.repeat(32) }, credential }); await f.controller.allow();
  assert.equal(f.values.size, 0); assert.match(f.view.detail, /changed during review/);
});

test('cached helper is not reused by another pairing and Forget removes protected helper permission', async () => {
  const f = fixture(); await f.allow(); const saved = JSON.parse(f.values.get(HOST_START_STORAGE_KEY)!); saved.pairing.device_id = 'another-phone'; f.values.set(HOST_START_STORAGE_KEY, JSON.stringify(saved));
  const fresh = fixture(); fresh.values.set(HOST_START_STORAGE_KEY, JSON.stringify(saved)); await fresh.controller.load(); await fresh.controller.check(); assert.equal(fresh.helper.length, 0); assert.equal(fresh.view.configured, false);
  await clearSavedPairing(f.store); assert.equal(f.values.has(HOST_START_STORAGE_KEY), false);
});

test('native helper bridge is independently scoped and never reconfigures global paired trust', () => {
  const kotlin = fs.readFileSync(new URL('../modules/tli-transport/android/src/main/java/expo/modules/tlitransport/TliTransportModule.kt', import.meta.url), 'utf8');
  const swift = fs.readFileSync(new URL('../modules/tli-transport/ios/TliTransportModule.swift', import.meta.url), 'utf8');
  for (const source of [kotlin, swift]) { const body = source.split('AsyncFunction("requestHelper")')[1]!.split('Function("cancel")')[0]!; assert.match(body, /helperRequest/); assert.doesNotMatch(body, /resetLocked|self\.transport\s*=/); }
  assert.match(kotlin, /state\.helperClient\?\.let \{ closeClient\(it\) \}/); assert.match(swift, /self\?\.helpers\.removeValue/);
});

test('Forget queues after an in-flight helper save and cannot resurrect its credential', async () => {
  const values = new Map<string, string>(), pending = deferred<void>(), events: string[] = [];
  const store = orderedPairingStore({ get: async key => values.get(key) || null, set: async (key, value) => { events.push('set:'+key); if (key === HOST_START_STORAGE_KEY) await pending.promise; values.set(key, value); }, remove: async key => { events.push('remove:'+key); values.delete(key); } });
  const saving = store.set(HOST_START_STORAGE_KEY, 'restricted credential'); await Promise.resolve();
  const forgetting = clearSavedPairing(store); await Promise.resolve(); assert.equal(events.length, 1);
  pending.resolve(); await Promise.all([saving, forgetting]); assert.equal(values.has(HOST_START_STORAGE_KEY), false); assert.equal(events.at(-1), 'remove:'+HOST_START_STORAGE_KEY);
});

test('a replacement pairing and its helper save follow an older delayed helper write', async () => {
  const values = new Map<string, string>(), pending = deferred<void>(); let writes = 0;
  const store = orderedPairingStore({ get: async key => values.get(key) || null, set: async (key, value) => { if (++writes === 1) await pending.promise; values.set(key, value); }, remove: async key => { values.delete(key); } });
  const old = store.set(HOST_START_STORAGE_KEY, 'old'); const pairingSave = savePairing(store, { ...pairing, device_id:'new-phone' });
  pending.resolve(); await pairingSave; await store.set(HOST_START_STORAGE_KEY, 'new'); await old; assert.equal(values.get(HOST_START_STORAGE_KEY), 'new');
});
