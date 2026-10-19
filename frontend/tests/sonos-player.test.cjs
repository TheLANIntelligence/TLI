const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/sonos-player.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const response = (value, status = 200) => ({ok: status >= 200 && status < 300, status, headers: new Headers(),
  json: async () => JSON.parse(JSON.stringify(value)), clone() { return this; }});

function fixture({hidden = false, handler = () => undefined} = {}) {
  const events = {}, calls = [], timers = new Map(), navigations = [], opened = []; let serial = 0;
  const on = (scope, name, fn) => (events[scope + ':' + name] ||= []).push(fn);
  function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
  function simple(node, selector) {
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return (node.className || '').split(/\s+/).includes(selector.slice(1));
    const attr = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
    if (attr) return attr[2] == null ? node.getAttribute(attr[1]) != null : node.getAttribute(attr[1]) === attr[2];
    return node.tag === selector.toLowerCase();
  }
  function matches(node, selector) {
    return selector.split(',').some(part => {
      const steps = part.trim().split(/\s+/); let current = node;
      if (!simple(current, steps.pop())) return false;
      while (steps.length) {
        const next = steps.pop(); current = current.parentNode;
        if (next === '>') { if (!current || !simple(current, steps.pop())) return false; }
        else { while (current && !simple(current, next)) current = current.parentNode; if (!current) return false; }
      }
      return true;
    });
  }
  function element(tag = 'div') {
    let content = '';
    const node = {tag, tagName: tag.toUpperCase(), parentNode: null, children: [], handlers: {}, attributes: {}, dataset: {}, style: {},
      value: '', disabled: false, hidden: false, className: '',
      append(...nodes) { for (const child of nodes) { child.remove(); child.parentNode = this; this.children.push(child); } },
      appendChild(child) { this.append(child); return child; },
      prepend(...nodes) { for (const child of [...nodes].reverse()) this.insertBefore(child, this.firstChild); },
      insertBefore(child, before) { if (!before) return this.appendChild(child); child.remove(); const index = this.children.indexOf(before);
        assert(index >= 0); child.parentNode = this; this.children.splice(index, 0, child); return child; },
      after(child) { if (this.parentNode) { const siblings = this.parentNode.children; this.parentNode.insertBefore(child, siblings[siblings.indexOf(this) + 1]); } },
      before(child) { this.parentNode?.insertBefore(child, this); },
      remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } },
      replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; content = ''; this.append(...nodes); },
      setAttribute(key, value) { this.attributes[key] = String(value);
        if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); },
      getAttribute(key) { if (key.startsWith('data-')) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
        return this.attributes[key] ?? null; },
      removeAttribute(key) { delete this.attributes[key]; },
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      fire(name, extra = {}) { for (const fn of this.handlers[name] || []) fn({target: this, currentTarget: this, preventDefault() {}, ...extra}); },
      click() { if (!this.disabled) this.fire('click'); },
      focus() { document.activeElement = this; }, scrollIntoView() {},
      querySelectorAll(selector) { return descendants(this).filter(child => matches(child, selector)); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      closest(selector) { for (let current = this; current; current = current.parentNode) if (matches(current, selector)) return current; return null; },
      contains(other) { return other === this || descendants(this).includes(other); },
    };
    Object.defineProperty(node, 'firstChild', {get: () => node.children[0] || null});
    Object.defineProperty(node, 'textContent', {get: () => content + node.children.map(child => child.textContent).join(''),
      set(value) { node.replaceChildren(); content = String(value); }});
    node.classList = {
      contains(name) { return node.className.split(/\s+/).includes(name); },
      add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle(name, force) { const enabled = force ?? !this.contains(name); this[enabled ? 'add' : 'remove'](name); return enabled; },
    };
    return node;
  }
  const document = {readyState: 'complete', hidden, body: element('body'), createElement: element,
    createElementNS: (_, tag) => element(tag),
    getElementById: id => descendants(document.body).find(node => node.id === id) || null,
    querySelectorAll: selector => document.body.querySelectorAll(selector), querySelector: selector => document.body.querySelector(selector),
    addEventListener: (name, fn) => on('document', name, fn), dispatchEvent: event => emit('document', event.type, event.detail)};
  document.activeElement = document.body;
  const main = element(); main.className = 'main-region'; document.body.append(main);
  const header = element('header'), headerRight = element(); headerRight.className = 'header-right'; header.append(headerRight); main.append(header);
  const quick = element('section'); quick.id = 'sonos-quick-player'; quick.hidden = true; main.append(quick);
  const scroll = element('main'); scroll.id = 'main-scroll'; scroll.className = 'main-scroll'; main.append(scroll);
  const dashboard = element('section'); dashboard.id = 'panel-dashboard2'; scroll.append(dashboard);
  const dashboardHeading = element(); dashboardHeading.className = 'dashboard-page-header'; dashboard.append(dashboardHeading);
  const wrap = element(); wrap.className = 'nd-wrap'; dashboard.append(wrap);
  const dashboardPlayer = element('section'); dashboardPlayer.id = 'dashboard-sonos'; dashboardPlayer.hidden = true; wrap.append(dashboardPlayer);
  const dashboardGrid = element(); dashboardGrid.className = 'dashboard-workspace-grid'; wrap.append(dashboardGrid);
  const primary = element(); primary.className = 'dashboard-primary-column'; dashboardGrid.append(primary);
  const home = element('section'); home.id = 'panel-homeauto'; scroll.append(home);
  const window = {addEventListener: (name, fn) => on('window', name, fn),
    dispatchEvent: event => emit('window', event.type, event.detail), location: {origin: 'http://localhost', href: 'http://localhost/'},
    switchPanel: id => { navigations.push(id); emit('document', 'tli-panel-switched', {panelId: id}); },
    TLISonos: {open: id => {opened.push(id);}}};
  function emit(scope, name, detail) { for (const fn of events[scope + ':' + name] || []) fn({type: name, detail}); }
  const fetch = async (url, options = {}) => { calls.push({url, options}); const result = await handler(url, options, calls);
    if (result) return result; assert.fail(`Unexpected player request: ${options.method || 'GET'} ${url}`); };
  window.fetch = fetch;
  const timer = (fn, delay, interval = false) => { const id = ++serial; timers.set(id, {fn, delay, interval}); return id; };
  const context = vm.createContext({window, document, console, fetch, AbortController, AbortSignal, Headers, URL,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    crypto: {randomUUID: () => 'sonos-player-request-' + (++serial)},
    setTimeout: (fn, delay) => timer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, true), clearInterval: id => timers.delete(id)});
  vm.runInContext(source, context);
  const ids = new Proxy({}, {get: (_, id) => document.getElementById(id)});
  return {window, document, calls, timers, ids, navigations, opened,
    event: (name, detail) => emit('window', name, detail), documentEvent: (name, detail) => emit('document', name, detail),
    respond: fn => {handler = fn;}, all: () => descendants(document.body),
    async advance(milliseconds) { for (const [id, value] of [...timers]) if (value.delay <= milliseconds) {
      if (!value.interval) timers.delete(id); value.fn(); } await flush(); },
    async visibility(hidden) { document.hidden = hidden; emit('document', 'visibilitychange'); await flush(); },
    async navigate(id) { window.switchPanel(id); await flush(); },
  };
}

const PROBE = '/api/events/recent?n=0', SUMMARY = '/api/sonos/now-playing';
const living = {device_id: 'beam-player', uid: 'RINCON_PLAYER_BEAM', name: 'Living room', member_names: ['Living room', 'Dining room'],
  playback: 'PLAYING', title: 'Evening jazz', artist: 'Synthetic quartet', source: {kind: 'spotify_connect', label: 'Spotify Connect', external: true}};
const office = {device_id: 'office-player', uid: 'RINCON_PLAYER_OFFICE', name: 'Office', member_names: ['Office'],
  playback: 'PAUSED_PLAYBACK', title: 'Morning piano', artist: 'Synthetic pianist', source: {kind: 'queue', label: 'Sonos queue', external: false}};
const summary = (groups = [living, office], extra = {}) => response({ok: true, protocol: 'tli-sonos-v1', devices_count: 3,
  connected_count: 3, groups, checked_at: new Date().toISOString(), unavailable_count: 0, partial: false, ...extra});
const volumePath = (id = living.device_id) => '/api/sonos/devices/' + id + '/volume-controls';
const dining = {device_id: 'dining-player', uid: 'RINCON_PLAYER_DINING', name: 'Dining room', volume: 12, muted: false, volume_cap: 25};
const volumeData = (id = living.device_id) => id === office.device_id ? {
  rooms: [{device_id: office.device_id, uid: office.uid, name: office.name, volume: 8, muted: false, volume_cap: 20}], group: {volume: 8, max: 20, muted: false},
} : {rooms: [{device_id: living.device_id, uid: living.uid, name: living.name, volume: 24, muted: false, volume_cap: 35}, {...dining}],
  group: {volume: 18, max: 25, muted: false}};
const levels = (data = volumeData(), id = data.rooms[0]?.device_id || living.device_id) => response({ok: true, protocol: 'tli-sonos-v1', device_id: id, volume_controls: data});
function playerFixture(handler = () => undefined, options = {}) {
  return fixture({...options, handler: (url, request, calls) => {
    const supplied = handler(url, request, calls); if (supplied) return supplied;
    if (url === PROBE) return response({events: []});
    if (url === SUMMARY) return summary();
    if (url.endsWith('/volume-controls')) return levels(volumeData(url.split('/').at(-2)));
    if (url.endsWith('/review')) return response({ok: true, protocol: 'tli-sonos-v1', review_id: 'quick_review',
      device: {id: url.split('/').at(-2)}, ...JSON.parse(request.body)});
    if (url === '/api/sonos/execute') return response({ok: true, protocol: 'tli-sonos-v1', outcome: 'accepted', summary: 'Sonos acknowledged the command.'});
  }});
}
const summaryCalls = f => f.calls.filter(call => call.url === SUMMARY);
const volumeCalls = f => f.calls.filter(call => call.url.endsWith('/volume-controls'));
const admissionCalls = calls => calls.filter(call => call.url === PROBE || call.url === SUMMARY).map(call => call.url);
const commands = f => f.calls.filter(call => /\/(review|execute)$/.test(call.url));
const pollTimers = f => [...f.timers.values()].filter(timer => [10000, 15000, 20000, 30000, 60000].includes(timer.delay));

test('startup verifies private access before reading speakers and displays detected playback in both surfaces', async () => {
  const checking = deferred(); const f = playerFixture(url => url === PROBE ? checking.promise : undefined);
  await flush(); assert.deepEqual(f.calls.map(call => call.url), [PROBE]); assert.equal(f.ids['sonos-quick-player'].hidden, true);
  checking.resolve(response({events: []})); await flush();
  assert.deepEqual(admissionCalls(f.calls), [PROBE, SUMMARY]);
  assert.equal(f.ids['sonos-quick-player'].hidden, false); assert.equal(f.ids['sonos-quick-title'].textContent, living.title);
  assert.match(f.ids['sonos-quick-meta'].textContent, /Living room/);
  assert.equal(f.ids['sonos-dashboard-title'].textContent, living.title);
  assert.match(f.ids['sonos-dashboard-state'].textContent, /playing/i);
  assert.equal(commands(f).length, 0, 'Detection never operates speakers');
});

test('visible polling uses one timer and never overlaps a pending summary request', async () => {
  const pending = deferred(); let reads = 0;
  const f = playerFixture(url => url === SUMMARY && ++reads === 2 ? pending.promise : undefined); await flush();
  assert.equal(f.timers.size, 1); assert.equal(pollTimers(f)[0].delay, 10000); assert.equal(pollTimers(f)[0].interval, false);
  await f.advance(10000); assert.equal(summaryCalls(f).length, 2);
  await f.advance(10000); f.documentEvent('tli-panel-switched', {panelId: 'panel-main'}); await flush();
  assert.equal(summaryCalls(f).length, 2, 'A pending read is not restarted by timers or navigation');
  pending.resolve(summary()); await flush(); assert.equal(f.timers.size, 1);
  await f.advance(10000); assert.equal(summaryCalls(f).length, 3);
});

test('a hidden page does not probe or poll until it becomes visible', async () => {
  const f = playerFixture(() => undefined, {hidden: true}); await flush();
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  await f.visibility(false); assert.deepEqual(admissionCalls(f.calls), [PROBE, SUMMARY]);
  await f.visibility(true); assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.equal(f.timers.size, 0);
  const count = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, count);
  await f.visibility(false); assert.deepEqual(admissionCalls(f.calls.slice(count)), [PROBE, SUMMARY]);
});

for (const event of ['tli-session-locked', 'tli-user-changed', 'tli-account-changed']) {
  test(`${event} aborts and discards a late summary; generic unlock cannot resume private polling`, async () => {
    const pending = deferred(); const f = playerFixture(url => url === SUMMARY ? pending.promise : undefined); await flush();
    const read = summaryCalls(f)[0]; f.event(event); assert.equal(read.options.signal.aborted, true);
    pending.resolve(summary([{...living, title: 'LATE PRIVATE TRACK'}])); await flush();
    assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.doesNotMatch(f.document.body.textContent, /LATE PRIVATE TRACK/);
    const count = f.calls.length; f.event('tli-session-unlocked'); await f.advance(60000);
    assert.equal(f.calls.length, count);
  });
}

test('verified recovery performs a new protected probe and duplicate ready events do not overlap work', async () => {
  const recovery = deferred(); let probes = 0;
  const f = playerFixture(url => url === PROBE && ++probes > 1 ? recovery.promise : undefined); await flush();
  f.event('tli-session-locked'); f.event('tli-session-unlocked', {source: 'pin-verification'}); await flush();
  f.event('tli-private-observation-ready'); f.event('tli-private-observation-ready'); await flush();
  assert.equal(f.calls.filter(call => call.url === PROBE).length, 2); assert.equal(summaryCalls(f).length, 1);
  recovery.resolve(response({events: []})); await flush();
  assert.equal(summaryCalls(f).length, 2); assert.equal(f.ids['sonos-quick-player'].hidden, false); assert.equal(f.timers.size, 1);
});

for (const [label, result, recovered] of [['success', response({events: []}), true], ['denied', response({detail: 'Access denied'}, 401), false]]) {
  test(`PIN-off recovery requires observation readiness and its own fresh probe: ${label}`, async () => {
    const checking = deferred(); let probes = 0;
    const f = playerFixture(url => url === PROBE && ++probes > 1 ? checking.promise : undefined); await flush();
    f.event('tli-session-locked'); f.event('tli-private-observation-ready'); await flush();
    assert.equal(f.calls.filter(call => call.url === PROBE).length, 1, 'Readiness while explicitly locked cannot start recovery');
    f.event('tli-session-unlocked'); await f.advance(60000);
    assert.equal(f.calls.filter(call => call.url === PROBE).length, 1, 'Generic unlock alone grants no private access');
    f.event('tli-private-observation-ready'); await flush();
    assert.equal(f.calls.filter(call => call.url === PROBE).length, 2); assert.equal(summaryCalls(f).length, 1);
    checking.resolve(result); await flush();
    assert.equal(summaryCalls(f).length, recovered ? 2 : 1);
    assert.equal(f.ids['sonos-quick-player'].hidden, !recovered);
  });
}

for (const [label, result] of [['denied', response({detail: 'Unlock TLI'}, 401)], ['malformed', response({events: 'invalid'})]]) {
  test(`${label} access probe cannot read speaker state`, async () => {
    const f = playerFixture(url => url === PROBE ? result : undefined); await flush();
    assert.equal(summaryCalls(f).length, 0); assert.equal(f.ids['sonos-quick-player'].hidden, true);
    assert.equal(commands(f).length, 0);
  });
}

test('idle playback stays on the dashboard with Play while the top player is hidden', async () => {
  const f = playerFixture(url => url === SUMMARY ? summary([office]) : undefined); await flush();
  assert.equal(f.ids['sonos-quick-player'].hidden, true);
  assert.equal(f.ids['sonos-dashboard-title'].textContent, office.title); assert.match(f.ids['sonos-dashboard-play'].textContent, /play/i);
  assert.equal(f.ids['sonos-dashboard-play'].disabled, false); assert.equal(pollTimers(f)[0].delay, 20000);
  f.ids['sonos-dashboard-play'].click(); await flush();
  assert.equal(commands(f)[0].url, '/api/sonos/devices/' + office.device_id + '/review');
  assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action: 'play', params: {}});
  assert.equal(commands(f).filter(call => call.url === '/api/sonos/execute').length, 1);
});

test('no saved speakers hides both surfaces without effects, volume reads, or recurring polls', async () => {
  const f = playerFixture(url => url === SUMMARY ? summary([], {devices_count: 0, connected_count: 0}) : undefined); await flush();
  assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.equal(f.ids['sonos-dashboard-play'].disabled, true);
  assert.equal(f.ids['dashboard-sonos'].hidden, true); assert.equal(volumeCalls(f).length, 0); assert.equal(f.timers.size, 0);
  await f.advance(60000); await f.advance(60000); assert.equal(summaryCalls(f).length, 1); assert.equal(commands(f).length, 0);
});

test('Sonos stays hidden during initial access and inventory checks until speakers are positively observed', async () => {
  const checking = deferred(), inventory = deferred();
  const f = playerFixture(url => url === PROBE ? checking.promise : url === SUMMARY ? inventory.promise : undefined); await flush();
  assert.equal(f.ids['dashboard-sonos'].hidden, true); assert.equal(f.ids['sonos-quick-player'].hidden, true);
  checking.resolve(response({events: []})); await flush();
  assert.equal(f.ids['dashboard-sonos'].hidden, true); assert.equal(f.ids['sonos-quick-player'].hidden, true);
  inventory.resolve(summary()); await flush(); assert.equal(f.ids['dashboard-sonos'].hidden, false); assert.equal(f.ids['sonos-quick-player'].hidden, false);
});

test('enrollment and last-room removal refresh a dormant widget without operating speakers', async () => {
  let enrolled = false; const f = playerFixture(url => url === SUMMARY ? enrolled ? summary() : summary([], {devices_count: 0, connected_count: 0}) : undefined); await flush();
  assert.equal(f.ids['dashboard-sonos'].hidden, true); assert.equal(f.timers.size, 0);
  enrolled = true; f.event('tli-sonos-changed'); await flush();
  assert.equal(f.ids['dashboard-sonos'].hidden, false); assert.equal(f.ids['sonos-quick-player'].hidden, false);
  assert.equal(summaryCalls(f).length, 2); assert.equal(volumeCalls(f).length, 1); assert.equal(f.timers.size, 1);
  enrolled = false; f.event('tli-sonos-changed'); await flush();
  assert.equal(f.ids['dashboard-sonos'].hidden, true); assert.equal(f.ids['sonos-quick-player'].hidden, true);
  assert.equal(f.timers.size, 0); const count = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, count); assert.equal(commands(f).length, 0);
});

for (const returnEvent of ['visibility', 'pageshow']) {
  test(`a ${returnEvent} return rechecks previously empty inventory through fresh protected access`, async () => {
    let enrolled = false; const f = playerFixture(url => url === SUMMARY ? enrolled ? summary() : summary([], {devices_count: 0, connected_count: 0}) : undefined); await flush();
    const count = f.calls.length; enrolled = true;
    if (returnEvent === 'visibility') {await f.visibility(true); await f.visibility(false);}
    else {f.event('pagehide'); f.event('pageshow'); await flush();}
    assert.deepEqual(admissionCalls(f.calls.slice(count)), [PROBE, SUMMARY]); assert.equal(f.ids['dashboard-sonos'].hidden, false); assert.equal(commands(f).length, 0);
  });
}

test('known Sonos owners keep an unavailable dashboard card but a new authority epoch forgets that observation', async () => {
  let failed = false; const f = playerFixture(url => url === SUMMARY && failed ? response({detail: 'Unavailable'}, 503) : undefined); await flush();
  failed = true; await f.advance(10000); assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.equal(f.ids['dashboard-sonos'].hidden, false);
  assert.equal(f.ids['sonos-dashboard-play'].disabled, true); assert.equal(f.ids['sonos-dashboard-refresh'].disabled, false);
  assert.match(f.ids['sonos-dashboard-state'].textContent, /unavailable|connection/i);
  f.event('tli-account-changed'); assert.equal(f.ids['dashboard-sonos'].hidden, true);
  f.event('tli-session-unlocked', {source: 'pin-verification'}); await flush();
  assert.equal(f.ids['dashboard-sonos'].hidden, true, 'A failed read cannot transfer previous owner device presence'); assert.equal(commands(f).length, 0);
});

test('saved but currently unavailable speakers still reveal the dashboard without volume reads', async () => {
  const f = playerFixture(url => url === SUMMARY ? summary([], {devices_count: 2, connected_count: 0, unavailable_count: 2, partial: true}) : undefined); await flush();
  assert.equal(f.ids['dashboard-sonos'].hidden, false); assert.equal(f.ids['sonos-quick-player'].hidden, true);
  assert.match(f.ids['sonos-dashboard-state'].textContent, /unavailable/i); assert.equal(f.ids['sonos-dashboard-open'].disabled, false);
  assert.equal(volumeCalls(f).length, 0); assert.equal(f.timers.size, 1); assert.equal(commands(f).length, 0);
});

test('failed polling clears the previous playing claim and never sends a playback command', async () => {
  let reads = 0; const f = playerFixture(url => url === SUMMARY && ++reads > 1 ? response({detail: 'Speakers unavailable'}, 503) : undefined);
  await flush(); assert.equal(f.ids['sonos-quick-player'].hidden, false); await f.advance(10000);
  assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.equal(f.ids['sonos-dashboard-play'].disabled, true);
  assert.doesNotMatch(f.ids['sonos-dashboard-state'].textContent, /^playing$/i); assert.equal(commands(f).length, 0);
  assert.equal(pollTimers(f)[0].delay, 15000);
  await f.advance(15000); assert.equal(pollTimers(f)[0].delay, 30000);
  await f.advance(30000); assert.equal(pollTimers(f)[0].delay, 60000);
});

test('playing group selection targets exactly the chosen group and survives ordinary navigation', async () => {
  const second = {...office, playback: 'PLAYING'};
  const f = playerFixture(url => url === SUMMARY ? summary([living, second]) : undefined); await flush();
  assert.equal(f.ids['sonos-quick-room'].hidden, false);
  f.ids['sonos-quick-room'].value = second.device_id; f.ids['sonos-quick-room'].fire('change'); await flush();
  assert.equal(f.ids['sonos-quick-title'].textContent, second.title);
  const reads = summaryCalls(f).length; await f.navigate('panel-main'); await f.navigate('panel-homeauto');
  assert.equal(f.ids['sonos-quick-player'].hidden, false); assert.equal(f.ids['sonos-quick-title'].textContent, second.title);
  assert.equal(summaryCalls(f).length, reads, 'Panel navigation does not restart global polling');
  f.ids['sonos-quick-open'].click(); await flush(); assert.deepEqual(f.opened, [second.device_id]);
});

for (const action of ['previous', 'pause', 'next']) {
  test(`quick ${action} is one review and one execute without confirmation or optimistic playback`, async () => {
    const pending = deferred(); const f = playerFixture(url => url === '/api/sonos/execute' ? pending.promise : undefined); await flush();
    f.ids['sonos-quick-' + action].click(); await flush();
    assert.deepEqual(commands(f).map(call => call.url), ['/api/sonos/devices/' + living.device_id + '/review', '/api/sonos/execute']);
    assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action, params: {}});
    assert.equal(JSON.parse(commands(f)[1].options.body).review_id, 'quick_review');
    f.ids['sonos-quick-' + action].fire('click'); await flush(); assert.equal(commands(f).length, 2);
    pending.resolve(response({ok: true, protocol: 'tli-sonos-v1', outcome: 'accepted', summary: 'Acknowledged.'})); await flush();
    assert.equal(commands(f).length, 2); assert.equal(summaryCalls(f).length, 2, 'Observed status is refreshed after command completion');
  });
}

test('pausing hides the top player only after refreshed state shows pause and leaves dashboard Play available', async () => {
  let reads = 0; const f = playerFixture(url => url === SUMMARY ? summary([{...living, playback: ++reads === 1 ? 'PLAYING' : 'PAUSED_PLAYBACK'}]) : undefined);
  await flush(); f.ids['sonos-quick-pause'].click(); await flush();
  assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.match(f.ids['sonos-dashboard-play'].textContent, /play/i);
  assert.match(f.ids['sonos-dashboard-state'].textContent, /paused/i);
});

test('an uncertain command is never automatically resent', async () => {
  const f = playerFixture(url => url === '/api/sonos/execute' ? response({detail: 'Delivery uncertain. Check Sonos.'}, 503) : undefined); await flush();
  f.ids['sonos-quick-next'].click(); await flush(); assert.match(f.ids['sonos-player-message'].textContent, /not retried/i);
  await f.advance(60000); await f.advance(60000);
  assert.equal(commands(f).filter(call => call.url === '/api/sonos/execute').length, 1); assert.equal(commands(f).filter(call => call.url.endsWith('/review')).length, 1);
});

test('locking during command preparation prevents submission and stale disclosure', async () => {
  const pending = deferred(); const f = playerFixture(url => url.endsWith('/review') ? pending.promise : undefined); await flush();
  f.ids['sonos-quick-next'].click(); await flush(); f.event('tli-session-locked');
  pending.resolve(response({protocol: 'tli-sonos-v1', review_id: 'stale_review'})); await flush();
  assert.equal(commands(f).filter(call => call.url === '/api/sonos/execute').length, 0);
  assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.equal(f.timers.size, 0);
});

test('pagehide aborts a read and pageshow requires a fresh protected probe', async () => {
  const pending = deferred(); let reads = 0;
  const f = playerFixture(url => url === SUMMARY && ++reads === 2 ? pending.promise : undefined); await flush(); await f.advance(10000);
  f.event('pagehide'); assert.equal(summaryCalls(f)[1].options.signal.aborted, true);
  pending.resolve(summary([{...living, title: 'OLD PAGE TRACK'}])); await flush();
  assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.doesNotMatch(f.document.body.textContent, /OLD PAGE TRACK/);
  const count = f.calls.length; f.event('pageshow'); await flush();
  assert.deepEqual(admissionCalls(f.calls.slice(count)), [PROBE, SUMMARY]);
});

for (const [label, patch] of [
  ['missing review identity', {review_id: ''}], ['different action', {action: 'play'}],
  ['different target', {device: {id: office.device_id}}], ['missing target', {device: null}],
]) {
  test(`${label} in a command preflight blocks execution`, async () => {
    const f = playerFixture(url => url.endsWith('/review') ? response({ok: true, protocol: 'tli-sonos-v1',
      review_id: 'wrong_review', action: 'pause', device: {id: living.device_id}, ...patch}) : undefined); await flush();
    f.ids['sonos-quick-pause'].click(); await flush();
    assert.equal(commands(f).filter(call => call.url === '/api/sonos/execute').length, 0);
    assert.match(f.ids['sonos-player-message'].textContent, /Nothing was submitted/);
  });
}

test('a read started before a command cannot restore outdated playback after its newer observation', async () => {
  const oldPoll = deferred(); let reads = 0;
  const f = playerFixture(url => url === SUMMARY ? (++reads === 2 ? oldPoll.promise
    : summary([{...living, playback: reads > 2 ? 'PAUSED_PLAYBACK' : 'PLAYING'}])) : undefined); await flush();
  await f.advance(10000); f.ids['sonos-quick-pause'].click(); await flush();
  assert.equal(summaryCalls(f)[1].options.signal.aborted, true);
  assert.equal(summaryCalls(f).length, 3); assert.equal(f.ids['sonos-quick-player'].hidden, true);
  oldPoll.resolve(summary([{...living, title: 'STALE PLAYING TRACK'}])); await flush();
  assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.doesNotMatch(f.document.body.textContent, /STALE PLAYING TRACK/);
  assert.equal(commands(f).filter(call => call.url === '/api/sonos/execute').length, 1); assert.equal(f.timers.size, 1);
});

test('track and source metadata remain literal text in both players', async () => {
  const malicious = {...living, name: '<img src=x>', title: '<script>track</script>', artist: '<svg>artist</svg>',
    source: {label: '<iframe>source</iframe>'}};
  const f = playerFixture(url => url === SUMMARY ? summary([malicious]) : undefined); await flush();
  for (const id of ['sonos-quick-title', 'sonos-dashboard-title']) {
    assert.equal(f.ids[id].textContent, malicious.title); assert.equal(f.ids[id].children.length, 0);
  }
  assert.match(f.ids['sonos-quick-meta'].textContent, /<iframe>source<\/iframe>/);
  assert.equal(f.all().some(node => ['img', 'script', 'iframe'].includes(node.tag)), false);
  assert.ok(f.all().filter(node => node.tag === 'svg').every(node => node.getAttribute('aria-hidden') === 'true'), 'Only authored decorative speaker icons are SVG');
});

test('a summary resolving after its timeout cannot preserve an old playing claim', async () => {
  const pending = deferred(); let reads = 0;
  const f = playerFixture(url => url === SUMMARY && ++reads === 2 ? pending.promise : undefined); await flush();
  await f.advance(10000); assert.equal(f.ids['sonos-quick-player'].hidden, false);
  await f.advance(15000); assert.equal(summaryCalls(f)[1].options.signal.aborted, true);
  pending.resolve(summary([{...living, title: 'TOO LATE PLAYING'}])); await flush();
  assert.equal(f.ids['sonos-quick-player'].hidden, true);
  assert.doesNotMatch(f.document.body.textContent, /TOO LATE PLAYING|Evening jazz/);
  assert.equal(f.ids['sonos-dashboard-play'].disabled, true); assert.equal(pollTimers(f)[0].delay, 15000);
  assert.equal(commands(f).length, 0);
});

for (const phase of ['review', 'execute']) {
  test(`a late ${phase} after command timeout cannot submit or replay an effect`, async () => {
    const pending = deferred(); const waitingFor = phase === 'review' ? '/review' : '/execute';
    const f = playerFixture(url => url.endsWith(waitingFor) ? pending.promise : undefined); await flush();
    f.ids['sonos-quick-next'].click(); await flush(); await f.advance(45000);
    pending.resolve(response({protocol: 'tli-sonos-v1', review_id: 'late_review', action: 'next', device: {id: living.device_id},
      outcome: 'accepted', summary: 'TOO LATE ACKNOWLEDGEMENT'})); await flush();
    assert.equal(commands(f).filter(call => call.url === '/api/sonos/execute').length, phase === 'review' ? 0 : 1);
    assert.match(f.ids['sonos-player-message'].textContent, phase === 'review' ? /Nothing was submitted/ : /not retried/);
    assert.doesNotMatch(f.ids['sonos-player-message'].textContent, /TOO LATE ACKNOWLEDGEMENT/);
    await f.advance(60000); assert.equal(commands(f).filter(call => call.url === '/api/sonos/execute').length, phase === 'review' ? 0 : 1);
  });
}

test('the two surfaces share one selected coordinator read and keep the group mixer closed initially', async () => {
  const checking = deferred(); const f = playerFixture(url => url === PROBE ? checking.promise : undefined); await flush();
  assert.equal(volumeCalls(f).length, 0, 'Levels require verified browser access');
  checking.resolve(response({events: []})); await flush();
  assert.deepEqual(volumeCalls(f).map(call => call.url), [volumePath()]);
  for (const prefix of ['sonos-quick', 'sonos-dashboard']) {
    const range = f.ids[prefix + '-volume-range']; assert.ok(range); assert.equal(String(range.value), '18'); assert.equal(String(range.max), '25');
    assert.match(range.getAttribute('aria-label'), /volume/i);
    assert.equal(f.ids[prefix + '-volume-toggle'].getAttribute('aria-expanded'), 'false');
    assert.equal(f.ids[prefix + '-volume-mixer'].hidden, true);
  }
  assert.equal(commands(f).length, 0);
});

test('paused dashboard selection and playing quick player retain separate exact volume targets', async () => {
  const f = playerFixture(); await flush();
  f.ids['sonos-dashboard-room'].value = office.device_id; f.ids['sonos-dashboard-room'].fire('change'); await flush();
  assert.equal(f.ids['sonos-quick-title'].textContent, living.title); assert.equal(f.ids['sonos-dashboard-title'].textContent, office.title);
  assert.deepEqual(volumeCalls(f).map(call => call.url), [volumePath(), volumePath(office.device_id)]);
  assert.equal(String(f.ids['sonos-quick-volume-range'].value), '18'); assert.equal(String(f.ids['sonos-dashboard-volume-range'].value), '8');
  f.ids['sonos-dashboard-volume-range'].value = '10'; f.ids['sonos-dashboard-volume-range'].fire('change'); await flush();
  assert.equal(commands(f)[0].url, '/api/sonos/devices/' + office.device_id + '/review');
  assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action: 'volume', params: {volume: 10}});
  f.ids['sonos-quick-volume-range'].value = '19'; f.ids['sonos-quick-volume-range'].fire('change'); await flush();
  assert.equal(commands(f)[2].url, '/api/sonos/devices/' + living.device_id + '/review');
  assert.deepEqual(JSON.parse(commands(f)[2].options.body), {action: 'group_volume', params: {volume: 19}});
});

test('drag preview is local and committing a master slider submits exactly one reviewed effect', async () => {
  const pending = deferred(); const f = playerFixture(url => url === '/api/sonos/execute' ? pending.promise : undefined); await flush();
  const range = f.ids['sonos-quick-volume-range']; range.value = '21'; range.fire('input'); await flush();
  assert.equal(commands(f).length, 0); assert.match(f.ids['sonos-quick-volume-value'].textContent, /21/);
  range.fire('change'); await flush(); range.fire('change'); range.fire('input'); await flush();
  assert.equal(commands(f).length, 2); assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action: 'group_volume', params: {volume: 21}});
  assert.equal(f.ids['sonos-quick-volume-range'].disabled, true);
  pending.resolve(response({ok: true, protocol: 'tli-sonos-v1', outcome: 'accepted'})); await flush();
  assert.equal(commands(f).length, 2); assert.equal(f.ids['sonos-quick-volume-range'].disabled, false);
});

test('the expanded mixer uses verified room ceilings and child commands reread the displayed coordinator', async () => {
  const foreign = {rooms: [{...dining, name: 'OTHER GROUP', volume: 3}], group: null};
  const f = playerFixture(url => url === '/api/sonos/execute' ? response({ok: true, protocol: 'tli-sonos-v1', outcome: 'accepted', volume_controls: foreign}) : undefined); await flush();
  f.ids['sonos-quick-volume-toggle'].click(); await flush(); assert.equal(f.ids['sonos-quick-volume-mixer'].hidden, false);
  const beamRange = f.ids['sonos-quick-volume-room-' + living.device_id], diningRange = f.ids['sonos-quick-volume-room-' + dining.device_id];
  assert.equal(String(beamRange.max), '35'); assert.equal(String(diningRange.max), '25');
  assert.equal(f.ids['sonos-quick-volume-room-bonded-sub'], null, 'Unlisted bonded satellites get no controls');
  const reads = volumeCalls(f).length; diningRange.value = '14'; diningRange.fire('change'); await flush();
  assert.equal(commands(f)[0].url, '/api/sonos/devices/' + dining.device_id + '/review');
  assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action: 'volume', params: {volume: 14}});
  assert.ok(volumeCalls(f).slice(reads).some(call => call.url === volumePath()));
  assert.equal(volumeCalls(f).some(call => call.url === volumePath(dining.device_id)), false);
  assert.doesNotMatch(f.document.body.textContent, /OTHER GROUP/);
});

test('group and single-room mute buttons submit explicit boolean parameters to the correct target', async () => {
  const f = playerFixture(); await flush(); f.ids['sonos-quick-volume-mute'].click(); await flush();
  assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action: 'group_mute', params: {muted: true}});
  f.ids['sonos-dashboard-room'].value = office.device_id; f.ids['sonos-dashboard-room'].fire('change'); await flush();
  f.ids['sonos-dashboard-volume-mute'].click(); await flush();
  assert.equal(commands(f)[2].url, '/api/sonos/devices/' + office.device_id + '/review');
  assert.deepEqual(JSON.parse(commands(f)[2].options.body), {action: 'mute', params: {muted: true}});
});

test('partial group volumes expose only verified rooms without an unsafe group command', async () => {
  const f = playerFixture(url => url.endsWith('/volume-controls') ? levels({rooms: volumeData().rooms, group: null,
    reason: 'Some group members could not be verified.'}) : undefined); await flush();
  const master = f.ids['sonos-quick-volume-range']; assert.ok(!master || master.disabled || master.hidden);
  const mute = f.ids['sonos-quick-volume-mute']; assert.ok(!mute || mute.disabled || mute.hidden);
  f.ids['sonos-quick-volume-toggle'].click(); await flush();
  const range = f.ids['sonos-quick-volume-room-' + dining.device_id]; assert.ok(range); assert.equal(range.disabled, false);
  range.value = '13'; range.fire('change'); await flush();
  assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action: 'volume', params: {volume: 13}});
});

test('a partial group with one verified child keeps its name and never implies that slider controls the displayed coordinator', async () => {
  const reason = 'The coordinator could not be verified. Only checked rooms are available.';
  const f = playerFixture(url => url === volumePath() ? levels({rooms: [{...dining}], group: null, reason}, living.device_id) : undefined); await flush();
  assert.equal(f.ids['sonos-quick-volume-range'], null); assert.equal(f.ids['sonos-quick-volume-mute'], null);
  const toggle = f.ids['sonos-quick-volume-toggle']; assert.equal(toggle.hidden, false); assert.equal(toggle.textContent, '1 room');
  toggle.click(); assert.match(f.ids['sonos-quick-volume-mixer'].textContent, /Dining room/);
  assert.ok(f.ids['sonos-quick-volume-mixer'].textContent.includes(reason));
  const child = f.ids['sonos-quick-volume-room-' + dining.device_id]; child.value = '14'; child.fire('change'); await flush();
  assert.equal(commands(f)[0].url, '/api/sonos/devices/' + dining.device_id + '/review');
  assert.deepEqual(JSON.parse(commands(f)[0].options.body), {action: 'volume', params: {volume: 14}});
});

test('observed volume above a saved ceiling stays truthful while the adjustable thumb is clamped', async () => {
  const data = volumeData(office.device_id); data.rooms[0].volume = 30; data.group.volume = 30;
  const f = playerFixture(url => url === SUMMARY ? summary([office]) : url === volumePath(office.device_id) ? levels(data) : undefined); await flush();
  assert.equal(f.ids['sonos-dashboard-volume-value'].textContent, '30');
  const slider = f.ids['sonos-dashboard-volume-range']; assert.equal(String(slider.value), '20');
  assert.match(slider.getAttribute('aria-valuetext'), /^30 out of 100; limit 20$/);
  assert.equal(commands(f).length, 0, 'Observation never silently lowers a speaker');
});

for (const cause of ['lock', 'hidden', 'selection']) {
  test(`a late volume response after ${cause} cannot expose stale levels or reactivate a detached control`, async () => {
    const pending = deferred(); let reading = 0;
    const f = playerFixture(url => url === volumePath() && ++reading === 2 ? pending.promise : undefined,
      {}); await flush();
    const old = f.ids['sonos-quick-volume-range']; await f.advance(10000);
    assert.equal(volumeCalls(f).filter(call => call.url === volumePath()).length, 2);
    if (cause === 'lock') f.event('tli-session-locked');
    else if (cause === 'hidden') await f.visibility(true);
    else {
      // Both surfaces must leave the old group, otherwise its still-visible quick player is a valid consumer.
      f.respond(url => url === SUMMARY ? summary([{...office, playback: 'PLAYING'}]) : url === PROBE ? response({events: []})
        : url.endsWith('/volume-controls') ? levels(volumeData(office.device_id)) : undefined);
      f.ids['sonos-dashboard-refresh'].click(); await flush();
    }
    pending.resolve(levels({rooms: [{...dining, name: 'LATE PRIVATE ROOM', volume: 23}], group: null})); await flush();
    assert.doesNotMatch(f.document.body.textContent, /LATE PRIVATE ROOM/);
    old.value = '9'; old.fire('change'); await flush(); assert.equal(commands(f).length, 0);
  });
}

test('changing selected playing group invalidates retained slider callbacks immediately', async () => {
  const f = playerFixture(url => url === SUMMARY ? summary([living, {...office, playback: 'PLAYING'}]) : undefined); await flush();
  const old = f.ids['sonos-quick-volume-range']; f.ids['sonos-quick-room'].value = office.device_id;
  f.ids['sonos-quick-room'].fire('change'); await flush(); old.value = '11'; old.fire('change'); await flush();
  assert.equal(commands(f).length, 0); assert.equal(String(f.ids['sonos-quick-volume-range'].value), '8');
});

test('failed volume refresh disables stale controls while playback transport remains usable', async () => {
  let reads = 0; const f = playerFixture(url => url.endsWith('/volume-controls') && ++reads > 1
    ? response({detail: 'Levels unavailable'}, 503) : undefined); await flush();
  await f.advance(10000); assert.equal(f.ids['sonos-quick-player'].hidden, false);
  assert.equal(f.ids['sonos-quick-next'].disabled, false);
  const range = f.ids['sonos-quick-volume-range']; assert.ok(!range || range.disabled);
  assert.equal(commands(f).length, 0);
});

test('volume preparation failure and uncertain execution never automatically resend a speaker action', async () => {
  for (const phase of ['review', 'execute']) {
    const f = playerFixture(url => url.endsWith('/' + phase) ? response({detail: 'Synthetic failure'}, 503) : undefined); await flush();
    const range = f.ids['sonos-quick-volume-range']; range.value = '20'; range.fire('change'); await flush();
    await f.advance(60000); await f.advance(60000);
    assert.equal(commands(f).filter(call => call.url.endsWith('/review')).length, 1);
    assert.equal(commands(f).filter(call => call.url.endsWith('/execute')).length, phase === 'review' ? 0 : 1);
  }
});

test('pending level reads never overlap or replace a pointer preview, and cancellation permits a later refresh', async () => {
  const pending = deferred(); let reads = 0;
  const changed = volumeData(); changed.group.volume = 7; changed.rooms.forEach(room => {room.volume = 7;});
  const f = playerFixture(url => url === volumePath() ? (++reads === 2 ? pending.promise : reads > 2 ? levels(changed) : undefined) : undefined);
  await flush(); const slider = f.ids['sonos-quick-volume-range']; await f.advance(10000);
  assert.equal(reads, 2); await f.advance(10000); assert.equal(reads, 2, 'Same coordinator has one pending volume read');
  slider.fire('pointerdown'); slider.value = '22'; slider.fire('input');
  pending.resolve(levels(changed)); await flush();
  assert.equal(f.ids['sonos-quick-volume-range'], slider); assert.equal(slider.value, '22');
  await f.advance(10000); assert.equal(reads, 2, 'Polling preserves a live pointer adjustment');
  slider.fire('pointercancel'); slider.fire('blur'); await f.advance(10000);
  assert.equal(reads, 3); assert.equal(String(f.ids['sonos-quick-volume-range'].value), '7'); assert.equal(commands(f).length, 0);
});

test('a level reply for a different coordinator is unusable until a valid read succeeds', async () => {
  let wrong = true; const f = playerFixture(url => url === volumePath() ? levels(volumeData(), wrong ? office.device_id : living.device_id) : undefined); await flush();
  assert.equal(f.ids['sonos-quick-volume-range'], null); assert.equal(f.ids['sonos-quick-volume-retry'].hidden, false);
  assert.equal(f.ids['sonos-quick-next'].disabled, false); wrong = false;
  f.ids['sonos-quick-volume-retry'].click(); await flush();
  assert.equal(f.ids['sonos-quick-volume-range'].disabled, false); assert.equal(commands(f).length, 0);
});

test('access denial from the volume endpoint clears all private playback and blocks ordinary recovery', async () => {
  const f = playerFixture(url => url.endsWith('/volume-controls') ? response({detail: 'Unlock TLI'}, 403) : undefined); await flush();
  assert.equal(f.ids['sonos-quick-player'].hidden, true); assert.doesNotMatch(f.document.body.textContent, /Evening jazz|Dining room/);
  const count = f.calls.length; f.event('tli-session-unlocked'); await f.advance(60000); assert.equal(f.calls.length, count);
});

test('unchanged levels do not send commands and malformed synthetic range values cannot escape the ceiling', async () => {
  const f = playerFixture(); await flush(); const slider = f.ids['sonos-quick-volume-range'];
  for (const value of ['18', '26', '-1', '1.5', 'NaN']) {slider.value = value; slider.fire('change'); await flush();}
  assert.equal(commands(f).length, 0);
});
