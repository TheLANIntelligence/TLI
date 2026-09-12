const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const script = fs.readFileSync(path.join(__dirname, '../js/document-context.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const descendants = root => root?.children.flatMap(n => [n, ...descendants(n)]) || [];
const content = root => [root.textContent, ...descendants(root).map(n => n.textContent)].join(' ');
const findButton = (root, text) => { const n = descendants(root).find(n => n.tag === 'button' && n.textContent === text); assert.ok(n, text); return n; };
const plain = v => JSON.parse(JSON.stringify(v));
const file = (name = 'setup.md', text = 'First line\nSecond line') => { const data = Buffer.isBuffer(text) ? text : Buffer.from(text); return { name, size: data.length, arrayBuffer: async () => Uint8Array.from(data).buffer }; };
const receipt = docs => ({ document_context: { documents: docs.map(d => ({ name: d.name, sha256: createHash('sha256').update(d.text).digest('hex'), line_count: d.text.split('\n').length, chars: [...d.text].length })), actions_performed: false } });
function fixture() {
  const nodes = {}, events = {}, dispatched = [];
  function element(tag) {
    const n = { tag, children: [], handlers: {}, textContent: '', value: '', hidden: false, disabled: false, attributes: {}, classList: { remove() {} },
      setAttribute(k, v) { this.attributes[k] = v; }, append(...items) { this.children.push(...items); }, appendChild(item) { this.append(item); }, before() {}, replaceChildren(...items) { this.children = items; },
      addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); }, fire(k) { return Promise.all((this.handlers[k] || []).map(fn => fn({ preventDefault() {} }))); }, click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; },
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = this; } }); return n;
  }
  for (const id of ['documents-open', 'chat-input', 'new-chat-btn']) nodes[id] = element('button');
  const ctx = vm.createContext({ console, Date, CustomEvent, TextEncoder, TextDecoder, AbortController, currentDeviceId: 'fixture-browser',
    document: { body: element('body'), readyState: 'complete', createElement: element, getElementById: id => nodes[id], querySelector: () => element('div') },
    window: { crypto: webcrypto, addEventListener: (key, fn) => (events[key] ||= []).push(fn), dispatchEvent: event => dispatched.push(event), TLIIntelligence: { getContext: () => ({}) } },
    fetch: () => assert.fail('Reading and reviewing documents must not send network requests'),
    localStorage: { setItem: () => assert.fail('No document persistence') }, sessionStorage: { setItem: () => assert.fail('No document persistence') },
  });
  vm.runInContext(script, ctx);
  return { nodes, ctx, events, dispatched, element, api: ctx.window.TLIDocuments,
    async choose(files = [file()]) { ctx.window.TLIDocuments.open(); nodes['documents-input'].files = files; await nodes['documents-input'].fire('change'); },
    async use() { await nodes['documents-use'].click(); },
    async select(files) { await this.choose(files); await this.use(); },
  };
}

test('chat summary only exposes reviewed filenames and removes one attachment without sending', async () => {
  const f = fixture(); await f.choose([file('a.md', 'Private first body'), file('b.txt', 'Private second body')]);
  assert.deepEqual(plain(f.api.describeContext()), [], 'Unconfirmed review files are not attached');
  await f.use(); f.nodes['chat-input'].value = 'Unsent question';
  f.api.requestContext = () => assert.fail('Summary must not prepare a request');
  const described = f.api.describeContext();
  assert.deepEqual(plain(described), [{ id: 'document:1', label: 'a.md', kind: 'document' }, { id: 'document:2', label: 'b.txt', kind: 'document' }]);
  described[0].label = 'Externally modified'; assert.equal(f.api.describeContext()[0].label, 'a.md');
  f.api.removeContext('document:1');
  assert.deepEqual(plain(f.api.describeContext()), [{ id: 'document:2', label: 'b.txt', kind: 'document' }]);
  assert.equal(f.nodes['chat-input'].value, 'Unsent question');
  assert.equal(f.dispatched.at(-1).type, 'tli-chat-context-changed'); assert.equal(f.dispatched.at(-1).detail, null);
  f.api.clear(); assert.deepEqual(plain(f.api.describeContext()), []);
});

test('local review sends nothing, normalizes line endings, preserves inert text and requires explicit use', async () => {
  const f = fixture(); await f.choose([file('setup.md', '<img onerror=alert(1)>\r\n😀')]);
  assert.match(content(f.nodes['documents-list']), /<img onerror=alert/);
  assert.ok(descendants(f.nodes['documents-list']).every(n => n.innerHTML === undefined));
  assert.throws(() => f.api.requestContext({}), /Use in chat or Cancel/);
  await f.use();
  const context = f.api.requestContext({ device_id: 'fixture' });
  assert.deepEqual(plain(context), { device_id: 'fixture', documents: [{ name: 'setup.md', text: '<img onerror=alert(1)>\n😀' }] });
  f.api.sent(context, receipt(context.documents)); assert.equal(f.api.requestContext({}).documents, undefined);
});

for (const [label, files, error] of [
  ['binary', [file('bad.txt', Buffer.from([65, 0, 66]))], /binary content/],
  ['encoding', [file('bad.txt', Buffer.from([0xff, 0xfe]))], /UTF-8/],
  ['empty', [file('empty.txt', ' \n ')], /nonempty/],
  ['wrong extension', [file('setup.pdf')], /\.txt or .md/],
  ['path name', [file('../setup.md')], /path separators/],
  ['citation delimiters', [file('bad[name].md')], /brackets/],
  ['combined bytes', [file('a.txt', 'x'.repeat(32769)), file('b.txt', 'x'.repeat(32768))], /64 KiB/],
  ['count', Array.from({ length: 5 }, (_, n) => file(n + '.txt')), /four/],
  ['duplicate', [file('ReadMe.md'), file('README.md')], /different filename/],
]) test(`reject ${label} before changing the reviewed selection`, async () => {
  const f = fixture(); await f.select(); await f.choose(files);
  assert.match(f.nodes['documents-status'].textContent, error);
  await findButton(f.nodes['documents-dialog'], 'Cancel').click();
  assert.equal(f.api.requestContext({}).documents[0].name, 'setup.md');
});

test('64 KiB UTF-8 boundary accepted, async reads cannot reappear after cancel, lock or new chat', async () => {
  const f = fixture(); await f.select([file('limit.txt', 'é'.repeat(32768))]);
  assert.equal(f.api.requestContext({}).documents[0].text.length, 32768); f.api.clear();
  for (const action of ['cancel', 'tli-session-locked', 'new-chat']) {
    let release; const reading = f.choose([{ name: 'slow.md', size: 1, arrayBuffer: () => new Promise(r => { release = r; }) }]);
    assert.throws(() => f.api.requestContext({}), /finish reading/);
    if (action === 'cancel') await findButton(f.nodes['documents-dialog'], 'Cancel').click();
    else if (action === 'new-chat') await f.nodes['new-chat-btn'].click();
    else f.events[action].forEach(fn => fn());
    release(Uint8Array.from([65]).buffer); await reading;
    assert.equal(f.api.requestContext({}).documents, undefined);
  }
});

test('mixed action/image/note/Vault context is rejected; plain command-shaped questions remain reference questions', async () => {
  const f = fixture(); await f.select();
  for (const [context, options] of [[{ target_id: 'node' }, {}], [{ diagnostic_id: 'report' }, {}], [{ screenshot: {} }, {}], [{ note_refs: [{}] }, {}], [{ include_vault_secrets: true }, {}], [{}, { image: true }], [{}, { text: '[vault:password]' }]]) assert.throws(() => f.api.requestContext(context, options), /on their own/);
  assert.equal(f.api.requestContext({}, { text: 'Turn off the lights described here' }).documents.length, 1);
});

test('failed or mismatched confirmation retains files; late completion preserves newer selections and locked sessions', async () => {
  const f = fixture(); await f.select(); const sent = f.api.requestContext({});
  assert.throws(() => f.api.sent(sent, {}), /did not confirm/);
  assert.throws(() => f.api.sent(sent, receipt([{ name: 'other.txt', text: 'a' }])), /did not confirm/);
  assert.equal(f.api.requestContext({}).documents.length, 1);
  await findButton(f.nodes['documents-selected'], 'Remove setup.md').click(); await f.select([file('setup.md', 'new text')]);
  f.api.sent(sent, receipt(sent.documents)); assert.equal(f.api.requestContext({}).documents[0].text, 'new text');
  f.events['tli-session-locked'].forEach(fn => fn()); assert.equal(f.api.isCurrent(sent), false);
  f.api.sent(sent, receipt(sent.documents)); assert.equal(f.api.requestContext({}).documents, undefined);
});

test('receipts render bounded metadata with inert filenames and never the source body', () => {
  const f = fixture(), bubble = f.element('div'), metadata = receipt([{ name: '<img>.txt', text: 'SECRET SOURCE BODY' }]);
  f.api.annotateReply(bubble, metadata); assert.match(content(bubble), /Documents provided to AI.*<img>.txt/);
  assert.doesNotMatch(content(bubble), /SECRET SOURCE BODY/); assert.ok(descendants(bubble).every(n => n.innerHTML === undefined));
  for (const invalid of [{}, { document_context: { ...metadata.document_context, actions_performed: true } }, receipt([{ name: '../secret.md', text: 'a' }])]) f.api.annotateReply(bubble, invalid);
  assert.equal(bubble.children.length, 1);
});

for (const provider of ['bundled', 'lmstudio']) for (const failure of [false, true]) test(`actual sendChat uses ${provider}, ${failure ? 'retains failed draft' : 'clears confirmed documents'} without search, mesh shortcut or duplicate send`, async () => {
  const f = fixture(); await f.select(); const docs = plain(f.api.requestContext({}).documents);
  const nodes = f.nodes, requests = [], bubbles = [];
  nodes['chat-input'].value = 'Explain these documents';
  for (const id of ['chat-send-btn', 'abort-chat-btn', 'mode-select', 'temperature-input', 'max-tokens-input']) nodes[id] = f.element('input');
  nodes['mode-select'].value = 'default'; nodes['temperature-input'].value = '0.2'; nodes['max-tokens-input'].value = '512';
  let release;
  Object.assign(f.ctx, { AbortController, _chatImageB64: null, _chatImageMime: null, _chatImageReadVersion: 0, _chatImageReading: false,
    $: id => nodes[id], showToast() {}, tliSearchIsEnabled: () => true, tliShouldGateForSearch: () => assert.fail('No document search shortcut'),
    appendMessage: () => { const b = f.element('div'); bubbles.push(b); return b; },
    resolveIntelligenceRoute: () => new Promise(r => { release = r; }), IntelligenceSource: { LAN_LLM: 'lan', NONE: 'none' }, lanAiChat: () => assert.fail('No document mesh shortcut'),
    lastSendTs: 0, readSettings: () => ({ defaultBrain: provider }), isTeachingMode: () => false, setModelStatus() {}, debugLog() {}, inFlightController: null,
    AIStatus: { local: {}, lan: { available: true } }, tliFetchBundledStatus: async () => ({ ok: true }), currentConversationId: null, _currentPanelId: 'panel-main',
    buildContextWrappedMessage: ({ latestUserMessage }) => latestUserMessage, formatModelOutput: text => text,
    tliBundledChatStream: async req => { assert.equal(provider, 'bundled'); requests.push(req); req.onMeta({ provider: 'bundled' }); if (failure) throw new Error('Provider unavailable'); req.onDelta('Answer [setup.md:L1-L2]'); req.onMeta(receipt(docs)); },
    fetch: async (url, options) => { if (url === '/api/ai/documents/capabilities') return { ok: true, json: async () => ({ ok: true, protocol: 'tli-document-questions-v1' }) }; assert.equal(provider, 'lmstudio'); assert.equal(url, '/chat'); requests.push(JSON.parse(options.body)); return { ok: !failure, status: failure ? 503 : 200, json: async () => failure ? { detail: 'Provider unavailable' } : { reply: 'Answer [setup.md:L1-L2]', ...receipt(docs) } }; },
    renderAssistantHTML: text => text, _attachSpeakBtn() {}, chatHistoryAdd() {}, tliSpeak() {}, saveConversation() {}, addPreviousPrompt() {},
  });
  const first = app.indexOf('async function sendChat()'), last = app.indexOf('// Shelly Chat Helpers', first);
  vm.runInContext(app.slice(first, last), f.ctx);
  const running = f.ctx.sendChat(); await f.ctx.sendChat(); release({ source: 'lan', node: {} }); await running;
  assert.equal(requests.length, 1); assert.deepEqual(plain(requests[0].documents), docs);
  assert.equal(nodes['chat-send-btn'].disabled, false);
  assert.equal(nodes['chat-input'].value, failure ? 'Explain these documents' : '');
  if (failure) { assert.match(bubbles[1].textContent, /Provider unavailable/); assert.equal(f.api.requestContext({}).documents.length, 1); }
  else { assert.equal(f.api.requestContext({}).documents, undefined); assert.match(content(bubbles[1]), /Documents provided to AI/); }
});

test('reopened conversation shows metadata while document content stays unavailable', async () => {
  const f = fixture(), rendered = []; f.nodes['chat-output'] = f.element('div');
  Object.assign(f.ctx, { $: id => f.nodes[id], currentConversationId: null, appendMessage: () => { const b = f.element('div'); rendered.push(b); return b; },
    fetch: async () => ({ ok: true, json: async () => ({ messages: [{ role: 'assistant', content: 'Earlier answer', ...receipt([{ name: 'setup.md', text: 'PRIVATE SOURCE BODY' }]) }] }) }) });
  const first = app.indexOf('async function loadConversation('), last = app.indexOf('function addPreviousPrompt', first);
  vm.runInContext(app.slice(first, last), f.ctx); await f.ctx.loadConversation('fixture', 'Document question');
  assert.match(content(rendered[0]), /Documents provided to AI/); assert.doesNotMatch(content(rendered[0]), /PRIVATE SOURCE BODY/);
});

test('resuming another conversation invalidates a pending document reply before history arrives', async () => {
  const f = fixture(); await f.select(); const pending = f.api.requestContext({});
  f.nodes['chat-output'] = f.element('div');
  let release;
  Object.assign(f.ctx, { $: id => f.nodes[id], currentConversationId: 'old', appendMessage: () => f.element('div'),
    fetch: () => new Promise(r => { release = r; }) });
  const first = app.indexOf('async function loadConversation('), last = app.indexOf('function addPreviousPrompt', first);
  vm.runInContext(app.slice(first, last), f.ctx);
  const loading = f.ctx.loadConversation('other', 'Other conversation');
  assert.equal(f.api.isCurrent(pending), false, 'Old reply must already be invalid while the replacement history loads');
  f.api.sent(pending, receipt(pending.documents)); assert.equal(f.api.requestContext({}).documents, undefined);
  release({ ok: true, json: async () => ({ messages: [] }) }); await loading;
  assert.equal(f.ctx.currentConversationId, 'other');
});

for (const [label, ok, result] of [['older backend', false, {}], ['SPA fallback', true, 'html'], ['incorrect capability', true, { ok: true, protocol: 'ordinary-chat' }]]) test(`${label} cannot receive document questions as ordinary chat`, async () => {
  const f = fixture(); await f.select(); const calls = [];
  f.ctx.fetch = async (url, options) => { calls.push({ url, options }); return { ok, json: async () => { if (result === 'html') throw new Error('HTML'); return result; } }; };
  await assert.rejects(f.api.ensureAvailable(f.api.requestContext({})), /No document question was sent/);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/ai/documents/capabilities');
  assert.equal(calls[0].options.body, undefined); assert.equal(calls[0].options.method, undefined);
  assert.equal(f.api.requestContext({}).documents.length, 1);
});

test('automatic page-reload history restoration also renders document provenance', async () => {
  const f = fixture(), bubbles = []; let ready, restore;
  f.nodes['chat-output'] = f.element('div'); f.nodes['chat-output'].querySelector = () => null;
  f.ctx.document.addEventListener = (_event, fn) => { ready = fn; };
  f.ctx.setTimeout = fn => { restore = fn; };
  f.ctx.localStorage.getItem = () => 'saved-conversation';
  f.ctx.appendMessage = () => { const bubble = f.element('div'); bubbles.push(bubble); return bubble; };
  f.ctx.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ role: 'assistant', content: 'Earlier answer', ...receipt([{ name: 'setup.md', text: 'PRIVATE SOURCE BODY' }]) }] }) });
  f.ctx.$ = id => f.nodes[id]; f.ctx.currentConversationId = null;
  Object.defineProperty(f.ctx, 'chatHistory', {get: () => f.ctx.window.chatHistory, set: value => { f.ctx.window.chatHistory = value; }});
  const first = app.indexOf('async function loadConversation('), last = app.indexOf('function addPreviousPrompt', first);
  vm.runInContext(app.slice(first, last), f.ctx); f.ctx.window.loadConversation = f.ctx.loadConversation;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../chat_history.js'), 'utf8'), f.ctx);
  ready(); await restore();
  assert.equal(bubbles.length, 1); assert.match(content(bubbles[0]), /Documents provided to AI/);
  assert.doesNotMatch(content(bubbles[0]), /PRIVATE SOURCE BODY/);
});

const excerptCoverage = () => ({ mode: 'excerpts', selection: 'question_terms', ranges: [{ start: 2, end: 3 }, { start: 40, end: 40 }], included_lines: 3, omitted_lines: 47 });
const excerptMeta = () => ({ document_context: { actions_performed: false, documents: [{ name: 'setup.md', sha256: 'a'.repeat(64), line_count: 50, chars: 800, coverage: excerptCoverage() }] } });

test('excerpt receipt explains exact original ranges, omitted lines and no full review', () => {
  const f = fixture(), bubble = f.element('div');
  f.api.annotateReply(bubble, excerptMeta());
  assert.match(content(bubble), /3 of 50 lines provided · 47 omitted/);
  assert.match(content(bubble), /Original lines: L2–L3, L40/);
  assert.match(content(bubble), /not a review of every line/);
  assert.match(content(bubble), /matching question words/);
  assert.match(content(bubble), /Other relevant passages may be omitted/);
  assert.doesNotMatch(content(bubble), /Full text supplied/);
});

test('representative, omitted, full and legacy document receipts stay distinct', () => {
  const f = fixture();
  for (const [coverage, expected, absent] of [
    [{ ...excerptCoverage(), selection: 'representative' }, /Sampled from positions across/, /Full text supplied/],
    [{ mode: 'omitted', selection: 'none', ranges: [], included_lines: 0, omitted_lines: 50 }, /No lines provided · 50 lines omitted/, /Full text supplied/],
    [{ mode: 'full', selection: 'full', ranges: [{ start: 1, end: 50 }], included_lines: 50, omitted_lines: 0 }, /50 lines provided · Full text supplied/, /No coverage breakdown/],
    [undefined, /No coverage breakdown recorded/, /Full text supplied/],
  ]) {
    const bubble = f.element('div'), metadata = excerptMeta();
    if (coverage) metadata.document_context.documents[0].coverage = coverage;
    else delete metadata.document_context.documents[0].coverage;
    f.api.annotateReply(bubble, metadata);
    assert.match(content(bubble), expected); assert.doesNotMatch(content(bubble), absent);
  }
});

for (const change of [
  { mode: 'full' }, { selection: 'semantic' }, { included_lines: 50 }, { omitted_lines: 0 },
  { ranges: [{ start: 2, end: 3 }, { start: 3, end: 3 }] }, { ranges: [{ start: 3, end: 2 }] },
  { ranges: [{ start: 49, end: 51 }] }, { ranges: [{ start: 1, end: 1 }].flatMap(r => Array(33).fill(r)) },
]) test('invalid document coverage is not rendered as confirmed: ' + JSON.stringify(change).slice(0, 120), async () => {
  const f = fixture(), bubble = f.element('div'), metadata = excerptMeta();
  Object.assign(metadata.document_context.documents[0].coverage, change);
  f.api.annotateReply(bubble, metadata); assert.equal(bubble.children.length, 0);
  const text = Array.from({ length: 50 }, (_, i) => 'Source line ' + i).join('\n');
  await f.select([file('setup.md', text)]);
  metadata.document_context.documents[0].chars = [...text].length;
  assert.throws(() => f.api.sent(f.api.requestContext({}), metadata), /did not confirm/);
  assert.equal(f.api.requestContext({}).documents[0].text, text);
});

test('successful excerpt confirmation clears only confirmed original selection; full source is never persisted', async () => {
  const f = fixture(), text = Array.from({ length: 50 }, (_, i) => 'Source line ' + i).join('\n');
  await f.select([file('setup.md', text)]);
  const context = f.api.requestContext({}), metadata = receipt(context.documents);
  metadata.document_context.documents[0].coverage = excerptCoverage();
  f.api.sent(context, metadata);
  assert.equal(f.api.requestContext({}).documents, undefined);
});

test('document review explains whole-line selection without sending or promising full review', () => {
  const f = fixture(); f.api.open();
  assert.match(content(f.nodes['documents-dialog']), /Longer files use whole-line passages/);
  assert.match(content(f.nodes['documents-dialog']), /answer shows included ranges and omitted lines/);
  assert.match(content(f.nodes['documents-dialog']), /line too long for the model is never silently cut/);
});


function richResponse(name, buffer, text = 'Replace the USB cable.\nThen restart the printer.') {
  const format = name.split('.').pop();
  const origin = { version:1, format, original_sha256:createHash('sha256').update(buffer).digest('hex'), original_bytes:buffer.length,
    text_sha256:createHash('sha256').update(text).digest('hex'), parser:'synthetic reader', unit_kind:format === 'pdf' ? 'page' : 'paragraph', total_units:3,
    units:[{number:1,start:1,end:1},{number:3,start:2,end:2}], empty_units:[2], omissions:['Text extraction only; no OCR or image contents.'] };
  return {ok:true, protocol:'tli-document-extraction-v1', document:{name,text,extraction:{origin,expires_at:Math.floor(Date.now()/1000)+1800,signature:'a'.repeat(64)}}};
}
async function enableRich(f, responder) {
  const calls = [];
  f.ctx.fetch = async (url, options) => {
    calls.push({url,options});
    if (url.endsWith('/extraction-capabilities')) return {ok:true,status:200,json:async()=>({ok:true,protocol:'tli-document-extraction-v1',formats:{pdf:{available:true},docx:{available:true}}})};
    return responder(url,options);
  };
  f.api.open(); await f.nodes['documents-check-support'].click(); return calls;
}
async function chooseRich(f,name,buffer) { f.nodes['documents-rich-input'].files=[file(name,buffer)]; return f.nodes['documents-rich-input'].fire('change'); }

test('PDF upload is separate and explicit; review maps pages, verifies bytes and includes only the signed extracted request', async () => {
  const f=fixture(), raw=Buffer.from('%PDF-synthetic');
  f.api.open(); assert.equal(f.nodes['documents-rich-choose'].disabled,true);
  const calls=await enableRich(f, async(url,options)=>({ok:true,status:200,json:async()=>richResponse('guide.pdf',raw)}));
  assert.equal(calls.length,1); assert.equal(f.nodes['documents-rich-choose'].disabled,false);
  await chooseRich(f,'guide.pdf',raw);
  assert.equal(calls.length,2); assert.equal(calls[1].options.method,'POST'); assert.equal(calls[1].options.headers['Content-Type'],'application/octet-stream');
  assert.deepEqual(Buffer.from(calls[1].options.body),raw);
  assert.equal(f.api.describeContext().length,0,'Uploaded extraction is not attached until explicit Use');
  assert.match(content(f.nodes['documents-list']), /Page 1: L1–L1/); assert.match(content(f.nodes['documents-list']), /No text extracted from pages: 2/);
  assert.match(content(f.nodes['documents-list']), /L2: Then restart/); assert.match(content(f.nodes['documents-status']), /no AI request/);
  await f.use(); const request=f.api.requestContext({});
  assert.equal(request.documents[0].extraction.origin.original_sha256,createHash('sha256').update(raw).digest('hex'));
  const meta=receipt(request.documents); meta.document_context.documents[0].extraction=plain(request.documents[0].extraction.origin);
  const bubble=f.element('div');f.api.annotateReply(bubble,meta);assert.match(content(bubble),/not visual page lines/);
  f.api.sent(request,meta);assert.equal(f.api.requestContext({}).documents,undefined);
});

for (const change of ['original','text','range','expired']) test(`inconsistent rich extraction ${change} retains previous document review`,async()=>{
  const f=fixture(),raw=Buffer.from('synthetic DOCX');await f.select([file('retained.md','Keep this private selection')]);
  await enableRich(f,async()=>{const data=richResponse('manual.docx',raw);
    if(change==='original')data.document.extraction.origin.original_sha256='f'.repeat(64);
    if(change==='text')data.document.text='Substituted body';
    if(change==='range')data.document.extraction.origin.units[1].end=99;
    if(change==='expired')data.document.extraction.expires_at=1;
    return {ok:true,status:200,json:async()=>data};});
  await chooseRich(f,'manual.docx',raw);assert.match(content(f.nodes['documents-status']),/inconsistent/);
  await findButton(f.nodes['documents-dialog'],'Cancel').click();assert.equal(f.api.requestContext({}).documents[0].name,'retained.md');
});

test('duplicate selection does not duplicate host extraction; cancel and lock abort reads and ignore late bodies',async()=>{
  for(const action of ['cancel','lock']){
    const f=fixture(),raw=Buffer.from('synthetic DOCX');let release, started;
    const began=new Promise(r=>started=r);
    const calls=await enableRich(f,async()=>{started();return new Promise(r=>release=r);});
    const pending=chooseRich(f,'manual.docx',raw);await began;await chooseRich(f,'manual.docx',raw);
    assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
    if(action==='lock')f.events['tli-session-locked'].forEach(fn=>fn());else await findButton(f.nodes['documents-dialog'],'Cancel').click();
    assert.equal(calls.at(-1).options.signal.aborted,true);
    release({ok:true,status:200,json:async()=>richResponse('manual.docx',raw)});await pending;
    assert.equal(f.api.requestContext({}).documents,undefined);assert.doesNotMatch(content(f.nodes['documents-list']),/USB/);
  }
});

test('unavailable rich reader has a reason and retains ordinary text flow; support lookup never uploads',async()=>{
  const f=fixture();let calls=0;f.ctx.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({ok:true,protocol:'tli-document-extraction-v1',formats:{pdf:{available:false,reason:'Parser missing'},docx:{available:false,reason:'Isolated worker unavailable'}}})};};
  f.api.open();await f.nodes['documents-check-support'].click();assert.equal(calls,1);assert.equal(f.nodes['documents-rich-choose'].disabled,true);
  assert.match(content(f.nodes['documents-support-status']),/Parser missing/);await f.choose();await f.use();assert.equal(f.api.requestContext({}).documents[0].name,'setup.md');
});

test('expired TLI session while extraction completes clears selected and reviewed private text',async()=>{
  const f=fixture(),raw=Buffer.from('synthetic DOCX');await f.select();
  await enableRich(f,async()=>({ok:false,status:401,json:async()=>({detail:'Unlock TLI'})}));
  await chooseRich(f,'manual.docx',raw);assert.equal(f.api.requestContext({}).documents,undefined);assert.equal(f.nodes['documents-dialog'].open,false);
});
