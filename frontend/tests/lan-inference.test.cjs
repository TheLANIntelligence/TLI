const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/lan-inference.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const protocol = 'tli-peer-inference-v1';
const peer = { id: 'peer-gaming', name: 'Gaming PC' };
const models = () => ({ protocol, peer, trust_revision: 'a'.repeat(64), checked_at: '2026-09-28T12:00:00Z',
  resources: [{ id: 'c'.repeat(64), revision: 'b'.repeat(64), label: 'Local coding model', model_id: 'qwen-test', provider: 'bundled', context_window: 32768 }] });
const fields = () => ({ peer_id: peer.id, trust_revision: 'a'.repeat(64), resource_id: 'c'.repeat(64), resource_revision: 'b'.repeat(64) });
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const ids = {}, events = {}, calls = [], created = [];
  let handler = async url => url.endsWith('/peers') ? { protocol, peers: [peer] } : models();
  function node(tag) {
    const el = { tag, children: [], handlers: {}, attrs: {}, style: {}, value: '', textContent: '', disabled: false, open: false,
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); },
      async fire(k) { await Promise.all((this.handlers[k] || []).map(fn => fn({ preventDefault() {} }))); },
      async click() { if (!this.disabled) await this.fire('click'); },
    };
    Object.defineProperty(el, 'id', { set(value) { ids[value] = el; }, get() { return Object.keys(ids).find(key => ids[key] === el); } });
    created.push(el); return el;
  }
  ids['chat-lan-inference'] = node('div'); ids['tli-no-ai-banner'] = node('div');
  const listen = (name, fn) => (events[name] ||= []).push(fn);
  const emit = name => (events[name] || []).forEach(fn => fn({ type: name }));
  const context = vm.createContext({ console, AbortController, document: { readyState: 'complete', createElement: node,
    getElementById: id => ids[id], addEventListener: listen },
    window: { addEventListener: listen, dispatchEvent(event) { emit(event.type); } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: async (url, options) => { calls.push({ url, options, body: options.body && JSON.parse(options.body) }); const value = await handler(url, options); return { ok: !value.http_status || value.http_status < 400, status: value.http_status || 200, json: value.json || (async () => value) }; },
  });
  vm.runInContext(source, context);
  return { ids, calls, created, context, api: context.window.TLILanInference, emit, handler: value => { handler = value; },
    text: () => created.map(el => el.textContent).join('\n'),
    async check() { await ids['lan-inference-load'].click(); ids['lan-inference-peer'].value = peer.id; await ids['lan-inference-peer'].fire('change'); await ids['lan-inference-check'].click(); },
    async select() { await this.check(); ids['lan-inference-resource'].value = 'c'.repeat(64); await ids['lan-inference-resource'].fire('change'); await ids['lan-inference-use'].click(); },
  };
}

test('mount, opening the chooser and navigation never contact any computer', async () => {
  const f = fixture(); f.created.find(el => el.tag === 'details').open = true; f.emit('tli-panel-switched');
  assert.equal(f.calls.length, 0); assert.equal(f.api.request(f.api.capture()), null);
  await f.ids['lan-inference-load'].click();
  assert.deepEqual(f.calls.map(call => [call.url, call.options.method]), [['/api/ai/lan/peers', 'GET']]);
  assert.equal(f.calls[0].options.cache, 'no-store'); assert.equal(f.api.request(f.api.capture()), null);
});
test('checking models requires explicit peer choice and model use requires a second deliberate selection', async () => {
  const f = fixture(); await f.ids['lan-inference-check'].fire('click'); assert.equal(f.calls.length, 0);
  await f.check(); assert.equal(f.calls.length, 2); assert.equal(f.api.request(f.api.capture()), null);
  assert.deepEqual(f.calls[1].body, { peer_id: peer.id });
  await f.ids['lan-inference-use'].fire('click'); assert.equal(f.api.request(f.api.capture()), null);
  f.ids['lan-inference-resource'].value = 'c'.repeat(64); await f.ids['lan-inference-resource'].fire('change'); await f.ids['lan-inference-use'].click();
  assert.deepEqual(plain(f.api.request(f.api.capture())), fields());
  assert.match(f.text(), /history or saved notes enabled in Context/); assert.match(f.text(), /Shelly/);
  assert.equal(f.ids['tli-no-ai-banner'].style.display, 'none');
  await f.ids['lan-inference-local'].click(); assert.equal(f.ids['tli-no-ai-banner'].style.display, '');
});
for (const event of ['tli-session-locked', 'tli-session-unlocked', 'tli-user-changed', 'tli-account-changed', 'pagehide']) {
  test(event + ' clears selected authority and invalidates outstanding request tickets', async () => {
    const f = fixture(); await f.select(); const ticket = f.api.capture(); f.emit(event);
    assert.equal(f.api.isCurrent(ticket), false); assert.equal(f.api.capture().selection, null);
    assert.throws(() => f.api.request(ticket), /session changed/);
  });
}
test('late model response after lock/unlock cannot restore private computer names or authority', async () => {
  const f = fixture(); await f.ids['lan-inference-load'].click(); f.ids['lan-inference-peer'].value = peer.id; await f.ids['lan-inference-peer'].fire('change');
  let release; f.handler(() => new Promise(resolve => { release = resolve; })); const pending = f.ids['lan-inference-check'].click(); await tick();
  f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); release(models()); await pending;
  assert.equal(f.ids['lan-inference-resource'].children.length, 1); assert.equal(f.api.capture().selection, null);
  assert.equal(f.ids['lan-inference-status'].textContent.includes('Gaming'), false);
});
test('returning to current setup cancels an in-flight check without automatic retry', async () => {
  const f = fixture(); await f.check(); let release; f.handler(() => new Promise(resolve => { release = resolve; }));
  const pending = f.ids['lan-inference-check'].click(); await tick(); await f.ids['lan-inference-local'].click(); release(models()); await pending;
  assert.equal(f.calls.at(-1).options.signal.aborted, true); assert.equal(f.api.capture().selection, null); assert.equal(f.ids['lan-inference-use'].disabled, true);
});
for (const failure of [{ http_status: 403, detail: { message: 'Inference grant revoked.' } }, { ...models(), peer: { id: 'wrong-peer', name: 'Wrong computer' } }, { ...models(), trust_revision: 'invalid' }]) {
  test('failed or mismatched model check leaves the default choice intact: ' + JSON.stringify(failure).slice(0, 55), async () => {
    const f = fixture(); f.handler(async url => url.endsWith('/peers') ? { protocol, peers: [peer] } : failure); await f.check();
    assert.equal(f.api.capture().selection, null); assert.equal(f.ids['lan-inference-use'].disabled, true); assert.equal(f.calls.length, 2);
  });
}
test('unsupported selected context and attachments never become ordinary LAN questions', async () => {
  const f = fixture(); await f.select();
  for (const context of [{ note_refs: [{}] }, { documents: [{}] }, { case_ref: {} }, { target_id: 'a' }, { diagnostic_id: 'a' }, { screenshot: {} }]) assert.throws(() => f.api.request(f.api.capture(), context), /Nothing was sent/);
  for (const options of [{ image: true }, { message: 'Use [vault:secret]' }]) assert.throws(() => f.api.request(f.api.capture(), {}, options), /Nothing was sent/);
  assert.deepEqual(plain(f.api.request(f.api.capture(), { use_conversation_history: false, use_saved_memory: false })), fields());
});

function installChat(f, { lm = false, failure = false } = {}) {
  const requests = [], history = [], bubbles = [], toasts = [], health = [];
  for (const id of ['chat-input', 'chat-send-btn', 'abort-chat-btn', 'mode-select', 'temperature-input', 'max-tokens-input']) f.ids[id] = { value: '', disabled: false };
  f.ids['chat-input'].value = 'Explain my project'; f.ids['mode-select'].value = 'default';
  const ctx = f.context;
  Object.assign(ctx, { _chatImageB64: null, _chatImageMime: null, _chatImageReadVersion: 0, _chatImageReading: false,
    $: id => f.ids[id], showToast: message => toasts.push(message), tliSearchIsEnabled: () => false,
    appendMessage(role, text) { const el = { role, textContent: text, innerHTML: '', children: [], append(...items) { this.children.push(...items); }, classList: { remove() {}, add() {} } }; bubbles.push(el); return el; },
    resolveIntelligenceRoute: async () => { health.push('route'); return { source: 'local' }; }, IntelligenceSource: { LAN_LLM: 'lan', NONE: 'none' },
    readSettings: () => ({ defaultBrain: lm ? 'lmstudio' : 'bundled' }), isTeachingMode: () => false, debugLog() {}, lastSendTs: 0,
    inFlightController: null, AIStatus: { local: {}, lan: { available: false } }, tliFetchBundledStatus: async () => { health.push('bundled'); return { ok: true }; },
    currentConversationId: 'saved-conversation', currentDeviceId: 'browser', _currentPanelId: 'panel-main', CHAT_HISTORY_DRAFT_ID: '__draft__',
    tliBundledChatStream: async request => { requests.push({ url: 'stream', body: request }); request.onMeta({ handled_by: 'lan_inference', provider: 'lan', model: 'qwen-test', inference_host: peer }); request.onDelta('Partial answer'); if (failure) throw Error('Connection interrupted'); },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ reply: 'Local answer' }) }; },
    renderAssistantHTML: value => value, formatModelOutput: value => value, _attachSpeakBtn() {}, tliSpeak() {}, setModelStatus() {},
    chatHistoryAdd: (role, content) => history.push({ role, content }), saveConversation() {}, addPreviousPrompt() {},
  });
  ctx.window.TLIMemory = { requestContext: context => ({ ...context, use_saved_memory: false, use_conversation_history: false }), isCurrent: () => true, ensureAvailable: async () => {}, decorateReply() {}, decorateMessage() {} };
  const start = app.indexOf('async function sendChat()'); vm.runInContext(app.slice(start, app.indexOf('// Shelly Chat Helpers', start)), ctx);
  return { requests, history, bubbles, toasts, health };
}
for (const lm of [false, true]) test('selected LAN model uses primary SSE with preserved context even when ' + (lm ? 'LM Studio selected' : 'local AI unavailable'), async () => {
  const f = fixture(); await f.select(); const chat = installChat(f, { lm }); f.context.tliFetchBundledStatus = () => assert.fail('LAN selection does not depend on local readiness');
  await f.context.sendChat(); assert.equal(chat.requests.length, 1); assert.equal(chat.requests[0].url, 'stream');
  const body = chat.requests[0].body; assert.deepEqual(plain(body.lan_inference), fields()); assert.equal(body.session_id, 'saved-conversation');
  assert.equal(body.use_saved_memory, false); assert.equal(body.use_conversation_history, false); assert.deepEqual(chat.health, []);
  assert.match(chat.bubbles[1].children[0].textContent, /Gaming PC/);
});
for (const lm of [false, true]) test('no LAN choice preserves the existing ' + (lm ? 'LM Studio' : 'bundled') + ' request', async () => {
  const f = fixture(); const chat = installChat(f, { lm }); await f.context.sendChat();
  assert.equal(chat.requests[0].url, lm ? '/chat' : 'stream'); assert.equal(chat.requests[0].body.lan_inference, undefined);
});
test('partial remote error retains the draft without successful history, receipt or local fallback', async () => {
  const f = fixture(); await f.select(); const chat = installChat(f, { failure: true }); await f.context.sendChat();
  assert.equal(chat.requests.length, 1); assert.equal(chat.history.length, 0); assert.equal(chat.bubbles[1].children.length, 0);
  assert.match(chat.bubbles[1].textContent, /Incomplete response/); assert.equal(f.ids['chat-input'].value, 'Explain my project');
});
test('late remote stream after a session change cannot restore replies or conversation IDs', async () => {
  const f = fixture(); await f.select(); const chat = installChat(f); let release;
  f.context.tliBundledChatStream = async request => {
    chat.requests.push({ url: 'stream', body: request }); await new Promise(resolve => { release = resolve; });
    request.onMeta({ session_id: 'private-old-session', handled_by: 'lan_inference', provider: 'lan', model: 'qwen-test', inference_host: peer });
    request.onDelta('Private late answer');
  };
  const sending = f.context.sendChat(); await tick(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  f.context.currentConversationId = null; f.context.window.currentConversationId = null; f.ids['chat-input'].value = 'New account draft'; release(); await sending;
  assert.equal(f.context.currentConversationId, null); assert.equal(f.context.window.currentConversationId, null);
  assert.equal(chat.history.length, 0); assert.equal(chat.bubbles[1].innerHTML, ''); assert.equal(f.ids['chat-input'].value, 'New account draft');
});
test('legacy LAN status and request helpers make no network requests', async () => {
  const context = vm.createContext({ Date, AIStatus: { lan: { available: true, nodes: [peer] } }, fetch: () => assert.fail('No automatic LAN network request'), fetchWithTimeout: () => assert.fail('No automatic LAN HTTP request') });
  const begin = app.indexOf('async function refreshLanAI()'); const end = app.indexOf('// Decide route', begin); vm.runInContext(app.slice(begin, end), context);
  const request = app.indexOf('async function lanAiChat()'); vm.runInContext(app.slice(request, app.indexOf('// --- Global UI helpers', request)), context);
  assert.equal(await context.refreshLanAI(), false); assert.deepEqual(plain(context.AIStatus.lan.nodes), []);
  await assert.rejects(context.lanAiChat({ node: { ip: '192.0.2.1' }, payload: { message: 'private' } }), /reviewed computer/);
});
test('reopened conversations keep the reported model and inference host receipt', async () => {
  const f = fixture(), rendered = []; f.ids['chat-output'] = {};
  Object.assign(f.context, { $: id => f.ids[id], currentConversationId: null,
    appendMessage() { const bubble = { children: [], append(...items) { this.children.push(...items); } }; rendered.push(bubble); return bubble; },
    fetch: async () => ({ ok: true, json: async () => ({ messages: [{ role: 'assistant', content: 'Earlier answer', provider: 'lan', model: 'historical-model', inference_host: peer }] }) }),
  });
  const begin = app.indexOf('async function loadConversation('); vm.runInContext(app.slice(begin, app.indexOf('function addPreviousPrompt', begin)), f.context);
  assert.equal(await f.context.loadConversation('saved-conversation', 'Sample chat'), true);
  assert.equal(rendered[0].children[0].textContent, 'AI model: historical-model · Gaming PC');
  assert.equal(f.api.capture().selection, null, 'Historical source never selects the model for a new request');
});

test('conversation settings prepare without replacing the active selection until a current commit', async () => {
  const f=fixture();await f.select();f.context.window.TLIWorkspace={supported:async()=>true};
  f.handler(async()=>({compute_selection:null,settings_revision:2}));let current=true;
  const commit=await f.api.prepareConversation('another',{current:()=>current});
  assert.deepEqual(plain(f.api.capture().selection),fields());current=false;assert.equal(commit(),false);
  assert.deepEqual(plain(f.api.capture().selection),fields());
  const next=await f.api.prepareConversation('another',{current:()=>true});assert.equal(next(),true);assert.equal(f.api.capture().selection,null);
});

test('obsolete capability read cannot invalidate a newer conversation model selection', async () => {
  const f=fixture();let release,checks=0;f.context.window.TLIWorkspace={supported:()=>++checks===1?new Promise(resolve=>{release=resolve;}):Promise.resolve(true)};
  f.handler(async()=>({compute_selection:fields(),settings_revision:1}));
  const old=f.api.prepareConversation('old');await tick();
  const commit=await f.api.prepareConversation('new');assert.equal(commit(),true);release(true);assert.equal((await old)(),false);
  assert.deepEqual(plain(f.api.capture().selection),fields());assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/conversations\/new\/settings$/);
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide'])test('saved AI selection clears on '+event+' and only a fresh explicit read may restore it',async()=>{
  const f=fixture();await f.select();f.context.window.TLIWorkspace={supported:async()=>true};let release;
  f.handler(()=>new Promise(resolve=>{release=resolve;}));const old=f.api.prepareConversation('old');await tick();
  const oldRequest=f.calls.at(-1);f.emit(event);assert.equal(oldRequest.options.signal.aborted,true);assert.equal(f.api.capture().selection,null);
  f.emit('tli-private-observation-ready');assert.equal((await f.api.prepareConversation('blocked'))(),false);
  f.emit('tli-session-unlocked');assert.equal((await f.api.prepareConversation('blocked'))(),false);
  assert.equal(f.api.request(f.api.capture()),null,'Ordinary local AI remains selectable after unlock');assert.equal(f.calls.length,3);
  f.emit('tli-private-observation-ready');assert.equal(f.calls.length,3,'Verified recovery does not replay the old read');
  f.handler(async()=>({compute_selection:fields(),settings_revision:1}));const commit=await f.api.prepareConversation('new');assert.equal(commit(),true);
  release({http_status:403,json:()=>assert.fail('Stale denial body must not be read')});assert.equal((await old)(),false);
  assert.deepEqual(plain(f.api.capture().selection),fields());assert.equal(f.api.isCurrent(f.api.capture()),true);
  assert.equal(f.calls.length,4);assert.match(f.calls.at(-1).url,/conversations\/new\/settings$/);
  assert.equal(f.calls.filter(call=>call.options.method==='PATCH').length,0);
});

for(const status of [401,403])test('current saved-selection denial '+status+' clears authority without requiring a readable error body',async()=>{
  const f=fixture();await f.select();f.context.window.TLIWorkspace={supported:async()=>true};
  f.handler(async()=>({http_status:status,json:()=>assert.fail('No denial body is needed')}));
  assert.equal((await f.api.prepareConversation('denied'))(),false);assert.equal(f.api.capture().selection,null);assert.equal(f.api.isCurrent(f.api.capture()),false);
  f.emit('tli-session-unlocked');assert.equal((await f.api.prepareConversation('denied'))(),false);assert.equal(f.calls.length,3);
  f.emit('tli-private-observation-ready');assert.equal(f.calls.length,3);
  f.handler(async()=>({compute_selection:null,settings_revision:0}));assert.equal((await f.api.prepareConversation('fresh'))(),true);
  assert.equal(f.calls.length,4);assert.equal(f.calls.filter(call=>call.options.method==='PATCH').length,0);
});

test('saved-selection body finishing after verified recovery cannot replace the current choice',async()=>{
  const f=fixture();f.context.window.TLIWorkspace={supported:async()=>true};let release;
  f.handler(async()=>({json:()=>new Promise(resolve=>{release=resolve;})}));const old=f.api.prepareConversation('old');await tick();
  for(const type of ['tli-session-locked','tli-session-unlocked','tli-private-observation-ready'])f.emit(type);
  f.handler(async()=>({compute_selection:fields(),settings_revision:1}));const fresh=await f.api.prepareConversation('fresh');assert.equal(fresh(),true);
  release({compute_selection:null,settings_revision:0});assert.equal((await old)(),false);
  assert.deepEqual(plain(f.api.capture().selection),fields());assert.equal(f.calls.length,2);
});

for(const failure of [{http_status:503,detail:'Settings unavailable'},{settings_revision:0},{settings_revision:0,compute_selection:{peer_id:'unknown'}},{json:async()=>{throw SyntaxError('Unreadable settings');}}])test('failed saved-selection read preserves the current model without fallback: '+JSON.stringify(failure),async()=>{
  const f=fixture();await f.select();f.context.window.TLIWorkspace={supported:async()=>true};f.handler(async()=>failure);
  await assert.rejects(f.api.prepareConversation('failed'));
  assert.deepEqual(plain(f.api.capture().selection),fields());assert.equal(f.api.isCurrent(f.api.capture()),true);assert.equal(f.calls.length,3);
  assert.equal(f.calls.filter(call=>call.options.method==='PATCH').length,0);
});

test('saved-selection preflight cannot read or PATCH on bare unlock and recovery never replays the choice',async()=>{
  const f=fixture();f.context.window.currentConversationId='saved';f.context.window.TLIConversationLoad={generation:0};f.context.window.TLIWorkspace={supported:async()=>true};
  f.emit('tli-session-locked');f.emit('tli-session-unlocked');await f.check();
  f.ids['lan-inference-resource'].value='c'.repeat(64);await f.ids['lan-inference-resource'].fire('change');await f.ids['lan-inference-use'].click();
  assert.equal(f.calls.length,2);assert.equal(f.api.capture().selection,null);assert.match(f.ids['lan-inference-status'].textContent,/verify access/);
  f.emit('tli-private-observation-ready');assert.equal(f.calls.length,2);
  f.handler(async()=>({settings_revision:2,compute_selection:null}));await f.ids['lan-inference-use'].click();
  assert.equal(f.calls.length,4);assert.equal(f.calls.at(-1).options.method,'PATCH');assert.equal(f.calls.at(-1).body.expected_settings_revision,2);
  assert.deepEqual(plain(f.api.capture().selection),fields());
});

for(const change of ['session','conversation'])test('model setting save cannot PATCH after a '+change+' change during its preflight',async()=>{
  const f=fixture();await f.check();f.ids['lan-inference-resource'].value='c'.repeat(64);await f.ids['lan-inference-resource'].fire('change');
  f.context.window.currentConversationId='old';f.context.window.TLIConversationLoad={generation:0};f.context.window.TLIWorkspace={supported:async()=>true};
  let release;f.handler(()=>new Promise(resolve=>{release=resolve;}));
  const choosing=f.ids['lan-inference-use'].click();await tick();
  if(change==='session'){f.emit('tli-session-locked');f.emit('tli-session-unlocked');}else{f.context.window.currentConversationId='new';f.context.window.TLIConversationLoad.generation++;}
  release({compute_selection:null,settings_revision:0});await choosing;
  assert.equal(f.calls.filter(call=>call.options.method==='PATCH').length,0);assert.equal(f.api.capture().selection,null);
});

test('sending while shared conversation settings load preserves the draft and makes no chat request',async()=>{
  const f=fixture(),chat=installChat(f);f.context.window.TLIConversationLoad={loading:true};await f.context.sendChat();
  assert.equal(chat.requests.length,0);assert.equal(f.ids['chat-input'].value,'Explain my project');assert.match(chat.toasts[0],/finish loading/);
});
