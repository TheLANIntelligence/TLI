import assert from 'node:assert/strict';
import test from 'node:test';
import { SSEParser, chatRoute, outcome, parsePairingCode, validateOrigin } from '../src/protocol';
import type { Bootstrap, ChatEvent } from '../src/types';
import { redirectPairingLink, takePairingLink } from '../src/pairing-link';

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

const linkNow = 1_900_000_000_000;
function cameraLink(patch: Record<string, string> = {}) {
  const fields = new URLSearchParams({ v: '1', c: 'A'.repeat(256), t: 'b'.repeat(43), e: String(linkNow / 1000 + 300), i: 'node-a', n: 'Living room · TLI', ...patch });
  return 'https://192.168.1.2:8000/api/companion/v1/pair#' + fields;
}
function appLink(scheme = 'tli-companion-beta', patch: Record<string, string> = {}) {
  return scheme + ':///pair#' + cameraLink(patch).split('#')[1] + '&o=' + encodeURIComponent('https://192.168.1.2:8000');
}
test('normal camera URL and both installed-app schemes preserve the reviewed origin/certificate', () => {
  const camera = parsePairingCode(cameraLink(), linkNow);
  for (const scheme of ['tli-companion', 'tli-companion-beta']) assert.deepEqual(parsePairingCode(appLink(scheme), linkNow), camera);
  assert.equal(camera.node_name, 'Living room · TLI'); assert.equal(camera.origin, 'https://192.168.1.2:8000');
  assert.equal(parsePairingCode(cameraLink({ c: 'ab-_'.repeat(32) + 'ab' }), linkNow).certificate_der, 'ab+/'.repeat(32) + 'ab==');
  assert.deepEqual(parsePairingCode(JSON.stringify(camera), linkNow), camera);
});
test('pairing URLs refuse foreign origins, query payloads, duplicate/unknown fields and conflicting origins', () => {
  for (const raw of [
    cameraLink().replace('https:', 'http:'), cameraLink().replace('192.168.1.2', '8.8.8.8'),
    cameraLink().replace('192.168.1.2', 'user:pass@192.168.1.2'), cameraLink().replace('/pair#', '/pair?token=wrong#'),
    cameraLink().replace('/pair#', '/other#'), cameraLink() + '&t=another_token_that_is_long_enough',
    cameraLink() + '&o=https%3A%2F%2F192.168.1.3', cameraLink() + '&future=1', cameraLink({ n: 'Bad\nname' }),
    cameraLink({ c: 'A'.repeat(129) }), cameraLink({ e: 'Infinity' }), cameraLink({ e: String(linkNow / 1000 + 601) }),
    cameraLink({ v: '2' }), cameraLink().replace('node-a', 'bad%ZZ'), appLink().replace(':///pair', '://other/pair'),
    appLink().replace('https%3A%2F%2F192.168.1.2%3A8000', 'http%3A%2F%2F192.168.1.2'),
    appLink().replace(':///pair#', ':///pair?token=x#'), cameraLink({ n: 'A'.repeat(257) }), 'https:' + 'x'.repeat(18000),
  ]) assert.throws(() => parsePairingCode(raw, linkNow));
  assert.throws(() => parsePairingCode(cameraLink({ e: String(linkNow / 1000) }), linkNow), /expired/);
});
test('native link ingress only stages a one-use review reference and never places credentials in navigation', () => {
  const raw = appLink(), route = redirectPairingLink(raw, linkNow)!;
  assert.match(route, /^\/pair\?incoming=\d+$/);
  for (const secret of ['b'.repeat(43), 'A'.repeat(128), '192.168.1.2']) assert.equal(route.includes(secret), false);
  const id = route.split('=')[1]!, candidate = takePairingLink(id);
  assert.equal(parsePairingCode(candidate.raw!, linkNow).token, 'b'.repeat(43));
  assert.equal(takePairingLink(id).raw, undefined);
  assert.equal(redirectPairingLink('tli-companion:///settings'), null);
  const invalid = redirectPairingLink(appLink('tli-companion', { e: '1' }), linkNow)!;
  assert.equal(takePairingLink(invalid.split('=')[1]!).raw, undefined);
});
test('a newer review invitation cannot be consumed under an older navigation reference', () => {
  const first = redirectPairingLink(appLink(), linkNow)!.split('=')[1]!;
  const second = redirectPairingLink(appLink('tli-companion', { n: 'New host' }), linkNow)!.split('=')[1]!;
  assert.equal(takePairingLink(first).raw, undefined);
  assert.equal(parsePairingCode(takePairingLink(second).raw!, linkNow).node_name, 'New host');
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
