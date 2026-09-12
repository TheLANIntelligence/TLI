/* Presentation and explicit context controls for AI Chat only. No provider calls. */
(() => {
  'use strict';
  const subject = "(?:(?:the|my|our|your) )?(?:(?:tli(?:'s)?|local|bundled|integrated|built-in) )?(?:ai(?: model)?|qwen(?: model)?|model|llm|lm ?studio)";
  const status = '(?:(?:currently|actually|still) )?(?:running|online|active|available|ready|working|loaded|on)';
  const questions = [new RegExp('^(?:is|are) '+subject+' '+status+'$'),
    new RegExp('^check (?:(?:if|whether) )?'+subject+' (?:is|are) '+status+'$'),
    new RegExp("^(?:what(?:'s| is) )?(?:the )?status of "+subject+'$'),
    new RegExp("^(?:what(?:'s| is) )?"+subject+' status$'),
    /^(?:what|which) (?:ai )?model (?:are you|is tli) (?:running|using)$/, /^(?:what|which) (?:ai|model) is (?:currently )?(?:running|loaded|selected)$/];
  function isStatusQuestion(text) { return questions.some(re => re.test(String(text || '').toLowerCase().replace(/’/g,"'").replace(/\s+/g,' ').trim().replace(/[?!. ]+$/,'').replace(/^(?:please |can you |could you )/,''))); }
  function describeNoteMode(items = [], {savedNotes = true, text = ''} = {}) {
    if (!items.some(item => item.kind === 'note')) return null;
    const conflicts = [...new Set(items.filter(item => ['image', 'device', 'report', 'document', 'case'].includes(item.kind)).map(item => item.kind))];
    if (/\[vault:[^\]]+\]/i.test(text)) conflicts.push('Vault reference');
    if (!savedNotes) conflicts.push('Use saved notes is off');
    return {blocked: conflicts.length > 0,
      text: conflicts.length ? `Before sending, resolve: ${conflicts.join(', ')}. Remove those items or remove the selected notes; enable Use saved notes if you keep notes selected. Nothing is removed automatically.`
        : 'Selected-note question: only these notes and your next question are provided. Earlier chat and other saved notes are excluded. No actions run in this mode.'};
  }
  const api = { isStatusQuestion, describeNoteMode, markFailure: bubble => bubble?.classList?.add('chat-bubble-error') };
  // A retry returns the question to the composer for review. It never repeats
  // an uncertain request, recreates an attachment or starts server work.
  api.showInterrupted = (bubble, { partial = '', message = '', stopped = false, actionUncertain = false, review } = {}) => {
    if (!bubble) return;
    bubble.classList.remove('chat-bubble-thinking');
    bubble.classList.add('chat-bubble-incomplete');
    if (!partial) bubble.textContent = '';
    const notice = document.createElement('div'); notice.className = 'chat-interruption'; notice.setAttribute('role', 'status');
    const title = document.createElement('strong'); title.textContent = partial ? 'Incomplete response' : stopped ? 'Response stopped' : 'No completed response';
    const detail = document.createElement('p');
    detail.textContent = (stopped ? 'You stopped waiting for this response. ' : message + ' ') +
      (partial ? 'The partial reply remains above. ' : '') +
      'No request was retried. ' + (actionUncertain ? 'Stopping the response does not confirm that the action stopped; check its result before trying again.' : 'Review your question and current context before sending again.');
    notice.append(title, detail);
    if (typeof review === 'function') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn-outline'; retry.textContent = 'Review question to retry';
      retry.addEventListener('click', review); notice.append(retry);
    }
    bubble.append(notice);
  };
  let activeResponse = null;
  const elapsedText = ms => { const seconds = Math.max(0, ms / 1000); return seconds < 60 ? seconds.toFixed(1) + 's' : Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's'; };
  function clearResponse() {
    if (activeResponse?.timer != null) clearInterval(activeResponse.timer);
    activeResponse = null;
    const status = document.getElementById('chat-response-status'), text = document.getElementById('chat-response-status-text');
    if (status) status.hidden = true; if (text) text.textContent = '';
    const elapsed = document.getElementById('chat-response-elapsed'); if (elapsed) elapsed.textContent = '';
  }
  function beginResponse() {
    clearResponse();
    const now = () => performance.now(), response = {start:now(),first:null,timer:null}; activeResponse = response;
    const status = document.getElementById('chat-response-status'), text = document.getElementById('chat-response-status-text');
    let elapsed = document.getElementById('chat-response-elapsed');
    if (!elapsed && status) { elapsed = document.createElement('span'); elapsed.id = 'chat-response-elapsed'; elapsed.setAttribute('aria-hidden', 'true'); status.append(elapsed); }
    const paint = () => {
      if (activeResponse !== response) return;
      const duration = Math.min(600000, Math.max(0, now() - response.start));
      const phase = response.first == null ? duration < 60000 ? 'Waiting for a reply…' : 'Still waiting for a reply…' : 'Receiving the reply…';
      if (text && text.textContent !== phase) text.textContent = phase;
      if (elapsed) elapsed.textContent = (duration >= 600000 ? '10m+' : elapsedText(duration)) + ' in this browser';
      if (status) status.hidden = false;
      if (duration >= 600000 && response.timer != null) { clearInterval(response.timer); response.timer = null; }
    };
    response.timer = setInterval(paint, 1000); paint();
    return {
      responding: () => { if (activeResponse === response && response.first == null) { response.first = Math.max(0, now() - response.start); paint(); } },
      finish: ({outcome, bubble} = {}) => {
        if (activeResponse !== response) return;
        const total = Math.max(0, now() - response.start); clearResponse();
        if (!bubble || !['completed','interrupted','stopped'].includes(outcome)) return;
        const receipt = document.createElement('div'); receipt.className = 'chat-response-timing';
        receipt.textContent = (response.first == null ? '' : 'First text ' + elapsedText(response.first) + ' · ') +
          (outcome === 'completed' ? 'Response received in ' : outcome === 'stopped' ? 'Stopped waiting after ' : 'Response interrupted after ') + elapsedText(total) + ' · Browser timing';
        receipt.title = 'Measured in this browser from Send, including preparation and network wait. First text means the first displayed reply. This is not a measurement of model speed or server execution.';
        bubble.append(receipt);
      }
    };
  };
  window.TLIChatWorkspace = api;
  function init() {
    const panel = document.getElementById('panel-main');
    if (!panel || panel.dataset.chatWorkspaceBound) return;
    panel.dataset.chatWorkspaceBound = '1';
    const $ = id => document.getElementById(id);
    const root = panel.querySelector('.chat-workspace'), details = $('chat-context-details'), summary = $('chat-context-summary');
    if (!root || !details || !summary) return;
    let locked = false, pending = false, signature = '', optionsFocus = null;
    api.beginResponse = beginResponse;
    const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
    const button = (text, fn) => { const el = node('button', text); el.type = 'button'; el.addEventListener('click', fn); return el; };
    const links = node('div', null, 'chat-context-links');
    links.append(button('Notes & fixes', () => window.TLINotebook?.open()), button('Choose documents', () => window.TLIDocuments?.open()), button('Attach image', () => $('chat-attach-btn')?.click()));
    const hint = node('p', 'Choose what to include. Saved notes and earlier conversation have separate controls for this question. Selected notes, documents and images keep their own sharing rules.', 'chat-context-explanation');
    details.append(links, hint);
    const noteMode = node('p', '', 'chat-note-mode-status'); noteMode.id = 'chat-note-mode-status'; noteMode.hidden = true; noteMode.setAttribute('role', 'status'); details.before(noteMode);
    function paintNoteMode(mode) {
      if (noteMode.hidden !== !mode) noteMode.hidden = !mode;
      const text = mode?.text || '';
      if (noteMode.textContent !== text) noteMode.textContent = text;
      const state = mode ? mode.blocked ? 'blocked' : 'standalone' : '';
      if (noteMode.dataset.state !== state) noteMode.dataset.state = state;
    }
    const chips = $('quickstart-chips'), starter = $('chat-starters');
    const classicStarterHome = chips?.parentElement;
    function arrangeInterface() {
      if (!chips || !starter || !classicStarterHome || !$('chat-starters-slot')) return;
      const classic = document.documentElement.dataset.interface === 'classic';
      const home = classic ? classicStarterHome : $('chat-starters-slot');
      if (chips.parentElement !== home) {
        // Keep starter listeners and control identity. The original explanatory
        // content stays in the same card when the starter controls return.
        if (classic) home.insertBefore(chips, home.children[1] || null);
        else home.append(chips);
      }
      starter.hidden = !classic;
    }
    arrangeInterface();
    window.addEventListener('tli:interface-change', arrangeInterface);
    function organize() {
      // Move existing controls, never clone inputs/listeners or prepare a request.
      ['.tli-int-chat', '#notebook-selected', '#documents-selected', '#case-context-selected'].forEach(selector => {
        const control = panel.querySelector(selector); if (control && control.parentElement !== details) details.append(control);
      });
      const memory = panel.querySelector('.memory-use-control'), slot = $('chat-memory-slot');
      if (memory && slot && memory.parentElement !== slot) {
        slot.append(memory);
        const label = memory.querySelector('label span'); if (label) label.textContent = 'Use saved notes';
        const help = memory.querySelector('p'); if (help) { help.id = 'chat-memory-help'; $('memory-use-saved')?.setAttribute('aria-describedby', help.id); }
      }
    }
    function render() {
      pending = false; organize();
      const output = $('chat-output'), hasMessages = !!output?.querySelector('.chat-bubble');
      root.classList.toggle('is-empty', !hasMessages && !locked);
      $('chat-welcome').hidden = hasMessages || locked;
      if (locked) { summary.replaceChildren(); paintNoteMode(null); signature=''; return; }
      const items=[];
      [window.TLIIntelligence, window.TLINotebook, window.TLIDocuments, window.TLICaseContext].forEach(owner => {
        for (const item of owner?.describeContext?.() || []) if (typeof item.id==='string' && typeof item.label==='string') items.push({ ...item, owner });
      });
      const image = $('chat-image-preview');
      if (image && !image.classList.contains('hidden')) items.push({id:'image',label:'Attached image',kind:'image',owner:{removeContext:()=> $('chat-image-remove')?.click()}});
      const mode = describeNoteMode(items, {savedNotes:$('memory-use-saved')?.checked !== false, text:$('chat-input')?.value || ''});
      paintNoteMode(mode);
      const next=JSON.stringify(items.map(({id,label,kind})=>({id,label,kind})));
      if (next === signature) return;
      signature=next; summary.replaceChildren();
      items.forEach(item=>{
        const chip=node('span',null,'chat-context-chip'), label=node('span',item.label);
        label.title=item.kind+': '+item.label;
        const remove=button('×',()=>{item.owner.removeContext?.(item.id);schedule();});
        remove.setAttribute('aria-label','Remove '+item.label); chip.append(label,remove);summary.append(chip);
      });
    }
    function schedule() { if (pending) return; pending=true; queueMicrotask(render); }
    $('chat-context-toggle').addEventListener('click',()=>{
      const open=details.hidden;details.hidden=!open;$('chat-context-toggle').setAttribute('aria-expanded',String(open));
      if (open) { const device=details.querySelector('.tli-int-chat');if(device)device.open=true; }
    });
    $('chat-runtime-button').addEventListener('click',()=>{
      if(typeof window.tliOpenModelManagerModal==='function')window.tliOpenModelManagerModal();
      else if(typeof window.tliOpenModelManager==='function')window.tliOpenModelManager();
      else if(typeof window.switchPanel==='function')window.switchPanel('panel-settings');
    });
    $('chat-options').addEventListener('toggle',()=>{if($('chat-options').open)optionsFocus=document.activeElement;});
    panel.addEventListener('keydown',e=>{if(e.key==='Escape') {if(!details.hidden){details.hidden=true;$('chat-context-toggle').setAttribute('aria-expanded','false');$('chat-context-toggle').focus();}else if($('chat-options').open){$('chat-options').open=false;optionsFocus?.focus?.();}}});
    window.addEventListener('tli-chat-context-changed',schedule);
    $('chat-input')?.addEventListener('input', schedule);
    $('new-chat-btn')?.addEventListener('click',clearResponse);
    window.addEventListener('tli-conversation-changed',clearResponse);
    const observer=new MutationObserver(records=>{
      // Only relevant containers; summary mutations must not recursively render.
      if(records.some(r=>!summary.contains(r.target)))schedule();
    });
    const lockScreen=$('tli-lock-screen');
    const screenLocked=()=>!!lockScreen && !lockScreen.hidden && lockScreen.getAttribute('aria-hidden')!=='true' && !lockScreen.classList.contains('hidden');
    const watch=()=>{observer.observe($('chat-composer-shell'),{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden']});observer.observe($('chat-output'),{childList:true,subtree:false});};
    const lockObserver=new MutationObserver(()=>{locked=screenLocked();schedule();});
    if(lockScreen)lockObserver.observe(lockScreen,{attributes:true,attributeFilter:['class','hidden','aria-hidden']});
    watch();
    const lock=()=>{locked=true;clearResponse();details.hidden=true;$('chat-context-toggle').setAttribute('aria-expanded','false');$('chat-options').open=false;render();};
    window.addEventListener('tli-session-locked',lock);
    window.addEventListener('pagehide',()=>{lock();observer.disconnect();});
    window.addEventListener('pageshow',event=>{if(event.persisted){locked=screenLocked();watch();render();}});
    window.addEventListener('tli-session-unlocked',()=>{locked=false;render();});
    api.refresh=schedule;
    render();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
