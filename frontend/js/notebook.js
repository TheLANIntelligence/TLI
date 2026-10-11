/* Private, explicitly saved notes on the existing chat and memory surfaces. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { notes: [], devices: [], selected: [], loaded: false, epoch: 0, read: 0, busy: false, editor: null,
    editing: false, baseline: null, drafts: new Map(), openTicket: 0 };
  const requests = new WeakMap();
  const contextChanged = () => window.dispatchEvent?.(new CustomEvent('tli-chat-context-changed'));
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const title = note => note.title || 'Untitled note';
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
  const confirmed = note => note.source === 'user_confirmation' && note.category === 'verified_fix';
  const source = note => confirmed(note) ? 'User-confirmed fix' : note.source === 'chat_ai' ? 'Saved TLI/AI reply · unconfirmed' : note.source === 'chat_user' ? 'Saved user statement' : note.source === 'legacy_device' ? 'Earlier device memory' : note.source === 'user_confirmation' ? 'User-confirmed note' : note.source === 'user' ? 'User-saved note' : !note.source || note.source === 'user_memory' ? 'Saved memory · source not recorded' : 'Saved memory · source unknown';
  const reference = note => ({ id: note.id, revision: note.revision });
  const validRef = note => typeof note?.id === 'string' && note.id.length > 0 && note.id.length <= 256 && typeof note.revision === 'string' && /^[a-f0-9]{64}$/.test(note.revision);
  const query = () => '?client_device_id=' + encodeURIComponent(typeof currentDeviceId !== 'undefined' ? currentDeviceId || 'dev-browser' : 'dev-browser');
  function message(text) { if ($('notebook-status')) $('notebook-status').textContent = text; }
  function button(text, fn, cls = 'btn-outline') {
    const b = node('button', text, cls); b.type = 'button'; b.addEventListener('click', fn); return b;
  }
  function field(label, input) { const wrap = node('label', null, 'notebook-field'); wrap.append(node('span', label), input); return wrap; }
  function option(value, text) { const o = node('option', text); o.value = value; return o; }
  function starterButtons() {
    const starters = node('div', null, 'notebook-starters');
    for (const [label, values] of [
      ['Setup detail', {title:'My setup', text:'Computer or device:\nUseful setup details:\n', category:'general'}],
      ['Preference', {title:'My preference', text:'When helping me with:\nI prefer:\n', category:'preference'}],
      ['Fix to remember', {title:'Fix to remember', text:'What went wrong:\nWhat I changed:\nWhat happened next:\n', category:'general'}],
    ]) starters.append(button(label, () => edit(null, values)));
    return starters;
  }
  async function api(path = '', method = 'GET', body) {
    const response = await fetch('/api/intelligence/memory' + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401) clear();
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `Notes & fixes request failed (${response.status}).`);
    return result;
  }
  function clear() {
    state.epoch++; state.read++; state.openTicket++; state.notes = []; state.devices = []; state.selected = []; state.loaded = false; state.busy = false; state.editor = null;
    state.editing = false; state.baseline = null; state.drafts.clear(); $('notebook-drafts')?.replaceChildren();
    $('notebook-list')?.replaceChildren(); $('notebook-editor')?.replaceChildren();
    if ($('notebook-search')) $('notebook-search').value = '';
    for (const id of ['notebook-kind', 'notebook-filter-device', 'notebook-after']) if ($(id)) $(id).value = '';
    if ($('notebook-refresh')) $('notebook-refresh').disabled = false;
    if ($('notebook-dialog')?.open) $('notebook-dialog').close();
    message(''); renderSelected();
  }
  function currentStatus(selected) {
    if (!state.loaded) return '';
    const current = state.notes.find(n => n.id === selected.id);
    return !current ? 'No longer available. Remove this selection.' : current.revision !== selected.revision ? 'Changed since selection. Open Notes & fixes and select the current version.' : '';
  }
  function renderSelected() {
    contextChanged();
    const box = $('notebook-selected'); if (!box) return;
    box.hidden = state.selected.length === 0; box.replaceChildren();
    if (!state.selected.length) return;
    box.append(node('strong', `Notes for your next question (${state.selected.length}/4)`), node('p', 'Only these selected notes and your next question will be provided. Earlier conversation and other saved notes are not included. These are saved context, not measured evidence. Ask about them on their own; remove selected notes or any image, device, report, document or Vault context before sending. No actions run in this mode.'));
    state.selected.forEach(n => {
      const row = node('div', null, 'notebook-selected-row');
      row.append(node('span', `${title(n)} · ${date(n.updated_at)}${currentStatus(n) ? ' · ' + currentStatus(n) : ''}`), button('Remove ' + title(n), () => { state.selected = state.selected.filter(x => x.id !== n.id); renderSelected(); }));
      box.append(row);
    });
    box.append(button('Review notes', () => open()));
  }
  function useNote(note) {
    rememberDraft();
    if (state.drafts.has(note.id)) { message('This note has unsaved changes. Save or discard its draft before selecting it for your next question.'); return; }
    if (!validRef(note) || note.id.startsWith('device-')) { message('Edit and save this earlier device memory before selecting it for chat.'); return; }
    if (!state.selected.some(n => n.id === note.id) && state.selected.length >= 4) { message('Choose up to four notes. Remove a selection before adding another.'); return; }
    state.selected = [...state.selected.filter(n => n.id !== note.id), { ...reference(note), title: title(note), updated_at: note.updated_at }];
    renderSelected(); $('notebook-dialog').close();
    if (typeof switchPanel === 'function') switchPanel('panel-main');
    else document.querySelector('[data-panel-target="panel-main"]')?.click();
    $('chat-input')?.focus();
  }
  function linkedNotes(note) {
    if(state.busy)return;
    rememberDraft();
    if(state.drafts.has(note.id)){message('This note has unsaved changes. Save or discard its draft before reviewing linked notes.');return;}
    if(!validRef(note)||note.id.startsWith('device-')){message('Save this earlier device memory as a current note before adding relationships.');return;}
    if(!window.TLINoteLinks){message('Linked notes are unavailable in this browser. Refresh TLI to load the matching interface.');return;}
    close();window.TLINoteLinks.open(reference(note));
  }
  function renderList() {
    const list = $('notebook-list'); if (!list) return;
    const term = $('notebook-search').value.trim().toLocaleLowerCase();
    const kind = $('notebook-kind')?.value, device = $('notebook-filter-device')?.value, after = $('notebook-after')?.value;
    const notes = state.notes.filter(n => (!kind || (kind === 'fixes' ? confirmed(n) : n.source === kind)) && (!device || n.device_id === device) &&
      (!after || (Number.isFinite(Date.parse(n.updated_at)) && Date.parse(n.updated_at) >= Date.parse(after + 'T00:00:00'))) &&
      [title(n), n.text, n.category, source(n), n.device_id, n.created_at, n.updated_at, state.devices.find(d => d.id === n.device_id)?.name].filter(Boolean).join(' ').toLocaleLowerCase().includes(term));
    list.replaceChildren();
    if (!notes.length) {
      if (state.notes.length) list.append(node('p', 'No notes match your search.'));
      else if (!state.loaded) list.append(node('p', 'Open or refresh your notes to check what is saved.'));
      else {
        const empty = node('section', null, 'notebook-empty');
        empty.append(node('h3', 'Keep the details you would otherwise have to explain again.'), node('p', 'Start with a setup detail, a preference or a fix you want to remember. These examples open drafts; nothing is saved or sent to AI.'));
        empty.append(starterButtons()); list.append(empty);
      }
    }
    notes.forEach(note => {
      const card = node('article', null, 'notebook-card');
      card.append(node('h3', title(note)), node('p', `${source(note)} · ${note.category || 'general'} · Updated ${date(note.updated_at)}`, 'notebook-meta'),
        node('p', note.device_id ? 'Associated device: ' + (state.devices.find(d => d.id === note.device_id)?.name || note.device_id) : 'No device association', 'notebook-meta'), node('p', note.text, 'notebook-text'));
      const actions = node('div', null, 'notebook-actions');
      if (confirmed(note)) card.append(node('p', 'Confirmed when this fix was saved. It does not establish current device health.', 'notebook-meta'));
      const use = button('Use for next question', () => useNote(note)); use.disabled = note.id.startsWith('device-') || !validRef(note);
      actions.append(button('Edit ' + title(note), () => edit(note)), use);
      if (!note.id.startsWith('device-') && validRef(note)) actions.append(button('Linked notes…',()=>linkedNotes(note)),button('Link to a problem…', () => { close(); return window.TLITroubleshooting?.offerEvidence({ kind: 'note', id: note.id }); }));
      if (note.id.startsWith('device-')) card.append(node('p', 'Edit and save to convert this earlier device memory into a note you can select for chat.'));
      card.append(actions); list.append(card);
    });
  }
  function fillDevices(control, selected = '') {
    control.replaceChildren(option('', 'No device association'));
    state.devices.forEach(d => control.append(option(d.id, d.name)));
    if (selected && !state.devices.some(d => d.id === selected)) control.append(option(selected, selected + ' (not in current inventory)'));
    control.value = selected;
  }
  async function load() {
    const epoch = state.epoch, read = ++state.read;
    message('Loading your notes…'); $('notebook-refresh').disabled = true;
    try {
      const data = await api(query());
      if (epoch !== state.epoch || read !== state.read) return false;
      if (!Array.isArray(data.facts)) throw new Error('TLI did not return a readable notes list.');
      state.notes = data.facts; state.loaded = true;
      message(''); renderList(); renderSelected(); renderDrafts();
      return true;
    } catch (e) { if (epoch === state.epoch && read === state.read) message(e.message + (state.loaded ? ' Previously loaded notes may be out of date.' : 'Your notes could not be loaded.')); return false; }
    finally { if (epoch === state.epoch && read === state.read) $('notebook-refresh').disabled = false; }
  }
  async function loadDevices() {
    const epoch = state.epoch;
    try {
      const response = await fetch('/api/intelligence/devices', { cache: 'no-store' });
      if (response.status === 401) { clear(); return; }
      if (!response.ok) return;
      const data = await response.json();
      if (epoch !== state.epoch) return;
      state.devices = Array.isArray(data.devices) ? data.devices : []; renderList();
      fillFilterDevices();
      if (!$('notebook-editor').hidden && $('notebook-device')) fillDevices($('notebook-device'), $('notebook-device').value);
    } catch (_) { /* Notes remain readable without device inventory. */ }
  }
  async function open(receipt, options = {}) {
    const dialog = $('notebook-dialog'); if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    if (state.busy) { message('Wait for the current save or deletion to finish.'); return; }
    showBrowser();
    const epoch = state.epoch, ticket = ++state.openTicket;
    loadDevices();
    const loaded = await load();
    fillFilterDevices();
    if (epoch !== state.epoch || ticket !== state.openTicket || !loaded || !receipt) return;
    const note = state.notes.find(n => n.id === receipt.id);
    if (!note) { message(options.source === 'note_link' ? 'This linked note is no longer available. The saved relationship remains a historical reference.' : options.source === 'search' ? 'This saved note is no longer available. Search again for current results.' : options.source === 'saved_place' ? 'This note is no longer available. Its favorite is retained in Saved places.' : 'This note is no longer available. The chat receipt records the version provided at that time.'); return; }
    edit(note);
    if (state.drafts.has(note.id)) { message('Your unsaved draft is open. The saved note has not been replaced or added to chat.'); return; }
    message(options.source === 'note_link' ? 'Opened the current saved note from a relationship. It has not been added to Chat.' : options.source === 'search' ? 'Opened the current saved note from search. It has not been added to chat.' : options.source === 'saved_place' ? 'You are viewing the current saved note from your favorite.' : note.revision === receipt.revision ? 'This is the version recorded in that chat receipt.' : 'This note has changed since that chat. You are viewing the current saved version.');
  }
  function formValues() {
    return { title: $('notebook-title')?.value || '', text: $('notebook-text')?.value || '',
      category: $('notebook-category')?.value || 'general', device_id: $('notebook-device')?.value || '' };
  }
  function rememberDraft() {
    if (!state.editing || !state.baseline) return;
    const values = formValues(), key = state.editor?.id || 'new';
    if (JSON.stringify(values) !== JSON.stringify(state.baseline)) state.drafts.set(key, { note: state.editor ? {...state.editor} : null, values });
    else state.drafts.delete(key);
  }
  function showBrowser() {
    rememberDraft(); state.editing = false; state.editor = null; state.baseline = null;
    $('notebook-editor').hidden = true; $('notebook-browser').hidden = false;
    renderList(); renderDrafts(); message('');
  }
  function close() {
    if (state.busy) { message('Wait for this save or deletion to finish before closing.'); return; }
    rememberDraft(); state.openTicket++; $('notebook-dialog')?.close();
  }
  function renderDrafts() {
    const area = $('notebook-drafts'); if (!area) return;
    area.replaceChildren(); area.hidden = state.drafts.size === 0;
    if (!state.drafts.size) return;
    area.append(node('h3', 'Unfinished notes'), node('p', 'Drafts stay in this open page until you save or discard them. Locking TLI or leaving the page clears them.', 'notebook-meta'));
    for (const [key, draft] of state.drafts) {
      const row = node('article', null, 'notebook-draft-row');
      const review = node('div', null, 'notebook-delete-review'); review.hidden = true;
      const name = draft.values.title || draft.note?.title || 'New note';
      review.append(node('p', `Discard the unsaved draft for “${name}”? Its saved note, if any, will stay unchanged.`),
        button('Discard this draft', () => { state.drafts.delete(key); renderDrafts(); message('Draft discarded. Saved notes are unchanged.'); }, 'btn-outline notebook-danger'),
        button('Keep draft', () => { review.hidden = true; }));
      row.append(node('strong', name), button('Resume draft', () => edit(draft.note)),
        button('Discard draft…', () => { review.hidden = false; }), review); area.append(row);
    }
  }
  function edit(note = null, starter = null) {
    if (state.busy) return;
    rememberDraft(); state.openTicket++;
    const draft = state.drafts.get(note?.id || 'new');
    if (draft) note = draft.note;
    state.editor = note ? { ...note } : null;
    const original = { title: note?.title || '', text: note?.text || '',
      category: note?.category === 'legacy_device' ? 'general' : note?.category || 'general', device_id: note?.device_id || '' };
    const values = draft?.values || (starter ? {...original, ...starter} : original);
    state.baseline = original; state.editing = true;
    const box = $('notebook-editor'); box.replaceChildren(); box.hidden = false; $('notebook-browser').hidden = true; message('');
    const heading = node('h3', note ? 'Edit note' : 'Add a note');
    if (!note && !draft && !starter) box.append(node('p', 'Start with an example, or write your own note. Nothing is saved until you choose Save note.', 'notebook-meta'), starterButtons());
    const name = node('input'); name.id = 'notebook-title'; name.value = values.title; name.maxLength = 120;
    const text = node('textarea'); text.id = 'notebook-text'; text.value = values.text; text.maxLength = 2000; text.rows = 7;
    const category = node('select'); category.id = 'notebook-category';
    category.append(option('general', 'General'), option('preference', 'Preference'), option('device', 'Device'));
    if (note?.category && !['general', 'preference', 'device', 'legacy_device'].includes(note.category)) category.append(option(note.category, note.category));
    category.value = values.category;
    const device = node('select'); device.id = 'notebook-device'; fillDevices(device, values.device_id);
    for (const control of [name, text, category, device]) control.addEventListener('input', rememberDraft);
    const actions = node('div', null, 'notebook-actions');
    const save = button('Save note', () => saveEdit()); save.id = 'notebook-save';
    const back = button('Back to notes', () => { if (!state.busy) showBrowser(); }); back.id = 'notebook-back';
    actions.append(save, back);
    if(note&&!note.id.startsWith('device-')&&validRef(note))actions.append(button('Linked notes…',()=>linkedNotes(note)));
    box.append(heading, node('p', 'Save details you want to refer to again. They are your context, not system measurements.'), field('Title (optional)', name), field('Note', text), field('Category', category), field('Associated device (optional)', device));
    if (starter && !draft) box.append(node('p', 'This is an unsaved starting point. Replace the prompts with your own details. Saving a fix note does not mark it as a verified diagnostic fix.', 'notebook-meta'));
    if (draft) box.append(node('p', 'Your unsaved draft is retained. It has not been provided to AI.', 'notebook-meta'));
    if (draft?.note && state.notes.find(n => n.id === note.id)?.revision !== note.revision) box.append(node('p', 'The saved version changed or is no longer available. Your original draft and version are preserved; review the saved note before replacing anything.', 'notebook-meta'));
    if (note) {
      box.append(node('p', `${source(note)} · Created ${date(note.created_at)} · Updated ${date(note.updated_at)}${note.report_id ? ' · Linked to a saved diagnostic report' : ''}`, 'notebook-meta'));
      if (note.chat_source) box.append(node('p', `Original chat message: ${date(note.chat_source.created_at)}. This is a reviewed copy; editing it does not change the original conversation.`, 'notebook-meta'));
      if (confirmed(note)) box.append(node('p', 'This records a past confirmed fix, not a fresh check of the device.', 'notebook-meta'));
    }
    box.append(actions);
    if (note) {
      const confirm = node('div', null, 'notebook-delete-review'); confirm.id = 'notebook-delete-review'; confirm.hidden = true;
      confirm.append(node('p', `Delete “${title(note)}”? Its saved text will be removed. Existing chat replies and note receipts will remain.`), button('Delete this note', () => deleteNote(note), 'btn-outline notebook-danger'), button('Keep note', () => { if (!state.busy) confirm.hidden = true; }));
      box.append(button('Delete note…', () => { if (!state.busy) confirm.hidden = false; }, 'btn-outline notebook-danger'), confirm);
    }
    rememberDraft(); name.focus();
  }
  function lockEditor(locked) {
    $('notebook-editor').querySelectorAll('button,input,textarea,select').forEach(n => { n.disabled = locked; });
    $('notebook-refresh').disabled = locked;
  }
  async function saveEdit() {
    if (state.busy) return;
    const note = state.editor, epoch = state.epoch;
    const payload = { text: $('notebook-text').value.trim(), title: $('notebook-title').value.trim() };
    const deviceId = $('notebook-device').value || null;
    if (!note || deviceId !== (note.device_id || null)) payload.device_id = deviceId;
    if (!payload.text) { message('Write a note before saving.'); return; }
    const category = $('notebook-category').value;
    if (!note || category !== note.category || ['general', 'preference', 'device'].includes(category)) payload.category = category;
    if (note) payload.expected_revision = note.revision;
    state.busy = true; lockEditor(true); message('Saving…');
    try {
      const saved = await api(note ? '/' + encodeURIComponent(note.id) + query() : '', note ? 'PATCH' : 'POST', payload);
      if (epoch !== state.epoch) return;
      if (!validRef(saved) || saved.id.startsWith('device-') || saved.text !== payload.text ||
          (note && !note.id.startsWith('device-') && saved.id !== note.id)) throw new Error('TLI did not confirm the saved note.');
      state.read++; state.notes = [saved, ...state.notes.filter(n => n.id !== saved.id && n.id !== note?.id)]; state.loaded = true;
      state.drafts.delete(note?.id || 'new'); state.editing = false;
      state.busy = false; edit(saved); renderSelected(); message('Note saved to Notes & fixes. Use for next question selects this saved version.');
      $('notebook-editor').append(button('Use for next question', () => useNote(saved)));
    } catch (e) { if (epoch === state.epoch) message(e.message + ' Your edit is still here. Use Back to notes and Refresh notes to review the current saved version.'); }
    finally { if (epoch === state.epoch) { state.busy = false; lockEditor(false); } }
  }
  async function deleteNote(note) {
    if (state.busy) return;
    const epoch = state.epoch; state.busy = true; lockEditor(true); message('Deleting…');
    try {
      const result = await api('/' + encodeURIComponent(note.id) + query() + '&expected_revision=' + encodeURIComponent(note.revision), 'DELETE');
      if (epoch !== state.epoch) return;
      if (result?.id !== note.id || result.deleted !== true) throw new Error('TLI did not confirm that this note was deleted.');
      state.read++; state.notes = state.notes.filter(n => n.id !== note.id); state.loaded = true;
      state.drafts.delete(note.id); state.editing = false; state.baseline = null;
      state.editor = null; $('notebook-editor').replaceChildren(); $('notebook-editor').hidden = true; $('notebook-browser').hidden = false;
      renderList(); renderSelected(); renderDrafts(); message('Saved note deleted.');
    } catch (e) { if (epoch === state.epoch) message(e.message + ' The deletion was not confirmed. Refresh notes before trying again.'); }
    finally { if (epoch === state.epoch) { state.busy = false; lockEditor(false); } }
  }
  function requestContext(context, { image = false, text = '' } = {}) {
    if (!state.selected.length) return context;
    if (context.use_saved_memory === false) throw new Error('Turn on Use saved notes or remove the selected notes before asking.');
    if (image || context.screenshot || context.target_id || context.diagnostic_id || context.documents?.length || /\[vault:[^\]]+\]/i.test(text) || context.include_vault_secrets || context.secret_keys?.length) throw new Error('Ask about selected notes on their own. Remove the image, device/report, document or Vault context, or remove the selected notes.');
    const stale = state.selected.find(n => currentStatus(n));
    if (stale) throw new Error(`${title(stale)}: ${currentStatus(stale)}`);
    const request = { ...context, note_refs: state.selected.map(reference) };
    requests.set(request, state.epoch); return request;
  }
  function sent(context) {
    if (requests.get(context) !== state.epoch) return;
    const refs = context?.note_refs || [];
    state.selected = state.selected.filter(n => !refs.some(r => r.id === n.id && r.revision === n.revision)); renderSelected();
  }
  function annotateReply(bubble, meta) {
    const context = meta?.note_context;
    if (!bubble || context?.actions_performed !== false || !Array.isArray(context.notes) || !context.notes.length || context.notes.length > 4 || context.notes.some(n => !validRef(n) || typeof n.title !== 'string' || n.title.length > 120)) return;
    const receipt = node('div', null, 'notebook-receipt'); receipt.append(node('strong', 'Notes provided to AI'));
    context.notes.forEach(n => { const row = node('div', null, 'notebook-selected-row'); row.append(node('span', `${n.title || 'Untitled note'} · ${date(n.updated_at)}`), button('Open current note', () => open(reference(n)))); receipt.append(row); });
    receipt.append(node('p', 'Selected saved notes were provided with this question. No actions performed.')); bubble.append(receipt);
  }
  function init() {
    const row = document.querySelector('.chat-input-row'); if (!row || $('notebook-dialog')) return;
    const selected = node('section', null, 'notebook-selected'); selected.id = 'notebook-selected'; selected.hidden = true; selected.setAttribute('aria-label', 'Notes selected for chat'); row.before(selected);
    const entry = $('notebook-open') || button('Notes & fixes', () => open());
    if ($('notebook-open')) entry.addEventListener('click', () => open()); else document.querySelector('.chat-actions-row > div')?.append(entry);
    const dialog = node('dialog', null, 'notebook-dialog'); dialog.id = 'notebook-dialog'; dialog.setAttribute('aria-labelledby', 'notebook-heading');
    const header = node('div', null, 'notebook-dialog-header'), heading = node('h2', 'Notes & fixes'); heading.id = 'notebook-heading';
    header.append(heading, button('Close notes', close));
    const status = node('p'); status.id = 'notebook-status'; status.setAttribute('role', 'status');
    const browser = node('div'); browser.id = 'notebook-browser';
    const search = node('input'); search.id = 'notebook-search'; search.type = 'search'; search.placeholder = 'Search titles, notes or devices'; search.addEventListener('input', renderList);
    const filters = node('div', null, 'notebook-filters');
    const kind = node('select'); kind.id = 'notebook-kind'; kind.append(option('', 'All notes'), option('fixes', 'Confirmed fixes'), option('chat_user', 'Saved user statements'), option('chat_ai', 'Saved TLI/AI replies')); kind.value = ''; kind.addEventListener('change', renderList);
    const deviceFilter = node('select'); deviceFilter.id = 'notebook-filter-device'; deviceFilter.append(option('', 'All devices')); deviceFilter.value = ''; deviceFilter.addEventListener('change', renderList);
    const after = node('input'); after.id = 'notebook-after'; after.type = 'date'; after.addEventListener('input', renderList);
    filters.append(field('Source', kind), field('Device', deviceFilter), field('Updated on or after', after), button('Clear filters', () => { search.value = ''; kind.value = ''; deviceFilter.value = ''; after.value = ''; renderList(); }));
    const actions = node('div', null, 'notebook-actions'); const refresh = button('Refresh notes', () => load()); refresh.id = 'notebook-refresh';
    actions.append(button('New note', () => edit()), refresh, button('Related notes…', () => {
      if(state.busy || !state.loaded){message('Load your current notes and finish any save before opening related-note search.');return;}
      if(!window.TLIRelatedNotes){message('Related-note search is unavailable in this browser. Refresh TLI to load the matching interface.');return;}
      const notes=state.notes,devices=state.devices;close();window.TLIRelatedNotes.open({notes,devices});
    }));
    const list = node('div', null, 'notebook-list'); list.id = 'notebook-list';
    const drafts = node('section', null, 'notebook-drafts'); drafts.id = 'notebook-drafts'; drafts.hidden = true;
    browser.append(drafts, field('Search your notes', search), filters, actions, list);
    const editor = node('div'); editor.id = 'notebook-editor'; editor.hidden = true;
    const intro = node('section', null, 'notebook-intro');
    intro.append(node('p', 'Keep setup details, preferences and past fixes so you can refer to them later.'),
      node('p', 'With “Use saved notes” enabled in AI Chat, TLI may include relevant notes. Choosing specific notes uses only those notes and your next question; earlier conversation is not included.', 'notebook-meta'),
      node('p', 'Stored for your current TLI account on this host. With the access PIN off, browser visitors use the shared local account. Vault notes and chat history are separate.', 'notebook-meta'));
    dialog.append(header, intro, status, browser, editor); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', rememberDraft);
    $('new-chat-btn')?.addEventListener('click', () => { state.selected = []; renderSelected(); });
    window.addEventListener('tli-session-locked', clear); window.addEventListener('pagehide', clear);
  }
  function fillFilterDevices() {
    const control = $('notebook-filter-device'); if (!control) return;
    const selected = control.value;
    control.replaceChildren(option('', 'All devices'));
    const ids = [...new Set([...state.devices.map(d => d.id), ...state.notes.map(n => n.device_id).filter(Boolean)])];
    ids.forEach(id => control.append(option(id, state.devices.find(d => d.id === id)?.name || id)));
    control.value = ids.includes(selected) ? selected : '';
  }
  function describeContext() {
    return state.selected.map(n => ({ id: 'note:' + n.id, label: title(n), kind: 'note' }));
  }
  function removeContext(id) {
    state.selected = state.selected.filter(n => 'note:' + n.id !== id); renderSelected();
  }
  window.TLINotebook = { open, requestContext, sent, annotateReply, clear, describeContext, removeContext };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
