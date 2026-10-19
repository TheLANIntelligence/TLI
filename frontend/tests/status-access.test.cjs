const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {create} = require('../js/host-identity.js');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8').replace(/\r\n/g, '\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const reply = (data, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => data});
const statusData = extra => ({model_online:true, node_role:'host', mesh_status:'approved', device_id:'host-a', device_nickname:'Private host', ...extra});
function slice(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
function events(target = {}) {
  const handlers = new Map();
  target.addEventListener = (type, fn) => { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); };
  target.dispatchEvent = event => { for (const fn of handlers.get(event.type) || []) fn(event); };
  target.emit = type => target.dispatchEvent({type});
  return target;
}
function node() {
  const classes = new Set();
  return {textContent:'', title:'', dataset:{}, hidden:false, children:[],
    replaceChildren() { this.textContent = ''; this.children = []; },
    classList:{add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
      contains:x => classes.has(x), toggle(x, enabled) { if (enabled) classes.add(x); else classes.delete(x); }}};
}
function statusFixture() {
  const window = events(), nodes = new Map(), requests = [], followups = [], pills = [], logs = [];
  for (const id of ['mesh-model-pill','visualizer-role-tag','tools-role-tag']) nodes.set(id, node());
  const document = events({hidden:false, getElementById:id => nodes.get(id) || null});
  const identity = create(() => {});
  window.TLIUI = {hostIdentity:identity};
  let respond = async () => reply(statusData()), meshRespond = async () => {};
  window.MeshService = {async fetchNode() { followups.push('mesh'); return meshRespond(); }};
  const ctx = vm.createContext({window, document, AbortSignal, CustomEvent:class {constructor(type) { this.type = type; }},
    $:id => nodes.get(id) || null, currentDeviceId:null, _tliProviderEpoch:0, meshDirectoryCache:null,
    _tliProviderCurrent:epoch => epoch === ctx._tliProviderEpoch && identity.get().status !== 'locked',
    setModelStatus:(...args) => followups.push(['model', ...args]),
    resolveIntelligenceRoute:async () => followups.push('route'), _setPill:(...args) => pills.push(args),
    debugLog:(...args) => logs.push(args), fetch:async (url, options) => { requests.push({url, options}); return respond(url, options); }});
  window.addEventListener('tli-session-locked', () => { ctx._tliProviderEpoch++; identity.setLocked(true); });
  window.addEventListener('tli-session-unlocked', () => { ctx._tliProviderEpoch++; identity.setLocked(false); });
  vm.runInContext(slice('function setMeshModelStatus(', 'function applyTheme('), ctx);
  vm.runInContext(slice('// ---------- status ----------', '// ---------- device rename'), ctx);
  return {ctx, window, document, nodes, requests, followups, pills, logs, identity,
    respond:fn => { respond = fn; }, meshRespond:fn => { meshRespond = fn; },
    refresh:options => ctx.refreshStatus(options), lock:() => window.emit('tli-session-locked'),
    unlock:() => window.emit('tli-session-unlocked'), ready:() => window.emit('tli-private-observation-ready'),
    async recover() { this.unlock(); this.ready(); await tick(); },
    run:code => vm.runInContext(code, ctx)};
}

test('current status preserves host and mesh projection, normal followups, bounded request and no private logging', async () => {
  const f = statusFixture(); await f.refresh();
  assert.equal(f.identity.get().name, 'Private host'); assert.equal(f.ctx.currentDeviceId, 'host-a');
  assert.match(f.nodes.get('mesh-model-pill').textContent, /HOST/);
  assert.deepEqual(f.followups, [['model',true,'Model server: Online'],'mesh','route']);
  assert.equal(f.requests[0].options.cache, 'no-store'); assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.ok(f.requests[0].options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(f.logs), /Private host|host-a|approved/);
});

test('a valid host status without a saved node ID does not retain a previous device target', async () => {
  const f = statusFixture(); await f.refresh();
  f.respond(async () => reply(statusData({device_id:null}))); await f.refresh();
  assert.equal(f.ctx.currentDeviceId, null); assert.equal(f.pills.length, 0);
});

test('overlapping status polls share one request and one set of followups', async () => {
  const f = statusFixture(), pending = deferred(); f.respond(() => pending.promise);
  const first = f.refresh(), second = f.refresh(); assert.equal(f.requests.length, 1);
  pending.resolve(reply(statusData())); await Promise.all([first, second]); assert.equal(f.followups.length, 3);
});

for (const status of [401,403]) test(`status ${status} clears private header state and bare unlock cannot resume or probe`, async () => {
  const f = statusFixture(); await f.refresh(); f.followups.length = 0;
  f.respond(async () => reply({detail:'Private denied body'}, status)); await f.refresh();
  assert.equal(f.ctx.currentDeviceId, null); assert.equal(f.identity.get().status, 'locked');
  assert.equal(f.nodes.get('mesh-model-pill').textContent, 'Mesh: Not confirmed');
  for (const id of ['visualizer-role-tag','tools-role-tag']) assert.equal(f.nodes.get(id).textContent, 'Role: Not confirmed');
  assert.deepEqual(f.followups, []);
  const count = f.requests.length; f.unlock(); await f.refresh(); f.document.emit('visibilitychange'); await tick();
  assert.equal(f.requests.length, count); assert.doesNotMatch(JSON.stringify(f.logs), /Private denied/);
});

test('verified readiness recovers status once without replaying provider or mesh work', async () => {
  const f = statusFixture(); f.lock(); f.unlock(); await f.refresh(); assert.equal(f.requests.length, 0);
  f.ready(); f.ready(); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.identity.get().name, 'Private host'); assert.deepEqual(f.followups, []);
  await f.refresh(); assert.equal(f.followups.length, 3, 'Later ordinary refresh keeps supported followups');
});

test('confirmed recovery while hidden defers the read until visible without optional probes', async () => {
  const f = statusFixture(); f.lock(); f.document.hidden = true; await f.recover(); await f.refresh();
  assert.equal(f.requests.length, 0);
  f.document.hidden = false; f.document.emit('visibilitychange'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.followups, []);
});

for (const code of [200,401,403,503]) test(`old status ${code} cannot repaint or relock a renewed session`, async () => {
  const f = statusFixture(), pending = deferred(); f.respond(() => pending.promise); const old = f.refresh();
  f.lock(); f.respond(async () => reply(statusData({device_nickname:'New host'}))); await f.recover();
  pending.resolve(reply(statusData({device_nickname:'Old private host'}), code)); await old;
  assert.equal(f.identity.get().name, 'New host'); assert.equal(f.identity.get().status, 'known');
  assert.equal(f.requests.length, 2); assert.deepEqual(f.followups, []); assert.equal(f.pills.length, 0);
});

test('an old status completion cannot clear the new pending recovery request', async () => {
  const f = statusFixture(), oldReply = deferred(), newReply = deferred(); f.respond(() => oldReply.promise);
  const old = f.refresh(); f.lock(); f.respond(() => newReply.promise); f.unlock(); f.ready();
  oldReply.resolve(reply(statusData())); await old; const duplicate = f.refresh(); assert.equal(f.requests.length, 2);
  newReply.resolve(reply(statusData())); await duplicate; assert.deepEqual(f.followups, []);
});

test('locking during status JSON parsing prevents projection and all followups', async () => {
  const f = statusFixture(), body = deferred(); f.respond(async () => ({ok:true,status:200,json:() => body.promise}));
  const pending = f.refresh(); await tick(); f.lock(); body.resolve(statusData()); await pending;
  assert.equal(f.ctx.currentDeviceId, null); assert.deepEqual(f.followups, []); assert.equal(f.identity.get().status, 'locked');
});

test('a status body from before unlock cannot replace the confirmed recovery snapshot', async () => {
  const f = statusFixture(), body = deferred(); f.respond(async () => ({ok:true,status:200,json:() => body.promise}));
  const old = f.refresh(); await tick(); f.lock();
  f.respond(async () => reply(statusData({device_nickname:'New host'}))); await f.recover();
  body.resolve(statusData({device_nickname:'Old private host'})); await old;
  assert.equal(f.identity.get().name, 'New host'); assert.equal(f.ctx.currentDeviceId, 'host-a');
  assert.deepEqual(f.followups, []); assert.equal(f.pills.length, 0);
});

for (const kind of ['503','network','null','array','missing-fields','wrong-type']) test(`${kind} status is unavailable, never offline or an automatic followup`, async () => {
  const f = statusFixture(); await f.refresh(); f.followups.length = 0;
  f.respond(async () => {
    if (kind === 'network') throw Error('Private upstream address');
    return reply(kind === 'null' ? null : kind === 'array' ? [] : kind === 'missing-fields' ? {} : statusData({model_online:kind === 'wrong-type' ? 'false' : true}), kind === '503' ? 503 : 200);
  });
  await f.refresh(); assert.equal(f.ctx.currentDeviceId, null); assert.deepEqual(f.followups, []);
  assert.match(f.nodes.get('mesh-model-pill').title, /unavailable/);
  assert.equal(f.pills.at(-1)[2], 'degraded'); assert.match(f.pills.at(-1)[4], /not confirmed/);
  assert.doesNotMatch(JSON.stringify(f.logs), /Private upstream/);
  f.respond(async () => reply(statusData())); await f.refresh(); assert.equal(f.ctx.currentDeviceId, 'host-a');
  assert.equal(f.nodes.get('mesh-model-pill').title, '');
});

test('lock while the normal mesh followup waits suppresses late context and route followups', async () => {
  const f = statusFixture(), pending = deferred(); f.meshRespond(() => pending.promise);
  const refresh = f.refresh(); await tick(); f.lock(); pending.resolve(); await refresh;
  assert.equal(f.ctx.currentDeviceId, null); assert.equal(f.nodes.get('tools-role-tag').textContent, 'Role: Not confirmed');
  assert.equal(f.followups.includes('route'), false);
});

test('pagehide invalidates pending status and clears retained labels without a retry', async () => {
  const f = statusFixture(), pending = deferred(); f.respond(() => pending.promise);
  const refresh = f.refresh(); f.window.emit('pagehide'); pending.resolve(reply(statusData())); await refresh; await f.refresh();
  assert.equal(f.requests.length, 1); assert.equal(f.ctx.currentDeviceId, null); assert.deepEqual(f.followups, []);
});

function dashboardFixture() {
  const window = events(), nodes = new Map(), calls = [], projected = [], effects = [], messages = [], identity = create(() => {});
  for (const id of ['nd-feed','nd-mesh-nodes','nd-statement-text','nd-meta-line','nd-actions','nd-suggestions','nd-quickread']) {
    const el = node(); el.textContent = 'Private retained details'; nodes.set(id, el);
  }
  const document = {getElementById:id => nodes.get(id) || null};
  let respond = async url => reply(url === '/dashboard/command-center' ? null : url === '/status' ? statusData()
    : url === '/api/system/disk' ? {ok:true,system:{pct:25,mount:'C:\\'}} : url === '/homeauto/devices' ? {devices:[]} : url === '/status/alerts' ? {alerts:[]} : {});
  window.TLIUI = {hostIdentity:identity};
  window.TLINarrator = {observeContext:data => projected.push(data), clear(){}, unavailable:() => effects.push('unavailable')};
  window.TLIPresence = {fetchActionCurrent:() => effects.push('action-read')};
  const ctx = vm.createContext({window, document, AbortSignal, Date, CustomEvent:class {constructor(type) {this.type = type;}},
    _viewEpoch:0, _sessionLocked:false, _open:true, _accessBlocked:false, _lastData:{nickname:'Private retained host'}, _lastRefreshFailed:false,
    _serverNarrator:null, _seenFeedIds:new Set(), _el:id => nodes.get(id) || null, _setVital(){},
    _pauseDashboard() { ctx._viewEpoch++; ctx._open = false; }, _showAccessPrompt:() => effects.push('access-prompt'),
    _seedFeed:() => effects.push('feed'), _refreshMeshStrip:() => effects.push('mesh'),
    _renderObservationSummary(){}, _renderActions(){}, _renderQuickRead(){}, _renderSuggestions(){},
    _feedLog:(...args) => messages.push(args), setEventMessage:msg => messages.push(msg),
    fetch:async (url, options) => { calls.push({url,options}); return respond(url, options); }});
  window.addEventListener('tli-session-locked', () => { ctx._sessionLocked = true; ctx._viewEpoch++; identity.setLocked(true); });
  vm.runInContext(slice('  function _clearPrivateDashboard()', '  function _showAccessPrompt()'), ctx);
  vm.runInContext(slice('  async function _refreshOnce()', '  function _renderObservationSummary()'), ctx);
  return {ctx, window, nodes, calls, projected, effects, messages, identity, respond:fn => {respond = fn;}, refresh:() => ctx._refreshOnce(),
    renew() { ctx._viewEpoch++; ctx._sessionLocked = false; ctx._open = true; ctx._accessBlocked = false; identity.setLocked(false); }};
}

for (const code of [401,403]) test(`Dashboard status ${code} clears private fallback and suppresses all dependent requests`, async () => {
  const f = dashboardFixture(); f.respond(async url => reply({detail:'Private denial'}, url === '/status' ? code : 503));
  const tile = node(); tile.dataset.scanPath = 'S:\\Private'; tile.title = 'Review S:\\Private in Free Space'; f.nodes.set('nd-storage-vital-tile', tile);
  await f.refresh(); assert.deepEqual(f.calls.map(x => x.url), ['/dashboard/command-center','/status']);
  assert.equal(f.ctx._lastData, null); assert.equal(f.ctx._accessBlocked, true); assert.equal(f.ctx._open, false);
  for (const el of f.nodes.values()) assert.equal(el.textContent, '');
  assert.equal(tile.dataset.scanPath, ''); assert.equal(tile.title, 'Open Free Space');
  assert.equal(f.projected.length, 0); assert.deepEqual(f.effects, ['access-prompt']); assert.equal(f.identity.get().status, 'locked');
});

for (const kind of ['503','network','malformed']) test(`Dashboard ${kind} status does not create an offline or empty success snapshot`, async () => {
  const f = dashboardFixture(); f.respond(async url => {
    if (url === '/dashboard/command-center') return reply(null,503);
    if (kind === 'network') throw Error('Private upstream');
    return reply(kind === 'malformed' ? {} : statusData(), kind === '503' ? 503 : 200);
  });
  await f.refresh(); assert.deepEqual(f.calls.map(x => x.url), ['/dashboard/command-center','/status']);
  assert.equal(f.projected.length, 0); assert.equal(f.ctx._lastRefreshFailed, true);
  assert.equal(f.ctx._lastData.nickname, 'Private retained host'); assert.deepEqual(f.effects, ['unavailable']);
  assert.doesNotMatch(JSON.stringify(f.messages), /Private upstream/);
});

test('Dashboard healthy fallback retains the existing payload and read-only downstream behavior', async () => {
  const f = dashboardFixture(); await f.refresh();
  assert.equal(f.ctx._lastRefreshFailed, false); assert.equal(f.projected.length, 1);
  assert.equal(f.ctx._lastData.nickname, 'Private host'); assert.equal(f.ctx._lastData.devCount, 0);
  assert.equal(f.ctx._lastData.lmOnline, true); assert.equal(f.ctx._lastData.nodeRole, 'host');
  assert.deepEqual(f.effects, ['action-read','feed','mesh']);
  assert.deepEqual(f.calls.map(x => x.url), ['/dashboard/command-center','/status','/api/system/disk','/homeauto/devices','/api/ai/bundled/status','/status/alerts']);
  assert.ok(f.calls.every(x => !x.options.method || x.options.method === 'GET'));
});

for (const code of [200,401,403]) test(`late Dashboard status ${code} cannot relock or paint after a newer view`, async () => {
  const f = dashboardFixture(), pending = deferred();
  f.respond(async url => url === '/dashboard/command-center' ? reply(null,503) : pending.promise);
  const old = f.refresh(); await tick(); f.renew();
  f.respond(async () => reply({ok:true,nickname:'New host',node:{id:'host-a',name:'New host'},devCount:0,devNames:[],activeAlerts:[]}));
  await f.refresh(); const calls = f.calls.length, effects = f.effects.length;
  pending.resolve(reply(statusData({device_nickname:'Old host'}),code)); await old;
  assert.equal(f.calls.length, calls); assert.equal(f.effects.length, effects); assert.equal(f.ctx._lastData.nickname, 'New host');
  assert.equal(f.ctx._sessionLocked, false); assert.equal(f.ctx._accessBlocked, false);
});

test('a Dashboard status body completing after lock starts no downstream reads', async () => {
  const f = dashboardFixture(), body = deferred();
  f.respond(async url => url === '/dashboard/command-center' ? reply(null,503) : {ok:true,status:200,json:() => body.promise});
  const old = f.refresh(); await tick(); f.window.emit('tli-session-locked'); body.resolve(statusData()); await old;
  assert.deepEqual(f.calls.map(x => x.url), ['/dashboard/command-center','/status']); assert.equal(f.projected.length, 0); assert.equal(f.effects.length, 0);
});

for(const code of [401,403])test(`Dashboard disk ${code} clears private fallback and starts no dependent probes`,async()=>{
  const f=dashboardFixture();f.respond(async url=>url==='/dashboard/command-center'?reply(null,503):url==='/status'?reply(statusData()):reply({detail:'PRIVATE disk'},code));
  await f.refresh();assert.deepEqual(f.calls.map(x=>x.url),['/dashboard/command-center','/status','/api/system/disk']);
  assert.equal(f.ctx._lastData,null);assert.equal(f.ctx._sessionLocked,true);assert.equal(f.ctx._accessBlocked,true);assert.equal(f.projected.length,0);
  assert.deepEqual(f.effects,['access-prompt']);for(const el of f.nodes.values())assert.equal(el.textContent,'');
});

for(const kind of ['503','network','malformed','reported-failure'])test(`Dashboard ${kind} disk observation is unavailable, never successful empty storage`,async()=>{
  const f=dashboardFixture();f.respond(async url=>{
    if(url==='/dashboard/command-center')return reply(null,503);if(url==='/status')return reply(statusData());
    if(kind==='network')throw Error('PRIVATE disk failure');return reply(kind==='malformed'?{}:{ok:kind!=='reported-failure'},kind==='503'?503:200);
  });
  await f.refresh();assert.equal(f.calls.length,3);assert.equal(f.projected.length,0);assert.equal(f.ctx._lastRefreshFailed,true);assert.deepEqual(f.effects,['unavailable']);
});

for(const code of [200,401,403])test(`late Dashboard disk ${code} cannot replace or relock a newer snapshot`,async()=>{
  const f=dashboardFixture(),pending=deferred();f.respond(async url=>url==='/dashboard/command-center'?reply(null,503):url==='/status'?reply(statusData()):pending.promise);
  const old=f.refresh();await tick();f.renew();f.respond(async()=>reply({ok:true,nickname:'New host',node:{id:'host-a',name:'New host'},devCount:0,devNames:[],activeAlerts:[]}));await f.refresh();
  const count=f.calls.length;pending.resolve(reply({ok:true,system:{mount:'S:\\Private',pct:99}},code));await old;
  assert.equal(f.calls.length,count);assert.equal(f.ctx._lastData.nickname,'New host');assert.equal(f.ctx._sessionLocked,false);
});

test('Dashboard disk body resolved after renewed access cannot start dependent reads',async()=>{
  const f=dashboardFixture(),body=deferred();f.respond(async url=>url==='/dashboard/command-center'?reply(null,503):url==='/status'?reply(statusData()):{ok:true,status:200,json:()=>body.promise});
  const old=f.refresh();await tick();f.renew();body.resolve({ok:true,system:{mount:'S:\\Private',pct:99}});await old;
  assert.equal(f.calls.length,3);assert.equal(f.projected.length,0);assert.equal(f.effects.length,0);
});
