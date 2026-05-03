// sw-init.js — Unregister stale service workers so fresh files load immediately.
// Loaded as the first <script> in index.html (replaces the inline block).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (regs) {
    regs.forEach(function (r) { r.unregister(); });
  });
}
