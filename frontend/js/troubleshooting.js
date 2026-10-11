/* Owner-scoped problem journals. Navigation never diagnoses, executes or sends chat. */
(() => {
  'use strict';
  const requestId = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const $ = id => document.getElementById(id), base = '/api/intelligence/cases';
  const state = { open: false, opening: null, locked: false, epoch: 0, read: 0, busy: false, loaded: false, rows: [], devices: [], current: null, draft: null, dirty: false, request: null, checked: null, finding:false, pick:null, evidenceOpen:false, recordsOpen:false, adminOpen:false };
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const clone = value => JSON.parse(JSON.stringify(value));
  const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
  const string = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
  const hash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  const pointer = item => ({ kind: item.kind, id: item.id, revision: item.revision, ...(item.kind === 'chat' ? { message_index: item.message_index } : {}) });
  const validPointer = p => p && ['note', 'report', 'chat'].includes(p.kind) && string(p.id, 256) && hash(p.revision) && (p.kind !== 'chat' || Number.isInteger(p.message_index) && p.message_index >= 0 && p.message_index <= 1000000);
  function validCase(row, full = true) {
    return row && /^case-[a-f0-9]{32}$/.test(row.id) && string(row.title, 120) && string(row.symptom, 4000) && hash(row.revision)
      && ['open', 'resolved'].includes(row.status) && typeof row.archived === 'boolean' && Number.isFinite(Date.parse(row.updated_at))
      && (row.computer === null || row.computer && string(row.computer.id, 256) && string(row.computer.name, 240))
      && (!full || Array.isArray(row.steps) && row.steps.length <= 30 && row.steps.every(s => string(s.id, 80) && string(s.text, 1000) && ['planned', 'tried', 'skipped'].includes(s.status) && typeof s.outcome === 'string' && s.outcome.length <= 2000)
        && typeof row.resolution === 'string' && row.resolution.length <= 2000 && Array.isArray(row.evidence) && row.evidence.length <= 32 && row.evidence.every(p => validPointer(p) && string(p.label, 240) && ['current', 'changed', 'unavailable'].includes(p.availability)));
  }
  function status(text, error = false) { const box = $('troubleshooting-status'); if (box) { box.textContent = text; box.classList.toggle('error', error); } }
  const current = epoch => state.open && !state.locked && state.epoch === epoch;
  async function api(path, method = 'GET', body) {
    const epoch = state.epoch;
    if (!current(epoch)) throw new Error('Open and unlock Troubleshooting first.');
    const response = await fetch(base + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!current(epoch)) return null;
    if (response.status === 401) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return null; }
    const data = await response.json().catch(() => null);
    if (!current(epoch)) return null;
    if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status}). Your saved work was not replaced.`);
    if (data?.ok !== true || data.protocol !== 'tli-cases-v1' || data.actions_performed !== false || !Number.isFinite(Date.parse(data.checked_at))) throw new Error('This host returned incomplete Troubleshooting information. Previous work was retained.');
    return data;
  }
  function button(label, callback, primary = false) {
    const b = node('button', label, primary ? 'btn-primary' : 'btn-outline'); b.type = 'button';
    b.addEventListener('click', async () => { if (b.disabled || state.locked) return; try { await callback(); } catch (error) { if (state.open && !state.locked) status(error.message, true); } }); return b;
  }
  function field(label, input) { const wrap = node('label', null, 'troubleshooting-field'); wrap.append(node('span', label), input); return wrap; }
  function select(options, value) { const el = node('select'); options.forEach(([key, label]) => { const o = node('option', label); o.value = key; el.append(o); }); el.value = value; return el; }
  function dirty() { state.dirty = true; state.checks?.invalidateGuidance?.(); $('troubleshooting-save-state').textContent = 'Unsaved changes · stored only in this open page until you save.'; if($('troubleshooting-next'))$('troubleshooting-next').textContent='Save & find next check'; if($('troubleshooting-ask'))$('troubleshooting-ask').textContent='Save & ask TLI about this problem…'; }
  function busy(value) {
    state.busy = value;
    $('troubleshooting-editor')?.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = value; });
    ['troubleshooting-new', 'troubleshooting-refresh', 'troubleshooting-search-button'].forEach(id => { if ($(id)) $(id).disabled = value; });
  }
  function emptyDraft() { return { title: '', symptom: '', computer_id: null, status: 'open', archived: false, steps: [], evidence: [], resolution: '' }; }
  function edit(row = null, keepSelection = false) {
    state.current = row; state.draft = row ? { title: row.title, symptom: row.symptom, computer_id: row.computer?.id || null, status: row.status, archived: row.archived, steps: clone(row.steps), evidence: clone(row.evidence), resolution: row.resolution } : emptyDraft();
    state.request = null; state.dirty = false; state.checkReport = null;
    if(!keepSelection){state.pick={step_ids:[],evidence_keys:[],report_key:null,include_resolution:false};state.evidenceOpen=state.recordsOpen=state.adminOpen=false;}
    renderEditor();
  }
  function newProblem() {
    if (state.busy) return;
    if (state.dirty) { status('Keep your current draft: save it or choose Discard changes before starting another problem.', true); return; }
    state.read++; edit(); $('troubleshooting-symptom')?.focus();
  }
  function prepareGuide(value) {
    if(!state.open || state.locked || document.hidden || $('tli-lock-screen')?.getAttribute?.('aria-hidden')==='false' || state.busy || state.dirty || !window.TLICaseGuides)return false;
    const guide=window.TLICaseGuides.validate(value);
    state.read++;edit();
    state.draft={...emptyDraft(),title:guide.title,symptom:guide.symptom,steps:guide.steps.map(text=>({id:requestId(),text,status:'planned',outcome:''}))};
    state.dirty=true;renderEditor();status('Guide prepared as an unsaved problem. Choose the affected computer, adapt the instructions and Save. No check or action ran.');
    $('troubleshooting-symptom')?.focus();return true;
  }
  function prepareRequest(value) {
    if (!state.open || state.locked || document.hidden || $('tli-lock-screen')?.getAttribute?.('aria-hidden') === 'false') return false;
    if (!string(value, 4000) || !value.trim()) { status('Describe the problem in up to 4,000 characters. Your existing work was retained.', true); return false; }
    if (state.busy || state.finding || state.dirty || state.current) { status('Your current problem is still open. Save or discard its changes and choose Start a problem before bringing in another request.', true); return false; }
    state.read++; edit(); state.draft.symptom = value; state.dirty = true; renderEditor();
    status('Your question is now an unsaved problem. Choose the affected computer, then find a check or ask TLI. No information was collected or sent.');
    $('troubleshooting-symptom')?.focus(); return true;
  }
  function renderList() {
    const box = $('troubleshooting-list'); if (!box) return; box.replaceChildren();
    if (!state.rows.length) box.append(node('p', state.loaded ? 'No problems match this view. Start one to keep evidence and tried steps together.' : 'Your saved problems have not been loaded.', 'troubleshooting-muted'));
    state.rows.forEach(row => {
      const item = node('article', null, 'troubleshooting-item');
      item.append(button(row.title, () => openCase(row.id)), node('p', `${row.archived ? 'Archived' : row.status === 'resolved' ? 'Resolved by you' : 'Open'} · ${row.computer?.name || 'No computer selected'}`, 'troubleshooting-muted'), node('small', `Updated ${date(row.updated_at)}`));
      box.append(item);
    });
    $('troubleshooting-list-time').textContent = state.checked ? `Last completed load: ${date(state.checked)}. ${state.rows.length} shown; use search to narrow the list.` : '';
  }
  function reflectSaved(row) {
    const filter = $('troubleshooting-filter')?.value || 'open', query = ($('troubleshooting-search')?.value || '').trim().toLowerCase();
    state.rows = state.rows.filter(item => item.id !== row.id);
    if ((filter === 'archived' ? row.archived : !row.archived && row.status === filter) &&
        (!query || (row.title + '\n' + row.symptom).toLowerCase().includes(query))) state.rows.push(row);
    state.rows.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)); state.rows = state.rows.slice(0, 50); renderList();
  }
  async function refresh() {
    if (state.busy || !state.open || state.locked) return;
    const epoch = state.epoch, ticket = ++state.read;
    status('Loading your saved problems…' + (state.loaded ? ' Previous results remain below.' : ''));
    try {
      const query = new URLSearchParams({ q: $('troubleshooting-search')?.value || '', status: $('troubleshooting-filter')?.value || 'open', limit: '50' });
      const data = await api('?' + query);
      if (!data || !current(epoch) || ticket !== state.read) return;
      if (!Array.isArray(data.items) || data.items.length > 50 || !data.items.every(row => validCase(row, false)) || !Number.isSafeInteger(data.total)) throw new Error('This host returned an incomplete problem list.');
      state.rows = data.items; state.loaded = true; state.checked = data.checked_at; renderList(); status('Saved problems loaded. Opening one performs no checks or actions.');
    } catch (error) { if (current(epoch) && ticket === state.read) status(error.message + (state.loaded ? ' Previous results remain and may be stale.' : ''), true); }
  }
  async function openCase(id) {
    if (state.busy) return;
    if (state.dirty) { status('Save or discard your current draft before opening another problem.', true); return; }
    const epoch = state.epoch, ticket = ++state.read;
    const data = await api('/' + encodeURIComponent(id));
    if (!data || !current(epoch) || ticket !== state.read) return;
    if (state.dirty) { status('Your draft changed while that problem was loading. It was retained; save or discard it before opening another problem.', true); return; }
    if (!validCase(data.case)) throw new Error('This host returned an incomplete problem. Previous work remains available.');
    edit(data.case); status('Problem opened. Evidence shows whether its saved source matches, changed or is unavailable; it does not describe current computer health.');
    $('troubleshooting-editor')?.scrollIntoView?.({ block: 'start' });
  }
  async function loadComputers() {
    const epoch = state.epoch;
    try {
      const r = await fetch('/api/intelligence/devices', { cache: 'no-store' });
      if (!current(epoch)) return;
      if (r.status === 401) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
      const data = await r.json();
      if (!current(epoch)) return;
      if (!r.ok || !Array.isArray(data.devices)) throw new Error('Computer list is unavailable.');
      state.devices = data.devices.filter(d => d.kind === 'computer' && string(d.id, 256) && string(d.name, 240));
      if (state.draft) {const focused=document.activeElement?.id;renderEditor();if(focused)$(focused)?.focus();}
    } catch (error) { if (current(epoch)) status('Computer list unavailable. Existing selected computer and your draft are retained.', true); }
  }
  const evidenceKey = item => JSON.stringify(pointer(item));
  function evidenceSelection(d) {
    const pick=state.pick, section=node('details',null,'troubleshooting-selection');section.open=state.evidenceOpen;
    section.append(node('summary','Optional evidence for this check'),node('p','Use the symptom and selected computer, plus only the items you choose here. Finding a check reads this selection; it does not send Chat or run a diagnostic.','troubleshooting-muted'));
    section.addEventListener('toggle',()=>{state.evidenceOpen=section.open;});
    let choiceIndex=0;
    const choose=(label,checked,change)=>{const input=node('input');input.type='checkbox';input.checked=checked;input.dataset.guidancePick=String(choiceIndex++);const wrap=node('label',null,'troubleshooting-choice');wrap.append(input,node('span',label));input.addEventListener('change',()=>{const focused=document.activeElement===input;try{change(input);state.checks?.invalidateGuidance?.();if(focused)[...$('troubleshooting-editor').querySelectorAll('input')].find(e=>e.dataset.guidancePick===input.dataset.guidancePick)?.focus();}catch(error){input.checked=checked;status(error.message,true);}});return wrap;};
    if(d.steps.length){section.append(node('h4','Steps and outcomes (up to 8)'));d.steps.forEach(step=>section.append(choose(`${step.status}: ${step.text}`,pick.step_ids.includes(step.id),input=>{
      if(input.checked && pick.step_ids.length>=8)throw new Error('Choose up to eight whole steps.');
      pick.step_ids=input.checked?[...pick.step_ids,step.id]:pick.step_ids.filter(id=>id!==step.id);
    })));}
    if(d.resolution)section.append(choose('Include my recorded resolution',pick.include_resolution,input=>{pick.include_resolution=input.checked;}));
    if(d.evidence.length){section.append(node('h4','Saved sources'),node('p','Link descriptions only, unless you explicitly choose recorded facts from one current report. Note bodies, raw samples and attachments stay excluded.','troubleshooting-muted'));
      d.evidence.forEach(item=>{const key=evidenceKey(item);section.append(choose(`${item.label} · ${item.availability || 'Draft link'} · description only`,pick.evidence_keys.includes(key),input=>{
        if(input.checked && pick.evidence_keys.length>=8)throw new Error('Choose up to eight evidence descriptions.');
        pick.evidence_keys=input.checked?[...pick.evidence_keys,key]:pick.evidence_keys.filter(k=>k!==key);
        if(!input.checked && pick.report_key===key)pick.report_key=null;renderEditor();
      }));if(item.kind==='report' && item.availability==='current')section.append(choose(`Recorded facts: ${item.label}`,pick.report_key===key,input=>{
        if(input.checked && !pick.evidence_keys.includes(key) && pick.evidence_keys.length>=8)throw new Error('Remove a description before selecting this report.');
        pick.report_key=input.checked?key:null;if(input.checked && !pick.evidence_keys.includes(key))pick.evidence_keys.push(key);renderEditor();
      }));});}
    if(!d.steps.length && !d.evidence.length && !d.resolution)section.append(node('p','No saved evidence yet. You can start from the symptom and computer.','troubleshooting-muted'));
    return section;
  }
  function guidanceRef(row,pick) {
    const steps=row.steps.filter(s=>pick.step_ids.includes(s.id)),links=row.evidence.filter(e=>pick.evidence_keys.includes(evidenceKey(e)));
    if(steps.length!==pick.step_ids.length || links.length!==pick.evidence_keys.length || pick.report_key && !links.some(e=>evidenceKey(e)===pick.report_key && e.kind==='report' && e.availability==='current'))throw new Error('Selected evidence changed. Review the current selection before finding a check.');
    return {id:row.id,revision:row.revision,step_ids:steps.map(s=>s.id),include_resolution:pick.include_resolution,evidence_refs:links.map(pointer),...(pick.report_key?{report_refs:links.filter(e=>evidenceKey(e)===pick.report_key).map(pointer)}:{})};
  }
  async function findNextCheck() {
    if(state.finding || state.busy || state.locked || !state.draft)return;
    if(!state.draft.computer_id)throw new Error('Choose the affected computer before finding a check. You can still save an unassigned problem.');
    if(!state.checks)throw new Error('Check controls are unavailable. Your draft remains available to save.');
    const epoch=state.epoch,pick=clone(state.pick),ticket={};state.finding=ticket;
    try {
      const row=state.dirty || !state.current ? await saveProblem() : state.current;
      if(!row || !current(epoch) || state.dirty || state.current!==row)return;
      await state.checks?.reviewSelection(guidanceRef(row,pick));
    } finally {if(state.finding===ticket)state.finding=false;}
  }
  async function askAboutProblem() {
    if (state.busy || state.finding || state.locked || !state.draft) return;
    if (!window.TLICaseContext) throw new Error('Case chat controls are unavailable. Refresh TLI to try again.');
    const epoch = state.epoch, row = state.dirty || !state.current ? await saveProblem() : state.current;
    if (!row || !current(epoch) || state.dirty || state.current !== row) return;
    return window.TLICaseContext.open(row, { current: () => current(epoch) && !state.dirty && !state.busy && state.current === row });
  }
  async function keepReport(id) {
    if (state.busy || state.locked || !state.draft) return false;
    const epoch = state.epoch, draft = state.draft;
    state.checkReport = id;
    const evidence = await linkEvidence({ kind: 'report', id });
    if (!evidence || !current(epoch) || state.draft !== draft) return false;
    const row = await saveProblem();
    if (!row || !current(epoch) || state.current !== row) return false;
    if (!row.evidence.some(p => p.kind === 'report' && p.id === id && p.revision === evidence.revision)) {
      status('The report is saved, but its link was not confirmed in this problem. Review the saved record before continuing.', true); return false;
    }
    status('Report and problem saved together. Ask TLI about this problem to review the evidence for a question, or record what you tried.');
    return true;
  }
  async function reopenProblem() {
    if (!state.open || state.locked) return;
    if (state.busy || !state.current || state.dirty) throw new Error('Save or discard your changes before reopening this problem.');
    if (state.draft.status !== 'resolved' && !state.draft.archived) return;
    const epoch = state.epoch;
    state.draft.status = 'open'; state.draft.archived = false; dirty(); renderEditor();
    const row = await saveProblem();
    if (row && current(epoch) && state.current === row) status('Investigation reopened. Earlier evidence, steps and your previous outcome are retained as history. No check has run.');
  }
  function renderEditor() {
    const box = $('troubleshooting-editor'); if (!box) return; box.replaceChildren();
    if (!state.draft) { box.append(node('h3', 'Pick up where you left off'), node('p', 'Open a problem or start a new one. Keep the symptom, evidence and attempted steps together without repeating checks.')); return; }
    const d = state.draft;
    box.append(node('h3', state.current ? 'Problem details' : 'Start a problem'));
    const saveState = node('p', state.dirty ? 'Unsaved changes · stored only in this open page until you save.' : state.current ? `Saved ${date(state.current.updated_at)}` : 'This problem has not been saved yet.', 'troubleshooting-muted'); saveState.id = 'troubleshooting-save-state'; box.append(saveState);
    const symptom=node('textarea');symptom.id='troubleshooting-symptom';symptom.maxLength=4000;symptom.value=d.symptom;symptom.addEventListener('input',()=>{d.symptom=symptom.value;dirty();});box.append(field('What is happening?',symptom));
    const computers = [['', 'No computer selected'], ...state.devices.map(c => [c.id, `${c.name} · ${c.id}`])];
    if (d.computer_id && !state.devices.some(c => c.id === d.computer_id)) computers.push([d.computer_id, `${state.current?.computer?.name || d.computer_id} · saved reference, not currently listed`]);
    const target = select(computers, d.computer_id || ''); target.id = 'troubleshooting-computer'; target.addEventListener('change', () => { d.computer_id = target.value || null; dirty(); renderEditor(); }); box.append(field('Affected computer', target),evidenceSelection(d));
    const primary=node('div',null,'troubleshooting-primary-actions');const find=button(state.dirty || !state.current?'Save & find next check':'Find next check',findNextCheck,true);find.id='troubleshooting-next';
    const save=button('Save problem',saveProblem);save.id='troubleshooting-save';
    const ask=button(state.dirty || !state.current?'Save & ask TLI about this problem…':'Ask TLI about this problem…',askAboutProblem);ask.id='troubleshooting-ask';
    primary.append(find,ask,save);
    if (state.current && (d.status === 'resolved' || d.archived)) primary.append(button('Reopen and save',reopenProblem));
    box.append(primary,node('p','Find a check or ask TLI saves your changes first. You review what to measure or share before running a check or sending a question.','troubleshooting-muted'));
    if (state.current) {
      const progress=node('section',null,'troubleshooting-progress');
      progress.append(node('strong',d.status==='resolved'?'You marked this problem resolved':d.archived?'This investigation is archived':'Continue this investigation'),node('p',`${d.evidence.length} evidence links · ${d.steps.filter(s=>s.status==='tried').length} recorded attempts. Saved observations describe their recorded time.`,'troubleshooting-muted'));
      progress.append(button('Record what happened',()=>{state.recordsOpen=true;renderEditor();$('troubleshooting-resolution')?.focus();}));box.append(progress);
    }
    if (window.TLIGuidedChecks) {
      state.checks ||= window.TLIGuidedChecks.create();
      const checkBox = node('section', null, 'troubleshooting-guided-checks'); checkBox.id = 'troubleshooting-guided-checks'; box.append(checkBox);
      const savedRow=state.current;
      state.checks.render(checkBox, { key: d, computerId: d.computer_id, current: () => state.open && !state.locked && state.draft === d,
        guidanceCurrent: () => state.open && !state.locked && !state.dirty && !state.busy && state.current===savedRow && state.draft===d,
        onLink: async id => { state.checkReport = id; await linkEvidence({ kind: 'report', id }); }, onKeepReport: keepReport });
    }
    const records=node('details',null,'troubleshooting-record');records.open=state.recordsOpen;records.addEventListener('toggle',()=>{state.recordsOpen=records.open;});records.append(node('summary','Evidence, tried steps & outcome'));box.append(records);
    records.append(node('h4', 'Evidence'), node('p', 'Link saved notes, reports or a completed chat message. Linked content is not sent to AI. Open each source to review it.', 'troubleshooting-muted'));
    const links = node('div', null, 'troubleshooting-evidence'); links.id = 'troubleshooting-evidence';
    if (!d.evidence.length) links.append(node('p', 'No evidence linked. Use “Link to a problem” on a saved note, diagnostic report or completed chat message.', 'troubleshooting-muted'));
    d.evidence.forEach((item, index) => {
      const availability = { current: 'Matches saved source', changed: 'Source changed since linking', unavailable: 'Source unavailable' }[item.availability] || 'Reviewed for this draft';
      const row = node('article', null, 'troubleshooting-link'); row.append(node('strong', item.label || item.kind), node('p', `${item.kind} · ${availability} · ${item.linked_at ? 'Linked ' + date(item.linked_at) : 'Not saved yet'}`, 'troubleshooting-muted'));
      row.append(button('Open current source', () => openEvidence(item)), button('Review latest source', () => reviewExisting(index)), button('Remove link', () => { forgetSelection(item);d.evidence.splice(index, 1); dirty(); renderEditor(); })); links.append(row);
    });
    records.append(links, button('Browse saved notes', () => window.TLINotebook?.open()), button('View report history', () => { window.switchPanel?.('panel-reports'); }));
    records.append(node('h4', 'Steps you planned or tried'), node('p', 'This is your record of work. Saving a step does not execute it.', 'troubleshooting-muted'));
    d.steps.forEach((step, index) => {
      const row = node('section', null, 'troubleshooting-step'); row.append(node('h5', `Step ${index + 1}`));
      const text = node('textarea'); text.value = step.text; text.maxLength = 1000; text.addEventListener('input', () => { step.text = text.value; dirty(); });
      const stage = select([['planned', 'Planned'], ['tried', 'Tried'], ['skipped', 'Skipped']], step.status); stage.addEventListener('change', () => { step.status = stage.value; dirty(); });
      const outcome = node('textarea'); outcome.value = step.outcome; outcome.maxLength = 2000; outcome.addEventListener('input', () => { step.outcome = outcome.value; dirty(); });
      row.append(field('What did you plan or do?', text), field('Progress', stage), field('What happened? (optional)', outcome), button('Remove step', () => { state.pick.step_ids=state.pick.step_ids.filter(id=>id!==step.id);d.steps.splice(index, 1); dirty(); renderEditor(); })); records.append(row);
    });
    const add = button('Add a step', () => { if (d.steps.length >= 30) return; d.steps.push({ id: requestId(), text: '', status: 'planned', outcome: '' }); dirty(); renderEditor(); }); add.disabled = d.steps.length >= 30; records.append(add);
    const statusField = select([['open', 'Open · still investigating'], ['resolved', 'Resolved · I confirmed improvement']], d.status); statusField.id = 'troubleshooting-state'; statusField.addEventListener('change', () => { d.status = statusField.value; dirty(); });
    const resolution = node('textarea'); resolution.value = d.resolution; resolution.maxLength = 2000; resolution.id = 'troubleshooting-resolution'; resolution.addEventListener('input', () => { d.resolution = resolution.value; dirty(); });
    records.append(field('Problem status', statusField), field('What improved and how did you confirm it?', resolution), node('p', 'Resolving records your confirmation. It does not certify current computer health or create a verified fix in Notes & fixes. When reopening, keep earlier outcomes as history and record each new attempt above.', 'troubleshooting-muted'),button('Save outcome',saveProblem,true));
    const admin=node('details',null,'troubleshooting-admin');admin.open=state.adminOpen;admin.addEventListener('toggle',()=>{state.adminOpen=admin.open;});admin.append(node('summary','Title & problem management'));box.append(admin);
    const title=node('input');title.id='troubleshooting-title';title.maxLength=120;title.value=d.title;title.addEventListener('input',()=>{d.title=title.value;dirty();});admin.append(field('Short title (optional; defaults to the first line of the symptom)',title));
    const archive = node('input'); archive.type = 'checkbox'; archive.checked = d.archived; archive.addEventListener('change', () => { d.archived = archive.checked; dirty(); }); admin.append(field('Archive this problem (keep its saved history)', archive));
    const actions = node('div', null, 'troubleshooting-actions');
    actions.append(button('Discard changes', () => { edit(state.current); status('Unsaved changes discarded. Saved records and linked sources are unchanged.'); }));
    if (state.current) {
      actions.append(button('Create reusable guide…', () => {
        if (state.dirty) throw new Error('Save or discard your changes before reviewing instructions from this saved problem.');
        if (!window.TLICaseGuides) throw new Error('Guide controls are unavailable. Refresh TLI to try again.');
        window.TLICaseGuides.open(state.current);
      }));
      actions.append(button('Export…', () => {
        if (state.dirty) throw new Error('Save or discard your changes before reviewing an export of this saved problem.');
        const row = state.current;
        if (!window.TLICaseExport) throw new Error('Export controls are unavailable. Refresh TLI to try again.');
        window.TLICaseExport.open(row, { current: () => state.open && !state.locked && !state.dirty && !state.busy && state.current === row });
      }));
      actions.append(button('Reload saved version', async () => { if (state.dirty) { status('Discard your draft explicitly before reloading a changed version.', true); return; } await openCase(state.current.id); }));
      const review = node('div', null, 'troubleshooting-delete-review'); review.hidden = true;
      review.append(node('p', 'Remove this problem? Its linked notes, conversations and reports stay unchanged.'), button('Remove this problem', removeProblem), button('Keep problem', () => { review.hidden = true; }));
      actions.append(button('Remove…', () => { review.hidden = false; })); admin.append(review);
    }
    admin.append(actions); if (state.busy) busy(true);
  }
  async function saveProblem() {
    if (state.busy || !state.draft || state.locked) return;
    const epoch = state.epoch, d = clone(state.draft);
    if(!d.title.trim())d.title=d.symptom.trim().split(/\r?\n/)[0].slice(0,120);
    if (!d.title.trim() || !d.symptom.trim() || d.steps.some(s => !s.text.trim()) || d.status === 'resolved' && !d.resolution.trim()) throw new Error('Add a title, symptom and step text. A resolved problem also needs the improvement you confirmed.');
    const values = { ...d, evidence: d.evidence.map(pointer) };
    if (state.current) values.expected_revision = state.current.revision;
    else { state.request ||= requestId(); values.request_id = state.request; }
    busy(true); state.read++; status('Saving this problem…');
    try {
      const data = await api(state.current ? '/' + encodeURIComponent(state.current.id) : '', state.current ? 'PUT' : 'POST', values);
      if (!data || !current(epoch)) return;
      if (!validCase(data.case)) throw new Error('The save response was incomplete. Keep your draft and check the saved problem before retrying.');
      edit(data.case,true); reflectSaved(data.case); status(data.already_saved ? 'This creation was already saved. Its current saved version is open.' : 'Problem saved. No diagnostics, device actions or AI requests ran.');return data.case;
    } catch (error) { if (current(epoch)) status((state.checkReport && d.evidence.some(link => link.kind === 'report' && link.id === state.checkReport) ? 'Report saved; problem link not saved. ' : '') + error.message + ' Your draft remains below; nothing was retried.', true); }
    finally { if (current(epoch)) busy(false); }
  }
  async function removeProblem() {
    if (state.busy || !state.current) return;
    if (state.dirty) throw new Error('Save or discard changes before removing this problem.');
    const epoch = state.epoch, row = state.current; busy(true); state.read++;
    try {
      const data = await api('/' + encodeURIComponent(row.id) + '?expected_revision=' + row.revision, 'DELETE');
      if (!data || !current(epoch)) return;
      if (data.deleted !== true || data.sources_changed !== false || data.id !== row.id) throw new Error('Removal was not confirmed. Check the saved list before another request.');
      state.rows = state.rows.filter(r => r.id !== row.id); state.current = null; state.draft = null; state.dirty = false; renderEditor(); renderList(); status('Problem removed. Linked sources remain unchanged.');
    } finally { if (current(epoch)) busy(false); }
  }
  async function reviewExisting(index) {
    const item = state.draft?.evidence[index]; if (!item || state.busy) return;
    await linkEvidence(item, index);
  }
  function forgetSelection(item){const key=evidenceKey(item);state.pick.evidence_keys=state.pick.evidence_keys.filter(k=>k!==key);if(state.pick.report_key===key)state.pick.report_key=null;}
  async function linkEvidence(ref, replaceIndex = null) {
    if (state.busy || state.locked || !state.draft) return;
    const epoch = state.epoch; busy(true);
    try {
      const data = await api('/evidence/review', 'POST', { kind: ref.kind, id: ref.id, ...(ref.kind === 'chat' ? { message_index: ref.message_index } : {}) });
      if (!data || !current(epoch)) return;
      if (!validPointer(data.evidence) || !string(data.evidence.label, 240) || data.evidence.kind !== ref.kind || data.evidence.id !== ref.id || (ref.kind === 'chat' && data.evidence.message_index !== ref.message_index)) throw new Error('This host did not provide a matching usable evidence reference.');
      const item = { ...data.evidence, availability: 'current' };
      const index = replaceIndex === null ? state.draft.evidence.findIndex(p => p.kind === item.kind && p.id === item.id && p.message_index === item.message_index) : replaceIndex;
      if (index >= 0) {if(evidenceKey(state.draft.evidence[index])!==evidenceKey(item))forgetSelection(state.draft.evidence[index]);state.draft.evidence[index] = item;}
      else { if (state.draft.evidence.length >= 32) throw new Error('A problem supports up to 32 evidence links.'); state.draft.evidence.push(item); }
      dirty(); renderEditor(); status('Source reviewed and linked in your draft. Review the problem and choose Save to keep this pointer. Nothing was sent to AI.'); return item;
    } finally { if (current(epoch)) busy(false); }
  }
  async function openEvidence(item) {
    if (item.availability === 'unavailable') throw new Error('The original source is unavailable. Its historical pointer is retained. You can explicitly review it again.');
    if (item.kind === 'note') return window.TLINotebook?.open({ id: item.id });
    if (item.kind === 'chat') { window.switchPanel?.('panel-main'); return window.loadConversation?.(item.id, item.label); }
    if (item.kind === 'report') return window.TLIIntelligence?.openSavedReport?.(item.id);
  }
  async function offerEvidence(ref) {
    if (!ref || !['note', 'report', 'chat'].includes(ref.kind) || !string(ref.id, 256)) return;
    if (state.locked) return;
    await open();
    if (!state.open || state.locked) return;
    if (!state.draft) edit();
    await linkEvidence(ref);
  }
  const chatDecorations = new WeakMap();
  function decorateMessage(bubble, metadata) {
    const ref = metadata?.source_ref;
    if (!bubble || !ref || !string(ref.conversation_id, 256) || !hash(ref.revision) || !Number.isInteger(ref.message_index) || ref.message_index < 0 || ref.message_index > 1000000) return;
    const key = JSON.stringify([ref.conversation_id, ref.message_index, ref.revision]), previous = chatDecorations.get(bubble);
    if (previous?.key === key) return;
    previous?.link.remove();
    const source = { kind: 'chat', id: ref.conversation_id, message_index: ref.message_index };
    const link = button('Link to a problem…', () => offerEvidence(source)); link.dataset.caseChatLink = 'true'; bubble.append(link); chatDecorations.set(bubble, {key, link});
  }
  async function onOpen() {
    init(); if (state.locked) return; if (state.open) return state.opening; state.open = true; state.epoch++;
    if (!state.draft) {edit();$('troubleshooting-symptom')?.focus();}
    const opening = Promise.all([refresh(), loadComputers()]); state.opening = opening;
    try { await opening; } finally { if (state.opening === opening) state.opening = null; }
  }
  function onClose() { state.checks?.suspend(); window.TLICaseExport?.close(); window.TLICaseContext?.close(); window.TLICaseGuides?.close(); state.open = false; state.opening = null; state.epoch++; state.read++; state.busy = false;state.finding=false; }
  async function open(options = {}) {
    window.switchPanel?.('panel-troubleshooting'); await onOpen();
    if (options.id) await openCase(options.id);
  }
  function clear() { onClose(); state.checks?.suspend(true); state.rows = []; state.devices = []; state.current = null; state.draft = null; state.request = null; state.checkReport = null; state.dirty = false; state.loaded = false; state.checked = null;state.pick=null; $('troubleshooting-search') && ($('troubleshooting-search').value = ''); renderList(); renderEditor(); status('Unlock TLI to load your saved problems. Unsaved drafts were cleared.'); }
  function init() {
    const root = $('troubleshooting-workspace'); if (!root || $('troubleshooting-status')) return;
    const privacy=node('details',null,'troubleshooting-privacy');privacy.append(node('summary','Privacy & account scope'),node('p', 'A private place to keep a problem, its evidence and what you tried. Troubleshooting records belong to your current account; with the access PIN off, browser visitors share the local account.', 'troubleshooting-intro'));root.append(privacy);
    const feedback = node('p', 'Open Troubleshooting to load saved problems.', 'troubleshooting-status'); feedback.id = 'troubleshooting-status'; feedback.setAttribute('role', 'status'); root.append(feedback);
    const grid = node('div', null, 'troubleshooting-grid'), browser = node('section', null, 'troubleshooting-browser'), editor = node('section', null, 'troubleshooting-editor'); editor.id = 'troubleshooting-editor';
    const search = node('input'); search.id = 'troubleshooting-search'; search.maxLength = 120; search.type = 'search'; search.addEventListener('keydown', e => { if (e.key === 'Enter') refresh(); });
    const filter = select([['open', 'Open problems'], ['resolved', 'Resolved problems'], ['archived', 'Archived problems']], 'open'); filter.id = 'troubleshooting-filter'; filter.addEventListener('change', refresh);
    const find = button('Search problems', refresh); find.id = 'troubleshooting-search-button'; const reload = button('Refresh list', refresh); reload.id = 'troubleshooting-refresh'; const make = button('Start a problem', newProblem, true); make.id = 'troubleshooting-new';
    const list = node('div'); list.id = 'troubleshooting-list'; const time = node('p', '', 'troubleshooting-muted'); time.id = 'troubleshooting-list-time';
    const findSaved=node('details',null,'troubleshooting-find');findSaved.append(node('summary','Find a saved problem'),field('Search title or symptom',search),field('Show',filter),find,reload);
    browser.append(node('h3', 'Your problems'), make, button('Start from a guide…',()=>{if(state.busy || state.dirty){status('Save or discard your current draft before preparing another problem.',true);return;}window.TLICaseGuides?.open();}), findSaved, time, list);
    grid.append(editor, browser); root.append(grid, node('p', 'Back up these records with the Saved work archive in Settings → Data & Recovery. Earlier notes/history archives do not include Troubleshooting.', 'troubleshooting-muted')); renderList(); renderEditor();
  }
  window.addEventListener('tli-session-locked', () => { state.locked = true; clear(); });
  window.addEventListener('tli-session-unlocked', () => { state.locked = false; if ($('panel-troubleshooting') && !$('panel-troubleshooting').classList.contains('hidden') && !$('panel-troubleshooting').hidden) onOpen(); });
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onClose();
    else if ($('panel-troubleshooting') && !$('panel-troubleshooting').classList.contains('hidden') && !$('panel-troubleshooting').hidden) onOpen();
  });
  window.TLITroubleshooting = { open, onOpen, onClose, offerEvidence, decorateMessage, prepareGuide, prepareRequest };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
