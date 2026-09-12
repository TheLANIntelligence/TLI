const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workspace = fs.readFileSync(path.join(__dirname, '../js/chat-workspace.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const sendStart = app.indexOf('async function sendChat()');
const sendEnd = app.indexOf('// Shelly Chat Helpers', sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, 'Extract the production sendChat implementation');
const send = app.slice(sendStart, sendEnd);
const nerve = fs.readFileSync(path.join(__dirname, '../nerve.js'), 'utf8');
const hookStart = nerve.indexOf('function _hookChatStream()');
const hookEnd = nerve.indexOf('// ── Pulse status bar', hookStart);
assert.ok(hookStart >= 0 && hookEnd > hookStart, 'Extract only the production stream hook');
const hook = nerve.slice(hookStart, hookEnd);

function publishWorkspace(ctx) {
  const listeners = [];
  ctx.document = {
    readyState: 'loading',
    createElement(tag) { return { tag, textContent: '', children: [], handlers: {},
      append(...nodes) { this.children.push(...nodes); }, setAttribute() {},
      addEventListener(type, fn) { this.handlers[type] = fn; } }; },
    addEventListener(name, callback) { listeners.push({ name, callback }); },
    getElementById() { assert.fail('Publishing the status predicate must not initialize the chat DOM'); },
  };
  vm.runInContext(workspace, ctx);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].name, 'DOMContentLoaded');
  assert.equal(typeof ctx.window.TLIChatWorkspace.isStatusQuestion, 'function');
  return ctx.window.TLIChatWorkspace;
}

test('the status predicate is available before DOM initialization, without a provider request', () => {
  const ctx = vm.createContext({ window: {}, fetch: () => assert.fail('No requests while publishing helpers') });
  publishWorkspace(ctx);
});

test('selected-note guidance explains standalone context and reports conflicts before preparing a request', () => {
  const ctx = vm.createContext({window:{}, fetch:() => assert.fail('Context guidance must not send anything')});
  const api = publishWorkspace(ctx), notes = [{id:'note:one', label:'Setup', kind:'note'}];
  const mode = api.describeNoteMode(notes);
  assert.equal(mode.blocked, false);
  assert.match(mode.text, /only these notes and your next question.*Earlier chat and other saved notes are excluded.*No actions/);
  const selected = [...notes, {kind:'device'}, {kind:'document'}, {kind:'image'}, {kind:'report'}];
  const blocked = api.describeNoteMode(selected, {savedNotes:false, text:'Use [vault:example]'});
  assert.equal(blocked.blocked, true);
  for (const word of ['device', 'document', 'image', 'report', 'Vault reference', 'Use saved notes is off']) assert.ok(blocked.text.includes(word));
  assert.match(blocked.text, /Nothing is removed automatically/);
  assert.equal(selected.length, 5);
  assert.equal(api.describeNoteMode([{kind:'device'}], {savedNotes:false}), null);
});

for (const question of [
  'Is the Qwen Model running?', 'Is the AI running', 'Is my local AI actually ready?',
  'Check if the AI is running.', 'Can you check whether Qwen is loaded?',
  "What's the status of the model?", 'AI status', 'Is LM Studio online?',
  'Which model are you using?', 'What model is currently loaded?',
]) test(`AI-status question stays out of direct LAN inference: ${question}`, () => {
  const ctx = vm.createContext({ window: {} });
  assert.equal(publishWorkspace(ctx).isStatusQuestion(question), true);
});

for (const question of [
  'Is the AI Fan running?', 'turn on AI', 'turn off Qwen', 'toggle Office Lamp',
  'Is the AI running and turn on my lamp?', 'Why is the model running slowly?',
  'Write a script to check if the AI is running', 'Is my printer running?',
  'What model should I install?', 'Is the AI running in this screenshot?',
]) test(`the status predicate does not steal ordinary questions or named devices: ${question}`, () => {
  const ctx = vm.createContext({ window: {} });
  assert.equal(publishWorkspace(ctx).isStatusQuestion(question), false);
});

function chatFixture({ message, lm = false } = {}) {
  const nodes = Object.fromEntries(['chat-input', 'chat-send-btn', 'abort-chat-btn', 'mode-select', 'temperature-input', 'max-tokens-input']
    .map(id => [id, { value: '', disabled: false }]));
  nodes['chat-input'].value = message;
  nodes['mode-select'].value = 'default';
  nodes['temperature-input'].value = '.2';
  nodes['max-tokens-input'].value = '512';
  const requests = [], bubbles = [], history = [], healthCalls = [];
  const ctx = vm.createContext({ AbortController,
    _chatImageB64: null, _chatImageMime: null, _chatImageReadVersion: 0, _chatImageReading: false,
    window: { TLIMemory: {
      requestContext(context) { context.use_saved_memory = true; return context; },
      isCurrent: () => true, async ensureAvailable() {}, decorateReply() {}, decorateMessage() {},
    }, TLIConversationLoad: { invalidate() {} } },
    $: id => nodes[id], showToast() {}, tliSearchIsEnabled: () => false,
    appendMessage(role, text) {
      const bubble = { role, textContent: text, htmlWrites: [], children: [], append(...nodes) { this.children.push(...nodes); }, classList: { remove() {}, add() {} } };
      Object.defineProperty(bubble, 'innerHTML', { get: () => bubble.htmlWrites.at(-1) || '', set: value => bubble.htmlWrites.push(value) });
      bubbles.push(bubble); return bubble;
    },
    resolveIntelligenceRoute: async () => { healthCalls.push('route'); return { source: 'lan', node: { name: 'Synthetic peer', ip: '192.0.2.40' } }; },
    IntelligenceSource: { LAN_LLM: 'lan', NONE: 'none' }, lastSendTs: 0,
    readSettings: () => ({ defaultBrain: lm ? 'lmstudio' : 'bundled' }), isTeachingMode: () => false, setModelStatus() { healthCalls.push('health-report'); }, debugLog() {},
    inFlightController: null, AIStatus: { local: {available:true,provider:'bundled'}, lan: { available: true } },
    tliFetchBundledStatus: async () => { healthCalls.push('bundled-probe'); return { ok: true }; }, currentConversationId: 'existing-thread', currentDeviceId: 'browser', _currentPanelId: 'panel-main',
    buildSystemInstruction: () => 'Synthetic instruction', currentNodeConfig: null, CHAT_CTX_MAX_TURNS: 8, chatHistory: [], CHAT_HISTORY_DRAFT_ID: '__draft__',
    lanAiChat: async request => { requests.push({ url: 'lan', body: request.payload }); return { reply: 'Synthetic ordinary answer' }; },
    tliBundledChatStream: async request => {
      requests.push({ url: 'stream', body: request });
      request.onMeta({ session_id: 'existing-thread', handled_by: 'ai_status', provider: 'tli-status' });
      request.onDelta('The bundled AI is not currently confirmed running.');
    },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ reply: 'LM Studio readiness is unknown.', conversation_id: 'existing-thread', handled_by: 'ai_status' }) };
    },
    formatModelOutput: text => text, renderAssistantHTML: text => text, _attachSpeakBtn() {}, tliSpeak() {},
    chatHistoryAdd: (role, content) => history.push({ role, content }), saveConversation() {}, addPreviousPrompt() {},
  });
  publishWorkspace(ctx);
  vm.runInContext(send, ctx);
  return { ctx, requests, nodes, bubbles, history, healthCalls };
}

function responseSpy(fixture) {
  const calls = [], handles = [];
  fixture.ctx.window.TLIChatWorkspace.beginResponse = () => {
    assert.equal(fixture.nodes['chat-send-btn'].disabled, true, 'Send is reserved before showing pending state');
    const id = handles.length;
    calls.push({ type: 'begin', id });
    const handle = { responding: () => calls.push({ type: 'responding', id }), finish: () => calls.push({ type: 'finish', id }) };
    handles.push(handle); return handle;
  };
  return { calls, handles, types: () => calls.map(call => call.type) };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pending state begins before slow route resolution and finishes on direct LAN success', async () => {
  const f = chatFixture({ message: 'Explain how a home network works.' }), spy = responseSpy(f), route = deferred();
  let resolving = false;
  f.ctx.resolveIntelligenceRoute = () => { assert.deepEqual(spy.types(), ['begin']); resolving = true; return route.promise; };
  const sending = f.ctx.sendChat();
  assert.equal(resolving, true); assert.deepEqual(spy.types(), ['begin']); assert.equal(f.requests.length, 0);
  route.resolve({ source: 'lan', node: { name: 'Synthetic peer', ip: '192.0.2.40' } }); await sending;
  assert.deepEqual(f.requests.map(request => request.url), ['lan']); assert.deepEqual(spy.types(), ['begin', 'responding', 'finish']);
});

for (const staleDuring of ['route', 'LAN answer']) test(`pending handle finishes on an early stale return during ${staleDuring}`, async () => {
  const f = chatFixture({ message: 'Explain how a home network works.' }), spy = responseSpy(f), pending = deferred();
  if (staleDuring === 'route') f.ctx.resolveIntelligenceRoute = () => pending.promise;
  else f.ctx.lanAiChat = () => pending.promise;
  const sending = f.ctx.sendChat(); await tick();
  assert.deepEqual(spy.types(), ['begin']);
  f.ctx.window.TLIMemory.isCurrent = () => false;
  pending.resolve(staleDuring === 'route' ? { source: 'lan', node: { name: 'Synthetic peer' } } : { reply: 'Late answer' });
  await sending;
  assert.deepEqual(spy.types(), ['begin', 'finish']); assert.deepEqual(f.history, []);
});

for (const outcome of ['success', 'failure', 'abort']) test(`stream ${outcome} ends its pending state and preserves the waiting bubble until first content`, async () => {
  const f = chatFixture({ message: 'Explain how a home network works.' }), spy = responseSpy(f), firstContent = deferred();
  let waitingForContent = false;
  f.ctx.resolveIntelligenceRoute = async () => ({ source: 'local' });
  f.ctx.tliBundledChatStream = async request => {
    f.requests.push({ url: 'stream', body: request });
    const bubble = f.bubbles[1];
    assert.ok(bubble.textContent.trim(), 'Waiting message remains visible before any delta');
    assert.deepEqual(bubble.htmlWrites, [], 'The waiting bubble was not cleared before the stream');
    request.onMeta({ session_id: 'existing-thread', handled_by: 'bundled' }); request.onDelta('');
    assert.deepEqual(spy.types(), ['begin'], 'Metadata and empty deltas are not an answer');
    assert.deepEqual(bubble.htmlWrites, []);
    waitingForContent = true;
    if (outcome === 'abort') request.signal.addEventListener('abort', firstContent.resolve, { once: true });
    await firstContent.promise;
    if (outcome === 'abort') {
      assert.equal(request.signal.aborted, true);
      throw Object.assign(new Error('Cancelled by fixture'), { name: 'AbortError' });
    }
    request.onDelta('First content'); request.onDelta(' and continuation.');
    assert.deepEqual(spy.types(), ['begin', 'responding'], 'Responding starts once on actual content');
    if (outcome === 'failure') throw new Error('Connection lost after partial response');
  };
  const sending = f.ctx.sendChat(); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(spy.types(), ['begin']); assert.equal(waitingForContent, true);
  if (outcome === 'abort') f.ctx.inFlightController.abort(); else firstContent.resolve();
  await sending;
  assert.deepEqual(spy.types(), outcome === 'abort' ? ['begin', 'finish'] : ['begin', 'responding', 'finish']);
  assert.equal(f.nodes['chat-send-btn'].disabled, false);
  assert.equal(f.nodes['abort-chat-btn'].disabled, true);
  if (outcome !== 'success') assert.deepEqual(f.history, []);
});

for (const stopped of [false, true]) test(`partial reply remains readable after ${stopped ? 'Stop' : 'provider failure'} and review never sends a retry`, async () => {
  const f = chatFixture({ message: 'Explain my network report.' });
  f.ctx.resolveIntelligenceRoute = async () => ({source:'local'});
  f.ctx.tliBundledChatStream = async request => {
    f.requests.push({url:'stream'}); request.onDelta('The gateway answered. '); request.onDelta('DNS was not tested.');
    f.nodes['chat-input'].value = 'A newer draft';
    if (stopped) throw Object.assign(new Error('Aborted'), {name:'AbortError'});
    throw new Error('Connection interrupted');
  };
  await f.ctx.sendChat();
  const bubble = f.bubbles[1], notice = bubble.children.at(-1);
  assert.equal(bubble.innerHTML, 'The gateway answered. DNS was not tested.');
  assert.equal(notice.children[0].textContent, 'Incomplete response');
  assert.match(notice.children[1].textContent, /partial reply remains above.*No request was retried.*Review your question/);
  assert.doesNotMatch(notice.children[1].textContent, /Request cancelled/);
  assert.equal(f.nodes['chat-input'].value, 'A newer draft');
  const retry = notice.children[2]; retry.handlers.click();
  assert.equal(f.nodes['chat-input'].value, 'A newer draft'); assert.equal(f.requests.length, 1);
  f.nodes['chat-input'].value = ''; retry.handlers.click();
  assert.equal(f.nodes['chat-input'].value, 'Explain my network report.'); assert.equal(f.requests.length, 1);
  assert.equal(f.history.length, 0, 'Incomplete text is not saved as a completed exchange');
  assert.equal(f.nodes['chat-send-btn'].disabled, false);
  f.ctx.window.TLIMemory.isCurrent = () => false; f.nodes['chat-input'].value = ''; retry.handlers.click();
  assert.equal(f.nodes['chat-input'].value, '', 'Expired review cannot restore private text after lock');
});

test('sequential sends receive independent pending handles', async () => {
  const f = chatFixture({ message: 'First question' }), spy = responseSpy(f);
  await f.ctx.sendChat(); f.nodes['chat-input'].value = 'Second question'; await f.ctx.sendChat();
  assert.equal(spy.handles.length, 2); assert.notEqual(spy.handles[0], spy.handles[1]);
  assert.deepEqual(spy.calls, [{ type: 'begin', id: 0 }, { type: 'responding', id: 0 }, { type: 'finish', id: 0 }, { type: 'begin', id: 1 }, { type: 'responding', id: 1 }, { type: 'finish', id: 1 }]);
});

for (const blockedBy of ['empty question', 'active request', 'invalid context', 'image still reading', 'search review']) test(`no pending indicator starts for ${blockedBy}`, async () => {
  const f = chatFixture({ message: blockedBy === 'empty question' ? '  ' : 'Explain how a home network works.' }), spy = responseSpy(f);
  if (blockedBy === 'active request') f.nodes['chat-send-btn'].disabled = true;
  if (blockedBy === 'invalid context') f.ctx.window.TLIMemory.requestContext = () => { throw new Error('Review the selected context first'); };
  if (blockedBy === 'image still reading') f.ctx._chatImageReading = true;
  if (blockedBy === 'search review') {
    f.ctx.tliSearchIsEnabled = () => true; f.ctx.tliShouldGateForSearch = () => true; f.ctx.tliShowSearchBannerFor = () => {};
  }
  await f.ctx.sendChat(); assert.deepEqual(spy.calls, []); assert.equal(f.requests.length, 0); assert.equal(f.bubbles.length, 0);
});

for (const lm of [false, true]) for (const message of ['Is the Qwen Model running?', 'Is the AI running']) {
  test(`sendChat uses the ${lm ? 'LM Studio' : 'bundled'} status handler despite a selected LAN peer: ${message}`, async () => {
    const fixture = chatFixture({ message, lm });
    await fixture.ctx.sendChat();
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].url, lm ? '/chat' : 'stream');
    assert.equal(fixture.requests[0].body.message, message);
    assert.equal(fixture.requests[0].body.use_saved_memory, true);
    if (lm) assert.equal(fixture.requests[0].body.brain, 'lmstudio');
    assert.deepEqual(fixture.history.map(turn => turn.role), ['user', 'assistant']);
    assert.equal(fixture.nodes['chat-send-btn'].disabled, false);
    assert.deepEqual(fixture.healthCalls, [], 'status must not trigger client health-report inference or route refresh');
    assert.equal(fixture.ctx.AIStatus.local.available, true, 'asking about readiness must not overwrite the observed provider state');
  });
}

test('sendChat retains direct LAN inference for an ordinary general question', async () => {
  const message = 'Explain how a home network works.';
  const fixture = chatFixture({ message });
  await fixture.ctx.sendChat();
  assert.deepEqual(fixture.requests.map(request => request.url), ['lan']);
  assert.equal(fixture.requests[0].body.messages.at(-1).content, message);
  assert.equal(fixture.nodes['chat-send-btn'].disabled, false);
});

test('uncertain LAN failure preserves the draft and never falls through to another generation request', async () => {
  const f = chatFixture({message:'Explain the printer setup.'});
  f.ctx.lanAiChat = async () => { f.requests.push({url:'lan'}); throw new Error('The peer connection was lost.'); };
  await f.ctx.sendChat();
  assert.deepEqual(f.requests.map(r=>r.url), ['lan']);
  assert.equal(f.nodes['chat-input'].value, 'Explain the printer setup.');
  assert.equal(f.nodes['chat-send-btn'].disabled, false);
  assert.equal(f.bubbles[1].children[0].children[0].textContent, 'No completed response');
  assert.equal(f.history.length, 0);
});

test('an empty LAN reply is an uncompleted request and cannot become a saved exchange', async () => {
  const f = chatFixture({message:'Explain the printer setup.'});
  f.ctx.lanAiChat = async () => { f.requests.push({url:'lan'}); return {reply:'   '}; };
  await f.ctx.sendChat();
  assert.deepEqual(f.requests.map(r=>r.url), ['lan']);assert.equal(f.history.length,0);
  assert.match(f.bubbles[1].children[0].children[1].textContent,/no usable reply/);
});

test('HTTP success without a usable JSON reply cannot become a saved conversation exchange', async () => {
  const f=chatFixture({message:'Explain my setup.',lm:true});f.ctx.resolveIntelligenceRoute=async()=>({source:'local'});
  f.ctx.fetch=async()=>{f.requests.push({url:'/chat'});return{ok:true,json:async()=>({reply:'',conversation_id:'existing-thread'})};};
  await f.ctx.sendChat();assert.equal(f.requests.length,1);assert.equal(f.history.length,0);
  assert.equal(f.nodes['chat-input'].value,'Explain my setup.');
  assert.match(f.bubbles[1].children[0].children[1].textContent,/no usable reply/);
});

test('late SSE metadata cannot update diagnostic status after the conversation context was cleared', async () => {
  const f=chatFixture({message:'Explain my setup.'});f.ctx.resolveIntelligenceRoute=async()=>({source:'local'});
  let active=true,shown=0;
  f.ctx.window.TLIIntelligence={getContext:()=>({}),capture:()=>0,isCurrent:()=>active,showMeta:()=>shown++};
  f.ctx.tliBundledChatStream=async request=>{active=false;request.onMeta({provider:'bundled',host:{name:'Private previous host'}});request.onDelta('Late private answer');};
  await f.ctx.sendChat();assert.equal(shown,0);assert.equal(f.history.length,0);assert.equal(f.bubbles[1].htmlWrites.length,0);
});

test('stopping an action response leaves its partial receipt and does not claim the action was cancelled', async () => {
  const f=chatFixture({message:'Toggle Office lamp'});f.ctx.resolveIntelligenceRoute=async()=>({source:'local'});
  f.ctx.tliBundledChatStream=async request=>{request.onMeta({handled_by:'intent_engine',provider:'tli-action'});request.onDelta('The host accepted the command.');throw Object.assign(new Error('Stopped'),{name:'AbortError'});};
  await f.ctx.sendChat();const notice=f.bubbles[1].children[0];
  assert.equal(f.bubbles[1].innerHTML,'The host accepted the command.');
  assert.match(notice.children[1].textContent,/does not confirm that the action stopped/);
  assert.equal(f.history.length,0);
});

function hookFixture({ metadata, deltas = ['No device matched ', "'ai'. Use an exact name."], interrupted = false, trailingMeta } = {}) {
  const toasts = [], callbacks = [];
  const result = { completed: true };
  const ctx = vm.createContext({ window: {
    tliToast(message, type) { toasts.push({ message, type }); },
    async tliBundledChatStream(opts) {
      opts.onMeta(metadata);
      for (const delta of deltas) opts.onDelta(delta);
      if (trailingMeta) opts.onMeta(trailingMeta);
      if (interrupted) throw Error('Synthetic interrupted stream');
      return result;
    },
  } });
  vm.runInContext(hook, ctx);
  ctx._hookChatStream();
  return { ctx, toasts, callbacks, result,
    run: () => ctx.window.tliBundledChatStream({
      onMeta: meta => callbacks.push({ meta }), onDelta: text => callbacks.push({ text }),
    }),
  };
}

for (const ok of [undefined, null, 'false', 1]) test(`unresolved or ambiguous intent cannot produce a success toast from ok=${String(ok)}`, async () => {
  const fixture = hookFixture({ metadata: { handled_by: 'intent_engine', ok } });
  const result = await fixture.run();
  assert.equal(result, fixture.result);
  assert.deepEqual(fixture.toasts, [{ message: "No device matched 'ai'. Use an exact name.", type: 'info' }]);
  assert.equal(fixture.callbacks.length, 3);
});

for (const ok of [true, false]) test(`only an explicit boolean handler result produces an ${ok ? 'success' : 'error'} action toast`, async () => {
  const fixture = hookFixture({ metadata: { handled_by: 'intent_engine', ok }, deltas: ['**Office Lamp**: ', ok ? 'turned off.' : 'request failed.'] });
  await fixture.run();
  assert.equal(fixture.toasts.length, 1);
  assert.equal(fixture.toasts[0].type, ok ? 'success' : 'error');
  assert.equal(fixture.toasts[0].message, `Office Lamp: ${ok ? 'turned off.' : 'request failed.'}`);
});

test('unrelated metadata cannot promote a clarification to action success', async () => {
  const fixture = hookFixture({ metadata: { handled_by: 'intent_engine' }, trailingMeta: { ok: true, source_ref: {} } });
  await fixture.run();
  assert.equal(fixture.toasts[0].type, 'info');
});

for (const ok of [undefined, true, false]) test(`an interrupted action stream has no completion toast even when ok=${String(ok)}`, async () => {
  const fixture = hookFixture({ metadata: { handled_by: 'intent_engine', ok }, interrupted: true });
  await assert.rejects(fixture.run(), /Synthetic interrupted stream/);
  assert.deepEqual(fixture.toasts, []);
});

test('read-only AI status is not presented as a device action', async () => {
  const fixture = hookFixture({ metadata: { handled_by: 'ai_status', provider: 'tli-status' }, deltas: ['AI readiness is unknown.'] });
  await fixture.run();
  assert.deepEqual(fixture.toasts, []);
});

test('installing the stream hook twice still produces one toast and one callback per event', async () => {
  const fixture = hookFixture({ metadata: { handled_by: 'intent_engine', ok: true } });
  fixture.ctx._hookChatStream();
  await fixture.run();
  assert.equal(fixture.toasts.length, 1);
  assert.equal(fixture.callbacks.length, 3);
});
const readinessCases = [
  {name:'observed CPU answer', data:{provider:'tli-tools',brain_used:'tli-tools',handled_by:'observed_status'}},
  {name:'action result', data:{brain_used:'tli-action',handled_by:'intent_engine'}},
  {name:'diagnostic report', data:{brain_used:'tli-diagnostics',handled_by:'diagnostics'}},
  {name:'unknown provider', data:{}},
  {name:'mesh answer', data:{brain_used:'mesh'}},
  {name:'bundled answer', data:{brain_used:'bundled',handled_by:'llm'}},
  {name:'contradictory provider metadata', data:{brain_used:'lmstudio',handled_by:'observed_status'}},
];
for(const scenario of readinessCases) test(`${scenario.name} cannot mark LM Studio online while AI is unavailable`,async()=>{
  const f=chatFixture({message:'How much CPU is being used?',lm:true});
  f.ctx.resolveIntelligenceRoute=async()=>({source:'local'});
  f.ctx.AIStatus.local.available=false;f.ctx.AIStatus.lan.available=false;
  f.ctx.tliFetchBundledStatus=async()=>({ok:false});
  f.ctx.fetch=async(url,options)=>{f.requests.push({url});return{ok:true,json:async()=>({reply:'The latest host CPU reading was 25%.',...scenario.data})};};
  await f.ctx.sendChat();
  assert.deepEqual(f.requests,[{url:'/chat'}]);assert.equal(f.ctx.AIStatus.local.available,false);
  assert.deepEqual(f.healthCalls,[],'Neither pending nor deterministic/unknown success may claim readiness');
  assert.equal(f.history.at(-1).content,'The latest host CPU reading was 25%.');
});
test('confirmed LM Studio generation does not launch another health-generation request',async()=>{
  const f=chatFixture({message:'Explain how local AI works.',lm:true});
  f.ctx.resolveIntelligenceRoute=async()=>({source:'local'});
  f.ctx.fetch=async()=>{assert.deepEqual(f.healthCalls,['bundled-probe']);return{ok:true,json:async()=>({reply:'A generated explanation.',brain_used:'lmstudio'})};};
  await f.ctx.sendChat();assert.deepEqual(f.healthCalls,['bundled-probe']);
});
for(const completed of [false,true]) test(`mesh routing metadata ${completed?'with a completed answer':'before failed generation'} does not prematurely claim readiness`,async()=>{
  const f=chatFixture({message:'Explain how local AI works.'}),pills=[];
  f.ctx.resolveIntelligenceRoute=async()=>({source:'local'});
  f.ctx.window.__tliSetAIPill=(...args)=>pills.push(args);
  f.ctx.tliBundledChatStream=async request=>{
    request.onMeta({handled_by:'mesh',mesh_node:{name:'Synthetic peer'}});assert.deepEqual(pills,[]);
    request.onDelta('Some explanation.');assert.deepEqual(pills,[]);
    if(!completed)throw Error('The peer disconnected');
  };
  await f.ctx.sendChat();assert.equal(pills.length,completed?1:0);
});

for (const phase of ['route','LAN','preflight']) test(`Stop ends browser wait during ${phase}, preserves draft and rejects late output`, async () => {
  const f = chatFixture({message:'Explain this network'}), wait = deferred(), spy = responseSpy(f);
  if (phase === 'route') f.ctx.resolveIntelligenceRoute = () => wait.promise;
  else if (phase === 'LAN') f.ctx.lanAiChat = () => wait.promise;
  else { f.ctx.resolveIntelligenceRoute = async () => ({source:'local'}); f.ctx.window.TLIMemory.ensureAvailable = () => wait.promise; }
  const sending = f.ctx.sendChat(); await tick();
  assert.equal(f.nodes['abort-chat-btn'].disabled, false);
  f.nodes['chat-input'].value = 'My newer draft'; f.ctx.inFlightController.abort(); await sending;
  assert.equal(f.nodes['chat-send-btn'].disabled, false); assert.equal(f.nodes['abort-chat-btn'].disabled, true);
  assert.equal(f.nodes['chat-input'].value,'My newer draft'); assert.deepEqual(f.history,[]);
  const count = f.requests.length, previous = f.bubbles[1].innerHTML;
  wait.resolve(phase === 'route' ? {source:'lan',node:{name:'Late'}} : {reply:'Late reply'}); await tick();
  assert.equal(f.requests.length,count); assert.equal(f.bubbles[1].innerHTML,previous); assert.deepEqual(f.history,[]);
  assert.deepEqual(spy.types(),['begin','finish']);
});
