/* The standalone guide follows this browser's appearance without loading TLI data. */
(() => {
  function sync() { document.documentElement.dataset.helpTone = document.documentElement.dataset.themeTone || 'light'; }
  sync();
  window.addEventListener('tli-theme-applied', sync);
})();
