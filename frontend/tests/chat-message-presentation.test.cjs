const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../js', name), 'utf8');

function fixture({controllers = false, popover = true} = {}) {
  const docEvents = new Map(), winEvents = new Map(); let requests = 0;
  const listen = (events, name, fn, capture = false) => { if (!events.has(name)) events.set(name, []); events.get(name).push({fn, capture: capture === true}); };
  const invoke = (events, name, event = {}) => { for (const {fn} of events.get(name) || []) fn(event); };
  let document;
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.className = ''; this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.events = new Map(); this.hidden = false; this.open = false; this.textContent = ''; this.style = {}; this.nativeOpen = false; if (popover) { this.showPopover = () => { this.nativeOpen = true; }; this.hidePopover = () => { this.nativeOpen = false; }; } if (tag === 'dialog') { this.showModal = () => {this.open = true;}; this.close = () => {this.open = false;}; } }
    get classList() { return {contains: name => this.className.split(/\s+/).includes(name), add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; }, remove: name => { this.className = this.className.split(/\s+/).filter(c => c !== name).join(' '); }}; }
    get parentElement() { return this.parentNode; }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    prepend(child) { this.insertBefore(child, this.children[0]); }
    insertBefore(child, before) { if (!before) { this.append(child); return; } child.remove(); const index = this.children.indexOf(before); assert.ok(index >= 0); child.parentNode = this; this.children.splice(index, 0, child); }
    after(child) { this.parentNode.insertBefore(child, this.nextElementSibling); }
    remove() { if (this.parentNode) { const parent = this.parentNode; this.parentNode = null; parent.children.splice(parent.children.indexOf(this), 1); } }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.textContent = ''; this.append(...children); }
    contains(child) { return this === child || this.children.some(n => n.contains(child)); }
    matches(selector) { return selector.split(',').some(part => { part = part.trim(); if (part === ':popover-open') return this.nativeOpen; if (part === '*') return true; const attr = /\[([^\]]+)\]/.exec(part); if (attr) { const present = attr[1] === 'open' ? this.open : attr[1] === 'data-case-chat-link' ? !!this.dataset.caseChatLink : this.attrs[attr[1]] != null; if (!present) return false; part = part.replace(attr[0], ''); } return !part || part.startsWith('.') ? !part || this.classList.contains(part.slice(1)) : this.tagName === part.toUpperCase(); }); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
    getBoundingClientRect() { return {left: 10, right: 290, top: 20, bottom: 140, width: 280, height: 120}; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    addEventListener(name, fn, capture = false) { listen(this.events, name, fn, capture); }
    focus() { document.activeElement = this; }
    click() { if (this.disabled) return; this.focus(); const chain = []; for (let n = this; n; n = n.parentNode) chain.push(n); const e = {target: this, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }}; for (const capture of [true, false]) for (const node of capture ? [...chain].reverse() : chain) for (const event of node.events.get('click') || []) if (event.capture === capture && !e.stopped) event.fn(e); return e; }
  }
  document = {readyState: 'loading', hidden: false, activeElement: null, createElement: tag => new Element(tag), addEventListener: (...args) => listen(docEvents, ...args), querySelectorAll: selector => document.body.querySelectorAll(selector), getElementById: id => [document.body, ...document.body.querySelectorAll('*')].find(el => el.id === id)};
  document.body = new Element('body');
  const window = {innerWidth: 320, innerHeight: 570, addEventListener: (...args) => listen(winEvents, ...args), dispatchEvent: event => invoke(winEvents, event.type, event)};
  const context = vm.createContext({window, document, fetch() { requests++; throw Error('No network operation was expected'); }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }, localStorage: {getItem() {return null;}}, console});
  vm.runInContext(source('chat-workspace.js'), context);
  if (controllers) { vm.runInContext(source('troubleshooting.js'), context); vm.runInContext(source('memory-continuity.js'), context); }
  const output = new Element(); output.id = 'chat-output'; document.body.append(output);
  const element = (tag = 'div', cls = '', text = '') => { const el = new Element(tag); el.className = cls; el.textContent = text; return el; };
  const bubble = (role = 'ai') => { const el = element('div', 'chat-bubble chat-bubble-' + role); el.append(element('span', '', role === 'user' ? 'Write a short story' : 'The original answer')); output.append(el); return el; };
  return {element, bubble, output, document, window, api: window.TLIChatWorkspace, present: window.TLIChatWorkspace.presentMessage, requests: () => requests,
    event: (name, value = {}, target = 'document') => invoke(target === 'window' ? winEvents : docEvents, name, value)};
}
const action = (f, bubble, label = 'Save to Notes & fixes…') => { const group = f.element('div', 'memory-message-actions'), b = f.element('button', '', label); group.append(b); bubble.append(group); return b; };
const footer = bubble => bubble.nextElementSibling;

test('persisted user and assistant actions share one quiet menu outside their message text', () => {
  const f = fixture({controllers: true}), ref = {conversation_id: 'synthetic-conversation', message_index: 0, revision: 'a'.repeat(64)};
  for (const role of ['user', 'ai']) {
    const b = f.bubble(role), metadata = {source_ref: {...ref, message_index: role === 'user' ? 0 : 1}};
    const decorate = role === 'user' ? f.window.TLIMemory.decorateMessage : f.window.TLIMemory.decorateReply;
    decorate(b, metadata); decorate(b, metadata);
    assert.equal(b.querySelectorAll('button').length, 0);
    const foot = footer(b), menu = foot.querySelector('.chat-message-menu');
    assert.equal(menu.children.length, 2, 'Existing save and link actions remain available once');
    assert.equal(menu.children.filter(n => n.dataset.caseChatLink).length, 1);
    assert.equal(foot.classList.contains('chat-message-footer-user'), role === 'user');
    assert.equal(foot.querySelector('.chat-message-more').hidden, false);
    assert.equal(menu.hidden, true);
    foot.querySelector('.chat-message-more').click();
    assert.equal(menu.hidden, false); assert.equal(f.requests(), 0);
  }
});

test('messages without a saved source do not gain save or troubleshooting actions', () => {
  const f = fixture({controllers: true}), b = f.bubble('ai');
  f.window.TLIMemory.decorateReply(b, {});
  assert.equal(footer(b).querySelector('.chat-message-more').hidden, true);
  assert.equal(footer(b).querySelector('.chat-message-menu').children.length, 0);
  assert.equal(f.requests(), 0);
});

test('provisional and detached messages do not acquire presentation controls', () => {
  const f = fixture(), b = f.bubble(); b.classList.add('chat-bubble-thinking'); const save = action(f, b);
  f.present(b); assert.equal(footer(b), null); assert.equal(save.parentNode.parentNode, b);
  b.classList.remove('chat-bubble-thinking'); b.remove(); f.present(b); assert.equal(b.children.length, 2);
});

test('ordinary and specialized receipts retain original nodes under one Answer details disclosure', () => {
  const f = fixture(), b = f.bubble();
  const receipts = ['memory-context-receipt', 'notebook-receipt', 'documents-receipt', 'case-context-receipt', 'screenshot-receipt', 'chat-response-timing'].map(cls => f.element('div', cls, cls + ' unchanged evidence'));
  b.append(...receipts); f.present(b);
  const details = footer(b).querySelector('.chat-answer-details');
  assert.equal(details.children[0].textContent, 'Answer details'); assert.equal(details.open, false);
  const retained = footer(b).querySelector('.chat-answer-details-body');
  assert.deepEqual(retained.children, receipts); assert.equal(b.children.length, 1);
  const later = f.element('div', 'memory-context-receipt', 'Late budget metadata'); b.append(later); f.present(b); f.present(b);
  assert.equal(footer(b).querySelectorAll('.chat-answer-details').length, 1); assert.deepEqual(retained.children, [...receipts, later]);
});

test('read aloud, copy and next screenshot retain their original explicit handlers', () => {
  const f = fixture(), b = f.bubble(), calls = [];
  const speak = f.element('button', 'chat-bubble-speak', 'Read aloud'), copy = f.element('button', 'chat-bubble-copy', 'Copy');
  const screenshot = f.element('div', 'screenshot-receipt', 'Snapshot limitations'), next = f.element('button', 'btn-outline', 'Share the next screen');
  [speak, copy, next].forEach(button => button.addEventListener('click', () => calls.push(button.textContent)));
  screenshot.append(next); b.append(speak, copy, screenshot); f.present(b);
  const toolbar = footer(b).querySelector('.chat-message-toolbar');
  assert.equal(next.parentNode, toolbar); assert.equal(speak.parentNode, toolbar); assert.equal(copy.parentNode, toolbar);
  assert.equal(toolbar.hidden, false); assert.deepEqual(calls, []);
  assert.equal(screenshot.parentNode.className, 'chat-answer-details-body');
  next.click(); speak.click(); copy.click(); assert.deepEqual(calls, ['Share the next screen', 'Read aloud', 'Copy']);
});

test('More actions is native-keyboard accessible and Escape returns focus without a request', () => {
  const f = fixture(), b = f.bubble(); action(f, b); f.present(b);
  const foot = footer(b), more = foot.querySelector('.chat-message-more'), menu = foot.querySelector('.chat-message-menu');
  assert.equal(more.tagName, 'BUTTON'); assert.equal(more.getAttribute('aria-controls'), menu.id);
  more.click(); assert.equal(more.getAttribute('aria-expanded'), 'true'); menu.children[0].focus();
  let prevented = false; f.event('keydown', {key: 'Escape', preventDefault() {prevented = true;}});
  assert.equal(prevented, true); assert.equal(menu.hidden, true); assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, more); assert.equal(f.requests(), 0);
});

test('review actions run once after menu closure, with the visible trigger available for focus return', () => {
  const f = fixture(), b = f.bubble(); const save = action(f, b); f.present(b); const foot = footer(b), more = foot.querySelector('.chat-message-more'), menu = foot.querySelector('.chat-message-menu');
  let clicked = 0; save.addEventListener('click', () => { clicked++; assert.equal(menu.hidden, true); assert.equal(f.document.activeElement, more); });
  more.click(); assert.equal(clicked, 0); save.click(); assert.equal(clicked, 1);
});

test('opening another menu, navigation and outside pointer close menus without executing actions', () => {
  const f = fixture(), first = f.bubble(), second = f.bubble('user'); action(f, first); action(f, second); f.present(first); f.present(second);
  const a = footer(first), b = footer(second); a.querySelector('.chat-message-more').click(); b.querySelector('.chat-message-more').click();
  assert.equal(a.querySelector('.chat-message-menu').hidden, true); assert.equal(b.querySelector('.chat-message-menu').hidden, false);
  f.event('pointerdown', {target: f.output}); assert.equal(b.querySelector('.chat-message-menu').hidden, true);
  a.querySelector('.chat-message-more').click(); f.event('tli-panel-switched', {detail: {panelId: 'panel-dashboard2'}});
  assert.equal(a.querySelector('.chat-message-menu').hidden, true); assert.equal(f.requests(), 0);
});

test('lock dismisses menus and details, rejects queued action clicks and delayed presentation', () => {
  const f = fixture(), b = f.bubble(), save = action(f, b); b.append(f.element('div', 'memory-context-receipt', 'Private metadata')); f.present(b);
  const foot = footer(b), more = foot.querySelector('.chat-message-more'), details = foot.querySelector('.chat-answer-details');
  let saved = 0; save.addEventListener('click', () => saved++); more.click(); details.open = true;
  f.event('tli-session-locked', {}, 'window'); assert.equal(foot.querySelector('.chat-message-menu').hidden, true); assert.equal(details.open, false);
  save.click(); more.click(); assert.equal(saved, 0); assert.equal(foot.querySelector('.chat-message-menu').hidden, true);
  const delayed = f.bubble(); action(f, delayed); f.present(delayed); assert.equal(footer(delayed), null);
  f.event('tli-session-unlocked', {}, 'window'); more.click(); assert.equal(foot.querySelector('.chat-message-menu').hidden, false);
});

test('backgrounding closes actions and blocks accidental execution until visible', () => {
  const f = fixture(), b = f.bubble(), save = action(f, b); f.present(b); let saved = 0; save.addEventListener('click', () => saved++);
  const foot = footer(b), more = foot.querySelector('.chat-message-more'); more.click(); f.document.hidden = true; f.event('visibilitychange');
  assert.equal(foot.querySelector('.chat-message-menu').hidden, true); save.click(); more.click(); assert.equal(saved, 0);
  f.document.hidden = false; more.click(); assert.equal(foot.querySelector('.chat-message-menu').hidden, false);
});

test('interrupted response timing remains truthful in Response details', () => {
  const f = fixture(), b = f.bubble(); b.classList.add('chat-bubble-incomplete'); b.append(f.element('div', 'chat-response-timing', 'Stopped waiting after 4s · Browser timing')); f.present(b);
  assert.equal(footer(b).querySelector('.chat-answer-details').children[0].textContent, 'Response details');
  assert.equal(footer(b).querySelector('.chat-message-more').hidden, true);
});

test('receipt insertion is wired to existing final decoration and timing paths without a transcript observer', () => {
  assert.match(source('chat-workspace.js'), /bubble\.append\(receipt\);\s+presentMessage\(bubble\)/);
  assert.match(source('memory-continuity.js'), /decorated\.receipt = receipt; decorations\.set\(bubble, decorated\);\s+window\.TLIChatWorkspace\?\.presentMessage/);
  assert.match(source('chat-workspace.js'), /observe\(\$\('chat-output'\),\{childList:true,subtree:false\}\)/);
  assert.match(source('chat-workspace.js'), /sectionHelp\.parentElement !== options\) options\.append\(sectionHelp\)/);
});

test('the existing timestamp and Copy row moves intact from only its own message wrapper', () => {
  const f = fixture(), first = f.bubble(), second = f.bubble('user');
  const a = f.element('div', 'chat-msg chat-msg--ai'), b = f.element('div', 'chat-msg chat-msg--user');
  const meta = f.element('div', 'chat-meta'), other = f.element('div', 'chat-meta'), copy = f.element('button', 'chat-meta-copy', 'Copy');
  let copied = 0; copy.addEventListener('click', () => copied++); meta.append(f.element('span', 'chat-meta-ts', '9:15 PM'), copy);
  a.append(first, meta); b.append(second, other); f.output.append(a, b); f.present(first);
  assert.equal(meta.parentNode, footer(first).querySelector('.chat-message-toolbar')); assert.equal(other.parentNode, b);
  assert.equal(footer(first).querySelector('.chat-message-more').hidden, true); assert.equal(footer(first).querySelector('.chat-message-toolbar').hidden, false);
  f.present(first); assert.equal(meta.parentNode.querySelectorAll('.chat-meta').length, 1); copy.click(); assert.equal(copied, 1);
});

test('a valid newer persisted source replaces both moved action bindings without accumulating buttons', () => {
  const f = fixture({controllers: true}), b = f.bubble('user'), old = {conversation_id: 'old-conversation', message_index: 0, revision: 'a'.repeat(64)};
  f.window.TLIMemory.decorateMessage(b, {source_ref: old});
  const oldButtons = [...footer(b).querySelector('.chat-message-menu').children];
  const next = {conversation_id: 'new-conversation', message_index: 2, revision: 'b'.repeat(64)};
  f.window.TLIMemory.decorateMessage(b, {source_ref: next}); f.window.TLIMemory.decorateMessage(b, {source_ref: next});
  const currentButtons = footer(b).querySelector('.chat-message-menu').children;
  assert.equal(currentButtons.length, 2); assert.ok(oldButtons.every(button => !button.isConnected)); assert.ok(currentButtons.every(button => !oldButtons.includes(button)));
  assert.equal(f.requests(), 0);
});

test('malformed persisted message indexes cannot gain a troubleshooting or note-save action', () => {
  const f = fixture({controllers: true});
  for (const index of [-1, 1000001, 0.5, '1']) {
    const b = f.bubble('user'); f.window.TLIMemory.decorateMessage(b, {source_ref: {conversation_id: 'synthetic', message_index: index, revision: 'a'.repeat(64)}});
    assert.equal(b.children.length, 1); assert.equal(footer(b), null);
  }
  assert.equal(f.requests(), 0);
});

for (const popover of [true, false]) test(`More uses a viewport-bounded top layer (${popover ? 'native popover' : 'native dialog fallback'})`, () => {
  const f = fixture({popover}), b = f.bubble(); action(f, b); f.present(b); const foot = footer(b), more = foot.querySelector('.chat-message-more'), menu = foot.querySelector('.chat-message-menu');
  f.window.visualViewport = {width: 320, height: 300, offsetLeft: 0, offsetTop: 20};
  more.getBoundingClientRect = () => ({left: 250, right: 300, top: 260, bottom: 290, width: 50, height: 30});
  menu.getBoundingClientRect = () => ({height: 180});
  more.click(); assert.equal(menu.hidden, false); assert.equal(menu.style.width, '280px'); assert.equal(menu.style.maxHeight, '276px');
  assert.equal(menu.style.left, '20px'); assert.equal(menu.style.top, '74px'); assert.equal(menu.parentNode, foot, 'Keep existing panel ancestry');
  assert.equal(popover ? menu.nativeOpen : menu.open, true); assert.equal(menu.tagName, popover ? 'DIV' : 'DIALOG');
  if (!popover) { assert.equal(menu.querySelector('.chat-message-menu-close').textContent, 'Close actions'); menu.querySelector('.chat-message-menu-close').click(); assert.equal(menu.open, false); assert.equal(f.document.activeElement, more); }
  assert.equal(f.requests(), 0);
});

test('native dismissal resets state while a delayed old close event cannot dismiss a newly opened popover', () => {
  const f = fixture(), b = f.bubble(); action(f, b); f.present(b); const foot = footer(b), more = foot.querySelector('.chat-message-more'), menu = foot.querySelector('.chat-message-menu');
  more.click(); const toggle = menu.events.get('toggle')[0].fn;
  toggle({newState: 'closed'}); assert.equal(menu.nativeOpen, true, 'Ignore an old closed event while currently open');
  menu.nativeOpen = false; toggle({newState: 'closed'}); assert.equal(menu.hidden, true); assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('dialog fallback backdrop and native cancel dismiss without executing a reviewed action', () => {
  const f = fixture({popover: false}), b = f.bubble(), save = action(f, b); let saved = 0; save.addEventListener('click', () => saved++); f.present(b);
  const foot = footer(b), more = foot.querySelector('.chat-message-more'), menu = foot.querySelector('.chat-message-menu');
  more.click(); f.event('pointerdown', {target: menu, clientX: 0, clientY: 0}); assert.equal(menu.open, false);
  more.click(); menu.events.get('cancel')[0].fn({preventDefault() {}}); assert.equal(menu.open, false); assert.equal(f.document.activeElement, more); assert.equal(saved, 0);
});

test('scrolling dismisses the anchored menu while scrolling within its own list remains possible', () => {
  const f = fixture(), b = f.bubble(); action(f, b); f.present(b); const foot = footer(b), more = foot.querySelector('.chat-message-more'), menu = foot.querySelector('.chat-message-menu');
  more.click(); f.event('scroll', {target: menu}); assert.equal(menu.hidden, false);
  f.event('scroll', {target: f.output}); assert.equal(menu.hidden, true);
});

test('page suspension blocks delayed presentation and pageshow resumes without reopening a menu', () => {
  const f = fixture(), b = f.bubble(); action(f, b); f.present(b); const more = footer(b).querySelector('.chat-message-more'), menu = footer(b).querySelector('.chat-message-menu');
  more.click(); f.event('pagehide', {}, 'window'); assert.equal(menu.hidden, true);
  const delayed = f.bubble(); action(f, delayed); f.present(delayed); assert.equal(footer(delayed), null); more.click(); assert.equal(menu.hidden, true);
  f.event('pageshow', {persisted: true}, 'window'); assert.equal(menu.hidden, true); assert.equal(f.requests(), 0);
  more.click(); assert.equal(menu.hidden, false);
});

test('pageshow cannot unlock a real locked session or restore an open action menu', () => {
  const f = fixture(), b = f.bubble(); action(f, b); f.present(b); const more = footer(b).querySelector('.chat-message-more'), menu = footer(b).querySelector('.chat-message-menu');
  f.event('tli-session-locked', {}, 'window'); f.event('pagehide', {}, 'window'); f.event('pageshow', {persisted: true}, 'window'); more.click(); assert.equal(menu.hidden, true);
  f.event('tli-session-unlocked', {}, 'window'); more.click(); assert.equal(menu.hidden, false);
});
