const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../js/saved-places.js'), 'utf8');
const all = root => root?.children.flatMap(n => [n, ...all(n)]) || [];
const content = root => [root.textContent, ...all(root).map(n => n.textContent)].join(' ');
const find = (f, text, root = f.nodes['places-dialog']) => { const n = all(root).find(n => n.tag === 'button' && n.textContent === text); assert.ok(n, text); return n; };
const row = (extra = {}) => ({ id: 'a'.repeat(32), name: 'My drive', kind: 'folder', target: 'N:\\Music', revision: 'b'.repeat(64), ...extra });
function fixture(rows = [row()], { dashboard = false, navigation } = {}) {
  const nodes = {}, events = {}, requests = [], scans = [], opened = [], notes = [];
  function element(tag) {
    const n = { tag, children: [], handlers: {}, textContent: '', value: '', hidden: false, disabled: false, attributes: {}, dataset: {},
      setAttribute(k, v) { this.attributes[k] = v; }, append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); }, replaceChildren(...items) { this.children = items; },
      addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); }, fire(k) { return Promise.all((this.handlers[k] || []).map(fn => fn({ preventDefault() {} }))); }, dispatchEvent(e) { return this.fire(e.type); }, click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; },
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = this; } }); return n;
  }
  for (const id of ['filesRootInput', 'panel-files', 'panel-visualizer']) nodes[id] = element('div');
  if (dashboard) { nodes['dashboard-places-mount'] = element('div'); nodes['panel-dashboard2'] = element('section'); nodes['panel-dashboard2'].hidden = true; }
  const ctx = vm.createContext({ console, Date, Map, Event, encodeURIComponent, switchPanel: id => opened.push(id),
    document: { body: element('body'), readyState: 'complete', createElement: element, getElementById: id => nodes[id], querySelector: () => element('div'), addEventListener: (key, fn) => (events[key] ||= []).push(fn) },
    window: { addEventListener: (key, fn) => (events[key] ||= []).push(fn), TLIVisualizer: { scanPath: p => scans.push(p) }, TLINotebook: { open: ref => notes.push(ref) }, ...(navigation ? {TLIUI:{navigation}} : {}) },
    fetch: async (url, opts = {}) => { requests.push([url, opts]); return { ok: true, json: async () => url.endsWith('/check') ? { ok: true, revision: rows[0].revision, status: 'available', checked_at: '2026-09-07T12:00:00Z', detail: 'Available', note: { id: 'f-note', revision: 'c'.repeat(64) } } : { ok: true, protocol: 'saved-places-v1', places: rows } }; },
    localStorage: { setItem: () => assert.fail('No browser persistence') }, sessionStorage: { setItem: () => assert.fail('No browser persistence') },
  });
  vm.runInContext(script, ctx);
  return { ctx, nodes, requests, scans, opened, notes, events, api: ctx.window.TLIPlaces };
}

test('favorites load only on request, render inert names, and open Files without scanning', async () => {
  const f = fixture([row({ name: '<img onerror=alert(1)>' })]); assert.equal(f.requests.length, 0);
  await f.api.open(); assert.equal(f.requests.length, 1); assert.match(content(f.nodes['places-list']), /<img onerror/);
  assert.ok(all(f.nodes['places-list']).every(n => n.innerHTML === undefined));
  await find(f, 'Open in Files').click();
  assert.equal(f.requests.length, 2); assert.deepEqual(f.opened, ['panel-files']); assert.equal(f.scans.length, 0);
  assert.equal(f.nodes.filesRootInput.value, 'N:\\Music'); assert.match(f.nodes['places-status'].textContent, /Choose Scan/);
});

test('folder favorites use the shared handoff and preserve conflicting draft paths', async () => {
  const f=fixture(),handoffs=[];f.nodes.filesRootInput.value='C:\\Current draft';
  f.ctx.window.TLIStorageWorkspace={prepare:intent=>{handoffs.push(intent);return{status:'draft-conflict'};}};
  await f.api.open();await find(f,'Open in Files').click();
  assert.equal(handoffs.length,1);assert.equal(handoffs[0].root,'N:\\Music');assert.equal(handoffs[0].view,'organize');
  assert.equal(f.nodes.filesRootInput.value,'C:\\Current draft');assert.equal(f.scans.length,0);assert.equal(f.requests.length,2);
  assert.match(f.nodes['places-status'].textContent,/draft was preserved/);
});

test('favorite panel options and navigation use the current shared catalogue labels', async () => {
  const navigation=[{id:'panel-dashboard2',label:'Home',kind:'panel'},{id:'panel-reports',label:'Saved reports',kind:'panel'},
    {id:'saved-notes',label:'Saved notes',kind:'shortcut'}];
  const f=fixture([row({kind:'panel',target:'panel-reports'})],{navigation});
  assert.deepEqual(f.nodes['places-panel'].children.map(node=>[node.value,node.textContent]),[['panel-dashboard2','Home'],['panel-reports','Saved reports']]);
  await f.api.open();await find(f,'Open').click();assert.deepEqual(f.opened,['panel-reports']);assert.equal(f.scans.length,0);
});

test('search opens and focuses the existing favorite without checking or executing its target', async () => {
  const f = fixture(); await f.api.openFavorite(row().id);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][1].method, 'GET');
  assert.equal(f.nodes['places-entry-' + row().id].focused, true);
  assert.equal(f.scans.length + f.opened.length + f.notes.length, 0);
  assert.match(f.nodes['places-status'].textContent, /location has not been checked/);
  await f.api.openFavorite('d'.repeat(32)); assert.match(f.nodes['places-status'].textContent, /no longer available/);
  assert.equal(f.requests.length, 2);
});

test('locking during a search-result open discards the late favorite list', async () => {
  const f = fixture(); let release;
  f.ctx.fetch = () => new Promise(r => { release = r; });
  const pending = f.api.openFavorite(row().id); f.events['tli-session-locked'].forEach(fn => fn());
  release({ ok: true, json: async () => ({ ok: true, protocol: 'saved-places-v1', places: [row()] }) }); await pending;
  assert.equal(f.nodes['places-dialog'].open, false); assert.equal(f.nodes['places-list'].children.length, 0);
  assert.equal(f.scans.length + f.opened.length + f.notes.length, 0);
});

test('Free Space navigation prepares a location once, with no scan claim or duplicate in-flight checks', async () => {
  const f = fixture(); await f.api.open(); let release;
  f.ctx.fetch = () => new Promise(r => { release = r; });
  const first = find(f, 'Review in Free Space').click(); await find(f, 'Review in Free Space').click();
  release({ ok: true, json: async () => ({ ok: true, revision: row().revision, status: 'available', checked_at: '2026-09-07T12:00:00Z', detail: 'Available' }) });
  await first;
  assert.deepEqual(f.scans, ['N:\\Music']); assert.match(f.nodes['places-status'].textContent, /Location prepared.*Choose Scan/);
});

test('unavailable and changed targets never navigate, scan or remove the favorite', async () => {
  for (const status of ['unavailable', 'unknown', 'changed']) {
    const f = fixture(); await f.api.open();
    f.ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: status === 'changed' ? 'd'.repeat(64) : row().revision, status: status === 'changed' ? 'available' : status, checked_at: '2026-09-07T12:00:00Z', detail: 'Drive disconnected. Favorite retained.' }) });
    await find(f, 'Review in Free Space').click();
    assert.equal(f.scans.length + f.opened.length, 0); assert.match(content(f.nodes['places-list']), /My drive/);
    assert.match(f.nodes['places-status'].textContent, status === 'changed' ? /changed/ : /retained/);
  }
});

test('saving never opens targets; failed edits retain drafts and duplicate saves are truthful', async () => {
  const f = fixture(); await f.api.open(); await find(f, 'Add favorite').click();
  f.nodes['places-name'].value = 'My drive again'; f.nodes['places-path'].value = 'N:\\Music';
  f.ctx.fetch = async () => ({ ok: false, status: 503, json: async () => ({ detail: 'Saved data unavailable' }) });
  await f.nodes['places-save'].click(); assert.equal(f.nodes['places-editor'].hidden, false); assert.equal(f.nodes['places-name'].value, 'My drive again');
  f.ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true, created: false, place: row(), message: 'This target is already saved.' }) });
  await f.nodes['places-save'].click(); assert.match(f.nodes['places-status'].textContent, /already saved/); assert.equal(f.scans.length + f.opened.length, 0);
});

test('removing a favorite requires explicit confirmation; failure preserves it without replay', async () => {
  const f = fixture(); await f.api.open(); await find(f, 'Remove favorite').click(); assert.equal(f.requests.length, 1);
  await find(f, 'Keep favorite').click(); assert.equal(f.requests.length, 1);
  await find(f, 'Remove favorite').click(); let attempts = 0;
  f.ctx.fetch = async () => { attempts++; return { ok: false, status: 409, json: async () => ({ detail: 'Favorite changed. Refresh.' }) }; };
  await find(f, 'Confirm removal').click(); assert.equal(attempts, 1); assert.match(content(f.nodes['places-list']), /My drive/);
});

test('editor controls cannot accept a newer draft while a save is pending', async () => {
  const f = fixture(); await f.api.open(); await find(f, 'Add favorite').click();
  f.nodes['places-name'].value = 'Drive'; f.nodes['places-path'].value = 'N:\\Music'; let release;
  f.ctx.fetch = () => new Promise(r => { release = r; }); const pending = f.nodes['places-save'].click();
  for (const id of ['places-name', 'places-path', 'places-kind', 'places-panel', 'places-note', 'places-save']) assert.equal(f.nodes[id].disabled, true);
  release({ ok: false, json: async () => ({ detail: 'Try again' }) }); await pending;
  assert.equal(f.nodes['places-name'].disabled, false); assert.equal(f.nodes['places-name'].value, 'Drive');
});

test('lock clears private UI and prevents late checks from opening a target', async () => {
  const f = fixture(); await f.api.open(); let release;
  f.ctx.fetch = () => new Promise(r => { release = r; }); const pending = find(f, 'Open in Files').click();
  f.events['tli-session-locked'].forEach(fn => fn());
  release({ ok: true, json: async () => ({ ok: true, revision: row().revision, status: 'available' }) }); await pending;
  assert.equal(f.opened.length, 0); assert.equal(f.nodes['places-dialog'].open, false); assert.equal(f.nodes['places-list'].children.length, 0);
});

test('closing cancels late navigation and clears a private removal confirmation', async () => {
  const f = fixture(); await f.api.open(); await find(f, 'Remove favorite').click();
  assert.match(content(f.nodes['places-remove']), /My drive/); let release;
  f.ctx.fetch = () => new Promise(r => { release = r; }); const pending = find(f, 'Open in Files').click();
  f.nodes['places-dialog'].open = false; await f.nodes['places-dialog'].fire('close');
  release({ ok: true, json: async () => ({ ok: true, revision: row().revision, status: 'available' }) }); await pending;
  assert.equal(f.opened.length, 0); assert.equal(f.nodes['places-remove'].children.length, 0);
});

test('note shortcut opens the currently checked revision without putting it into chat', async () => {
  const f = fixture([row({ kind: 'note', target: 'f-note' })]); await f.api.open(); await find(f, 'Open').click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.notes)), [{ id: 'f-note', revision: 'c'.repeat(64) }]); assert.equal(f.scans.length, 0);
});

test('Dashboard preview shows four bounded private favorites and never checks targets, scans, or opens notes', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => row({ id: String(i).repeat(32), name: i ? `Place ${i}` : '<img onerror=attack()>', kind: i === 1 ? 'note' : 'folder' }));
  const f = fixture(rows, { dashboard: true }); assert.equal(f.requests.length, 0); await f.api.refreshHome();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][1].method, 'GET'); assert.equal(f.nodes['places-home-list'].children.length, 4); assert.equal(f.nodes['places-home-count'].textContent, '4 of 7');
  assert.match(content(f.nodes['places-home-list']), /<img onerror=attack\(\)>/); assert.ok(all(f.nodes['places-home-list']).every(n => n.innerHTML === undefined));
  assert.equal(f.scans.length + f.opened.length + f.notes.length, 0);
  await f.nodes['places-home-list'].children[1].click(); assert.equal(f.requests.length, 2); assert.equal(f.requests[1][1].method, 'GET'); assert.equal(f.nodes['places-dialog'].open, true);
  assert.equal(f.scans.length + f.opened.length + f.notes.length, 0); assert.match(f.nodes['places-status'].textContent, /Choose Open or Scan/);
});

test('Dashboard entry triggers one metadata GET and duplicate refreshes share it', async () => {
  const f = fixture([row()], { dashboard: true }); let release;
  f.ctx.fetch = async (url, options) => { f.requests.push([url, options]); return new Promise(resolve => { release = resolve; }); };
  for (const fn of f.events['tli-panel-switched']) fn({ detail: { panelId: 'panel-dashboard2' } }); const duplicate = f.api.refreshHome();
  assert.equal(f.requests.length, 1); assert.equal(f.nodes['places-home-refresh'].disabled, true);
  release({ ok: true, json: async () => ({ ok: true, protocol: 'saved-places-v1', places: [row()] }) }); await duplicate;
  assert.equal(f.nodes['places-home-refresh'].disabled, false); assert.match(content(f.nodes['places-home-list']), /My drive/);
});

test('failed Dashboard refresh preserves previous favorites and observation time without empty success', async () => {
  const f = fixture([row()], { dashboard: true }); await f.api.refreshHome();
  f.ctx.fetch = async () => ({ ok: false, status: 503, json: async () => ({ detail: 'Saved data unavailable.' }) }); await f.api.refreshHome();
  assert.equal(f.nodes['places-home'].dataset.state, 'stale'); assert.match(content(f.nodes['places-home-list']), /My drive/); assert.match(f.nodes['places-home-status'].textContent, /Previous favorites from/);
  assert.doesNotMatch(content(f.nodes['places-home-list']), /No favorites/);
});

test('Dashboard preview clears on auth failure and never restores late metadata after session lock', async () => {
  const f = fixture([row()], { dashboard: true }); await f.api.refreshHome();
  f.ctx.fetch = async () => ({ ok: false, status: 401, json: async () => ({ detail: 'Unlock TLI.' }) }); await f.api.refreshHome(); assert.equal(f.nodes['places-home-list'].children.length, 0); assert.equal(f.nodes['places-home-count'].textContent, '');
  let release; f.ctx.fetch = () => new Promise(resolve => { release = resolve; }); const pending = f.api.refreshHome();
  for (const fn of f.events['tli-session-locked']) fn(); release({ ok: true, json: async () => ({ ok: true, protocol: 'saved-places-v1', places: [row()] }) }); await pending;
  assert.equal(f.nodes['places-home-list'].children.length, 0); assert.equal(f.nodes['places-home-refresh'].disabled, false); assert.equal(f.scans.length + f.opened.length + f.notes.length, 0);
});

test('closing the existing manager preserves Dashboard favorites and does not strand a pending preview read', async () => {
  const f = fixture([row()], { dashboard: true }); await f.api.refreshHome(); await f.api.open();
  let release; f.ctx.fetch = () => new Promise(resolve => { release = resolve; }); const pending = f.api.refreshHome();
  f.nodes['places-dialog'].open = false; await f.nodes['places-dialog'].fire('close'); assert.match(content(f.nodes['places-home-list']), /My drive/);
  release({ ok: true, json: async () => ({ ok: true, protocol: 'saved-places-v1', places: [row({ name: 'Current drive' })] }) }); await pending;
  assert.match(content(f.nodes['places-home-list']), /Current drive/); assert.equal(f.nodes['places-home-refresh'].disabled, false); assert.equal(f.nodes['places-list'].children.length, 0);
});

test('a late Dashboard read cannot overwrite newer metadata loaded in the existing manager', async () => {
  const f = fixture([row()], { dashboard: true }); await f.api.refreshHome(); let release, reads = 0;
  f.ctx.fetch = () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, json: async () => ({ ok: true, protocol: 'saved-places-v1', places: [row({ name: 'New name' })] }) });
  const old = f.api.refreshHome(); await f.api.open(); release({ ok: true, json: async () => ({ ok: true, protocol: 'saved-places-v1', places: [row({ name: 'Old name' })] }) }); await old;
  assert.match(content(f.nodes['places-home-list']), /New name/); assert.doesNotMatch(content(f.nodes['places-home-list']), /Old name/);
});
