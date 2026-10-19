import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewWorkspace } from '../src/workspace-preview';
import type { Conversation } from '../src/types';

test('preview deletion follows the host endpoint and does not implement the nonexistent AI alias', () => {
  const preview = new PreviewWorkspace();
  const rows: Conversation[] = [{ id: 'chat one', title: 'Selected', messages: [] },
    { id: 'chat-two', title: 'Retained', messages: [] }];
  assert.equal(preview.request('/api/ai/conversations/chat%20one', 'DELETE', {}, rows), undefined);
  assert.equal(rows.length, 2);
  const response = preview.request('/conversations/chat%20one', 'DELETE', {}, rows)!;
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, existed: true });
  assert.deepEqual(rows.map(row => row.id), ['chat-two']);
  assert.deepEqual(JSON.parse(preview.request('/conversations/chat%20one', 'DELETE', {}, rows)!.body), { ok: true, existed: false });
  assert.equal(preview.request('/conversations/chat-two/extra', 'DELETE', {}, rows), undefined);
  assert.equal(rows.length, 1);
});
