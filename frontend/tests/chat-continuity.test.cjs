const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = app.indexOf('async function sendChat()');
const send = app.slice(start, app.indexOf('// Shelly Chat Helpers', start));
const plain = value => JSON.parse(JSON.stringify(value));
function fixture({ off = false, lm = false, lan = false, fail = false, unsupported = false } = {}) {
  const nodes = Object.fromEntries(['chat-input', 'chat-send-btn', 'abort-chat-btn', 'mode-select', 'temperature-input', 'max-tokens-input'].map(id => [id, { value: '', disabled: false }]));
  nodes['chat-input'].value = 'What did we decide about the studio backup?';
  nodes['mode-select'].value = 'default'; nodes['temperature-input'].value = '.2'; nodes['max-tokens-input'].value = '512';
  const requests = [], decorated = [], userRefs = [], history = [], bubbles = [], requestsEpoch = new WeakMap();
  let epoch = 0, release, block = null;
  const metadata = { session_id: 'saved-thread', conversation_id: 'saved-thread',
    memory_context: { use_saved_memory: !off, status: off ? 'disabled' : 'none', notes: [], omitted_for_budget: 0 },
    conversation_context: { status: 'included', included_messages: 12, included_exchanges: 6, omitted_messages: 0, character_budget: 12000 },
    source_ref: { conversation_id: 'saved-thread', message_index: 1, revision: 'a'.repeat(64) },
    user_source_ref: { conversation_id: 'saved-thread', message_index: 0, revision: 'b'.repeat(64) } };
  const ctx = vm.createContext({ AbortController,
    _chatImageB64: null, _chatImageMime: null, _chatImageReadVersion: 0, _chatImageReading: false,
    window: { TLIMemory: {
      requestContext(context) { context.use_saved_memory = !off; requestsEpoch.set(context, epoch); return context; },
      isCurrent: context => requestsEpoch.get(context) === epoch,
      async ensureAvailable() { if (unsupported) throw Error('Update the host before asking without saved memory.'); },
      decorateReply(bubble, meta) { decorated.push(plain(meta)); },
      decorateMessage(bubble, meta) { userRefs.push(plain(meta)); },
    }, TLIConversationLoad: { invalidate() {} } },
    $: id => nodes[id], showToast() {}, tliSearchIsEnabled: () => false,
    appendMessage(role, text) { const b = { role, textContent: text, innerHTML: '', classList: { remove() {} } }; bubbles.push(b); return b; },
    resolveIntelligenceRoute: async () => ({ source: lan ? 'lan' : 'local', node: lan ? { name: 'Peer', ip: 'fixture' } : null }),
    IntelligenceSource: { LAN_LLM: 'lan', NONE: 'none' }, lastSendTs: 0,
    readSettings: () => ({ defaultBrain: lm ? 'lmstudio' : 'bundled' }), isTeachingMode: () => false, setModelStatus() {}, debugLog() {},
    inFlightController: null, AIStatus: { local: {}, lan: { available: lan } },
    tliFetchBundledStatus: async () => ({ ok: true }), currentConversationId: 'previous-thread', currentDeviceId: 'browser', _currentPanelId: 'panel-main',
    buildContextWrappedMessage: () => assert.fail('Server context must not contain a second browser history'),
    buildSystemInstruction: () => 'System', currentNodeConfig: null, CHAT_CTX_MAX_TURNS: 8, chatHistory: [], CHAT_HISTORY_DRAFT_ID: '__draft__',
    lanAiChat: async () => { requests.push({ url: 'lan' }); return { reply: 'Legacy peer reply' }; },
    tliBundledChatStream: async req => {
      requests.push({ url: 'stream', body: req });
      req.onMeta({ session_id: metadata.session_id }); req.onDelta('The studio backup uses the spare drive.');
      if (block) await block;
      if (fail) throw Error('Connection lost');
      req.onMeta(metadata);
    },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); if (block) await block; return { ok: !fail, status: fail ? 503 : 200, json: async () => fail ? { detail: 'Provider stopped' } : { ...metadata, reply: 'Use the spare drive.' } }; },
    formatModelOutput: text => text, renderAssistantHTML: text => text, _attachSpeakBtn() {}, tliSpeak() {},
    chatHistoryAdd: (role, content) => history.push({ role, content }), saveConversation() {}, addPreviousPrompt() {},
  });
  vm.runInContext(send, ctx);
  return { ctx, nodes, requests, decorated, userRefs, history, bubbles, metadata,
    block() { block = new Promise(resolve => { release = resolve; }); }, release() { release(); },
    leave() { epoch++; nodes['chat-send-btn'].disabled = false; ctx.currentConversationId = null; ctx.window.currentConversationId = null; },
  };
}
for (const lm of [false, true]) test(`${lm ? 'LM Studio' : 'bundled'} receives raw question and opt-out with exact completed context receipts`, async () => {
  const f = fixture({ off: true, lm, lan: true }); await f.ctx.sendChat();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, lm ? '/chat' : 'stream');
  assert.equal(f.requests[0].body.use_saved_memory, false);
  assert.equal(f.requests[0].body.message, 'What did we decide about the studio backup?');
  assert.equal(f.decorated.length, 1); assert.deepEqual(f.decorated[0].memory_context, f.metadata.memory_context);
  assert.deepEqual(f.userRefs, [{ source_ref: f.metadata.user_source_ref }]);
  assert.deepEqual(f.history.map(m => m.role), ['user', 'assistant']);
  assert.equal(f.ctx.window.currentConversationId, 'saved-thread');
});
test('unsupported opt-out makes no generation request and retains the ordinary draft', async () => {
  const f = fixture({ off: true, unsupported: true }); await f.ctx.sendChat();
  assert.equal(f.requests.length, 0); assert.equal(f.decorated.length, 0);
  assert.match(f.nodes['chat-input'].value, /studio backup/); assert.match(f.bubbles[1].textContent, /Update the host/);
  assert.equal(f.nodes['chat-send-btn'].disabled, false);
});
for (const lm of [false, true]) test(`${lm ? 'JSON failure' : 'interrupted stream'} retains the draft without a completed receipt or local replay`, async () => {
  const f = fixture({ lm, fail: true }); await f.ctx.sendChat();
  assert.equal(f.requests.length, 1); assert.equal(f.decorated.length, 0); assert.equal(f.userRefs.length, 0); assert.equal(f.history.length, 0);
  assert.match(f.nodes['chat-input'].value, /studio backup/); assert.match(f.bubbles[1].textContent, /Request failed/);
});
for (const lm of [false, true]) test(`leaving during ${lm ? 'JSON' : 'SSE'} ignores late answers, saved IDs and context controls`, async () => {
  const f = fixture({ lm }); f.block(); const running = f.ctx.sendChat();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.requests.length, 1);
  f.leave(); f.nodes['chat-input'].value = 'Next conversation draft';
  f.release(); await running;
  assert.equal(f.decorated.length, 0); assert.equal(f.history.length, 0);
  assert.equal(f.ctx.currentConversationId, null); assert.equal(f.ctx.window.currentConversationId, null);
  assert.equal(f.nodes['chat-input'].value, 'Next conversation draft');
});
test('duplicate send clicks share one in-flight generation', async () => {
  const f = fixture(); f.block(); const running = f.ctx.sendChat(); await f.ctx.sendChat();
  await new Promise(resolve => setImmediate(resolve)); f.release(); await running;
  assert.equal(f.requests.length, 1); assert.equal(f.decorated.length, 1);
});
test('existing explicit direct-LAN routing remains available with unreported context', async () => {
  const f = fixture({ lan: true }); await f.ctx.sendChat();
  assert.deepEqual(f.requests.map(r => r.url), ['lan']); assert.deepEqual(f.decorated, [{}]); assert.equal(f.userRefs.length, 0);
});
