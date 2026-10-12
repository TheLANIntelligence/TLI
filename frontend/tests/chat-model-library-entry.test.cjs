const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = app.indexOf('// Wire no-AI banner action button');
const end = app.indexOf('// Initial check + re-check', start);
assert.ok(start >= 0 && end > start, 'Exercise the production chat banner event binding');
const binding = app.slice(start, end);

function setup({ mesh = false, available = true } = {}) {
  const calls = [], listeners = {};
  const button = { dataset: mesh ? { tliMeshMode: '1' } : {}, addEventListener(type, callback) { listeners[type] = callback; } };
  const window = available ? { tliOpenModelManagerModal() { calls.push('model-controller'); } } : {};
  const context = vm.createContext({ window,
    $(id) { assert.equal(id, 'tli-no-ai-download-btn', 'Only the model controller may change its overlay'); return button; },
    switchPanel(panel) { calls.push(['panel', panel]); },
    showToast(message, level) { calls.push(['notice', message, level]); },
    fetch() { assert.fail('Opening the library must not directly download or activate a model'); },
  });
  vm.runInContext(binding, context);
  return { calls, click: () => listeners.click() };
}

test('chat model-library action delegates each open to the controller that loads models and owns focus/close', () => {
  const fixture = setup();
  assert.deepEqual(fixture.calls, []);
  fixture.click(); fixture.click();
  assert.deepEqual(fixture.calls, ['model-controller', 'model-controller']);
});

test('the LAN availability action keeps its Settings navigation instead of opening a local download', () => {
  const fixture = setup({ mesh: true }); fixture.click();
  assert.deepEqual(fixture.calls, [['panel', 'panel-settings']]);
});

test('a missing model controller gives recovery guidance without exposing an uninitialized dialog', () => {
  const fixture = setup({ available: false }); fixture.click();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][0], 'notice');
  assert.match(fixture.calls[0][1], /model library.*unavailable.*Reload TLI/i);
  assert.equal(fixture.calls[0][2], 'error');
});
