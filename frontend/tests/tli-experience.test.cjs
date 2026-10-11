const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/tli-experience.js'), 'utf8');
function fixture(text = '') {
  const events = {}, nodes = {}, prepared = [], opened = [], notices = [];
  let active = 'panel-main', context = [], computerResult = true, buildResult = true;
  function node(id) {
    const classes = new Set(id === 'chat-image-preview' ? ['hidden'] : []);
    return nodes[id] = {value: '', disabled: false, hidden: false, textContent: '',
      classList: {contains: value => value === 'active' ? id === active : classes.has(value), remove: value => classes.delete(value)},
      getAttribute: () => null, addEventListener() {}};
  }
  for (const id of ['panel-main', 'panel-builder', 'panel-homeauto', 'panel-troubleshooting', 'chat-input', 'chat-send-btn', 'chat-image-preview', 'tli-task-status', 'tli-start-computer', 'tli-start-home', 'tli-start-build']) node(id);
  nodes['chat-input'].value = text;
  const window = {addEventListener: (name, fn) => {events[name] = fn;},
    switchPanel(id) {active = id; opened.push(id);}, showToast: value => notices.push(value),
    TLIIntelligence: {isCurrent: () => true, capture: () => 1, describeContext: () => context},
    TLIHostIdentity: {get: () => ({id: 'host-one'})},
    TLITroubleshooting: {async open() {window.switchPanel('panel-troubleshooting');}, prepareRequest(value) {prepared.push(['computer', value]); return computerResult;}},
    TLIWebApps: {async open() {}, prepareRequest(value) {prepared.push(['build', value]); return buildResult;}},
  };
  const document = {readyState: 'loading', hidden: false, getElementById: id => nodes[id], addEventListener() {}};
  vm.runInNewContext(source, {window, document, fetch() {assert.fail('Handoffs must not execute requests');}});
  return {window, document, events, nodes, prepared, opened, notices, start: window.TLIExperience.start,
    context(value) {context = value;}, refuse() {computerResult = buildResult = false;}};
}
for (const kind of ['computer', 'build']) test(`${kind} copies only the unsent text and keeps the original chat draft`, async () => {
  const f = fixture('Help with my task');
  assert.equal(await f.start(kind), true);
  assert.deepEqual(f.prepared, [[kind, 'Help with my task']]);
  assert.equal(f.nodes['chat-input'].value, 'Help with my task');
});
test('home opens configured controls without copying or sending chat text', async () => {
  const f = fixture('Turn on Office Lamp');
  assert.equal(await f.start('home'), true);
  assert.deepEqual(f.opened, ['panel-homeauto']); assert.deepEqual(f.prepared, []);
  assert.equal(f.nodes['chat-input'].value, 'Turn on Office Lamp');
});
test('empty entry opens existing work without creating a draft', async () => {
  const f = fixture(); await f.start('computer'); await f.start('build');
  assert.deepEqual(f.prepared, []);
});
test('selected context or an attached image prevents misleading text-only transfers', async () => {
  for (const attachment of ['context', 'image', 'decoding-image']) {
    const f = fixture('Use this evidence');
    if (attachment === 'context') f.context([{kind: 'report'}]);
    else if (attachment === 'decoding-image') f.window.TLIChatWorkspace = {hasImageDraft: () => true};
    else f.nodes['chat-image-preview'].classList.remove('hidden');
    assert.equal(await f.start('computer'), false); assert.deepEqual(f.opened, []); assert.deepEqual(f.prepared, []);
  }
});
test('an active task refusing a draft is preserved', async () => {
  const f = fixture('New brief'); f.refuse();
  assert.equal(await f.start('build'), false);
  assert.equal(f.nodes['chat-input'].value, 'New brief'); assert.match(f.notices.at(-1), /existing task was kept/);
});
test('running chat and excessive briefs do not navigate', async () => {
  const f = fixture('x'.repeat(4001)); assert.equal(await f.start('build'), false);
  f.nodes['chat-input'].value = 'help'; f.nodes['chat-send-btn'].disabled = true;
  assert.equal(await f.start('computer'), false); assert.deepEqual(f.opened, []);
});
for (const change of ['lock', 'pagehide', 'host', 'draft', 'context', 'navigation']) test(`late handoff is discarded after ${change}`, async () => {
  const f = fixture('Original'); let finish;
  f.window.TLITroubleshooting.open = async () => {f.window.switchPanel('panel-troubleshooting'); await new Promise(resolve => finish = resolve);};
  const pending = f.start('computer');
  assert.equal(await f.start('build'), false, 'duplicate handoff is blocked');
  if (change === 'lock') f.events['tli-session-locked']();
  if (change === 'pagehide') f.events.pagehide();
  if (change === 'host') f.window.TLIHostIdentity.get = () => ({id: 'host-two'});
  if (change === 'draft') f.nodes['chat-input'].value = 'Revised';
  if (change === 'context') f.context([{kind: 'note'}]);
  if (change === 'navigation') f.window.switchPanel('panel-homeauto');
  finish(); assert.equal(await pending, false); assert.deepEqual(f.prepared, []);
});
