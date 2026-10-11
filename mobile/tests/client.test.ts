import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, Client, InterruptedError, type NativeRequest, type NativeResponse, type Transport } from '../src/client';

class FakeTransport implements Transport {
  requests: NativeRequest[] = []; cancelled: string[] = [];
  handlers: Record<string, Set<(event: any) => void>> = { onHeaders: new Set(), onChunk: new Set() };
  async configure() {} async reset() {}
  cancel(id: string) { this.cancelled.push(id); }
  addListener(name: 'onHeaders' | 'onChunk', handler: (event: any) => void) { this.handlers[name]!.add(handler); return { remove: () => this.handlers[name]!.delete(handler) }; }
  emit(name: string, event: unknown) { this.handlers[name]!.forEach(handler => handler(event)); }
  respond: (request: NativeRequest) => Promise<NativeResponse> = async () => ({ status: 200, headers: {}, body: '{}' });
  request(request: NativeRequest) { this.requests.push(request); return this.respond(request); }
}
test('pairing redemption omits Authorization, authenticated operations use owner credential', async () => {
  const transport = new FakeTransport();
  await new Client(transport, '').json('/api/companion/v1/pairings/redeem', 'POST', { token: 'invitation' });
  assert.equal(transport.requests[0]?.headers.Authorization, undefined);
  await new Client(transport, 'paired-owner').json('/api/ai/conversations');
  assert.equal(transport.requests[1]?.headers.Authorization, 'Bearer paired-owner');
});
test('revoked credential invalidates once and never falls back or retries', async () => {
  const transport = new FakeTransport(); let invalidated = 0;
  transport.respond = async () => ({ status: 401, headers: {}, body: '{"detail":"Phone revoked"}' });
  await assert.rejects(new Client(transport, 'revoked', () => invalidated++).json('/api/ai/conversations'), (error: unknown) => error instanceof ApiError && error.message === 'Phone revoked');
  assert.equal(invalidated, 1); assert.equal(transport.requests.length, 1);
});
test('failed command is sent once and never automatically replayed', async () => {
  const transport = new FakeTransport(); transport.respond = async () => { throw new Error('Wi-Fi lost'); };
  await assert.rejects(new Client(transport, 'valid').json('/homepower/scenes/run', 'POST', { scene_id: 'evening' }), /Wi-Fi lost/);
  assert.equal(transport.requests.length, 1);
});
test('native connection and certificate failures mark offline; HTTP errors and cancellation do not', async () => {
  const transport = new FakeTransport(); let offline = 0;
  const client = new Client(transport, 'valid', () => {}, () => offline++);
  for (const code of ['E_NETWORK', 'E_TLS_TRUST', 'E_LOCAL_NETWORK_PERMISSION', 'E_TIMEOUT']) {
    transport.respond = async () => { throw Object.assign(new Error(code), { code }); };
    await assert.rejects(client.json('/api/intelligence/devices'), new RegExp(code));
  }
  assert.equal(offline, 4);
  transport.respond = async () => { throw Object.assign(new Error('Cancelled'), { code: 'E_CANCELLED' }); };
  await assert.rejects(client.json('/api/intelligence/devices'), /Cancelled/);
  transport.respond = async () => ({ status: 409, headers: {}, body: '{"detail":"Busy"}' });
  await assert.rejects(client.json('/api/intelligence/devices'), /Busy/); assert.equal(offline, 4);
});
test('stream subscriptions precede request, filter request IDs and are removed on completion', async () => {
  const transport = new FakeTransport();
  transport.respond = async ({ id }) => {
    transport.emit('onHeaders', { id, status: 200, headers: {} });
    transport.emit('onChunk', { id: 'other', chunk: 'malformed' });
    transport.emit('onChunk', { id, chunk: 'data: {"type":"meta","session_id":"desktop-chat"}\n\ndata: {"type":"del' });
    transport.emit('onChunk', { id, chunk: 'ta","text":"Hello"}\n\ndata: {"type":"done"}\n\n' });
    return { status: 200, headers: {}, body: '' };
  };
  const events: string[] = []; await new Client(transport, 'valid').stream('/api/ai/chat/stream', {}, e => events.push(e.type));
  assert.deepEqual(events, ['meta', 'delta', 'done']); assert.equal(transport.handlers.onChunk!.size, 0); assert.equal(transport.handlers.onHeaders!.size, 0);
});
test('truncated stream remains interrupted and callbacks are removed', async () => {
  const transport = new FakeTransport();
  transport.respond = async ({ id }) => { transport.emit('onHeaders', { id, status: 200, headers: {} }); transport.emit('onChunk', { id, chunk: 'data: {"type":"delta","text":"Partial"}\n\ndata: {"type":"done"}\n' }); return { status: 200, headers: {}, body: '' }; };
  await assert.rejects(new Client(transport, 'valid').stream('/api/ai/chat/stream', {}, () => {}), InterruptedError);
  assert.equal(transport.requests.length, 1); assert.equal(transport.handlers.onChunk!.size, 0);
});
test('HTTP stream errors are not parsed as SSE and explicit error events fail completion', async () => {
  const transport = new FakeTransport();
  transport.respond = async ({ id }) => { transport.emit('onHeaders', { id, status: 409, headers: {} }); transport.emit('onChunk', { id, chunk: '{"detail":"Vision unavailable"}' }); return { status: 409, headers: {}, body: '{"detail":"Vision unavailable"}' }; };
  await assert.rejects(new Client(transport, 'valid').stream('/api/ai/chat/stream', {}, () => {}), /Vision unavailable/);
  transport.respond = async ({ id }) => { transport.emit('onHeaders', { id, status: 200, headers: {} }); transport.emit('onChunk', { id, chunk: 'data: {"type":"error","detail":"Model stopped"}\n\n' }); return { status: 200, headers: {}, body: '' }; };
  await assert.rejects(new Client(transport, 'valid').stream('/api/ai/chat/stream', {}, () => {}), /Model stopped/);
});
test('foreground cancellation cancels each in-flight request without starting another', async () => {
  const transport = new FakeTransport(); let rejectRequest: (error: Error) => void = () => {};
  transport.respond = () => new Promise((_resolve, reject) => { rejectRequest = reject; });
  const client = new Client(transport, 'valid'); const pending = client.json('/chat', 'POST', { message: 'Hi' });
  client.cancelAll(); assert.deepEqual(transport.cancelled, [transport.requests[0]!.id]); rejectRequest(new Error('Cancelled'));
  await assert.rejects(pending, /Cancelled/); assert.equal(transport.requests.length, 1);
});
