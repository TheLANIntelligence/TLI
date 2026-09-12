import assert from 'node:assert/strict';
import test from 'node:test';
import { SSEParser, chatRoute, outcome, parsePairingCode, validateOrigin } from '../src/protocol';
import type { Bootstrap, ChatEvent } from '../src/types';

test('SSE frames survive every possible chunk boundary including CRLF and Unicode', () => {
  const raw = ': keepalive\r\ndata: {"type":"meta","session_id":"conv-desktop"}\r\n\r\ndata: {"type":"delta","text":"Café 🏡"}\r\n\r\ndata: {"type":"done"}\r\n\r\n';
  for (let split = 0; split <= raw.length; split++) {
    const events: ChatEvent[] = []; const parser = new SSEParser(e => events.push(e));
    parser.push(raw.slice(0, split)); parser.push(raw.slice(split)); parser.finish();
    assert.deepEqual(events.map(e => e.type), ['meta', 'delta', 'done']);
    assert.equal(events[1]?.text, 'Café 🏡'); assert.equal(events[0]?.session_id, 'conv-desktop');
  }
});
test('SSE multiline data, comments, unknown events, and frame limits', () => {
  const events: ChatEvent[] = []; const parser = new SSEParser(e => events.push(e));
  parser.push(':ping\n\nevent: message\ndata: {"type":"delta",\ndata: "text":"hello"}\n\ndata: {"type":"future"}\n\n');
  assert.deepEqual(events, [{ type: 'delta', text: 'hello' }]);
  assert.throws(() => parser.push('data: ' + 'a'.repeat(1_000_001)), /oversized/);
});
test('an incomplete done frame at EOF cannot claim completion', () => {
  for (const tail of ['data: {"type":"done"}', 'data: {"type":"done"}\n', 'data: {"type":"done"}\r\n']) {
    const events: ChatEvent[] = []; const parser = new SSEParser(e => events.push(e)); parser.push(tail); parser.finish(); assert.deepEqual(events, []);
  }
});
test('only secure private IPv4 origins are accepted', () => {
  for (const address of ['https://10.0.0.2:8000', 'https://172.16.0.2', 'https://192.168.1.5', 'https://169.254.1.3']) assert.equal(validateOrigin(address), address);
  for (const address of ['http://192.168.1.2', 'https://127.0.0.1', 'https://8.8.8.8', 'https://172.15.0.2', 'https://tli.local', 'https://user:password@192.168.1.2', 'https://192.168.1.2/other', 'https://192.168.1.2?secret=1']) assert.throws(() => validateOrigin(address));
});
test('pairing rejects expired, malformed, incomplete and foreign codes', () => {
  const code = { version: 1, origin: 'https://192.168.1.2:8000', certificate_der: 'A'.repeat(256), token: 'b'.repeat(32), expires_at: 200, node_id: 'node-a', node_name: 'Home' };
  assert.equal(parsePairingCode(JSON.stringify(code), 100_000).node_id, 'node-a');
  assert.throws(() => parsePairingCode(JSON.stringify(code), 200_000), /expired/);
  assert.throws(() => parsePairingCode(JSON.stringify({ ...code, version: 2 }), 100_000), /incomplete/);
  assert.throws(() => parsePairingCode(JSON.stringify({ ...code, origin: 'http://192.168.1.2' }), 100_000));
  assert.throws(() => parsePairingCode('not-json'), /pairing code/);
});
test('provider routing honors bootstrap while keeping photos and explicit controls on TLI intent stream', () => {
  const bootstrap = { api_version: 1, node: { id: 'a', name: 'Home' }, capabilities: { vision: true }, chat: { path: '/chat', streaming: false } } satisfies Bootstrap;
  assert.deepEqual(chatRoute(bootstrap), { path: '/chat', streaming: false });
  for (const message of ['Turn on the kitchen light', 'Switch the living room light off', 'Run the evening scene']) assert.equal(chatRoute(bootstrap, false, message).path, '/api/ai/chat/stream');
  assert.equal(chatRoute(bootstrap, false, 'Explain this diagnostic report and what I should check next.').path, '/chat');
  assert.equal(chatRoute(bootstrap, false, 'Help me with my printer.').path, '/chat');
  assert.equal(chatRoute(bootstrap, false, 'Check my network!').path, '/api/ai/chat/stream');
  assert.equal(chatRoute(bootstrap, true).path, '/api/ai/chat/stream');
});
test('action receipts show partial failures and empty scenes truthfully', () => {
  assert.equal(outcome({ ok: false, results: [{ ok: true }, { ok: false }] }), 'Partly completed · 1 of 2 actions succeeded');
  assert.equal(outcome({ ok: true, results: [] }), 'This scene has no actions');
  assert.equal(outcome({ ok: false }), 'Action did not complete');
});
