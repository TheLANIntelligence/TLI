// Dependency-free component regressions: node --test frontend/tests/anniversary.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(frontend, 'js/action-engine.js'), 'utf8');

test('standalone join status is quiet while unexpected failures remain visible', async () => {
  const mesh = fs.readFileSync(path.join(frontend, 'js/mesh.js'), 'utf8');
  const start = mesh.indexOf('async function pollMeshJoinStatus()');
  const end = mesh.indexOf('async function requestMeshJoin(', start);
  for (const [status, detail, quiet] of [[400, 'This node is not joined to any host.', true],
    [400, 'Unexpected request error', false], [401, 'Unlock required', true], [503, 'Host unavailable', false]]) {
    const toasts = [], updates = [];
    const context = vm.createContext({ meshUiLocked:false, meshUiEpoch:0, meshUiCurrent:()=>true, document:{hidden:false}, meshJoinPollTimer: null, console: { error() {} },
      showToast: msg => toasts.push(msg), updateMeshJoinStatus: msg => updates.push(msg),
      fetch: async () => ({ ok: false, status, text: async () => JSON.stringify({ detail }) }) });
    vm.runInContext(mesh.slice(start, end), context);
    await context.pollMeshJoinStatus();
    assert.equal(toasts.length, quiet ? 0 : 1);
    if(status===401)assert.equal(updates.length,0);
    else assert.match(updates[0], quiet ? /Standalone/ : /Join status error/);
  }
});

// Execution outcomes are exercised against the actual reviewed-routine controller in
// routine-workspace.test.cjs. This legacy entry point now only installs navigation.
test('Smart devices installs one manual-routine link and never executes on open or refresh', () => {
  const children = [], panels = []; let refreshes = 0, fallbackOpens = 0, requests = 0;
  const window = { switchPanel: panel => panels.push(panel),
    TLIManualRoutines: { refresh: () => refreshes++, onOpen: () => fallbackOpens++ } };
  const context = vm.createContext({ window, fetch: () => { requests++; throw Error('Unexpected request'); },
    document: {
      querySelector: selector => selector === '#panel-homeauto .page-header' ? { append: child => children.push(child) } : null,
      getElementById: id => children.find(child => child.id === id) || null,
      createElement: () => ({ addEventListener(event, fn) { assert.equal(event, 'click'); this.click = fn; } }),
    } });
  vm.runInContext(source, context);
  window.TLIHomeAutoActions.onOpen(); window.TLIHomeAutoActions.setup();
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, 'Manual routines');
  assert.deepEqual(panels, []);
  children[0].click(); assert.deepEqual(panels, ['panel-automations']);
  window.TLIHomeAutoActions.refreshActions(); window.TLIHomeAutoActions.refreshReceipts();
  assert.equal(refreshes, 2);
  delete window.switchPanel; window.TLIHomeAutoActions.loadDevices();
  assert.equal(fallbackOpens, 1);
  assert.equal(requests, 0);
});

test('dashboard activity marks failed receipts as errors, including legacy step failures', async () => {
  const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
  // Execute the actual feed seeding function with its I/O boundaries stubbed.
  const start = app.indexOf('  async function _seedFeed()');
  const end = app.indexOf('\n  function ', start + 1);
  const feed = [];
  const context = vm.createContext({
    _viewEpoch:0, _sessionLocked:false,
    _lastData: { recent_receipts: [
      { ts: '1', kind: 'action_run', ok: false, summary: 'Partial action' },
      { ts: '2', kind: 'action_run', results: [{ ok: false }], summary: 'Legacy failure' },
      { ts: '3', kind: 'action_run', ok: true, summary: 'Completed action' },
    ], activeAlerts: [] },
    _seenFeedIds: new Set(), _feedLog: (...args) => feed.push(args),
  });
  vm.runInContext(app.slice(start, end) + '\nthis.seed = _seedFeed;', context);
  await context.seed();
  assert.equal(feed.find(row => row[0].includes('Partial'))[1], 'error');
  assert.equal(feed.find(row => row[0].includes('Legacy'))[1], 'error');
  assert.equal(feed.find(row => row[0].includes('Completed'))[1], 'good');
});

test('Narrator rejects stale messages and cancels a superseded transition', () => {
  const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
  const start = app.indexOf('  let _serverNarrator = null;');
  const end = app.indexOf("  window.addEventListener('tli-system-observation'", start);
  const timers = new Map();
  const displayed = [];
  let timerId = 0;
  const context = vm.createContext({
    _open: true, _sessionLocked:false, _el: () => null, _typeText: text => displayed.push(text), _setNarratorCard() {},
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(app.slice(start, end) + '\nthis.show = setEventMessage;', context);
  context.show({ type: 'confirmation', text: 'Opened Devices.', timestamp: 5 });
  context.show({ type: 'status', text: 'Stale response', timestamp: 4 });
  for (const fn of timers.values()) fn();
  timers.clear();
  context.show({ type: 'status', text: 'Pending status', timestamp: 6 });
  context.show({ type: 'alert', text: 'Action failed', timestamp: 7 });
  for (const fn of timers.values()) fn();
  assert.deepEqual(displayed, ['Opened Devices.', 'Action failed']);
});

test('dashboard connection failure replaces a stale healthy Narrator', async () => {
  const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
  const start = app.indexOf('  async function _refresh()');
  const end = app.indexOf('\n  function _renderMeshStrip', start);
  const messages = [];
  const metadata = [];
  const context = vm.createContext({
    _open: true, _sessionLocked:false, _refreshPending:null, _viewEpoch:0, AbortSignal, fetch: async () => { throw new Error('offline'); },
    window: { TLIUIHealth: require('../js/ui-health.js') }, _lastData: null,
    _lastRefreshFailed: false, _el: () => null,
    _setOrb() {}, _setMeta: text => metadata.push(text), _feedLog() {}, setEventMessage: msg => messages.push(msg),
  });
  vm.runInContext(app.slice(start, end) + '\nthis.refresh = _refresh;', context);
  await context.refresh();
  assert.equal(messages[0].type, 'alert');
  assert.match(messages[0].text, /monitoring is unavailable/);
  assert.match(metadata[0], /Monitoring unavailable; no successful readings yet.*No successful system probe/);
});

test('Dashboard access rejection does not probe legacy private endpoints', async () => {
  const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
  const start = app.indexOf('  async function _refresh()');
  const end = app.indexOf('\n  function _renderMeshStrip', start);
  const calls=[];
  const context=vm.createContext({_open:true,_sessionLocked:false,_refreshPending:null,_viewEpoch:0,AbortSignal,
    fetch:async url=>{calls.push(url);return {ok:false,status:401};},window:{TLIUIHealth:require('../js/ui-health.js')},
    _lastData:null,_lastRefreshFailed:false,_el:()=>null,_setOrb(){},_setMeta(){},_feedLog(){},setEventMessage(){}});
  vm.runInContext(app.slice(start,end)+'\nthis.refresh=_refresh;',context);
  await context.refresh();
  assert.deepEqual(calls,['/dashboard/command-center']);
});
