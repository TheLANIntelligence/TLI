/* Explicit shortcuts, backed by encrypted owner-scoped favorites on the host. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { rows: [], busy: false, epoch: 0, checks: new Map(), editing: null };
  const home = { rows: [], loaded: false, busy: false, opening: false, failed: false, checkedAt: null, epoch: 0, request: 0, pending: null };
  const fallbackPanels = { 'panel-dashboard2': 'Dashboard', 'panel-main': 'AI Chat', 'panel-files': 'Files', 'panel-visualizer': 'Free Space', 'panel-settings': 'Settings', 'panel-devices': 'Devices' };
  const panels = () => Array.isArray(window.TLIUI?.navigation) ? Object.fromEntries(window.TLIUI.navigation
    .filter(item => item.kind !== 'shortcut' && /^panel-[a-z0-9-]+$/.test(item.id) && typeof item.label === 'string')
    .map(item => [item.id,item.label])) : fallbackPanels;
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, fn) => { const b = node('button', text, 'btn-outline'); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const option = (value, text) => { const o = node('option', text); o.value = value; return o; };
  const field = (title, input) => { const n = node('label', null, 'places-field'); n.append(node('span', title), input); return n; };
  const status = text => { $('places-status').textContent = text; };
  function busy(value) {
    state.busy = value; $('places-dialog').setAttribute('aria-busy', String(value));
    for (const id of ['places-name', 'places-path', 'places-kind', 'places-panel', 'places-note', 'places-save']) if ($(id)) $(id).disabled = value;
  }
  async function api(path = '', method = 'GET', body, extra = {}) {
    const epoch = home.epoch;
    const r = await fetch('/api/intelligence/places' + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra });
    if (r.status === 401 && epoch === home.epoch) clear();
    const result = await r.json();
    if (!r.ok || result.ok !== true) throw new Error(typeof result.detail === 'string' ? result.detail : 'Saved places request failed. Try again explicitly.');
    return result;
  }
  async function run(fn) {
    if (state.busy) return;
    busy(true); const epoch = state.epoch;
    try { await fn(() => epoch === state.epoch && $('places-dialog').open); }
    catch (e) { if (epoch === state.epoch) status(e.message || 'Saved places request failed.'); }
    finally { if (epoch === state.epoch) busy(false); }
  }
  function clear({ keepDashboard = false } = {}) {
    state.epoch++; state.rows = []; state.checks.clear(); state.editing = null; busy(false);
    $('places-list')?.replaceChildren(); $('places-name').value = ''; $('places-path').value = ''; $('places-note').replaceChildren();
    $('places-remove')?.replaceChildren(); $('places-remove').hidden = true;
    $('places-editor').hidden = true; if ($('places-dialog').open) $('places-dialog').close(); status('');
    if (!keepDashboard) {
      home.epoch++; home.request++; home.rows = []; home.loaded = false; home.checkedAt = null; home.failed = true; home.busy = false; home.opening = false; home.pending = null;
      renderHome('Unlock TLI, then refresh your saved places.');
    }
  }
  async function load(current) {
    const result = await api(); if (!current()) return;
    if (result.protocol !== 'saved-places-v1' || !Array.isArray(result.places)) throw new Error('This host does not support saved places.');
    state.rows = result.places; state.checks.clear(); render(); adoptHomeRows(state.rows); status(`${state.rows.length} saved places. Locations are checked only when you ask.`);
  }
  function navigate(panel) {
    if (typeof switchPanel !== 'function') throw new Error('Panel navigation is unavailable. Refresh TLI and try again.');
    switchPanel(panel);
  }
  async function visit(row, action, current) {
    const checked = await api('/' + encodeURIComponent(row.id) + '/check', 'POST');
    if (!current()) return;
    if (checked.revision !== row.revision) throw new Error('This favorite changed. Refresh before opening it.');
    state.checks.set(row.id, checked); render(); status(checked.detail);
    if (action === 'check' || checked.status !== 'available') return;
    if (row.kind === 'panel') { if (!panels()[row.target]) throw new Error('This panel is unavailable.'); navigate(row.target); }
    else if (row.kind === 'note') {
      if (!window.TLINotebook?.open || !checked.note) throw new Error('Notes & fixes is unavailable.');
      $('places-dialog').close(); await window.TLINotebook.open(checked.note, { source: 'saved_place' }); return;
    } else if (window.TLIStorageWorkspace?.prepare) {
      const result = window.TLIStorageWorkspace.prepare({view:action === 'scan' ? 'space' : 'organize',root:row.target,source:'saved-place'});
      if (result.status === 'unavailable') throw new Error('This folder could not be prepared. Finish current file work and try again.');
      status(result.status === 'draft-conflict' ? 'Your current draft was preserved. Review the requested folder in Files & Storage.' : 'Location prepared. Choose Scan to inspect its files.');
    } else if (action === 'scan') {
      if (!window.TLIVisualizer?.scanPath) throw new Error('Free Space is unavailable.');
      navigate('panel-visualizer'); window.TLIVisualizer.scanPath(row.target);
      status('Location prepared in Free Space. Choose Scan to inspect it.');
    } else {
      const input = $('filesRootInput'); if (!input) throw new Error('Files is unavailable.');
      navigate('panel-files'); input.value = row.target;
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      status('Path opened in Files. Choose Scan to list its contents.'); input.focus();
    }
    $('places-dialog').close();
  }
  function render() {
    const list = $('places-list'); list.replaceChildren();
    if (!state.rows.length) list.append(node('p', 'No favorites yet. Save a folder, drive, note from Notes & fixes or TLI panel.'));
    state.rows.forEach(row => {
      const card = node('article', null, 'places-card'), actions = node('div', null, 'places-actions');
      card.id = 'places-entry-' + row.id; card.tabIndex = -1;
      card.append(node('h3', row.name), node('p', row.kind === 'note' ? 'note from Notes & fixes' : row.target, 'places-target'));
      const check = state.checks.get(row.id);
      card.append(node('p', check ? `${check.status} · ${check.detail} Checked ${new Date(check.checked_at).toLocaleTimeString()}` : 'Not checked this visit.', 'places-check'));
      actions.append(button(row.kind === 'folder' ? 'Open in Files' : 'Open', () => run(c => visit(row, 'open', c))));
      if (row.kind === 'folder') actions.append(button('Review in Free Space', () => run(c => visit(row, 'scan', c))));
      actions.append(button('Check', () => run(c => visit(row, 'check', c))), button('Rename', () => edit(row)), button('Remove favorite', () => remove(row)));
      card.append(actions); list.append(card);
    });
  }
  function edit(row) {
    if (state.busy) return;
    state.editing = row || null; $('places-editor').hidden = false; $('places-name').value = row?.name || '';
    $('places-kind-field').hidden = !!row; $('places-target-fields').hidden = !!row;
    $('places-save').textContent = row ? 'Save name' : 'Save favorite'; $('places-name').focus();
  }
  function remove(row) {
    if (state.busy) return;
    const box = $('places-remove'); box.replaceChildren(); box.hidden = false;
    box.append(node('p', `Remove “${row.name}” from favorites? Its files, note or panel will be kept.`),
      button('Keep favorite', () => { box.hidden = true; }),
      button('Confirm removal', () => run(async current => {
        await api('/' + encodeURIComponent(row.id) + '?expected_revision=' + encodeURIComponent(row.revision), 'DELETE');
        if (!current()) return;
        state.rows = state.rows.filter(p => p.id !== row.id); box.hidden = true; render(); adoptHomeRows(state.rows); status('Favorite removed. Its target was kept.');
      })));
  }
  async function save(current) {
    const name = $('places-name').value.trim(), editing = state.editing;
    if (!name) throw new Error('Enter a name for this favorite.');
    const kind = $('places-kind').value;
    const target = kind === 'folder' ? $('places-path').value.trim() : kind === 'panel' ? $('places-panel').value : $('places-note').value;
    const result = editing ? await api('/' + encodeURIComponent(editing.id), 'PATCH', { name, expected_revision: editing.revision }) : await api('', 'POST', { name, kind, target });
    if (!current()) return;
    state.rows = [...state.rows.filter(p => p.id !== result.place.id), result.place]; state.editing = null; state.checks.delete(result.place.id);
    $('places-editor').hidden = true; $('places-name').value = ''; $('places-path').value = ''; render(); adoptHomeRows(state.rows); status(result.message || 'Favorite name saved.');
  }
  function kindChanged() {
    const kind = $('places-kind').value;
    for (const name of ['folder', 'panel', 'note']) $('places-' + name + '-field').hidden = name !== kind;
    if (kind !== 'note') return;
    run(async current => {
      const r = await fetch('/api/intelligence/memory', { cache: 'no-store' }); if (r.status === 401) clear();
      const data = await r.json(); if (!current()) return;
      if (!r.ok || !Array.isArray(data.facts)) throw new Error('Notes & fixes could not be loaded.');
      const notes = data.facts.filter(n => typeof n.id === 'string' && /^[A-Za-z0-9_-]{1,240}$/.test(n.id) && !n.id.startsWith('device-'));
      $('places-note').replaceChildren(option('', 'Choose a note'));
      notes.forEach(n => $('places-note').append(option(n.id, n.title || 'Untitled note')));
      status(notes.length ? 'Choose a note from your current TLI account.' : 'No notes yet. Add one in Notes & fixes first.');
    });
  }
  function open(path) {
    if (!$('places-dialog').open) $('places-dialog').showModal();
    if (typeof path === 'string') { edit(); $('places-kind').value = 'folder'; kindChanged(); $('places-path').value = path; }
    return run(load);
  }
  async function openFavorite(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id)) throw new Error('This favorite is unavailable. Search again.');
    if (state.busy) throw new Error('Finish the current Favorites request before opening a search result.');
    if (!$('places-dialog').open) $('places-dialog').showModal();
    return run(async current => {
      await load(current); if (!current()) return;
      const row = state.rows.find(item => item.id === id);
      if (!row) { status('This favorite is no longer available. Search again for current results.'); return; }
      const card = $('places-entry-' + id); card?.scrollIntoView?.({ block: 'nearest' }); card?.focus();
      status('Favorite selected from search. Choose Open or Scan when ready; its location has not been checked.');
    });
  }
  function adoptHomeRows(rows) {
    if (!$('places-home-list')) return;
    home.request++; home.rows = [...rows]; home.loaded = true; home.failed = false; home.busy = false; home.checkedAt = Date.now(); home.pending = null; renderHome();
  }
  function renderHome(message = '') {
    const list = $('places-home-list'), card = $('places-home'); if (!list || !card) return;
    card.setAttribute('aria-busy', String(home.busy));
    card.dataset.state = home.busy ? 'loading' : home.failed ? home.loaded ? 'stale' : 'unavailable' : home.loaded ? 'ready' : 'empty';
    $('places-home-refresh').disabled = home.busy;
    list.replaceChildren();
    if (home.loaded && home.rows.length) {
      home.rows.slice(0, 4).forEach(row => {
        const review = button('', async () => {
          if (home.opening || state.busy) return;
          home.opening = true; review.disabled = true;
          try { await openFavorite(row.id); }
          catch (error) { $('places-home-status').textContent = error.message || 'This favorite could not be opened.'; }
          finally { home.opening = false; review.disabled = false; }
        });
        review.className = 'places-home-entry'; review.setAttribute('aria-label', 'Review favorite: ' + row.name);
        const text = node('span', null, 'places-home-entry-text');
        text.append(node('strong', row.name, 'places-home-name'), node('span', row.kind === 'folder' ? row.target : row.kind === 'panel' ? (panels()[row.target] || 'TLI panel') : 'Saved note', 'places-home-target'));
        review.append(node('span', row.kind === 'folder' ? 'Folder' : row.kind === 'note' ? 'Note' : 'Panel', 'places-home-kind'), text, node('span', '›', 'places-home-arrow'));
        list.append(review);
      });
    } else if (home.loaded) list.append(node('p', 'Save a folder, drive, note or TLI panel to return here quickly.', 'places-home-empty'));
    else if (!home.busy && !home.failed) list.append(node('p', 'Open Dashboard or choose Refresh to load your private favorites.', 'places-home-empty'));
    $('places-home-count').textContent = home.loaded ? home.rows.length > 4 ? `4 of ${home.rows.length}` : String(home.rows.length) : '';
    $('places-home-status').textContent = message || (home.busy ? 'Loading saved places…' : home.loaded ? `Checked ${new Date(home.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Select a favorite to review it.` : '');
  }
  async function refreshHome() {
    if (!$('places-home-list')) return;
    if (home.pending) return home.pending;
    const epoch = home.epoch, request = ++home.request; home.busy = true; renderHome();
    const pending = (async () => {
      try {
        const result = await api('', 'GET', undefined, typeof AbortSignal !== 'undefined' ? { signal: AbortSignal.timeout(10000) } : {});
        if (epoch !== home.epoch || request !== home.request) return;
        if (result.protocol !== 'saved-places-v1' || !Array.isArray(result.places) || !result.places.every(row => row && typeof row.id === 'string' && /^[a-f0-9]{32}$/i.test(row.id) && typeof row.name === 'string' && typeof row.target === 'string' && ['folder', 'panel', 'note'].includes(row.kind))) throw new Error('This host returned an incomplete saved places list.');
        home.rows = result.places; home.loaded = true; home.failed = false; home.checkedAt = Date.now(); home.busy = false; renderHome();
      } catch (error) {
        if (epoch !== home.epoch || request !== home.request) return;
        home.failed = true; home.busy = false;
        const previous = home.loaded ? ` Previous favorites from ${new Date(home.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} are still shown.` : '';
        renderHome((error.message || 'Saved places could not be loaded.') + previous);
      } finally { if (home.pending === pending) home.pending = null; }
    })();
    home.pending = pending; return pending;
  }
  function initHome() {
    const mount = $('dashboard-places-mount'); if (!mount) return;
    const card = node('section', null, 'places-home'); card.id = 'places-home'; card.setAttribute('aria-labelledby', 'places-home-title');
    const heading = node('div', null, 'places-home-heading'), title = node('h2', 'Saved places'); title.id = 'places-home-title';
    const count = node('span', '', 'places-home-count'); count.id = 'places-home-count'; heading.append(title, count);
    const list = node('div', null, 'places-home-list'); list.id = 'places-home-list';
    const message = node('p', '', 'places-home-status'); message.id = 'places-home-status'; message.setAttribute('role', 'status');
    const actions = node('div', null, 'places-home-actions'), refresh = button('Refresh', refreshHome); refresh.id = 'places-home-refresh';
    actions.append(button('Manage saved places', () => open()), refresh);
    card.append(heading, node('p', 'Your private shortcuts. Locations are checked only when you ask.', 'places-home-intro'), list, message, actions); mount.append(card); renderHome();
    document.addEventListener?.('tli-panel-switched', event => { if (event.detail?.panelId === 'panel-dashboard2') refreshHome(); });
    if ($('panel-dashboard2') && !$('panel-dashboard2').hidden) refreshHome();
  }
  function init() {
    const dialog = node('dialog', null, 'places-dialog'); dialog.id = 'places-dialog'; dialog.setAttribute('aria-labelledby', 'places-title');
    const title = node('h2', 'Saved places'); title.id = 'places-title';
    const tools = node('div', null, 'places-actions'); tools.append(button('Add favorite', () => edit()), button('Refresh', () => run(load)), button('Close', () => dialog.close()));
    const message = node('p'); message.id = 'places-status'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const editor = node('section', null, 'places-editor'); editor.id = 'places-editor'; editor.hidden = true;
    const name = node('input'); name.id = 'places-name'; name.maxLength = 120;
    const kind = node('select'); kind.id = 'places-kind'; kind.append(option('folder', 'Folder or drive'), option('note', 'note from Notes & fixes'), option('panel', 'TLI panel')); kind.value = 'folder'; kind.addEventListener('change', kindChanged);
    const kindField = field('Type', kind); kindField.id = 'places-kind-field';
    const targets = node('div'); targets.id = 'places-target-fields';
    const path = node('input'); path.id = 'places-path'; path.maxLength = 2048; path.placeholder = 'Absolute path on the TLI host';
    const pathField = field('Host folder or mapped drive path', path); pathField.id = 'places-folder-field';
    const panel = node('select'); panel.id = 'places-panel'; Object.entries(panels()).forEach(([id, label]) => panel.append(option(id, label))); panel.value = 'panel-dashboard2';
    const panelField = field('Panel', panel); panelField.id = 'places-panel-field'; panelField.hidden = true;
    const note = node('select'); note.id = 'places-note'; const noteField = field('note from Notes & fixes', note); noteField.id = 'places-note-field'; noteField.hidden = true;
    targets.append(pathField, panelField, noteField);
    const saveButton = button('Save favorite', () => run(save)); saveButton.id = 'places-save';
    editor.append(field('Name', name), kindField, targets, saveButton, button('Cancel edit', () => { if (!state.busy) { editor.hidden = true; state.editing = null; } }));
    const removeBox = node('section', null, 'places-editor'); removeBox.id = 'places-remove'; removeBox.hidden = true;
    const list = node('div', null, 'places-list'); list.id = 'places-list';
    dialog.append(title, node('p', 'Private favorites saved on this host. Saving a location does not open, scan or change it.'), tools, message, editor, removeBox, list); document.body.append(dialog);
    dialog.addEventListener('close', () => { if (!dialog.open) clear({ keepDashboard: true }); });
    initHome();
    for (const id of ['panel-files', 'panel-visualizer']) {
      const host = $(id); if (!host) continue;
      const bar = node('div', null, 'places-shortcuts'); bar.append(button('Saved places', () => open()));
      if (id === 'panel-files') bar.append(button('Save this path', () => open($('filesRootInput')?.value || '')));
      const mount = id === 'panel-visualizer' ? $('fs-saved-places') : null;
      if (mount) mount.append(bar); else host.prepend(bar);
    }
    window.addEventListener('tli-session-locked', clear); window.addEventListener('pagehide', clear);
  }
  window.TLIPlaces = { open, openFavorite, clear, refreshHome };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
