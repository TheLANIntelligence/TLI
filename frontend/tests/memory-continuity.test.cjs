const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/memory-continuity.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ref = { conversation_id: 'conv-fixture', message_index: 1, revision: 'a'.repeat(64) };
const note = { id: 'f-chat-test', revision: 'b'.repeat(64), text: 'Reviewed suggestion', title: 'Printer', source: 'chat_ai' };
const preview = { source: { ...ref, role: 'assistant', created_at: '2026-09-01T12:00:00Z', provider: 'bundled' }, source_kind: 'ai_suggestion', text: 'Original AI reply', suggested_text: 'Original AI reply', suggested_title: 'Printer suggestion', requires_excerpt: false };
function descendants(root) { return root?.children.flatMap(child => [child, ...descendants(child)]) || []; }
function content(root) { return [root?.textContent, ...descendants(root).map(n => n.textContent)].join(' '); }
function button(root, label) { const found = descendants(root).find(n => n.tag === 'button' && n.textContent === label); assert.ok(found, label); return found; }
const plain = value => JSON.parse(JSON.stringify(value));

test('earlier conversation opt-out is per question and requires fresh host support', async () => {
  const f = fixture(); f.nodes['memory-use-history'].checked = false;
  const context = f.api.requestContext({});
  await assert.rejects(f.api.ensureAvailable(context), /without earlier conversation/);
  assert.equal(context.use_conversation_history, false); assert.equal(f.calls.length, 1);
  f.handler(() => ({ok:true, protocol:'tli-memory-continuity-v1', use_conversation_history:true}));
  await f.api.ensureAvailable(context); assert.equal(f.calls.length, 2);
  assert.equal(f.nodes['memory-use-history'].checked, false);
  f.api.sent(context); assert.equal(f.nodes['memory-use-history'].checked, true);
  assert.equal(context.use_conversation_history, false, 'The completed request retains its actual choice');
  const next = f.api.requestContext({}); f.nodes['memory-use-history'].checked = false;
  f.api.sent(next); assert.equal(f.nodes['memory-use-history'].checked, false, 'Do not reset a newer user choice');
  f.emit('tli-session-locked'); assert.equal(f.nodes['memory-use-history'].checked, true);
});

test('final source controls identify actual versions while invalid citations never gain a source action', async () => {
  const f = fixture(), bubble = f.element('div');
  const source = {handle:'N1',kind:'note',id:'fixture-note',label:'Printer fix',revision:'a'.repeat(64),provenance:'chat_ai',ranges:[],saved_at:'2026-09-08T10:00:00Z'};
  const evidence = {version:1,interpretation:'ai',sources:[source],citations_checked:true,citations:[{reference:'[N1]',handle:'N1'}],invalid_citations:1,historical_notes:{checked:true,changed:1,unavailable:1}};
  f.api.decorateReply(bubble, {evidence_context:evidence,note_context:{}});
  assert.match(content(bubble), /AI interpretation.*does not prove.*unconfirmed.*1 reference could not be verified/s);
  assert.match(content(bubble), /1 changed and 1 unavailable/);
  assert.equal(f.calls.length, 0); await button(bubble,'Open current note').click();
  assert.deepEqual(plain(f.opened),[{id:'fixture-note',revision:'a'.repeat(64)}]);
  const malformed = f.element('div');
  f.api.decorateReply(malformed,{evidence_context:{...evidence,citations:[{reference:'[N9]',handle:'N1'}]},note_context:{}});
  assert.match(content(malformed), /identities could not be checked/);
  assert.equal(descendants(malformed).filter(n => n.tag === 'button').length,0);
});

test('document citations cannot span omitted lines and unfinished references stay unverified', () => {
  const f=fixture(), source={handle:'D1',kind:'document',id:'a'.repeat(64),revision:'a'.repeat(64),label:'manual.txt',provenance:'selected_document',ranges:[{start:1,end:3},{start:8,end:9}]};
  const evidence={version:1,interpretation:'ai',sources:[source],citations_checked:true,citations:[{reference:'[manual.txt:L2-L8]',handle:'D1'}],invalid_citations:0};
  const bad=f.element('div'); f.api.decorateReply(bad,{evidence_context:evidence,document_context:{}});
  assert.match(content(bad),/could not be checked/);
  const pending=f.element('div'); f.api.decorateReply(pending,{evidence_context:{...evidence,citations_checked:false,citations:[]},document_context:{}});
  assert.match(content(pending),/not been checked against a completed answer/);
  assert.equal(f.calls.length,0);
});

test('recorded outcome receipts distinguish saved results, no source and host observations without requests', () => {
  const f=fixture(), receipt={version:1,interpretation:'backend',sources:[],citations_checked:true,citations:[],invalid_citations:0};
  const report={handle:'R1',kind:'report',id:'saved-report',label:'Saved diagnostic report',provenance:'recorded_measurement',ranges:[],observed_at:'2026-09-01T10:00:00Z',host_id:'study',target_id:'printer-7'};
  const saved=f.element('div'); f.api.decorateReply(saved,{handled_by:'recorded_outcome',provider:'tli-records',evidence_context:{...receipt,sources:[report]}});
  assert.match(content(saved),/selected saved records.*historical; no new check or repair ran/s);
  assert.doesNotMatch(content(saved),/Backend observation summary|AI interpretation/);
  assert.ok(button(saved,'Open saved report'));
  const empty=f.element('div'); f.api.decorateReply(empty,{handled_by:'recorded_outcome',provider:'tli-records',evidence_context:receipt});
  assert.match(content(empty),/No recorded outcome was supplied/);
  assert.doesNotMatch(content(empty),/Summary of the selected saved records|Backend observation summary/);
  const observed=f.element('div'); f.api.decorateReply(observed,{provider:'tli-tools',evidence_context:{...receipt,sources:[{...report,handle:'O1',kind:'observation',provenance:'host_observation',id:'ram'}]}});
  assert.match(content(observed),/Backend observation summary/);
  assert.equal(f.calls.length,0);
});

test('structured report facts precede AI prose and retain an exact source binding without fetching',()=>{
  const f=fixture(),bubble=f.element('div'),rendered=f.element('section');bubble.append(f.element('p'));let given;
  f.ctx.window.TLIReportFacts={render:(value,expected)=>{given={value,expected};return rendered;}};
  const facts={version:1,report_id:'saved-report'};
  const source={handle:'R1',kind:'report',id:'saved-report',label:'Saved report',provenance:'recorded_measurement',ranges:[],host_id:'host',target_id:null};
  const evidence={version:1,interpretation:'ai',sources:[source],citations_checked:true,citations:[],invalid_citations:0,recorded_report:facts};
  f.api.decorateReply(bubble,{evidence_context:evidence});f.api.decorateReply(bubble,{evidence_context:evidence});
  assert.equal(bubble.children[0],rendered);assert.equal(bubble.children.filter(n=>n===rendered).length,1);
  assert.deepEqual(plain(given),{value:facts,expected:{reportId:'saved-report',hostId:'host',targetId:null}});assert.equal(f.calls.length,0);
});

test('an unbound structured report cannot acquire a source identity from model text',()=>{
  const f=fixture(),bubble=f.element('div');let given='not called';
  f.ctx.window.TLIReportFacts={render:value=>{given=value;return f.element('section');}};
  f.api.decorateReply(bubble,{evidence_context:{version:1,interpretation:'ai',sources:[],citations_checked:true,citations:[],invalid_citations:0,recorded_report:{report_id:'invented'}}});
  assert.equal(given,null);assert.equal(f.calls.length,0);
});

test('historical note labels distinguish changed and unavailable versions without actionable current handles',()=>{
  const f=fixture(),bubble=f.element('div');
  const references=[{exchange_index:1,note_id:'old-note',title:'Earlier fix <script>',revision:'a'.repeat(64),handle:'N1',status:'changed'},{exchange_index:2,note_id:'gone-note',title:'Earlier preference',revision:'b'.repeat(64),handle:'N1',status:'unavailable'}];
  const evidence={version:1,interpretation:'ai',sources:[],citations_checked:true,citations:[],invalid_citations:0,historical_notes:{checked:true,changed:1,unavailable:1,references}};
  f.api.decorateReply(bubble,{evidence_context:evidence});const text=content(bubble);
  assert.match(text,/Earlier exchange 1.*historical N1.*Earlier fix <script>.*saved note changed/s);
  assert.match(text,/Earlier exchange 2.*no longer available/s);assert.match(text,/not current source handles/);
  assert.equal(descendants(bubble).filter(n=>['button','a','script'].includes(n.tag)).length,0);assert.equal(f.calls.length,0);
  for(const refs of [[references[0],references[0]],[references[1],references[0]],[{...references[0],revision:'bad'}]]){
    const invalid=f.element('div');f.api.decorateReply(invalid,{evidence_context:{...evidence,historical_notes:{...evidence.historical_notes,references:refs}}});
    assert.match(content(invalid),/Individual historical reference details could not be checked/);assert.doesNotMatch(content(invalid),/Earlier fix <script>/);
  }
});

test('observed answers show dated host evidence without suggesting AI or saved notes were used', () => {
  const f = fixture(), bubble = f.element('div');
  const metadata = { handled_by: 'observed_status', provider: 'tli-tools', observation_context: {
    schema_version: 1, topic: 'ram', host: {id: 'fixture-host', name: 'Study'}, resource: 'Memory',
    source: 'Passive host memory observation', observed_at: '2026-09-01T10:00:00Z', checked_at: '2026-09-01T10:00:01Z',
    status: 'current', coverage: 'This host only; no process diagnosis.'
  }};
  f.api.decorateReply(bubble, metadata); f.api.decorateReply(bubble, metadata);
  assert.match(content(bubble), /within.*30-second.*when answered/i);
  assert.match(content(bubble), /Study.*fixture-host/);
  assert.match(content(bubble), /did not use saved notes, prior conversation or AI inference/);
  assert.equal(descendants(bubble).filter(n => n.tag === 'summary').length, 1);
  assert.equal(f.calls.length, 0);
});

test('configured model budget is labelled an estimate and unknown capacity cannot imply fit', () => {
  const f = fixture(), bubble = f.element('div');
  const input_budget = { version: 1, provider: 'bundled', model: 'standard', estimation: 'heuristic', capacity_status: 'configured',
    context_tokens: 4096, capacity_source: 'owned_runtime_launch', reserved_output_tokens: 1024, character_limit: 12000,
    input_characters: 2000, estimated_input_tokens: 800, fit: 'estimated', checked_at: '2026-09-01T10:00:01Z' };
  f.api.decorateReply(bubble, { input_budget, note_context: {} });
  assert.match(content(bubble), /planning estimate, not an exact tokenizer count/);
  assert.match(content(bubble), /1,024 tokens reserved/);
  const unknown = f.element('div');
  f.api.decorateReply(unknown, { input_budget: {...input_budget, provider: 'lmstudio', capacity_status: 'unknown', context_tokens: null, fit: 'unknown'}, document_context: {} });
  assert.match(content(unknown), /effective context capacity is unknown/);
  assert.match(content(unknown), /does not guarantee/);
  assert.equal(f.calls.length, 0);
});

test('malformed evidence cannot make unsupported readiness claims or inject private metadata', () => {
  const f = fixture(), bubble = f.element('div');
  f.api.decorateReply(bubble, { provider: 'tli-tools', input_budget: { fit: 'guaranteed', private_prompt: 'HIDDEN_INPUT' },
    observation_context: {status: 'current', source: 'HIDDEN_INPUT'} });
  assert.match(content(bubble), /unknown/);
  assert.doesNotMatch(content(bubble), /HIDDEN_INPUT|guaranteed/);
});
function fixture() {
  const nodes = {}, calls = [], events = {}, opened = [];
  const eventTarget = new EventTarget(), dispatched = [];
  let handler;
  function element(tag) {
    const n = { tag, textContent: '', children: [], handlers: {}, attributes: {}, disabled: false, value: '',
      append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); }, replaceChildren(...items) { this.children = items; }, before(item) { nodes.before = item; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, fn) { (this.handlers[key] ||= []).push(fn); },
      fire(key) { return Promise.all((this.handlers[key] || []).map(fn => fn({ preventDefault() {} }))); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
      querySelectorAll(selector) { return descendants(this).filter(n => selector.split(',').includes(n.tag)); } };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = this; }, get() { return Object.keys(nodes).find(k => nodes[k] === this); } });
    return n;
  }
  const body = element('body'), row = element('div'); nodes['new-chat-btn'] = element('button');
  const ctx = vm.createContext({ console, Date, Event, CustomEvent,
    document: { body, readyState: 'complete', createElement: element, getElementById: id => nodes[id] || null, querySelector: () => row },
    window: { addEventListener: (key, fn) => { (events[key] ||= []).push(fn); eventTarget.addEventListener(key, fn); },
      dispatchEvent: event => { dispatched.push(event.type); return eventTarget.dispatchEvent(event); }, TLINotebook: { open: value => opened.push(value) } },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      let result = handler && await handler(url, options);
      if (result === undefined) result = url.endsWith('capabilities') ? { ok: true, protocol: 'tli-memory-continuity-v1' } : url.endsWith('preview') ? preview : url.endsWith('/devices') ? { devices: [{ id: 'host', name: 'Office PC' }] } : { ok: true, note, already_saved: false };
      return { status: result.status || 200, ok: !result.status || result.status === 200, json: async () => result.body || result };
    } });
  vm.runInContext(source, ctx);
  return { nodes, calls, events, opened, element, ctx, dispatched, api: ctx.window.TLIMemory, handler(fn) { handler = fn; },
    async review(reference = ref) { const bubble = element('div'); ctx.window.TLIMemory.decorateMessage(bubble, { source_ref: reference }); await button(bubble, 'Save to Notes & fixes…').click(); await tick(); return bubble; },
    emit(name) { ctx.window.dispatchEvent(new Event(name)); } };
}

test('closing a reviewed chat copy and opening another message retains the unsaved draft without fetching it again', async () => {
  const f = fixture(); await f.review();
  f.nodes['memory-save-title'].value = 'Unfinished reviewed note'; f.nodes['memory-save-text'].value = 'My reviewed draft';
  await button(f.nodes['memory-save-dialog'], 'Close review').click();
  const count = f.calls.length; await f.review({...ref, message_index:3});
  assert.equal(f.calls.length, count);
  assert.equal(f.nodes['memory-save-title'].value, 'Unfinished reviewed note');
  assert.equal(f.nodes['memory-save-text'].value, 'My reviewed draft');
  assert.match(f.nodes['memory-save-status'].textContent, /Save or discard.*another chat message/);
  assert.equal(f.nodes['memory-save-dialog'].open, true);
});

test('discarding a reviewed copy requires confirmation and never deletes its original message or saved notes', async () => {
  const f = fixture(); await f.review();
  const count = f.calls.length; await button(f.nodes['memory-save-editor'], 'Discard draft…').click();
  assert.equal(f.nodes['memory-save-discard-review'].hidden, false);
  await button(f.nodes['memory-save-editor'], 'Keep editing').click();
  assert.equal(f.nodes['memory-save-text'].value, preview.suggested_text);
  await button(f.nodes['memory-save-editor'], 'Discard draft…').click();
  await button(f.nodes['memory-save-editor'], 'Discard this copy').click();
  assert.equal(f.calls.length, count); assert.equal(f.nodes['memory-save-dialog'].open, false);
  assert.equal(f.nodes['memory-save-editor'].children.length, 0);
});

test('chat summary reflects native memory preference without preparing requests or changing request epochs', async () => {
  const f = fixture(), pending = f.api.requestContext({});
  const prepare = f.api.requestContext;
  f.api.requestContext = () => assert.fail('Summary must not prepare a request');
  assert.deepEqual(plain(f.api.describeContext()), [{ id: 'memory', label: 'Use saved notes: on', kind: 'memory', enabled: true }]);
  f.api.setEnabled(false);
  assert.equal(f.nodes['memory-use-saved'].checked, false);
  assert.deepEqual(plain(f.api.describeContext()), [{ id: 'memory', label: 'Use saved notes: off', kind: 'memory', enabled: false }]);
  assert.equal(f.api.isCurrent(pending), true, 'Preference changes apply to the next request');
  assert.equal(prepare({}).use_saved_memory, false);
  f.nodes['memory-use-saved'].checked = true; await f.nodes['memory-use-saved'].fire('change');
  assert.equal(f.api.describeContext()[0].enabled, true);
  assert.deepEqual(f.dispatched, ['tli-chat-context-changed', 'tli-chat-context-changed']);
  assert.equal(f.calls.length, 0);
});

test('default recall is explicit and keeps the same request identity without any preflight', async () => {
  const f = fixture(), original = { device_id: 'browser' };
  assert.equal(f.calls.length, 0);
  assert.equal(f.api.requestContext(original), original);
  assert.equal(original.use_saved_memory, true);
  await f.api.ensureAvailable(original);
  assert.equal(f.calls.length, 0);
  assert.equal(original.use_conversation_history, true);
  assert.match(content(f.nodes.before), /Use earlier conversation.*Turning either off leaves its saved data unchanged/);
});

test('asking without memory requires a fresh exact capability every time', async () => {
  const f = fixture(); f.nodes['memory-use-saved'].checked = false;
  const first = f.api.requestContext({}); await f.api.ensureAvailable(first);
  const second = f.api.requestContext({}); await f.api.ensureAvailable(second);
  assert.equal(f.calls.length, 2); assert.equal(first.use_saved_memory, false);
  assert.ok(f.calls.every(c => c.options.cache === 'no-store' && c.options.redirect === 'error' && !c.options.body));
});

test('older or unreachable hosts cannot silently ignore opt-out', async () => {
  const f = fixture(); f.nodes['memory-use-saved'].checked = false;
  f.handler(() => ({ ok: true, protocol: 'old' }));
  await assert.rejects(f.api.ensureAvailable(f.api.requestContext({})), /Update.*not been sent/);
  f.handler(() => { throw new Error('offline'); });
  await assert.rejects(f.api.ensureAvailable(f.api.requestContext({})), /could not confirm/);
  assert.ok(f.calls.every(c => c.options.method === 'GET'));
});

test('401 capability preflight dispatches the real lock event and resets ordinary chat controls once', async () => {
  const f = fixture();
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const listener = app.match(/function clearLocalChatSession\(\) \{[\s\S]*?\n\}\r?\nwindow\.addEventListener\("tli-session-locked", clearLocalChatSession\);/);
  assert.ok(listener, 'existing app session-lock handler');
  let deleted = 0, aborted = 0;
  f.ctx.window.TLIConversationLoad = { deleted() { deleted++; } };
  f.ctx.inFlightController = { abort() { aborted++; } };
  for (const id of ['chat-input', 'chat-send-btn', 'abort-chat-btn']) f.nodes[id] = f.element(id === 'chat-input' ? 'textarea' : 'button');
  f.nodes['chat-input'].value = 'Private question'; f.nodes['chat-send-btn'].disabled = true; f.nodes['abort-chat-btn'].disabled = false;
  vm.runInContext(listener[0], f.ctx);
  f.nodes['memory-use-saved'].checked = false;
  const request = f.api.requestContext({});
  f.handler(() => ({ status: 401, body: { detail: 'Locked' } }));
  await assert.rejects(f.api.ensureAvailable(request), /could not confirm/);
  assert.deepEqual(f.dispatched.filter(type => type !== 'tli-chat-context-changed'), ['tli-session-locked']);
  assert.equal(deleted, 1); assert.equal(aborted, 1);
  assert.equal(f.nodes['chat-input'].value, ''); assert.equal(f.nodes['chat-send-btn'].disabled, false); assert.equal(f.nodes['abort-chat-btn'].disabled, true);
  assert.equal(f.api.isCurrent(request), false); assert.equal(f.calls.length, 1);
});

test('401 preview/save clears private editor and dispatches lock without repopulating error content', async () => {
  for (const rejected of ['preview', 'save']) {
    const f = fixture();
    if (rejected === 'save') { await f.review(); f.nodes['memory-save-reviewed'].checked = true; }
    const before = f.calls.length;
    f.handler(url => url.endsWith('/' + rejected) ? { status: 401, body: { detail: 'Private server detail must not populate the review' } } : undefined);
    if (rejected === 'preview') await f.review(); else await f.nodes['memory-save-confirm'].click();
    assert.deepEqual(f.dispatched.filter(type => type !== 'tli-chat-context-changed'), ['tli-session-locked']);
    assert.equal(f.nodes['memory-save-dialog'].open, false); assert.equal(f.nodes['memory-save-editor'].children.length, 0); assert.equal(f.nodes['memory-save-status'].textContent, '');
    assert.equal(f.calls.length, before + 1);
  }
});

test('new chat and session changes invalidate pending capability checks', async () => {
  const f = fixture(); f.nodes['memory-use-saved'].checked = false;
  let resolve; f.handler(() => new Promise(r => { resolve = r; }));
  const context = f.api.requestContext({}), pending = f.api.ensureAvailable(context);
  await f.nodes['new-chat-btn'].click();
  resolve({ ok: true, protocol: 'tli-memory-continuity-v1' });
  await assert.rejects(pending, /conversation changed/);
  assert.equal(f.api.isCurrent(context), false); assert.equal(f.nodes['memory-use-saved'].checked, false);
  f.emit('tli-session-locked'); assert.equal(f.nodes['memory-use-saved'].checked, true);
});

test('selected notes conflict with opt-out without discarding the selection', () => {
  const f = fixture(); f.nodes['memory-use-saved'].checked = false;
  const context = { note_refs: [{ id: 'private', revision: 'c'.repeat(64) }] };
  assert.throws(() => f.api.requestContext(context), /Turn on Use saved notes or remove/);
  assert.equal(context.note_refs.length, 1);
});

test('save controls require persisted pointers and do not duplicate', () => {
  const f = fixture(), bubble = f.element('div'); bubble.textContent = 'Untrusted unsaved text';
  f.api.decorateMessage(bubble, {}); assert.equal(bubble.children.length, 0);
  f.api.decorateMessage(bubble, { source_ref: ref }); f.api.decorateMessage(bubble, { source_ref: ref });
  assert.equal(bubble.children.length, 1); assert.equal(f.calls.length, 0);
});

test('review displays original source/date and requires an explicit reviewed copy', async () => {
  const f = fixture(); await f.review();
  assert.match(content(f.nodes['memory-save-editor']), /TLI\/AI reply · unconfirmed.*does not verify/);
  assert.match(content(f.nodes['memory-save-editor']), /Original AI reply/);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { source_ref: ref });
  await f.nodes['memory-save-confirm'].click();
  assert.match(f.nodes['memory-save-status'].textContent, /check the review box/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/save')).length, 0);
  f.nodes['memory-save-text'].value = 'Reviewed suggestion'; f.nodes['memory-save-reviewed'].checked = true;
  await f.nodes['memory-save-confirm'].click();
  assert.match(f.nodes['memory-save-status'].textContent, /no fix was verified/);
  assert.deepEqual(JSON.parse(f.calls.find(c => c.url.endsWith('/save')).options.body), { source_ref: ref, text: 'Reviewed suggestion', title: 'Printer suggestion', category: 'general', device_id: null, reviewed: true });
  await button(f.nodes['memory-save-editor'], 'Open current saved note').click();
  assert.deepEqual(plain(f.opened[0]), { id: note.id, revision: note.revision });
});

test('long originals require a deliberate excerpt and are not truncated into a note', async () => {
  const f = fixture(); f.handler(url => url.endsWith('/preview') ? { ...preview, text: 'x'.repeat(2001), suggested_text: '', requires_excerpt: true } : undefined);
  await f.review(); assert.equal(f.nodes['memory-save-text'].value, '');
  assert.match(content(f.nodes['memory-save-editor']), /nothing has been shortened automatically/);
});

test('failed save retains reviewed draft and duplicate clicks produce one request', async () => {
  const f = fixture(); await f.review(); let release;
  f.handler(url => url.endsWith('/save') ? new Promise(r => { release = r; }) : undefined);
  f.nodes['memory-save-text'].value = 'My correction'; f.nodes['memory-save-reviewed'].checked = true;
  const pending = f.nodes['memory-save-confirm'].click(); await f.nodes['memory-save-confirm'].click();
  assert.equal(f.calls.filter(c => c.url.endsWith('/save')).length, 1);
  release({ status: 409, body: { detail: 'Source changed' } }); await pending;
  assert.equal(f.nodes['memory-save-text'].value, 'My correction'); assert.equal(f.nodes['memory-save-reviewed'].checked, true);
  assert.match(f.nodes['memory-save-status'].textContent, /Source changed.*draft is still here/);
});

test('edited existing duplicate is reported without claiming the old text was written', async () => {
  const f = fixture(); await f.review(); f.nodes['memory-save-reviewed'].checked = true;
  f.handler(url => url.endsWith('/save') ? { ok: true, already_saved: true, note: { ...note, text: 'Later edit' } } : undefined);
  await f.nodes['memory-save-confirm'].click();
  assert.match(f.nodes['memory-save-status'].textContent, /already saved.*later edits.*kept/);
});

test('wrong source or malformed success is not accepted as a saved note', async () => {
  const f = fixture(); await f.review(); f.nodes['memory-save-reviewed'].checked = true;
  f.handler(url => url.endsWith('/save') ? { ok: true, already_saved: false, note: { ...note, source: 'user_confirmation' } } : undefined);
  await f.nodes['memory-save-confirm'].click();
  assert.match(f.nodes['memory-save-status'].textContent, /did not confirm/);
  assert.equal(f.nodes['memory-save-text'].value, preview.suggested_text);
});

test('late preview and save cannot repopulate private state after session lock', async () => {
  const f = fixture(); let release;
  f.handler(url => url.endsWith('/preview') ? new Promise(r => { release = r; }) : undefined);
  const pending = f.review(); await tick(); f.emit('tli-session-locked'); release(preview); await pending;
  assert.equal(f.nodes['memory-save-dialog'].open, false); assert.equal(f.nodes['memory-save-editor'].children.length, 0);
});

test('receipts show only bounded facts actually provided and original versions open current note', async () => {
  const f = fixture(), bubble = f.element('div');
  const metadata = { memory_context: { use_saved_memory: true, status: 'included', notes: [{ ...note, title: '<img onerror=bad>', updated_at: '2026-09-01T12:00:00Z', device_id: 'host' }], omitted_for_budget: 2 }, conversation_context: { status: 'limited', included_messages: 4, included_exchanges: 2, omitted_messages: 8, character_budget: 10000 } };
  f.api.decorateReply(bubble, metadata); f.api.decorateReply(bubble, metadata);
  assert.equal(bubble.children.length, 1); assert.match(content(bubble), /provided to AI.*does not confirm.*AI suggestion, unconfirmed/);
  assert.match(content(bubble), /2 additional relevant notes.*4 earlier chat messages.*8 earlier messages were left out/);
  assert.doesNotMatch(content(bubble), /Reviewed suggestion/); assert.equal(descendants(bubble).filter(n => n.tag === 'img').length, 0);
  await button(bubble, 'Open current note').click(); assert.deepEqual(plain(f.opened[0]), { id: note.id, revision: note.revision });
});

test('missing and malformed receipts remain unknown rather than claiming empty memory', () => {
  const f = fixture();
  for (const meta of [{}, { memory_context: { status: 'none' } }, { memory_context: { use_saved_memory: true, status: 'included', notes: [], omitted_for_budget: 0 } }]) {
    const bubble = f.element('div'); f.api.decorateReply(bubble, meta);
    assert.match(content(bubble), /host did not report/); assert.doesNotMatch(content(bubble), /No saved notes were provided/);
  }
});

test('deterministic action/tool/diagnostic replies keep valid Save controls without unknown AI context receipts', () => {
  const f = fixture();
  for (const meta of [
    ...['intent_engine', 'tool_fastpath', 'diagnostics'].map(handled_by => ({ handled_by })),
    ...['tli-action', 'tli-tools', 'tli-diagnostics'].map(provider => ({ provider })),
  ]) {
    const bubble = f.element('div'); f.api.decorateReply(bubble, { ...meta, source_ref: ref });
    assert.ok(button(bubble, 'Save to Notes & fixes…'));
    assert.doesNotMatch(content(bubble), /Context for this answer|host did not report/);
    assert.equal(bubble.children.length, 1);
  }
  const peer = f.element('div'); f.api.decorateReply(peer, { provider: 'mesh', handled_by: 'peer' });
  assert.match(content(peer), /host did not report/);
  assert.equal(f.calls.length, 0);
});

test('off receipts explain previous history and selected document/note receipts stay separate', () => {
  const f = fixture(), bubble = f.element('div');
  f.api.decorateReply(bubble, { memory_context: { use_saved_memory: false, status: 'disabled', notes: [], omitted_for_budget: 0 } });
  assert.match(content(bubble), /Earlier conversation may still contain saved information/);
  for (const name of ['note_context', 'document_context', 'screenshot_context']) {
    const selected = f.element('div'); f.api.decorateReply(selected, { [name]: {} }); assert.equal(selected.children.length, 0);
  }
});

const existing = {id:'f-owned',revision:'c'.repeat(64),title:'Printer fix',text:'Old steps',category:'device',device_id:'host',source:'user_confirmation'};
async function chooseExisting(f, target=existing) {
  await f.review(); f.nodes['memory-save-mode'].value='update'; await f.nodes['memory-save-mode'].fire('change'); await tick();
  f.nodes['memory-save-target'].value=target.id; await f.nodes['memory-save-target'].fire('change');
}
test('updating a current owned note requires an explicit target and reviewed revision; proposal and target are compared',async()=>{
  const f=fixture(); f.handler((url,opts)=>url==='/api/intelligence/memory'?{facts:[existing]}:url.endsWith('/save')?{ok:true,already_saved:false,updated_existing:true,note:{...existing,...JSON.parse(opts.body),revision:'d'.repeat(64),source:'chat_ai'}}:undefined);
  await f.review(); assert.equal(f.calls.some(c=>c.url==='/api/intelligence/memory'),false);
  f.nodes['memory-save-title'].value='My proposed title'; f.nodes['memory-save-text'].value='My corrected steps';
  f.nodes['memory-save-mode'].value='update'; await f.nodes['memory-save-mode'].fire('change'); await tick();
  f.nodes['memory-save-reviewed'].checked=true; await f.nodes['memory-save-confirm'].click(); assert.equal(f.calls.filter(c=>c.url.endsWith('/save')).length,0);
  f.nodes['memory-save-target'].value=existing.id; await f.nodes['memory-save-target'].fire('change');
  assert.equal(f.nodes['memory-save-text'].value,'My corrected steps'); assert.equal(f.nodes['memory-save-title'].value,'My proposed title');
  assert.equal(f.nodes['memory-save-category'].value,'device'); assert.equal(f.nodes['memory-save-device'].value,'host');
  assert.match(content(f.nodes['memory-save-comparison']),/Old steps.*My corrected steps/);
  assert.match(content(f.nodes['memory-save-target-area']),/removes any previous confirmed-fix/);
  assert.equal(f.nodes['memory-save-reviewed'].checked,false);
  f.nodes['memory-save-reviewed'].checked=true; await f.nodes['memory-save-confirm'].click();
  const payload=JSON.parse(f.calls.find(c=>c.url.endsWith('/save')).options.body);
  assert.equal(payload.note_id,existing.id); assert.equal(payload.expected_revision,existing.revision);
  assert.match(f.nodes['memory-save-status'].textContent,/Updated the reviewed note/);
});
for(const failure of [409,404,503]) test(`update ${failure} retains proposal but requires refreshed target and new review`,async()=>{
  const f=fixture(); let saved=0;
  f.handler(url=>url==='/api/intelligence/memory'?{facts:[existing]}:url.endsWith('/save')?(saved++,{status:failure,body:{detail:'Current note changed or unavailable'}}):undefined);
  await chooseExisting(f); f.nodes['memory-save-text'].value='Keep this draft'; f.nodes['memory-save-reviewed'].checked=true;
  await f.nodes['memory-save-confirm'].click(); assert.equal(saved,1); assert.equal(f.nodes['memory-save-text'].value,'Keep this draft');
  f.nodes['memory-save-reviewed'].checked=true; await f.nodes['memory-save-confirm'].click(); assert.equal(saved,1);
  assert.match(f.nodes['memory-save-status'].textContent,/Choose and review/);
  await f.nodes['memory-save-refresh'].click(); assert.equal(f.nodes['memory-save-reviewed'].checked,false); assert.equal(f.nodes['memory-save-text'].value,'Keep this draft');
});
test('legacy and malformed notes cannot be selected for replacement',async()=>{
 const f=fixture(); f.handler(url=>url==='/api/intelligence/memory'?{facts:[{...existing,id:'device-legacy'},{...existing,id:'legacy',source:'legacy_device'},{...existing,id:'bad',revision:'no'},existing]}:undefined);
 await chooseExisting(f); assert.equal(f.nodes['memory-save-target'].children.length,2);
});
test('field edits invalidate the update review and confirmed-fix category becomes general',async()=>{
 const f=fixture(), target={...existing,category:'verified_fix'}; f.handler(url=>url==='/api/intelligence/memory'?{facts:[target]}:undefined);
 await chooseExisting(f,target); assert.equal(f.nodes['memory-save-category'].value,'general'); f.nodes['memory-save-reviewed'].checked=true;
 f.nodes['memory-save-text'].value='Edited again'; await f.nodes['memory-save-text'].fire('input'); assert.equal(f.nodes['memory-save-reviewed'].checked,false);
 assert.match(content(f.nodes['memory-save-comparison']),/verified_fix.*Edited again.*general/);
});
test('late owned-note response and old unauthorized response cannot repopulate or lock a new conversation',async()=>{
 const f=fixture(); let release; f.handler(url=>url==='/api/intelligence/memory'?new Promise(r=>release=r):undefined);
 await f.review(); f.nodes['memory-save-mode'].value='update'; await f.nodes['memory-save-mode'].fire('change'); await tick();
 f.api.clear(); release({status:401,body:{detail:'Old session'}}); await tick();
 assert.equal(f.nodes['memory-save-editor'].children.length,0); assert.equal(f.dispatched.includes('tli-session-locked'),false);
});
test('duplicate update clicks submit once; malformed update success does not clear draft',async()=>{
 const f=fixture(); let release;
 f.handler(url=>url==='/api/intelligence/memory'?{facts:[existing]}:url.endsWith('/save')?new Promise(r=>release=r):undefined);
 await chooseExisting(f); f.nodes['memory-save-reviewed'].checked=true;
 const first=f.nodes['memory-save-confirm'].click(); await tick(); await f.nodes['memory-save-confirm'].click();
 assert.equal(f.calls.filter(c=>c.url.endsWith('/save')).length,1);
 release({ok:true,updated_existing:true,already_saved:false,note:{...note,id:'different-note'}}); await first;
 assert.equal(f.nodes['memory-save-text'].value,preview.suggested_text); assert.match(f.nodes['memory-save-status'].textContent,/did not confirm/);
});

test('custom category and retired computer survive reviewed updates but never carry silently into new notes',async()=>{
 const f=fixture(),target={...existing,title:undefined,category:'old_custom',device_id:'retired-computer'};
 f.handler(url=>url==='/api/intelligence/memory'?{facts:[target]}:undefined);await chooseExisting(f,target);
 assert.equal(f.nodes['memory-save-category'].value,'old_custom');assert.equal(f.nodes['memory-save-device'].value,'retired-computer');
 assert.match(content(f.nodes['memory-save-comparison']),/Untitled note/);
 f.nodes['memory-save-text'].value='Keep proposed text';f.nodes['memory-save-title'].value='Keep proposed title';f.nodes['memory-save-reviewed'].checked=true;
 f.nodes['memory-save-mode'].value='new';await f.nodes['memory-save-mode'].fire('change');
 assert.equal(f.nodes['memory-save-category'].value,'general');assert.equal(f.nodes['memory-save-device'].value,'');assert.equal(f.nodes['memory-save-reviewed'].checked,false);
 assert.deepEqual(f.nodes['memory-save-category'].children.map(o=>o.value),['general','preference','device']);assert.equal(f.nodes['memory-save-device'].children.some(o=>o.value==='retired-computer'),false);assert.equal(f.nodes['memory-save-device'].children.some(o=>o.value==='host'),true);
 assert.equal(f.nodes['memory-save-comparison'].hidden,true);assert.equal(f.nodes['memory-save-text'].value,'Keep proposed text');assert.equal(f.nodes['memory-save-title'].value,'Keep proposed title');
});

test('a carried computer confirmed by a late registry response stays selectable when returning to new',async()=>{
 const f=fixture();let release;f.handler(url=>url==='/api/intelligence/memory'?{facts:[existing]}:url.endsWith('/devices')?new Promise(r=>release=r):undefined);
 await chooseExisting(f);release({devices:[{id:'host',name:'Current Office PC'}]});await tick();
 f.nodes['memory-save-mode'].value='new';await f.nodes['memory-save-mode'].fire('change');
 assert.equal(f.nodes['memory-save-device'].children.filter(o=>o.value==='host').length,1);assert.equal(f.nodes['memory-save-device'].children.find(o=>o.value==='host').textContent,'Current Office PC');
});
