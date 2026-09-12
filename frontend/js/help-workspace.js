/* The standalone guide follows this browser's appearance without loading TLI data. */
(() => {
  let theme = 'emeraldLight';
  try { const saved = JSON.parse(localStorage.getItem('tli_settings') || '{}'); if (typeof saved.defaultTheme === 'string') theme = saved.defaultTheme; } catch {}
  document.documentElement.dataset.helpTone = window.TLIThemes?.resolve(theme).tone || 'light';
})();
