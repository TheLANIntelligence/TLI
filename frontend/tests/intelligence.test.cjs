const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
const start = source.indexOf('async function tliBundledChatStream(');
const end = source.indexOf('function clearChatWithPlaceholder', start);

test('opening a saved report is read-only and leaves existing chat target/report unchanged', async () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../js/intelligence.js'), 'utf8');
  const nodes={}, all=[], calls=[], listeners={};let finish=null;
  function element(tag){const n={tag,textContent:'',children:[],handlers:{},dataset:{},value:'',open:false,classList:{toggle(){}},
    append(...children){this.children.push(...children)},before(){},replaceChildren(...children){this.children=children},setAttribute(){},focus(){},
    addEventListener(event,fn){(this.handlers[event]||=[]).push(fn)},showModal(){this.open=true},close(){this.open=false;for(const f of this.handlers.close||[])f()}};
    Object.defineProperty(n,'id',{set(id){nodes[id]=n}});all.push(n);return n;}
  for(const id of ['panel-reports','panel-settings','new-chat-btn'])nodes[id]=element('div');
  const body=element('body'),row=element('div');
  const record={id:'saved-report',kind:'network',created_at:'2026-09-08T12:00:00Z',target:{id:'old-computer',name:'Previously checked'},checks:[{status:'pass',label:'Saved check',detail:'Historical reading'}],findings:[]};
  const ctx=vm.createContext({Date,CustomEvent,document:{readyState:'complete',body,addEventListener:(event,fn)=>(listeners[event]||=[]).push(fn),createElement:element,getElementById:id=>nodes[id],querySelector:()=>row,querySelectorAll:selector=>all.filter(n=>selector==='[data-int-target]'?n.dataset.intTarget:(n.className||'').includes('tli-int-status'))},
    window:{addEventListener:(event,fn)=>(listeners[event]||=[]).push(fn),dispatchEvent(){}},fetch:async(url,options)=>{calls.push({url,options});if(finish)await new Promise(resolve=>finish(resolve));return{ok:true,status:200,json:async()=>record}}});
  vm.runInContext(script,ctx);const api=ctx.window.TLIIntelligence, before=JSON.stringify(api.getContext());
  await api.openSavedReport('saved-report');assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');assert.equal(nodes['tli-saved-report-dialog'].open,true);assert.equal(JSON.stringify(api.getContext()),before);
  const dialog=nodes['tli-saved-report-dialog'],normalClose=dialog.close;
  dialog.close=function(){this.open=false};dialog.close();await api.openSavedReport('saved-report');
  for(const fn of dialog.handlers.close)fn();
  assert.equal(dialog.open,true);assert.ok(dialog.children.some(n=>n.textContent==='Saved diagnostic report'),'queued close must preserve a replacement report');
  assert.equal(JSON.stringify(api.getContext()),before);assert.ok(calls.every(c=>c.options.method==='GET'));
  dialog.close=normalClose;
  nodes['tli-saved-report-dialog'].close();let done;finish=resolve=>done=resolve;
  const closed=api.openSavedReport('saved-report');await new Promise(resolve=>setImmediate(resolve));for(const fn of listeners['tli-panel-switched']||[])fn();done();await closed;assert.equal(nodes['tli-saved-report-dialog'].open,false);
  const pending=api.openSavedReport('saved-report');await new Promise(resolve=>setImmediate(resolve));for(const fn of listeners['tli-session-locked']||[])fn();done();await assert.rejects(pending,/no longer current/);
  assert.equal(nodes['tli-saved-report-dialog'].open,false);assert.equal(nodes['tli-saved-report-dialog'].children.length,0);
});

test('chat device and report summaries use selections without private report bodies or extra requests', async () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../js/intelligence.js'), 'utf8');
  const nodes = {}, all = [], calls = [], events = [];
  function element(tag) {
    const n = { tag, textContent: '', children: [], handlers: {}, dataset: {}, value: '', classList: { toggle() {} },
      append(...children) { this.children.push(...children); }, before() {}, replaceChildren(...children) { this.children = children; },
      setAttribute() {}, addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      fire(type) { return Promise.all((this.handlers[type] || []).map(fn => fn({}))); }, focus() {},
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = this; } }); all.push(n); return n;
  }
  for (const id of ['panel-reports', 'panel-settings', 'new-chat-btn']) nodes[id] = element('div');
  const row = element('div');
  const report = { id: 'report-fixture', kind: 'system', created_at: '2026-09-07T12:00:00Z', host: { name: 'Office PC' }, target: { id: 'device-fixture', name: 'Studio display' },
    scope: 'Private diagnostic scope', checks: [], findings: [{ certainty: 'Observed', text: 'Private finding body' }], next_steps: [] };
  const ctx = vm.createContext({ CustomEvent, Date, switchPanel() {},
    document: { readyState: 'complete', createElement: element, getElementById: id => nodes[id], querySelector: () => row,
      querySelectorAll: selector => all.filter(n => selector === '[data-int-target]' ? n.dataset.intTarget : (n.className || '').includes('tli-int-status')) },
    window: { dispatchEvent: event => events.push(event) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const result = url.endsWith('/devices') ? { devices: [{ id: 'device-fixture', name: 'Studio display', kind: 'computer' }], node: { name: 'Office PC' }, scope: 'This host' } : { reports: [report] };
      return { ok: true, json: async () => result };
    },
  });
  vm.runInContext(script, ctx); const api = ctx.window.TLIIntelligence;
  assert.deepEqual(JSON.parse(JSON.stringify(api.describeContext())), []); assert.equal(calls.length, 0);
  const devices = nodes['panel-reports'].children[0]; devices.open = true; await devices.fire('toggle');
  const historyButton = all.find(n => n.tag === 'button' && n.textContent.startsWith('Studio display ·'));
  assert.ok(historyButton); await historyButton.fire('click');
  assert.deepEqual(JSON.parse(JSON.stringify(api.describeContext())), [], 'History navigation cannot attach evidence');
  assert.equal(api.getContext().diagnostic_id,null);assert.equal(api.getContext().target_id,null);
  assert.ok(calls.every(c=>c.options.method==='GET'),'History navigation performs reads only');
  const discuss=all.find(n=>n.tag==='button'&&n.textContent==='Discuss this report in chat');
  await discuss.fire('click');
  const before = JSON.stringify(api.getContext()), callCount = calls.length;
  const described = api.describeContext();
  assert.equal(described[0].label, 'Studio display'); assert.equal(described[0].id, 'device:device-fixture');
  assert.equal(described[1].id, 'report:report-fixture'); assert.equal(described[1].kind, 'report'); assert.match(described[1].label, /system report/);
  assert.doesNotMatch(JSON.stringify(described), /Private diagnostic|Private finding/);
  described[0].label = 'Externally modified'; assert.equal(api.describeContext()[0].label, 'Studio display');
  assert.equal(JSON.stringify(api.getContext()), before); assert.equal(calls.length, callCount);
  api.removeContext('report:report-fixture');
  assert.equal(api.getContext().diagnostic_id, null); assert.equal(api.getContext().target_id, 'device-fixture');
  api.removeContext('device:device-fixture'); assert.equal(api.getContext().target_id, null);
  assert.deepEqual(JSON.parse(JSON.stringify(api.describeContext())), []);
  assert.equal(events.at(-1).type, 'tli-chat-context-changed'); assert.equal(events.at(-1).detail, null); assert.equal(calls.length, callCount);
});

function harness(chunks, status = 200) {
  const calls = [], deltas = [], meta = [];
  let cancelled = false;
  const queue = chunks.map(s => new TextEncoder().encode(s));
  const ctx = vm.createContext({ TextDecoder, window: { TLIIntelligence: { showMeta: m => meta.push(m) } },
    fetch: async (...args) => {
      calls.push(args);
      return { ok: status === 200, status, json: async () => ({ detail: 'Vision unavailable' }), body: {
        getReader: () => ({ read: async () => queue.length ? { value: queue.shift(), done: false } : { done: true },
          cancel: async () => { cancelled = true; } }),
      } };
    },
  });
  vm.runInContext(source.slice(start, end), ctx);
  return { calls, deltas, meta, cancelled: () => cancelled,
    run: () => ctx.tliBundledChatStream({ message: 'Check the image', image_b64: 'example', image_mime: 'image/png',
      target_id: 'printer', diagnostic_id: 'report-1', retention_days: 0, onDelta: t => deltas.push(t), onMeta: m => meta.push(m) }) };
}

test('chat stream forwards image and selected evidence together', async () => {
  const h = harness(['data: {"type":"meta","provider":"lmstudio"}\n\n', 'data: {"type":"delta","text":"Evidence"}\n\n', 'data: {"type":"done"}\n\n']);
  await h.run();
  const body = JSON.parse(h.calls[0][1].body);
  assert.equal(body.image_b64, 'example'); assert.equal(body.diagnostic_id, 'report-1');
  assert.equal(body.target_id, 'printer'); assert.equal(body.retention_days, 0);
  assert.deepEqual(h.deltas, ['Evidence']); assert.equal(h.meta[0].provider, 'lmstudio'); assert(h.cancelled());
});

test('provider error after partial text never retries or reports completion', async () => {
  const h = harness(['data: {"type":"delta","text":"Partial"}\n\n', 'data: {"type":"error","detail":"Provider stopped"}\n\n']);
  await assert.rejects(h.run(), /Provider stopped/);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.deltas, ['Partial']); assert(h.cancelled());
});

test('HTTP image capability failure never falls back to a text request', async () => {
  const h = harness([], 409);
  await assert.rejects(h.run(), /Vision unavailable/); assert.equal(h.calls.length, 1);
});

test('truncated stream is failure, including when the provider emitted no tokens', async () => {
  const h = harness(['data: {"type":"meta"}\n\n']);
  await assert.rejects(h.run(), /interrupted/); assert.equal(h.calls.length, 1);
});

test('split SSE frames retain text and completion', async () => {
  const h = harness(['data: {"type":"del', 'ta","text":"Hello"}\r\n\r\n', 'data: {"type":"done"}\n\n']);
  await h.run(); assert.deepEqual(h.deltas, ['Hello']);
});

for (const succeeds of [true, false]) {
  test(`phone companion stream ${succeeds ? 'completes split frames' : 'reports failure without retry'}`, async () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../js/companion.js'), 'utf8');
    const first = html.indexOf('  async function _sendChat(text)');
    const last = html.indexOf('  chatSend.addEventListener', first);
    const chunks = ['data: {"type":"delta","text":"Phone', ' reply"}\n\n',
      succeeds ? 'data: {"type":"done"}\n\n' : 'data: {"type":"error","detail":"Device unavailable"}\n\n'];
    const bubbles = [], calls = [];
    let saves = 0;
    const ctx = vm.createContext({ TextDecoder, SAT_ID: 'phone-test', _history: [],
      chatInput: { value: 'question', style: {} }, chatSend: { disabled: false }, chatOut: { scrollTop: 0, scrollHeight: 10 },
      _bubble: () => { const b = { className: '', textContent: '' }; bubbles.push(b); return b; },
      _saveHistory: () => saves++, fetch: async (...args) => { calls.push(args); return { ok: true, body: {
        getReader: () => ({ read: async () => chunks.length ? { value: new TextEncoder().encode(chunks.shift()), done: false } : { done: true }, cancel: async () => {} }),
      } }; },
    });
    vm.runInContext(html.slice(first, last), ctx);
    await Promise.all([ctx._sendChat('question'), ctx._sendChat('duplicate')]);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][1].body).device_id, 'phone-test');
    assert.equal(ctx.chatSend.disabled, false);
    assert.equal(saves, succeeds ? 1 : 0);
    assert.match(bubbles[1].textContent, succeeds ? /^Phone reply$/ : /Device unavailable.*not automatically retried/);
  });
}

test('unpaired Companion preserves join links without a mobile redirect loop', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../js/companion.js'), 'utf8');
  const redirects = [];
  const ctx = vm.createContext({ URLSearchParams, localStorage: { getItem: () => null },
    window: { location: { search: '?join=satellite&token=preview-token', replace: url => redirects.push(url) } },
  });
  vm.runInContext(script, ctx);
  assert.deepEqual(redirects, ['/?join=satellite&token=preview-token&desktop=1']);
  const html = fs.readFileSync(path.resolve(__dirname, '../companion.html'), 'utf8');
  assert.match(html, /<script src="\/js\/companion\.js(?:\?v=[a-f0-9]{12})?"><\/script>/);
  assert.doesNotMatch(html, /<script>/);
});

for (const fails of [false, true]) {
test(`desktop image send snapshots context and protects newer attachments on ${fails ? 'failure' : 'success'}`, async () => {
  const first = source.indexOf('async function sendChat()');
  const last = source.indexOf('// Shelly Chat Helpers', first);
  const nodes = {
    'chat-input': { value: 'turn off lamp' }, 'chat-send-btn': { disabled: false }, 'abort-chat-btn': { disabled: true },
    'mode-select': { value: 'default' }, 'temperature-input': { value: '0.2' }, 'max-tokens-input': { value: '512' },
  };
  const sent = [], bubbles = [];
  let releaseRoute;
  const route = new Promise(resolve => { releaseRoute = resolve; });
  const ctx = vm.createContext({
    AbortController, _chatImageB64: 'original-image', _chatImageMime: 'image/png', _chatImageReadVersion: 1, _chatImageReading: false,
    window: { TLIIntelligence: { getContext: () => ({ target_id: 'original-target', retention_days: 0 }) },
      TLIScreenshots: { requestContext: context => ({ ...context, screenshot: {task:'error',target_id:'original-computer',provider_key:'reviewed'} }), annotateReply() {} } },
    $: id => nodes[id], showToast() {}, tliSearchIsEnabled: () => true,
    tliShouldGateForSearch: () => assert.fail('Image guidance must not trigger web search'),
    appendMessage: () => { const b = { textContent: '', innerHTML: '', classList: { remove() {} } }; bubbles.push(b); return b; },
    resolveIntelligenceRoute: () => route,
    IntelligenceSource: { LAN_LLM: 'lan', NONE: 'none' }, lastSendTs: 0,
    readSettings: () => ({}), isTeachingMode: () => false, setModelStatus() {}, debugLog() {},
    inFlightController: null, AIStatus: { local: {}, lan: { available: false } },
    tliFetchBundledStatus: async () => ({ ok: false }), currentConversationId: null, _currentPanelId: 'panel-main',
    buildContextWrappedMessage: ({ latestUserMessage }) => latestUserMessage,
    tliBundledChatStream: async req => { sent.push(req); if (fails) throw new Error('Provider unavailable'); req.onDelta('The image shows a lamp.'); },
    renderAssistantHTML: text => text, _attachSpeakBtn() {}, chatHistoryAdd() {}, tliSpeak() {},
    _clearChatImage: () => assert.fail('A newer attachment must not be cleared'),
  });
  vm.runInContext(source.slice(first, last), ctx);
  const firstSend = ctx.sendChat();
  assert.equal(nodes['chat-send-btn'].disabled, true);
  await ctx.sendChat();
  ctx._chatImageB64 = 'newer-image'; ctx._chatImageReadVersion = 2;
  ctx.window.TLIIntelligence.getContext = () => ({ target_id: 'newer-target' });
  ctx.window.TLIScreenshots.requestContext = () => ({ screenshot: {target_id:'newer-computer'} });
  releaseRoute({ source: 'local' });
  await firstSend;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].image_b64, 'original-image');
  assert.equal(sent[0].target_id, 'original-target');
  assert.equal(sent[0].screenshot.target_id, 'original-computer');
  assert.equal(sent[0].screenshot.provider_key, 'reviewed');
  assert.equal(nodes['chat-input'].value, '', 'An old failed request must not replace a newer attachment draft');
  assert.equal(nodes['chat-send-btn'].disabled, false);
  if (fails) assert.match(bubbles[1].textContent, /Request failed.*Provider unavailable/);
});
}
