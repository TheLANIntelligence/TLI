const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/ui-foundation.js'), 'utf8');
const start = source.indexOf('  function accessibleOverlays()');
const controller = source.slice(start, source.indexOf('  function init()', start));

function fixture() {
  const events = {}, frames = new Map();
  let observer, nextFrame = 0, scans = 0, layoutReads = 0;
  const document = { activeElement: null, addEventListener(type, fn) { events[type] = fn; } };
  function make(tag = 'div', id = '') {
    const classes = new Set(), attrs = new Map();
    const element = { nodeType: 1, tagName: tag.toUpperCase(), id, children: [], parentElement: null,
      hidden: false, open: false, disabled: false, textContent: '',
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
      get isConnected() { return this === document.body || !!this.parentElement?.isConnected; },
      append(child) { child.parentElement = this; this.children.push(child); },
      contains(other) { return other === this || this.children.some(child => child.contains(other)); },
      matches(selector) { return selector.split(',').some(part => { const value = part.trim(); return value.startsWith('#') ? this.id === value.slice(1) : value.startsWith('.') ? classes.has(value.slice(1)) : this.tagName === value.toUpperCase(); }); },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getAttribute(name) { return attrs.get(name) ?? null; },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getClientRects() { layoutReads++; for (let node = this; node; node = node.parentElement) if (node.hidden || node.classList.contains('hidden') || (node.tagName === 'DIALOG' && !node.open)) return []; return [{}]; },
      focus() { document.activeElement = this; events.focusin?.({ target: this }); },
      click() { this.clicked = (this.clicked || 0) + 1; },
    };
    return element;
  }
  document.body = make('body'); document.activeElement = document.body;
  document.querySelectorAll = selector => { scans++; return document.body.querySelectorAll(selector); };
  const opener = make('button', 'opener'); document.body.append(opener); opener.focus();
  const context = vm.createContext({ document, $: id => document.body.querySelector('#' + id),
    getComputedStyle: () => ({ visibility: 'visible' }),
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    queueMicrotask: fn => fn(),
  });
  function emit(records) { observer(records); }
  function attribute(target) { emit([{ type: 'attributes', target }]); }
  function append(parent, child) { parent.append(child); emit([{ type: 'childList', target: parent, addedNodes: [child], removedNodes: [] }]); }
  function frame() { const ready = [...frames.values()]; frames.clear(); for (const fn of ready) fn(); }
  function dialog(id = 'test-dialog', tag = 'dialog') {
    const box = make(tag, id); box.setAttribute('aria-label', 'Test dialog');
    if (tag !== 'dialog') { box.classList.add('modal-overlay'); box.hidden = true; }
    const first = make('input'), last = make('button'); box.append(first); box.append(last);
    append(document.body, box); frame(); return { box, first, last };
  }
  vm.runInContext(controller + '\naccessibleOverlays();', context);
  return { document, make, opener, frames, attribute, append, frame, dialog,
    emit, key(event) { events.keydown(event); },
    resetCounts() { scans = 0; layoutReads = 0; }, counts: () => ({ scans, layoutReads }),
  };
}

test('background rendering never repeatedly measures an unchanged open overlay', () => {
  const f = fixture(), { box, first } = f.dialog(); box.open = true; f.attribute(box); f.frame();
  assert.equal(f.document.activeElement, first);
  const output = f.make('div', 'chat-output'); f.append(f.document.body, output); f.frame(); f.resetCounts();
  for (let i = 0; i < 1000; i++) {
    const paragraph = f.make('p'); paragraph.textContent = 'Reply or background status ' + i;
    f.append(output, paragraph); f.attribute(paragraph);
  }
  assert.equal(f.frames.size, 0, 'Unrelated rendering must not schedule focus/layout work');
  assert.deepEqual(f.counts(), { scans: 0, layoutReads: 0 });
  assert.equal(f.document.activeElement, first);
});

test('bursts of overlay visibility changes settle in one frame and restore the opener on close', () => {
  const f = fixture(), { box, first } = f.dialog('legacy-modal', 'div'); f.resetCounts();
  box.hidden = false; for (let i = 0; i < 100; i++) f.attribute(box);
  assert.equal(f.frames.size, 1); assert.equal(f.counts().scans, 0); f.frame();
  assert.equal(f.counts().scans, 1); assert.equal(f.document.activeElement, first);
  assert.equal(box.getAttribute('role'), 'dialog'); assert.equal(box.getAttribute('aria-modal'), 'true');
  box.hidden = true; f.attribute(box); f.frame(); assert.equal(f.document.activeElement, f.opener);
});

test('showing an ancestor and adding an already-open nested dialog still establish focus', () => {
  const f = fixture(), wrapper = f.make('section'); wrapper.hidden = true;
  const box = f.make('dialog'); box.open = true; box.setAttribute('aria-label', 'Nested');
  const input = f.make('input'); box.append(input); wrapper.append(box); f.append(f.document.body, wrapper); f.frame();
  assert.equal(f.document.activeElement, f.opener);
  wrapper.hidden = false; f.attribute(wrapper); f.frame(); assert.equal(f.document.activeElement, input);
  const other = f.make('section'), modal = f.make('dialog'), control = f.make('button');
  modal.open = true; modal.setAttribute('aria-label', 'Added'); modal.append(control); other.append(modal);
  f.append(f.document.body, other); f.frame(); assert.equal(f.document.activeElement, control);
});

test('Tab arriving before the next frame honors the newly opened dialog', () => {
  const f = fixture(), { box, first, last } = f.dialog(); box.open = true; f.attribute(box);
  let prevented = false;
  f.key({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(f.frames.size, 0); assert.equal(prevented, true); assert.equal(f.document.activeElement, last);
  f.key({ key: 'Tab', shiftKey: false, preventDefault() {} }); assert.equal(f.document.activeElement, first);
});

test('the PIN overlay still traps focus and cannot be dismissed with Escape', () => {
  const f = fixture(), { box, first, last } = f.dialog('tli-lock-screen', 'div');
  box.hidden = false; f.attribute(box); f.frame(); first.focus();
  f.key({ key: 'Tab', shiftKey: true, preventDefault() {} }); assert.equal(f.document.activeElement, last);
  f.key({ key: 'Escape', defaultPrevented: false, preventDefault() { assert.fail('PIN must not be dismissed'); } });
  assert.equal(box.hidden, false); assert.equal(last.clicked, undefined);
});
