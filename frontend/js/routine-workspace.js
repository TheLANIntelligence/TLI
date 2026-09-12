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
  const cleanStep = step => step.type === 'shelly.switch'
    ? { type: step.type, device: step.device, value: step.value }
    : { type: step.type, device_id: step.device_id, capability: step.capability };
  let active = false, locked = false, epoch = 0, read = null, mutation = null;
  let caps = null, saved = null, receipts = null, checked = '', draft = null, preview = null, saveCandidate = null;
  let runReview = null, outcome = null, notice = '', failed = false, departure = null, backgroundRequest = false;
  let savedQuery = '', savedLimit = 30, legacyLimit = 30, resumeVisible = false;
  const alive = token => active && !locked && token === epoch;
  const busy = () => !!read || !!mutation;

  function requestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  }
  function button(label, action, primary = false) {
    const b = node('button', label, primary ? 'btn-primary' : 'btn-outline'); b.type = 'button'; b.disabled = busy();
    b.addEventListener('click', () => {
      if (b.disabled || busy() || locked || !active) return;
      return Promise.resolve().then(() => { if (!locked && active && !busy()) return action(); }).catch(error => {
        if (active && !locked) { notice = error.message; failed = true; paint(); }
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
      result.push({ key: 'hp:' + d.device_id, type: 'homepower.execute', identity: d.device_id, name: d.name || 'Unnamed device', address: d.ip || d.host || '', relay: Number.isInteger(d.relay) ? d.relay : 0, effects, binding: 'Registered device ID', physical: physical(d) });
    }
    for (const d of caps.devices) {
      const identity = d.id || d.source_id, address = d.ip || d.host;
      if (!id(address) || !Number.isInteger(d.relay) || d.relay < 0) continue;
      // Never choose a duplicate address/relay through the resolver's literal-address fallback.
      const stable = id(identity) && legacyIds.get(identity) === 1;
      if (!stable && (id(identity) || addresses.get(physical(d)) !== 1 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address))) continue;
      if (result.some(row => row.physical === physical(d))) continue;
      result.push({ key: 'shelly:' + (stable ? identity : address + ':' + d.relay), type: 'shelly.switch', identity: stable ? identity : null,
        selector: stable ? identity : address + ' relay ' + d.relay, name: d.name || 'Unnamed device', address, relay: d.relay,
        effects: ['on', 'off'], binding: stable ? 'Registered device ID' : 'Registered address + relay; physical identity unverified' });
    }
    return result;
  }
  const targetLabel = t => `${t.name} · ${t.identity || 'address binding'} · ${t.address || 'Address unavailable'} · relay ${t.relay}`;
  function payload() {
    if (!draft?.name.trim()) throw new Error('Give this routine a name. Your draft has not been saved.');
    if (!draft.steps.length || draft.steps.length > 20) throw new Error('Choose between 1 and 20 steps.');
    const available = targets();
    return { name: draft.name.trim(), steps: draft.steps.map((row, index) => {
      const t = available.find(t => t.key === row.target);
      if (!t || !t.effects.includes(row.effect)) throw new Error('Choose a registered target and supported effect for step ' + (index + 1) + '.');
      return t.type === 'shelly.switch' ? { type: t.type, device: t.selector, value: row.effect } : { type: t.type, device_id: t.identity, capability: row.effect };
    }) };
  }
  function invalidated() {
    preview = null; saveCandidate = null;
    document.getElementById('routine-preview')?.remove();
    notice = 'Unsaved draft. Preview the current targets and effects before saving.'; failed = false;
    const status = document.getElementById('routine-status'); if (status) { status.textContent = notice; status.className = 'routine-status'; }
  }
  function newDraft(effect) {
    const start = () => { draft = { name: '', steps: [{ target: '', effect }] }; preview = null; saveCandidate = null; departure = null; notice = 'Template opened as an unsaved draft. Choose each target yourself.'; failed = false; paint(); };
    if (draft) { departure = start; notice = 'Keep your current draft or explicitly discard it before opening a new template.'; paint(); } else start();
  }
  async function api(path, method = 'GET', body, signal) {
    const requestEpoch = epoch;
    const response = await fetch('/actions' + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
    if (response.status === 401) { if (alive(requestEpoch)) window.dispatchEvent(new CustomEvent('tli-session-locked')); throw new Error('Unlock TLI to continue.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(typeof data?.detail === 'string' ? data.detail : 'Request failed (' + response.status + ').'), { status: response.status });
    return data;
  }
  const validCaps = v => v?.review_protocol === protocol && Array.isArray(v.devices) && v.devices.length <= 2000 && v.devices.every(d => d && typeof d === 'object') && Array.isArray(v.hp_devices) && v.hp_devices.length <= 2000 && v.hp_devices.every(d => d && typeof d === 'object') && typeof v.trigger_engine?.available === 'boolean';
  const validSaved = v => Array.isArray(v?.actions) && v.actions.length <= 1000 && v.actions.every(a => a && id(a.id) && text(a.name, 120) && Array.isArray(a.steps)) && Array.isArray(v.triggers) && v.triggers.length <= 1000 && v.triggers.every(t => t && typeof t === 'object');
  const validReceipts = v => Array.isArray(v?.items) && v.items.length <= 200 && v.items.every(r => r && typeof r === 'object' && text(r.summary || ''));
  function validReview(v, expectedId) {
    return v?.ok === true && v.protocol === protocol && v.actions_performed === false && v.trigger_active === false && Number.isFinite(Date.parse(v.checked_at)) && text(v.name, 120) && text(v.scope) && hash(v.target_revision) && hash(expectedId ? v.revision : v.draft_revision) && (!expectedId || v.action_id === expectedId) && typeof v.available === 'boolean' && v.errors && typeof v.errors === 'object' && !Array.isArray(v.errors) && Array.isArray(v.steps) && v.steps.length <= 20 && v.steps.every((row, i) => row.index === i && id(row.step_type) && text(row.effect, 100) && (row.target === null || row.target && (row.target.id == null || id(row.target.id)) && (row.target.name == null || text(row.target.name, 256)) && id(row.target.address) && Number.isInteger(row.target.relay))) && (!v.available || v.steps.length > 0 && !Object.keys(v.errors).length && v.steps.every(r => r.target));
  }
  function previewMatches(v, p) {
    if (v.name !== p.name || v.steps.length !== p.steps.length) return false;
    return v.steps.every((row, index) => {
      const step = p.steps[index]; if (row.step_type !== step.type || row.effect !== (step.value || step.capability)) return false;
      if (!row.target) return !v.available;
      if (step.type === 'homepower.execute') return row.target.id === step.device_id;
      const t = targets().find(t => t.selector === step.device);
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
    } finally { if (read === controller) read = null; if (alive(token)) paint(); }
  }
  async function reviewDraft() {
    const p = payload(), token = ++epoch, controller = new AbortController(); read = controller; preview = null; saveCandidate = null; notice = 'Resolving the exact registered targets…'; failed = false; paint();
    try {
      const v = await api('/preview', 'POST', p, controller.signal); if (!alive(token)) return;
      if (!validReview(v) || !previewMatches(v, p)) throw new Error('The preview did not confirm the requested targets and effects. Nothing was saved or run.');
      preview = v; saveCandidate = v.available ? { ...copy(p), request_id: requestId() } : null;
      notice = v.available ? 'Preview ready. Saving records this routine; it does not run it.' : 'Some targets are unavailable. Correct the draft and preview it again.'; failed = !v.available;
    } catch (error) { if (alive(token)) { notice = error.message; failed = true; } }
    finally { if (read === controller) read = null; if (alive(token)) { paint(); document.getElementById('routine-preview')?.focus(); } }
  }
  async function saveDraft() {
    if (!saveCandidate || !preview?.available) return;
    const p = copy(saveCandidate), token = epoch, reservation = {}; mutation = reservation; notice = 'Saving the reviewed routine…'; failed = false; paint();
    try {
      const v = await api('/approve', 'POST', p); if (!alive(token)) return;
      if (v?.ok !== true || v.trigger_active !== false || !id(v.action?.id) || v.action.name !== p.name || !Array.isArray(v.action.steps) || JSON.stringify(v.action.steps.map(cleanStep)) !== JSON.stringify(p.steps) || !(typeof v.receipt_saved === 'boolean' || v.duplicate === true)) throw new Error('The response did not confirm the exact reviewed routine.');
      saved = saved || { actions: [], triggers: [] }; saved.actions = [v.action, ...saved.actions.filter(a => a.id !== v.action.id)];
      draft = null; preview = null; saveCandidate = null;
      notice = v.receipt_saved === false ? 'Routine saved. Its history receipt could not be saved. No device action ran.' : 'Routine saved. Review it separately before choosing Run.'; failed = v.receipt_saved === false;
    } catch (error) { if (alive(token)) { notice = error.message + ' Save outcome is unconfirmed. Your draft is retained. Retry the same save explicitly to avoid creating a duplicate.'; failed = true; } }
    finally { if (mutation === reservation) mutation = null; if (active && !locked) paint(); }
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
      const item = node('li'); item.append(node('strong', row.effect));
      item.append(node('p', row.target ? `${row.target.name || 'Unnamed device'} · ${row.target.id || 'Registered address + relay; physical identity unverified'} · ${row.target.address} · relay ${row.target.relay}` : 'Target unavailable'));
      if (v.errors[row.index]) item.append(node('p', String(v.errors[row.index]), 'routine-warning'));
      list.append(item);
    }); return list;
  }
  function editor() {
    const box = section('1. Prepare a routine', 'routine-editor');
    box.append(node('p', 'Steps run in order on the registered targets you choose. New templates have no device selected.', 'routine-muted'));
    if (!draft) {
      box.append(actions(button('Switch devices on', () => newDraft('on')), button('Switch devices off', () => newDraft('off')), button('Custom routine', () => newDraft(''))));
      box.append(node('p', 'Templates only open a draft. No AI, save or device action runs.')); return box;
    }
    const name = node('input'); name.value = draft.name; name.maxLength = 120; name.disabled = busy(); name.setAttribute('aria-label', 'Routine name');
    name.addEventListener('input', () => { if (busy() || !draft) return; draft.name = name.value; invalidated(); }); box.append(field('Routine name', name));
    const options = targets();
    if (!caps) box.append(node('p', 'Registered targets are unavailable. Refresh saved state to try again; your draft remains here.', 'routine-warning'));
    else if (!options.length) box.append(node('p', 'No uniquely identified switch targets are available. Review their saved IDs, addresses, relays and supported capabilities in Smart devices.'));
    draft.steps.forEach((row, index) => {
      const line = node('div', null, 'routine-step'); line.append(node('h4', 'Step ' + (index + 1)));
      const target = select([['', 'Choose a registered target'], ...options.map(t => [t.key, targetLabel(t)])], row.target, 'Step ' + (index + 1) + ' target');
      const selected = options.find(t => t.key === row.target);
      if (row.target && !selected) { const o = node('option', 'Previous target unavailable — choose again'); o.value = row.target; target.append(o); target.value = row.target; }
      const effect = select([['', 'Choose effect'], ...(selected?.effects || []).map(e => [e, e.endsWith('toggle') ? 'Toggle current state' : e.endsWith('off') ? 'Switch off' : 'Switch on'])], row.effect, 'Step ' + (index + 1) + ' effect');
      target.addEventListener('change', () => { if (busy() || !draft) return; row.target = target.value; const next = options.find(t => t.key === row.target); const simple = row.effect.replace('switch.', ''); row.effect = next?.effects.find(e => e.replace('switch.', '') === simple) || ''; invalidated(); paint(); });
      effect.addEventListener('change', () => { if (busy() || !draft) return; row.effect = effect.value; invalidated(); });
      line.append(field('Exact target', target), field('Effect', effect));
      if (selected) line.append(node('p', selected.binding + '. Availability is not probed by this picker.', 'routine-muted'));
      line.append(button('Remove step ' + (index + 1), () => { draft.steps.splice(index, 1); invalidated(); paint(); })); box.append(line);
    });
    const add = button('Add step', () => { draft.steps.push({ target: '', effect: '' }); invalidated(); paint(); }); add.disabled ||= draft.steps.length >= 20;
    box.append(actions(add, button('Preview routine', reviewDraft, true), button('Discard draft', () => { departure = () => { draft = null; preview = null; saveCandidate = null; departure = null; paint(); }; notice = 'Discard this unsaved routine or keep editing.'; paint(); })));
    if (preview) {
      const p = section('2. Review before saving', 'routine-review'); p.id = 'routine-preview'; p.tabIndex = -1;
      p.append(node('p', preview.scope), node('p', 'Targets checked ' + stamp(preview.checked_at), 'routine-muted'), reviewRows(preview));
      if (saveCandidate) p.append(button(failed ? 'Retry same reviewed save' : 'Save reviewed routine', saveDraft, true)); box.append(p);
    }
    return box;
  }
  function paint() {
    const root = document.getElementById('routine-workspace'); if (!root || !active || locked) return;
    root.replaceChildren(); root.setAttribute('aria-busy', busy() ? 'true' : 'false');
    const toolbar = node('div', null, 'routine-toolbar'); toolbar.append(node('p', 'Choose → Preview → Save → Review run → Run', 'routine-eyebrow'), button('Refresh saved state', refresh)); root.append(toolbar);
    const status = node('p', notice, 'routine-status' + (failed ? ' error' : '')); status.id = 'routine-status'; status.setAttribute('role', 'status'); root.append(status);
    if (departure) root.append(actions(button('Keep editing', () => { departure = null; notice = 'Draft retained.'; paint(); }), button('Discard draft and continue', () => departure())));
    const grid = node('div', null, 'routine-grid'); grid.append(editor());
    const roster = section('Saved routines', 'routine-roster'); roster.append(node('p', 'Saving and running are separate. Review current target bindings every time.', 'routine-muted'));
    if (!saved) roster.append(node('p', 'Saved routines are unavailable or have not loaded.'));
    else if (!saved.actions.length) roster.append(node('p', 'No saved routines yet. Start with an unsaved template.'));
    else {
      const search = node('input'); search.type = 'search'; search.value = savedQuery; search.setAttribute('aria-label', 'Find saved routines'); search.disabled = busy();
      search.addEventListener('change', () => { if (busy()) return; savedQuery = search.value; savedLimit = 30; paint(); });
      roster.append(field('Find a saved routine', search));
      const matching = saved.actions.filter(a => (a.name + ' ' + a.id).toLowerCase().includes(savedQuery.toLowerCase()));
      matching.slice(0, savedLimit).forEach(a => { const row = node('article'); row.append(node('h4', a.name), node('p', `${a.steps.length} steps · ${a.id} · saved ${stamp(a.updated_at || a.created_at)}`, 'routine-muted')); const b = button('Review run: ' + a.name, () => reviewRun(a.id)); row.append(b); if (a.enabled === false) row.append(node('p', 'Saved as disabled. Review will report whether it is available.')); roster.append(row); });
      roster.append(node('p', `Showing ${Math.min(savedLimit, matching.length)} of ${matching.length} matching routines.`, 'routine-muted'));
      if (matching.length > savedLimit) roster.append(button('Show 30 more routines', () => { savedLimit += 30; paint(); }));
    }
    if (checked) roster.append(node('p', 'Last refresh attempted ' + stamp(checked), 'routine-muted')); grid.append(roster); root.append(grid);
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
    active = false; epoch++; read?.abort(); read = null; preview = null; saveCandidate = null; runReview = null; departure = null;
    if (mutation) backgroundRequest = true;
    if (clear) { caps = null; saved = null; receipts = null; draft = null; outcome = null; checked = ''; notice = ''; savedQuery = ''; savedLimit = 30; legacyLimit = 30; }
    document.getElementById('routine-workspace')?.replaceChildren();
  }
  function open() {
    if (locked) return; if (active) { paint(); return; } active = true;
    notice = backgroundRequest ? 'An earlier request may have completed on the host. Inspect saved routines and recorded results before preparing another run.' : 'Loading saved routines…';
    if (backgroundRequest) { backgroundRequest = false; failed = true; paint(); } else { paint(); refresh(); }
  }
  window.TLIManualRoutines = { onOpen: open, onClose: () => close(), refresh };
  window.addEventListener('tli-session-locked', () => { locked = true; close(true); });
  window.addEventListener('tli-session-unlocked', () => { locked = false; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { resumeVisible = active; close(true); }
    else if (resumeVisible && !locked) {
      resumeVisible = false; const root = document.getElementById('routine-workspace'); if (!root) return;
      const b = node('button', 'Reload saved routines', 'btn-outline'); b.type = 'button'; b.addEventListener('click', open);
      root.replaceChildren(node('p', 'Private drafts and reviews were cleared while this page was in the background. Leaving did not cancel any requested host action.'), b);
    }
  });
  document.addEventListener('tli-panel-switched', event => { if (active && (event.detail?.panelId || event.detail?.id) !== 'panel-automations') close(); });
})();
