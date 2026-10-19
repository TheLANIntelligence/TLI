const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const lanSource = fs.readFileSync(path.join(__dirname, '../js/tli-chat.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const dashStart = app.indexOf('window.TLIDash2 = (function () {');
const dashEnd = app.indexOf('\n})();', dashStart) + '\n})();'.length;
assert.ok(dashStart >= 0 && dashEnd > dashStart);
const dashSource = app.slice(dashStart, dashEnd);
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = data => ({ok:true, status:200, json:async () => data});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };

function fixture(source = lanSource) {
  const streams = [], intervals = new Map(), timers = new Map(), calls = [], nodes = new Map(), toasts = [];
  const events = target => {
    const handlers = new Map();
    target.addEventListener = (type, fn) => {if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn);};
    target.emit = type => {for (const fn of handlers.get(type) || []) fn();};
    return target;
  };
  let nextTimer = 0;
  let respond = async url => {
    if (url === '/mesh/node') return reply({node_id:'host', display_name:'Host'});
    if (url === '/api/lan/peers') return reply({peers:[{id:'peer', name:'Peer', online:true}]});
    if (url.startsWith('/mesh/chat/messages')) return reply({messages:[]});
    if (url === '/api/mesh/health') return reply({nodes:[]});
    return reply({ok:true, aiOk:true, devNames:[], devCount:0, activeAlerts:[], diskData:{}, events:[]});
  };
  class EventSource {
    constructor(url) {this.url = url; this.closed = false; streams.push(this);}
    close() {this.closed = true;}
  }
  const window = events({innerWidth:1200, innerHeight:800});
  const document = events({hidden:false, getElementById:id => nodes.get(id) || null, querySelector:() => null,
    createElement:() => ({style:{}, addEventListener() {}, remove() {}}),
    body:{appendChild:el => toasts.push(el)},
  });
  const context = vm.createContext({window, document, EventSource, console, AbortSignal,
    setInterval(fn, ms) {const id = ++nextTimer; intervals.set(id, {fn, ms}); return id;},
    clearInterval(id) {intervals.delete(id);},
    setTimeout(fn, ms) {const id = ++nextTimer; timers.set(id, {fn, ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    fetch:async url => {calls.push(url); return respond(url);},
  });
  vm.runInContext(source, context);
  const api = window.TLIChat || window.TLIDash2;
  return {window, document, streams, intervals, calls, nodes, toasts, api,
    active:() => streams.filter(stream => !stream.closed),
    respond(fn) {respond = fn;},
    async hide(hidden) {document.hidden = hidden; document.emit('visibilitychange'); await tick();},
    async timer(ms) {for (const timer of [...intervals.values()]) if (timer.ms === ms) await timer.fn(); await tick();},
  };
}

test('LAN presence closes on navigation; repeated visits retain only one stream and unread timer', async () => {
  const f = fixture();
  for (let visit = 0; visit < 4; visit++) {
    await f.api.onOpen();
    assert.equal(f.active().length, 1);
    await f.api.onOpen();
    assert.equal(f.active().length, 1, 'reopening the same panel does not duplicate SSE');
    f.api.onClose();
    assert.equal(f.active().length, 0);
    assert.deepEqual([...f.intervals.values()].map(t => t.ms), [10000]);
  }
});

test('a late LAN snapshot cannot reopen presence after navigation away', async () => {
  const f = fixture(), pending = deferred();
  f.respond(() => pending.promise);
  const opening = f.api.onOpen();
  f.api.onClose();
  pending.resolve(reply({node_id:'host'}));
  await opening;
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.calls, ['/mesh/node']);
});

test('hidden LAN tabs stop all periodic work and recheck before reconnecting', async () => {
  const f = fixture();
  await f.api.onOpen();
  const old = f.active()[0];
  await f.hide(true);
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
  const before = f.calls.length;
  old.onerror();
  old.onmessage({data:JSON.stringify({type:'directory_changed'})});
  assert.equal(f.calls.length, before);
  await f.hide(false);
  assert.equal(f.active().length, 1);
  assert.ok(f.calls.slice(before).includes('/api/lan/peers'));
  f.api.onClose();
  await f.hide(true);
  await f.hide(false);
  assert.equal(f.active().length, 0, 'returning to another panel does not reopen LAN presence');
  assert.deepEqual([...f.intervals.values()].map(t => t.ms), [10000]);
});

test('the selected peer still produces notifications when another TLI panel is open', async () => {
  const f = fixture();
  f.window.switchPanel = () => f.api.onOpen();
  await f.api.onOpen();
  assert.equal(await f.api.openPeer('peer'), true);
  await tick();
  f.api.onClose();
  f.respond(async () => reply({messages:[{ts:Date.now(), from_id:'peer', from_name:'Peer', body:'A new message'}]}));
  await f.timer(10000);
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0].innerHTML, /A new message/);
  assert.equal(f.active().length, 0);
});

test('locking LAN invalidates pending opens and visibility cannot reconnect an old session', async () => {
  const f = fixture(), pending = deferred();
  f.respond(() => pending.promise);
  const opening = f.api.onOpen();
  f.window.emit('tli-session-locked');
  pending.resolve(reply({node_id:'host'}));
  await opening;
  await f.hide(true);
  await f.hide(false);
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.calls, ['/mesh/node']);
});

test('LAN first opened in a hidden tab initializes when the tab becomes visible', async () => {
  const f = fixture();
  await f.hide(true);
  await f.api.onOpen();
  assert.equal(f.calls.length, 0);
  assert.equal(f.active().length, 0);
  await f.hide(false);
  assert.equal(f.active().length, 1);
  assert.ok(f.calls.includes('/api/lan/peers'));
});

test('dashboard pauses its stream and timers in a hidden browser tab, then refreshes on return', async () => {
  const f = fixture(dashSource);
  f.api.onOpen(); await tick();
  const old = f.active()[0];
  assert.equal(f.active().length, 1);
  await f.hide(true);
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
  const before = f.calls.length;
  await f.hide(false);
  assert.equal(f.active().length, 1);
  assert.ok(f.calls.slice(before).includes('/dashboard/command-center'));
  old.onerror();
  assert.equal(f.active().length, 1, 'a stale stream error cannot close the replacement');
  f.api.onClose();
  await f.hide(true);
  await f.hide(false);
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
});

test('dashboard opened while hidden waits for visibility and lock prevents reconnection', async () => {
  const f = fixture(dashSource);
  await f.hide(true);
  f.api.onOpen(); await tick();
  assert.equal(f.streams.length, 0);
  assert.equal(f.calls.length, 0);
  await f.hide(false);
  assert.equal(f.active().length, 1);
  f.window.emit('tli-session-locked');
  await f.hide(true);
  await f.hide(false);
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
});

test('unlocking during a pending dashboard refresh cannot reopen a panel the user leaves', async () => {
  const f = fixture(dashSource), pending = deferred();
  f.nodes.set('panel-dashboard2', {hidden:false, classList:{contains:() => false}});
  f.respond(() => pending.promise);
  f.api.onOpen(); await tick();
  f.window.emit('tli-session-locked');
  f.window.emit('tli-session-unlocked');
  f.api.onClose();
  f.nodes.get('panel-dashboard2').hidden = true;
  pending.resolve(reply({ok:true, aiOk:true, devNames:[], devCount:0, activeAlerts:[]}));
  await tick();
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
});

test('dashboard PIN-off unlock after an access failure cannot retry automatically or use legacy fallback', async () => {
  const f = fixture(dashSource);
  f.nodes.set('panel-dashboard2', {hidden:false, classList:{contains:() => false}});
  f.respond(async () => {
    f.window.emit('tli-session-locked');
    f.window.emit('tli-session-unlocked');
    return {ok:false, status:401, json:async () => ({detail:'Expired cookie'})};
  });
  f.api.onOpen(); await tick(); await tick();
  assert.deepEqual(f.calls, ['/dashboard/command-center']);
  assert.equal(f.active().length, 0);
  assert.equal(f.intervals.size, 0);
  f.window.emit('tli-session-unlocked');
  await f.hide(true); await f.hide(false);
  assert.deepEqual(f.calls, ['/dashboard/command-center']);
});

test('dashboard denied access clears polling and waits for a confirmed access event', async () => {
  const f = fixture(dashSource);
  f.nodes.set('panel-dashboard2', {hidden:false, classList:{contains:() => false}});
  f.respond(async () => ({ok:false, status:403, json:async () => ({detail:'Use HTTPS'})}));
  f.api.onOpen(); await tick();
  assert.deepEqual(f.calls, ['/dashboard/command-center']);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.active().length, 0);
  let checks = 0;
  f.window.EventInterpreter = {retry:() => { checks++; }};
  f.api.refresh();
  assert.equal(checks, 1);
  assert.equal(f.calls.length, 1);
  f.respond(async url => reply(url === '/api/mesh/health' ? {nodes:[]} : {ok:true, devNames:[], devCount:0, activeAlerts:[], recent_receipts:[]}));
  f.window.emit('tli-private-observation-ready'); await tick();
  assert.equal(f.calls.filter(url => url === '/dashboard/command-center').length, 2);
  assert.equal(f.active().length, 1);
});

test('dashboard ignores a late unauthorized result after a new session check', async () => {
  const f = fixture(dashSource), pending = deferred();
  f.nodes.set('panel-dashboard2', {hidden:false, classList:{contains:() => false}});
  f.respond(() => pending.promise);
  f.api.onOpen(); await tick();
  f.window.emit('tli-session-locked');
  f.window.emit('tli-session-unlocked');
  f.respond(async url => reply(url === '/api/mesh/health' ? {nodes:[]} : {ok:true, devNames:[], devCount:0, activeAlerts:[], recent_receipts:[]}));
  f.window.emit('tli-private-observation-ready');
  pending.resolve({ok:false, status:401, json:async () => ({detail:'Old session'})});
  await tick(); await tick();
  assert.equal(f.calls.filter(url => url === '/dashboard/command-center').length, 2);
  assert.equal(f.active().length, 1);
});
