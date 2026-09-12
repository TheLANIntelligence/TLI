import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewedImageContext, screenshotReceiptText } from '../src/screenshot-help';
import type { ChatContext, ScreenshotReceipt, ScreenshotReview } from '../src/types';

const review: ScreenshotReview = { host: { id: 'home-host', name: 'Home' }, checked_at: '2026-09-06T12:00:00Z',
  computers: [{ id: 'computer-host', name: 'Home', node_id: 'home-host' }, { id: 'computer-peer', name: 'Studio', node_id: 'peer' }],
  provider: { key: 'a'.repeat(64), provider: 'bundled', model: 'vision', destination: 'localhost', port: 8081 } };
const photo = { uri: 'cache://selected.jpg', base64: 'fake-image', mime: 'image/jpeg' as const, width: 300, height: 200 };
const context: ChatContext = { photo, target_id: 'phone-context', diagnostic_id: 'explicit-report' };

test('ordinary photos preserve chosen device and report while adding reviewed provider key', () => {
  const payload = reviewedImageContext(context, review, 'photo', 'unknown', '');
  assert.equal(payload.target_id, 'phone-context'); assert.equal(payload.diagnostic_id, 'explicit-report');
  assert.equal(payload.image_provider_key, review.provider!.key); assert.equal(payload.screenshot, undefined);
  assert.equal(payload.photo, photo);
});
test('text chat stays independent of screenshot review', () => {
  const text: ChatContext = { target_id: 'computer-host' };
  assert.equal(reviewedImageContext(text, undefined, 'error', 'unknown', ''), text);
});
test('unknown, unavailable or malformed provider reviews block photos before upload', () => {
  for (const snapshot of [undefined, { ...review, provider: null }, { ...review, provider: { ...review.provider!, key: '' } }]) {
    assert.throws(() => reviewedImageContext(context, snapshot, 'photo', 'unknown', ''), /Review the AI destination/);
  }
  assert.throws(() => reviewedImageContext(context, { ...review, provider: null, reason: 'Vision unavailable' }, 'error', 'unknown', ''), /Vision unavailable/);
});
test('guided screenshots do not infer computer identity from the phone or ordinary device context', () => {
  const payload = reviewedImageContext(context, review, 'error', 'unknown', '');
  assert.equal(payload.target_id, undefined);
  assert.deepEqual(payload.screenshot, { task: 'error', provider_key: review.provider!.key });
  assert.equal(payload.diagnostic_id, 'explicit-report'); // server validates explicit evidence scope
  assert.equal(context.target_id, 'phone-context');
});
test('each guided task uses only the explicitly selected registered computer', () => {
  for (const task of ['explain', 'error', 'next_step'] as const) {
    const payload = reviewedImageContext({ photo }, review, task, 'computer-peer', 'ignored label');
    assert.equal(payload.screenshot?.target_id, 'computer-peer'); assert.equal(payload.screenshot?.other_computer, undefined);
    assert.equal(payload.screenshot?.task, task); assert.equal(payload.diagnostic_id, undefined);
  }
});
test('disappeared computer targets never fall back to another computer', () => {
  assert.throws(() => reviewedImageContext({ photo }, review, 'error', 'removed-computer', ''), /no longer listed/);
});
test('a labelled other computer is bounded and never becomes a registered ID', () => {
  const payload = reviewedImageContext({ photo }, review, 'next_step', 'other', ' Guest laptop ');
  assert.equal(payload.screenshot?.other_computer, 'Guest laptop'); assert.equal(payload.screenshot?.target_id, undefined);
  assert.throws(() => reviewedImageContext({ photo }, review, 'error', 'other', ' '), /Name the computer/);
  assert.throws(() => reviewedImageContext({ photo }, review, 'error', 'other', 'a'.repeat(121)), /120/);
});
test('rechecking binds the next photo payload to the new reviewed provider, never an automatic retry', () => {
  const first = reviewedImageContext({ photo }, review, 'explain', 'unknown', '');
  const changed = { ...review, provider: { ...review.provider!, key: 'b'.repeat(64), model: 'other vision' } };
  const next = reviewedImageContext({ photo }, changed, 'explain', 'unknown', '');
  assert.equal(first.screenshot?.provider_key, 'a'.repeat(64)); assert.equal(next.screenshot?.provider_key, 'b'.repeat(64));
});
test('shared history receipt describes snapshot scope and no actions while old messages need no receipt', () => {
  const receipt: ScreenshotReceipt = { task: 'error', computer: { name: 'Studio' }, report_id: 'report', capture: 'user_shared_snapshot', actions_performed: false };
  const text = screenshotReceiptText(receipt)!;
  assert.match(text, /Understand an error · Studio · saved diagnostic attached/);
  assert.match(text, /no actions performed/); assert.match(text, /Attach a new image/);
  assert.equal(screenshotReceiptText(), undefined);
  assert.equal(screenshotReceiptText({ ...receipt, actions_performed: true } as unknown as ScreenshotReceipt), undefined);
});
