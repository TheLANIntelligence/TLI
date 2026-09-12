const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function catalogue() {
  const callbacks = [];
  const context = vm.createContext({window: {addEventListener: (...args) => callbacks.push(args)}, document: {readyState:'loading', addEventListener: (...args) => callbacks.push(args)}, fetch() { assert.fail('Loading navigation must not request data'); }, localStorage: {setItem() {assert.fail('Navigation must not change saved settings');}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/ui-foundation.js'), 'utf8'), context);
  return context.window.TLIUI;
}

test('every section has distinct navigation and bounded purpose, target, prerequisite and result guidance without probes', () => {
  const {navigation} = catalogue();
  assert.equal(new Set(navigation.map(n => n.id)).size, navigation.length);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const item of navigation) {
    for (const key of ['purpose','target','prerequisites','result']) {
      assert.equal(typeof item[key], 'string');
      assert.ok(item[key].length > 20 && item[key].length < 320, item.id + ':' + key);
    }
    if (item.kind === 'panel') assert.ok(html.includes('id="' + item.id + '"'), item.id + ' has a real destination');
  }
});

test('old note names resolve to the existing notebook shortcut; native pairing has its own panel', () => {
  const {navigation} = catalogue();
  const notes = navigation.find(n => n.id === 'saved-notes');
  assert.equal(notes.label, 'Notes & fixes');
  assert.equal(notes.kind, 'shortcut');
  for (const alias of ['notebook','saved notes','memory']) assert.ok(notes.aliases.includes(alias));
  const companion = navigation.find(n => n.id === 'panel-companion');
  assert.equal(companion.group, 'Home & network');
  assert.match(companion.prerequisites, /PIN.*HTTPS.*LAN.*certificate/);
  assert.match(companion.result, /creates no invitation/);
  assert.match(navigation.find(n => n.id === 'panel-mesh').result, /Browser satellite/);
});
