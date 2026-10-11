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
  const api = { isStatusQuestion, describeNoteMode, markFailure: bubble => bubble?.classList?.add('chat-bubble-error'),
    hasImageDraft: () => typeof _chatImageReading !== 'undefined' && _chatImageReading === true ||
      typeof _chatImageB64 !== 'undefined' && !!_chatImageB64 };
  // Navigation starters prepare text only. Never replace another task's draft,
  // attachment or selected context, and never submit to Chat's action handlers.
  api.prepareDraft = text => {
    if (typeof text !== 'string' || !text.trim() || text.length > 12000 || window.TLIIntelligence?.isCurrent?.() === false) return false;
    const input = document.getElementById('chat-input');
    if (!input) return false;
    const image = document.getElementById('chat-image-preview');
    const selected = [window.TLIIntelligence, window.TLINotebook, window.TLIDocuments, window.TLICaseContext].some(owner => (owner?.describeContext?.() || []).length);
    const pending = document.getElementById('chat-send-btn')?.disabled;
    window.switchPanel?.('panel-main');
    if (input.value.trim() || selected || image && !image.classList.contains('hidden') || pending) {
      window.showToast?.('Your current conversation is ready to continue. Finish or clear its draft and attachments before adding a new starter.', 'info');
      input.focus(); return false;
    }
    input.value = text; input.dispatchEvent(new Event('input', {bubbles:true})); input.focus(); return true;
  };
  // Message presentation is finalized by existing completion/history decorators.
  // Move original controls and receipts, retaining their owners and listeners.
  const presentedMessages = new WeakMap();
  let openMessageMenu = null, messageMenusBound = false, messageMenusLocked = false, messageMenusSuspended = false, nextMessageMenu = 0;
  function closeMessageMenu(restoreFocus = false) {
    const current = openMessageMenu; openMessageMenu = null;
    if (!current) return;
    try {
      if (current.mode === 'popover') current.menu.hidePopover();
      else if (current.menu.open) current.menu.close();
    } catch (_) { /* Already dismissed by the browser. */ }
    current.menu.hidden = true; current.more.setAttribute('aria-expanded', 'false');
    if (restoreFocus && current.more.isConnected) current.more.focus();
  }
  function positionMessageMenu(view) {
    if (!view || openMessageMenu !== view || view.menu.hidden || !view.more.isConnected) return;
    const visual = window.visualViewport;
    const width = visual?.width || window.innerWidth, height = visual?.height || window.innerHeight;
    if (!(width > 0 && height > 0)) return;
    const leftEdge = (visual?.offsetLeft || 0) + 12, topEdge = (visual?.offsetTop || 0) + 12;
    const availableWidth = Math.max(1, width - 24), availableHeight = Math.max(1, height - 24);
    const menuWidth = Math.min(280, availableWidth);
    view.menu.style.width = menuWidth + 'px'; view.menu.style.maxHeight = availableHeight + 'px';
    const anchor = view.more.getBoundingClientRect(), bounds = view.menu.getBoundingClientRect();
    const menuHeight = Math.min(bounds.height, availableHeight);
    const rightEdge = leftEdge + availableWidth, bottomEdge = topEdge + availableHeight;
    const preferredTop = anchor.bottom + 6 + menuHeight <= bottomEdge ? anchor.bottom + 6 : anchor.top - menuHeight - 6;
    view.menu.style.left = Math.max(leftEdge, Math.min(anchor.right - menuWidth, rightEdge - menuWidth)) + 'px';
    view.menu.style.top = Math.max(topEdge, Math.min(preferredTop, bottomEdge - menuHeight)) + 'px';
  }
  function bindMessageMenus() {
    if (messageMenusBound) return;
    messageMenusBound = true;
    document.addEventListener('pointerdown', event => {
      if (!openMessageMenu) return;
      const {menu, more, mode} = openMessageMenu;
      const bounds = mode === 'dialog' && event.target === menu ? menu.getBoundingClientRect() : null;
      const backdrop = bounds && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
      if (backdrop || !menu.contains(event.target) && !more.contains(event.target)) closeMessageMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && openMessageMenu) { event.preventDefault(); closeMessageMenu(true); }
    });
    const dismiss = () => {
      closeMessageMenu();
      document.querySelectorAll('.chat-answer-details[open]').forEach(details => { details.open = false; });
    };
    window.addEventListener('tli-session-locked', () => { messageMenusLocked = true; dismiss(); });
    window.addEventListener('pagehide', () => { messageMenusSuspended = true; dismiss(); });
    window.addEventListener('pageshow', () => { messageMenusSuspended = false; });
    window.addEventListener('tli-session-unlocked', () => { messageMenusLocked = false; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) closeMessageMenu(); });
    document.addEventListener('tli-panel-switched', () => closeMessageMenu());
    window.addEventListener('resize', () => positionMessageMenu(openMessageMenu));
    window.visualViewport?.addEventListener('resize', () => positionMessageMenu(openMessageMenu));
    window.visualViewport?.addEventListener('scroll', () => positionMessageMenu(openMessageMenu));
    document.addEventListener('scroll', event => {
      if (openMessageMenu && event.target !== openMessageMenu.menu && !openMessageMenu.menu.contains(event.target)) closeMessageMenu();
    }, true);
  }
  function presentMessage(bubble) {
    if (messageMenusLocked || messageMenusSuspended || !bubble?.parentNode || !bubble.classList?.contains('chat-bubble') || bubble.classList.contains('chat-bubble-thinking')) return;
    const direct = selector => Array.from(bubble.children).filter(child => child.matches(selector));
    const actions = direct('.memory-message-actions, [data-case-chat-link]');
    const receipts = direct('.memory-context-receipt, .notebook-receipt, .documents-receipt, .case-context-receipt, .screenshot-receipt, .chat-response-timing');
    const tools = direct('.chat-bubble-speak, .chat-bubble-copy');
    const wrapper = bubble.parentElement;
    const meta = wrapper.classList.contains('chat-msg')
      ? Array.from(wrapper.children).find(child => child.matches('.chat-meta')) : null;
    let view = presentedMessages.get(bubble);
    if (!view && !actions.length && !receipts.length && !tools.length && !meta) return;
    if (!view) {
      bindMessageMenus();
      const make = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text) el.textContent = text; return el; };
      const user = bubble.classList.contains('chat-bubble-user');
      const footer = make('div', 'chat-message-footer' + (user ? ' chat-message-footer-user' : ''));
      const toolbar = make('div', 'chat-message-toolbar');
      const more = make('button', 'chat-message-more', 'More'); more.type = 'button'; more.hidden = true;
      more.title = user ? 'More actions for your message' : 'More actions for this reply';
      more.setAttribute('aria-label', more.title); more.setAttribute('aria-expanded', 'false');
      const candidate = make('div', 'chat-message-menu'), mode = typeof candidate.showPopover === 'function' ? 'popover' : 'dialog';
      const menu = mode === 'popover' ? candidate : make('dialog', 'chat-message-menu');
      menu.id = 'chat-message-menu-' + (++nextMessageMenu); menu.hidden = true;
      if (mode === 'popover') { menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'group'); }
      menu.setAttribute('aria-label', 'Message actions'); more.setAttribute('aria-controls', menu.id);
      toolbar.append(more); footer.append(toolbar, menu); bubble.after(footer);
      view = {footer, toolbar, more, menu, mode, menuClose: null, details: null, detailBody: null}; presentedMessages.set(bubble, view);
      if (mode === 'dialog') {
        view.menuClose = make('button', 'chat-message-menu-close', 'Close actions'); view.menuClose.type = 'button';
        view.menuClose.addEventListener('click', () => closeMessageMenu(true)); menu.append(view.menuClose);
        menu.addEventListener('cancel', event => { event.preventDefault(); closeMessageMenu(true); });
        menu.addEventListener('close', () => { if (openMessageMenu === view && !menu.open) closeMessageMenu(); });
      } else menu.addEventListener('toggle', event => { if (event.newState === 'closed' && openMessageMenu === view && !menu.matches(':popover-open')) closeMessageMenu(); });
      more.addEventListener('click', () => {
        if (messageMenusLocked || messageMenusSuspended || document.hidden || !more.isConnected) return;
        const expand = menu.hidden; closeMessageMenu();
        if (expand) {
          menu.hidden = false; more.setAttribute('aria-expanded', 'true'); openMessageMenu = view;
          try { if (mode === 'popover') menu.showPopover(); else menu.showModal(); positionMessageMenu(view); }
          catch (_) { closeMessageMenu(true); }
        }
      });
      // Closing runs before a reviewed action opens its existing dialog or page.
      // Never manufacture a click, request, attachment or saved record here.
      menu.addEventListener('click', event => {
        if (!event.target.closest('button')) return;
        if (messageMenusLocked || messageMenusSuspended || document.hidden || !footer.isConnected) {
          event.preventDefault(); event.stopImmediatePropagation(); closeMessageMenu(); return;
        }
        closeMessageMenu(true);
      }, true);
      toolbar.addEventListener('click', event => {
        if (event.target !== more && event.target.closest('button')) closeMessageMenu();
      });
    }
    if (bubble.nextElementSibling !== view.footer) bubble.after(view.footer);
    for (const control of actions) {
      if (control.matches('.memory-message-actions')) {
        Array.from(control.children).forEach(button => view.menu.insertBefore(button, view.menuClose)); control.remove();
      } else view.menu.insertBefore(control, view.menuClose);
    }
    for (const control of tools) {
      const kind = control.classList.contains('chat-bubble-speak') ? '.chat-bubble-speak' : '.chat-bubble-copy';
      view.toolbar.querySelectorAll(kind).forEach(previous => { if (previous !== control) previous.remove(); });
      view.toolbar.insertBefore(control, view.more);
    }
    if (meta) view.toolbar.append(meta);
    if (receipts.length && !view.details) {
      view.details = document.createElement('details'); view.details.className = 'chat-answer-details';
      const summary = document.createElement('summary'); summary.textContent = bubble.classList.contains('chat-bubble-incomplete') ? 'Response details' : 'Answer details';
      view.detailBody = document.createElement('div'); view.detailBody.className = 'chat-answer-details-body';
      view.details.append(summary, view.detailBody); view.footer.append(view.details);
    }
    for (const receipt of receipts) {
      if (receipt.classList.contains('screenshot-receipt')) {
        // Continue from a newly shared image, never from a retained screenshot.
        Array.from(receipt.children).filter(child => child.tagName === 'BUTTON').forEach(button => {
          button.classList.add('chat-message-continue'); view.toolbar.insertBefore(button, view.more);
        });
      }
      view.detailBody.append(receipt);
    }
    view.more.hidden = view.menu.children.length === (view.menuClose ? 1 : 0);
    view.toolbar.hidden = view.more.hidden && view.toolbar.children.length === 1;
  }
  api.presentMessage = presentMessage;
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
        presentMessage(bubble);
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
    // Keep optional Chat help in Options. Move the original disclosure only.
    const phoneLayout = window.matchMedia('(max-width:768px)');
    let sectionHelp = null;
    function placeSectionHelp() {
      const options = $('chat-options');
      if (!options) return;
      sectionHelp ||= panel.querySelector('.ui-section-help');
      if (!sectionHelp) return;
      if (sectionHelp.parentElement !== options) options.append(sectionHelp);
      schedule();
    }
    phoneLayout.addEventListener('change', placeSectionHelp);
    window.addEventListener('tli:ui-ready', placeSectionHelp);
    let locked = false, pending = false, signature = '', optionsFocus = null;
    placeSectionHelp();
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
    const premium = () => document.documentElement.dataset.experience === 'premium';
    // Presentation changes move the original controls. Their request owners,
    // listeners, checked state and pending-response state remain untouched.
    const placements = new Map();
    const recent = $('recent-chats-list')?.closest('.right-column-card');
    const composer = $('chat-composer-shell'), composerBottom = composer?.querySelector('.chat-composer-bottom');
    const historyTools = node('details', null, 'chat-recent-tools');
    historyTools.append(node('summary', 'Manage'));
    const recentActions = recent?.querySelector('.card-header-actions');
    if (recent) recent.classList.add('chat-recent-work');
    const premiumLabels = [
      [panel.querySelector('.chat-workspace-card > .card-header-row .card-title'), 'Ask TLI'],
      [$('chat-welcome')?.querySelector('p'), 'Think it through. Make something. Or simply ask.'],
      [$('chat-context-toggle'), 'Context & memory'],
      [recent?.querySelector('.card-title'), 'Pick up where you left off'],
    ].filter(([element]) => element).map(([element, text]) => ({element, text, original: element.textContent}));
    const move = (element, destination, before = null) => {
      if (!element || !destination || element.parentNode === destination) return;
      if (!placements.has(element)) {
        const marker = document.createComment('Chat presentation home');
        element.before(marker); placements.set(element, marker);
      }
      destination.insertBefore(element, before);
    };
    let premiumArranged = null;
    function arrangePremium() {
      const enabled = premium();
      if (enabled === premiumArranged) return;
      const focused = document.activeElement;
      const output = $('chat-output'), scroll = output?.scrollTop;
      if (enabled) {
        move($('chat-runtime-button'), composerBottom, composerBottom?.firstChild);
        move($('chat-memory-slot'), details, details.firstChild);
        move($('chat-lan-inference'), details);
        move($('chat-context-toggle'), composerBottom, $('chat-options'));
        move($('screenshot-start'), links);
        move($('tli-connected-tools'), $('chat-options'));
        move(recent, composer?.parentNode);
        if (recentActions) {
          recentActions.append(historyTools);
          move($('conversation-search-open'), recentActions, historyTools);
          move($('recent-chats-refresh'), historyTools);
          move($('recent-chats-clear'), historyTools);
        }
      } else {
        for (const [element, marker] of placements) if (marker.parentNode) marker.after(element);
        historyTools.remove();
      }
      for (const {element, text, original} of premiumLabels) element.textContent = enabled ? text : original;
      premiumArranged = enabled;
      if (focused?.isConnected && focused !== document.body && focused !== document.activeElement) focused.focus({preventScroll:true});
      if (output) output.scrollTop = scroll;
    }
    function arrangeInterface() {
      arrangePremium();
      if (!chips || !starter || !classicStarterHome || !$('chat-starters-slot')) return;
      const classic = !premium() && document.documentElement.dataset.interface === 'classic';
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
    window.addEventListener('tli:experience-change', arrangeInterface);
    function organize() {
      // Move existing controls, never clone inputs/listeners or prepare a request.
      ['.tli-int-chat', '#notebook-selected', '#documents-selected', '#case-context-selected'].forEach(selector => {
        const control = panel.querySelector(selector); if (control && control.parentElement !== details) details.append(control);
      });
      const memory = panel.querySelector('.memory-use-control'), slot = $('chat-memory-slot');
      if (memory && slot && memory.parentElement !== slot) {
        slot.append(memory);
        const help = memory.querySelector('p'); if (help) { help.id = 'chat-memory-help'; $('memory-use-saved')?.setAttribute('aria-describedby', help.id); }
      }
      if (memory) {
        for (const [id, compact, full] of [['memory-use-saved', 'Saved notes', 'Use saved notes'], ['memory-use-history', 'Earlier chat', 'Use earlier conversation']]) {
          const input = $(id), label = input?.closest('label')?.querySelector('span');
          const text = phoneLayout.matches ? compact : full;
          if (label && label.textContent !== text) label.textContent = text;
          if (input?.getAttribute('aria-label') !== full) input?.setAttribute('aria-label', full);
        }
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
