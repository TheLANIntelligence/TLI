/* Explicit task handoffs from Ask TLI. Text is copied, never sent or executed. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const destinations = {computer: 'panel-troubleshooting', home: 'panel-homeauto', build: 'panel-builder'};
  let locked = false, suspended = false, busy = false, epoch = 0;
  const host = () => window.TLIUI?.hostIdentity?.get?.().id || window.TLIHostIdentity?.get?.().id || null;
  const allowed = () => !locked && !suspended && !document.hidden &&
    $('tli-lock-screen')?.getAttribute('aria-hidden') !== 'false' && window.TLIIntelligence?.isCurrent?.() !== false;
  function feedback(text, notify = true) {
    const status = $('tli-task-status');
    if (status) { status.textContent = text; status.hidden = !text; }
    if (text && notify) window.showToast?.(text, 'info');
  }
  function hasContext() {
    const image = $('chat-image-preview');
    return window.TLIChatWorkspace?.hasImageDraft?.() || image && !image.classList.contains('hidden') ||
      [window.TLIIntelligence, window.TLINotebook, window.TLIDocuments, window.TLICaseContext]
        .some(owner => (owner?.describeContext?.() || []).length > 0);
  }
  function setBusy(value) {
    busy = value;
    for (const kind of Object.keys(destinations)) if ($('tli-start-' + kind)) $('tli-start-' + kind).disabled = value;
  }
  async function start(kind) {
    if (!destinations[kind] || !allowed() || busy) return false;
    if ($('chat-send-btn')?.disabled) { feedback('Wait for this reply to finish before opening another task.'); return false; }
    const input = $('chat-input'), text = input?.value.trim() || '';
    const transfer = kind !== 'home' && !!text;
    if (transfer && (text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))) {
      feedback('Use up to 4,000 characters for a task brief. Your chat draft is unchanged.'); return false;
    }
    if (transfer && hasContext()) {
      feedback('This draft includes selected context. Finish it in Chat, or remove its attachments and selections before copying the text into another task.'); return false;
    }
    if (typeof window.switchPanel !== 'function' || !$(destinations[kind])) {
      feedback('This workspace is unavailable. Your chat draft is unchanged.'); return false;
    }
    const ticket = ++epoch, hostId = host(), original = input?.value || '';
    const contextTicket = window.TLIIntelligence?.capture?.();
    const current = () => ticket === epoch && allowed() && host() === hostId &&
      window.TLIIntelligence?.isCurrent?.(contextTicket) !== false &&
      $(destinations[kind])?.classList.contains('active') && !$(destinations[kind])?.hidden;
    setBusy(true); feedback('');
    try {
      if (kind === 'computer') {
        if (!window.TLITroubleshooting?.open) throw new Error('Computer help is unavailable. Your draft is unchanged.');
        await window.TLITroubleshooting.open();
      } else {
        window.switchPanel(destinations[kind]);
        if (kind === 'build') {
          if (!window.TLIWebApps?.open) throw new Error('The app workspace is unavailable. Your draft is unchanged.');
          await window.TLIWebApps.open();
        }
      }
      if (!current()) return false;
      if (!transfer) return true;
      if (input.value !== original || hasContext() || $('chat-send-btn')?.disabled) {
        feedback('Your chat draft or context changed while opening this task. Nothing was copied.'); return false;
      }
      const prepared = kind === 'computer' ? window.TLITroubleshooting.prepareRequest?.(text)
        : window.TLIWebApps.prepareRequest?.(text);
      if (prepared !== true) {
        feedback('Your existing task was kept. Finish it or start a new one before copying this request.'); return false;
      }
      feedback('Your request was copied to the selected workspace. The original chat draft is still available.', false);
      return true;
    } catch (error) {
      if (ticket === epoch && allowed()) feedback(error.message || 'This task could not be opened. Your chat draft is unchanged.');
      return false;
    } finally { if (ticket === epoch) setBusy(false); }
  }
  function clear() { epoch++; setBusy(false); const box = $('tli-task-status'); if (box) { box.textContent = ''; box.hidden = true; } }
  window.addEventListener('tli-session-locked', () => { locked = true; clear(); });
  window.addEventListener('tli-session-unlocked', () => { locked = false; });
  window.addEventListener('pagehide', () => { suspended = true; clear(); });
  window.addEventListener('pageshow', () => { suspended = false; });
  window.TLIExperience = {start};
  function init() {
    for (const kind of Object.keys(destinations)) $('tli-start-' + kind)?.addEventListener('click', () => start(kind));
    $('chat-input')?.addEventListener('input', () => { const status = $('tli-task-status'); if (status) { status.textContent = ''; status.hidden = true; } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
