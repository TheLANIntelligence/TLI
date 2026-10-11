/* Reviewed snapshots on the existing Chat controller. Never captures, sends or executes. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tasks = { image:'Ask about this image', explain:'Explain this screen', error:'Help with an error', next_step:'Choose the next step' };
  const prompts = { explain:'Explain this screen and its visible controls.', error:'Help me understand this error and choose a useful next check.', next_step:'Help me choose the next step on this screen.' };
  const state = { attached:false, nextTask:null, version:0, review:null, computers:[], checking:false, controller:null, timer:null, locked:false, targetMissing:false, targetLabel:'', previewInvoker:null };
  const validTask = task => Object.hasOwn(tasks, task);
  const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  function validateReview(data) {
    const bad = () => { throw new Error('Sharing details were incomplete. Recheck before sending.'); };
    if (!record(data) || !record(data.host) || !text(data.host.id,256) || !text(data.host.name,256) || !text(data.checked_at,64) || !Number.isFinite(Date.parse(data.checked_at)) || !Array.isArray(data.computers) || data.computers.length > 512) bad();
    const ids = new Set();
    const computers = data.computers.map(c => {
      if (!record(c) || !text(c.id,256) || !text(c.name,256) || (c.node_id != null && !text(c.node_id,256)) || ids.has(c.id) || c.id === 'other') bad();
      ids.add(c.id); return {id:c.id,name:c.name,node_id:c.node_id ?? null};
    });
    let provider = null;
    if (data.provider != null) {
      const p = data.provider;
      if (!record(p) || typeof p.key !== 'string' || !/^[a-f0-9]{64}$/.test(p.key) || !text(p.provider,80) || !text(p.model,512) || !text(p.destination,253) || !text(p.note,1000,true) || (p.port != null && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535))) bad();
      provider = {key:p.key,provider:p.provider,model:p.model,destination:p.destination,port:p.port ?? null,note:p.note};
    } else if (!text(data.reason,2000)) bad();
    return {host:{id:data.host.id,name:data.host.name},computers,provider,reason:provider ? null : data.reason,checked_at:data.checked_at};
  }
  function node(tag, content, cls) { const n = document.createElement(tag); if (content) n.textContent = content; if (cls) n.className = cls; return n; }
  function field(label, control) { const n = node('label','','tli-int-field'); n.append(node('span',label),control); return n; }
  function option(value, label) { const n = node('option',label); n.value = value; return n; }
  function notice(content) { if ($('screenshot-sharing')) $('screenshot-sharing').textContent = content; }
  async function readReview(response) {
    const tooLarge = () => new Error('Sharing details were too large. Recheck before sending.');
    if (Number(response.headers?.get('content-length')) > 524288) { await response.body?.cancel?.(); throw tooLarge(); }
    const reader = response.body?.getReader?.();
    if (!reader) { if (!response.text) return response.json(); const body = await response.text(); if (body.length > 524288) throw tooLarge(); return JSON.parse(body); }
    const decoder = new TextDecoder(); let size = 0, body = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 524288) { await reader.cancel(); throw tooLarge(); }
        body += decoder.decode(chunk.value,{stream:true});
      }
      return JSON.parse(body + decoder.decode());
    } finally { reader.releaseLock(); }
  }
  function invalidate() { state.version++; state.controller?.abort(); state.controller = null; clearTimeout(state.timer); state.timer = null; state.checking = false; state.review = null; if ($('screenshot-recheck')) $('screenshot-recheck').disabled = false; }
  function closePreview(returnFocus = true) {
    const invoker = state.previewInvoker; if (!returnFocus) state.previewInvoker = null;
    const dialog = $('screenshot-preview-dialog'); if (dialog?.open) dialog.close();
    if ($('screenshot-preview-image')) $('screenshot-preview-image').src = '';
    if (returnFocus && !state.locked && invoker?.isConnected) invoker.focus();
  }
  function renderScope() {
    if (!state.attached || !$('screenshot-task')) return;
    const guided = $('screenshot-task').value !== 'image', value = $('screenshot-computer').value;
    $('screenshot-title').textContent = guided ? 'Review screenshot' : 'Review image';
    $('screenshot-scope').hidden = !guided; $('screenshot-other-wrap').hidden = value !== 'other';
    const context = window.TLIIntelligence?.getContext() || {};
    $('screenshot-clear-report').hidden = !context.diagnostic_id;
    const computer = value === 'other' ? $('screenshot-other').value.trim() || 'Another computer' : state.computers.find(c => c.id === value)?.name || (state.targetMissing ? state.targetLabel : 'Unknown');
    $('screenshot-scope-summary').textContent = guided ? `Computer: ${computer}${state.targetMissing ? ' — unavailable; choose again' : ''} · ${context.diagnostic_id ? 'Saved report attached' : 'Screenshot only; no report'}` : 'Image question · Review your other selected context before sending.';
    $('screenshot-report').textContent = context.diagnostic_id ? 'The selected saved report is attached. It must measure the chosen computer; a screenshot is not a live measurement.' : 'No report attached. A matching saved report is optional.';
    $('screenshot-retention').textContent = context.retention_days ? `TLI retains this image for ${context.retention_days} day(s). Chat text stays in history.` : 'TLI does not retain this image after the request. Chat text stays in history.';
    $('screenshot-boundary').textContent = guided ? 'Saved notes and earlier chat are not shared in screenshot guidance. No actions run.' : 'Image questions keep their existing context rules. Resolve any conflicting notes or documents before sending.';
    $('screenshot-models').hidden = !state.review || !!state.review.provider;
  }
  async function recheck() {
    if (state.checking || state.locked || !state.attached) return;
    invalidate(); const version = state.version;
    state.controller = new AbortController(); state.checking = true;
    notice('Checking sharing details… No image has been sent.'); $('screenshot-recheck').disabled = true; $('screenshot-models').hidden = true;
    const current = () => version === state.version && state.attached && !state.locked;
    state.timer = setTimeout(() => { if (current()) { invalidate(); notice('Sharing check timed out. No image was sent. Recheck before sharing.'); } },15000);
    try {
      const response = await fetch('/api/intelligence/screenshots/context',{cache:'no-store',signal:state.controller.signal});
      if (!current()) return;
      const raw = await readReview(response);
      if (!current()) return;
      if (!response.ok) throw new Error(text(raw?.detail,2000) ? raw.detail : 'Sharing details are unavailable.');
      const data = validateReview(raw), target = $('screenshot-computer'), counts = new Map();
      // A user can edit scope while this read waits. Preserve that latest choice.
      const previous = target.value, oldLabel = state.computers.find(c => c.id === previous)?.name || state.targetLabel || previous;
      data.computers.forEach(c => counts.set(c.name,(counts.get(c.name) || 0) + 1));
      target.replaceChildren(option('','Unknown — screenshot only'), ...data.computers.map(c => option(c.id,`${c.name} · ${c.node_id === data.host.id ? 'TLI host' : 'registered computer'}${counts.get(c.name) > 1 ? ' · ' + c.id : ''}`)), option('other','Another computer…'));
      state.targetMissing = !!previous && previous !== 'other' && !data.computers.some(c => c.id === previous);
      if (state.targetMissing) { const missing = option(previous,`Unavailable · ${oldLabel}`); missing.disabled = true; target.append(missing); }
      target.value = previous; state.targetLabel = oldLabel; state.review = data; state.computers = data.computers;
      const p = data.provider;
      notice(p ? `Send to ${p.provider} · ${p.model} at ${p.destination}${p.port ? ':' + p.port : ''}. No image sent yet.` : `Image guidance unavailable: ${data.reason}`);
      $('screenshot-provider-detail').textContent = `${p?.note || 'You can describe or paste the visible error as text without an image.'} Checked ${new Date(data.checked_at).toLocaleString()}. The provider may have its own retention policy.`;
      renderScope();
    } catch (error) {
      if (current()) { notice((error instanceof SyntaxError ? 'Sharing details were incomplete.' : error.message) + ' Recheck before sharing.'); $('screenshot-provider-detail').textContent = ''; }
    } finally { if (current()) { clearTimeout(state.timer); state.timer = null; state.checking = false; state.controller = null; $('screenshot-recheck').disabled = false; } }
  }
  function attachmentReadStarted() { const task = state.nextTask || 'image'; state.nextTask = null; return task; }
  function attachmentChanged(file, taskToken) {
    const chosen = validTask(taskToken) ? taskToken : state.nextTask || 'image';
    invalidate(); closePreview(false); state.attached = !!file && !state.locked; state.targetMissing = false; state.targetLabel = ''; state.computers = [];
    const box = $('screenshot-help'); if (!box) return;
    box.hidden = !state.attached; $('screenshot-task').value = state.attached ? chosen : 'image';
    $('screenshot-computer').replaceChildren(option('','Unknown — screenshot only')); $('screenshot-computer').value = ''; $('screenshot-other').value = ''; $('screenshot-details').open = false;
    for (const id of ['screenshot-filename','screenshot-sharing','screenshot-provider-detail','screenshot-scope-summary','screenshot-retention','screenshot-report','screenshot-boundary']) $(id).textContent = '';
    state.nextTask = null;
    if (state.attached) { $('screenshot-filename').textContent = typeof file.name === 'string' ? file.name.slice(0,256) : 'Attached image'; renderScope(); recheck(); }
  }
  function prepareTask(task) { if (!state.locked && validTask(task)) state.nextTask = task; }
  function chooseScreenshot(task = 'explain') { if (state.locked) return; prepareTask(validTask(task) && task !== 'image' ? task : 'explain'); $('chat-image-input')?.click(); }
  function requestContext(context) {
    if (state.locked) throw new Error('Unlock TLI and attach the image again.');
    if (!state.attached) return context;
    if (!state.review?.provider) throw new Error(state.review?.reason || 'Recheck the sharing details before sending the screenshot.');
    const task = $('screenshot-task').value; if (!validTask(task)) throw new Error('Choose how TLI can help with this image.');
    if (task === 'image') return {...context,image_provider_key:state.review.provider.key};
    const value = $('screenshot-computer').value;
    if (state.targetMissing || (value && value !== 'other' && !state.review.computers.some(c => c.id === value))) throw new Error('The chosen computer is no longer available. Choose another computer or explicitly choose Unknown.');
    return {...context,target_id:null,screenshot:{task,target_id:value && value !== 'other' ? value : null,other_computer:value === 'other' ? $('screenshot-other').value.trim() || 'Another computer' : null,provider_key:state.review.provider.key}};
  }
  function annotateReply(bubble, meta) {
    const c = meta?.screenshot_context;
    if (!bubble || !c || !validTask(c.task) || c.task === 'image' || c.capture !== 'user_shared_snapshot' || c.actions_performed !== false || !text(c.computer?.name,256) || (c.report_id != null && !text(c.report_id,256))) return;
    const provider = [meta.provider,meta.model].filter(v => text(v,512)).join(' / '), receipt = node('div','','screenshot-receipt');
    receipt.append(node('p',`Screenshot guidance · ${tasks[c.task]} · ${c.computer.name} (user-selected or unknown)${provider ? ' · ' + provider : ''}. ${c.report_id ? 'Saved report attached to that turn. ' : ''}No actions performed. This was a shared snapshot. Attach the next screen to continue.`));
    const next = node('button','Share the next screen','btn-outline btn-sm'); next.type = 'button'; next.addEventListener('click',() => chooseScreenshot(c.task)); receipt.append(next); bubble.append(receipt);
  }
  function clearPrivate() { state.locked = true; state.nextTask = null; attachmentChanged(null); if ($('screenshot-start')) $('screenshot-start').disabled = true; }
  function init() {
    const preview = $('chat-image-preview'); if (!preview || $('screenshot-help')) return;
    const box = node('section','','tli-intelligence screenshot-help'); box.id = 'screenshot-help'; box.hidden = true; box.setAttribute('aria-label','Image sharing and screenshot guidance');
    const body = node('div','','tli-int-body');
    const dialog = node('dialog','','screenshot-preview-dialog'); dialog.id = 'screenshot-preview-dialog'; dialog.setAttribute('aria-label','Review attached image');
    const expanded = node('img'); expanded.id = 'screenshot-preview-image'; expanded.alt = 'Full preview of the image to share';
    const close = node('button','Close preview','btn-outline'); close.type = 'button'; close.addEventListener('click',() => dialog.close());
    dialog.addEventListener('close',() => { expanded.src = ''; const invoker = state.previewInvoker; state.previewInvoker = null; if (!state.locked && invoker?.isConnected) invoker.focus(); });
    dialog.append(close,expanded); box.append(dialog);
    const heading = node('div','','screenshot-review-heading'), title = node('h4','Review screenshot'); title.id = 'screenshot-title';
    const enlarge = node('button','Enlarge preview','btn-outline btn-sm'); enlarge.type = 'button'; enlarge.id = 'screenshot-enlarge';
    enlarge.addEventListener('click',() => { if (!state.attached || state.locked || dialog.open) return; state.previewInvoker = enlarge; expanded.src = $('chat-image-thumb').src; dialog.showModal(); });
    heading.append(title,enlarge);
    const filename = node('p','','screenshot-filename'); filename.id = 'screenshot-filename';
    const task = node('select'); task.id = 'screenshot-task'; Object.entries(tasks).forEach(([id,label]) => task.append(option(id,label))); task.addEventListener('change',renderScope);
    const summary = node('p','','screenshot-scope-summary'); summary.id = 'screenshot-scope-summary'; summary.setAttribute('role','status');
    const sharing = node('p'); sharing.id = 'screenshot-sharing'; sharing.setAttribute('role','status');
    const models = node('button','Review image model options','btn-outline btn-sm'); models.id = 'screenshot-models'; models.type = 'button'; models.hidden = true;
    models.addEventListener('click',() => { if (state.locked) return; if (typeof window.tliOpenModelManagerModal === 'function') window.tliOpenModelManagerModal(); else if (typeof window.tliOpenModelManager === 'function') window.tliOpenModelManager(); else notice('Open Settings to review image model options. No model has been switched.'); });
    const details = node('details','','screenshot-details'); details.id = 'screenshot-details'; details.append(node('summary','Computer, report & sharing details'));
    const scope = node('div'); scope.id = 'screenshot-scope';
    const computer = node('select'); computer.id = 'screenshot-computer'; computer.append(option('','Unknown — screenshot only')); computer.addEventListener('change',() => { state.targetMissing = false; renderScope(); });
    const other = node('input'); other.id = 'screenshot-other'; other.maxLength = 120; other.placeholder = 'For example, my work laptop'; other.addEventListener('input',renderScope);
    const otherWrap = field('Computer name (optional)',other); otherWrap.id = 'screenshot-other-wrap';
    const report = node('p'); report.id = 'screenshot-report';
    const clear = node('button','Clear attached report','btn-outline btn-sm'); clear.type = 'button'; clear.id = 'screenshot-clear-report'; clear.addEventListener('click',() => { window.TLIIntelligence?.clearReport(); renderScope(); });
    scope.append(field('Which computer is shown?',computer),otherWrap,report,clear);
    const provider = node('p'); provider.id = 'screenshot-provider-detail';
    const check = node('button','Recheck sharing details','btn-outline btn-sm'); check.id = 'screenshot-recheck'; check.type = 'button'; check.addEventListener('click',recheck);
    const settings = node('button','Review report or image retention','btn-outline btn-sm'); settings.type = 'button'; settings.addEventListener('click',() => { if (state.locked) return; if ($('chat-context-details')?.hidden) $('chat-context-toggle')?.click(); });
    details.append(scope,provider,check,settings);
    const retention = node('p'); retention.id = 'screenshot-retention';
    const boundary = node('p','','screenshot-boundary'); boundary.id = 'screenshot-boundary';
    body.append(heading,filename,field('How can TLI help?',task),summary,sharing,models,retention,details,boundary,node('p','Check the preview for personal information. Add your goal below, then press Send.','screenshot-send-hint'));
    box.append(body); preview.after(box);
    const start = node('button','Screenshot help','chip-button'); start.type = 'button'; start.id = 'screenshot-start'; start.addEventListener('click',() => chooseScreenshot());
    document.querySelector('.chat-composer-bottom')?.append(start);
    $('chat-image-input')?.addEventListener('cancel',() => { state.nextTask = null; });
    document.addEventListener('change',() => { if (state.attached) renderScope(); });
    window.addEventListener?.('tli-chat-context-changed',renderScope);
    window.addEventListener?.('tli-session-locked',clearPrivate); window.addEventListener?.('pagehide',clearPrivate);
    window.addEventListener?.('tli-session-unlocked',() => { state.locked = false; start.disabled = false; });
    document.addEventListener('visibilitychange',() => { if (!document.hidden) return; closePreview(false); if (state.checking) { invalidate(); notice('Sharing review paused. Recheck before sending.'); } });
  }
  window.TLIScreenshots = {attachmentChanged,attachmentReadStarted,attachmentReadFailed:() => { state.nextTask = null; },prepareTask,chooseScreenshot,requestContext,annotateReply,chooseImage:() => prepareTask('image'),defaultPrompt:() => prompts[$('screenshot-task')?.value] || "What's in this image?"};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
