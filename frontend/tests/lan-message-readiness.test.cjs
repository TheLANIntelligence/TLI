const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/tli-chat.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(peers) {
  const nodes = new Map(), requests = [], reviews = [], streams = [];
  const events = target => {
    const handlers = new Map();
    target.addEventListener = (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); };
    target.emit = async (name, event = {}) => { for (const fn of handlers.get(name) || []) await fn(event); };
    return target;
  };
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.style = {}; this.value = ''; this.hidden = false; this.classList = {remove() {}}; events(this); }
    set id(value) { this._id = value; nodes.set(value, this); }
    get id() { return this._id; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html || ''; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return (this._text || '') + this.children.map(child => child.textContent).join(' '); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child, sibling) { child.parentElement = this; this.children.splice(this.children.indexOf(sibling), 0, child); }
    replaceChildren(...children) { this._html = ''; this._text = ''; this.children = []; for (const child of children) this.appendChild(child); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    setAttribute(name, value) { this[name] = value; }
    focus() {}
    remove() {}
  }
  for (const id of ['tli-chat-buddies-list', 'tli-chat-buddies-meta', 'tli-chat-thread-output', 'tli-chat-thread-title', 'tli-chat-thread-meta', 'tli-chat-input', 'tli-chat-send-btn', 'tli-chat-share-btn', 'tli-chat-back-btn']) {
    const node = new Element(); node.id = id;
  }
  const thread = new Element(); thread.appendChild(nodes.get('tli-chat-thread-output'));
  const window = events({innerWidth:1200, TLIPeerTrust:{open(options) { reviews.push(options); }}, switchPanel() {}});
  const document = events({hidden:false, getElementById:id => nodes.get(id) || null, querySelector:() => null, createElement:tag => new Element(tag), body:new Element()});
  let directory = peers, failDirectory = false, delivery = {ok:true, status:200, data:{delivery:'acknowledged'}};
  const respond = data => ({ok:true, status:200, json:async () => data});
  const context = vm.createContext({window, document, console,
    crypto:{randomUUID:() => '00000000-0000-4000-8000-000000000000'},
    EventSource:class { constructor() { streams.push(this); } close() {} },
    setInterval:() => 1, clearInterval() {}, setTimeout:() => 2, clearTimeout() {},
    fetch:async (url, options) => {
      requests.push({url, body:options?.body ? JSON.parse(options.body) : null});
      if (url === '/mesh/node') return respond({node_id:'fox', display_name:'FOX'});
      if (url === '/api/lan/peers') return failDirectory ? {ok:false, status:503} : respond({peers:directory});
      if (url === '/mesh/chat/send') return {...delivery, json:async () => delivery.data};
      return respond({messages:[]});
    },
  });
  vm.runInContext(source, context);
  const findButton = (container, text) => {
    if (container.tagName === 'button' && container.textContent === text) return container;
    for (const child of container.children) { const result = findButton(child, text); if (result) return result; }
    return null;
  };
  return {nodes, requests, reviews, streams, window, api:window.TLIChat,
    input:nodes.get('tli-chat-input'), send:nodes.get('tli-chat-send-btn'),
    sends:() => requests.filter(r => r.url === '/mesh/chat/send'),
    notice:() => nodes.get('tli-chat-message-readiness'),
    button:(text, container = nodes.get('tli-chat-message-readiness')) => findButton(container, text),
    peers(value) { directory = value; }, failDirectory() { failDirectory = true; }, delivery(value) { delivery = value; },
    async select(index) { await nodes.get('tli-chat-buddies-list').children[index].emit('click'); await tick(); },
    async refresh() { await window.emit('tli-peer-trust-changed'); await tick(); },
  };
}

const pending = (id = 'dell-installation-one') => ({id, name:'TheLegatoDell', ip:'192.168.4.135', online:true, status:'pending', trust_state:'review_required', messaging:{available:false, code:'peer_not_allowed', message:'Review text-message permission on both computers before sending.'}});
const reviewed = (id = 'dell-installation-one') => ({...pending(id), status:'allowed', trust_state:'verified', messaging:{available:true, code:'ready', message:'Permission reviewed here.'}});

test('discovered pending peer has a direct review path and cannot send even through Enter', async () => {
  const f = fixture([pending()]); await f.api.onOpen(); await f.select(0);
  f.input.value = 'Hello from FOX';
  assert.equal(f.send.disabled, true);
  assert.equal(f.input.disabled, false, 'draft remains editable during review');
  assert.match(f.notice().textContent, /both computers/);
  assert.match(f.nodes.get('tli-chat-thread-meta').innerHTML, /Seen on LAN/);
  await f.input.emit('keydown', {key:'Enter', preventDefault() {}});
  await f.button('Review computer trust').emit('click');
  assert.equal(f.input.value, 'Hello from FOX'); assert.equal(f.sends().length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.reviews)), [{deviceId:'dell-installation-one', name:'TheLegatoDell', purpose:'messages'}]);
});

test('review completion enables a deliberate send without automatically sending or losing the draft', async () => {
  const f = fixture([pending()]); await f.api.onOpen(); await f.select(0); f.input.value = 'Hello';
  f.peers([reviewed()]); await f.refresh();
  assert.equal(f.send.disabled, false); assert.equal(f.sends().length, 0); assert.equal(f.input.value, 'Hello');
  assert.match(f.notice().textContent, /must also review FOX/);
  await f.send.emit('click');
  assert.equal(f.sends().length, 1); assert.equal(f.sends()[0].body.to_id, pending().id); assert.equal(f.input.value, '');
  assert.match(f.nodes.get('tli-chat-thread-output').textContent, /Delivered to reviewed computer/);
});

test('blocked and missing-permission peers retain drafts and disable Send', async () => {
  for (const peer of [{...pending(), status:'blocked', messaging:null}, {...reviewed(), messaging:{available:false, code:'capability_required', message:'Text-message permission has not been reviewed here.'}}]) {
    const f = fixture([peer]); await f.api.onOpen(); await f.select(0); f.input.value = 'Keep this';
    await f.send.emit('click');
    assert.equal(f.sends().length, 0); assert.equal(f.input.value, 'Keep this'); assert.equal(f.send.disabled, true);
    assert.match(f.notice().textContent, /blocked|not been reviewed/);
  }
});

test('inference-only nodes explain AI compute even when the server reports missing message permission', async () => {
  const peer = {...reviewed(), peer_profile:'inference_node', messaging:{available:false, code:'capability_required', message:'Review text-message permission before sending.'}};
  const f = fixture([peer]); await f.api.onOpen(); await f.select(0);
  assert.equal(f.send.disabled, true);
  assert.match(f.notice().textContent, /AI compute only.*Ask TLI/);
  assert.doesNotMatch(f.notice().textContent, /Review text-message permission/);
  assert.equal(f.button('Review computer trust'), null);
  f.input.value = 'Hello'; await f.send.emit('click');
  assert.equal(f.sends().length, 0); assert.equal(f.input.value, 'Hello');
});

test('duplicate same-address identities stay distinct and drafts remain bound to the selected identity', async () => {
  const f = fixture([pending('old-installation'), {...pending('new-installation'), online:false}]);
  await f.api.onOpen(); await f.select(0); f.input.value = 'For the old identity';
  const rows = f.nodes.get('tli-chat-buddies-list').children;
  assert.equal(rows.length, 2); assert.match(rows[0].innerHTML, /title="old-installation"/); assert.match(rows[1].innerHTML, /title="new-installation"/);
  await f.select(1); assert.equal(f.input.value, ''); f.input.value = 'For the new identity';
  await f.select(0); assert.equal(f.input.value, 'For the old identity');
  f.streams[0].onmessage({data:JSON.stringify({type:'node_offline', node_id:'old-installation'})});
  assert.equal(f.input.value, 'For the old identity'); assert.match(f.nodes.get('tli-chat-thread-title').innerHTML, /TheLegatoDell/);
});

test('a failed directory refresh cannot reuse stale permission or erase the current recipient and draft', async () => {
  const f = fixture([reviewed()]); await f.api.onOpen(); await f.select(0); f.input.value = 'Do not lose me';
  f.failDirectory(); await f.refresh(); await f.send.emit('click');
  assert.equal(f.send.disabled, true); assert.equal(f.input.value, 'Do not lose me'); assert.equal(f.sends().length, 0);
  assert.match(f.notice().textContent, /could not be checked/);
});

test('previous discoveries stay collapsed while their exact conversation and draft remain selectable', async () => {
  const old = {...pending('old-installation'), previous_discovery:true, superseded_by:'current-installation'};
  const f = fixture([old, pending('current-installation')]); await f.api.onOpen();
  const list = f.nodes.get('tli-chat-buddies-list');
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0]['data-node-id'], 'current-installation');
  const previous = list.children[1];
  assert.equal(previous.tagName, 'details'); assert.equal(previous.open, false);
  assert.match(previous.children[0].textContent, /Previous discoveries \(1\)/);
  assert.equal(f.nodes.get('tli-chat-buddies-meta').textContent, '1/1');
  await previous.children[1].emit('click'); await tick(); f.input.value = 'Old identity draft';
  assert.match(f.notice().textContent, /older discovery record/);
  assert.equal(f.send.disabled, true);
  await list.children[0].emit('click'); await tick(); assert.equal(f.input.value, '');
  f.input.value = 'Current identity draft';
  await list.children[1].children[1].emit('click'); await tick();
  assert.equal(f.input.value, 'Old identity draft'); assert.equal(f.sends().length, 0);
  assert.equal(list.children[1].open, true);
  await f.refresh(); assert.equal(f.input.value, 'Old identity draft');
});

test('remote rejection retains the draft and retries only on an explicit action with the same message identifier', async () => {
  const f = fixture([reviewed()]); await f.api.onOpen(); await f.select(0); f.input.value = 'Hello Dell';
  f.delivery({ok:false, status:409, data:{detail:{code:'peer_review_required', message:'Review FOX on the other computer.'}}});
  await f.send.emit('click');
  assert.equal(f.input.value, 'Hello Dell'); assert.equal(f.sends().length, 1);
  const out = f.nodes.get('tli-chat-thread-output');
  assert.match(out.textContent, /Review FOX on the other computer/);
  await f.button('Review computer trust', out).emit('click'); assert.equal(f.sends().length, 1);
  f.delivery({ok:true, status:200, data:{delivery:'acknowledged'}});
  await f.button('Retry this message', out).emit('click');
  assert.equal(f.sends().length, 2); assert.equal(f.sends()[0].body.message_id, f.sends()[1].body.message_id); assert.equal(f.input.value, '');
});

test('session lock clears drafts and disables the composer', async () => {
  const f = fixture([reviewed()]); await f.api.onOpen(); await f.select(0); f.input.value = 'Private draft';
  await f.window.emit('tli-session-locked');
  assert.equal(f.input.value, ''); assert.equal(f.input.disabled, true); assert.equal(f.send.disabled, true); assert.equal(f.notice().hidden, true);
});
