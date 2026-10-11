import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type NativeRequest, type NativeResponse, type Transport } from '../src/client';
import { DataHealthCheck, dataHealthLabel, validateDataHealth } from '../src/data-health';
import { sampleDataHealth } from '../src/data-health-preview';
import PreviewTransport from '../modules/tli-transport/index.web';

class FakeTransport implements Transport {
  requests: NativeRequest[] = [];
  async configure() {} async reset() {} cancel() {}
  addListener() { return { remove() {} }; }
  respond: (request: NativeRequest) => Promise<NativeResponse> = async () => ({ status: 200, headers: { 'cache-control': 'no-store' }, body: JSON.stringify(sampleDataHealth()) });
  request(request: NativeRequest) { this.requests.push(request); return this.respond(request); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const response = (value: unknown): NativeResponse => ({ status: 200, headers: {}, body: JSON.stringify(value) });
const harness = () => { const transport = new FakeTransport(); return { transport, client: new Client(transport, 'test-only-owner-credential'), checks: new DataHealthCheck() }; };

test('data-health validation requires every distinct store check, its host, time and unknown backup status', () => {
  const good = sampleDataHealth();
  assert.deepEqual(validateDataHealth(good, 'sample-home'), good);
  const invalid: unknown[] = [undefined, {}, { ...good, schema_version: 2 }, { ...good, checked_at: 'not a date' }, { ...good, checks: good.checks.slice(1) }, { ...good, checks: [good.checks[0], good.checks[0], good.checks[2]] }, { ...good, checks: good.checks.map(check => ({ ...check, status: 'healthy' })) }, { ...good, backup: { status: 'verified', detail: 'Unsupported claim' } }, { ...good, guidance: { ...good.guidance, steps: [''] } }];
  for (const value of invalid) assert.throws(() => validateDataHealth(value, 'sample-home'), /incomplete or unsupported/);
  assert.throws(() => validateDataHealth(good, 'different-home'), /could not confirm/);
  assert.throws(() => validateDataHealth(good, ''), /could not confirm/);
});

test('unavailable, not-created and not-checked remain separate from readable data or verified backup', () => {
  const fixture = validateDataHealth(sampleDataHealth(true), 'sample-home');
  assert.deepEqual(fixture.checks.map(check => check.status), ['unavailable', 'not_checked', 'not_created']);
  assert.equal(fixture.backup.status, 'unknown');
  assert.equal(dataHealthLabel('readable'), 'Readable at check time');
  assert.equal(dataHealthLabel('unavailable'), 'Unavailable');
  assert.equal(dataHealthLabel('not_created'), 'Not created');
  assert.equal(dataHealthLabel('not_checked'), 'Not checked');
});

test('an explicit check sends one authenticated GET with no body; creating the controller sends nothing', async () => {
  const h = harness();
  assert.equal(h.transport.requests.length, 0);
  assert.deepEqual(h.checks.snapshot, { busy: false, stale: false, error: '' });
  assert.equal(await h.checks.check(h.client, 'sample-home'), true);
  const request = h.transport.requests[0]!;
  assert.equal(request.path, '/api/intelligence/data-health'); assert.equal(request.method, 'GET'); assert.equal(request.body, undefined);
  assert.equal(request.headers.Authorization, 'Bearer test-only-owner-credential');
  assert.equal(h.checks.snapshot.checkedFor, h.client);
  assert.equal(h.checks.snapshot.data?.backup.status, 'unknown'); assert.equal(h.checks.snapshot.stale, false);
});

test('simultaneous check requests cannot start competing reads', async () => {
  const h = harness(), pending = deferred<NativeResponse>();
  h.transport.respond = () => pending.promise;
  const first = h.checks.check(h.client, 'sample-home');
  assert.equal(h.checks.snapshot.busy, true);
  assert.equal(await h.checks.check(h.client, 'sample-home'), false);
  assert.equal(h.transport.requests.length, 1);
  pending.resolve(response(sampleDataHealth())); assert.equal(await first, true);
  assert.equal(h.checks.snapshot.busy, false);
});

test('failed refresh retains previous results and checked time as stale, without retrying', async () => {
  const h = harness();
  await h.checks.check(h.client, 'sample-home');
  const previous = h.checks.snapshot.data;
  h.transport.respond = async () => ({ status: 503, headers: {}, body: JSON.stringify({ detail: 'Store check unavailable' }) });
  assert.equal(await h.checks.check(h.client, 'sample-home'), false);
  assert.equal(h.checks.snapshot.data, previous); assert.equal(h.checks.snapshot.data?.checked_at, previous?.checked_at);
  assert.equal(h.checks.snapshot.stale, true); assert.equal(h.checks.snapshot.error, 'Store check unavailable');
  assert.equal(h.transport.requests.length, 2); assert.equal(h.checks.snapshot.busy, false);
});

test('malformed and different-host responses cannot overwrite a successful previous check', async () => {
  const h = harness(); await h.checks.check(h.client, 'sample-home');
  const previous = h.checks.snapshot.data;
  for (const value of [{}, { ...sampleDataHealth(), host: { id: 'other', name: 'Another TLI' } }]) {
    h.transport.respond = async () => response(value);
    assert.equal(await h.checks.check(h.client, 'sample-home'), false);
    assert.equal(h.checks.snapshot.data, previous); assert.equal(h.checks.snapshot.stale, true);
  }
});

test('pairing reset clears data and isolates late completion from a new owner check on the same host', async () => {
  const h = harness(), nextTransport = new FakeTransport(), nextClient = new Client(nextTransport, 'different-owner-credential');
  await h.checks.check(h.client, 'sample-home');
  const oldResponse = deferred<NativeResponse>(), nextResponse = deferred<NativeResponse>();
  h.transport.respond = () => oldResponse.promise; nextTransport.respond = () => nextResponse.promise;
  const old = h.checks.check(h.client, 'sample-home');
  h.checks.clear(); assert.equal(h.checks.snapshot.data, undefined); assert.equal(h.checks.snapshot.checkedFor, undefined);
  const next = h.checks.check(nextClient, 'sample-home');
  oldResponse.resolve(response(sampleDataHealth(true))); assert.equal(await old, false);
  assert.equal(h.checks.snapshot.data, undefined); assert.equal(h.checks.snapshot.busy, true);
  nextResponse.resolve(response(sampleDataHealth())); assert.equal(await next, true);
  assert.equal(h.checks.snapshot.checkedFor, nextClient); assert.equal(validateDataHealth(h.checks.snapshot.data, 'sample-home').checks[0]?.status, 'readable');
});

test('background or changed-session completions stay stale and never become current without another explicit check', async () => {
  const h = harness(); await h.checks.check(h.client, 'sample-home');
  const previous = h.checks.snapshot.data, pending = deferred<NativeResponse>();
  h.transport.respond = () => pending.promise;
  const reading = h.checks.check(h.client, 'sample-home');
  h.checks.suspend(); pending.resolve(response(sampleDataHealth(true))); assert.equal(await reading, false);
  assert.equal(h.checks.snapshot.data, previous); assert.equal(h.checks.snapshot.stale, true); assert.equal(h.checks.snapshot.busy, false);
  assert.equal(h.transport.requests.length, 2);
  let current = true; const late = deferred<NativeResponse>(); h.transport.respond = () => late.promise;
  const changed = h.checks.check(h.client, 'sample-home', () => current);
  current = false; late.resolve(response(sampleDataHealth(true))); assert.equal(await changed, false);
  assert.equal(h.checks.snapshot.data, previous); assert.equal(h.checks.snapshot.stale, true);
});

test('browser fixture supplies only synthetic no-store checks and rejects data mutations', async () => {
  const result = await PreviewTransport.request({ id: 'fixture-read', path: '/api/intelligence/data-health', method: 'GET', headers: {} });
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  const data = validateDataHealth(JSON.parse(result.body), 'sample-home');
  assert.match(data.scope, /No real host files/);
  assert.match(data.guidance.summary, /phone is not a backup/);
  assert.equal((await PreviewTransport.request({ id: 'fixture-write', path: '/api/intelligence/data-health', method: 'POST', headers: {} })).status, 405);
});

test('an interrupted first check cannot return to the misleading never-checked state', async () => {
  const h = harness(), pending = deferred<NativeResponse>();
  h.transport.respond = () => pending.promise;
  const reading = h.checks.check(h.client, 'sample-home');
  h.checks.suspend(); pending.resolve(response(sampleDataHealth())); await reading;
  assert.equal(h.checks.snapshot.data, undefined); assert.match(h.checks.snapshot.error, /interrupted/);
  assert.equal(h.transport.requests.length, 1);
});
