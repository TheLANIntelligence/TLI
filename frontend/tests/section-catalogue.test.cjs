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
  assert.equal(notes.label, 'Saved notes');
  assert.equal(notes.kind, 'shortcut');
  for (const alias of ['notebook','saved notes','memory']) assert.ok(notes.aliases.includes(alias));
  const companion = navigation.find(n => n.id === 'panel-companion');
  assert.equal(companion.group, 'Devices');
  assert.match(companion.prerequisites, /computer awake.*same home network/);
  assert.match(companion.result, /prepare this computer.*install the app.*private pairing code/);
  assert.match(navigation.find(n => n.id === 'panel-mesh').result, /Browser satellite/);
});

test('storage and device workspaces open directly from primary navigation and retain specialist parents', () => {
  const api = catalogue();
  assert.deepEqual(Array.from(api.navigation.filter(n => n.primary), n => n.label), ['Dashboard','Ask TLI','Files','Free Space','Game Optimizer','Vault','Computers','Smart home','Routines','Connect phone','Printers & scanners','USB drives']);
  for (const item of api.navigation) {
    assert.ok(api.navigation.some(n => n.id === item.parent));
    assert.equal(api.rootFor(item.id), item.parent);
    assert.equal(api.isActive(item.parent, item.id), true);
    if (item.parent !== item.id) assert.equal(item.pinnable, true);
  }
  assert.equal(api.rootFor('panel-app-local-notebook'), 'panel-more');
  assert.equal(api.isActive('panel-games', 'panel-performance'), false);
  assert.equal(api.isActive('panel-help', 'panel-performance'), true);
  assert.equal(api.isActive('panel-files', 'panel-visualizer'), false);
  assert.equal(api.isActive('panel-printshop', 'panel-devices'), true);
  assert.equal(api.isActive('panel-mesh', 'panel-tli-chat'), true);
  assert.equal(api.rootFor('panel-devices-home'), 'panel-more');
});

test('legacy destinations stay searchable without reintroducing primary navigation clutter', () => {
  const {navigation} = catalogue();
  for (const [id, alias] of [['panel-main','AI Chat'],['panel-files','file organizer'],['panel-automations','Automations'],['panel-hub','TLI Hub'],['panel-printshop','Print & Scan'],['panel-performance','Performance & apps'],['saved-notes','Notes & fixes']]) {
    assert.ok(navigation.find(n => n.id === id).aliases.includes(alias), alias);
  }
  for (const id of ['panel-tools','panel-builder','panel-scripts','panel-hub']) assert.equal(navigation.find(n => n.id === id).parent,'panel-more');
  assert.equal(navigation.find(n => n.id === 'panel-reports').parent,'panel-help');
});

test('corrupt and stale browser pins cannot inject new destinations into the catalogue', () => {
  const context = vm.createContext({window:{addEventListener(){}}, document:{readyState:'loading',addEventListener(){}}, localStorage:{getItem(){return JSON.stringify(['panel-builder','panel-builder','panel-does-not-exist','panel-app-injected','panel-dashboard2','panel-visualizer','panel-automations','panel-mesh']);}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/ui-foundation.js'),'utf8'),context);
  assert.deepEqual(Array.from(context.window.TLIUI.getPins()),['panel-builder']);
  assert.equal(context.window.TLIUI.setPinned('panel-does-not-exist',true),false);
});

test('HomeLab is hidden from the shared catalogue and old pins without rewriting stored preferences', () => {
  let stored = JSON.stringify(['panel-homelab','panel-builder']), writes = 0;
  const original = stored;
  const context = vm.createContext({CustomEvent: class {constructor(type) {this.type = type;}},
    window:{addEventListener(){},dispatchEvent(){}},
    document:{readyState:'loading',addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];},getElementById(){return null;}},
    localStorage:{getItem(){return stored;},setItem(key,value){assert.equal(key,'tli_navigation_pins_v1');stored=value;writes++;}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/ui-foundation.js'),'utf8'),context);
  const api = context.window.TLIUI;
  assert.equal(api.isPanelHidden('panel-homelab'),true);
  assert.equal(api.isPanelHidden('panel-homeauto'),false);
  assert.equal(api.navigation.some(n=>n.id==='panel-homelab'),false);
  assert.deepEqual(Array.from(api.getPins()),['panel-builder']);
  assert.equal(api.setPinned('panel-homelab',true),false);
  assert.equal(stored,original);assert.equal(writes,0);
  assert.equal(api.setPinned('panel-tools',true),true);
  assert.deepEqual(JSON.parse(stored),['panel-builder','panel-tools','panel-homelab']);
  assert.deepEqual(Array.from(api.getPins()),['panel-builder','panel-tools']);
});
