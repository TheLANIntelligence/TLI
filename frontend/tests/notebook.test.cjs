const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../js/notebook.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const revision = char => char.repeat(64);
const note = (id = 'f-one', extra = {}) => ({ id, title: 'Router setup', text: 'Private saved context for the house.', source: 'user', category: 'general', device_id: null, created_at: '2026-09-07T10:00:00Z', updated_at: '2026-09-07T11:00:00Z', revision: revision('a'), ...extra });
function fixture(notes = [note()]) {
  const nodes = {}, calls = [], docEvents = {}, winEvents = {}, dispatched = [];
  let responseHandler = null, currentNotes = notes;
  function element(tag) {
    const n = { tag, children: [], handlers: {}, textContent: '', value: '', hidden: false, disabled: false, attributes: {}, classList: { remove() {} },
      setAttribute(k, v) { this.attributes[k] = v; },
      append(...items) { this.children.push(...items); }, appendChild(item) { this.append(item); }, before(item) { nodes.before = item; },
      replaceChildren(...items) { this.children = items; },
      addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); },
      fire(k, event = {}) { return Promise.all((this.handlers[k] || []).map(fn => fn({preventDefault() {}, ...event}))); }, click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; },
      querySelectorAll(selector) { return descendants(this).filter(x => selector.split(',').includes(x.tag)); },
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = this; }, get() { return Object.keys(nodes).find(k => nodes[k] === this); } });
    return n;
  }
  const body = element('body'), row = element('div'), actions = element('div');
  for (const id of ['notebook-open', 'chat-input', 'new-chat-btn']) nodes[id] = element(id === 'chat-input' ? 'textarea' : 'button');
  const ctx = vm.createContext({ console, Date, CustomEvent, currentDeviceId: 'browser-fixture',
    document: { body, readyState: 'complete', createElement: element, getElementById: id => nodes[id] || null,
      querySelector: selector => selector === '.chat-input-row' ? row : actions,
      addEventListener: (key, fn) => (docEvents[key] ||= []).push(fn) },
    window: { addEventListener: (key, fn) => (winEvents[key] ||= []).push(fn), dispatchEvent: event => dispatched.push(event), TLIIntelligence: { getContext: () => ({}) } },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      let result;
      if (responseHandler) result = await responseHandler(url, options);
      if (result === undefined) result = url.startsWith('/api/intelligence/devices') ? { devices: [{ id: 'node-host', name: 'Office computer' }] } : { facts: currentNotes };
      return { ok: !result.status || result.status === 200, status: result.status || 200, json: async () => result.body || result };
    },
  });
  vm.runInContext(script, ctx);
  return { nodes, calls, ctx, element, dispatched, api: ctx.window.TLINotebook, events: winEvents,
    handler(fn) { responseHandler = fn; }, notes(value) { currentNotes = value; },
    async open(receipt) { await ctx.window.TLINotebook.open(receipt); await tick(); },
    async use(id = 'f-one') { const n = currentNotes.find(n => n.id === id); const card = nodes['notebook-list'].children.find(c => c.children.some(ch => ch.tag === 'h3' && ch.textContent === n.title)); await findButton(card, 'Use for next question').click(); },
    async edit(id = 'f-one') { const n = currentNotes.find(n => n.id === id); await findButton(nodes['notebook-list'], 'Edit ' + n.title).click(); },
  };
}
test('linked-note entry blocks both current and retained dirty source drafts, then passes only a clean reference',async()=>{
  const f=fixture(),opened=[];f.ctx.window.TLINoteLinks={open:ref=>opened.push(ref)};await f.open();await f.edit();
  f.nodes['notebook-title'].value='Unsaved changed title';await f.nodes['notebook-title'].fire('input');await findButton(f.nodes['notebook-editor'],'Linked notes…').click();
  assert.equal(opened.length,0);assert.match(f.nodes['notebook-status'].textContent,/unsaved changes/);await f.nodes['notebook-back'].click();await findButton(f.nodes['notebook-list'],'Linked notes…').click();assert.equal(opened.length,0);
  await f.edit();f.nodes['notebook-title'].value='Router setup';await f.nodes['notebook-title'].fire('input');await findButton(f.nodes['notebook-editor'],'Linked notes…').click();assert.equal(opened.length,1);assert.deepEqual(JSON.parse(JSON.stringify(opened[0])),{id:'f-one',revision:revision('a')});assert.equal(f.calls.some(c=>c.options.method==='POST'||c.options.method==='PUT'),false);
});
test('note relationship navigation does not invent a Chat receipt or attach a note',async()=>{
 const f=fixture();await f.api.open({id:'f-one',revision:revision('b')},{source:'note_link'});assert.match(f.nodes['notebook-status'].textContent,/from a relationship/);assert.doesNotMatch(f.nodes['notebook-status'].textContent,/since that chat/);assert.equal(f.api.describeContext().length,0);
});
function descendants(root) { return root?.children.flatMap(child => [child, ...descendants(child)]) || []; }
function findButton(root, label) { const b = descendants(root).find(n => n.tag === 'button' && n.textContent === label); assert.ok(b, 'Button exists: ' + label); return b; }
function content(root) { return [root?.textContent, ...descendants(root).map(n => n.textContent)].join(' '); }
const plain = value => JSON.parse(JSON.stringify(value));

for (const label of ['Setup detail', 'Preference', 'Fix to remember']) test(`${label} starter opens an unsaved draft without inventing a confirmed fix`, async () => {
  const f = fixture([]); await f.open();
  assert.match(content(f.nodes['notebook-dialog']), /Notes & fixes.*With.*Use saved notes.*earlier conversation is not included/);
  assert.match(content(f.nodes['notebook-dialog']), /access PIN off.*shared local account/);
  await findButton(f.nodes['notebook-list'], label).click();
  assert.equal(f.nodes['notebook-editor'].hidden, false);
  assert.ok(f.nodes['notebook-text'].value.length > 0);
  assert.notEqual(f.nodes['notebook-category'].value, 'verified_fix');
  assert.match(content(f.nodes['notebook-editor']), /unsaved starting point.*does not mark it as a verified/);
  assert.ok(f.calls.every(call => call.options.method === 'GET' || !call.options.method));
  assert.deepEqual(plain(f.api.describeContext()), []);
});

test('returning users can start an example through New note and an unfinished draft is never overwritten', async () => {
  const f = fixture(); await f.open();
  assert.match(content(f.nodes['notebook-dialog']), /Keep setup details, preferences and past fixes so you can refer to them later\./);
  await findButton(f.nodes['notebook-dialog'], 'New note').click();
  await findButton(f.nodes['notebook-editor'], 'Fix to remember').click();
  assert.equal(f.nodes['notebook-title'].value, 'Fix to remember');
  f.nodes['notebook-text'].value = 'An unfinished fix description';
  await f.nodes['notebook-back'].click(); await findButton(f.nodes['notebook-dialog'], 'New note').click();
  assert.equal(f.nodes['notebook-text'].value, 'An unfinished fix description');
  assert.ok(f.calls.every(call => !call.options.body));
});

test('Back, Close and opening another note preserve independent drafts and original save revisions', async () => {
  const f = fixture([note(), note('f-two', {title:'Display setup'})]); await f.open(); await f.edit();
  f.nodes['notebook-title'].value = 'Router draft'; f.nodes['notebook-text'].value = 'Unsaved router change';
  await f.nodes['notebook-back'].click();
  assert.match(content(f.nodes['notebook-drafts']), /Router draft/);
  await f.edit('f-two'); f.nodes['notebook-text'].value = 'Unsaved display change';
  await findButton(f.nodes['notebook-dialog'], 'Close notes').click(); await f.open();
  assert.match(content(f.nodes['notebook-drafts']), /Router draft.*Display setup/);
  await f.api.open({id:'f-one', revision:revision('a')}, {source:'search'});
  assert.equal(f.nodes['notebook-text'].value, 'Unsaved router change');
  assert.equal(f.nodes['notebook-title'].value, 'Router draft');
  f.handler((url, options) => options.method === 'PATCH' ? {status:409, body:{detail:'This note changed.'}} : undefined);
  await f.nodes['notebook-save'].click();
  const sent = JSON.parse(f.calls.find(call => call.options.method === 'PATCH').options.body);
  assert.equal(sent.expected_revision, revision('a'));
  assert.equal(f.nodes['notebook-text'].value, 'Unsaved router change');
  assert.equal(f.calls.filter(call => call.options.method !== 'GET' && call.options.method).length, 1);
});

test('Escape keeps a new draft and discard requires explicit review without changing saved notes', async () => {
  const f = fixture([]); await f.open(); await findButton(f.nodes['notebook-list'], 'Preference').click();
  f.nodes['notebook-text'].value = 'My unsaved preference'; let prevented = false;
  await f.nodes['notebook-dialog'].fire('cancel', {preventDefault() {prevented = true;}});
  assert.equal(prevented, true); assert.equal(f.nodes['notebook-dialog'].open, false);
  await f.open(); const drafts = f.nodes['notebook-drafts'];
  await findButton(drafts, 'Discard draft…').click();
  assert.match(content(drafts), /Discard the unsaved draft.*saved note.*unchanged/);
  await findButton(drafts, 'Keep draft').click(); await findButton(drafts, 'Resume draft').click();
  assert.equal(f.nodes['notebook-text'].value, 'My unsaved preference');
  await f.nodes['notebook-back'].click(); await findButton(drafts, 'Discard draft…').click();
  await findButton(drafts, 'Discard this draft').click();
  assert.equal(drafts.hidden, true); assert.equal(drafts.children.length, 0);
  assert.ok(f.calls.every(call => !call.options.body));
});

test('successful save clears only its draft while another unfinished note remains', async () => {
  const f = fixture([note(), note('f-two', {title:'Display setup'})]); await f.open(); await f.edit();
  f.nodes['notebook-text'].value = 'Router draft'; await f.nodes['notebook-back'].click();
  await f.edit('f-two'); f.nodes['notebook-text'].value = 'Display draft';
  f.handler((url, options) => options.method === 'PATCH' ? note('f-two', {title:'Display setup', text:'Display draft', revision:revision('b')}) : undefined);
  await f.nodes['notebook-save'].click(); await f.nodes['notebook-back'].click();
  assert.match(content(f.nodes['notebook-drafts']), /Router setup/);
  assert.doesNotMatch(content(f.nodes['notebook-drafts']), /Display setup/);
  assert.equal(f.calls.filter(call => call.options.method === 'PATCH').length, 1);
});

test('a note with a retained draft cannot silently select the older saved text for chat', async () => {
  const f = fixture(); await f.open(); await f.edit();
  f.nodes['notebook-text'].value = 'Unsent draft'; await f.nodes['notebook-back'].click(); await f.use();
  assert.match(f.nodes['notebook-status'].textContent, /unsaved changes.*Save or discard/);
  assert.deepEqual(plain(f.api.describeContext()), []);
  assert.equal(f.nodes['notebook-dialog'].open, true);
});

test('locking clears retained drafts and a late load cannot restore their text', async () => {
  const f = fixture(); await f.open(); await f.edit();
  f.nodes['notebook-text'].value = 'Private unfinished draft'; await f.nodes['notebook-back'].click();
  let finish; f.handler(url => url.includes('/memory') ? new Promise(resolve => {finish = resolve;}) : undefined);
  const opening = f.api.open(); await tick(); for (const fn of f.events['tli-session-locked']) fn();
  finish({facts:[note()]}); await opening;
  assert.equal(f.nodes['notebook-drafts'].children.length, 0);
  assert.doesNotMatch(content(f.nodes['notebook-dialog']), /Private unfinished draft/);
  f.handler(null); await f.open();
  assert.equal(f.nodes['notebook-drafts'].hidden, true);
});

test('closing an in-flight result open cannot replace the draft editor after the read completes', async () => {
  const f = fixture(); await f.open(); await f.edit();
  f.nodes['notebook-text'].value = 'Retained draft';
  let finish; f.handler(url => url.includes('/memory') ? new Promise(resolve => {finish = resolve;}) : undefined);
  const opening = f.api.open({id:'f-one', revision:revision('a')}); await tick();
  await findButton(f.nodes['notebook-dialog'], 'Close notes').click();
  finish({facts:[note()]}); await opening;
  assert.equal(f.nodes['notebook-dialog'].open, false);
  assert.equal(f.nodes['notebook-editor'].hidden, true);
  assert.match(content(f.nodes['notebook-drafts']), /Router setup/);
});

test('malformed notes replacement preserves the last list and does not show first-use success', async () => {
  const f = fixture(); await f.open();
  f.handler(url => url.includes('/memory') ? {ok:true} : undefined); await f.nodes['notebook-refresh'].click();
  assert.match(f.nodes['notebook-status'].textContent, /readable notes list.*Previously loaded/);
  assert.match(content(f.nodes['notebook-list']), /Router setup/);
  assert.doesNotMatch(content(f.nodes['notebook-list']), /These examples open drafts/);
});

test('selected notes reject documents and explicit secret keys while preserving all selections', async () => {
  const f = fixture(); await f.open(); await f.use();
  for (const context of [{documents:[{name:'example.txt', text:'Synthetic content'}]}, {secret_keys:['example']}]) {
    assert.throws(() => f.api.requestContext(context), /on their own/);
    assert.equal(f.api.describeContext().length, 1);
  }
  assert.ok(f.calls.every(call => !call.options.body));
});

test('opening a search result shows the current note without inventing a receipt or attaching it', async () => {
  const f = fixture(); f.nodes['chat-input'].value = 'Keep this draft';
  await f.api.open({ id: 'f-one', revision: 'b'.repeat(64) }, { source: 'search' });
  assert.match(content(f.nodes['notebook-dialog']), /Opened the current saved note from search/);
  assert.doesNotMatch(content(f.nodes['notebook-dialog']), /recorded in that chat receipt|changed since that chat/);
  assert.deepEqual(plain(f.api.describeContext()), []);
  assert.equal(f.nodes['chat-input'].value, 'Keep this draft');
  await f.api.open({ id: 'deleted', revision: 'a'.repeat(64) }, { source: 'search' });
  assert.match(content(f.nodes['notebook-dialog']), /Search again for current results/);
});

test('chat summary describes selected notes without bodies, requests or draft changes', async () => {
  const f = fixture([note(), note('f-two', { title: 'Display' })]);
  await f.open(); await f.use(); await f.use('f-two');
  f.nodes['chat-input'].value = 'Keep my draft'; const calls = f.calls.length;
  f.api.requestContext = () => assert.fail('Summary must not prepare a request');
  const described = f.api.describeContext();
  assert.deepEqual(plain(described), [{ id: 'note:f-one', label: 'Router setup', kind: 'note' }, { id: 'note:f-two', label: 'Display', kind: 'note' }]);
  described[0].label = 'Changed outside the controller';
  assert.equal(f.api.describeContext()[0].label, 'Router setup');
  f.api.removeContext('note:f-one');
  assert.deepEqual(plain(f.api.describeContext()), [{ id: 'note:f-two', label: 'Display', kind: 'note' }]);
  assert.equal(f.calls.length, calls); assert.equal(f.nodes['chat-input'].value, 'Keep my draft');
  assert.equal(f.dispatched.at(-1).type, 'tli-chat-context-changed');
  assert.equal(f.dispatched.at(-1).detail, null);
  f.api.clear(); assert.deepEqual(plain(f.api.describeContext()), []);
});

test('confirmed-fix filter requires user confirmation and supports device/date/source search', async () => {
  const f = fixture([note('fix', { title: 'Paper feed', category: 'verified_fix', source: 'user_confirmation', device_id: 'node-host' }),
    note('ai', { title: 'AI idea', category: 'verified_fix', source: 'chat_ai' }), note('claim', { title: 'Claim', category: 'verified_fix', source: 'user' })]);
  await f.open(); f.nodes['notebook-kind'].value = 'fixes'; await f.nodes['notebook-kind'].fire('change');
  assert.match(content(f.nodes['notebook-list']), /Paper feed.*does not establish current device health/);
  assert.doesNotMatch(content(f.nodes['notebook-list']), /AI idea|Claim/);
  f.nodes['notebook-filter-device'].value = 'node-host'; f.nodes['notebook-after'].value = '2026-09-08'; await f.nodes['notebook-after'].fire('input');
  assert.match(content(f.nodes['notebook-list']), /No notes match/);
  f.nodes['notebook-after'].value = '2026-09-01'; f.nodes['notebook-search'].value = 'user-confirmed'; await f.nodes['notebook-search'].fire('input');
  assert.match(content(f.nodes['notebook-list']), /Paper feed/);
});

test('saved AI suggestions retain unconfirmed source labels in list and editor', async () => {
  const f = fixture([note('ai', { source: 'chat_ai', chat_source: { role: 'assistant', created_at: '2026-09-01T12:00:00Z' } })]);
  await f.open(); assert.match(content(f.nodes['notebook-list']), /Saved TLI\/AI reply · unconfirmed/);
  await f.edit('ai'); assert.match(content(f.nodes['notebook-editor']), /unconfirmed.*Original chat message/);
  assert.doesNotMatch(content(f.nodes['notebook-editor']), /Linked to a saved diagnostic report/);
});

test('opting out cannot discard deliberately selected notes', async () => {
  const f = fixture(); await f.open(); await f.use();
  assert.throws(() => f.api.requestContext({ use_saved_memory: false }), /Turn on Use saved notes/);
  assert.equal(f.api.requestContext({}).note_refs.length, 1);
});

test('Notebook loads on explicit open, searches body and device, and never sends a chat', async () => {
  const f = fixture([note(), note('f-two', { title: 'Display', text: 'Set the refresh rate.', device_id: 'node-host' })]);
  assert.equal(f.calls.length, 0);
  await f.open();
  assert.equal(f.nodes['notebook-dialog'].open, true);
  assert.deepEqual(f.calls.map(c => c.url).sort(), ['/api/intelligence/devices', '/api/intelligence/memory?client_device_id=browser-fixture']);
  assert.ok(f.calls.every(c => !c.options.body));
  f.nodes['notebook-search'].value = 'private saved'; await f.nodes['notebook-search'].fire('input');
  assert.equal(f.nodes['notebook-list'].children.length, 1); assert.match(content(f.nodes['notebook-list']), /Router setup/);
  f.nodes['notebook-search'].value = 'Office computer'; await f.nodes['notebook-search'].fire('input');
  assert.match(content(f.nodes['notebook-list']), /Display/); assert.doesNotMatch(content(f.nodes['notebook-list']), /Router setup/);
});

test('Use in chat attaches only references and preserves the draft without autosending', async () => {
  const f = fixture(); await f.open(); f.nodes['chat-input'].value = 'My draft'; await f.use();
  const context = f.api.requestContext({ device_id: 'browser-fixture' }, { text: 'Explain this' });
  assert.deepEqual(plain(context), { device_id: 'browser-fixture', note_refs: [{ id: 'f-one', revision: revision('a') }] });
  assert.doesNotMatch(JSON.stringify(context), /Private saved|Router setup/);
  assert.equal(f.nodes['chat-input'].value, 'My draft'); assert.equal(f.nodes['notebook-dialog'].open, false);
  assert.match(content(f.nodes['notebook-selected']), /not measured evidence.*Router setup/);
  assert.equal(f.calls.length, 2);
});

test('selection is capped at four notes and legacy entries require a saved edit', async () => {
  const facts = Array.from({ length: 5 }, (_, i) => note('f-' + i, { title: 'Note ' + i }));
  facts.push(note('device-legacy', { title: 'Old memory', source: 'legacy_device', category: 'legacy_device' }));
  const f = fixture(facts); await f.open();
  for (const n of facts.slice(0, 5)) await f.use(n.id);
  assert.equal(f.api.requestContext({}).note_refs.length, 4); assert.match(f.nodes['notebook-status'].textContent, /up to four/);
  const card = f.nodes['notebook-list'].children.find(c => content(c).includes('Old memory'));
  assert.equal(findButton(card, 'Use for next question').disabled, true); assert.match(content(card), /Edit and save to convert/);
});

test('mixed image, device/report, screenshot and vault requests block without dropping notes', async () => {
  const f = fixture(); await f.open(); await f.use();
  for (const [context, options] of [[{}, { image: true }], [{ screenshot: {} }, {}], [{ target_id: 'host' }, {}], [{ diagnostic_id: 'report' }, {}], [{ include_vault_secrets: true }, {}], [{}, { text: 'Use [vault:password]' }]]) {
    assert.throws(() => f.api.requestContext(context, options), /on their own/);
    assert.equal(f.api.requestContext({}).note_refs.length, 1);
  }
  assert.equal(f.calls.length, 2);
});

test('changed notes require explicit reselection and completion clears only the exact sent versions', async () => {
  const f = fixture(); await f.open(); await f.use();
  const first = f.api.requestContext({});
  f.notes([note('f-one', { revision: revision('b'), text: 'Edited note' })]); await f.open();
  assert.throws(() => f.api.requestContext({}), /Changed since selection/);
  await f.use(); assert.equal(first.note_refs[0].revision, revision('a'));
  f.api.sent(first); assert.equal(f.api.requestContext({}).note_refs[0].revision, revision('b'));
  f.api.sent(f.api.requestContext({})); assert.equal(f.api.requestContext({}).note_refs, undefined);
});

test('save is one mutation and a failed edit preserves text plus the expected revision', async () => {
  const f = fixture(); await f.open(); await f.edit();
  f.nodes['notebook-text'].value = 'An unsaved edit';
  let release;
  f.handler((url, options) => options.method === 'PATCH' ? new Promise(resolve => { release = resolve; }) : undefined);
  const save = f.nodes['notebook-save'].click(); await tick(); await f.nodes['notebook-save'].click();
  const requests = f.calls.filter(c => c.options.method === 'PATCH'); assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).expected_revision, revision('a'));
  release({ status: 409, body: { detail: 'This note changed. Refresh before editing.' } }); await save;
  assert.equal(f.nodes['notebook-text'].value, 'An unsaved edit'); assert.equal(f.nodes['notebook-save'].disabled, false);
  assert.match(f.nodes['notebook-status'].textContent, /changed.*Your edit is still here/);
});

test('malformed successful save responses preserve the editor and previously selected version', async () => {
  const invalid = [{}, [], note('f-one', { revision: 'bad', text: 'My edit' }), note('f-other', { text: 'My edit' }), note('f-one', { text: 'A different edit' }), note('device-legacy', { text: 'My edit' })];
  for (const response of invalid) {
    const f = fixture(); await f.open(); await f.use(); await f.open(); await f.edit();
    f.nodes['notebook-title'].value = 'Unsaved title'; f.nodes['notebook-text'].value = 'My edit';
    f.handler((url, options) => options.method === 'PATCH' ? response : undefined);
    await f.nodes['notebook-save'].click();
    assert.match(f.nodes['notebook-status'].textContent, /did not confirm the saved note.*edit is still here/);
    assert.equal(f.nodes['notebook-text'].value, 'My edit'); assert.equal(f.nodes['notebook-title'].value, 'Unsaved title');
    assert.equal(f.nodes['notebook-editor'].hidden, false); assert.equal(f.nodes['notebook-save'].disabled, false);
    assert.equal(f.api.requestContext({}).note_refs[0].revision, revision('a'));
    assert.equal(f.calls.filter(c => c.options.method === 'PATCH').length, 1);
  }
});

test('malformed successful delete responses retain the note and explicit review', async () => {
  for (const response of [{}, [], { id: 'f-one', deleted: false }, { id: 'f-one', deleted: 'true' }, { id: 'f-other', deleted: true }]) {
    const f = fixture(); await f.open(); await f.use(); await f.open(); await f.edit();
    await findButton(f.nodes['notebook-editor'], 'Delete note…').click();
    f.handler((url, options) => options.method === 'DELETE' ? response : undefined);
    await findButton(f.nodes['notebook-delete-review'], 'Delete this note').click();
    assert.match(f.nodes['notebook-status'].textContent, /did not confirm.*deletion was not confirmed/);
    assert.equal(f.nodes['notebook-delete-review'].hidden, false); assert.equal(f.nodes['notebook-editor'].hidden, false);
    assert.equal(f.nodes['notebook-text'].value, note().text); assert.equal(f.api.requestContext({}).note_refs.length, 1);
    assert.equal(f.calls.filter(c => c.options.method === 'DELETE').length, 1);
  }
});

test('creating a note does not select it, and edited legacy categories are preserved', async () => {
  const f = fixture([note('f-one', { category: 'work' })]); await f.open();
  let saved;
  f.handler((url, options) => { if (options.method === 'POST' || options.method === 'PATCH') { saved = JSON.parse(options.body); return note(options.method === 'POST' ? 'f-new' : 'f-one', { ...saved, revision: revision('b') }); } });
  await findButton(f.nodes['notebook-browser'], 'New note').click(); f.nodes['notebook-title'].value = 'New note'; f.nodes['notebook-text'].value = 'A detail';
  await f.nodes['notebook-save'].click(); assert.equal(saved.title, 'New note'); assert.equal(saved.category, 'general'); assert.equal(saved.expected_revision, undefined);
  assert.equal(f.api.requestContext({}).note_refs, undefined);
  await f.nodes['notebook-back'].click(); await f.edit(); f.nodes['notebook-text'].value = 'Changed work note'; await f.nodes['notebook-save'].click();
  assert.equal(saved.category, undefined, 'Unknown existing categories are left unchanged'); assert.equal(saved.expected_revision, revision('a'));
});

test('delete needs explicit inline confirmation and sends the revision once', async () => {
  const f = fixture(); await f.open(); await f.use(); await f.open(); await f.edit();
  await findButton(f.nodes['notebook-editor'], 'Delete note…').click();
  assert.equal(f.calls.filter(c => c.options.method === 'DELETE').length, 0);
  assert.equal(f.nodes['notebook-delete-review'].hidden, false); assert.match(content(f.nodes['notebook-delete-review']), /chat replies.*remain/);
  f.handler((url, options) => options.method === 'DELETE' ? { deleted: true, id: 'f-one' } : undefined);
  await findButton(f.nodes['notebook-delete-review'], 'Delete this note').click();
  const calls = f.calls.filter(c => c.options.method === 'DELETE'); assert.equal(calls.length, 1); assert.match(calls[0].url, new RegExp('expected_revision=' + revision('a')));
  assert.throws(() => f.api.requestContext({}), /No longer available/); assert.match(f.nodes['notebook-status'].textContent, /Saved note deleted/);
});

test('legacy device-memory edit promotes to an owned, selectable note', async () => {
  const legacy = note('device-old', { title: 'Old memory', source: 'legacy_device', category: 'legacy_device' });
  const f = fixture([legacy]); await f.open(); await f.edit('device-old');
  f.handler((url, options) => {
    if (options.method !== 'PATCH') return;
    const payload = JSON.parse(options.body); assert.equal(payload.category, 'general'); assert.equal(payload.expected_revision, revision('a'));
    return note('f-promoted', { title: 'Old memory' });
  });
  await f.nodes['notebook-save'].click(); await findButton(f.nodes['notebook-editor'], 'Use for next question').click();
  assert.equal(f.api.requestContext({}).note_refs[0].id, 'f-promoted');
});

test('session lock clears loaded text and selections and ignores an in-flight read', async () => {
  const f = fixture(); await f.open(); await f.use(); await f.open(); await f.edit();
  let release;
  f.handler((url, options) => options.method === 'GET' && url.includes('/memory') ? new Promise(resolve => { release = resolve; }) : undefined);
  const opening = f.api.open(); await tick();
  for (const fn of f.events['tli-session-locked']) fn();
  assert.equal(f.nodes['notebook-dialog'].open, false); assert.equal(f.nodes['notebook-editor'].children.length, 0);
  assert.equal(f.api.requestContext({}).note_refs, undefined);
  release({ facts: [note()] }); await opening;
  assert.equal(f.nodes['notebook-list'].children.length, 0); assert.equal(f.nodes['notebook-refresh'].disabled, false);
});

test('401 during a save removes the editor and does not repopulate private state', async () => {
  const f = fixture(); await f.open(); await f.edit();
  f.handler((url, options) => options.method === 'PATCH' ? { status: 401, body: { detail: 'Session expired' } } : undefined);
  await f.nodes['notebook-save'].click();
  assert.equal(f.nodes['notebook-editor'].children.length, 0); assert.equal(f.nodes['notebook-list'].children.length, 0); assert.equal(f.nodes['notebook-dialog'].open, false);
});

test('an old session completion cannot clear the next session selections', async () => {
  const f = fixture(); await f.open(); await f.use(); const previous = f.api.requestContext({});
  for (const fn of f.events['tli-session-locked']) fn();
  await f.open(); await f.use(); f.api.sent(previous);
  assert.equal(f.api.requestContext({}).note_refs.length, 1);
});

test('a missing historical device association survives an unrelated note edit', async () => {
  const f = fixture([note('f-one', { device_id: 'removed-device' })]); await f.open(); await f.edit();
  assert.match(content(f.nodes['notebook-device']), /removed-device.*not in current inventory/);
  let payload;
  f.handler((url, options) => { if (options.method === 'PATCH') { payload = JSON.parse(options.body); return note('f-one', { device_id: 'removed-device', ...payload }); } });
  f.nodes['notebook-text'].value = 'Updated explanation'; await f.nodes['notebook-save'].click();
  assert.equal(payload.device_id, undefined, 'An unchanged historical association must not require rediscovery');
});

test('favorite opens current note without inventing a chat receipt', async () => {
  const f = fixture();
  await f.api.open({ id: 'f-one', revision: revision('b') }, { source: 'saved_place' });
  assert.match(f.nodes['notebook-status'].textContent, /current saved note from your favorite/);
  assert.doesNotMatch(f.nodes['notebook-status'].textContent, /chat|receipt/);
  f.notes([]); await f.api.open({ id: 'f-one' }, { source: 'saved_place' });
  assert.match(f.nodes['notebook-status'].textContent, /favorite is retained/);
});

test('receipts contain inert provenance, and opening shows changed or deleted status', async () => {
  const f = fixture(), bubble = f.element('div');
  const selected = note('f-one', { title: '<img src=x onerror=alert(1)>' });
  f.api.annotateReply(bubble, { note_context: { notes: [selected], actions_performed: false } });
  assert.match(content(bubble), /Notes provided to AI.*<img.*No actions performed/); assert.doesNotMatch(content(bubble), /Private saved context/);
  assert.ok(descendants(bubble).every(n => n.innerHTML === undefined));
  f.notes([note('f-one', { revision: revision('b') })]); await findButton(bubble, 'Open current note').click();
  assert.match(f.nodes['notebook-status'].textContent, /changed since that chat/);
  f.notes([]); await findButton(bubble, 'Open current note').click(); assert.match(f.nodes['notebook-status'].textContent, /no longer available/);
  const count = bubble.children.length;
  for (const context of [null, {}, { notes: [selected], actions_performed: true }, { notes: [{ ...selected, revision: 'bad' }], actions_performed: false }]) f.api.annotateReply(bubble, { note_context: context });
  assert.equal(bubble.children.length, count);
});

for (const fail of [false, true]) test(`note send ${fail ? 'preserves draft and selections on interruption' : 'clears confirmed selections and renders receipt'} without a direct LAN or search shortcut`, async () => {
  const f = fixture(); await f.open(); await f.use();
  const nodes = f.nodes; nodes['chat-input'].value = 'What did I save?';
  for (const id of ['chat-send-btn', 'abort-chat-btn', 'mode-select', 'temperature-input', 'max-tokens-input']) nodes[id] = f.element('input');
  nodes['mode-select'].value = 'default'; nodes['temperature-input'].value = '0.2'; nodes['max-tokens-input'].value = '512';
  const bubbles = [], requests = [], annotations = [];
  const annotate = f.api.annotateReply;
  f.api.annotateReply = (bubble, metadata) => { annotations.push(metadata); annotate(bubble, metadata); };
  let release;
  Object.assign(f.ctx, { AbortController, _chatImageB64: null, _chatImageMime: null, _chatImageReadVersion: 0, _chatImageReading: false,
    $: id => nodes[id], showToast() {}, tliSearchIsEnabled: () => true, tliShouldGateForSearch: () => assert.fail('Notes must not trigger search'),
    appendMessage: () => { const b = f.element('div'); bubbles.push(b); return b; },
    resolveIntelligenceRoute: () => new Promise(resolve => { release = resolve; }), IntelligenceSource: { LAN_LLM: 'lan', NONE: 'none' },
    lanAiChat: () => assert.fail('Notes must stay on the owner-aware backend route'),
    lastSendTs: 0, readSettings: () => ({}), isTeachingMode: () => false, setModelStatus() {}, debugLog() {}, inFlightController: null,
    AIStatus: { local: {}, lan: { available: false } }, tliFetchBundledStatus: async () => ({ ok: false }), currentConversationId: null, _currentPanelId: 'panel-main',
    buildContextWrappedMessage: ({ latestUserMessage }) => latestUserMessage,
    tliBundledChatStream: async req => { requests.push(req); req.onMeta({ provider: 'bundled', model: 'fixture-model', host: { name: 'Fixture host' } }); if (fail) throw new Error('Provider stopped'); req.onDelta('Here is the explanation.'); req.onMeta({ note_context: { notes: [note()], actions_performed: false } }); },
    renderAssistantHTML: text => text, _attachSpeakBtn() {}, chatHistoryAdd() {}, tliSpeak() {},
  });
  const first = app.indexOf('async function sendChat()'), last = app.indexOf('// Shelly Chat Helpers', first);
  vm.runInContext(app.slice(first, last), f.ctx);
  const running = f.ctx.sendChat(); await f.ctx.sendChat(); release({ source: 'lan', node: { name: 'Peer' } }); await running;
  assert.equal(requests.length, 1); assert.deepEqual(plain(requests[0].note_refs), [{ id: 'f-one', revision: revision('a') }]);
  assert.equal(nodes['chat-send-btn'].disabled, false);
  assert.equal(nodes['chat-input'].value, fail ? 'What did I save?' : '');
  if (fail) { assert.equal(f.api.requestContext({}).note_refs.length, 1); assert.match(bubbles[1].textContent, /Provider stopped/); }
  else {
    assert.equal(f.api.requestContext({}).note_refs, undefined); assert.match(content(bubbles[1]), /Notes provided to AI/);
    assert.equal(annotations[0].provider, 'bundled'); assert.equal(annotations[0].model, 'fixture-model'); assert.equal(annotations[0].host.name, 'Fixture host');
    assert.equal(annotations[0].note_context.notes[0].id, 'f-one');
  }
});

test('reopened conversations render note provenance without adding note bodies to LAN history', async () => {
  const f = fixture(), rendered = [];
  f.nodes['chat-output'] = f.element('div');
  Object.assign(f.ctx, { $: id => f.nodes[id], currentConversationId: null,
    appendMessage: (role, text) => { const b = f.element('div'); rendered.push(b); return b; },
    fetch: async () => ({ ok: true, json: async () => ({ messages: [{ role: 'assistant', content: 'Earlier answer', note_context: { notes: [note()], actions_performed: false } }] }) }),
  });
  const first = app.indexOf('async function loadConversation('), last = app.indexOf('function addPreviousPrompt', first);
  vm.runInContext(app.slice(first, last), f.ctx); await f.ctx.loadConversation('existing-conversation', 'Notes');
  assert.match(content(rendered[0]), /Notes provided to AI/); assert.doesNotMatch(content(rendered[0]), /Private saved/);
});

for (const [selection, fail] of [['explicit', false], ['auto', false], ['explicit', true]]) test(`Notebook retains ${selection} LM Studio selection ${fail ? 'on provider failure' : 'even when bundled inference is healthy'}`, async () => {
  const f = fixture(); await f.open(); await f.use();
  const nodes = f.nodes, requests = [], bubbles = [];
  nodes['chat-input'].value = 'Explain my saved details';
  for (const id of ['chat-send-btn', 'abort-chat-btn', 'mode-select', 'temperature-input', 'max-tokens-input']) nodes[id] = f.element('input');
  nodes['mode-select'].value = 'default'; nodes['temperature-input'].value = '0.2'; nodes['max-tokens-input'].value = '512';
  f.ctx.window.__tliActiveAISource = selection === 'auto' ? 'lmstudio' : 'bundled';
  Object.assign(f.ctx, { AbortController, _chatImageB64: null, _chatImageMime: null, _chatImageReadVersion: 0, _chatImageReading: false,
    $: id => nodes[id], showToast() {}, tliSearchIsEnabled: () => true, tliShouldGateForSearch: () => assert.fail('No web search for notes'),
    appendMessage: () => { const b = f.element('div'); bubbles.push(b); return b; },
    resolveIntelligenceRoute: async () => ({ source: 'local' }), IntelligenceSource: { LAN_LLM: 'lan', NONE: 'none' },
    lastSendTs: 0, readSettings: () => ({ defaultBrain: selection === 'explicit' ? 'lmstudio' : 'auto' }), isTeachingMode: () => false,
    setModelStatus() {}, debugLog() {}, inFlightController: null, AIStatus: { local: {}, lan: { available: true } },
    tliFetchBundledStatus: async () => ({ ok: true }), currentConversationId: null, _currentPanelId: 'panel-main',
    buildContextWrappedMessage: ({ latestUserMessage }) => latestUserMessage, formatModelOutput: text => text,
    tliBundledChatStream: () => assert.fail('Selected LM Studio must not use bundled-only notebook SSE'),
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: !fail, status: fail ? 503 : 200, json: async () => fail ? { detail: 'LM Studio unavailable' } : { reply: 'Your selected notes describe the setup.', conversation_id: null, note_context: { notes: [note()], actions_performed: false } } }; },
    chatHistoryAdd() {}, saveConversation() {}, addPreviousPrompt() {},
  });
  const first = app.indexOf('async function sendChat()'), last = app.indexOf('// Shelly Chat Helpers', first);
  vm.runInContext(app.slice(first, last), f.ctx);
  await f.ctx.sendChat();
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/chat'); assert.equal(requests[0].body.brain, 'lmstudio');
  assert.deepEqual(plain(requests[0].body.note_refs), [{ id: 'f-one', revision: revision('a') }]);
  if (fail) { assert.equal(f.api.requestContext({}).note_refs.length, 1); assert.equal(nodes['chat-input'].value, 'Explain my saved details'); assert.match(bubbles[1].textContent, /LM Studio unavailable/); }
  else { assert.equal(f.api.requestContext({}).note_refs, undefined); assert.match(content(bubbles[1]), /Notes provided to AI/); }
});
