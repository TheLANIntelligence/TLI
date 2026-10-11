/* Fixed LAN handoff only. Never fetches, redeems, persists or logs an invitation. */
(() => {
  'use strict';
  let invitation = null, failure = '', paint = null;
  function acceptIncoming() {
    const entry = new URL(location.href);
    let fragment = entry.hash.slice(1);
    invitation = null; failure = '';
    try { history.replaceState(null, '', location.pathname); }
    catch (_) { fragment = ''; failure = 'Open TLI Companion and scan a fresh code inside the app.'; }
    try {
    const url = entry, fields = new URLSearchParams(fragment), keys = [...fields.keys()];
    const expected = ['v', 'c', 't', 'e', 'i', 'n'];
    const parts = url.hostname.split('.').map(Number), [a,b] = parts;
    const local = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && parts.every(n=>n>=0&&n<=255) && (a===10 || a===172&&b>=16&&b<=31 || a===192&&b===168 || a===169&&b===254);
    const certificate = fields.get('c') || '', token = fields.get('t') || '', id = fields.get('i') || '', name = fields.get('n') || '', expiry = fields.get('e') || '';
    if (fragment.length > 18000 || /%(?![0-9a-f]{2})/i.test(fragment) || url.protocol !== 'https:' || !local || url.username || url.password || url.search || url.pathname !== '/api/companion/v1/pair' || keys.length !== expected.length || new Set(keys).size !== keys.length || keys.some(key=>!expected.includes(key)) || fields.get('v') !== '1' || !/^[A-Za-z0-9_-]{128,12000}$/.test(certificate) || certificate.length%4===1 || !/^[A-Za-z0-9_-]{20,256}$/.test(token) || !id || id.length>256 || !name.trim() || name.length>256 || /[\u0000-\u001f\u007f]/.test(id+name) || !/^\d{1,12}$/.test(expiry) || Number(expiry)*1000<=Date.now() || Number(expiry)*1000>Date.now()+600000) throw new Error();
    fields.set('o', url.origin);
    invitation = { fragment: fields.toString(), origin: url.origin, name, expires: Number(expiry)*1000 };
    } catch (_) { failure = failure || 'This invitation is missing, invalid or expired. Create a fresh pairing code on your TLI desktop.'; }
    fragment = '';
    entry.hash = ''; entry.search = '';
  }
  acceptIncoming();
  // Camera apps may reuse an open browser tab with a fragment-only navigation.
  // Stage that fresh invitation and remove its URL payload just as on cold load.
  window.addEventListener('hashchange', () => { acceptIncoming(); if (paint) paint(); });
  document.addEventListener('DOMContentLoaded', () => {
    const status = document.getElementById('pair-link-status'), host = document.getElementById('pair-link-host');
    const beta = document.getElementById('pair-open-beta'), app = document.getElementById('pair-open-app');
    const clear = message => { invitation = null; beta.disabled = app.disabled = true; host.textContent = ''; status.textContent = message; };
    let expiryTimer = null;
    paint = () => {
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      if (!invitation) { clear(failure); return; }
      status.textContent = 'Open your installed app to review this invitation. Nothing has been paired yet.';
      host.textContent = invitation.name + ' · ' + invitation.origin;
      beta.disabled = app.disabled = false;
      expiryTimer = setTimeout(() => clear('This invitation has expired. Create a fresh code on your TLI desktop.'), Math.max(0, invitation.expires-Date.now()));
    };
    paint();
    for (const [button,scheme] of [[beta,'tli-companion-beta'],[app,'tli-companion']]) button.addEventListener('click', () => {
      if (!invitation || Date.now()>=invitation.expires) { clear('This invitation has expired. Create a fresh code on your TLI desktop.'); return; }
      location.href = scheme + ':///pair#' + invitation.fragment;
    });
    window.addEventListener('pagehide', () => clear('Invitation cleared from this page. Continue in the app, or scan a fresh code.'), {once:true});
  }, {once:true});
})();
