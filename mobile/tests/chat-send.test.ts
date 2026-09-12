import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type NativeRequest, type NativeResponse, type Transport } from '../src/client';
import { ChatSendGuard, sendChat } from '../src/chat-send';
import type { Bootstrap, ChatContext, ChatEvent, Message, NoteContext, ScreenshotReceipt } from '../src/types';

const caseRef = { id: 'case-' + 'a'.repeat(32), revision: 'b'.repeat(64), step_ids: ['step-one'], include_resolution: false, evidence_refs: [] };
const caseReceipt = { schema_version: 1, id: caseRef.id, revision: caseRef.revision, title: 'Printer case', updated_at: '2026-09-08T12:00:00Z', computer_id: null, status: 'open', archived: false, steps: [{ id: 'step-one', status: 'planned' }], omitted_step_count: 1, resolution_included: false, evidence_links: [], omitted_link_count: 0, linked_bodies_included: false, actions_performed: false };
const caseCapability = { ok: true, protocol: 'tli-cases-v1', case_context: 'tli-case-context-v1', actions_performed: false };

class FakeTransport implements Transport {
  requests: NativeRequest[] = [];
  handlers: Record<string, Set<(event: any) => void>> = { onHeaders: new Set(), onChunk: new Set() };
  async configure() {} async reset() {} cancel() {}
  addListener(name: 'onHeaders' | 'onChunk', handler: (event: any) => void) { this.handlers[name]!.add(handler); return { remove: () => this.handlers[name]!.delete(handler) }; }
  emit(name: string, event: unknown) { this.handlers[name]!.forEach(handler => handler(event)); }
  frames(id: string, events: ChatEvent[]) {
    this.emit('onHeaders', { id, status: 200, headers: {} });
    this.emit('onChunk', { id, chunk: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  }
  respond: (request: NativeRequest) => Promise<NativeResponse> = async request => {
    this.frames(request.id, [{ type: 'delta', text: 'An answer' }, { type: 'done' }]);
    return { status: 200, headers: {}, body: '' };
  };
  request(request: NativeRequest) { this.requests.push(request); return this.respond(request); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const response: NativeResponse = { status: 200, headers: {}, body: '' };
test('history opt-out requires explicit host capability and preserves the per-question payload', async () => {
  const h = harness();
  h.transport.respond = async request => request.path.endsWith('/capabilities')
    ? {...response, body:JSON.stringify({ok:true,protocol:'tli-memory-continuity-v1'})}
    : assert.fail('Unsupported host must not receive the question');
  await assert.rejects(h.run({use_conversation_history:false}), /without earlier conversation/);
  assert.equal(h.transport.requests.length,1);
  const second = harness();
  second.transport.respond = async request => {
    if(request.path.endsWith('/capabilities')) return {...response,body:JSON.stringify({ok:true,protocol:'tli-memory-continuity-v1',use_conversation_history:true})};
    second.transport.frames(request.id,[{type:'delta',text:'A completed answer'},{type:'meta',conversation_context:{status:'disabled',use_conversation_history:false,included_messages:0,included_exchanges:0,omitted_messages:0,character_budget:12000}},{type:'done'}]);return response;
  };
  await second.run({use_conversation_history:false});
  assert.equal(JSON.parse(second.transport.requests[1]!.body!).use_conversation_history,false);
  assert.equal((second.updates.at(-1)!.conversation_context as any).status,'disabled');
});

test('stopped or changed history capability checks never send a question later', async () => {
  const h=harness(), pending=deferred<NativeResponse>();
  h.transport.respond=()=>pending.promise;
  const sending=h.run({use_conversation_history:false});
  h.guard.interrupt('Stopped waiting.');
  pending.resolve({...response,body:JSON.stringify({ok:true,protocol:'tli-memory-continuity-v1',use_conversation_history:true})});
  await assert.rejects(sending);
  assert.equal(h.transport.requests.length,1);
});
const bootstrap: Bootstrap = { api_version: 1, node: { id: 'home', name: 'Home host' }, capabilities: { vision: true } };
function harness(guard = new ChatSendGuard()) {
  const transport = new FakeTransport();
  const client = new Client(transport, 'test-only-credential');
  const updates: Message[] = [], ids: string[] = [], errors: unknown[] = [];
  let starts = 0, settled = 0, current = true;
  return {
    transport, client, guard, updates, ids, errors,
    get starts() { return starts; }, get settled() { return settled; },
    changeConversation() { current = false; },
    run(context: ChatContext = {}, options: { bootstrap?: Bootstrap; message?: string } = {}) {
      return sendChat({ client, guard, bootstrap: options.bootstrap || bootstrap, deviceId: 'phone', conversationId: 'existing', message: options.message ?? 'Please explain this.', context,
        isCurrent: () => current,
        onStart: assistant => { starts++; updates.push(assistant); },
        onUpdate: assistant => updates.push(assistant), onConversation: id => ids.push(id),
        onError: error => errors.push(error), onSettled: () => { settled++; },
      });
    },
  };
}

test('confirmed screenshot response preserves reviewed payload and receipt metadata', async () => {
  const h = harness();
  const receipt: ScreenshotReceipt = { task: 'error', computer: { id: 'computer:a', name: 'Desk', node_id: 'a' }, report_id: null, capture: 'user_shared_snapshot', actions_performed: false };
  h.transport.respond = async ({ id }) => {
    h.transport.frames(id, [{ type: 'meta', conversation_id: 'shared', provider: 'bundled', model: 'Qwen', host: { name: 'Home' }, screenshot_context: receipt }, { type: 'delta', text: 'The screenshot shows an error.' }, { type: 'done' }]);
    return response;
  };
  const screenshot = { task: 'error', target_id: 'computer:a', provider_key: 'a'.repeat(64) } as const;
  await h.run({ photo: { uri: 'file:///sample.jpg', base64: 'sample', mime: 'image/jpeg', width: 10, height: 10 }, screenshot, image_provider_key: screenshot.provider_key });
  const request = h.transport.requests[0]!;
  assert.equal(request.path, '/api/ai/chat/stream');
  const body = JSON.parse(request.body!);
  assert.deepEqual(body.screenshot, screenshot); assert.equal(body.image_provider_key, screenshot.provider_key);
  assert.equal(body.retention_days, 0); assert.equal(body.image_mime, 'image/jpeg'); assert.equal(body.device_id, 'phone');
  assert.deepEqual(h.ids, ['shared']);
  const { timing, ...completed } = h.updates.at(-1)!; assert.equal(timing?.outcome, 'complete');
  assert.deepEqual(completed, { role: 'assistant', state: 'complete', content: 'The screenshot shows an error.', provider: 'bundled', model: 'Qwen', host: 'Home', screenshot_context: receipt });
  assert.equal(h.settled, 1); assert.equal(h.guard.busy, false);
});

test('legacy JSON chat resolves only its completed response using the existing route', async () => {
  const h = harness();
  h.transport.respond = async () => ({ ...response, body: JSON.stringify({ reply: 'Local reply', conversation_id: 'shared', model_used: 'Qwen', brain_used: 'LM Studio' }) });
  await h.run({}, { bootstrap: { ...bootstrap, chat: { path: '/chat', streaming: false } } });
  assert.equal(h.transport.requests[0]!.path, '/chat');
  assert.deepEqual(h.ids, ['shared']); assert.equal(h.updates.at(-1)?.state, 'complete'); assert.equal(h.updates.at(-1)?.host, undefined);
});

test('provider failure rejects the caller, keeps partial content, and sends nothing again automatically', async () => {
  const h = harness();
  h.transport.respond = async ({ id }) => {
    h.transport.frames(id, [{ type: 'meta', conversation_id: 'partial-chat' }, { type: 'delta', text: 'Partial explanation' }, { type: 'error', detail: 'Vision unavailable' }]);
    return response;
  };
  await assert.rejects(h.run(), /Vision unavailable/);
  assert.equal(h.transport.requests.length, 1); assert.equal(h.updates.at(-1)?.state, 'interrupted'); assert.equal(h.updates.at(-1)?.content, 'Partial explanation');
  assert.deepEqual(h.ids, ['partial-chat']); assert.equal(h.errors.length, 1); assert.equal(h.guard.busy, false);
});

test('incomplete streams and empty done responses cannot clear the caller draft as success', async () => {
  for (const events of [[{ type: 'delta', text: 'Partial' }], [{ type: 'done' }]] as ChatEvent[][]) {
    const h = harness();
    h.transport.respond = async ({ id }) => { h.transport.frames(id, events); return response; };
    await assert.rejects(h.run(), /interrupted|no answer/i);
    assert.equal(h.updates.at(-1)?.state, 'interrupted'); assert.equal(h.transport.requests.length, 1);
  }
});

test('empty or malformed legacy responses reject without claiming completion', async () => {
  for (const body of ['', '{}', '{"reply":" "}']) {
    const h = harness(); h.transport.respond = async () => ({ ...response, body });
    await assert.rejects(h.run({}, { bootstrap: { ...bootstrap, chat: { path: '/chat', streaming: false } } }), /no answer/);
    assert.equal(h.updates.at(-1)?.state, 'interrupted'); assert.equal(h.transport.requests.length, 1);
  }
});

test('stop and background interruption reject even when native cancellation returns late success', async () => {
  for (const reason of ['Response stopped.', 'Response interrupted while the app was in the background.']) {
    const h = harness(), pending = deferred<NativeResponse>();
    h.transport.respond = ({ id }) => { h.transport.frames(id, [{ type: 'delta', text: 'Partial' }]); return pending.promise; };
    const sending = h.run();
    h.guard.interrupt(reason); h.client.cancelAll();
    h.transport.frames(h.transport.requests[0]!.id, [{ type: 'delta', text: ' late text' }, { type: 'done' }]);
    pending.resolve(response);
    await assert.rejects(sending, error => error instanceof Error && error.message === reason);
    assert.equal(h.updates.at(-1)?.content, 'Partial'); assert.equal(h.updates.at(-1)?.state, 'interrupted');
    assert.equal(h.guard.busy, false); assert.equal(h.settled, 1);
  }
});

test('duplicates and sends during cancellation reject without starting another request', async () => {
  const h = harness(), pending = deferred<NativeResponse>();
  h.transport.respond = () => pending.promise;
  const sending = h.run();
  await assert.rejects(h.run(), /already in progress/);
  h.guard.interrupt('Stopped');
  await assert.rejects(h.run(), /already in progress/);
  assert.equal(h.starts, 1); assert.equal(h.transport.requests.length, 1); assert.equal(h.guard.busy, true);
  pending.resolve(response); await assert.rejects(sending, /Stopped/);
  assert.equal(h.guard.busy, false);
  h.transport.respond = async ({ id }) => { h.transport.frames(id, [{ type: 'delta', text: 'Explicit new attempt' }, { type: 'done' }]); return response; };
  await h.run(); assert.equal(h.transport.requests.length, 2);
});

test('pairing change isolates old events and completion from a new in-flight send', async () => {
  const guard = new ChatSendGuard(), old = harness(guard), next = harness(guard);
  const previousResponse = deferred<NativeResponse>(), nextResponse = deferred<NativeResponse>();
  old.transport.respond = () => previousResponse.promise;
  next.transport.respond = () => nextResponse.promise;
  const previous = old.run();
  guard.invalidate(); old.changeConversation();
  const current = next.run();
  old.transport.frames(old.transport.requests[0]!.id, [{ type: 'meta', conversation_id: 'wrong-home' }, { type: 'delta', text: 'Old answer' }, { type: 'done' }]);
  previousResponse.resolve(response);
  await assert.rejects(previous, /connection changed/i);
  assert.deepEqual(old.ids, []); assert.equal(old.updates.length, 1); assert.equal(old.settled, 0); assert.equal(guard.busy, true);
  next.transport.frames(next.transport.requests[0]!.id, [{ type: 'delta', text: 'Current home' }, { type: 'done' }]);
  nextResponse.resolve(response); await current;
  assert.equal(next.updates.at(-1)?.content, 'Current home'); assert.equal(next.settled, 1); assert.equal(guard.busy, false);
});

test('a changed conversation rejects a late JSON result without replacing its messages', async () => {
  const h = harness(), pending = deferred<NativeResponse>();
  h.transport.respond = () => pending.promise;
  const sending = h.run({}, { bootstrap: { ...bootstrap, chat: { path: '/chat', streaming: false } } });
  h.changeConversation();
  pending.resolve({ ...response, body: JSON.stringify({ reply: 'Old conversation', conversation_id: 'old' }) });
  await assert.rejects(sending, /conversation changed/);
  assert.deepEqual(h.ids, []); assert.equal(h.updates.length, 1); assert.equal(h.guard.busy, false);
});

test('empty submissions and screenshot requests without an image reject before any request', async () => {
  const h = harness();
  await assert.rejects(h.run({}, { message: '  ' }), /Write a question/);
  await assert.rejects(h.run({ screenshot: { task: 'explain', provider_key: 'a'.repeat(64) } }), /Add the screenshot/);
  assert.equal(h.starts, 0); assert.equal(h.transport.requests.length, 0); assert.equal(h.guard.busy, false);
});

test('photos require a reviewed provider; a fresh review can supersede an old capability hint', async () => {
  const h = harness();
  const photo = { uri: 'file:///sample.jpg', base64: 'sample', mime: 'image/jpeg', width: 10, height: 10 } as const;
  for (const key of [undefined, 'invalid']) await assert.rejects(h.run({ photo, image_provider_key: key }), /Review the image provider/);
  assert.equal(h.transport.requests.length, 0);
  await h.run({ photo, image_provider_key: 'b'.repeat(64) }, { bootstrap: { ...bootstrap, capabilities: { vision: false } } });
  assert.equal(h.updates.at(-1)?.state, 'complete'); assert.equal(h.transport.requests.length, 1);
});

test('Notebook sends identifiers and exact revisions only, retaining receipts across SSE and legacy JSON', async () => {
  const receipt: NoteContext = { actions_performed: false, notes: [{ id: 'f-note', revision: 'a'.repeat(64), title: 'Paper', category: 'device', source: 'user' }] };
  for (const streaming of [true, false]) {
    const h = harness();
    h.transport.respond = async ({ id }) => {
      if (!streaming) return { ...response, body: JSON.stringify({ reply: 'Notebook reply', conversation_id: 'notes-chat', note_context: receipt }) };
      h.transport.frames(id, [{ type: 'meta', conversation_id: 'notes-chat', note_context: receipt }, { type: 'delta', text: 'Notebook reply' }, { type: 'done' }]); return response;
    };
    await h.run({ note_refs: receipt.notes }, { bootstrap: { ...bootstrap, chat: { path: streaming ? '/api/ai/chat/stream' : '/chat', streaming } } });
    assert.deepEqual(JSON.parse(h.transport.requests[0]!.body!).note_refs, [{ id: 'f-note', revision: 'a'.repeat(64) }]);
    assert.deepEqual(h.updates.at(-1)?.note_context, receipt);
    assert.equal(h.updates.at(-1)?.state, 'complete');
  }
});

test('invalid mixed Notebook context reaches no request or optimistic message', async () => {
  const h = harness(), note_refs = [{ id: 'f-note', revision: 'a'.repeat(64) }];
  for (const context of [{ target_id: 'printer' }, { diagnostic_id: 'report' }, { screenshot: { task: 'explain', provider_key: 'a'.repeat(64) } }] as ChatContext[]) await assert.rejects(h.run({ ...context, note_refs }), /Notes need their own question/);
  assert.equal(h.transport.requests.length, 0); assert.equal(h.starts, 0); assert.equal(h.guard.busy, false);
});

test('failed Notebook send retains reviewed selections and duplicate guard prevents a second request', async () => {
  const h = harness(), pending = deferred<NativeResponse>();
  const context = { note_refs: [{ id: 'f-note', revision: 'a'.repeat(64) }] }, original = structuredClone(context);
  h.transport.respond = () => pending.promise;
  const sending = h.run(context);
  await assert.rejects(h.run(context), /already in progress/);
  pending.resolve({ status: 409, headers: {}, body: JSON.stringify({ detail: 'A selected note changed. Review it in Notebook.' }) });
  await assert.rejects(sending, /selected note changed/);
  assert.deepEqual(context, original); assert.equal(h.transport.requests.length, 1); assert.equal(h.updates.at(-1)?.state, 'interrupted');
});

test('Notebook command wording stays with the configured LM Studio route and never chooses an intent stream', async () => {
  const h = harness();
  h.transport.respond = async () => ({ ...response, body: JSON.stringify({ reply: 'Notes are context, no action was run.', conversation_id: 'notes-lmstudio', brain_used: 'lmstudio' }) });
  await h.run({ note_refs: [{ id: 'f-note', revision: 'a'.repeat(64) }] }, { bootstrap: { ...bootstrap, chat: { path: '/chat', streaming: false } }, message: 'Turn on the kitchen light' });
  assert.equal(h.transport.requests[0]!.path, '/chat');
  assert.equal(JSON.parse(h.transport.requests[0]!.body!).brain, 'lmstudio');
  assert.equal(h.updates.at(-1)?.provider, 'lmstudio');
});


test('saved-note opt out requires supported host capability before any chat POST', async () => {
  const h = harness();
  h.transport.respond = async request => request.path.endsWith('/capabilities') ? { ...response, body: JSON.stringify({ ok: true, protocol: 'tli-memory-continuity-v1' }) } : (h.transport.frames(request.id, [{ type: 'delta', text: 'Without recall' }, { type: 'done' }]), response);
  await h.run({ use_saved_memory: false });
  assert.deepEqual(h.transport.requests.map(r => [r.path, r.method]), [['/api/intelligence/memory/capabilities', 'GET'], ['/api/ai/chat/stream', 'POST']]);
  assert.equal(JSON.parse(h.transport.requests[1]!.body!).use_saved_memory, false);
  assert.equal(h.transport.requests.some(r => /health|start|diagnostic/.test(r.path)), false);
});
test('unknown opt-out capability and interruption during preflight send no chat request', async () => {
  const h = harness(); h.transport.respond = async () => ({ ...response, body: JSON.stringify({ ok: true, protocol: 'old' }) });
  await assert.rejects(h.run({ use_saved_memory: false }), /Update the TLI host/); assert.equal(h.transport.requests.length, 1);
  const second = harness(), wait = deferred<NativeResponse>(); second.transport.respond = () => wait.promise;
  const sending = second.run({ use_saved_memory: false }); second.guard.interrupt('Stopped waiting.');
  wait.resolve({ ...response, body: JSON.stringify({ ok: true, protocol: 'tli-memory-continuity-v1' }) });
  await assert.rejects(sending, /Stopped waiting/); assert.equal(second.transport.requests.length, 1);
});
test('explicit selected notes cannot be silently sent with saved notes off', async () => {
  const h = harness();
  await assert.rejects(h.run({ use_saved_memory: false, note_refs: [{ id: 'f-note', revision: 'a'.repeat(64) }] }), /Turn on Use saved notes/);
  assert.equal(h.transport.requests.length, 0); assert.equal(h.starts, 0);
});
test('all additive receipts survive SSE and JSON without inventing a host or readiness', async () => {
  const metadata = { memory_context: { use_saved_memory: false, status: 'disabled', notes: [], omitted_for_budget: 0 }, observation_context: { status: 'unknown' }, conversation_context: { status: 'none' }, input_budget: { estimation: 'heuristic' }, document_context: { documents: [] }, source_ref: { conversation_id: 'saved', message_index: 1, revision: 'a'.repeat(64) } };
  for (const streaming of [true, false]) {
    const h = harness(); h.transport.respond = async ({ id }) => {
      if (streaming) h.transport.frames(id, [{ type: 'meta', ...metadata }, { type: 'delta', text: 'Observed reply' }, { type: 'done' }]);
      return streaming ? response : { ...response, body: JSON.stringify({ reply: 'Observed reply', conversation_id: 'saved', ...metadata }) };
    };
    await h.run({}, { bootstrap: { ...bootstrap, chat: { path: streaming ? '/api/ai/chat/stream' : '/chat', streaming } } });
    const final = h.updates.at(-1)!;
    for (const key of Object.keys(metadata)) assert.deepEqual((final as any)[key], (metadata as any)[key]);
    assert.equal(final.host, undefined); assert.equal(h.transport.requests.length, 1); assert.equal(final.timing?.outcome, 'complete');
  }
});
test('first text and Stop timing are recorded before delayed transport settlement', async () => {
  const h = harness(), wait = deferred<NativeResponse>();
  h.transport.respond = ({ id }) => { h.transport.frames(id, [{ type: 'delta', text: 'Partial response' }]); return wait.promise; };
  const pending = h.run(); h.guard.interrupt('Stopped waiting.');
  const stopped = h.updates.at(-1)!; assert.equal(stopped.timing?.outcome, 'interrupted'); assert.ok(stopped.timing?.first_text_ms !== undefined);
  const elapsed = stopped.timing!.elapsed_ms;
  wait.resolve(response); await assert.rejects(pending);
  assert.equal(h.updates.at(-1)!.timing!.elapsed_ms, elapsed); assert.equal(h.updates.at(-1)!.content, 'Partial response');
});

for (const streaming of [true, false]) test(`case request ${streaming ? 'SSE' : 'JSON'} requires fresh capability and preserves reviewed receipt`, async () => {
  const h = harness(); h.transport.respond = async request => {
    if (request.path.endsWith('/cases/capabilities')) return { ...response, body: JSON.stringify(caseCapability) };
    if (!streaming) return { ...response, body: JSON.stringify({ reply: 'Historical user-recorded case answer [C1].', conversation_id: 'case-answer', case_context: caseReceipt }) };
    h.transport.frames(request.id, [{ type: 'meta', case_context: caseReceipt }, { type: 'delta', text: 'Historical user-recorded case answer [C1].' }, { type: 'done' }]); return response;
  };
  await h.run({ case_ref: caseRef }, { message: 'Turn the device off', bootstrap: { ...bootstrap, chat: { path: streaming ? '/api/ai/chat/stream' : '/chat', streaming } } });
  assert.equal(h.transport.requests.length, 2); const request = h.transport.requests[1]!, body = JSON.parse(request.body!);
  assert.equal(request.path, streaming ? '/api/ai/chat/stream' : '/chat'); assert.deepEqual(body.case_ref, caseRef);
  if (!streaming) assert.equal(body.brain, 'lmstudio');
  assert.equal(h.updates.at(-1)!.state, 'complete'); assert.deepEqual(h.updates.at(-1)!.case_context, caseReceipt);
});

for (const reason of ['old-host', 'stop', 'session']) test('case preflight ' + reason + ' sends no question', async () => {
  const h = harness(), pending = deferred<NativeResponse>(); h.transport.respond = () => pending.promise;
  const request = h.run({ case_ref: caseRef }); if (reason === 'stop') h.guard.interrupt('Stopped'); else if (reason === 'session') h.changeConversation();
  pending.resolve({ ...response, body: JSON.stringify(reason === 'old-host' ? { ...caseCapability, case_context: undefined } : caseCapability) });
  await assert.rejects(request); assert.equal(h.transport.requests.length, 1); assert.equal(h.transport.requests[0]!.method, 'GET');
});

for (const bad of [undefined, { ...caseReceipt, actions_performed: true }, { ...caseReceipt, revision: 'f'.repeat(64) }, { ...caseReceipt, steps: [] }]) test('case reply without exact scope confirmation remains interrupted', async () => {
  const h = harness(); h.transport.respond = async request => {
    if (request.path.endsWith('/capabilities')) return { ...response, body: JSON.stringify(caseCapability) };
    h.transport.frames(request.id, [{ type: 'delta', text: 'Partial unconfirmed answer' }, { type: 'meta', case_context: bad }, { type: 'done' }]); return response;
  };
  await assert.rejects(h.run({ case_ref: caseRef }), /did not confirm/); assert.equal(h.updates.at(-1)!.state, 'interrupted'); assert.equal(h.updates.at(-1)!.content, 'Partial unconfirmed answer'); assert.equal(h.transport.requests.length, 2);
});

test('case revision conflict and forced duplicate send make one POST and preserve failure', async () => {
  const h = harness(), pending = deferred<NativeResponse>(); h.transport.respond = async request => request.path.endsWith('/capabilities') ? { ...response, body: JSON.stringify(caseCapability) } : pending.promise;
  const first = h.run({ case_ref: caseRef }); await assert.rejects(h.run({ case_ref: caseRef }), /already in progress/);
  pending.resolve({ status: 409, headers: {}, body: JSON.stringify({ detail: 'Case changed after review' }) }); await assert.rejects(first, /Case changed/);
  assert.equal(h.transport.requests.filter(r => r.method === 'POST').length, 1); assert.equal(h.updates.at(-1)!.state, 'interrupted');
});
