const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/sonos.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const response = (value, status = 200) => ({ok: status >= 200 && status < 300, status,
  json: async () => JSON.parse(JSON.stringify({protocol: 'tli-sonos-v1', ...value}))});
const speaker = {id: 'speaker_beam', uid: 'RINCON_FIXTURE_BEAM', name: 'Living room', room: 'Living room', model: 'Beam (Gen 1)', volume_cap: 35};
const secondSpeaker = {id: 'speaker_play1', uid: 'RINCON_FIXTURE_PLAY1', name: 'Living room', room: 'Office', model: 'Play:1', volume_cap: 12};
const candidate = {discovery_id: 'opaque_discovery_token', name: speaker.name, room: speaker.room,
  model: speaker.model, already_enrolled: false};
const catalog = (devices = []) => response({devices, availability: {music: true}});
const discovery = (candidates = [candidate], extra = {}) => response({candidates, expires_in_seconds: 120, partial: false, ...extra});

function fixture(handler = () => undefined) {
  const events = {}, calls = [], dispatched = [], timers = new Map(); let serial = 0;
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const dispatch = (prefix, event) => {
    dispatched.push({scope: prefix || 'window', type: event.type, detail: event.detail});
    for (const fn of events[prefix + event.type] || []) fn(event);
    return true;
  };
  function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
  function matches(node, selector) {
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return (node.className || '').split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[data-')) {
      const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return node.dataset[key] != null;
    }
    return selector.split(',').map(part => part.trim()).includes(node.tag);
  }
  function element(tag = 'div') {
    let content = '';
    const node = {tag, tagName: tag.toUpperCase(), parentNode: null, children: [], handlers: {}, attributes: {}, dataset: {},
      value: '', disabled: false, hidden: false, open: false, checked: false,
      append(...nodes) { for (const child of nodes) { child.remove(); child.parentNode = this; this.children.push(child);
        if (this.tag === 'select' && this.children.length === 1) this.value = child.value; } },
      appendChild(child) { this.append(child); return child; },
      insertBefore(child, before) { if (!before) return this.appendChild(child); child.remove();
        const index = this.children.indexOf(before); assert(index >= 0); child.parentNode = this; this.children.splice(index, 0, child); return child; },
      before(child) { this.parentNode?.insertBefore(child, this); },
      after(child) { if (this.parentNode) { const siblings = this.parentNode.children; this.parentNode.insertBefore(child, siblings[siblings.indexOf(this) + 1]); } },
      remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } },
      replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null;
        this.children = []; content = ''; if (this.tag === 'select') this.value = ''; this.append(...nodes); },
      setAttribute(key, value) { this.attributes[key] = String(value);
        if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); },
      getAttribute(key) { if (key.startsWith('data-')) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
        return this.attributes[key] ?? null; },
      removeAttribute(key) { delete this.attributes[key];
        if (key.startsWith('data-')) delete this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; },
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      fire(name, extra = {}) { const event = {target: this, currentTarget: this, preventDefault() {}, ...extra};
        for (const fn of this.handlers[name] || []) fn(event); },
      click() { if (!this.disabled) this.fire('click'); },
      querySelectorAll(selector) { return descendants(this).filter(child => matches(child, selector)); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      closest(selector) { let current = this; while (current) { if (matches(current, selector)) return current; current = current.parentNode; } return null; },
    };
    Object.defineProperty(node, 'firstChild', {get() { return this.children[0] || null; }});
    node.classList = {
      contains(name) { return (node.className || '').split(/\s+/).includes(name); },
      add(...names) { node.className = [...new Set([...(node.className || '').split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove(...names) { node.className = (node.className || '').split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle(name, force) { const enabled = force ?? !this.contains(name); this[enabled ? 'add' : 'remove'](name); return enabled; },
    };
    Object.defineProperty(node, 'textContent', {get() { return content + this.children.map(child => child.textContent).join(''); },
      set(value) { this.replaceChildren(); content = String(value); }});
    return node;
  }
  const document = {readyState: 'complete', hidden: false, body: element('body'), createElement: element,
    getElementById: id => descendants(document.body).find(node => node.id === id) || null,
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    querySelector: selector => document.body.querySelector(selector),
    addEventListener: (name, fn) => (events['document:' + name] ||= []).push(fn),
    dispatchEvent: event => dispatch('document:', event)};
  const panel = element(); panel.id = 'panel-homeauto'; document.body.append(panel);
  const assistant = element('details'); assistant.id = 'home-assistant-section';
  const assistantTitle = element('summary'); assistantTitle.textContent = 'Home Assistant · optional connection';
  const assistantMount = element(); assistantMount.id = 'home-assistant-mount';
  assistant.append(assistantTitle, assistantMount); panel.append(assistant);
  const window = {addEventListener: (name, fn) => (events[name] ||= []).push(fn),
    dispatchEvent: event => dispatch('', event)};
  const context = vm.createContext({window, document, console, AbortController, CustomEvent, crypto: {randomUUID: () => `request-${++serial}`},
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, {fn, delay}); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      calls.push({url, options}); const supplied = await handler(url, options, calls);
      if (supplied) return supplied;
      if (url === '/api/sonos/devices' && options.method === 'GET') return catalog();
      if (url === '/api/sonos/discover') return discovery();
      if (url === '/api/sonos/devices' && options.method === 'POST') return response({device: speaker});
      assert.fail(`Unexpected request: ${options.method} ${url}`);
    },
  });
  vm.runInContext(source, context);
  const all = () => descendants(document.body);
  const visible = node => {
    if (!node) return false;
    for (let current = node; current; current = current.parentNode) {
      if (current.hidden) return false;
      const parent = current.parentNode;
      if (parent?.tag === 'details' && !parent.open && current.tag !== 'summary') return false;
    }
    return true;
  };
  const emit = (name, detail) => { for (const fn of events[name] || []) fn({detail}); };
  const ids = new Proxy({}, {get: (_, id) => document.getElementById(id)});
  return {calls, dispatched, ids, document, window, all, visible, emit,
    button: label => all().find(node => node.tag === 'button' && node.textContent === label),
    text: () => ids['sonos-box'].textContent,
    async find() { this.button('Find speakers').click(); await flush(); },
    async click(label) { const button = this.button(label); assert(button, `Missing button ${label}`); assert(!button.disabled, `${label} is disabled`); button.click(); await flush(); },
    async enter() { emit('document:tli-panel-switched', {panelId: 'panel-homeauto'}); await flush(); },
    async select(id = speaker.id) { ids['sonos-device'].value = id; ids['sonos-device'].fire('change'); await flush(); },
    advanceTimers(milliseconds) { for (const [id, timer] of timers) if (timer.delay <= milliseconds) { timers.delete(id); timer.fn(); } },
  };
}

function quickNavigation(f) {
  const opened = [];
  f.window.switchPanel = panelId => {
    opened.push(panelId);
    f.ids['panel-homeauto'].hidden = panelId !== 'panel-homeauto';
    f.document.dispatchEvent({type: 'tli-panel-switched', detail: {panelId}});
  };
  return opened;
}

test('quick-player Rooms opens its exact room and automatically checks its status without a command', async () => {
  const pending = deferred();
  const f = fixture(url => {
    if (url === '/api/sonos/devices') return pending.promise;
    if (url === `/api/sonos/devices/${secondSpeaker.id}/status`) return response({device: secondSpeaker,
      reading: {playback: 'PAUSED_PLAYBACK', title: 'Quick-open checked track', volume: 8, muted: false}});
  });
  const opened = quickNavigation(f);
  f.window.TLISonos.open(secondSpeaker.id); await flush();
  assert.deepEqual(opened, ['panel-homeauto']);
  assert.equal(f.calls.length, 1, 'The target waits for the saved-room list');
  pending.resolve(catalog([speaker, secondSpeaker])); await flush();
  assert.equal(f.ids['sonos-device'].value, secondSpeaker.id);
  assert.match(f.ids['sonos-status'].textContent, /Quick-open checked track/);
  assert.deepEqual(f.calls.map(call => [call.options.method, call.url]), [
    ['GET', '/api/sonos/devices'], ['GET', `/api/sonos/devices/${secondSpeaker.id}/status`],
  ]);
});

for (const timedOut of [false, true]) {
  test(`quick-open does not use cached rooms after a ${timedOut ? 'timed-out' : 'failed'} catalog refresh`, async () => {
    const pending = deferred(); let lists = 0;
    const f = fixture(url => url === '/api/sonos/devices'
      ? (++lists === 1 ? catalog([speaker, secondSpeaker]) : pending.promise) : undefined);
    quickNavigation(f);
    await f.enter(); await f.select(speaker.id);
    f.window.TLISonos.open(secondSpeaker.id); await flush();
    if (timedOut) f.advanceTimers(45000);
    pending.resolve(timedOut ? catalog([speaker, secondSpeaker]) : response({detail: 'Rooms unavailable.'}, 503));
    await flush();
    assert.equal(f.ids['sonos-device'].value, speaker.id);
    assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 0);
    assert.equal(f.calls.length, 2);
    if (!timedOut) assert.match(f.ids['sonos-message'].textContent, /Rooms unavailable/);
  });
}

for (const [label, change] of [
  ['manual room selection', f => {f.ids['sonos-device'].value = speaker.id; f.ids['sonos-device'].fire('change');}],
  ['navigation', f => f.window.switchPanel('panel-dashboard2')],
  ['lock and unlock', f => {f.emit('tli-session-locked'); f.emit('tli-session-unlocked');}],
  ['owner change', f => f.emit('tli-account-changed')],
]) {
  test(`${label} cancels a quick-open target while its room list is pending`, async () => {
    const pending = deferred(); let lists = 0;
    const f = fixture(url => url === '/api/sonos/devices' ? (++lists === 1 ? catalog([speaker, secondSpeaker]) : pending.promise) : undefined);
    const opened = quickNavigation(f);
    await f.enter(); await f.select(speaker.id);
    f.window.TLISonos.open(secondSpeaker.id); await flush(); change(f);
    pending.resolve(catalog([{...secondSpeaker, name: 'PRIVATE STALE QUICK ROOM'}])); await flush();
    assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 0);
    assert.doesNotMatch(f.text(), /PRIVATE STALE QUICK ROOM/);
    if (label === 'manual room selection') assert.equal(f.ids['sonos-device'].value, speaker.id);
    if (label === 'navigation') {
      assert.deepEqual(opened, ['panel-homeauto', 'panel-dashboard2']);
      assert.equal(f.ids['panel-homeauto'].hidden, true);
    }
  });

  test(`${label} discards a quick-open status already in flight`, async () => {
    const pending = deferred();
    const f = fixture(url => {
      if (url === '/api/sonos/devices') return catalog([speaker, secondSpeaker]);
      if (url.endsWith('/status')) return pending.promise;
    });
    quickNavigation(f);
    f.window.TLISonos.open(secondSpeaker.id); await flush();
    assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 1);
    change(f);
    pending.resolve(response({device: secondSpeaker, reading: {playback: 'PLAYING', title: 'PRIVATE STALE QUICK TRACK'}}));
    await flush();
    assert.doesNotMatch(f.text(), /PRIVATE STALE QUICK TRACK/);
    assert.equal(f.calls.length, 2);
    if (label === 'manual room selection') assert.equal(f.ids['sonos-device'].value, speaker.id);
  });
}

test('successful room enrollment notifies the automatic player without exposing speaker metadata in the event', async () => {
  let enrolled = false;
  const f = fixture((url, options) => {
    if (url === '/api/sonos/devices' && options.method === 'POST') {enrolled = true; return response({device: speaker});}
    if (url === '/api/sonos/devices' && options.method === 'GET') return catalog(enrolled ? [speaker] : []);
  });
  await f.find(); await f.click('Add to TLI');
  const changed = f.dispatched.filter(event => event.type === 'tli-sonos-changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].detail, undefined);
});

test('clean Sonos section has no manual setup and only loads saved rooms when opened', async () => {
  const f = fixture(); await flush();
  assert(f.button('Find speakers'));
  assert(f.button('Refresh rooms'));
  assert.equal(f.ids['sonos-box'].tag, 'section');
  for (const id of ['sonos-advanced', 'sonos-ip', 'sonos-name', 'sonos-room', 'sonos-cap']) assert.equal(f.ids[id], null);
  assert.equal(f.ids['sonos-player'].hidden, true);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert.equal(f.ids['sonos-box'].querySelectorAll('details').length, 0);
  assert.equal(f.calls.length, 0);
  await f.enter();
  assert.deepEqual(f.calls.map(call => [call.options.method, call.url]), [['GET', '/api/sonos/devices']]);
  await f.click('Refresh rooms');
  assert.equal(f.calls.length, 2);
  assert(f.calls.every(call => call.url === '/api/sonos/devices' && call.options.method === 'GET'));
});

test('optional Home Assistant stays collapsed after Sonos and panel entry never contacts hardware', async () => {
  const f = fixture();
  const nodes = f.all();
  assert(nodes.indexOf(f.ids['sonos-box']) < nodes.indexOf(f.ids['home-assistant-section']));
  assert.equal(f.ids['home-assistant-section'].open, false);
  assert.equal(f.visible(f.ids['home-assistant-mount']), false);
  await f.enter();
  assert.deepEqual(f.calls.map(call => [call.options.method, call.url]), [['GET', '/api/sonos/devices']]);
  f.ids['home-assistant-section'].open = true; f.ids['home-assistant-section'].fire('toggle'); await flush();
  assert.equal(f.calls.length, 1);
});

test('discovery renders speaker names/models and enrolls only the opaque choice', async () => {
  let enrolled = false;
  const f = fixture((url, options) => {
    if (url === '/api/sonos/devices' && options.method === 'POST') { enrolled = true; return response({device: speaker}); }
    if (url === '/api/sonos/devices' && options.method === 'GET') return catalog(enrolled ? [speaker] : []);
  });
  await f.find();
  assert.match(f.ids['sonos-found'].textContent, /Living room/);
  assert.match(f.ids['sonos-found'].textContent, /Beam \(Gen 1\)/);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/devices').length, 0);
  assert.equal(f.all().filter(node => node.tag === 'input' && f.visible(node) && node.type !== 'number').length, 0);
  await f.click('Add to TLI');
  const request = f.calls.find(call => call.url === '/api/sonos/devices' && call.options.method === 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {discovery_id: candidate.discovery_id});
  assert.equal(f.ids['sonos-device'].value, speaker.id);
  assert(f.calls.some(call => call.url === '/api/sonos/devices' && call.options.method === 'GET'));
  assert.equal(f.calls.filter(call => /\/(status|review|execute)$/.test(call.url)).length, 0);
  await f.click('Done');
  assert.equal(f.visible(f.ids['sonos-found']), false);
  assert.equal(f.ids['sonos-device'].value, speaker.id);
  assert.equal(f.ids['sonos-player'].hidden, false);
});

test('already enrolled discovery offers explicit reconnect and refreshes the returned identity', async () => {
  const f = fixture((url, options) => {
    if (url === '/api/sonos/discover') return discovery([{...candidate, already_enrolled: true, device_id: speaker.id}]);
    if (url === '/api/sonos/devices' && options.method === 'GET') return catalog([speaker]);
  });
  await f.find();
  assert(f.button('Reconnect speaker'));
  assert.equal(f.button('Add to TLI'), undefined);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/devices' && call.options.method === 'POST').length, 0);
  await f.click('Reconnect speaker');
  assert.deepEqual(JSON.parse(f.calls.find(call => call.url === '/api/sonos/devices' && call.options.method === 'POST').options.body),
    {discovery_id: candidate.discovery_id});
  assert.equal(f.ids['sonos-device'].value, speaker.id);
  assert.equal(f.calls.filter(call => /\/(review|execute)$/.test(call.url)).length, 0);
});

for (const [label, change] of [
  ['lock', f => { f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); }],
  ['owner change', f => { f.emit('tli-user-changed'); f.emit('tli-session-unlocked'); }],
  ['navigation', f => f.emit('document:tli-panel-switched', {panelId: 'panel-chat'})],
  ['speaker change', f => { f.ids['sonos-device'].value = 'another_speaker'; f.ids['sonos-device'].fire('change'); }],
]) {
  test(`${label} rejects a stale discovery response and cannot enroll its choices`, async () => {
    const pending = deferred();
    const f = fixture(url => url === '/api/sonos/discover' ? pending.promise : undefined);
    f.button('Find speakers').click(); await tick(); change(f);
    pending.resolve(discovery([{...candidate, name: 'PRIVATE OLD SPEAKER'}])); await flush();
    assert.doesNotMatch(f.ids['sonos-found'].textContent, /PRIVATE OLD SPEAKER/);
    assert.equal(f.button('Add to TLI'), undefined);
    assert.equal(f.calls.filter(call => call.url === '/api/sonos/devices').length, 0);
  });

  test(`${label} while enrolling never refreshes or selects from a stale completion`, async () => {
    const pending = deferred();
    const f = fixture((url, options) => url === '/api/sonos/devices' && options.method === 'POST' ? pending.promise : undefined);
    await f.find(); f.button('Add to TLI').click(); await tick(); change(f);
    pending.resolve(response({device: {...speaker, name: 'PRIVATE OLD SPEAKER'}})); await flush();
    assert.equal(f.calls.filter(call => call.url === '/api/sonos/devices' && call.options.method === 'POST').length, 1);
    assert.equal(f.calls.filter(call => call.url === '/api/sonos/devices' && call.options.method === 'GET').length, 0);
    assert.notEqual(f.ids['sonos-device'].value, speaker.id);
    assert.doesNotMatch(f.text(), /PRIVATE OLD SPEAKER/);
  });
}

test('cleared discovery cards cannot enroll through an old retained callback', async () => {
  const f = fixture(); await f.find();
  const stale = f.button('Add to TLI'); assert(stale);
  f.window.TLISonos.clear();
  stale.fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/devices').length, 0);
  assert.equal(f.button('Add to TLI'), undefined);
});

test('expired discovery buttons stop enrollment and require a new explicit search', async () => {
  const f = fixture(); await f.find();
  const action = f.button('Add to TLI'); assert(action && !action.disabled);
  f.advanceTimers(120001);
  assert(action.disabled);
  action.fire('click'); await flush();
  assert.match(f.ids['sonos-message'].textContent, /expired/i);
  assert.equal(f.calls.length, 1);
  assert.match(f.ids['sonos-found'].textContent, /Find speakers again/);
});

test('locked controls reject a dispatched action and unlocking never starts discovery', async () => {
  const f = fixture();
  f.emit('tli-session-locked');
  assert(f.button('Find speakers').disabled);
  f.button('Find speakers').fire('click'); await flush();
  assert.equal(f.calls.length, 0);
  f.emit('tli-session-unlocked'); await flush();
  assert(!f.button('Find speakers').disabled);
  assert.equal(f.calls.length, 0);
  await f.find();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/discover').length, 1);
});

test('a failed discovery keeps retry available and never reintroduces address controls', async () => {
  const f = fixture(url => url === '/api/sonos/discover' ? response({detail: 'Discovery unavailable on this network.'}, 503) : undefined);
  await f.find();
  assert.match(f.ids['sonos-message'].textContent, /Discovery unavailable/);
  assert.equal(f.ids['sonos-ip'], null);
  assert(!f.button('Find speakers').disabled);
  assert.equal(f.calls.length, 1);
  assert.equal(f.button('Add to TLI'), undefined);
});

function playerFixture(handler = () => undefined) {
  return fixture((url, options, calls) => {
    const supplied = handler(url, options, calls);
    if (supplied) return supplied;
    if (url === '/api/sonos/devices' && options.method === 'GET') return catalog([speaker, secondSpeaker]);
    if (url.endsWith('/review')) {
      const body = JSON.parse(options.body);
      const device = url.includes(secondSpeaker.id) ? secondSpeaker : speaker;
      return response({review_id: 'review_exact_action', action: body.action, params: body.params,
        device, affected: [{name: 'Living room'}, {name: 'Kitchen'}], effect: 'Playback changes for these rooms.'});
    }
    if (url === '/api/sonos/execute') return response({outcome: 'confirmed', summary: 'Playback confirmed.', observed: {playback: 'PLAYING'}});
    if (url.endsWith('/favorites')) return response({items: [{id: 'favorite_jazz', name: 'Morning jazz'}]});
    if (url === '/api/sonos/receipts') return response({receipts: [{checked_at: '2026-10-15', action: 'play', outcome: 'confirmed', summary: 'Playback confirmed.'}]});
    if (url.endsWith('/status')) {
      const device = url.includes(secondSpeaker.id) ? secondSpeaker : speaker;
      return response({device, reading: {playback: 'PAUSED_PLAYBACK', volume: 8, muted: false, title: 'Morning jazz'},
        group: {coordinator: device.uid, members: [{uid: device.uid, name: device.name, bonded: false}]},
        clip_support: {state: 'unsupported'}, checked_at: '2026-10-15'});
    }
  });
}

async function chooseFavorite(f) {
  await f.click('Favorites');
  f.ids['sonos-favorite'].value = 'favorite_jazz'; f.ids['sonos-favorite'].fire('change');
  await f.click('Play favorite');
}

test('selecting a room reveals its player with unique model labels and the saved volume ceiling', async () => {
  const f = playerFixture(); await f.enter();
  const options = f.ids['sonos-device'].children.filter(node => node.value);
  assert.deepEqual(options.map(node => node.value), [speaker.id, secondSpeaker.id]);
  assert.match(options[0].textContent, /Living room.*Beam/);
  assert.match(options[1].textContent, /Living room.*Play:1/);
  await f.select();
  assert.equal(f.ids['sonos-player'].hidden, false);
  assert.equal(f.ids['sonos-volume'].type, 'range');
  assert.equal(Number(f.ids['sonos-volume'].max), 35);
  f.ids['sonos-volume'].value = '30';
  await f.select(secondSpeaker.id);
  assert.equal(Number(f.ids['sonos-volume'].max), 12);
  assert(Number(f.ids['sonos-volume'].value) <= 12);
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 0);
  await f.click('Refresh status');
  assert.equal(f.calls.find(call => call.url.endsWith('/status')).url, `/api/sonos/devices/${secondSpeaker.id}/status`);
  assert.equal(Number(f.ids['sonos-volume'].max), 12);
  await f.select('');
  assert.equal(f.ids['sonos-player'].hidden, true);
});

test('identical room names and models retain distinct saved speaker labels and identities', async () => {
  const twins = [{...speaker, id: 'speaker_111111'}, {...speaker, id: 'speaker_222222', uid: 'RINCON_FIXTURE_TWIN'}];
  const f = fixture((url, options) => url === '/api/sonos/devices' && options.method === 'GET' ? catalog(twins) : undefined);
  await f.enter();
  const options = f.ids['sonos-device'].children.filter(node => node.value);
  assert.equal(options.length, 2);
  assert.notEqual(options[0].textContent, options[1].textContent);
  assert.match(options[0].textContent, /Living room.*Beam.*111111/);
  assert.match(options[1].textContent, /Living room.*Beam.*222222/);
  await f.select(twins[1].id);
  assert.equal(f.ids['sonos-device'].value, twins[1].id);
  assert.match(f.ids['sonos-room-model'].textContent, /222222/);
  assert.equal(f.calls.length, 1);
});

for (const label of ['Spotify Connect', 'AirPlay', 'Music service', '<img src=x onerror=alert(1)>']) {
  test(`current source label is rendered as text: ${label}`, async () => {
    const f = playerFixture(url => url.endsWith('/status') ? response({device: speaker,
      reading: {playback: 'PAUSED_PLAYBACK', source: {kind: 'external', label, external: true}}}) : undefined);
    await f.enter(); await f.select(); await f.click('Refresh status');
    const sourceLabel = f.ids['sonos-status'].querySelector('.sonos-source');
    assert.equal(sourceLabel.textContent, 'Source: ' + label);
    assert.equal(sourceLabel.children.length, 0, 'Source names must not create HTML elements');
    assert.equal(f.ids['sonos-status'].querySelector('.sonos-playback').textContent, 'Paused');
    assert.equal(f.ids['sonos-status'].querySelector('.sonos-track').textContent, 'Track information unavailable');
    await f.select(secondSpeaker.id);
    assert.equal(f.ids['sonos-status'].querySelector('.sonos-source'), null, 'Changing rooms clears the previous source');
  });
}

test('an accepted Play command that is observed paused stays visibly paused', async () => {
  const summary = 'Sonos acknowledged Play, but the selected source is still paused.';
  const f = playerFixture(url => url === '/api/sonos/execute' ? response({ok: true, outcome: 'accepted', summary,
    observed: {playback: 'PAUSED_PLAYBACK', title: 'Current Spotify track',
      source: {kind: 'spotify_connect', label: 'Spotify Connect', external: true}}}) : undefined);
  await f.enter(); await f.select(); await f.click('Play');
  assert.equal(f.ids['sonos-status'].querySelector('.sonos-playback').textContent, 'Paused');
  assert.equal(f.ids['sonos-status'].querySelector('.sonos-source').textContent, 'Source: Spotify Connect');
  assert.equal(f.ids['sonos-message'].textContent, summary);
  assert.doesNotMatch(f.ids['sonos-status'].textContent, /Playing/);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
});

test('player extras stay hidden until requested and reading them never controls speakers', async () => {
  const f = playerFixture(); await f.enter(); await f.select();
  for (const id of ['sonos-favorite', 'sonos-destination', 'sonos-receipts']) {
    assert(f.ids[id], `${id} is available on demand`);
    assert.equal(f.visible(f.ids[id]), false);
  }
  assert.equal(f.calls.length, 1);
  await f.click('Favorites');
  assert.equal(f.visible(f.ids['sonos-favorite']), true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/favorites')).length, 1);
  assert.match(f.ids['sonos-favorite'].textContent, /Morning jazz/);
  await f.click('Favorites');
  assert.equal(f.visible(f.ids['sonos-favorite']), false);
  await f.click('Group rooms');
  assert.equal(f.visible(f.ids['sonos-destination']), true);
  await f.click('Recent activity');
  assert.equal(f.visible(f.ids['sonos-receipts']), true);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/receipts').length, 1);
  assert.equal(f.calls.filter(call => call.options.method !== 'GET').length, 0);
});

for (const [label, action, params] of [
  ['Play', 'play', {}], ['Pause', 'pause', {}], ['Stop', 'stop', {}],
  ['Next', 'next', {}], ['Previous', 'previous', {}],
  ['Apply volume', 'volume', {volume: 20}], ['Mute', 'mute', {muted: true}], ['Unmute', 'mute', {muted: false}],
]) {
  test(`${label} prepares and executes the exact action with one click and no confirmation`, async () => {
    const pending = deferred();
    const f = playerFixture(url => url === '/api/sonos/execute' ? pending.promise : undefined);
    await f.enter(); await f.select();
    const priorStatus = f.ids['sonos-status'].textContent;
    await f.click(label);
    const commands = f.calls.filter(call => /\/(review|execute)$/.test(call.url));
    assert.deepEqual(commands.map(call => [call.options.method, call.url]), [
      ['POST', `/api/sonos/devices/${speaker.id}/review`], ['POST', '/api/sonos/execute'],
    ]);
    assert.deepEqual(JSON.parse(commands[0].options.body), {action, params});
    const body = JSON.parse(commands[1].options.body);
    assert.equal(body.review_id, 'review_exact_action');
    assert.match(body.request_id, /^request-/);
    assert.equal(f.ids['sonos-confirmation'].hidden, true);
    assert.equal(f.ids['sonos-status'].textContent, priorStatus, 'Sending a command is not verified playback');
    pending.resolve(response({outcome: 'confirmed', summary: 'Playback confirmed.', observed: {playback: 'PLAYING'}})); await flush();
    assert.equal(f.ids['sonos-confirmation'].hidden, true);
    f.ids['sonos-run'].fire('click'); await flush();
    assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
  });
}

test('rapid clicks cannot duplicate preparation or execution while either response is pending', async () => {
  const preparing = deferred(), executing = deferred();
  const f = playerFixture(url => url.endsWith('/review') ? preparing.promise : url === '/api/sonos/execute' ? executing.promise : undefined);
  await f.enter(); await f.select();
  f.button('Play').click(); await tick();
  f.button('Play').fire('click'); f.button('Pause').fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  preparing.resolve(response({review_id: 'one_play', action: 'play', params: {}, device: speaker,
    affected: [{name: speaker.name}], effect: 'Playback changes.'})); await flush();
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  f.button('Play').fire('click'); f.button('Pause').fire('click'); f.ids['sonos-run'].fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
  executing.resolve(response({outcome: 'confirmed', summary: 'Playback confirmed.'})); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
});

test('Cancel and a failed review leave no executable confirmation', async () => {
  let fail = false;
  const f = playerFixture(url => url.endsWith('/review') && fail ? response({detail: 'Speaker state changed. Refresh it.'}, 409) : undefined);
  await f.enter(); await f.select(); await chooseFavorite(f);
  assert.equal(f.ids['sonos-confirmation'].hidden, false);
  await f.click('Cancel');
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  f.ids['sonos-run'].fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  await f.click('Play favorite');
  assert.equal(f.ids['sonos-confirmation'].hidden, false);
  fail = true; await f.click('Play');
  assert.match(f.ids['sonos-message'].textContent, /Speaker state changed/);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert(f.ids['sonos-run'].disabled);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  const reviewCount = f.calls.filter(call => call.url.endsWith('/review')).length;
  f.advanceTimers(120001); f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); await flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, reviewCount);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
});

for (const [label, change] of [
  ['room change', f => { f.ids['sonos-device'].value = secondSpeaker.id; f.ids['sonos-device'].fire('change'); }],
  ['lock and unlock', f => { f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); }],
  ['owner change', f => { f.emit('tli-user-changed'); f.emit('tli-session-unlocked'); }],
  ['navigation', f => f.emit('document:tli-panel-switched', {panelId: 'panel-chat'})],
]) {
  test(`${label} during preparation prevents automatic playback and stale disclosure`, async () => {
    const pending = deferred();
    const f = playerFixture(url => url.endsWith('/review') ? pending.promise : undefined);
    await f.enter(); await f.select();
    f.button('Play').click(); await tick(); change(f);
    pending.resolve(response({review_id: 'old_room_review', action: 'play', params: {}, device: speaker,
      affected: [{name: 'OLD PRIVATE ROOM'}], effect: 'Old room playback'})); await flush();
    assert.equal(f.ids['sonos-confirmation'].hidden, true);
    assert.doesNotMatch(f.text(), /OLD PRIVATE ROOM/);
    f.ids['sonos-run'].fire('click'); f.advanceTimers(120001); await flush();
    assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
    assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  });
}

test('uncertain immediate playback is submitted once and never automatically replayed', async () => {
  const f = playerFixture(url => url === '/api/sonos/execute' ? response({detail: 'Delivery uncertain. Read recent activity.'}, 503) : undefined);
  await f.enter(); await f.select(); await f.click('Play');
  assert.match(f.ids['sonos-message'].textContent, /Delivery uncertain/);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  f.ids['sonos-run'].fire('click'); f.advanceTimers(120001); await flush();
  f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); await flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
});

test('a preparation response arriving after the request timeout cannot start playback', async () => {
  const pending = deferred();
  const f = playerFixture(url => url.endsWith('/review') ? pending.promise : undefined);
  await f.enter(); await f.select();
  f.button('Play').click(); await tick();
  f.advanceTimers(45001);
  assert.equal(f.calls.find(call => call.url.endsWith('/review')).options.signal.aborted, true);
  pending.resolve(response({review_id: 'expired_request', action: 'play', params: {}, device: speaker,
    affected: [{name: speaker.name}], effect: 'Playback changes.'})); await flush();
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
});

test('expired confirmation requires a fresh action review before any command can execute', async () => {
  const f = playerFixture((url, options) => {
    if (url.endsWith('/review')) return response({review_id: 'review_short_expiry', ...JSON.parse(options.body),
      device: speaker, affected: [{name: speaker.name}], effect: 'Room playback changes.', expires_at: Date.now() / 1000 + 2});
  });
  await f.enter(); await f.select(); await chooseFavorite(f);
  assert.equal(f.ids['sonos-confirmation'].hidden, false);
  // Backend expiry uses Unix seconds, not an ISO date or milliseconds.
  f.advanceTimers(2100);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert.match(f.ids['sonos-message'].textContent, /Confirmation expired/);
  f.ids['sonos-run'].fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  await f.click('Play favorite'); await f.click('Confirm');
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 2);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
});

test('an already submitted confirmation is not relabeled expired while its response is pending', async () => {
  const pending = deferred();
  const f = playerFixture((url, options) => {
    if (url.endsWith('/review')) return response({review_id: 'review_near_expiry', ...JSON.parse(options.body),
      device: speaker, affected: [{name: speaker.name}], effect: 'Room playback changes.', expires_at: Date.now() / 1000 + 2});
    if (url === '/api/sonos/execute') return pending.promise;
  });
  await f.enter(); await f.select(); await chooseFavorite(f);
  f.button('Confirm').click(); await tick();
  f.advanceTimers(2100);
  assert.doesNotMatch(f.ids['sonos-message'].textContent, /expired/i);
  pending.resolve(response({outcome: 'confirmed', summary: 'Playback confirmed.', observed: {playback: 'PLAYING'}})); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
});

test('moving the volume slider invalidates the previous confirmation before applying a new value', async () => {
  const f = playerFixture(); await f.enter(); await f.select(); await chooseFavorite(f);
  f.ids['sonos-volume'].value = '11'; f.ids['sonos-volume'].fire('input');
  assert.equal(f.ids['sonos-volume-value'].textContent, '11');
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  f.ids['sonos-run'].fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  await f.click('Apply volume');
  const reviews = f.calls.filter(call => call.url.endsWith('/review'));
  assert.deepEqual(JSON.parse(reviews.at(-1).options.body), {action: 'volume', params: {volume: 11}});
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
});

test('a late review cannot restore confirmation after the requested volume changes', async () => {
  const pending = deferred();
  const f = playerFixture(url => url.endsWith('/review') ? pending.promise : undefined);
  await f.enter(); await f.select();
  f.button('Apply volume').click(); await tick();
  f.ids['sonos-volume'].value = '9'; f.ids['sonos-volume'].fire('input');
  pending.resolve(response({review_id: 'old_volume', action: 'volume', params: {volume: 20},
    device: speaker, affected: [{name: 'OLD VOLUME REQUEST'}], effect: 'Volume changes.'})); await flush();
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert.doesNotMatch(f.ids['sonos-confirmation'].textContent, /OLD VOLUME REQUEST/);
  f.ids['sonos-run'].fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
});

test('volume input alone sends nothing, Apply executes its bounded value, and favorites still require confirmation', async () => {
  const f = playerFixture(); await f.enter(); await f.select(secondSpeaker.id);
  f.ids['sonos-volume'].value = '9'; f.ids['sonos-volume'].fire('input');
  assert.equal(f.calls.filter(call => call.options.method !== 'GET').length, 0);
  await f.click('Apply volume');
  let reviews = f.calls.filter(call => call.url.endsWith('/review'));
  assert.deepEqual(JSON.parse(reviews[0].options.body), {action: 'volume', params: {volume: 9}});
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
  await chooseFavorite(f);
  reviews = f.calls.filter(call => call.url.endsWith('/review'));
  assert.deepEqual(JSON.parse(reviews[1].options.body), {action: 'favorite', params: {favorite_id: 'favorite_jazz', replace_queue: true}});
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
  assert.equal(f.ids['sonos-confirmation'].hidden, false);
  assert.match(f.ids['sonos-confirmation'].textContent, /Living room/);
  assert.match(f.ids['sonos-confirmation'].textContent, /Kitchen/);
  assert.equal(f.ids['sonos-run'].textContent, 'Confirm');
  await f.click('Confirm');
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 2);
});

test('Done hides discovery and invalidates an old card callback', async () => {
  const f = fixture(); await f.find();
  const stale = f.button('Add to TLI'); assert(stale);
  assert(f.visible(f.ids['sonos-found']));
  await f.click('Done');
  assert.equal(f.visible(f.ids['sonos-found']), false);
  stale.fire('click'); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/devices' && call.options.method === 'POST').length, 0);
});

test('removing a saved speaker is contextual and requires Confirm without sending music commands', async () => {
  let removed = false;
  const f = playerFixture((url, options) => {
    if (url === `/api/sonos/devices/${speaker.id}` && options.method === 'DELETE') {
      removed = true; return response({removed: speaker.id});
    }
    if (url === '/api/sonos/devices' && options.method === 'GET') return catalog(removed ? [] : [speaker]);
  });
  await f.enter(); await f.select();
  assert.equal(f.visible(f.button('Remove speaker from TLI')), false);
  await f.click('Recent activity'); await f.click('Remove speaker from TLI');
  assert.equal(f.ids['sonos-confirmation'].hidden, false);
  assert.equal(f.calls.filter(call => call.options.method === 'DELETE').length, 0);
  await f.click('Cancel');
  assert.equal(removed, false);
  await f.click('Remove speaker from TLI'); await f.click('Confirm');
  assert.equal(f.calls.filter(call => call.options.method === 'DELETE').length, 1);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  assert.equal(f.ids['sonos-player'].hidden, true);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
});

const rearSpeaker = {id: 'speaker_rear', uid: 'RINCON_FIXTURE_REAR', name: 'Rear left', room: 'Living room', model: 'Play:1', volume_cap: 25};
const topologyMember = (device, extra = {}) => ({uid: device.uid, device_id: device.id, name: device.name,
  room: device.room, model: device.model, bonded: false, parent_uid: null, bond_source: null, ...extra});
const observedTopology = () => ({checked_at: '2026-10-15T14:25:00Z', groups: [
  {coordinator: speaker.uid, member_count: 2, complete: true, members: [topologyMember(speaker, {bonded: true, bond_source: 'satellite_parent'}),
    topologyMember(rearSpeaker, {bonded: true, parent_uid: speaker.uid, bond_source: 'satellite'})]},
  {coordinator: secondSpeaker.uid, member_count: 1, complete: true, members: [topologyMember(secondSpeaker)]},
]});
const statusWithTopology = (topology = observedTopology(), extra = {}) => response({device: speaker,
  checked_at: topology?.checked_at || '2026-10-15T14:25:00Z', reading: {playback: 'PLAYING', title: 'Fixture music', volume: 10, muted: false},
  group: {coordinator: speaker.uid, members: [{uid: speaker.uid, name: speaker.name}]},
  clip_support: {state: 'unsupported'}, topology, ...extra});
function topologyFixture(handler = () => undefined) {
  return playerFixture((url, options, calls) => {
    const supplied = handler(url, options, calls);
    if (supplied) return supplied;
    if (url === '/api/sonos/devices' && options.method === 'GET') return catalog([speaker, secondSpeaker, rearSpeaker]);
    if (url.endsWith('/status')) return statusWithTopology();
    if (url.endsWith('/review')) return response({review_id: 'review_group_fixture', ...JSON.parse(options.body), device: speaker,
      affected: [{uid: speaker.uid, name: speaker.name}, {uid: rearSpeaker.uid, name: rearSpeaker.name}],
      effect: 'The reported rooms are affected.', topology: observedTopology()});
  });
}
function topologyState(f) { return f.ids['sonos-topology'].getAttribute('data-state'); }
function memberNode(f, uid) { return f.ids['sonos-topology-content'].querySelectorAll('[data-uid]').find(node => node.dataset.uid === uid); }
function nestedWithin(child, ancestor) { for (let node = child?.parentNode; node; node = node.parentNode) if (node === ancestor) return true; return false; }

test('topology starts unknown and only Refresh group reads actual membership and coordinator identity', async () => {
  const f = topologyFixture(); await f.enter(); await f.select();
  assert.equal(topologyState(f), 'unknown');
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 0);
  assert.equal(f.ids['sonos-group-refresh'].textContent, 'Refresh group');
  await f.click('Refresh group');
  assert.equal(topologyState(f), 'current');
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 1);
  const selected = memberNode(f, speaker.uid), separate = memberNode(f, secondSpeaker.uid);
  assert(selected && separate, 'Both explicitly observed groups are present');
  assert.match(selected.textContent, /Beam \(Gen 1\)/);
  assert.match(selected.textContent, /selected/i);
  assert.match(selected.textContent, /group leader|coordinator/i);
  assert.match(separate.textContent, /Play:1/);
  assert.match(separate.textContent, /group leader|coordinator/i);
  const cards = f.ids['sonos-topology-content'].querySelectorAll('.sonos-group-card');
  assert.equal(cards.find(card => card.dataset.coordinator === speaker.uid).dataset.selected, 'true');
  assert.equal(cards.find(card => card.dataset.coordinator === secondSpeaker.uid).dataset.selected, 'false');
  assert.equal(nestedWithin(separate, selected), false, 'Same room names cannot merge separate groups');
  assert.match(f.ids['sonos-scope'].textContent, /playback|music|transport/i);
  assert.match(f.ids['sonos-scope'].textContent, /group/i);
  assert.match(f.ids['sonos-scope'].textContent, /volume/i);
  assert.match(f.ids['sonos-scope'].textContent, /each room.*volume.*group together/i);
});

test('only a reported bonded parent creates a nested speaker relationship', async () => {
  const f = topologyFixture(); await f.enter(); await f.select(); await f.click('Refresh group');
  const parent = memberNode(f, speaker.uid), rear = memberNode(f, rearSpeaker.uid);
  assert(parent && rear);
  assert.equal(nestedWithin(rear, parent), true);
  assert.match(rear.textContent, /bonded|satellite|surround/i);
  assert.match(rear.textContent, /Play:1/);
  assert.equal(nestedWithin(memberNode(f, secondSpeaker.uid), parent), false);
});

test('invisible and unlocated bonded members never acquire an inferred parent or model', async () => {
  const invisible = {uid: 'RINCON_MANAGED', device_id: 'speaker_managed', name: 'Living room managed', room: '', model: 'Sonos',
    bonded: true, parent_uid: null, bond_source: 'invisible'};
  const unlocated = topologyMember(rearSpeaker, {bonded: true, parent_uid: 'RINCON_UNAVAILABLE_PARENT', bond_source: 'satellite'});
  const topology = {checked_at: '2026-10-15T14:25:00Z', groups: [{coordinator: speaker.uid, member_count: 3,
    complete: true, members: [topologyMember(speaker), invisible, unlocated]}]};
  const f = topologyFixture(url => url.endsWith('/status') ? statusWithTopology(topology) : undefined);
  await f.enter(); await f.select(); await f.click('Refresh group');
  const parent = memberNode(f, speaker.uid), managed = memberNode(f, invisible.uid), rear = memberNode(f, rearSpeaker.uid);
  assert(managed && rear);
  assert.equal(nestedWithin(managed, parent), false);
  assert.equal(nestedWithin(rear, parent), false);
  assert.match(managed.textContent, /Sonos.managed/i);
  assert.doesNotMatch(managed.textContent, /bonded|stereo|surround/i);
  assert.doesNotMatch(managed.textContent, /Beam|Play:1/);
});

test('incomplete observed groups disclose omitted members without inventing their identities', async () => {
  const topology = {checked_at: '2026-10-15T14:25:00Z', groups: [{coordinator: null, member_count: 3,
    complete: false, members: [topologyMember(speaker)]}]};
  const f = topologyFixture(url => url.endsWith('/status') ? statusWithTopology(topology, {
    group: {coordinator: 'RINCON_NOT_ENROLLED', members: [{uid: 'RINCON_NOT_ENROLLED', name: 'UNVERIFIED PRIVATE ROOM'}]},
  }) : undefined);
  await f.enter(); await f.select(); await f.click('Refresh group');
  const pane = f.ids['sonos-topology-content'];
  assert.equal(pane.querySelectorAll('[data-uid]').length, 1);
  assert.equal(memberNode(f, 'RINCON_NOT_ENROLLED'), undefined);
  assert.doesNotMatch(pane.textContent, /UNVERIFIED PRIVATE ROOM/);
  assert.match(pane.textContent, /incomplete|not shown|not visible|not added|not verified|unavailable|limited/i);
  assert.doesNotMatch(memberNode(f, speaker.uid).textContent, /coordinator|group leader/i);
});

test('older status payloads cannot manufacture topology from matching names or legacy group fields', async () => {
  const f = playerFixture(); await f.enter(); await f.select(); await f.click('Refresh group');
  assert.equal(topologyState(f), 'unknown');
  assert.equal(f.ids['sonos-topology-content'].querySelectorAll('[data-uid]').length, 0);
  assert.equal(f.ids['sonos-device'].children.filter(option => option.value).length, 2);
});

test('a failed group refresh keeps prior evidence visibly stale and initial failure remains unknown', async () => {
  let reads = 0;
  const f = topologyFixture(url => url.endsWith('/status') && ++reads > 1 ? response({detail: 'Speaker offline'}, 503) : undefined);
  await f.enter(); await f.select(); await f.click('Refresh group');
  assert.equal(topologyState(f), 'current');
  await f.click('Refresh group');
  assert.equal(topologyState(f), 'stale');
  assert(memberNode(f, rearSpeaker.uid));
  assert.match(f.ids['sonos-topology'].textContent, /last.known|last.checked|stale|not.current|could.not/i);
  const fresh = topologyFixture(url => url.endsWith('/status') ? response({detail: 'Speaker offline'}, 503) : undefined);
  await fresh.enter(); await fresh.select(); await fresh.click('Refresh group');
  assert.equal(topologyState(fresh), 'unknown');
  assert.equal(fresh.ids['sonos-topology-content'].querySelectorAll('[data-uid]').length, 0);
});

test('successful playback changes retain group evidence as last known until explicit refresh', async () => {
  const f = topologyFixture(); await f.enter(); await f.select(); await f.click('Refresh group');
  await f.click('Play');
  assert.equal(topologyState(f), 'stale');
  assert(memberNode(f, speaker.uid) && memberNode(f, rearSpeaker.uid));
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 1);
  assert.match(f.ids['sonos-topology'].textContent, /last.known|last.checked|stale|refresh/i);
  await f.click('Refresh group');
  assert.equal(topologyState(f), 'current');
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 2);
});

test('review topology identifies its limited scope and remains evidence after confirmation is cancelled', async () => {
  const subset = observedTopology(); subset.groups = subset.groups.slice(0, 1); subset.checked_at = '2026-10-15T14:26:00Z';
  const f = topologyFixture((url, options) => url.endsWith('/review') ? response({review_id: 'scoped_review', ...JSON.parse(options.body),
    device: speaker, affected: [{uid: speaker.uid, name: speaker.name}], effect: 'Selected group playback changes.', topology: subset}) : undefined);
  await f.enter(); await f.select(); await f.click('Refresh group');
  assert(memberNode(f, secondSpeaker.uid));
  await chooseFavorite(f);
  assert.equal(topologyState(f), 'current');
  assert.equal(memberNode(f, secondSpeaker.uid), undefined);
  assert.match(f.ids['sonos-topology-note'].textContent, /groups checked for this action/i);
  await f.click('Cancel');
  f.ids['sonos-volume'].value = '11'; f.ids['sonos-volume'].fire('input');
  assert.equal(topologyState(f), 'current');
  assert(memberNode(f, rearSpeaker.uid));
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  await f.click('Refresh group');
  assert(memberNode(f, secondSpeaker.uid));
  assert.doesNotMatch(f.ids['sonos-topology-note'].textContent, /groups checked for this action/i);
});

test('a group action never predicts a new joined topology from the requested target', async () => {
  const ordinary = {checked_at: '2026-10-15T14:25:00Z', groups: [
    {coordinator: speaker.uid, member_count: 1, complete: true, members: [topologyMember(speaker)]},
    {coordinator: secondSpeaker.uid, member_count: 1, complete: true, members: [topologyMember(secondSpeaker)]},
  ]};
  const f = topologyFixture((url, options) => {
    if (url.endsWith('/status')) return statusWithTopology(ordinary);
    if (url.endsWith('/review')) return response({review_id: 'ordinary_join', ...JSON.parse(options.body), device: speaker,
      affected: [{uid: speaker.uid, name: speaker.name}, {uid: secondSpeaker.uid, name: secondSpeaker.name}],
      effect: 'These ordinary rooms will play together.', topology: ordinary});
  });
  await f.enter(); await f.select();
  assert(f.ids['sonos-join'].disabled, 'An unchecked group cannot be changed');
  await f.click('Refresh group');
  await f.click('Group rooms');
  f.ids['sonos-destination'].value = secondSpeaker.id; f.ids['sonos-destination'].fire('change');
  assert(!f.ids['sonos-join'].disabled);
  await f.click('Join group');
  assert.equal(f.ids['sonos-confirmation'].hidden, false);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  await f.click('Confirm');
  const reviewed = f.calls.find(call => call.url.endsWith('/review'));
  assert.deepEqual(JSON.parse(reviewed.options.body), {action: 'join', params: {target_id: secondSpeaker.id}});
  assert.equal(topologyState(f), 'stale');
  assert.equal(nestedWithin(memberNode(f, secondSpeaker.uid), memberNode(f, speaker.uid)), false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 1);
  assert(f.ids['sonos-join'].disabled && f.ids['sonos-leave'].disabled, 'Last-known groups require a fresh read before another group change');
  await f.click('Refresh group');
  assert(!f.ids['sonos-join'].disabled);
});

test('leaving an ordinary group still requires confirmation before changing the speakers', async () => {
  const ordinary = {checked_at: '2026-10-15T14:25:00Z', groups: [
    {coordinator: speaker.uid, member_count: 2, complete: true, members: [topologyMember(speaker), topologyMember(secondSpeaker)]},
  ]};
  const f = topologyFixture((url, options) => {
    if (url.endsWith('/status')) return statusWithTopology(ordinary);
    if (url.endsWith('/review')) return response({review_id: 'ordinary_leave', ...JSON.parse(options.body), device: speaker,
      affected: [{uid: speaker.uid, name: speaker.name}, {uid: secondSpeaker.uid, name: secondSpeaker.name}],
      effect: 'The selected speaker leaves this group.', topology: ordinary});
  });
  await f.enter(); await f.select(); await f.click('Refresh group'); await f.click('Group rooms');
  await f.click('Leave group');
  const reviewed = f.calls.find(call => call.url.endsWith('/review'));
  assert.deepEqual(JSON.parse(reviewed.options.body), {action: 'leave', params: {}});
  assert.equal(f.ids['sonos-confirmation'].hidden, false);
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 0);
  await f.click('Confirm');
  assert.equal(f.calls.filter(call => call.url === '/api/sonos/execute').length, 1);
  assert.equal(topologyState(f), 'stale');
  assert(memberNode(f, speaker.uid) && memberNode(f, secondSpeaker.uid), 'A command cannot predict the resulting group');
});

test('bonded groups stay visible but cannot be joined or separated through ordinary grouping controls', async () => {
  const f = topologyFixture(); await f.enter(); await f.select(); await f.click('Refresh group');
  await f.click('Group rooms');
  f.ids['sonos-destination'].value = secondSpeaker.id; f.ids['sonos-destination'].fire('change');
  assert(f.ids['sonos-join'].disabled);
  assert(f.ids['sonos-leave'].disabled);
  assert.match(f.ids['sonos-group-guidance'].textContent, /bonded|Sonos.managed/i);
  assert.match(f.ids['sonos-group-guidance'].textContent, /Sonos app/i);
  f.ids['sonos-join'].click(); f.ids['sonos-leave'].click(); await flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/review') || call.url.endsWith('/execute')).length, 0);
  assert.match(memberNode(f, speaker.uid).textContent, /Bonded set/);
});

test('room changes and lock erase previous topology rather than reuse it for another selection', async () => {
  const f = topologyFixture(); await f.enter(); await f.select(); await f.click('Refresh group');
  assert(memberNode(f, rearSpeaker.uid));
  await f.select(secondSpeaker.id);
  assert.equal(topologyState(f), 'unknown');
  assert.equal(f.ids['sonos-topology-content'].querySelectorAll('[data-uid]').length, 0);
  assert.doesNotMatch(f.ids['sonos-topology'].textContent, /Rear left/);
  f.emit('tli-session-locked');
  assert.equal(topologyState(f), 'unknown');
  assert.doesNotMatch(f.ids['sonos-topology'].textContent, /Living room|Rear left|Beam|Play:1/);
});

test('a late group reading cannot populate topology after the selected room changes', async () => {
  const pending = deferred();
  const f = topologyFixture(url => url.endsWith('/status') ? pending.promise : undefined);
  await f.enter(); await f.select(); f.button('Refresh group').click(); await tick();
  await f.select(secondSpeaker.id);
  pending.resolve(statusWithTopology()); await flush();
  assert.equal(topologyState(f), 'unknown');
  assert.equal(f.ids['sonos-topology-content'].querySelectorAll('[data-uid]').length, 0);
  assert.equal(f.ids['sonos-device'].value, secondSpeaker.id);
});

const volumeOffice = {...secondSpeaker, name: 'Office'};
const volumeTopology = () => ({checked_at: '2026-10-16T14:25:00Z', groups: [
  {coordinator: speaker.uid, member_count: 3, complete: true, members: [topologyMember(speaker),
    topologyMember(rearSpeaker, {bonded: true, parent_uid: speaker.uid, bond_source: 'satellite'}), topologyMember(volumeOffice)]},
]});
const initialRoomVolumes = () => [
  {device_id: speaker.id, uid: speaker.uid, name: speaker.name, volume: 10, muted: false, volume_cap: 35},
  {device_id: volumeOffice.id, uid: volumeOffice.uid, name: volumeOffice.name, volume: 8, muted: false, volume_cap: 12},
];
const volumeStatus = (rooms = initialRoomVolumes(), extra = {}) => statusWithTopology(volumeTopology(), {
  volume_controls: {rooms, group: {volume: Math.round(rooms.reduce((sum, row) => sum + row.volume, 0) / rooms.length), max: 12}}, ...extra,
});
function volumeFixture(handler = () => undefined) {
  let rooms = initialRoomVolumes(), reviewed;
  return playerFixture((url, options, calls) => {
    const supplied = handler(url, options, calls);
    if (supplied) return supplied;
    if (url === '/api/sonos/devices' && options.method === 'GET') return catalog([speaker, volumeOffice, rearSpeaker]);
    if (url.endsWith('/status')) return volumeStatus(rooms);
    if (url.endsWith('/review')) {
      const device = url.includes(volumeOffice.id) ? volumeOffice : speaker;
      reviewed = {...JSON.parse(options.body), device};
      return response({review_id: 'volume_review', ...reviewed, affected: [{name: device.name}], topology: volumeTopology(), effect: 'Volume changes.'});
    }
    if (url === '/api/sonos/execute') {
      if (reviewed.action === 'group_volume') {
        const average = Math.round(rooms.reduce((sum, row) => sum + row.volume, 0) / rooms.length);
        rooms = rooms.map(row => ({...row, volume: row.volume + reviewed.params.volume - average}));
      } else rooms = rooms.map(row => row.device_id !== reviewed.device.id ? row : {
        ...row, ...(reviewed.action === 'volume' ? {volume: reviewed.params.volume} : {muted: reviewed.params.muted}),
      });
      return response({ok: true, outcome: 'accepted', summary: 'Sonos acknowledged the volume change.', observed: {playback: 'PLAYING'}});
    }
  });
}
const volumeRows = f => f.ids['sonos-room-volumes'].querySelectorAll('.sonos-volume-row').filter(row => row.dataset.volumeDevice);
const roomRange = (f, device = speaker) => f.ids['sonos-volume-' + device.id];
const roomMute = (f, label) => f.ids['sonos-room-volumes'].querySelectorAll('button').find(button => button.getAttribute('aria-label') === label);
const volumeCommands = f => f.calls.filter(call => /\/(review|execute)$/.test(call.url));
async function openRoomVolumes(f) { await f.enter(); await f.select(); await f.click('Refresh status'); }
async function changeRange(slider, value) { slider.value = String(value); slider.fire('input'); slider.fire('change'); await flush(); }

test('checked room volumes show independent ceilings, accessible controls and no separate satellite slider', async () => {
  const f = volumeFixture(); await f.enter(); await f.select();
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 0, 'Selection never contacts speakers');
  assert.equal(f.visible(f.ids['sonos-volume']), true, 'Legacy controls remain available before a current volume read');
  await f.click('Refresh status');
  assert.deepEqual(volumeRows(f).map(row => row.dataset.volumeDevice), [speaker.id, volumeOffice.id]);
  assert.equal(f.ids['sonos-volume-' + rearSpeaker.id], null, 'Bonded satellites are not independent room controls');
  assert.equal(f.visible(f.ids['sonos-volume']), false);
  for (const label of ['Apply volume', 'Mute', 'Unmute']) assert.equal(f.visible(f.button(label)), false);
  for (const [device, value, ceiling] of [[speaker, 10, 35], [volumeOffice, 8, 12]]) {
    const slider = roomRange(f, device);
    assert.equal(slider.type, 'range'); assert.equal(Number(slider.value), value); assert.equal(Number(slider.max), ceiling);
    assert(slider.getAttribute('aria-label') || f.all().some(node => node.tag === 'label' && node.getAttribute('for') === slider.id), 'Every room range is labeled');
    assert(roomMute(f, 'Mute ' + device.name), 'Each mute button names its room');
  }
  assert.equal(Number(f.ids['sonos-group-volume'].value), 9);
  assert.equal(Number(f.ids['sonos-group-volume'].max), 12, 'Group volume uses the server-provided safe ceiling');
  assert.equal(volumeCommands(f).length, 0);
});

test('individual slider input stays local and committing targets that room then rereads all volumes', async () => {
  const f = volumeFixture(); await openRoomVolumes(f);
  const slider = roomRange(f, volumeOffice);
  slider.value = '11'; slider.fire('input'); await flush();
  assert.equal(volumeCommands(f).length, 0);
  const office = volumeRows(f).find(row => row.dataset.volumeDevice === volumeOffice.id);
  assert.match(office.textContent, /11/);
  slider.fire('change'); await flush();
  const commands = volumeCommands(f);
  assert.deepEqual(commands.map(call => call.url), [`/api/sonos/devices/${volumeOffice.id}/review`, '/api/sonos/execute']);
  assert.deepEqual(JSON.parse(commands[0].options.body), {action: 'volume', params: {volume: 11}});
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 2, 'A read-only status request refreshes every room after acknowledgement');
  assert.equal(Number(roomRange(f, volumeOffice).value), 11);
  assert.equal(Number(roomRange(f).value), 10, 'Changing Office volume leaves Living room volume alone');
});

test('group volume commits one bounded group command then shows fresh room readings', async () => {
  const f = volumeFixture(); await openRoomVolumes(f);
  await changeRange(f.ids['sonos-group-volume'], 11);
  const commands = volumeCommands(f);
  assert.deepEqual(commands.map(call => call.url), [`/api/sonos/devices/${speaker.id}/review`, '/api/sonos/execute']);
  assert.deepEqual(JSON.parse(commands[0].options.body), {action: 'group_volume', params: {volume: 11}});
  assert.equal(Number(roomRange(f).value), 12); assert.equal(Number(roomRange(f, volumeOffice).value), 10);
  assert.equal(Number(f.ids['sonos-group-volume'].value), 11);
  assert.equal(f.ids['sonos-confirmation'].hidden, true);
});

test('a room mute button affects its named room and updates to Unmute from the subsequent reading', async () => {
  const f = volumeFixture(); await openRoomVolumes(f);
  roomMute(f, 'Mute Office').click(); await flush();
  let commands = volumeCommands(f);
  assert.equal(commands[0].url, `/api/sonos/devices/${volumeOffice.id}/review`);
  assert.deepEqual(JSON.parse(commands[0].options.body), {action: 'mute', params: {muted: true}});
  assert(roomMute(f, 'Unmute Office')); assert(roomMute(f, 'Mute Living room'));
  roomMute(f, 'Unmute Office').click(); await flush();
  commands = volumeCommands(f);
  assert.deepEqual(JSON.parse(commands[2].options.body), {action: 'mute', params: {muted: false}});
  assert.equal(commands.filter(call => call.url === '/api/sonos/execute').length, 2);
  assert(roomMute(f, 'Mute Office'));
});

test('slider changes cannot duplicate a pending command or interrupt its follow-up volume read', async () => {
  const pending = deferred(); let reads = 0;
  const f = volumeFixture(url => url.endsWith('/status') && ++reads > 1 ? pending.promise : undefined);
  await openRoomVolumes(f);
  const oldRoom = roomRange(f, volumeOffice), oldGroup = f.ids['sonos-group-volume'];
  await changeRange(oldRoom, 11);
  assert.equal(f.ids['sonos-device'].disabled, true, 'The busy guard includes the read after execution');
  oldRoom.fire('change'); oldGroup.fire('change'); roomMute(f, 'Mute Office').fire('click'); await flush();
  assert.equal(volumeCommands(f).length, 2);
  pending.resolve(volumeStatus(initialRoomVolumes().map(row => row.device_id === volumeOffice.id ? {...row, volume: 11} : row))); await flush();
  assert.equal(f.ids['sonos-device'].disabled, false);
  assert.equal(Number(roomRange(f, volumeOffice).value), 11);
  assert.equal(volumeCommands(f).length, 2);
});

for (const [label, change] of [
  ['room change', f => { f.ids['sonos-device'].value = secondSpeaker.id; f.ids['sonos-device'].fire('change'); }],
  ['lock and unlock', f => { f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); }],
  ['navigation', f => f.emit('document:tli-panel-switched', {panelId: 'panel-chat'})],
]) {
  test(`${label} prevents retained room and group callbacks from controlling an old group`, async () => {
    const f = volumeFixture(); await openRoomVolumes(f);
    const room = roomRange(f, volumeOffice), group = f.ids['sonos-group-volume'], mute = roomMute(f, 'Mute Office');
    change(f); await flush();
    await changeRange(room, 11); await changeRange(group, 11); mute.fire('click'); await flush();
    assert.equal(volumeCommands(f).length, 0);
  });

  test(`${label} during a volume preflight blocks its execution and private refresh`, async () => {
    const pending = deferred();
    const f = volumeFixture(url => url.endsWith('/review') ? pending.promise : undefined);
    await openRoomVolumes(f); await changeRange(roomRange(f, volumeOffice), 11); change(f);
    pending.resolve(response({review_id: 'old_volume_review', action: 'volume', params: {volume: 11}, device: volumeOffice,
      affected: [{name: 'OLD PRIVATE ROOM'}], topology: volumeTopology(), effect: 'Old volume change.'})); await flush();
    assert.equal(volumeCommands(f).filter(call => call.url === '/api/sonos/execute').length, 0);
    assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 1);
    assert.doesNotMatch(f.text(), /OLD PRIVATE ROOM/);
  });

  test(`${label} during the post-command read discards old volume rows without replay`, async () => {
    const pending = deferred(); let reads = 0;
    const f = volumeFixture(url => url.endsWith('/status') && ++reads > 1 ? pending.promise : undefined);
    await openRoomVolumes(f); await changeRange(roomRange(f, volumeOffice), 11); change(f);
    pending.resolve(volumeStatus(initialRoomVolumes().map(row => ({...row, name: 'OLD PRIVATE ROOM'})))); await flush();
    assert.doesNotMatch(f.text(), /OLD PRIVATE ROOM/);
    assert.equal(volumeCommands(f).filter(call => call.url === '/api/sonos/execute').length, 1);
    assert.equal(volumeRows(f).length, 0);
  });
}

test('an uncertain group command is never resent by timers or unlock and uses read-only verification', async () => {
  const f = volumeFixture(url => url === '/api/sonos/execute' ? response({ok: false, outcome: 'unknown',
    summary: 'Volume delivery is uncertain. No retry ran.'}) : undefined);
  await openRoomVolumes(f); await changeRange(f.ids['sonos-group-volume'], 11);
  assert.equal(volumeCommands(f).filter(call => call.url === '/api/sonos/execute').length, 1);
  f.advanceTimers(120001); f.emit('tli-session-locked'); f.emit('tli-session-unlocked'); await flush();
  assert.equal(volumeCommands(f).filter(call => call.url === '/api/sonos/execute').length, 1);
  assert.equal(volumeCommands(f).filter(call => call.url.endsWith('/review')).length, 1);
});

test('failed post-volume refresh disables stale controls until an explicit fresh status succeeds', async () => {
  let reads = 0;
  const f = volumeFixture(url => url.endsWith('/status') && ++reads === 2 ? response({detail: 'Speaker offline'}, 503) : undefined);
  await openRoomVolumes(f); await changeRange(roomRange(f, volumeOffice), 11);
  assert.equal(f.ids['sonos-group-volume'].disabled, true);
  assert.equal(roomRange(f, volumeOffice).disabled, true);
  assert.equal(f.ids['sonos-device'].disabled, false, 'Failed verification must not leave the entire panel busy');
  assert.match(f.ids['sonos-message'].textContent, /refresh|offline|check/i);
  f.ids['sonos-group-volume'].fire('change'); roomRange(f, volumeOffice).fire('change'); await flush();
  assert.equal(volumeCommands(f).filter(call => call.url === '/api/sonos/execute').length, 1);
  await f.click('Refresh status');
  assert.equal(f.ids['sonos-group-volume'].disabled, false); assert.equal(roomRange(f, volumeOffice).disabled, false);
  assert.equal(Number(roomRange(f, volumeOffice).value), 11);
});

test('fresh room volumes supplied by the command receipt update the stack without another read', async () => {
  const rooms = initialRoomVolumes().map(row => row.device_id === speaker.id ? {...row, volume: 14} : row);
  const f = volumeFixture(url => url === '/api/sonos/execute' ? response({ok: true, outcome: 'accepted', summary: 'Volume acknowledged.',
    observed: {playback: 'PLAYING'}, volume_controls: {rooms, group: {volume: 11, max: 12}}}) : undefined);
  await openRoomVolumes(f); await changeRange(roomRange(f), 14);
  assert.equal(f.calls.filter(call => call.url.endsWith('/status')).length, 1);
  assert.equal(Number(roomRange(f).value), 14);
  assert.equal(Number(f.ids['sonos-group-volume'].value), 11);
  assert.equal(f.ids['sonos-group-volume'].disabled, false);
});

test('a command to another room rereads the selected group instead of using that room’s receipt volumes', async () => {
  const f = volumeFixture(url => url === '/api/sonos/execute' ? response({ok: true, outcome: 'accepted', summary: 'Volume acknowledged.',
    volume_controls: {rooms: [{...initialRoomVolumes()[1], name: 'DIFFERENT GROUP ROOM', volume: 11}], group: null}}) : undefined);
  await openRoomVolumes(f); await changeRange(roomRange(f, volumeOffice), 11);
  const reads = f.calls.filter(call => call.url.endsWith('/status'));
  assert.equal(reads.length, 2); assert.equal(reads[1].url, `/api/sonos/devices/${speaker.id}/status`);
  assert.deepEqual(volumeRows(f).map(row => row.dataset.volumeDevice), [speaker.id, volumeOffice.id]);
  assert.doesNotMatch(f.ids['sonos-room-volumes'].textContent, /DIFFERENT GROUP ROOM/);
});

test('failed volume preparation sends no command and disables unverified slider previews until refresh', async () => {
  const f = volumeFixture(url => url.endsWith('/review') ? response({detail: 'Speaker group changed. Refresh status.'}, 409) : undefined);
  await openRoomVolumes(f); await changeRange(roomRange(f, volumeOffice), 11);
  assert.equal(volumeCommands(f).filter(call => call.url === '/api/sonos/execute').length, 0);
  assert.equal(f.ids['sonos-group-volume'].disabled, true); assert.equal(roomRange(f, volumeOffice).disabled, true);
  assert.match(f.ids['sonos-message'].textContent, /group changed/);
  await f.click('Refresh status');
  assert.equal(Number(roomRange(f, volumeOffice).value), 8); assert.equal(roomRange(f, volumeOffice).disabled, false);
});

test('failed execution disables stale volume controls and does not resend the command', async () => {
  const f = volumeFixture(url => url === '/api/sonos/execute' ? response({detail: 'Delivery uncertain. Read current state.'}, 503) : undefined);
  await openRoomVolumes(f); await changeRange(f.ids['sonos-group-volume'], 11);
  assert.equal(f.ids['sonos-group-volume'].disabled, true);
  assert.equal(roomRange(f).disabled, true);
  assert.match(f.ids['sonos-message'].textContent, /Delivery uncertain/);
  f.ids['sonos-group-volume'].fire('change'); f.advanceTimers(120001); await flush();
  assert.equal(volumeCommands(f).filter(call => call.url === '/api/sonos/execute').length, 1);
});

test('unchanged slider values and callbacks from replaced volume rows do not send new commands', async () => {
  const f = volumeFixture(); await openRoomVolumes(f);
  const oldRoom = roomRange(f, volumeOffice), oldGroup = f.ids['sonos-group-volume'], oldMute = roomMute(f, 'Mute Office');
  oldRoom.fire('change'); oldGroup.fire('change'); await flush();
  assert.equal(volumeCommands(f).length, 0);
  await f.click('Refresh status');
  await changeRange(oldRoom, 11); await changeRange(oldGroup, 11); oldMute.fire('click'); await flush();
  assert.equal(volumeCommands(f).length, 0);
});
