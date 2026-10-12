/* Shared host runs. Only GETs reconnect; an uncertain POST is never replayed. */
window.TLIWorkspace = (() => {
  'use strict';
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  let generation = 0, locked = false, leaving = false, bootstrapPromise, epoch = '', cursor = 0, refreshing = false;
  const active = new Set();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const aborted = () => Object.assign(new Error('Stop requested. Review saved work for any already completed actions.'), {name:'AbortError'});
  async function json(path, options = {}) {
    const response = await fetch(path, {cache:'no-store', ...options, headers:{'Content-Type':'application/json', ...(options.headers || {})}});
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof value.detail === 'string' ? value.detail : value.detail?.message || `Workspace request failed (${response.status}).`), {status:response.status});
    return value;
  }
  async function supported() {
    if (locked) return false;
    if (!bootstrapPromise) bootstrapPromise = json('/api/companion/v1/bootstrap').then(value => value.capabilities?.host_runs === true).catch(error => { bootstrapPromise = null; if (error.status === 404) return false; throw error; });
    return bootstrapPromise;
  }
  async function run(kind, payload, {signal, onMeta, onDelta, appId, chatPath} = {}) {
    const ticket = generation;
    const available = await supported();
    if (locked || ticket !== generation || leaving) throw aborted();
    if (!available) return null;
    if (signal?.aborted) throw aborted();
    const requestId = crypto.randomUUID();
    let id = requestId, value, emitted = '', lastMetadata = '', stopped = false;
    const current = () => !locked && ticket === generation && !leaving;
    const stop = () => { stopped = true; if (current()) void json(`/api/runs/${encodeURIComponent(id)}/cancel`, {method:'POST',body:'{}'}).catch(() => {}); };
    signal?.addEventListener('abort', stop, {once:true});
    active.add(requestId);
    try {
      try {
        value = await json('/api/runs', {method:'POST', body:JSON.stringify({request_id:requestId,kind,payload,...(appId ? {app_id:appId} : {}),...(chatPath ? {chat_path:chatPath} : {})})});
      } catch (error) {
        if (error.status) throw error;
        value = await json(`/api/runs/${requestId}`).catch(() => { throw Error('The submission result is uncertain. Reopen Saved work before deliberately retrying; nothing was automatically resent.'); });
      }
      id = value.id;
      if (stopped) { stop(); throw aborted(); }
      while (current()) {
        if (signal?.aborted) throw aborted();
        const meta = {...value.metadata, ...(value.conversation_id ? {conversation_id:value.conversation_id,session_id:value.conversation_id} : {})};
        const serial = JSON.stringify(meta);
        if (serial !== lastMetadata) { lastMetadata = serial; onMeta?.(meta); }
        const text = value.text || value.result?.reply || '';
        if (text.startsWith(emitted) && text.length > emitted.length) { onDelta?.(text.slice(emitted.length)); emitted = text; }
        if (terminal.has(value.status)) {
          if (value.status !== 'completed') throw Error(value.error || 'This request did not finish. Review saved work before retrying.');
          return value.result || {reply:text, ...meta};
        }
        await sleep(document.hidden ? 2500 : 650);
        if (!current()) throw aborted();
        if (document.hidden) continue;
        try { value = await json(`/api/runs/${encodeURIComponent(id)}?after=${value.cursor || 0}`); }
        catch (error) { if (error.status) throw error; await sleep(1500); }
      }
      throw aborted();
    } finally { active.delete(requestId); signal?.removeEventListener('abort', stop); }
  }
  async function chat(payload, options = {}) { return run('chat', {lan_inference:null, ...payload}, options); }
  async function builder(path, payload) {
    const appId = path ? decodeURIComponent(path.split('/')[1]) : undefined;
    return run(appId ? 'builder_revise' : 'builder_create', payload, {appId});
  }
  async function refresh() {
    if (refreshing || locked || document.hidden || leaving) return;
    refreshing = true;
    const ticket = generation;
    try {
      if (!(await supported())) return;
      if (ticket !== generation || locked || leaving) return;
      const value = await json(`/api/workspace/events?after=${cursor}&epoch=${encodeURIComponent(epoch)}`);
      if (ticket !== generation || locked) return;
      const first = !epoch; epoch = value.epoch; cursor = value.cursor;
      for (const event of value.events || []) window.dispatchEvent(new CustomEvent('tli-workspace-changed', {detail:event}));
      const id = window.currentConversationId;
      if (!first && !active.size && id && (value.reset || value.events?.some(event => ['conversation','conversation_settings'].includes(event.kind) && event.resource_id === id))) {
        if (!document.getElementById('chat-send-btn')?.disabled) await window.loadConversation?.(id, '', {refresh:true});
      }
      await renderRuns(ticket);
    } catch (error) { if (ticket === generation && error.status === 401) locked = true; }
    finally { refreshing = false; }
  }
  async function renderRuns(ticket) {
    const host = document.getElementById('chat-lan-inference');
    if (!host) return;
    const value = await json('/api/runs');
    if (ticket !== generation || locked) return;
    let shelf = document.getElementById('workspace-saved-runs');
    if (!shelf) { shelf = document.createElement('details'); shelf.id = 'workspace-saved-runs'; shelf.className = 'chat-options'; host.after(shelf); }
    const runs = (value.runs || []).slice(0, 8);
    shelf.hidden = !runs.length;
    const open = shelf.open; shelf.replaceChildren(); shelf.open = open;
    const summary = document.createElement('summary'); summary.textContent = `Saved work · ${runs.filter(value => !terminal.has(value.status)).length} running`; shelf.append(summary);
    for (const value of runs) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px';
      const label = document.createElement('span'); label.textContent = `${value.kind === 'chat' ? 'Conversation' : 'Builder'} · ${value.status}`; row.append(label);
      if (value.conversation_id) { const button = document.createElement('button'); button.type = 'button'; button.className = 'chip-button'; button.textContent = 'Open conversation'; button.onclick = () => window.loadConversation?.(value.conversation_id, 'Shared conversation'); row.append(button); }
      if (value.app_id) { const button = document.createElement('button'); button.type = 'button'; button.className = 'chip-button'; button.textContent = 'Open app'; button.onclick = () => window.TLIWebApps?.openProject?.(value.app_id); row.append(button); }
      if (!terminal.has(value.status)) { const button = document.createElement('button'); button.type = 'button'; button.className = 'chip-button'; button.textContent = 'Stop'; button.onclick = () => json(`/api/runs/${encodeURIComponent(value.id)}/cancel`, {method:'POST',body:'{}'}).then(refresh).catch(error => window.showToast?.(error.message,'error')); row.append(button); }
      shelf.append(row);
    }
  }
  function clear(isLocked) { generation++; locked = isLocked; bootstrapPromise = null; epoch = ''; cursor = 0; document.getElementById('workspace-saved-runs')?.remove(); }
  window.addEventListener('tli-session-locked', () => clear(true));
  window.addEventListener('tli-session-unlocked', () => { clear(false); void refresh(); });
  for (const type of ['tli-user-changed','tli-account-changed']) window.addEventListener(type, () => clear(true));
  window.addEventListener('pagehide', () => { leaving = true; });
  window.addEventListener('pageshow', () => { leaving = false; void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(refresh, 5000);
  return {supported, run, chat, builder, refresh};
})();
