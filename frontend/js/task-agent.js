/* Explicit task mode. Source/tool text is always rendered as inert text. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  let ui, areas = [], task = null, runId = null, busy = false, locked = false, epoch = 0, stopped = false, taskMode = false;
  let taskView = 0, savedView = 0;
  const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
  function invoke(action) { const result = action(), ticket = epoch; Promise.resolve(result).catch(error => { if (current(ticket)) notice(error.message); }); }
  const button = (text, action) => { const el = node('button', text); el.type = 'button'; el.className = 'chip-button'; el.addEventListener('click', () => { if (!locked) invoke(action); }); return el; };
  const status = error => typeof error?.detail === 'string' ? error.detail : error?.detail?.message;
  async function api(path, options = {}) {
    const response = await fetch(path, {cache: 'no-store', ...options, headers: {'Content-Type': 'application/json', ...(options.headers || {})}});
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(status(value) || `Request failed (${response.status}).`), {status: response.status});
    return value;
  }
  const post = (path, value) => api(path, {method: 'POST', body: JSON.stringify(value)});
  function notice(text) { if (ui) { ui.notice.textContent = text || ''; ui.notice.hidden = !text; } }
  function current(ticket) { return ticket === epoch && !locked; }
  function field(parent, label, element) { const wrap = node('label'); wrap.className = 'task-agent-field'; wrap.append(node('span', label), element); parent.append(wrap); return element; }
  function checkbox(parent, text, checked = false) { const input = node('input'); input.type = 'checkbox'; input.checked = checked; const wrap = node('label'); wrap.className = 'task-agent-check'; wrap.append(input, node('span', text)); parent.append(wrap); return input; }
  function select(parent, label, choices) { const el = node('select'); for (const [value, text] of choices) { const option = node('option', text); option.value = value; el.append(option); } return field(parent, label, el); }
  function setBusy(value) {
    busy = value; ui.stop.disabled = !value || locked; ui.mode.disabled = value || locked;
    ui.body.setAttribute('aria-busy', String(value));
    for (const element of [ui.area, ui.provider, ui.model, ui.reasoning, ui.share, ui.web, ...ui.examples]) element.disabled = value || locked;
    if ($('chat-send-btn')) $('chat-send-btn').disabled = value;
  }
  function paintMode() {
    ui.body.hidden = !taskMode;
    ui.mode.setAttribute('aria-expanded', String(taskMode));
    ui.mode.setAttribute('aria-label', taskMode ? 'Close task tools and return to chat' : 'Open task tools');
    ui.modeState.textContent = taskMode ? 'Task mode on' : 'Optional';
    ui.modeHint.textContent = taskMode ? 'Your next message starts a task. Close to return to chat.' : 'Read folders, edit text files, and review actions.';
    if (ui.sendLabel) ui.sendLabel.textContent = taskMode ? 'Start task' : ui.originalSendLabel;
  }
  function toggleMode() {
    if (busy || locked) return;
    taskMode = !taskMode; paintMode();
    if (taskMode) invoke(loadAreas);
  }
  function useExample(text) {
    const input = $('chat-input'); if (!input || busy || locked) return;
    input.value = input.value.trim() ? `${input.value}\n\n${text}` : text;
    input.dispatchEvent(new Event('input', {bubbles:true})); input.focus();
    notice('Example added to your draft. Review the draft and work area, then use Start task when ready.');
  }
  async function loadAreas() {
    if (locked) return;
    const ticket = epoch, data = await api('/api/tasks/areas'); if (!current(ticket)) return;
    const selected = ui.area.value; areas = data.areas || [];
    ui.area.replaceChildren(); const empty = node('option', 'No file access · device tasks only'); empty.value = ''; ui.area.append(empty);
    for (const area of areas) { const option = node('option', area.name); option.value = area.id; ui.area.append(option); }
    ui.area.value = areas.some(a => a.id === selected) ? selected : '';
  }
  async function saveArea() {
    if (busy || locked) return;
    const ticket = epoch;
    const lines = value => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const saved = await post('/api/tasks/areas', {name: ui.areaName.value.trim(), read_roots: lines(ui.readRoots.value), write_roots: lines(ui.writeRoots.value)});
    if (!current(ticket)) return;
    await loadAreas(); if (!current(ticket)) return;
    ui.area.value = saved.id; ui.areaEditor.open = false;
    notice('Work area approved. Commands still require their own task review.');
  }
  function renderTask(value) {
    const ticket = epoch, view = ++taskView, actionButtons = [];
    let actionTaken = false;
    const visible = () => current(ticket) && view === taskView;
    const beginAction = () => {
      if (busy || actionTaken || !visible()) return false;
      actionTaken = true;
      for (const control of actionButtons) control.disabled = true;
      return true;
    };
    const mutationButton = (label, path, body) => {
      const control = button(label, async () => {
        if (!beginAction()) return;
        try {
          const updated = await post(path, body);
          if (visible()) renderTask(updated);
        } catch (error) {
          if (visible()) notice(`${error.message} Open Saved tasks to check the recorded result before taking another action. Nothing was retried.`);
        }
      });
      actionButtons.push(control); return control;
    };
    task = value; ui.activity.hidden = false; ui.receipts.replaceChildren();
    ui.taskTitle.textContent = `Task · ${value.status || 'running'}`;
    if (value.activity) ui.taskTitle.textContent += ` · ${value.activity.replaceAll('_', ' ')}`;
    for (const receipt of value.receipts || []) {
      const item = node('details'); item.append(node('summary', `${receipt.tool.replaceAll('_', ' ')} · ${receipt.outcome}`));
      const pre = node('pre', receipt.result ? JSON.stringify(receipt.result, null, 2) : receipt.summary || 'Recorded attempt.'); item.append(pre);
      const operation = receipt.tool === 'workspace_write' && receipt.result?.receipt?.id;
      if (operation && value.status !== 'running') item.append(mutationButton('Undo this change', `/api/tasks/${value.id}/undo`, {operation_id: operation}));
      ui.receipts.append(item);
    }
    ui.review.replaceChildren();
    if (value.pending) {
      const pending = value.pending;
      ui.review.append(node('h4', 'Review the next action'), node('p', pending.disclosure || 'Review the exact target, operation, and affected rooms.'),
        node('pre', JSON.stringify(pending.reviewed_command || pending.device_review || pending.arguments, null, 2)));
      if (!pending.approved) ui.review.append(mutationButton('Approve for this task', `/api/tasks/${value.id}/approve`, {review_id: pending.id, expected_revision: value.revision}));
    }
    if (value.status === 'interrupted' || value.status === 'needs_input' && (!value.pending || value.pending.approved)) {
      const followup=field(ui.review,'Answer or further instructions (optional)',node('textarea'));
      const resume = button('Continue task', () => { if (beginAction()) return resumeTask(value,followup.value); });
      actionButtons.push(resume); ui.review.append(resume);
    }
    notice(value.reply || (value.status === 'needs_input' ? 'Review the recorded work and the next action.' : value.status === 'running' ? `Working · ${(value.activity || 'examining evidence').replaceAll('_', ' ')}` : `Task ${value.status}.`));
    if (value.error) notice(value.error);
  }
  function payload(message) {
    const area = areas.find(a => a.id === ui.area.value);
    const provider = {kind: ui.provider.value, model: ui.model.value.trim(), reasoning: ui.reasoning.value, tool_mode: 'json', selection: null};
    if (['lmstudio', 'openai'].includes(provider.kind) && !provider.model) {
      ui.modelOptions.open = true; ui.model.focus();
      throw Error(`Enter the exact ${provider.kind === 'lmstudio' ? 'LM Studio' : 'OpenAI'} model ID in Model & internet options before starting.`);
    }
    if (provider.kind === 'lan') {
      provider.selection = window.TLILanInference?.capture()?.selection;
      if (!provider.selection) throw Error('Choose a reviewed LAN model using the AI selector first.');
    }
    return {message, conversation_id: window.currentConversationId || null, area_id: area?.id || null, area_revision: area?.revision || null,
      provider, share_context: ui.share.checked, allow_web: ui.web.checked,
      use_saved_memory: $('memory-use-saved')?.checked === true, use_conversation_history: $('memory-use-history')?.checked !== false};
  }
  async function submitOnce(path, body) {
    const ticket = epoch, requestId = body.request_id;
    runId = body.request_id;
    try { return await post(path, body); }
    catch (error) {
      if (error.status) throw error;
      if (!current(ticket)) throw Error('Session changed.');
      return api(`/api/runs/${encodeURIComponent(requestId)}`).catch(() => { throw Error('Submission is uncertain. Open Saved tasks before retrying. Nothing was resent.'); });
    }
  }
  async function watch(value, ticket) {
    if (!current(ticket)) throw Error('Session changed.');
    runId = value.id; let misses = 0;
    if (stopped) await post(`/api/runs/${runId}/cancel`, {});
    while (current(ticket)) {
      if (value.metadata?.agent) renderTask(value.metadata.agent);
      if (terminal.has(value.status)) {
        if (value.status !== 'completed') {
          if (task?.id) { const saved = await api(`/api/tasks/${task.id}`); if (current(ticket)) renderTask(saved); }
          throw Error(value.error || 'Task interrupted. Review the recorded effects.');
        }
        const result = value.result || {};
        if (result.task_id) { const saved = await api(`/api/tasks/${result.task_id}`); if (current(ticket)) renderTask(saved); }
        if (!current(ticket)) throw Error('Session changed.');
        return {...result, conversation_id: value.conversation_id, run_id: value.id};
      }
      await new Promise(resolve => setTimeout(resolve, 700));
      if (!current(ticket)) break;
      try { value = await api(`/api/runs/${encodeURIComponent(runId)}`); misses = 0; }
      catch (error) { if (error.status || ++misses >= 15) throw error; }
    }
    throw Error('Session changed. Reopen Saved tasks to see the result.');
  }
  async function run(message, voice = null) {
    if (busy || locked || $('chat-send-btn')?.disabled) throw Error('Wait for the current reply or stop it before starting.');
    if (!message.trim()) throw Error('Describe what you want TLI to complete.');
    if ($('chat-image-preview') && !$('chat-image-preview').classList.contains('hidden')) throw Error('Remove the image attachment before starting a file task.');
    const request = payload(message), ticket = ++epoch;
    setBusy(true); stopped = false; task = null; taskView++; savedView++; ui.saved.replaceChildren(); ui.activity.hidden = false; ui.taskTitle.textContent = 'Task activity'; ui.receipts.replaceChildren(); ui.review.replaceChildren(); notice('Starting task…');
    try {
      const value = await submitOnce('/api/runs', {request_id: crypto.randomUUID(), kind:'agent_task', payload:request});
      if (current(ticket) && $('chat-input')?.value.trim() === message.trim()) $('chat-input').value = '';
      const result = await watch(value, ticket);
      if (current(ticket)) {
        setBusy(false);
        if (result.conversation_id) await window.loadConversation?.(result.conversation_id, 'Task conversation', {refresh:true});
      }
      if (current(ticket) && voice) await voice.complete(result.reply, {run_id:result.run_id});
      return result;
    } finally { if (current(ticket)) { setBusy(false); runId = null; } }
  }
  async function resumeTask(value,followUp='') {
    if (busy || locked) return;
    const ticket = ++epoch; stopped = false; setBusy(true);
    try {
      const run = await submitOnce(`/api/tasks/${value.id}/resume`, {request_id:crypto.randomUUID(), expected_revision:value.revision,follow_up:followUp});
      const result = await watch(run, ticket);
      if (current(ticket)) {
        setBusy(false);
        if (result.conversation_id) await window.loadConversation?.(result.conversation_id, 'Task conversation', {refresh:true});
      }
      return result;
    } finally { if (current(ticket)) { setBusy(false); runId = null; } }
  }
  async function stop() {
    const ticket = epoch;
    stopped = true;
    if (runId) await post(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
    if (current(ticket)) notice('Stop requested. Already completed actions remain in the task receipts.');
  }
  async function savedTasks() {
    if (busy || locked) return;
    const ticket = epoch, list = ++savedView;
    const currentList = () => current(ticket) && list === savedView;
    let data;
    try { data = await api('/api/tasks'); }
    catch (error) { if (currentList()) notice(error.message); return; }
    if (!currentList()) return;
    ui.activity.hidden = false; ui.saved.replaceChildren(node('h4','Saved tasks'));
    for (const item of data.tasks || []) ui.saved.append(button(`${item.message.slice(0, 70)} · ${item.status}`, async () => {
      if (busy || !currentList()) return;
      const selection = ++taskView;
      const currentSelection = () => current(ticket) && selection === taskView;
      task = null; ui.receipts.replaceChildren(); ui.review.replaceChildren(); ui.taskTitle.textContent = 'Loading saved task…'; notice('');
      let value;
      try { value = await api(`/api/tasks/${item.id}`); }
      catch (error) { if (currentSelection()) { ui.taskTitle.textContent = 'Saved task unavailable'; notice(error.message); } return; }
      if (!currentSelection()) return;
      renderTask(value);
      if (value.status === 'running') {
        setBusy(true); stopped = false;
        try {
          const result = await watch(await api(`/api/runs/${value.active_run}`), ticket);
          if (current(ticket)) {
            setBusy(false);
            if (result.conversation_id) await window.loadConversation?.(result.conversation_id, 'Task conversation', {refresh:true});
          }
        }
        finally { if (current(ticket)) { setBusy(false); runId = null; } }
      }
    }));
    if (!(data.tasks || []).length) ui.saved.append(node('p', 'No saved tasks for this account.'));
  }
  function reset(lock) {
    epoch++; taskView++; savedView++; locked = lock; busy = false; stopped = true; task = null; runId = null; areas = [];
    if (!ui) return;
    taskMode = false; paintMode(); ui.activity.hidden = true; ui.receipts.replaceChildren(); ui.review.replaceChildren(); ui.saved.replaceChildren();
    ui.area.replaceChildren(); ui.readRoots.value = ''; ui.writeRoots.value = ''; ui.areaName.value = ''; notice(''); setBusy(false);
  }
  function install() {
    const composer = $('chat-composer-shell'); if (!composer || ui) return;
    const box = node('section'); box.id = 'task-agent'; box.className = 'task-agent';
    const mode = button('', toggleMode); mode.id = 'task-agent-mode'; mode.className = 'task-agent-toggle'; mode.setAttribute('aria-controls', 'task-agent-body');
    const heading = node('span'), titleRow = node('span'), modeState = node('span', 'Optional'), modeHint = node('span');
    heading.className = 'task-agent-heading'; titleRow.className = 'task-agent-title'; modeState.className = 'task-agent-state'; modeHint.className = 'task-agent-hint';
    titleRow.append(node('strong','Task tools'),modeState); heading.append(titleRow,modeHint);
    const chevron = node('span','⌄'); chevron.className = 'task-agent-chevron'; chevron.setAttribute('aria-hidden','true'); mode.append(heading,chevron); box.append(mode);
    const body = node('div'); body.id = 'task-agent-body'; body.hidden = true; body.className = 'task-agent-body'; box.append(body);
    const intro = node('p', 'Describe a goal in the message box. TLI can investigate files, update text, and check the result. Commands and speaker actions pause for review.'); intro.className = 'task-agent-intro'; body.append(intro);
    const examplesBox = node('div'); examplesBox.className = 'task-agent-examples'; examplesBox.setAttribute('aria-label','Add an example to your draft');
    const examples = [
      ['Understand a project','Read and explain a folder','Inspect the files in my approved work area and explain how the project is organized. Do not change any files.'],
      ['Fix a text file','Update a document or config','Help me update a text file in my approved work area. Ask which file and what changes I want before editing.'],
      ['Investigate an error','Trace a problem through logs','Read the logs in my approved work area and investigate the error. Explain the evidence and ask me to review any command needed to check it.'],
    ].map(([label, hint, text]) => { const example = button('', () => useExample(text)); example.className = 'task-agent-example'; example.append(node('strong',label),node('span',hint)); examplesBox.append(example); return example; });
    body.append(examplesBox);
    const access = node('div'); access.className = 'task-agent-access'; body.append(access);
    const area = select(access, 'Approved work area', [['', 'No file access · device tasks only']]); area.id='task-agent-area';
    const controls = node('div'); controls.className = 'task-agent-actions';
    controls.append(button('Refresh work areas', loadAreas), button('Revoke selected area', async () => {
      if (busy || locked || !ui.area.value) return;
      const ticket = epoch;
      await api(`/api/tasks/areas/${encodeURIComponent(ui.area.value)}`, {method:'DELETE'});
      if (!current(ticket)) return;
      await loadAreas(); if (current(ticket)) notice('Work area access revoked.');
    }), button('Find game locations', async () => {
      const ticket=epoch, result=await api('/api/tasks/game-locations'); if(current(ticket)) notice(result.locations.map(v=>`${v.store}: ${v.path}`).join('\n') || result.hint);
    }));
    const areaEditor = node('details'); areaEditor.className = 'task-agent-settings'; areaEditor.append(node('summary', 'Approve a work area'));
    areaEditor.append(node('p','Save a work area with specific folders. Leave editing access empty for read-only work. New commands still need a separate review.'));
    const areaName = field(areaEditor, 'Name', node('input'));
    const readRoots = field(areaEditor, 'Folders TLI may read · absolute paths, one per line', node('textarea'));
    const writeRoots = field(areaEditor, 'Folders TLI may edit · optional, one per line', node('textarea'));
    areaName.placeholder = 'My project'; readRoots.placeholder = 'C:\\Projects\\My project'; writeRoots.placeholder = 'Only folders where edits are allowed';
    areaEditor.append(button('Approve these folders', saveArea), controls); access.append(areaEditor);
    const modelOptions = node('details'); modelOptions.className = 'task-agent-settings'; modelOptions.append(node('summary','Model & internet options')); body.append(modelOptions);
    const provider = select(modelOptions, 'Task model', [['bundled','Bundled local model'],['lmstudio','LM Studio'],['lan','Selected LAN model'],['openai','OpenAI cloud']]); provider.id = 'task-agent-provider';
    const model = field(modelOptions, 'Model ID · required for LM Studio/cloud', node('input')); model.placeholder='Model identifier from your provider';
    const reasoning = select(modelOptions, 'Cloud reasoning effort', [['high','High'],['medium','Medium'],['low','Low'],['xhigh','Extra high'],['max','Maximum']]);
    const share = checkbox(modelOptions, 'Allow task excerpts and selected context to be sent to this LAN/cloud provider');
    const web = checkbox(modelOptions, 'Allow internet research for this task');
    modelOptions.append(node('p', 'The bundled local model is used by default. Cloud access and web research need host setup. A provider failure will not switch models.'));
    const setup = node('details'); setup.className = 'task-agent-setup'; setup.append(node('summary','Host setup details'),node('p','Cloud tasks need TLI_OPENAI_API_KEY on the host. Local web research needs TLI_TASK_SEARXNG_URL. Context note/history choices also apply.')); modelOptions.append(setup);
    const actions = node('div'); actions.className='task-agent-actions'; body.append(actions);
    const stopButton=button('Stop task',stop);stopButton.disabled=true;
    actions.append(stopButton,button('Saved tasks',savedTasks));
    const taskTitle=node('h4','Task activity'),noticeNode=node('p');noticeNode.hidden=true;noticeNode.setAttribute('role','status');noticeNode.setAttribute('aria-live','polite');noticeNode.className='task-agent-notice';body.append(noticeNode);
    const receipts=node('div'),review=node('div'),saved=node('div');review.className='task-agent-review';saved.className='task-agent-saved';
    const activity = node('div'); activity.className = 'task-agent-activity'; activity.hidden = true; activity.append(taskTitle,receipts,review,saved); body.append(activity);
    const inputRow = $('chat-input')?.closest('.chat-input-row'); if (inputRow) inputRow.before(box); else composer.append(box);
    const sendLabel = $('chat-send-btn')?.querySelector('span');
    ui={mode,modeState,modeHint,body,examples,area,areaEditor,areaName,readRoots,writeRoots,modelOptions,provider,model,reasoning,share,web,stop:stopButton,taskTitle,notice:noticeNode,receipts,review,saved,activity,sendLabel,originalSendLabel:sendLabel?.textContent};
    paintMode();
    document.addEventListener('click', event=>{
      if(taskMode && event.target.closest?.('#chat-send-btn')) {event.preventDefault();event.stopImmediatePropagation();invoke(()=>run($('chat-input')?.value||''));}
    },true);
    $('chat-input')?.addEventListener('keydown',event=>{
      if(taskMode && event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();event.stopImmediatePropagation();invoke(()=>run(event.currentTarget.value));}
    },true);
  }
  window.addEventListener('tli:voice-turn',event=>{
    const voice=event.detail;if(!voice||!ui||locked)return;voice.handled=true;
    const action=async()=>{
      if(taskMode)return run(voice.text,voice);
      if(busy||$('chat-send-btn')?.disabled)throw Error('Wait for the current reply.');
      const ticket=++epoch;setBusy(true);stopped=false;
      try {
        const selection=window.TLILanInference?.capture()?.selection||null;
        const result=await watch(await submitOnce('/api/runs',{request_id:crypto.randomUUID(),kind:'chat',chat_path:'/api/ai/chat/stream',payload:{
          message:voice.text,conversation_id:window.currentConversationId||null,lan_inference:selection,
          use_saved_memory:$('memory-use-saved')?.checked===true,use_conversation_history:$('memory-use-history')?.checked!==false}}),ticket);
        if(current(ticket)) {
          setBusy(false);
          if(result.conversation_id)await window.loadConversation?.(result.conversation_id,'Voice conversation',{refresh:true});
          if(current(ticket))await voice.complete(result.reply,{run_id:result.run_id});
        }
      } finally {if(current(ticket)){setBusy(false);runId=null;}}
    }; const promise=action(),ticket=epoch;promise.catch(error=>{if(current(ticket)){notice(error.message);voice.fail?.(error.message);}});
  });
  window.addEventListener('tli:voice-stop',()=>{if(busy)stop().catch(()=>{});});
  window.addEventListener('tli-session-locked',()=>reset(true));
  window.addEventListener('tli-session-unlocked',()=>reset(false));
  for(const name of ['tli-user-changed','tli-account-changed','pagehide'])window.addEventListener(name,()=>reset(true));
  window.TLITaskAgent={run,stop,refresh:loadAreas};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
