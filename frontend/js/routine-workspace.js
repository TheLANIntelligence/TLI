/* Manual routines. Navigation reads saved state; only a reviewed Run changes devices. */
(() => {
  'use strict';
  const protocol = 'tli-action-review-v1';
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const text = (value, max = 2000) => typeof value === 'string' && value.length <= max;
  const id = value => text(value, 256) && value.length > 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
  const node = (tag, value, cls) => { const e = document.createElement(tag); if (value != null) e.textContent = value; if (cls) e.className = cls; return e; };
  const stable = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
  const cleanStep = step => Object.fromEntries(Object.entries(step).filter(([key, value]) =>
    value !== null || !['device', 'value', 'device_id', 'capability'].includes(key)));
  const sameSteps = (one, two) => Array.isArray(one) && Array.isArray(two) && stable(one.map(cleanStep)) === stable(two.map(cleanStep));
  let active = false, locked = false, epoch = 0, read = null, mutation = null;
  let accessReady = true, resumeAfterUnlock = false;
  let caps = null, saved = null, receipts = null, checked = '', draft = null, preview = null, saveCandidate = null;
  let runReview = null, outcome = null, notice = '', failed = false, departure = null, backgroundRequest = false;
  let savedQuery = '', savedLimit = 30, legacyLimit = 30, resumeVisible = false;
  let showArchived = false, archiveReview = null, pendingOpen = null;
  const favoriteKey = 'tli.routine-favorites.v1', favoriteMounts = new Set(), favoriteTickets = new WeakMap();
  let favoriteEpoch = 0;
  const alive = token => active && !locked && accessReady && token === epoch;
  const busy = () => !!read || !!mutation;

  function requestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  }
  function button(label, action, primary = false) {
    const b = node('button', label, primary ? 'btn-primary' : 'btn-outline'); b.type = 'button'; b.disabled = busy();
    const buttonEpoch = epoch;
    b.addEventListener('click', () => {
      if (b.disabled || busy() || !alive(buttonEpoch)) return;
      return Promise.resolve().then(() => { if (alive(buttonEpoch) && !busy()) return action(); }).catch(error => {
        if (alive(buttonEpoch)) { notice = error.message; failed = true; paint(); }
      });
    }); return b;
  }
  function actions(...items) { const box = node('div', null, 'routine-actions'); box.append(...items); return box; }
  function section(title, cls = '') { const box = node('section', null, 'routine-card ' + cls); box.append(node('h3', title)); return box; }
  function field(label, control) { const wrap = node('label'); wrap.append(node('span', label), control); return wrap; }
  function select(options, value, label) {
    const e = node('select'); e.setAttribute('aria-label', label); e.disabled = busy();
    for (const [key, labelText] of options) { const option = node('option', labelText); option.value = key; e.append(option); }
    e.value = value; return e;
  }
  function targets() {
    if (!caps) return [];
    const result = [], hp = caps.hp_devices;
    const physical = d => `${d.ip || d.host || ''}|${Number.isInteger(d.relay) ? d.relay : 0}`;
    const hpIds = new Map(), legacyIds = new Map(), addresses = new Map();
    hp.forEach(d => { if (id(d.device_id)) hpIds.set(d.device_id, (hpIds.get(d.device_id) || 0) + 1); });
    caps.devices.forEach(d => {
      const key = d.id || d.source_id;
      if (id(key)) legacyIds.set(key, (legacyIds.get(key) || 0) + 1);
      addresses.set(physical(d), (addresses.get(physical(d)) || 0) + 1);
    });
    for (const d of hp) {
      if (!id(d.device_id) || hpIds.get(d.device_id) !== 1) continue;
      const offered = Array.isArray(d.capabilities) ? d.capabilities : [];
      const effects = ['switch.on', 'switch.off', 'switch.toggle'].filter(c => offered.includes(c));
      if (!effects.length) continue;
      result.push({ key: 'hp:' + d.device_id, type: 'homepower.execute', identity: d.device_id, name: d.name || 'Unnamed device', room: d.room || '', address: d.ip || d.host || '', relay: Number.isInteger(d.relay) ? d.relay : 0, effects, binding: 'Registered device ID', physical: physical(d) });
    }
    for (const d of caps.devices) {
      const identity = d.id || d.source_id, address = d.ip || d.host;
      if (!id(address) || !Number.isInteger(d.relay) || d.relay < 0) continue;
      // Never choose a duplicate address/relay through the resolver's literal-address fallback.
      const stable = id(identity) && legacyIds.get(identity) === 1;
      if (!stable && (id(identity) || addresses.get(physical(d)) !== 1 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address))) continue;
      if (result.some(row => row.physical === physical(d))) continue;
      result.push({ key: 'shelly:' + (stable ? identity : address + ':' + d.relay), type: 'shelly.switch', identity: stable ? identity : null,
        selector: stable ? identity : address + ' relay ' + d.relay, name: d.name || 'Unnamed device', room: d.room || '', address, relay: d.relay,
        effects: ['on', 'off'], binding: stable ? 'Registered device ID' : 'Registered address + relay; physical identity unverified' });
    }
    return result;
  }
  const targetLabel = t => t.name + (t.room ? ' · ' + t.room : '') + (targets().filter(other => other.name === t.name && other.room === t.room).length > 1 ? ` · ${t.address} · relay ${t.relay}` : '');
  function payload() {
    if (!draft?.name.trim()) throw new Error('Give this routine a name. Your draft has not been saved.');
    if (!draft.steps.length || draft.steps.length > 20) throw new Error('Choose between 1 and 20 steps.');
    const available = targets();
    return { name: draft.name.trim(), steps: draft.steps.map((row, index) => {
      if (row.original && !row.edited) return copy(row.original);
      const t = available.find(t => t.key === row.target);
      if (!t || !t.effects.includes(row.effect)) throw new Error('Choose a registered target and supported effect for step ' + (index + 1) + '.');
      const original = row.original ? copy(row.original) : {};
      // Retain driver metadata when the same kind of step is edited.
      if (original.type && original.type !== t.type) throw new Error('Remove this step and add a new one to use a different device type.');
      return t.type === 'shelly.switch' ? { ...original, type: t.type, device: t.selector, value: row.effect } : { ...original, type: t.type, device_id: t.identity, capability: row.effect };
    }) };
  }
  function invalidated() {
    preview = null; saveCandidate = null;
    document.getElementById('routine-preview')?.remove();
    notice = 'Unsaved draft. Preview the current targets and effects before saving.'; failed = false;
    const status = document.getElementById('routine-status'); if (status) { status.textContent = notice; status.className = 'routine-status'; }
  }
  function newDraft(effect) {
    const start = () => { draft = { name: '', steps: [{ target: '', effect }] }; preview = null; saveCandidate = null; archiveReview = null; departure = null; notice = 'Choose the devices for your routine, then review and save it.'; failed = false; paint(); };
    if (draft) { departure = start; notice = 'Keep your current draft or explicitly discard it before opening a new template.'; paint(); } else start();
  }
  async function api(path, method = 'GET', body, signal) {
    const requestEpoch = epoch;
    const response = await fetch('/actions' + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
    if (response.status === 401 || response.status === 403) { if (alive(requestEpoch)) window.dispatchEvent(new CustomEvent('tli-session-locked')); throw new Error('Unlock TLI to continue.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(typeof data?.detail === 'string' ? data.detail : 'Request failed (' + response.status + ').'), { status: response.status });
    return data;
  }
  const validCaps = v => v?.review_protocol === protocol && Array.isArray(v.devices) && v.devices.length <= 2000 && v.devices.every(d => d && typeof d === 'object') && Array.isArray(v.hp_devices) && v.hp_devices.length <= 2000 && v.hp_devices.every(d => d && typeof d === 'object') && typeof v.trigger_engine?.available === 'boolean';
  const validSaved = v => Array.isArray(v?.actions) && v.actions.length <= 1000 && v.actions.every(a => a && id(a.id) && text(a.name, 120) && Array.isArray(a.steps)) && Array.isArray(v.triggers) && v.triggers.length <= 1000 && v.triggers.every(t => t && typeof t === 'object');
  const validReceipts = v => Array.isArray(v?.items) && v.items.length <= 200 && v.items.every(r => r && typeof r === 'object' && text(r.summary || ''));
  const validDefinition = (v, expectedId) => v?.ok === true && v.protocol === protocol && hash(v.revision) &&
    v.action?.id === expectedId && text(v.action.name, 120) && Array.isArray(v.action.steps) && v.action.steps.length <= 20 &&
    v.action.steps.every(step => step && typeof step === 'object' && !Array.isArray(step));
  function validReview(v, expectedId) {
    return v?.ok === true && v.protocol === protocol && v.actions_performed === false && v.trigger_active === false && Number.isFinite(Date.parse(v.checked_at)) && text(v.name, 120) && text(v.scope) && hash(v.target_revision) && hash(expectedId ? v.revision : v.draft_revision) && (!expectedId || v.action_id === expectedId) && typeof v.available === 'boolean' && v.errors && typeof v.errors === 'object' && !Array.isArray(v.errors) && Array.isArray(v.steps) && v.steps.length <= 20 && v.steps.every((row, i) => row.index === i && id(row.step_type) && (text(row.effect, 100) || !v.available && row.effect == null) && (row.target === null || row.target && (row.target.id == null || id(row.target.id)) && (row.target.name == null || text(row.target.name, 256)) && id(row.target.address) && Number.isInteger(row.target.relay))) && (!v.available || v.steps.length > 0 && !Object.keys(v.errors).length && v.steps.every(r => r.target));
  }
  function previewMatches(v, p) {
    if (v.name !== p.name || v.steps.length !== p.steps.length) return false;
    return v.steps.every((row, index) => {
      const step = p.steps[index]; if (row.step_type !== step.type || (row.effect || '') !== (step.value || step.capability || '')) return false;
      if (!row.target) return !v.available;
      if (step.type === 'homepower.execute') return row.target.id === step.device_id;
      const matches = targets().filter(t => t.selector === step.device || t.name === step.device);
      const t = matches.length === 1 ? matches[0] : null;
      return !!t && row.target.address === t.address && row.target.relay === t.relay && (!t.identity || row.target.id === t.identity);
    });
  }
  async function refresh() {
    if (!active || locked || busy()) return;
    const token = ++epoch, controller = new AbortController(); read = controller; notice = 'Reading registered targets, saved routines and recorded results…'; failed = false; paint();
    try {
      const all = await Promise.allSettled(['/capabilities', '/list', '/receipts?limit=50'].map(path => api(path, 'GET', undefined, controller.signal)));
      if (!alive(token)) return;
      const validators = [validCaps, validSaved, validReceipts], errors = [];
      all.forEach((result, i) => {
        if (result.status !== 'fulfilled' || !validators[i](result.value)) { errors.push(['Registered targets', 'Saved routines', 'Recorded results'][i] + ' unavailable'); return; }
        if (i === 0) caps = result.value; else if (i === 1) saved = result.value; else receipts = result.value;
      });
      checked = new Date().toISOString(); preview = null; saveCandidate = null; runReview = null;
      notice = errors.length ? errors.join('. ') + '. Previous results and your draft are retained; they may be out of date.' : 'Saved state refreshed. No device was checked or operated.';
      failed = errors.length > 0;
    } finally { if (read === controller) read = null; if (alive(token)) { paint(); consumePendingOpen(); } }
  }
  async function editSaved(actionId, duplicate = false) {
    if (draft) { departure = () => { draft = null; departure = null; return editSaved(actionId, duplicate); }; notice = 'Keep your draft or discard it before opening another routine.'; paint(); return; }
    const token = ++epoch, controller = new AbortController(); read = controller; notice = 'Reading the saved routine…'; failed = false; paint();
    try {
      const v = await api('/' + encodeURIComponent(actionId) + '/definition', 'GET', undefined, controller.signal); if (!alive(token)) return;
      if (!validDefinition(v, actionId)) throw new Error('The saved definition was incomplete. Nothing was changed.');
      const options = targets();
      draft = { name: duplicate ? (v.action.name.slice(0, 110) + ' copy') : v.action.name,
        id: duplicate ? null : actionId, revision: duplicate ? null : v.revision, duplicate,
        baseSteps: copy(v.action.steps), steps: v.action.steps.map(step => {
          const matches = options.filter(t => step.type === t.type && (step.type === 'homepower.execute' ? step.device_id === t.identity : step.device === t.selector || step.device === t.name));
          const target = matches.length === 1 ? matches[0] : null;
          return { original: copy(step), target: target?.key || '', effect: step.value || step.capability || '', retained: !target || !target.effects.includes(step.value || step.capability), edited: false };
        }) };
      preview = null; saveCandidate = null; runReview = null; archiveReview = null;
      notice = duplicate ? 'Unsaved copy. Choose a name, review its steps and save a separate routine.' : 'Editing this routine. Its saved version stays available until you save changes.';
    } catch (error) { if (alive(token)) { notice = error.message; failed = true; } }
    finally { if (read === controller) read = null; if (alive(token)) paint(); }
  }
  async function reviewDraft() {
    if (draft?.id && draft.steps.every(row => row.original && !row.edited) && sameSteps(draft.steps.map(row => row.original), draft.baseSteps)) {
      if (!draft.name.trim()) throw new Error('Give this routine a name.');
      preview = { available: true, metadata: true };
      saveCandidate = { name: draft.name.trim(), expected_revision: draft.revision, request_id: requestId() };
      notice = 'Review the name change. Every existing step is kept exactly as saved.'; failed = false; paint(); return;
    }
    const p = payload(), token = ++epoch, controller = new AbortController(); read = controller; preview = null; saveCandidate = null; notice = 'Resolving the exact registered targets…'; failed = false; paint();
    try {
      const v = await api('/preview', 'POST', p, controller.signal); if (!alive(token)) return;
      if (!validReview(v) || !previewMatches(v, p)) throw new Error('The preview did not confirm the requested targets and effects. Nothing was saved or run.');
      const keepsUnavailable = (draft.id || draft.duplicate) && Object.keys(v.errors).every(index => draft.steps[Number(index)]?.original && !draft.steps[Number(index)].edited);
      preview = v; saveCandidate = v.available || keepsUnavailable ? { ...copy(p), ...(draft.id ? { expected_revision: draft.revision } : {}), request_id: requestId() } : null;
      notice = v.available ? 'Preview ready. Saving records this routine; it does not run it.' : keepsUnavailable ? 'Unavailable saved steps are preserved. You can save the definition, but it cannot run until every step is available.' : 'Some targets are unavailable. Correct the draft and preview it again.'; failed = !saveCandidate;
    } catch (error) { if (alive(token)) { notice = error.message; failed = true; } }
    finally { if (read === controller) read = null; if (alive(token)) { paint(); document.getElementById('routine-preview')?.focus(); } }
  }
  async function saveDraft() {
    if (!saveCandidate || !preview) return;
    const p = copy(saveCandidate), token = epoch, reservation = {}; mutation = reservation; notice = 'Saving the reviewed routine…'; failed = false; paint();
    try {
      const editing = draft.id, expectedSteps = p.steps || draft.baseSteps;
      const v = await api(editing ? '/' + encodeURIComponent(editing) : '/approve', editing ? 'PATCH' : 'POST', p); if (!alive(token)) return;
      if (v?.ok !== true || v.trigger_active !== false || !id(v.action?.id) || editing && (v.action.id !== editing || !hash(v.revision)) || v.action.name !== p.name || !sameSteps(v.action.steps, expectedSteps) || !(typeof v.receipt_saved === 'boolean' || v.duplicate === true)) throw new Error('The response did not confirm the exact reviewed routine.');
      saved = saved || { actions: [], triggers: [] }; saved.actions = [v.action, ...saved.actions.filter(a => a.id !== v.action.id)];
      draft = null; preview = null; saveCandidate = null;
      changed();
      notice = v.receipt_saved === false ? 'Routine saved. Its history receipt could not be saved. No device action ran.' : 'Routine saved. Review it separately before choosing Run.'; failed = v.receipt_saved === false;
    } catch (error) { if (alive(token)) { notice = error.message + (error.status === 409 && draft?.id ? ' Your draft is retained. Choose Reload saved version to review the current routine before editing again.' : ' Save outcome is unconfirmed. Your draft is retained. Retry the same save explicitly to avoid creating a duplicate.'); failed = true; } }
    finally { if (mutation === reservation) mutation = null; if (active && !locked) paint(); }
  }
  async function prepareArchive(actionId) {
    const token = ++epoch, controller = new AbortController(); read = controller; archiveReview = null; runReview = null; notice = 'Reading the current routine…'; failed = false; paint();
    try {
      const v = await api('/' + encodeURIComponent(actionId) + '/definition', 'GET', undefined, controller.signal); if (!alive(token)) return;
      if (!validDefinition(v, actionId)) throw new Error('The saved definition was incomplete. Nothing was changed.');
      archiveReview = { action: v.action, body: { archived: v.action.archived !== true, expected_revision: v.revision, request_id: requestId() } };
      notice = archiveReview.body.archived ? 'Archive removes this routine from your active list. Its steps and history are kept.' : 'Restore brings this routine back to your active list. It does not run it.';
    } catch (error) { if (alive(token)) { notice = error.message; failed = true; } }
    finally { if (read === controller) read = null; if (alive(token)) paint(); }
  }
  async function saveArchive() {
    if (!archiveReview) return;
    const reviewed = copy(archiveReview), token = epoch, reservation = {}; mutation = reservation; notice = 'Saving routine visibility…'; failed = false; paint();
    try {
      const v = await api('/' + encodeURIComponent(reviewed.action.id), 'PATCH', reviewed.body); if (!alive(token)) return;
      if (!validDefinition(v, reviewed.action.id) || v.action.archived !== reviewed.body.archived || v.action.name !== reviewed.action.name || !sameSteps(v.action.steps, reviewed.action.steps)) throw new Error('The requested archive state was not confirmed.');
      saved.actions = saved.actions.map(row => row.id === v.action.id ? v.action : row);
      archiveReview = null; runReview = null; changed();
      notice = reviewed.body.archived ? 'Routine archived. You can restore it from Archived routines.' : 'Routine restored. Review it before running.';
      if (v.receipt_saved === false) notice += ' Its history receipt could not be saved.';
      failed = v.receipt_saved === false;
    } catch (error) { if (alive(token)) { notice = error.message + ' Your archive review is retained. Retry the same request or review the current version.'; failed = true; } }
    finally { if (mutation === reservation) mutation = null; if (alive(token)) paint(); }
  }
  async function reviewRun(actionId) {
    const token = ++epoch, controller = new AbortController(); read = controller; runReview = null; notice = 'Reading the current saved routine and its exact targets…'; failed = false; paint();
    try {
      const v = await api('/' + encodeURIComponent(actionId) + '/review', 'GET', undefined, controller.signal); if (!alive(token)) return;
      if (!validReview(v, actionId)) throw new Error('The run review was incomplete. No action was requested.');
      runReview = { ...v, request_id: requestId(), acknowledged: false };
      notice = v.available ? 'Review every effect and acknowledge the exact targets before running.' : 'This routine is unavailable for execution. The saved definition remains unchanged.'; failed = !v.available;
    } catch (error) { if (alive(token)) { notice = error.message + ' Earlier results are retained.'; failed = true; } }
    finally { if (read === controller) read = null; if (alive(token)) { paint(); document.getElementById('routine-run-review')?.focus(); } }
  }
  async function run() {
    if (!runReview?.available || !runReview.acknowledged) return;
    const review = copy(runReview), token = epoch, reservation = {}; mutation = reservation; runReview = null;
    notice = 'Run requested. Leaving this view does not cancel work on the host.'; failed = false; paint();
    try {
      const v = await api('/run/' + encodeURIComponent(review.action_id), 'POST', { request_id: review.request_id, expected_revision: review.revision, expected_targets: review.target_revision });
      if (!alive(token)) return;
      if (typeof v?.ok !== 'boolean' || !Array.isArray(v.results) || v.results.length !== review.steps.length || !v.results.every(r => r && typeof r.ok === 'boolean') || v.ok !== v.results.every(r => r.ok) || !text(v.summary) || !(typeof v.receipt_saved === 'boolean' || v.duplicate === true)) throw new Error('A complete execution result was not received.');
      outcome = { name: review.name, action_id: review.action_id, checked_at: new Date().toISOString(), ok: v.ok, summary: v.summary, results: v.results, receipt_saved: v.receipt_saved, reviewed_steps: review.steps };
      notice = v.ok ? 'The driver reported success for every step. This is not a new physical-state measurement.' : 'The run returned failed or partial results. Review every step before preparing another run.';
      if (v.receipt_saved === false) notice += ' The history receipt was not saved; this visible result is the available receipt.';
      failed = !v.ok || v.receipt_saved === false;
    } catch (error) { if (alive(token)) { notice = error.message + ' Run outcome is unconfirmed. Earlier results are retained. Inspect devices and recorded results, then request a new review only when it is safe. No automatic retry will occur.'; failed = true; } }
    finally { if (mutation === reservation) mutation = null; if (active && !locked) paint(); }
  }
  function reviewRows(v) {
    const list = node('ol', null, 'routine-reviewed-steps');
    v.steps.forEach(row => {
      const item = node('li'); item.append(node('strong', row.effect?.endsWith('off') ? 'Switch off' : row.effect?.endsWith('on') ? 'Switch on' : row.effect?.endsWith('toggle') ? 'Toggle current state' : row.effect || 'Saved step'));
      item.append(node('p', row.target ? `${row.target.name || 'Unnamed device'} · ${row.target.id || 'Registered address + relay; physical identity unverified'} · ${row.target.address} · relay ${row.target.relay}` : 'Target unavailable'));
      if (v.errors[row.index]) item.append(node('p', String(v.errors[row.index]), 'routine-warning'));
      list.append(item);
    }); return list;
  }
  function editor() {
    const box = section(draft?.id ? 'Edit routine' : draft?.duplicate ? 'Copy a routine' : 'Make everyday tasks easier', 'routine-editor');
    box.append(node('p', 'A routine runs your chosen device actions in order when you press Run.', 'routine-muted'));
    if (!draft) {
      box.append(actions(button('Switch devices on', () => newDraft('on')), button('Switch devices off', () => newDraft('off')), button('Custom routine', () => newDraft(''))));
      box.append(node('p', 'Try “Evening lights”, “Turn off my office” or “Movie time”. Choose your own devices for each step.'));
      if (caps && !targets().length) box.append(node('p', 'Connect a supported smart device to make your first routine.'), button('Connect a smart device', () => window.switchPanel?.('panel-homeauto')));
      return box;
    }
    const name = node('input'); name.value = draft.name; name.maxLength = 120; name.disabled = busy(); name.setAttribute('aria-label', 'Routine name');
    name.addEventListener('input', () => { if (busy() || !draft) return; draft.name = name.value; invalidated(); }); box.append(field('Routine name', name));
    const options = targets();
    if (!caps) box.append(node('p', 'Registered targets are unavailable. Refresh saved state to try again; your draft remains here.', 'routine-warning'));
    else if (!options.length) box.append(node('p', 'No supported switch devices are available yet. Connect a device, then return to this draft.'), button('Connect a smart device', () => window.switchPanel?.('panel-homeauto')));
    draft.steps.forEach((row, index) => {
      const line = node('div', null, 'routine-step'); line.append(node('h4', 'Step ' + (index + 1)));
      if (row.retained && !row.edited) {
        line.append(node('p', 'Saved step kept unchanged', 'routine-muted'), node('p', `${row.original.type || 'Unknown step'} · ${row.original.device || row.original.device_id || 'Saved target'}`));
        const details = node('details'); details.append(node('summary', 'Saved step details'), node('pre', JSON.stringify(row.original, null, 2))); line.append(details);
        if (['shelly.switch', 'homepower.execute'].includes(row.original.type)) line.append(button('Choose device for step ' + (index + 1), () => { row.retained = false; row.edited = true; invalidated(); paint(); }));
        else line.append(node('p', 'This editor cannot change this legacy step. It will be preserved when you save.', 'routine-muted'));
        box.append(line); return;
      }
      const target = select([['', 'Choose a registered target'], ...options.map(t => [t.key, targetLabel(t)])], row.target, 'Step ' + (index + 1) + ' target');
      const selected = options.find(t => t.key === row.target);
      if (row.target && !selected) { const o = node('option', 'Previous target unavailable — choose again'); o.value = row.target; target.append(o); target.value = row.target; }
      const effect = select([['', 'Choose effect'], ...(selected?.effects || []).map(e => [e, e.endsWith('toggle') ? 'Toggle current state' : e.endsWith('off') ? 'Switch off' : 'Switch on'])], row.effect, 'Step ' + (index + 1) + ' effect');
      target.addEventListener('change', () => { if (busy() || !draft) return; row.edited = true; row.target = target.value; const next = options.find(t => t.key === row.target); const simple = row.effect.replace('switch.', ''); row.effect = next?.effects.find(e => e.replace('switch.', '') === simple) || ''; invalidated(); paint(); });
      effect.addEventListener('change', () => { if (busy() || !draft) return; row.edited = true; row.effect = effect.value; invalidated(); });
      line.append(field('Device', target), field('Action', effect));
      if (selected) { const details = node('details'); details.append(node('summary', 'Device details'), node('p', `${selected.binding} · ${selected.identity || 'Address binding'} · ${selected.address} · relay ${selected.relay}. The current target binding is reviewed before Run.`, 'routine-muted')); line.append(details); }
      line.append(button('Remove step ' + (index + 1), () => { draft.steps.splice(index, 1); invalidated(); paint(); })); box.append(line);
    });
    const add = button('Add step', () => { draft.steps.push({ target: '', effect: '' }); invalidated(); paint(); }); add.disabled ||= draft.steps.length >= 20;
    box.append(actions(add, button('Preview routine', reviewDraft, true), button('Discard draft', () => { departure = () => { draft = null; preview = null; saveCandidate = null; departure = null; paint(); }; notice = 'Discard this unsaved routine or keep editing.'; paint(); })));
    if (draft.id) box.append(button('Reload saved version', () => editSaved(draft.id)));
    if (preview) {
      const p = section('2. Review before saving', 'routine-review'); p.id = 'routine-preview'; p.tabIndex = -1;
      if (preview.metadata) p.append(node('p', 'Routine name: ' + draft.name.trim()), node('p', 'All ' + draft.steps.length + ' saved steps remain unchanged.'));
      else p.append(node('p', preview.scope), node('p', 'Targets checked ' + stamp(preview.checked_at), 'routine-muted'), reviewRows(preview));
      if (saveCandidate) p.append(button(failed ? 'Retry same reviewed save' : draft.id ? 'Save routine changes' : 'Save reviewed routine', saveDraft, true)); box.append(p);
    }
    return box;
  }
  function paint() {
    const root = document.getElementById('routine-workspace'); if (!root || !active || locked) return;
    root.replaceChildren(); root.setAttribute('aria-busy', busy() ? 'true' : 'false');
    const toolbar = node('div', null, 'routine-toolbar'); toolbar.append(node('p', 'Your devices, working together', 'routine-eyebrow'), button('Refresh saved state', refresh)); root.append(toolbar);
    const status = node('p', notice, 'routine-status' + (failed ? ' error' : '')); status.id = 'routine-status'; status.setAttribute('role', 'status'); root.append(status);
    if (departure) root.append(actions(button('Keep editing', () => { departure = null; notice = 'Draft retained.'; paint(); }), button('Discard draft and continue', () => departure())));
    const grid = node('div', null, 'routine-grid'); grid.append(editor());
    const roster = section(showArchived ? 'Archived routines' : 'Saved routines', 'routine-roster'); roster.append(node('p', 'Choose a routine to review and run. Pin favorites to Home for easy access.', 'routine-muted'));
    roster.append(button(showArchived ? 'Show active routines' : 'Archived routines', () => { showArchived = !showArchived; savedLimit = 30; paint(); }));
    if (!saved) roster.append(node('p', 'Saved routines are unavailable or have not loaded.'));
    else if (!saved.actions.length) roster.append(node('p', 'No saved routines yet. Start with an unsaved template.'));
    else {
      const search = node('input'); search.type = 'search'; search.value = savedQuery; search.setAttribute('aria-label', 'Find saved routines'); search.disabled = busy();
      search.addEventListener('change', () => { if (busy()) return; savedQuery = search.value; savedLimit = 30; paint(); });
      roster.append(field('Find a saved routine', search));
      const matching = saved.actions.filter(a => (a.archived === true) === showArchived && (a.name + ' ' + a.id).toLowerCase().includes(savedQuery.toLowerCase()));
      matching.slice(0, savedLimit).forEach(a => {
        const row = node('article'); row.append(node('h4', a.name), node('p', `${a.steps.length} steps · saved ${stamp(a.updated_at || a.created_at)}`, 'routine-muted'));
        if (!showArchived) row.append(button('Review run: ' + a.name, () => reviewRun(a.id)));
        const more = node('details', null, 'routine-card-menu'); more.append(node('summary', 'Manage routine'));
        more.append(actions(button('Edit: ' + a.name, () => editSaved(a.id)), button('Duplicate: ' + a.name, () => editSaved(a.id, true)),
          button((showArchived ? 'Restore: ' : 'Archive: ') + a.name, () => prepareArchive(a.id))));
        if (!showArchived) more.append(button((favoriteIds().includes(a.id) ? 'Unpin from Home: ' : 'Pin to Home: ') + a.name, () => toggleFavorite(a.id)));
        row.append(more); if (a.enabled === false) row.append(node('p', 'Saved as disabled. Restoring does not enable it.', 'routine-muted')); roster.append(row);
      });
      roster.append(node('p', `Showing ${Math.min(savedLimit, matching.length)} of ${matching.length} matching routines.`, 'routine-muted'));
      if (matching.length > savedLimit) roster.append(button('Show 30 more routines', () => { savedLimit += 30; paint(); }));
    }
    if (checked) roster.append(node('p', 'Last refresh attempted ' + stamp(checked), 'routine-muted')); grid.append(roster); root.append(grid);
    if (archiveReview) {
      const box = section((archiveReview.body.archived ? 'Archive ' : 'Restore ') + archiveReview.action.name, 'routine-review');
      box.append(node('p', archiveReview.body.archived ? 'Keep this routine and its history in Archived routines. It cannot run while archived.' : 'Return this routine to your active list. Its previous enabled or disabled state is preserved.'),
        actions(button(failed ? 'Retry same visibility change' : archiveReview.body.archived ? 'Archive routine' : 'Restore routine', saveArchive, true),
          button('Review current version', () => prepareArchive(archiveReview.action.id)), button('Cancel visibility change', () => { archiveReview = null; paint(); })));
      root.append(box);
    }
    if (runReview) {
      const box = section('3. Review this run · ' + runReview.name, 'routine-run-review'); box.id = 'routine-run-review'; box.tabIndex = -1;
      box.append(node('p', runReview.scope), node('p', 'Targets checked ' + stamp(runReview.checked_at), 'routine-muted'), reviewRows(runReview));
      if (runReview.available) {
        const agree = node('input'); agree.type = 'checkbox'; agree.checked = runReview.acknowledged; agree.disabled = busy(); agree.setAttribute('aria-label', 'I reviewed every target and effect');
        const go = button('Run reviewed routine', run, true); go.disabled ||= !runReview.acknowledged;
        agree.addEventListener('change', () => { if (busy() || !runReview) return; runReview.acknowledged = agree.checked; go.disabled = !agree.checked; });
        box.append(field('I reviewed every target and effect. Run these steps now.', agree), actions(go, button('Close run review', () => { runReview = null; paint(); })));
      } root.append(box);
    }
    if (outcome) {
      const box = section('Last received run result · ' + outcome.name, 'routine-outcome'); box.id = 'routine-outcome';
      box.append(node('p', outcome.ok ? 'Driver-reported completion' : 'Failed or partial execution'), node('p', outcome.summary), node('p', 'Received ' + stamp(outcome.checked_at), 'routine-muted'));
      if (outcome.receipt_saved === false) box.append(node('p', 'History receipt not saved. Keep this visible result for your records.', 'routine-warning'));
      const list = node('ol'); outcome.results.forEach((r, index) => {
        const step = outcome.reviewed_steps[index], target = step.target;
        list.append(node('li', (r.ok ? 'Reported success' : r.skipped ? 'Not run' : 'Failed') + ' · ' + step.effect + ' · ' + (target.id || 'Registered address binding') + ' · ' + target.address + ' · relay ' + target.relay + (r.error ? ' · ' + r.error : '')));
      }); box.append(list); root.append(box);
    }
    const history = node('details', null, 'routine-secondary'); history.append(node('summary', 'Recorded results'));
    history.append(node('p', 'Saved receipts report what the host recorded. A started entry without a final result does not establish completion. Refreshing does not repeat a run.'));
    if (!receipts) history.append(node('p', 'Recorded results are unavailable or have not loaded.'));
    else if (!receipts.items.length) history.append(node('p', 'No recorded results returned.'));
    else receipts.items.forEach(r => { const row = node('article'); row.append(node('strong', r.kind === 'action_started' ? 'Run started; completion is not established by this entry' : r.kind === 'action_run' ? 'Run result recorded' : r.kind === 'action_saved' ? 'Save recorded' : 'Event recorded'), node('p', r.summary || 'No summary recorded'), node('p', stamp(r.ts), 'routine-muted')); history.append(row); }); root.append(history);
    const legacy = node('details', null, 'routine-secondary'); legacy.append(node('summary', 'Legacy trigger definitions · read only'));
    legacy.append(node('p', 'These saved definitions are not activated by this workspace. It does not provide an automatic trigger engine. Existing Home Power scenes use their separate controller.'));
    if (!saved) legacy.append(node('p', 'Saved definitions are unavailable.'));
    else if (!saved.triggers.length) legacy.append(node('p', 'No legacy trigger definitions were returned.'));
    else {
      saved.triggers.slice(0, legacyLimit).forEach(t => { const row = node('article'); row.append(node('strong', String(t.type || 'Unknown trigger')), node('p', `Saved target: ${t.node_id || t.device || 'Unspecified'} · routine: ${t.action_id || 'Unspecified'}`), node('p', 'Stored enabled flag: ' + String(t.enabled) + ' · not an activation or execution status', 'routine-muted')); const data = node('pre', JSON.stringify(t, null, 2)); row.append(data); legacy.append(row); });
      if (saved.triggers.length > legacyLimit) legacy.append(button('Show 30 more definitions', () => { legacyLimit += 30; paint(); }));
    } root.append(legacy);
  }
  function close(clear = false) {
    active = false; epoch++; read?.abort(); read = null; preview = null; saveCandidate = null; runReview = null; archiveReview = null; departure = null; pendingOpen = null;
    if (mutation) backgroundRequest = true;
    if (clear) { caps = null; saved = null; receipts = null; draft = null; outcome = null; checked = ''; notice = ''; savedQuery = ''; savedLimit = 30; legacyLimit = 30; showArchived = false; clearFavorites(); }
    document.getElementById('routine-workspace')?.replaceChildren();
  }
  function open() {
    if (locked || !accessReady) return; if (active) { paint(); consumePendingOpen(); return; } active = true;
    notice = backgroundRequest ? 'An earlier request may have completed on the host. Inspect saved routines and recorded results before preparing another run.' : 'Loading saved routines…';
    if (backgroundRequest) { backgroundRequest = false; failed = true; paint(); } else { paint(); refresh(); }
  }
  function consumePendingOpen() {
    if (!pendingOpen || busy() || !active || locked) return;
    const actionId = pendingOpen; pendingOpen = null; reviewRun(actionId);
  }
  function openSaved(actionId) {
    if (!id(actionId) || locked || !accessReady || document.hidden) return;
    window.switchPanel?.('panel-automations');
    pendingOpen = actionId; open();
  }
  function favoriteIds() {
    try { const rows = JSON.parse(window.localStorage?.getItem(favoriteKey) || '[]'); return Array.isArray(rows) ? [...new Set(rows.filter(value => id(value)))].slice(0, 50) : []; } catch { return []; }
  }
  function toggleFavorite(actionId) {
    try {
      const ids = favoriteIds(), next = ids.includes(actionId) ? ids.filter(value => value !== actionId) : [...ids, actionId];
      if (next.length > 50) throw new Error('You can pin up to 50 routines to Home.');
      if (!window.localStorage) throw new Error('Browser storage is unavailable.');
      window.localStorage.setItem(favoriteKey, JSON.stringify(next));
      notice = next.includes(actionId) ? 'Routine pinned to Home on this browser.' : 'Routine unpinned from Home on this browser.'; failed = false;
      changed(); paint();
    } catch (error) { notice = 'Could not save this favorite. ' + error.message; failed = true; paint(); }
  }
  function clearFavorites() {
    favoriteEpoch++; for (const mount of favoriteMounts) { mount.replaceChildren(); mount.hidden = true; }
  }
  function changed() {
    window.dispatchEvent(new CustomEvent('tli-routines-changed'));
    if (!locked && !document.hidden) for (const mount of favoriteMounts) if (mount.isConnected !== false) renderFavorites(mount);
  }
  async function renderFavorites(mount) {
    if (typeof mount === 'string') mount = document.getElementById(mount);
    if (!mount) return;
    const ticket = {}; favoriteTickets.set(mount, ticket);
    favoriteMounts.add(mount); mount.replaceChildren(); mount.hidden = true;
    if (locked || !accessReady || document.hidden) return;
    const favorites = favoriteIds();
    if (!favorites.length) { mount.append(node('p', 'Pin a saved routine in Devices to keep it here.', 'routine-muted')); return; }
    mount.hidden = false;
    const token = favoriteEpoch; mount.append(node('p', 'Loading your favorite routines…', 'routine-muted'));
    try {
      const response = await fetch('/actions/list', { method: 'GET', cache: 'no-store' });
      if (token !== favoriteEpoch || favoriteTickets.get(mount) !== ticket || locked || document.hidden) return;
      if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
      const data = await response.json(); if (token !== favoriteEpoch || favoriteTickets.get(mount) !== ticket || locked || document.hidden) return;
      if (!response.ok || !validSaved(data)) throw new Error('Saved routines are unavailable.');
      mount.replaceChildren();
      for (const actionId of favorites) {
        const matches = data.actions.filter(row => row.id === actionId);
        const action = matches.length === 1 ? matches[0] : null;
        if (!action || action.archived === true) continue;
        const card = node('article', null, 'routine-favorite'); card.append(node('strong', action.name), node('p', action.enabled === false ? 'Saved as disabled' : action.steps.length + ' steps', 'routine-muted'));
        const review = node('button', 'Review and run', 'btn-outline'); review.type = 'button'; review.disabled = action.enabled === false;
        review.addEventListener('click', () => { if (!review.disabled && token === favoriteEpoch && favoriteTickets.get(mount) === ticket) openSaved(action.id); }); card.append(review); mount.append(card);
      }
      if (!mount.children.length) mount.append(node('p', 'Your pinned routines are archived or unavailable. Review them in Devices.', 'routine-muted'));
    } catch { if (token === favoriteEpoch && favoriteTickets.get(mount) === ticket && !locked) mount.replaceChildren(node('p', 'Favorite routines could not be loaded. Open Devices to refresh them.', 'routine-muted')); }
  }
  window.TLIManualRoutines = { onOpen: open, onClose: () => { resumeAfterUnlock = false; close(); }, refresh, openSaved };
  window.TLIRoutineFavorites = { render: renderFavorites, clear: clearFavorites };
  window.addEventListener('tli-session-locked', () => {
    resumeAfterUnlock ||= active;
    locked = true; accessReady = false; close(true);
  });
  window.addEventListener('tli-session-unlocked', () => { locked = false; });
  window.addEventListener('tli-private-observation-ready', () => {
    if (locked || accessReady) return;
    accessReady = true;
    if (resumeAfterUnlock && !document.hidden) { resumeAfterUnlock = false; open(); }
    if (!document.hidden) for (const mount of favoriteMounts) if (mount.isConnected !== false) renderFavorites(mount);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { resumeVisible = active; close(true); }
    else if (resumeAfterUnlock && !locked && accessReady) { resumeAfterUnlock = false; open(); }
    else if (resumeVisible && !locked) {
      resumeVisible = false; const root = document.getElementById('routine-workspace'); if (!root) return;
      const b = node('button', 'Reload saved routines', 'btn-outline'); b.type = 'button'; b.addEventListener('click', open);
      root.replaceChildren(node('p', 'Private drafts and reviews were cleared while this page was in the background. Leaving did not cancel any requested host action.'), b);
    }
  });
  window.addEventListener('storage', event => { if (event.key === favoriteKey) { clearFavorites(); if (active) paint(); changed(); } });
  window.addEventListener('pagehide', () => close(true));
  document.addEventListener('tli-panel-switched', event => { if ((event.detail?.panelId || event.detail?.panel || event.detail?.id) !== 'panel-automations') { resumeAfterUnlock = false; if (active) close(); } });
})();
