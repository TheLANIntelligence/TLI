const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/federation.js'), 'utf8');
const interceptor = fs.readFileSync(path.join(__dirname, '../js/fetch-interceptor.js'), 'utf8');
const reply = (value, status = 200) => ({ok:status >= 200 && status < 300, status, json:async () => value, clone() {return this;}});
const state = running => ({available:false, retired:true, enabled:false, saved_enabled:true, running, port:9000, rooms:0, peers:0, ws_url:null});
const fedState = connected => ({available:false, retired:true, connected, connecting:false, room:'RETAIN', relay_url:'ws://private.invalid:9000'});
const expired = "This TLI session expired or was revoked. Unlock TLI again; if the PIN is off, clear this site's cookies or use a new private window on localhost.";
const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };

function fixture(initial = reply(state(false)), {intercept = false, pinOff = false, fed = reply(fedState(false)), history = reply({messages:[]})} = {}) {
  const nodes = {}, requests = [], toasts = [], intervals = [], listeners = {};
  let statusResult = initial, fedResult = fed, historyResult = history, operation = async () => reply({ok:true});
  class Element {
    constructor() { this.handlers = {}; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.className = ''; this.children = []; }
    set textContent(value) {this._text = value; this.children = [];}
    get textContent() {return this._text;}
    set innerHTML(_) {assert.fail('Untrusted relay content must use textContent');}
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    async emit(name) { for (const fn of this.handlers[name] || []) await fn({}); }
    click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
    appendChild(child) { this.children.push(child); }
  }
  for (const match of source.matchAll(/getElementById\("([^"]+)"\)/g)) nodes[match[1]] = new Element();
  const document = {hidden:false, getElementById:id => nodes[id] || null, createElement:() => new Element()};
  const window = {location:{href:'http://localhost:8000/', origin:'http://localhost:8000'},
    addEventListener:(name, fn) => (listeners[name] ||= []).push(fn),
    dispatchEvent:event => {for (const fn of listeners[event.type] || []) fn(event);}};
  if (pinOff) window.TLIPinLock = {checkAndLock:() => Promise.resolve().then(() => window.dispatchEvent(new CustomEvent('tli-session-unlocked')))};
  async function value(result) {result = typeof result === 'function' ? await result() : result; if (result instanceof Error) throw result; return result;}
  const context = vm.createContext({document, window, URL, Headers, CustomEvent,
    showToast:(...args) => toasts.push(args), setInterval:fn => {intervals.push(fn);}, setTimeout:() => {},
    EventSource:class {constructor() {assert.fail('Retired federation must never subscribe');}},
    WebSocket:class {constructor() {assert.fail('Retired federation must never connect');}},
    fetch:async (url, options = {}) => {
      requests.push({url, ...options});
      if (url === '/relay/status') return value(statusResult);
      if (url === '/federation/status') return value(fedResult);
      if (url === '/federation/messages') return value(historyResult);
      if (url === '/relay/stop' || url === '/federation/pair' && options.method === 'DELETE') return operation(url, options);
      assert.fail('Retired UI attempted unexpected endpoint: ' + url);
    }});
  if (intercept) {window.fetch = context.fetch; vm.runInContext(interceptor, context); context.fetch = (...args) => window.fetch(...args);}
  vm.runInContext(source, context); context.setupFederatedChat();
  return {nodes, requests, toasts, document, ready:flush,
    setStatus(value) {statusResult = value;}, setFed(value) {fedResult = value;}, setHistory(value) {historyResult = value;}, setOperation(fn) {operation = fn;},
    async poll() {for (const fn of intervals) fn(); await flush();},
    async event(name) {for (const fn of listeners[name] || []) fn(); await flush();},
    mutations:() => requests.filter(row => row.method && row.method !== 'GET'),
    toggle:() => nodes['fed-relay-toggle'].click(), refresh:() => nodes['fed-chat-card'].children[0].click(),
    message:() => nodes['fed-relay-sub'].textContent};
}

for (const [name, result, expected] of [
  ['expired session', reply({detail:expired}, 401), /Unlock TLI/],
  ['denied actor', reply({detail:'Relay access denied.'}, 403), /access denied/],
  ['expired session without detail', reply({}, 401), /Unlock TLI/],
  ['denied actor without detail', reply({}, 403), /Access denied/],
  ['unavailable host', reply({detail:'Host is unavailable'}, 503), /Host is unavailable/],
  ['malformed status', reply({detail:'unexpected'}), /could not be confirmed/],
  ['unreadable JSON', {ok:true, status:200, json:async () => {throw Error('bad JSON');}}, /could not be confirmed/],
  ['network failure', new Error('Connection lost'), /Connection lost/],
]) test(`relay status ${name} remains unknown and offers a read-only retry`, async () => {
  const f = fixture(result); await f.ready();
  assert.match(f.message(), expected); assert.doesNotMatch(f.message(), /No listener is running/);
  assert.equal(f.nodes['fed-relay-toggle'].textContent, 'Check status');
  f.setStatus(reply(state(false)));
  if ([401,403].includes(result.status)) await f.event('tli-session-unlocked');
  await f.toggle();
  assert.match(f.message(), /unavailable.*No listener is running/);
  assert.equal(f.nodes['fed-relay-toggle'].textContent, 'Check status');
  assert.equal(f.mutations().length, 0);
});

test('retired UI never offers start, pairing, sending, actionable URLs or stream subscriptions', async () => {
  const f = fixture(reply({...state(false), ws_url:'ws://must-not-share.invalid:9000'})); await f.ready();
  assert.equal(f.nodes['fed-pair-pane'].hidden, true);
  assert.equal(f.nodes['fed-input'].disabled, true); assert.equal(f.nodes['fed-send-btn'].disabled, true);
  assert.equal(f.nodes['fed-relay-copy-url'].hidden, true); assert.equal(f.nodes['fed-relay-url-badge'].textContent, '');
  assert.equal(f.nodes['fed-relay-port-row'].hidden, true);
  await f.toggle(); await f.poll(); await f.event('tli-private-observation-ready');
  assert.deepEqual(f.mutations(), []);
  assert.equal(f.requests.filter(x => x.url === '/federation/status').length, 1, 'Healthy ready event is not another history load');
});

for (const status of [401, 403, 500]) test(`stop rejection ${status} requires status before retry`, async () => {
  const f = fixture(reply(state(true))); await f.ready();
  f.setOperation(async () => reply({detail:'Operation rejected'}, status)); await f.toggle();
  assert.equal(f.mutations().length, 1); assert.equal(f.mutations()[0].url, '/relay/stop');
  assert.match(f.message(), status === 500 ? /could not be confirmed/ : /Operation rejected/);
  assert.ok(f.toasts.every(x=>x[1] !== 'success'));
  assert.equal(f.nodes['fed-relay-toggle'].textContent, 'Check status');
  if (status !== 500) await f.event('tli-session-unlocked');
  await f.toggle(); assert.equal(f.mutations().length, 1);
});

test('successful stop checks actual state; lost response and malformed acknowledgement never claim closure', async () => {
  const f = fixture(reply(state(true))); await f.ready();
  f.setOperation(async () => {f.setStatus(reply(state(false))); return reply({ok:true});}); await f.toggle();
  assert.match(f.message(), /No listener is running/); assert.equal(f.mutations().length, 1);
  assert.equal(f.nodes['fed-relay-toggle'].textContent, 'Check status');
  f.setStatus(reply(state(true))); await f.toggle();
  f.setOperation(async () => {throw Error('Lost response');}); await f.toggle();
  assert.match(f.message(), /could not be confirmed/); await f.poll(); assert.equal(f.mutations().length, 2);
  await f.toggle(); f.setOperation(async () => reply({})); await f.toggle();
  assert.match(f.message(), /could not be confirmed/); assert.equal(f.mutations().length, 3);
});

test('acknowledged stop followed by rejected status remains unknown and cannot auto-repeat', async () => {
  const f = fixture(reply(state(true))); await f.ready();
  f.setOperation(async () => {f.setStatus(reply({detail:expired}, 401)); return reply({ok:true});}); await f.toggle();
  assert.match(f.message(), /Unlock TLI/); assert.equal(f.nodes['fed-relay-toggle'].textContent, 'Check status');
  await f.toggle(); assert.equal(f.mutations().length, 1);
});

test('lock rejects late listener status; bare unlock does not fetch and explicit check releases the request slot', async () => {
  const pending = deferred(), f = fixture(() => pending.promise); await f.ready();
  await f.event('tli-session-locked'); pending.resolve(reply(state(true))); await f.ready();
  assert.match(f.message(), /Unlock TLI/); assert.equal(f.nodes['fed-relay-toggle'].disabled, true);
  f.setStatus(reply(state(false))); await f.event('tli-session-unlocked');
  assert.equal(f.requests.filter(x => x.url === '/relay/status').length, 1);
  await f.toggle(); assert.match(f.message(), /No listener is running/); assert.equal(f.mutations().length, 0);
});

test('old-session 401 cannot replace current listener status through the real interceptor', async () => {
  const pending = deferred(), f = fixture(() => pending.promise, {intercept:true}); await f.ready();
  await f.event('tli-session-locked'); f.setStatus(reply(state(true))); await f.event('tli-session-unlocked'); await f.toggle();
  pending.resolve(reply({detail:expired}, 401)); await f.ready();
  assert.match(f.message(), /cleanup is still needed/); assert.equal(f.nodes['fed-relay-toggle'].textContent, 'Stop');
});

test('duplicate stop clicks and late acknowledgement after lock cannot repeat or repaint', async () => {
  const f = fixture(reply(state(true))); await f.ready(); const pending = deferred();
  f.setOperation(() => pending.promise); const action = f.toggle();
  await f.nodes['fed-relay-toggle'].emit('click'); assert.equal(f.mutations().length, 1);
  await f.event('tli-session-locked'); pending.resolve(reply({ok:true})); await action;
  assert.match(f.message(), /Unlock TLI/); assert.equal(f.nodes['fed-relay-toggle'].disabled, true);
  assert.equal(f.requests.filter(x => x.url === '/relay/status').length, 1);
});

for (const pinOff of [false,true]) test(`real interceptor retains stale-cookie guidance; PIN off=${pinOff}`, async () => {
  const f = fixture(reply({detail:expired}, 401), {intercept:true,pinOff}); await f.ready();
  assert.match(f.message(), /PIN is off, clear this site's cookies/);
  assert.equal(f.mutations().length, 0); await f.poll();
  assert.equal(f.requests.filter(x => x.url === '/relay/status').length, 1);
});

test('history renders untrusted text literally and explicit disconnect preserves the view', async () => {
  const f = fixture(reply(state(false)), {fed:reply(fedState(true)), history:reply({messages:[{from:'<b>peer</b>',text:'<img src=x onerror=bad()> literal'}]})}); await f.ready();
  const text = f.nodes['fed-thread'].children[0].textContent;
  assert.equal(text, '<b>peer</b>: <img src=x onerror=bad()> literal');
  assert.equal(f.nodes['fed-disconnect-btn'].hidden, false);
  await f.nodes['fed-disconnect-btn'].click();
  assert.equal(f.mutations()[0].method, 'DELETE'); assert.equal(f.mutations()[0].url, '/federation/pair');
  assert.equal(f.nodes['fed-thread'].children[0].textContent, text);
  assert.equal(f.nodes['fed-disconnect-btn'].hidden, true);
});

test('failed disconnect shows unknown outcome and only a read can re-enable it', async () => {
  const f = fixture(reply(state(false)), {fed:reply(fedState(true))}); await f.ready();
  f.setOperation(async () => {throw Error('Lost disconnect response');}); await f.nodes['fed-disconnect-btn'].click();
  assert.match(f.nodes['fed-status-label'].textContent, /check status before retrying/);
  assert.equal(f.nodes['fed-disconnect-btn'].hidden, true);
  await f.nodes['fed-disconnect-btn'].emit('click'); assert.equal(f.mutations().length, 1);
  await f.refresh(); assert.equal(f.nodes['fed-disconnect-btn'].hidden, false); assert.equal(f.mutations().length, 1);
});

test('lock clears private history; pending old history cannot repopulate it; guarded-ready restores only a fresh read', async () => {
  const pending = deferred(), f = fixture(reply(state(false)), {history:()=>pending.promise}); await f.ready();
  await f.event('tli-session-locked'); assert.equal(f.nodes['fed-thread'].children.length, 0);
  await f.event('tli-session-unlocked'); assert.equal(f.requests.filter(x=>x.url==='/federation/messages').length, 1);
  f.setHistory(reply({messages:[{from:'Current',text:'Fresh history'}]}));
  await f.event('tli-private-observation-ready'); pending.resolve(reply({messages:[{text:'Old private content'}]})); await f.ready();
  assert.equal(f.nodes['fed-thread'].children[0].textContent, 'Current: Fresh history');
  assert.equal(f.requests.filter(x=>x.url==='/federation/messages').length, 2);
  await f.event('tli-private-observation-ready'); assert.equal(f.requests.filter(x=>x.url==='/federation/messages').length, 2);
});

test('unlock arriving during startup invalidates and releases pending reads before guarded-ready recovery', async () => {
  const pending = deferred(), f = fixture(()=>pending.promise, {fed:()=>pending.promise}); await f.ready();
  await f.event('tli-session-unlocked');
  f.setStatus(reply(state(false))); f.setFed(reply(fedState(false)));
  await f.event('tli-private-observation-ready'); pending.resolve(reply(state(true))); await f.ready();
  assert.match(f.message(), /No listener is running/);
  assert.equal(f.nodes['fed-relay-toggle'].disabled, false);
  await f.refresh(); assert.equal(f.requests.filter(x=>x.url==='/federation/status').length, 3);
});

test('history failure is visible and recovery does not send, reconnect or discard prior history', async () => {
  const f = fixture(reply(state(false)), {history:reply({messages:[{from:'Saved',text:'Keep'}]})}); await f.ready();
  f.setHistory(reply({detail:'History read unavailable'},503)); await f.refresh();
  assert.match(f.nodes['fed-status-label'].textContent, /History read unavailable/);
  assert.equal(f.nodes['fed-thread'].children[0].textContent, 'Saved: Keep');
  assert.deepEqual(f.mutations(), []);
});

for (const endpoint of ['status','history','disconnect','relay']) for (const status of [401,403]) test(`current ${status} during ${endpoint} clears private history and waits for guarded recovery`, async () => {
  const f = fixture(reply(state(true)), {fed:reply(fedState(true)), history:reply({messages:[{from:'Private',text:'Previously visible'}]})}); await f.ready();
  assert.equal(f.nodes['fed-thread'].children.length, 1);
  if (endpoint === 'status') {f.setFed(reply({},status)); await f.refresh();}
  if (endpoint === 'history') {f.setHistory(reply({},status)); await f.refresh();}
  if (endpoint === 'disconnect') {f.setOperation(async()=>reply({},status)); await f.nodes['fed-disconnect-btn'].click();}
  if (endpoint === 'relay') {f.setOperation(async()=>reply({},status)); await f.toggle();}
  assert.equal(f.nodes['fed-thread'].children.length, 0);
  assert.equal(f.nodes['fed-disconnect-btn'].hidden, true);
  const count = f.requests.length; await f.poll(); assert.equal(f.requests.length,count);
  f.setStatus(reply(state(false))); f.setFed(reply(fedState(false))); f.setHistory(reply({messages:[{from:'Fresh',text:'New access'}]}));
  await f.event('tli-session-unlocked'); assert.equal(f.requests.length,count,'Bare unlock does not retry');
  await f.event('tli-private-observation-ready');
  assert.equal(f.nodes['fed-thread'].children[0].textContent,'Fresh: New access');
});

test('stale history403 cannot clear or relock the new-session view', async () => {
  const pending = deferred(), f = fixture(reply(state(false)), {history:()=>pending.promise}); await f.ready();
  await f.event('tli-session-locked'); await f.event('tli-session-unlocked');
  f.setHistory(reply({messages:[{from:'New',text:'Keep visible'}]})); await f.event('tli-private-observation-ready');
  pending.resolve(reply({},403)); await f.ready();
  assert.equal(f.nodes['fed-thread'].children[0].textContent,'New: Keep visible');
  assert.equal(f.nodes['fed-relay-toggle'].disabled,false);
});
