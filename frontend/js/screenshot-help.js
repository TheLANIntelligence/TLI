/* Explicit, per-attachment screenshot guidance on the existing chat surface. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { attached: false, nextTask: null, version: 0, review: null };
  const prompts = { explain: 'Explain this screen and its visible controls.', error: 'Help me understand this error and choose a useful next check.',
    next_step: 'Help me choose the next step on this screen.' };
  function node(tag, text, cls) {
    const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n;
  }
  function field(label, control) { const n = node('label', '', 'tli-int-field'); n.append(node('span', label), control); return n; }
  function option(value, label) { const n = node('option', label); n.value = value; return n; }
  function notice(text) { if ($('screenshot-sharing')) $('screenshot-sharing').textContent = text; }
  function renderScope() {
    const guided = $('screenshot-task').value !== 'image';
    $('screenshot-scope').hidden = !guided;
    $('screenshot-other-wrap').hidden = $('screenshot-computer').value !== 'other';
    const context = window.TLIIntelligence?.getContext() || {};
    $('screenshot-clear-report').hidden = !context.diagnostic_id;
    $('screenshot-report').textContent = context.diagnostic_id ?
      'The report selected under Device, report & image context is attached. It must measure the chosen computer.' :
      'No report attached. Guidance uses the screenshot and your message.';
    $('screenshot-retention').textContent = context.retention_days ?
      `This image will be retained by TLI for ${context.retention_days} day(s). Change this under Device, report & image context.` :
      'TLI will not retain the image after this request. Your message and the answer stay in chat history.';
  }
  async function recheck() {
    const version = ++state.version;
    state.review = null;
    notice('Checking the image provider… The image has not been sent.');
    $('screenshot-recheck').disabled = true;
    try {
      const response = await fetch('/api/intelligence/screenshots/context', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Sharing details are unavailable.');
      if (version !== state.version || !state.attached) return;
      const target = $('screenshot-computer'), previous = target.value;
      target.replaceChildren(option('', 'Unknown — use only the screenshot'),
        ...data.computers.map(c => option(c.id, c.name + (c.node_id === data.host.id ? ' · TLI host' : ' · registered computer'))),
        option('other', 'Another computer…'));
      target.value = previous === 'other' || data.computers.some(c => c.id === previous) ? previous : '';
      state.review = data;
      notice(data.provider ? `Send to ${data.provider.provider} · ${data.provider.model} at ${data.provider.destination}${data.provider.port ? ':' + data.provider.port : ''}. ${data.provider.note} Checked ${new Date(data.checked_at).toLocaleTimeString()}.` : data.reason);
      renderScope();
    } catch (error) {
      if (version === state.version) notice(error.message + ' Recheck before sharing a screenshot.');
    } finally { if (version === state.version) $('screenshot-recheck').disabled = false; }
  }
  function attachmentChanged(file) {
    state.attached = !!file; state.version++; state.review = null;
    const box = $('screenshot-help'); if (!box) return;
    if ($('screenshot-preview-dialog')?.open) $('screenshot-preview-dialog').close();
    box.hidden = !file;
    $('screenshot-task').value = file ? (state.nextTask || 'image') : 'image';
    $('screenshot-computer').value = ''; $('screenshot-other').value = '';
    if (file) {
      state.nextTask = null;
      $('screenshot-filename').textContent = file.name;
      renderScope(); recheck();
    }
  }
  function requestContext(context) {
    if (!state.attached) return context;
    if (!state.review?.provider) throw new Error(state.review?.reason || 'Recheck the sharing details before sending the screenshot.');
    if ($('screenshot-task').value === 'image') return { ...context, image_provider_key: state.review.provider.key };
    const value = $('screenshot-computer').value;
    return { ...context, target_id: null, screenshot: {
      task: $('screenshot-task').value, target_id: value && value !== 'other' ? value : null,
      other_computer: value === 'other' ? $('screenshot-other').value.trim() || 'Another computer' : null,
      provider_key: state.review.provider.key,
    } };
  }
  function annotateReply(bubble, meta) {
    if (!bubble || !meta?.screenshot_context) return;
    const context = meta.screenshot_context;
    const tasks = { explain: 'Explain this screen', error: 'Help with an error', next_step: 'Choose the next step' };
    if (!Object.hasOwn(tasks, context.task) || context.capture !== 'user_shared_snapshot' || context.actions_performed !== false ||
        typeof context.computer?.name !== 'string' || !context.computer.name || context.computer.name.length > 256) return;
    const provider = [meta.provider, meta.model].filter(value => typeof value === 'string' && value).join(' / ');
    bubble.append(node('p', `Screenshot guidance · ${tasks[context.task]} · ${context.computer.name} (user-selected or unknown)${provider ? ' · ' + provider : ''}. ${context.report_id ? 'Saved report attached to that turn. ' : ''}No actions performed. This was a shared snapshot. Attach the next screen to continue.`, 'screenshot-receipt'));
  }
  function init() {
    const preview = $('chat-image-preview'); if (!preview || $('screenshot-help')) return;
    const box = node('section', '', 'tli-intelligence screenshot-help'); box.id = 'screenshot-help'; box.hidden = true;
    box.setAttribute('aria-label', 'Image sharing and screenshot guidance');
    const body = node('div', '', 'tli-int-body');
    const dialog = node('dialog', '', 'screenshot-preview-dialog'); dialog.id = 'screenshot-preview-dialog';
    dialog.setAttribute('aria-label', 'Review attached image');
    const expanded = node('img'); expanded.alt = 'Full preview of the image to share';
    const close = node('button', 'Close preview', 'btn-outline'); close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { expanded.src = ''; });
    dialog.append(close, expanded); box.append(dialog);
    const enlarge = node('button', 'Enlarge preview', 'btn-outline btn-sm'); enlarge.type = 'button';
    enlarge.addEventListener('click', () => { expanded.src = $('chat-image-thumb').src; dialog.showModal(); });
    const filename = node('p'); filename.id = 'screenshot-filename';
    const task = node('select'); task.id = 'screenshot-task';
    task.append(option('image', 'Ask about this image'), option('explain', 'Explain this screen'),
      option('error', 'Help with an error'), option('next_step', 'Choose the next step'));
    task.addEventListener('change', renderScope);
    const scope = node('div'); scope.id = 'screenshot-scope';
    const computer = node('select'); computer.id = 'screenshot-computer'; computer.append(option('', 'Unknown — use only the screenshot'));
    computer.addEventListener('change', renderScope);
    const other = node('input'); other.id = 'screenshot-other'; other.maxLength = 120; other.placeholder = 'For example, my work laptop';
    const otherWrap = field('Computer name (optional)', other); otherWrap.id = 'screenshot-other-wrap';
    const report = node('p'); report.id = 'screenshot-report';
    const clear = node('button', 'Clear attached report', 'btn-outline btn-sm'); clear.type = 'button'; clear.id = 'screenshot-clear-report';
    clear.addEventListener('click', () => { window.TLIIntelligence?.clearReport(); renderScope(); });
    scope.append(field('Which computer is shown?', computer), otherWrap, report, clear,
      node('p', 'Describe your goal in the message below. TLI will suggest a step and what to look for afterward. Share each new screen yourself.'));
    const sharing = node('p'); sharing.id = 'screenshot-sharing'; sharing.setAttribute('role', 'status');
    const retention = node('p'); retention.id = 'screenshot-retention';
    const check = node('button', 'Recheck sharing details', 'btn-outline btn-sm'); check.id = 'screenshot-recheck'; check.type = 'button'; check.addEventListener('click', recheck);
    body.append(node('h4', 'Review before sharing'), filename, enlarge, field('How can TLI help?', task), scope, sharing, check, retention,
      node('p', 'Check the preview for personal information. Press Send to share this image with the provider above. The provider may have its own retention settings.'));
    box.append(body); preview.after(box);
    const start = node('button', 'Screenshot help', 'chip-button'); start.type = 'button'; start.id = 'screenshot-start';
    start.addEventListener('click', () => { state.nextTask = 'explain'; $('chat-image-input')?.click(); });
    document.querySelector('.chat-actions-row > div')?.append(start);
    $('chat-image-input')?.addEventListener('cancel', () => { state.nextTask = null; });
    document.addEventListener('change', () => { if (state.attached) renderScope(); });
  }
  window.TLIScreenshots = { attachmentChanged, requestContext, annotateReply,
    chooseImage: () => { state.nextTask = 'image'; },
    defaultPrompt: () => prompts[$('screenshot-task')?.value] || "What's in this image?" };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
