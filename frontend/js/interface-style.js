/* Two presentations of the same application. Never reload, navigate or recreate
   feature controls when changing layout. This preference is independent of themes. */
(() => {
  'use strict';
  const key = 'tli_interface_style';
  const valid = value => value === 'classic' || value === 'modern';
  let current = 'modern', saved = true, ready = false;
  const groupState = new Map();
  try { const value = localStorage.getItem(key); if (valid(value)) current = value; }
  catch { saved = false; }
  document.documentElement.dataset.interface = current;

  function rememberView() {
    const focus = document.activeElement;
    let selection;
    try { if (typeof focus?.selectionStart === 'number') selection = [focus.selectionStart, focus.selectionEnd, focus.selectionDirection]; } catch {}
    const scrolls = [...document.querySelectorAll('.main-scroll, .sidebar, #chat-output, #chat-history-list')].map(el => {
      const box = el.getBoundingClientRect();
      const children = el.matches('.main-scroll')
        ? el.querySelectorAll('.panel-container.active .card-title, .panel-container.active h2, .panel-container.active .settings-section')
        : el.children;
      const anchor = [...children].find(child => { const rect = child.getBoundingClientRect(); return rect.height && rect.top >= box.top && rect.top < box.bottom; });
      return {el, top:el.scrollTop, left:el.scrollLeft, end:el.id === 'chat-output' && el.scrollHeight > el.clientHeight && el.scrollHeight - el.clientHeight - el.scrollTop < 3,
        anchor, offset:anchor ? anchor.getBoundingClientRect().top - box.top : 0};
    });
    return () => {
      // Moving existing containers can blur their active input. Restore the same
      // element and selection without opening a panel or stealing modal focus.
      if (focus?.isConnected && focus !== document.body && focus.getClientRects().length) {
        if (document.activeElement !== focus) focus.focus({preventScroll:true});
        try { if (selection) focus.setSelectionRange(...selection); } catch {}
      }
      for (const {el, top, left, end, anchor, offset} of scrolls) {
        if (end) el.scrollTop = el.scrollHeight;
        else if (anchor?.getClientRects().length) el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
        else el.scrollTop = top;
        el.scrollLeft = left;
      }
    };
  }

  function navigation() {
    for (const group of document.querySelectorAll('.sidebar .tli-nav-group')) {
      const summary = group.querySelector('summary');
      if (current === 'classic') {
        if (!groupState.has(group)) groupState.set(group, {open:group.open, tab:summary?.getAttribute('tabindex')});
        group.open = true;
        summary?.setAttribute('aria-disabled', 'true');
        summary?.setAttribute('tabindex', '-1');
      } else if (groupState.has(group)) {
        const previous = groupState.get(group);
        group.open = previous.open || !!group.querySelector('[aria-current="page"]') || group.contains(document.activeElement);
        summary?.removeAttribute('aria-disabled');
        if (previous.tab == null) summary?.removeAttribute('tabindex'); else summary?.setAttribute('tabindex', previous.tab);
        groupState.delete(group);
      }
    }
  }
  function sync(announce = false) {
    const select = document.getElementById('tli-interface-select'); if (select) select.value = current;
    for (const input of document.querySelectorAll('input[name="tli-interface-style"]')) input.checked = input.value === current;
    const text = (current === 'classic' ? 'Classic UI' : 'Modern UI') + (saved ? ' · Saved in this browser.' : ' · Applied for this page. Browser storage is unavailable; this choice may not survive a reload.');
    const status = document.getElementById('tli-interface-status'); if (status) status.textContent = text;
    const notice = document.getElementById('tli-interface-notice'); if (notice && announce) notice.textContent = text;
  }
  function set(value) {
    if (!valid(value)) return false;
    const restore = ready ? rememberView() : () => {};
    const changed = current !== value; current = value;
    try { localStorage.setItem(key, value); saved = true; } catch { saved = false; }
    document.documentElement.dataset.interface = current;
    if (ready) {
      navigation(); sync(true);
      if (changed) window.dispatchEvent(new CustomEvent('tli:interface-change', {detail:{interface:current}}));
      restore();
    }
    return true;
  }
  window.TLIInterface = Object.freeze({get:() => current, set});
  // The early head script can initialize before the shell constructs its rail.
  // Reconcile once that owner has finished; persisted Classic must expose every
  // group on first load as well as after an explicit switch.
  window.addEventListener('tli:ui-ready', navigation, {once:true});
  function init() {
    if (ready) return; ready = true;
    navigation(); sync();
    document.getElementById('tli-interface-select')?.addEventListener('change', event => set(event.target.value));
    for (const input of document.querySelectorAll('input[name="tli-interface-style"]')) input.addEventListener('change', () => { if (input.checked) set(input.value); });
    // Classic's navigation is a flat, always-open rail. Modern remembers its
    // collapsed groups. These handlers never handle feature/action buttons.
    document.addEventListener('click', event => { if (current === 'classic' && event.target.closest('.sidebar .tli-nav-group > summary')) event.preventDefault(); });
    document.addEventListener('keydown', event => { if (current === 'classic' && ['Enter',' '].includes(event.key) && event.target.matches('.sidebar .tli-nav-group > summary')) event.preventDefault(); });
  }
  // Bind controls when the document exists. The shell readiness event above
  // handles its later-created navigation without timers or repeated scans.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => queueMicrotask(init), {once:true}); else init();
})();
