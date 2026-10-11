const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, '../js/routine-workspace.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const protocol = 'tli-action-review-v1', at = '2026-09-13T12:00:00Z', hash = 'a'.repeat(64);

function fixture() {
  const ids = {}, events = {}, calls = [], storage = new Map();
  const action = { id: 'routine-one', name: 'Evening lights', created_at: at, updated_at: at, enabled: true,
    owner_metadata: { preserved: true }, steps: [{ type: 'shelly.switch', device: 'lamp', value: 'on', driver_metadata: { keep: true } }] };
  let rows = [action], version = 1, override;
  const revision = () => version.toString(16).padStart(64, '0');
  const caps = { review_protocol: protocol, trigger_engine: { available: false }, devices: [{ id: 'lamp', name: 'Desk lamp', ip: '192.0.2.1', relay: 0 }], hp_devices: [] };
  function element(tag) {
    const el = { tagName: tag.toUpperCase(), children: [], handlers: {}, attrs: {}, value: '', textContent: '', disabled: false, isConnected: true,
      append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } },
      replaceChildren(...items) { this.children = []; this.textContent = ''; this.append(...items); },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      async fire(type) { for (const fn of this.handlers[type] || []) await fn({ target: this, preventDefault() {} }); },
      click() { return this.disabled ? Promise.resolve() : this.fire('click'); }, focus() {},
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(row => row !== this); } };
    Object.defineProperty(el, 'id', { get: () => el._id, set(value) { el._id = value; ids[value] = el; } });
    return el;
  }
  const root = element('main'); root.id = 'routine-workspace';
  const home = element('div'); home.id = 'home-favorites';
  const document = { hidden: false, createElement: element, getElementById: id => ids[id], addEventListener: (type, fn) => (events[type] ||= []).push(fn) };
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    addEventListener: (type, fn) => (events[type] ||= []).push(fn), dispatchEvent: event => { for (const fn of events[event.type] || []) fn(event); },
    switchPanel: target => { window.dispatchEvent(new CustomEvent('tli-panel-switched', { detail: { panelId: target } })); window.TLIManualRoutines.onOpen(); } };
  function reviewed(body, saved = false) {
    const steps = body.steps.map((step, index) => ({ index, step_type: step.type, effect: step.value || step.capability || null,
      target: step.type === 'shelly.switch' ? { id: 'lamp', name: 'Desk lamp', address: '192.0.2.1', relay: 0 } : null }));
    const errors = Object.fromEntries(steps.filter(row => !row.target).map(row => [row.index, 'Legacy step unavailable']));
    return { ok: true, protocol, actions_performed: false, trigger_active: false, name: body.name, checked_at: at,
      scope: 'Review the exact targets.', target_revision: hash, ...(saved ? { action_id: body.id, revision: revision() } : { draft_revision: hash }),
      available: !Object.keys(errors).length && !body.archived, steps, errors };
  }
  async function defaultHandler(url, options) {
    const body = options.body && JSON.parse(options.body);
    if (url.endsWith('/capabilities')) return clone(caps);
    if (url.endsWith('/list')) return { actions: clone(rows), triggers: [] };
    if (url.includes('/receipts')) return { items: [] };
    if (url.endsWith('/definition')) return { ok: true, protocol, action: clone(rows.find(row => url.includes(row.id))), revision: revision() };
    if (url.endsWith('/preview')) return reviewed(body);
    if (url.endsWith('/review')) return reviewed(rows.find(row => url.includes(row.id)), true);
    if (options.method === 'PATCH') {
      if (body.expected_revision !== revision()) return { http: 409, detail: 'Routine changed elsewhere' };
      const row = rows.find(row => url.endsWith(row.id));
      for (const field of ['name', 'steps', 'archived']) if (Object.hasOwn(body, field)) row[field] = clone(body[field]);
      version++;
      return { ok: true, protocol, action: clone(row), revision: revision(), trigger_active: false, receipt_saved: true };
    }
    if (url.endsWith('/approve')) {
      const created = { id: 'routine-copy', name: body.name, steps: clone(body.steps), created_at: at };
      rows.push(created); return { ok: true, action: clone(created), trigger_active: false, receipt_saved: true };
    }
    throw Error('Unexpected ' + url);
  }
  vm.runInNewContext(code, { window, document, Date, Set, Map, Uint8Array, AbortController, CustomEvent, crypto: webcrypto,
    fetch: async (url, options = {}) => { calls.push({ url, options: clone(options) }); const body = await (override || defaultHandler)(url, options); return { ok: !body.http, status: body.http || 200, json: async () => body }; } });
  const nodes = (mount = root) => [mount, ...mount.children.flatMap(child => nodes(child))];
  const button = (label, mount = root) => nodes(mount).find(el => el.tagName === 'BUTTON' && el.textContent === label);
  return { window, document, home, caps, calls, storage, action, rows, revision, defaultHandler, handler: value => { override = value; },
    text: (mount = root) => nodes(mount).map(el => el.textContent).join('\n'), button,
    input: label => nodes().find(el => el.attrs['aria-label'] === label),
    async open() { window.TLIManualRoutines.onOpen(); await tick(); await tick(); },
    async click(label, mount = root) { const el = button(label, mount); assert.ok(el, label); await el.click(); await tick(); },
    async set(label, value, event = 'input') { const el = this.input(label); assert.ok(el, label); el.value = value; await el.fire(event); await tick(); },
    event: type => window.dispatchEvent(new CustomEvent(type)), nextRevision: () => version++ };
}

test('editing a routine uses revision-checked PATCH and retains unknown step metadata', async () => {
  const f = fixture(); await f.open(); await f.click('Edit: Evening lights');
  assert.equal(f.input('Routine name').value, 'Evening lights');
  await f.set('Routine name', 'Bedtime'); await f.set('Step 1 effect', 'off', 'change');
  await f.click('Preview routine'); await f.click('Save routine changes');
  const request = f.calls.find(call => call.options.method === 'PATCH');
  const body = JSON.parse(request.options.body);
  assert.equal(body.expected_revision, '1'.padStart(64, '0'));
  assert.deepEqual(body.steps[0].driver_metadata, { keep: true });
  assert.equal(f.action.name, 'Bedtime'); assert.equal(f.action.steps[0].value, 'off');
  assert.equal(f.action.id, 'routine-one'); assert.deepEqual(f.action.owner_metadata, { preserved: true });
  assert.equal(f.calls.some(call => call.url.includes('/run/')), false);
});

test('unsupported legacy steps remain intact during a name-only edit', async () => {
  const f = fixture(); f.action.steps.push({ type: 'future.timer', milliseconds: 4000, opaque: { keep: true } });
  await f.open(); await f.click('Edit: Evening lights');
  assert.match(f.text(), /cannot change this legacy step/);
  await f.set('Routine name', 'My lights'); await f.click('Preview routine'); await f.click('Save routine changes');
  const body = JSON.parse(f.calls.find(call => call.options.method === 'PATCH').options.body);
  assert.equal(body.steps, undefined); assert.equal(f.action.steps[1].milliseconds, 4000);
  assert.equal(f.calls.some(call => call.url.endsWith('/preview')), false);
});

test('an unavailable saved step stays intact while another step is edited', async () => {
  const f = fixture(); const legacy = { type: 'future.timer', duration: 12 }; f.action.steps.push(legacy);
  await f.open(); await f.click('Edit: Evening lights'); await f.set('Step 1 effect', 'off', 'change');
  await f.click('Preview routine'); assert.match(f.text(), /Unavailable saved steps are preserved/);
  await f.click('Save routine changes'); assert.deepEqual(f.action.steps[1], legacy);
});

test('duplicate opens an unsaved draft and creates a new routine only after review', async () => {
  const f = fixture(); const original = clone(f.action);
  await f.open(); await f.click('Duplicate: Evening lights');
  assert.equal(f.input('Routine name').value, 'Evening lights copy');
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
  await f.click('Preview routine'); await f.click('Save reviewed routine');
  assert.equal(f.rows.length, 2); assert.notEqual(f.rows[1].id, f.action.id); assert.deepEqual(f.action, original);
  const payload = JSON.parse(f.calls.find(call => call.url.endsWith('/approve')).options.body);
  assert.equal(payload.expected_revision, undefined); assert.equal(payload.trigger, undefined);
});

test('edit conflicts keep the draft and same request until the user chooses a fresh version', async () => {
  const f = fixture(); await f.open(); await f.click('Edit: Evening lights'); await f.set('Routine name', 'Draft');
  await f.click('Preview routine'); f.nextRevision(); await f.click('Save routine changes');
  assert.equal(f.input('Routine name').value, 'Draft'); assert.match(f.text(), /changed elsewhere/);
  const previous = f.calls.at(-1).options.body;
  await f.click('Retry same reviewed save'); assert.equal(f.calls.at(-1).options.body, previous);
  assert.equal(f.action.name, 'Evening lights');
});

test('archive and restore are explicit metadata changes; archived rows cannot offer Run', async () => {
  const f = fixture(); await f.open(); await f.click('Archive: Evening lights');
  assert.equal(f.calls.some(call => call.options.method === 'PATCH'), false);
  await f.click('Archive routine'); assert.equal(f.action.archived, true);
  assert.equal(f.button('Review run: Evening lights'), undefined);
  await f.click('Archived routines'); assert.ok(f.button('Restore: Evening lights'));
  await f.click('Restore: Evening lights'); await f.click('Restore routine');
  assert.equal(f.action.archived, false); await f.click('Show active routines'); assert.ok(f.button('Review run: Evening lights'));
  assert.equal(f.calls.some(call => call.url.includes('/run/')), false);
});

test('device picker leads with the friendly name and empty setup has an actionable button', async () => {
  const f = fixture(); await f.open(); await f.click('Switch devices on');
  assert.equal(f.input('Step 1 target').children[1].textContent, 'Desk lamp');
  f.caps.devices = []; await f.click('Refresh saved state'); assert.ok(f.button('Connect a smart device'));
});

test('Home favorites persist only IDs, resolve current labels, and open review without execution', async () => {
  const f = fixture(); await f.open(); await f.click('Pin to Home: Evening lights');
  assert.equal(f.storage.get('tli.routine-favorites.v1'), '["routine-one"]');
  f.action.name = 'Current label'; await f.window.TLIRoutineFavorites.render(f.home);
  assert.match(f.text(f.home), /Current label/); assert.doesNotMatch(f.text(f.home), /Evening lights/);
  await f.click('Review and run', f.home); assert.ok(f.input('I reviewed every target and effect'));
  assert.equal(f.calls.some(call => call.url.includes('/run/')), false);
});

test('late favorite reads cannot restore names after lock or replace a newer render', async () => {
  const f = fixture(); f.storage.set('tli.routine-favorites.v1', '["routine-one"]');
  let complete;
  f.handler(() => new Promise(resolve => { complete = resolve; }));
  const pending = f.window.TLIRoutineFavorites.render(f.home);
  f.event('tli-session-locked'); complete({ actions: [clone(f.action)], triggers: [] }); await pending;
  assert.equal(f.text(f.home).trim(), '');
  f.event('tli-session-unlocked'); const old = f.window.TLIRoutineFavorites.render(f.home);
  const finishOld = complete; f.handler(f.defaultHandler); f.action.name = 'New label';
  await f.window.TLIRoutineFavorites.render(f.home);
  finishOld({ actions: [{ ...clone(f.action), name: 'Old label' }], triggers: [] }); await old;
  assert.match(f.text(f.home), /New label/); assert.doesNotMatch(f.text(f.home), /Old label/);
});

test('archived and duplicate-ID favorites never expose a run shortcut', async () => {
  const f = fixture(); f.storage.set('tli.routine-favorites.v1', '["routine-one"]'); f.action.archived = true;
  await f.window.TLIRoutineFavorites.render(f.home); assert.equal(f.button('Review and run', f.home), undefined);
  f.action.archived = false; f.rows.push(clone(f.action));
  await f.window.TLIRoutineFavorites.render(f.home); assert.equal(f.button('Review and run', f.home), undefined);
});
