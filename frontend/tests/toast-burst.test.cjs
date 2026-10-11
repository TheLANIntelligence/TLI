const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../nerve.js'), 'utf8');

function fixture() {
  const nodes = new Map(), timers = new Map();
  let now = 0, nextTimer = 0;
  function element() {
    const classes = new Set(), handlers = {};
    const close = { addEventListener(name, fn) { handlers[name] = fn; }, click() { handlers.click(); } };
    const node = {
      children: [], parentNode: null, innerHTML: '',
      classList: { add(name) { classes.add(name); }, contains(name) { return classes.has(name); } },
      appendChild(child) { child.parentNode = this; this.children.push(child); },
      removeChild(child) {
        const index = this.children.indexOf(child);
        assert.notEqual(index, -1, 'only attached children may be removed');
        this.children.splice(index, 1); child.parentNode = null;
      },
      querySelector(selector) { assert.equal(selector, '.tli-toast-close'); return close; },
    };
    Object.defineProperty(node, 'id', { set(id) { nodes.set(id, node); } });
    Object.defineProperty(node, 'firstChild', { get() { return node.children[0] || null; } });
    return node;
  }
  function advance(ms) {
    const target = now + ms;
    let calls = 0;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++calls < 1000, 'timer execution must remain bounded');
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = target;
  }
  const context = vm.createContext({
    window: {},
    document: { readyState: 'loading', addEventListener() {}, body: element(),
      getElementById(id) { return nodes.get(id) || null; }, createElement: element },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance,
  });
  vm.runInContext(source, context, { timeout: 100 });
  // Call through runInContext: a regression in the synchronous trim loop fails
  // with a VM timeout instead of hanging the Node test process.
  const run = code => vm.runInContext(code, context, { timeout: 100 });
  return { run, context, timers, container: () => nodes.get('tli-toast-container') };
}

test('a fourth toast and a larger synchronous burst keep the newest three without blocking', () => {
  const f = fixture();
  f.run('for (let i = 1; i <= 4; i++) window.tliToast("Notification " + i, "error");');
  assert.equal(f.container().children.length, 3);
  for (const [index, toast] of f.container().children.entries()) assert.match(toast.innerHTML, new RegExp(`Notification ${index + 2}<`));
  assert.equal(f.timers.size, 3, 'evicted toasts must not retain their expiry timers');
  f.run('for (let i = 5; i <= 100; i++) window.tliToast("Notification " + i);');
  assert.equal(f.container().children.length, 3);
  for (const [index, toast] of f.container().children.entries()) assert.match(toast.innerHTML, new RegExp(`Notification ${index + 98}<`));
  assert.equal(f.timers.size, 3);
});

test('manual dismissal and normal expiry preserve their existing animation delay', () => {
  const f = fixture();
  f.run('window.tliToast("Dismiss me");');
  const toast = f.container().firstChild;
  toast.querySelector('.tli-toast-close').click();
  assert.equal(toast.classList.contains('tli-toast--out'), true);
  assert.equal(f.container().children.length, 1);
  f.run('advance(239);'); assert.equal(f.container().children.length, 1);
  f.run('advance(1);'); assert.equal(f.container().children.length, 0);
  assert.equal(f.timers.size, 0);
  f.run('window.tliToast("Expire normally"); advance(3999);');
  const expiring = f.container().firstChild;
  assert.equal(expiring.classList.contains('tli-toast--out'), false);
  f.run('advance(1);');
  assert.equal(expiring.classList.contains('tli-toast--out'), true);
  assert.equal(f.container().children.length, 1);
  f.run('advance(240);'); assert.equal(f.container().children.length, 0);
});

test('a burst during dismissal removes the old toast without its delayed callback removing a replacement', () => {
  const f = fixture();
  f.run('for (let i = 1; i <= 3; i++) window.tliToast("Notification " + i);');
  const old = f.container().firstChild;
  old.querySelector('.tli-toast-close').click();
  f.run('window.tliToast("Replacement");');
  assert.equal(old.parentNode, null);
  assert.equal(f.container().children.length, 3);
  f.run('advance(240);');
  assert.equal(f.container().children.length, 3);
  assert.match(f.container().children[2].innerHTML, /Replacement</);
  f.run('advance(4000);');
  assert.equal(f.container().children.length, 0);
  assert.equal(f.timers.size, 0);
});
