/* Browser-local presentation. Never reloads a workspace or starts an operation. */
(() => {
  'use strict';
  const key = 'tli_experience_v1';
  let current = 'premium', saved = true;
  try { if (localStorage.getItem(key) === 'legacy') current = 'legacy'; } catch { saved = false; }
  // An explicit activation link changes only this browser's workspace choice.
  // Consume it so later reloads do not override another deliberate selection.
  try {
    if (window.location?.search) {
      const url = new URL(window.location.href);
      if (url.searchParams.get('experience') === 'premium') {
        current = 'premium';
        try { localStorage.setItem(key, current); saved = true; } catch { saved = false; }
        url.searchParams.delete('experience');
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      }
    }
  } catch { /* A restricted History API does not prevent applying the view. */ }
  document.documentElement.dataset.experience = current;
  const get = () => current;
  function sync() {
    const select = document.getElementById('tli-experience-select');
    if (select) select.value = current;
    const legacy = document.getElementById('tli-legacy-interface');
    if (legacy) legacy.hidden = current !== 'legacy';
    const upgrade = document.getElementById('tli-use-new-experience');
    if (upgrade) upgrade.hidden = current !== 'legacy';
    const status = document.getElementById('tli-experience-status');
    if (status) status.textContent = saved ? 'Saved in this browser. Your work stays in place.' : 'Applied for this page. Browser storage is unavailable.';
  }
  function set(value) {
    if (!['premium', 'legacy'].includes(value)) return false;
    const restore = window.TLIInterface?.rememberView?.() || (() => {});
    const changed = value !== current;
    try { localStorage.setItem(key, value); saved = true; } catch { saved = false; }
    current = value;
    document.documentElement.dataset.experience = value;
    sync();
    if (changed) window.dispatchEvent(new CustomEvent('tli:experience-change', {detail: {experience: value}}));
    restore();
    return true;
  }
  window.TLIPresentation = Object.freeze({get, set});
  document.addEventListener('DOMContentLoaded', () => {
    sync();
    document.getElementById('tli-experience-select')?.addEventListener('change', event => set(event.target.value));
    document.getElementById('tli-use-new-experience')?.addEventListener('click', () => set('premium'));
  }, {once: true});
})();
