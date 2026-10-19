const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../tli-bridge.js'), 'utf8');

function fixture(readyState = 'loading') {
  const calls = [], listeners = new Map();
  const document = {
    readyState,
    addEventListener(type, fn, options) {
      const entries = listeners.get(type) || []; entries.push({fn, options}); listeners.set(type, entries);
    },
  };
  const forbidden = method => (...args) => { calls.push({method, args}); throw new Error('Unexpected host access: ' + method); };
  const window = {
    parent: {postMessage: forbidden('postMessage')},
    addEventListener: forbidden('window.addEventListener'),
    localStorage: {getItem: forbidden('storage.get'), setItem: forbidden('storage.set'), removeItem: forbidden('storage.remove')},
  };
  vm.runInNewContext(source, {
    window, document, fetch: forbidden('fetch'), localStorage: window.localStorage,
    setTimeout: forbidden('setTimeout'), showToast: forbidden('showToast'),
  });
  return {
    bridge: window.TLIBridge, calls,
    loaded() {
      document.readyState = 'complete';
      for (const entry of listeners.get('DOMContentLoaded') || []) entry.fn();
      listeners.set('DOMContentLoaded', (listeners.get('DOMContentLoaded') || []).filter(entry => !entry.options?.once));
    },
  };
}

test('ready initializes a local shell only after its DOM is ready and grants no permissions', () => {
  const f = fixture(); let initializations = 0, permissions;
  f.bridge.ready(grants => { initializations++; permissions = grants; });
  assert.equal(initializations, 0); assert.equal(f.bridge.available, false);
  f.loaded(); f.loaded();
  assert.equal(initializations, 1); assert.deepEqual(Array.from(permissions), []); assert.equal(Object.isFrozen(permissions), true);
  assert.deepEqual(f.calls, []);
});

test('late ready callbacks run without a parent handshake and cannot grant each other permissions', async () => {
  const f = fixture('complete'), results = [];
  f.bridge.ready(grants => { assert.throws(() => grants.push('settings.read')); results.push(Array.from(grants)); });
  f.bridge.ready(grants => results.push(Array.from(grants)));
  f.bridge.ready(null);
  assert.deepEqual(results, []); await Promise.resolve();
  assert.deepEqual(results, [[], []]); assert.deepEqual(f.calls, []);
});

for (const [name, args] of [
  ['call', ['settings.read', {}]], ['notify', ['Untrusted toast', 'error']], ['getMeshDevices', []],
  ['getSettings', []], ['setBadge', [3]], ['storage', ['get', 'secret']], ['storage', ['set', 'secret', 'replacement']],
  ['storage', ['remove', 'secret']], ['storage', ['clear']],
]) test(name + '(' + (args[0] || '') + ') explicitly rejects without messaging, storage, network or timers', async () => {
  const f = fixture('complete');
  await assert.rejects(f.bridge[name](...args), /Host-connected app features are unavailable/);
  assert.deepEqual(f.calls, []);
});

test('the inert SDK API cannot be changed into grants by mutating exposed methods', async () => {
  const f = fixture('complete'); assert.equal(Object.isFrozen(f.bridge), true);
  f.bridge.getSettings = () => 'unexpected';
  await assert.rejects(f.bridge.getSettings(), /Package permissions are requests, not user grants/);
  assert.deepEqual(f.calls, []);
});
