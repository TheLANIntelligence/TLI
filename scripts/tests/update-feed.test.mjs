import test from 'node:test';
import assert from 'node:assert/strict';
import { updateFeedResponse } from '../../website/update-feed.mjs';

const feed = { version: '1.4.6-beta', minimum_prepare_version: '1.4.6', updater: 'guided-v1', notes: 'Release notes.', platforms: {
  windows: { updater: 'guided-v1', sha256: 'a'.repeat(64), url: 'https://example.test/windows.zip' },
  macos: { updater: 'guided-v1', sha256: 'b'.repeat(64), url: 'https://example.test/mac.zip' },
} };
const response = () => new Response(JSON.stringify(feed), { headers: { 'Content-Type': 'application/json', ETag: 'stale', 'Cache-Control': 'public, max-age=3600' } });
async function check(agent) {
  const result = await updateFeedResponse(new Request('https://example.test/downloads.json', { headers: { 'User-Agent': agent } }), response());
  return { result, body: await result.json() };
}
test('old TLI clients receive manual packages before their validators can reject new paths', async () => {
  for (const agent of ['TLI/1.3.5-beta', 'TLI/1.4.4-beta', 'TLI/1.4.5-beta']) {
    const { result, body } = await check(agent);
    assert.equal(body.updater, 'manual');
    assert.ok(Object.values(body.platforms).every(p => p.updater === 'manual'));
    assert.equal(body.platforms.windows.sha256, feed.platforms.windows.sha256);
    assert.match(body.notes, /one-time upgrade/);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.get('Vary'), 'User-Agent');
    assert.equal(result.headers.get('ETag'), null);
  }
});
test('new compatible clients retain guided downloads and immutable package identity', async () => {
  for (const agent of ['TLI/1.4.6-beta', 'TLI/1.4.7-beta', 'TLI/1.10.0', 'TLI/2.0.0']) {
    const { result, body } = await check(agent);
    assert.deepEqual(body, feed);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});
test('ordinary website requests retain the public fresh-install manifest', async () => {
  const { body } = await check('Mozilla/5.0');
  assert.deepEqual(body, feed);
});
test('missing compatibility metadata never enables old clients by accident', async () => {
  const missing = { ...feed }; delete missing.minimum_prepare_version;
  const result = await updateFeedResponse(new Request('https://example.test/downloads.json', { headers: { 'User-Agent': 'TLI/1.4.5-beta' } }), new Response(JSON.stringify(missing)));
  assert.equal((await result.json()).updater, 'manual');
});
test('only supported older clients receive the separately verified compatibility bridge', async () => {
  const bridge = { ...feed, version: '1.4.6-beta', minimum_prepare_version: '1.4.5', notes: 'One-time updater migration.' };
  const next = { ...feed, version: '1.4.7-beta', compatibility_bridge: bridge };
  for (const [agent, expectedVersion, expectedMethod] of [
    ['TLI/1.4.4-beta', '1.4.7-beta', 'manual'],
    ['TLI/1.4.5-beta', '1.4.6-beta', 'guided-v1'],
    ['TLI/1.4.6-beta', '1.4.7-beta', 'guided-v1'],
    ['TLI/1.4.7-beta', '1.4.7-beta', 'guided-v1'],
  ]) {
    const result = await updateFeedResponse(new Request('https://example.test/downloads.json', { headers: { 'User-Agent': agent } }), new Response(JSON.stringify(next)));
    const body = await result.json();
    assert.equal(body.version, expectedVersion);
    assert.equal(body.updater, expectedMethod);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});
