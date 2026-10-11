/* Reviewed copies and truthful, body-free context receipts for ordinary chat. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { epoch: 0, ticket: 0, busy: false, preview: null, ref: null, target: null, notes: [], noteRead: 0 };
  const requests = new WeakMap(), decorations = new WeakMap();
  const contextChanged = () => window.dispatchEvent?.(new CustomEvent('tli-chat-context-changed'));
  const protocol = 'tli-memory-continuity-v1';
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, fn) => { const b = node('button', text, 'btn-outline'); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const field = (text, input) => { const label = node('label', null, 'memory-field'); label.append(node('span', text), input); return label; };
  const option = (value, text) => { const o = node('option', text); o.value = value; return o; };
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
  const validRef = ref => ref && typeof ref.conversation_id === 'string' && ref.conversation_id.length > 0 && ref.conversation_id.length <= 256 && Number.isInteger(ref.message_index) && ref.message_index >= 0 && ref.message_index <= 1000000 && /^[a-f0-9]{64}$/.test(ref.revision);
  const pointer = ref => ({ conversation_id: ref.conversation_id, message_index: ref.message_index, revision: ref.revision });
  const status = text => { if ($('memory-save-status')) $('memory-save-status').textContent = text; };
  const current = (epoch, ticket) => epoch === state.epoch && ticket === state.ticket;
  function clear(resetPreference = false) {
    state.epoch++; state.ticket++; state.busy = false; state.preview = null; state.ref = null; state.target = null; state.notes = []; state.noteRead++;
    $('memory-save-editor')?.replaceChildren(); status('');
    if ($('memory-save-dialog')?.open) $('memory-save-dialog').close();
    if (resetPreference && $('memory-use-saved')) $('memory-use-saved').checked = true;
    if ($('memory-use-history')) $('memory-use-history').checked = true;
    contextChanged();
  }
  function requestContext(context) {
    context.use_saved_memory = $('memory-use-saved')?.checked !== false;
    context.use_conversation_history = $('memory-use-history')?.checked !== false;
    if (context.use_saved_memory === false && context.note_refs?.length) throw new Error('Turn on Use saved notes or remove the selected notes before asking.');
    requests.set(context, state.epoch);
    return context;
  }
  const isCurrent = context => requests.get(context) === state.epoch;
  function lockSession() {
    clear(true);
    // Use the same lock event as ordinary chat so its in-flight controller,
    // private history, and Send/Stop controls are reset together.
    window.dispatchEvent(new CustomEvent('tli-session-locked'));
  }
  async function api(path, body, signal) {
    const epoch = state.epoch;
    const response = await fetch('/api/intelligence/memory' + (path ? '/' + path : ''), { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (epoch !== state.epoch) throw new Error('This earlier Notes & fixes request is no longer current.');
    if (response.status === 401) { lockSession(); const error = new Error('Your TLI session expired. Unlock TLI before trying again.'); error.status = 401; throw error; }
    let result; try { result = await response.json(); } catch (_) { throw new Error('TLI did not return a readable Notes & fixes response.'); }
    if (!response.ok) { const error = new Error(typeof result.detail === 'string' ? result.detail : `Notes & fixes request failed (${response.status}).`); error.status = response.status; throw error; }
    return result;
  }
  async function ensureAvailable(context, signal) {
    if (!isCurrent(context)) throw new Error('The conversation changed. Send your question again from the current chat.');
    if (context.use_saved_memory === false || context.use_conversation_history === false) {
      let data;
      try { data = await api('capabilities', undefined, signal); } catch (error) { if (!isCurrent(context) && error.status !== 401) throw new Error('The conversation changed. Send your question again from the current chat.'); throw new Error('TLI could not confirm asking without saved notes is supported. Reconnect or update the host, then try again.'); }
      if (data?.ok !== true || data.protocol !== protocol) throw new Error('Update the TLI host before asking without saved notes. This question has not been sent.');
      if (context.use_conversation_history === false && data.use_conversation_history !== true) throw new Error('Update the TLI host before asking without earlier conversation. This question has not been sent.');
    }
    if (!isCurrent(context)) throw new Error('The conversation changed. Send your question again from the current chat.');
  }
  function locked(value) { $('memory-save-editor')?.querySelectorAll('button,input,textarea,select').forEach(n => { n.disabled = value; }); }
  async function review(ref) {
    if (!validRef(ref) || state.busy) return;
    if (state.preview) {
      const dialog = $('memory-save-dialog'); if (dialog && !dialog.open) dialog.showModal();
      status('Your reviewed draft is still here. Save or discard it before opening another chat message.'); return;
    }
    const epoch = state.epoch, ticket = ++state.ticket;
    state.busy = true; state.preview = null; state.ref = pointer(ref);
    const dialog = $('memory-save-dialog'); if (!dialog) { state.busy = false; return; }
    if (!dialog.open) dialog.showModal();
    $('memory-save-editor').replaceChildren(); status('Loading the saved original message…');
    try {
      const data = await api('from-chat/preview', { source_ref: state.ref });
      if (!current(epoch, ticket)) return;
      if (!validRef(data?.source) || JSON.stringify(pointer(data.source)) !== JSON.stringify(pointer(ref)) || !['user', 'assistant'].includes(data.source.role) || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 32000 || typeof data.suggested_text !== 'string' || data.suggested_text.length > 2000 || data.source_kind !== (data.source.role === 'user' ? 'user_statement' : 'ai_suggestion')) throw new Error('TLI did not confirm the original message. Reopen the conversation and try again.');
      state.preview = data; renderReview(data); status('Review the original and edit your saved copy before saving.');
      loadDevices(epoch, ticket);
    } catch (e) { if (current(epoch, ticket)) status(e.message); }
    finally { if (current(epoch, ticket)) state.busy = false; }
  }
  function renderReview(data) {
    const box = $('memory-save-editor'); box.replaceChildren();
    const ai = data.source.role === 'assistant';
    box.append(node('p', ai ? 'Source: TLI/AI reply · unconfirmed. Saving this does not verify its advice or mark it as a successful fix.' : 'Source: Your statement. Saving records what you said; it is not a system measurement.'),
      node('p', `Original message: ${date(data.source.created_at)}${data.source.provider ? ' · ' + data.source.provider : ''}${data.source.model ? ' · ' + data.source.model : ''}`, 'memory-meta'));
    const original = node('details'); original.append(node('summary', 'Review original saved message'), node('pre', data.text)); box.append(original);
    const mode = node('select'); mode.id = 'memory-save-mode'; mode.append(option('new', 'Create a new note'), option('update', 'Update an existing note')); mode.value = 'new';
    mode.addEventListener('change', () => {
      state.target = null; state.noteRead++; $('memory-save-reviewed').checked = false;
      $('memory-save-target-area').hidden = mode.value !== 'update';
      if (mode.value !== 'update') {
        const category = $('memory-save-category');
        const value = ['general', 'preference', 'device'].includes(category.value) ? category.value : 'general';
        category.replaceChildren(option('general', 'General'), option('preference', 'Preference'), option('device', 'Device')); category.value = value;
        const device = $('memory-save-device'); device.replaceChildren(...Array.from(device.children).filter(o => o.memoryTargetOnly !== true)); device.value = '';
      }
      $('memory-save-confirm').textContent = mode.value === 'update' ? 'Update reviewed note' : 'Save reviewed copy';
      renderComparison(); if (mode.value === 'update') loadNotes();
    });
    const targets = node('section', null, 'memory-update-target'); targets.id = 'memory-save-target-area'; targets.hidden = true;
    const picker = node('select'); picker.id = 'memory-save-target'; picker.append(option('', 'Choose a note to review')); picker.value = '';
    picker.addEventListener('change', () => selectTarget(picker.value));
    const refresh = button('Refresh current notes', loadNotes); refresh.id = 'memory-save-refresh';
    targets.append(field('Existing note', picker), refresh, node('p', 'Updating keeps the note’s identity and original creation date. It replaces its text and source with this saved chat message, and removes any previous confirmed-fix status. Review the changes below before saving.'));
    box.append(field('Save destination', mode), targets);
    const title = node('input'); title.id = 'memory-save-title'; title.maxLength = 120; title.value = typeof data.suggested_title === 'string' ? data.suggested_title.slice(0, 120) : '';
    const text = node('textarea'); text.id = 'memory-save-text'; text.rows = 7; text.maxLength = 2000; text.value = data.suggested_text;
    const category = node('select'); category.id = 'memory-save-category'; category.append(option('general', 'General'), option('preference', 'Preference'), option('device', 'Device')); category.value = 'general';
    const device = node('select'); device.id = 'memory-save-device'; device.append(option('', 'No device association')); device.value = '';
    const reviewed = node('input'); reviewed.id = 'memory-save-reviewed'; reviewed.type = 'checkbox'; reviewed.checked = false;
    const reviewLabel = node('label', null, 'memory-review-check'); reviewLabel.append(reviewed, node('span', 'I reviewed this saved copy and its source.'));
    if (data.requires_excerpt) box.append(node('p', 'The original is longer than a note. Write a reviewed excerpt of up to 2,000 characters; nothing has been shortened automatically.'));
    const comparison = node('section', null, 'memory-note-comparison'); comparison.id = 'memory-save-comparison'; comparison.hidden = true;
    for (const input of [title, text, category, device]) input.addEventListener('input', () => { reviewed.checked = false; renderComparison(); });
    for (const input of [category, device]) input.addEventListener('change', () => { reviewed.checked = false; renderComparison(); });
    box.append(field('Title (optional)', title), field('Copy to save (up to 2,000 characters)', text), field('Category', category), field('Associated computer (optional)', device), comparison, reviewLabel);
    const save = button('Save reviewed copy', saveReview); save.id = 'memory-save-confirm';
    const discard = node('div', null, 'memory-discard-review'); discard.id = 'memory-save-discard-review'; discard.hidden = true;
    discard.append(node('p', 'Discard this unsaved copy? The original conversation and saved notes will stay unchanged.'),
      button('Discard this copy', () => { if (state.busy) return; clear(); }),
      button('Keep editing', () => { discard.hidden = true; }));
    box.append(save, button('Discard draft…', () => { if (!state.busy) discard.hidden = false; }), discard); title.focus();
  }
  async function loadDevices(epoch, ticket) {
    try {
      const response = await fetch('/api/intelligence/devices', { cache: 'no-store', redirect: 'error' });
      if (!current(epoch, ticket)) return;
      if (response.status === 401) { lockSession(); return; }
      if (!response.ok) return;
      const data = await response.json();
      if (!current(epoch, ticket) || !Array.isArray(data.devices)) return;
      const control = $('memory-save-device'); if (!control) return;
      for (const d of data.devices.slice(0, 1000)) if (typeof d.id === 'string' && d.id.length <= 256 && typeof d.name === 'string') {
        const existing = Array.from(control.children).find(o => o.value === d.id);
        if (existing) { existing.memoryTargetOnly = false; existing.textContent = d.name; }
        else control.append(option(d.id, d.name));
      }
    } catch (_) { /* No association is required to save a note. */ }
  }
  const validTarget = n => typeof n?.id === 'string' && n.id.length > 0 && n.id.length <= 256 && !n.id.startsWith('device-') && n.source !== 'legacy_device'
    && /^[a-f0-9]{64}$/.test(n.revision) && typeof n.text === 'string' && n.text.length <= 2000 && typeof n.title === 'string' && n.title.length <= 120
    && typeof n.category === 'string' && n.category.length > 0 && n.category.length <= 64 && (n.device_id == null || (typeof n.device_id === 'string' && n.device_id.length <= 256));
  function selectedMode() { return $('memory-save-mode')?.value === 'update'; }
  function renderComparison() {
    const box = $('memory-save-comparison'); if (!box) return;
    box.hidden = !selectedMode() || !state.target; box.replaceChildren(); if (box.hidden) return;
    const target = state.target;
    const card = (heading, title, text, category, device) => { const section = node('div'); section.append(node('h3', heading), node('strong', title || 'Untitled note'), node('pre', text), node('p', `Category: ${category} · Computer: ${device || 'No association'}`, 'memory-meta')); return section; };
    box.append(card('Current saved note', target.title, target.text, target.category, target.device_id),
      card('After this update', $('memory-save-title').value, $('memory-save-text').value, $('memory-save-category').value, $('memory-save-device').value));
    box.append(node('p', `New source: ${state.preview?.source.role === 'user' ? 'Saved user statement' : 'Saved AI suggestion · unconfirmed'}. This does not verify a fix.`, 'memory-update-source'));
  }
  function selectTarget(id) {
    state.target = state.notes.find(n => n.id === id) || null;
    $('memory-save-reviewed').checked = false;
    if (state.target) {
      const category = $('memory-save-category'), device = $('memory-save-device');
      const value = state.target.category === 'verified_fix' ? 'general' : state.target.category;
      if (!Array.from(category.children).some(o => o.value === value)) category.append(option(value, value));
      category.value = value;
      if (state.target.device_id && !Array.from(device.children).some(o => o.value === state.target.device_id)) { const carried = option(state.target.device_id, state.target.device_id); carried.memoryTargetOnly = true; device.append(carried); }
      device.value = state.target.device_id || '';
    }
    renderComparison();
  }
  async function loadNotes() {
    if (state.busy || !state.preview || !selectedMode()) return;
    const epoch = state.epoch, ticket = state.ticket, read = ++state.noteRead, previous = state.target?.id;
    state.target = null; state.notes = []; $('memory-save-reviewed').checked = false; renderComparison();
    $('memory-save-target').replaceChildren(option('', 'Choose a note to review'));
    $('memory-save-target').disabled = true; status('Loading your current saved notes…');
    try {
      const data = await api('');
      if (!current(epoch, ticket) || read !== state.noteRead || !selectedMode()) return;
      if (!Array.isArray(data.facts)) throw new Error('TLI did not return a usable list of owned notes.');
      state.notes = data.facts.map(n => n && typeof n === 'object' ? {...n, title:n.title == null ? '' : n.title} : n).filter(validTarget).slice(0, 500);
      const picker = $('memory-save-target'); picker.replaceChildren(option('', 'Choose a note to review'));
      state.notes.forEach(n => picker.append(option(n.id, (n.title || 'Untitled note') + (n.device_id ? ' · ' + n.device_id : '') + ' · ' + n.id)));
      picker.value = state.notes.some(n => n.id === previous) ? previous : '';
      selectTarget(picker.value);
      status(state.notes.length ? 'Choose a note, review its current contents and the proposed update, then check the review box. Your proposed text is retained.' : 'No current editable notes are available. You can create a new note instead.');
    } catch (e) { if (current(epoch, ticket) && read === state.noteRead) status(e.message + ' Your proposed text is retained. Refresh explicitly before updating.'); }
    finally { if (current(epoch, ticket) && read === state.noteRead) $('memory-save-target').disabled = false; }
  }
  async function saveReview() {
    if (state.busy || !state.preview || !state.ref) return;
    const payload = { source_ref: state.ref, text: $('memory-save-text').value.trim(), title: $('memory-save-title').value.trim(), category: $('memory-save-category').value, device_id: $('memory-save-device').value || null, reviewed: $('memory-save-reviewed').checked === true };
    if (!payload.text || payload.text.length > 2000 || payload.title.length > 120) { status('Write a note of 1–2,000 characters and a title of up to 120 characters.'); return; }
    if (selectedMode()) {
      if (!validTarget(state.target)) { status('Choose and review a current saved note before updating.'); return; }
      payload.note_id = state.target.id; payload.expected_revision = state.target.revision;
    }
    if (!payload.reviewed) { status('Review the original and check the review box before saving.'); return; }
    const epoch = state.epoch, ticket = state.ticket;
    state.busy = true; locked(true); status(payload.note_id ? 'Updating your reviewed note…' : 'Saving your reviewed copy…');
    try {
      const data = await api('from-chat/save', payload);
      if (!current(epoch, ticket)) return;
      const note = data?.note;
      if (data.ok !== true || typeof data.already_saved !== 'boolean' || typeof note?.id !== 'string' || note.id.length > 256 || !/^[a-f0-9]{64}$/.test(note.revision) || note.source !== (state.preview.source.role === 'user' ? 'chat_user' : 'chat_ai') || (data.already_saved === false && note.text !== payload.text)) throw new Error('TLI did not confirm this saved copy. Your draft is retained.');
      if (payload.note_id && (data.updated_existing !== true || data.already_saved !== false || note.id !== payload.note_id || note.revision === payload.expected_revision || note.title !== payload.title || note.category !== payload.category || (note.device_id || null) !== payload.device_id)) throw new Error('TLI did not confirm this exact note update. Check the current note before trying again.');
      status(payload.note_id ? 'Updated the reviewed note. Its identity and original creation date were kept; the saved source is now this chat message, with no confirmed-fix status.' : data.already_saved ? 'This copy was already saved. Its current note may contain later edits; those edits were kept.' : 'Saved to Notes & fixes. The original source and its date are retained; no fix was verified.');
      const box = $('memory-save-editor'); box.replaceChildren(node('p', note.title || 'Untitled note'), button('Open current saved note', () => { $('memory-save-dialog').close(); window.TLINotebook?.open({ id: note.id, revision: note.revision }); }));
      state.preview = null; state.ref = null; state.target = null; state.notes = []; state.noteRead++;
    } catch (e) { if (current(epoch, ticket)) {
      if (payload.note_id) { state.target = null; state.notes = []; $('memory-save-target').replaceChildren(option('', 'Refresh current notes before choosing')); $('memory-save-reviewed').checked = false; renderComparison(); }
      status(e.message + ' Your reviewed draft is still here.' + (payload.note_id ? ' Refresh current notes and review again before updating; nothing will retry automatically.' : ''));
    } }
    finally { if (current(epoch, ticket)) { state.busy = false; locked(false); } }
  }
  function decorateMessage(bubble, metadata) {
    window.TLITroubleshooting?.decorateMessage?.(bubble, metadata);
    if (!bubble || !validRef(metadata?.source_ref)) return;
    const decorated = decorations.get(bubble) || {};
    const ref = pointer(metadata.source_ref), key = JSON.stringify(ref);
    if (decorated.save && decorated.saveRef === key) { window.TLIChatWorkspace?.presentMessage?.(bubble); return; }
    decorated.save?.remove();
    const controls = node('div', null, 'memory-message-actions'), save = button('Save to Notes & fixes…', () => review(ref)); controls.append(save); bubble.append(controls);
    decorated.save = save; decorated.saveRef = key; decorations.set(bubble, decorated);
    window.TLIChatWorkspace?.presentMessage?.(bubble);
  }
  function decorateReply(bubble, metadata = {}) {
    if (!bubble) return;
    decorateMessage(bubble, metadata);
    decorateEvidence(bubble, metadata);
    if (['intent_engine', 'tool_fastpath', 'diagnostics'].includes(metadata.handled_by) ||
        ['tli-action', 'tli-tools', 'tli-diagnostics', 'tli-status'].includes(metadata.provider)) { window.TLIChatWorkspace?.presentMessage?.(bubble); return; }
    const decorated = decorations.get(bubble) || {};
    if (decorated.receipt) { window.TLIChatWorkspace?.presentMessage?.(bubble); return; }
    // Explicit reference modes already have their own complete receipts.
    if (metadata.note_context || metadata.document_context || metadata.screenshot_context || metadata.case_context) { window.TLIChatWorkspace?.presentMessage?.(bubble); return; }
    const receipt = node('details', null, 'memory-context-receipt'); receipt.append(node('summary', 'Context for this answer'));
    const m = metadata.memory_context, c = metadata.conversation_context;
    const validNote = n => typeof n?.id === 'string' && n.id.length > 0 && n.id.length <= 256 && typeof n.title === 'string' && n.title.length <= 120 && /^[a-f0-9]{64}$/.test(n.revision);
    const validMemory = m && typeof m.use_saved_memory === 'boolean' && ['included', 'none', 'disabled'].includes(m.status) && Number.isInteger(m.omitted_for_budget) && m.omitted_for_budget >= 0 && Array.isArray(m.notes) && m.notes.length <= 8 && m.notes.every(validNote) && (m.status === 'included' ? m.notes.length > 0 && m.use_saved_memory : m.notes.length === 0) && (m.status !== 'disabled' || !m.use_saved_memory);
    if (!validMemory) receipt.append(node('p', 'This host did not report which saved notes were provided for this answer.'));
    else {
      receipt.append(node('p', m.status === 'disabled' ? 'Saved-note retrieval was off for this question. Earlier conversation may still contain saved information.' : m.status === 'none' ? 'No saved notes were provided for this answer.' : `${m.notes.length} saved ${m.notes.length === 1 ? 'note was' : 'notes were'} provided to AI. This does not confirm how the answer used them.`));
      m.notes.forEach(n => { const row = node('div', null, 'memory-receipt-note'); row.append(node('span', `${n.title || 'Untitled note'} · ${date(n.updated_at)}${n.source === 'chat_ai' ? ' · AI suggestion, unconfirmed' : ''}${n.device_id ? ' · ' + n.device_id : ''}`), button('Open current note', () => window.TLINotebook?.open({ id: n.id, revision: n.revision }))); receipt.append(row); });
      if (m.omitted_for_budget) receipt.append(node('p', `${m.omitted_for_budget} additional relevant ${m.omitted_for_budget === 1 ? 'note was' : 'notes were'} left out to fit the available context.`));
    }
    const validHistory = c && ['included', 'none', 'limited', 'disabled'].includes(c.status) && ['included_messages', 'included_exchanges', 'omitted_messages', 'character_budget'].every(k => Number.isInteger(c[k]) && c[k] >= 0) && (c.status !== 'disabled' || c.use_conversation_history === false && c.included_messages === 0 && c.omitted_messages === 0);
    receipt.append(node('p', validHistory ? c.status === 'disabled' ? 'Earlier conversation was off for this question. No prior exchanges or follow-up topic were supplied.' : `${c.included_messages} earlier chat messages (${c.included_exchanges} exchanges) were provided.${c.omitted_messages ? ` ${c.omitted_messages} earlier messages were left out for this answer.` : ''}` : 'This host did not report how much earlier conversation was provided.'));
    bubble.append(receipt); decorated.receipt = receipt; decorations.set(bubble, decorated);
    window.TLIChatWorkspace?.presentMessage?.(bubble);
  }
  function decorateEvidence(bubble, metadata) {
    const decorated = decorations.get(bubble) || {};
    const bounded = (value, size = 512) => typeof value === 'string' && value.length > 0 && value.length <= size;
    const stamp = value => bounded(value, 64) && Number.isFinite(Date.parse(value));
    const observed = metadata.observation_context;
    const evidence = metadata.evidence_context;
    if (evidence && !decorated.sources) {
      const box = node('details', null, 'memory-context-receipt'); box.append(node('summary', 'Sources & interpretation'));
      const sources = evidence.sources;
      const kinds = { note: 'N', report: 'R', document: 'D', observation: 'O', case: 'C' };
      const optional = (value, size) => value == null || bounded(value, size);
      const citationMatches = (citation, source) => {
        if (citation.reference === '[' + source.handle + ']') return source.kind !== 'document';
        if (source.kind !== 'document') return false;
        const prefix = '[' + source.label + ':L';
        if (!citation.reference.startsWith(prefix)) return false;
        const range = /^(\d+)(?:-L?(\d+))?\]$/.exec(citation.reference.slice(prefix.length));
        return !!range && source.ranges.some(r => r.start <= Number(range[1]) && Number(range[1]) <= Number(range[2] || range[1]) && Number(range[2] || range[1]) <= r.end);
      };
      const valid = evidence.version === 1 && ['ai', 'backend'].includes(evidence.interpretation) && typeof evidence.citations_checked === 'boolean'
        && Array.isArray(sources) && sources.length <= 12 && new Set(sources.map(s => s?.handle)).size === sources.length
        && sources.every(s => s && kinds[s.kind] && new RegExp('^' + kinds[s.kind] + '[1-9][0-9]?$').test(s.handle) && bounded(s.id, 256) && bounded(s.label, 240) && bounded(s.provenance, 64)
          && (!['note', 'document', 'case'].includes(s.kind) || /^[a-f0-9]{64}$/.test(s.revision))
          && optional(s.saved_at, 64) && optional(s.observed_at, 64) && optional(s.host_id, 256) && optional(s.target_id, 256)
          && Array.isArray(s.ranges) && s.ranges.length <= 32 && (s.kind === 'document' || s.ranges.length === 0) && s.ranges.every((r, i) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 1 && r.end >= r.start && r.end <= 65537 && (!i || r.start > s.ranges[i - 1].end)))
        && Array.isArray(evidence.citations) && evidence.citations.length <= 32 && (evidence.citations_checked || !evidence.citations.length && !evidence.invalid_citations) && evidence.citations.every(c => bounded(c.reference, 160) && sources.some(s => s.handle === c.handle && citationMatches(c, s)))
        && Number.isInteger(evidence.invalid_citations) && evidence.invalid_citations >= 0 && evidence.invalid_citations <= 10000;
      if (!valid) box.append(node('p', 'Source identities could not be checked. References in the answer remain unverified.'));
      else {
        const backendDescription = sources.some(source => source.kind === 'observation')
          ? 'Backend observation summary. Its timestamp and coverage describe the checks actually available.'
          : sources.length ? 'Summary of the selected saved records. Recorded results and user confirmations are historical; no new check or repair ran.'
            : 'No recorded outcome was supplied. No new check or repair ran for this answer.';
        box.append(node('p', evidence.interpretation === 'backend' ? backendDescription : 'AI interpretation of the supplied context. A checked source reference identifies a source; it does not prove the answer is correct.'));
        if (!sources.length) box.append(node('p', 'No saved-note, report or document source was supplied. This answer has no verified source references.'));
        for (const source of sources) {
          const row = node('div', null, 'memory-receipt-note memory-evidence-source');
          const category = source.kind === 'note' ? source.provenance === 'chat_ai' ? 'Saved AI suggestion · unconfirmed' : source.provenance === 'user_confirmation' ? 'User-confirmed historical fix · not an independent test' : 'Saved statement · not a current measurement' : source.kind === 'report' ? 'Saved diagnostic checks · historical observation' : source.kind === 'document' ? 'Selected document · not measured current health' : source.kind === 'case' ? 'User-recorded troubleshooting · historical statements, not measured health' : 'Host observation · see reading time and coverage';
          row.append(node('strong', `${source.handle} · ${source.label}`), node('p', category), node('p', `Recorded: ${date(source.observed_at || source.saved_at)}${source.host_id ? ' · Host: ' + source.host_id : ''}${source.target_id ? ' · Target: ' + source.target_id : ''}`));
          if (source.kind === 'note' || source.kind === 'report') {
            const message = node('p'); message.setAttribute('role', 'status');
            row.append(button(source.kind === 'note' ? 'Open current note' : 'Open saved report', async () => {
              try {
                const open = source.kind === 'note' ? window.TLINotebook?.open : window.TLIIntelligence?.openSavedReport;
                if (typeof open !== 'function') throw new Error('This source view is unavailable. Refresh TLI before trying again.');
                await open(source.kind === 'note' ? { id: source.id, revision: source.revision } : source.id);
                message.textContent = '';
              } catch (error) { message.textContent = String(error?.message || 'This saved source is unavailable.').slice(0,300); }
            }), message);
          }
          if (source.kind === 'document') row.append(node('p', `Supplied lines: ${source.ranges.map(r => r.start === r.end ? r.start : r.start + '–' + r.end).join(', ')}. Reselect the matching file to review its text; document bodies are not retained in this receipt.`));
          box.append(row);
        }
        box.append(node('p', evidence.citations_checked ? `${evidence.citations.length} distinct reference${evidence.citations.length === 1 ? '' : 's'} matched supplied source identities or document ranges.${evidence.invalid_citations ? ` ${evidence.invalid_citations} reference${evidence.invalid_citations === 1 ? '' : 's'} could not be verified.` : ''}` : 'References have not been checked against a completed answer.'));
        const historical = evidence.historical_notes;
        if (historical?.checked === true && Number.isInteger(historical.changed) && Number.isInteger(historical.unavailable) && historical.changed >= 0 && historical.changed <= 512 && historical.unavailable >= 0 && historical.unavailable <= 512 && (historical.changed || historical.unavailable)) box.append(node('p', `Earlier answer references: ${historical.changed} changed and ${historical.unavailable} unavailable for this question. Historical replies remain in the conversation; they are not current saved facts.`));
        if (historical?.references !== undefined) {
          const refs = historical.references;
          const validRefs = historical.checked === true && Array.isArray(refs) && refs.length <= 256
            && refs.every((r, i) => r && Number.isInteger(r.exchange_index) && r.exchange_index >= 1 && r.exchange_index <= 32
              && bounded(r.note_id, 256) && bounded(r.title, 120) && /^[a-f0-9]{64}$/.test(r.revision) && /^N[1-8]$/.test(r.handle)
              && ['changed', 'unavailable'].includes(r.status)
              && (!i || r.exchange_index > refs[i - 1].exchange_index || r.exchange_index === refs[i - 1].exchange_index && r.handle > refs[i - 1].handle))
            && historical.changed === refs.filter(r => r.status === 'changed').length && historical.unavailable === refs.filter(r => r.status === 'unavailable').length;
          if (!validRefs) box.append(node('p', 'Individual historical reference details could not be checked.'));
          else if (refs.length) {
            const details = node('details'); details.append(node('summary', 'Changed or unavailable historical notes'), node('p', 'These labels belong to earlier supplied exchanges. They are not current source handles or new note attachments.'));
            const list = node('ul');
            refs.forEach(r => { const row = node('li'); row.append(node('strong', `Earlier exchange ${r.exchange_index} · historical ${r.handle} · ${r.title}`), node('p', r.status === 'changed' ? 'The saved note changed after this earlier reference.' : 'The saved note is no longer available to this answer.'), node('p', `Note ID: ${r.note_id}`), node('p', `Referenced version: ${r.revision}`)); list.append(row); });
            details.append(list); box.append(details);
          }
        }
      }
      if (evidence.recorded_report != null && !decorated.recordedReport) {
        const source = valid ? sources.find(s => s.kind === 'report') : null;
        const facts = window.TLIReportFacts?.render
          ? window.TLIReportFacts.render(source ? evidence.recorded_report : null, source ? { reportId: source.id, hostId: source.host_id, targetId: source.target_id || null } : {}, { compact: true })
          : node('p', 'Structured report facts are unavailable in this browser. A source reference alone does not verify the answer.');
        bubble.prepend(facts); decorated.recordedReport = facts;
      }
      bubble.append(box); decorated.sources = box;
    }
    if (observed && !decorated.observation) {
      const box = node('details', null, 'memory-context-receipt'); box.append(node('summary', 'Readings used for this answer'));
      const valid = observed.schema_version === 1 && ['cpu', 'ram', 'storage', 'network', 'printers', 'system'].includes(observed.topic)
        && ['current', 'stale', 'unknown', 'unavailable'].includes(observed.status) && bounded(observed.host?.name, 256)
        && bounded(observed.host?.id, 256) && bounded(observed.resource) && bounded(observed.source)
        && bounded(observed.coverage, 2000) && stamp(observed.checked_at) && (observed.observed_at === null || stamp(observed.observed_at));
      if (!valid) box.append(node('p', 'The host did not provide a usable reading receipt. Current health is unknown.'));
      else {
        const state = { current: 'Within the 30-second freshness window when answered', stale: 'Stale reading when answered', unknown: 'Reading unavailable or not yet observed', unavailable: 'Could not confirm this reading' }[observed.status];
        box.append(node('p', `${observed.resource} · TLI host: ${observed.host.name} (${observed.host.id})`),
          node('p', `${state}. Observed: ${date(observed.observed_at)}. Answer checked: ${date(observed.checked_at)}.`),
          node('p', `Source: ${observed.source}. ${observed.coverage}`),
          node('p', 'This answer used host observations. It did not use saved notes, prior conversation or AI inference, and it did not perform a repair.'));
      }
      bubble.append(box); decorated.observation = box;
    }
    const budget = metadata.input_budget;
    if (budget && !decorated.budget) {
      const box = node('details', null, 'memory-context-receipt'); box.append(node('summary', 'Input size & model limits'));
      const positive = value => Number.isInteger(value) && value > 0 && value <= 1000000;
      const valid = budget.version === 1 && ['bundled', 'lmstudio', 'unknown'].includes(budget.provider)
        && budget.estimation === 'heuristic' && ['configured', 'unknown'].includes(budget.capacity_status)
        && positive(budget.input_characters) && positive(budget.character_limit) && budget.character_limit <= 12000
        && budget.input_characters <= budget.character_limit && positive(budget.estimated_input_tokens)
        && positive(budget.reserved_output_tokens) && stamp(budget.checked_at)
        && (budget.capacity_status === 'unknown' ? budget.context_tokens === null && budget.fit === 'unknown'
          : positive(budget.context_tokens) && budget.fit === 'estimated' && budget.capacity_source === 'owned_runtime_launch'
            && budget.estimated_input_tokens + budget.reserved_output_tokens <= budget.context_tokens);
      if (!valid) box.append(node('p', 'This host did not report a usable input-size check. Model capacity remains unknown.'));
      else {
        box.append(node('p', `${budget.input_characters.toLocaleString()} text characters · about ${budget.estimated_input_tokens.toLocaleString()} input tokens, including a formatting allowance · ${budget.reserved_output_tokens.toLocaleString()} tokens reserved for the answer.`));
        box.append(node('p', budget.capacity_status === 'configured'
          ? `${budget.context_tokens.toLocaleString()} tokens configured for this bundled runtime. This is a planning estimate, not an exact tokenizer count or a guarantee that the model can answer well.`
          : `The provider's effective context capacity is unknown. TLI applied its ${budget.character_limit.toLocaleString()}-character text ceiling; this does not guarantee that the request fits the model.`));
        box.append(node('p', `Checked ${date(budget.checked_at)}. Image inputs require separate accounting.`));
      }
      bubble.append(box); decorated.budget = box;
    }
    decorations.set(bubble, decorated);
  }
  function init() {
    const row = document.querySelector('.chat-input-row'); if (!row || $('memory-use-saved')) return;
    const controls = node('section', null, 'memory-use-control');
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'memory-use-saved'; checkbox.checked = true;
    checkbox.addEventListener('change', contextChanged);
    const label = node('label'); label.append(checkbox, node('span', 'Use saved notes'));
    const history = node('input'); history.type = 'checkbox'; history.id = 'memory-use-history'; history.checked = true; history.addEventListener('change', contextChanged);
    const historyLabel = node('label'); historyLabel.append(history, node('span', 'Use earlier conversation'));
    controls.append(label, historyLabel, node('p', 'Choose context for this question. Saved notes adds relevant Notes & fixes; earlier conversation adds previous exchanges and supports follow-ups. Turning either off leaves its saved data unchanged. Selected notes, documents and images keep their separate sharing rules.')); row.before(controls);
    const dialog = node('dialog', null, 'memory-save-dialog'); dialog.id = 'memory-save-dialog'; dialog.setAttribute('aria-labelledby', 'memory-save-heading');
    const heading = node('h2', 'Save to Notes & fixes'); heading.id = 'memory-save-heading';
    const header = node('div', null, 'memory-save-header'); header.append(heading, button('Close review', () => { if (state.busy) { status('Wait for this request to finish before closing.'); return; } dialog.close(); }));
    const message = node('p'); message.id = 'memory-save-status'; message.setAttribute('role', 'status');
    const editor = node('div'); editor.id = 'memory-save-editor'; dialog.append(header, message, editor); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
    $('new-chat-btn')?.addEventListener('click', () => clear());
    window.addEventListener('tli-conversation-changed', () => clear());
    window.addEventListener('tli-session-locked', () => clear(true)); window.addEventListener('pagehide', () => clear(true));
  }
  function describeContext() {
    const enabled = $('memory-use-saved')?.checked !== false;
    return [{ id: 'memory', label: 'Use saved notes: ' + (enabled ? 'on' : 'off'), kind: 'memory', enabled }];
  }
  function setEnabled(enabled) {
    const checkbox = $('memory-use-saved'); if (!checkbox || typeof enabled !== 'boolean') return;
    checkbox.checked = enabled; contextChanged();
  }
  function sent(context) {
    if (isCurrent(context) && $('memory-use-history')?.checked === context.use_conversation_history) { $('memory-use-history').checked = true; contextChanged(); }
  }
  window.TLIMemory = { requestContext, ensureAvailable, isCurrent, decorateReply, decorateMessage, clear, describeContext, setEnabled, sent };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
