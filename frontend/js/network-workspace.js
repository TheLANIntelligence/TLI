/* Presentation and navigation for existing network/specialist panels. No requests. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
  const copy = (selector, value) => { const el = document.querySelector(selector); if (el) el.textContent = value; };
  function init() {
    if (window.TLINetworkWorkspace) return;
    window.TLINetworkWorkspace = { ready: true };
    const home = byId('panel-homeauto'), strip = home?.querySelector('.sha-add-strip');
    if (home && strip) {
      const dialog = node('dialog', null, 'network-device-dialog'); dialog.id = 'smart-device-dialog'; dialog.setAttribute('aria-labelledby', 'smart-device-heading');
      const heading = node('h2', 'Add or check a Shelly device'); heading.id = 'smart-device-heading';
      const close = node('button', 'Close', 'btn-outline'); close.type = 'button';
      close.addEventListener('click', () => dialog.close());
      const header = node('div', null, 'network-dialog-header'); header.append(heading, close);
      dialog.append(header, node('p', 'Use the address of a Shelly device on the TLI host’s network. Choose its relay explicitly; different relays at one address are separate targets.'));
      dialog.append(strip); document.body.append(dialog);
      byId('shelly-ip-input')?.setAttribute('aria-label', 'Shelly IP address or hostname');
      byId('shelly-name-input')?.setAttribute('aria-label', 'Device name (optional)');
      const open = node('button', 'Add device', 'btn-primary'); open.id = 'smart-device-open'; open.type = 'button';
      open.addEventListener('click', () => { if (!dialog.open) dialog.showModal(); byId('shelly-ip-input')?.focus(); });
      home.querySelector('.page-header')?.append(open);
      window.addEventListener('tli-session-locked', () => { if (dialog.open) dialog.close(); });
    }
    const fed = byId('fed-chat-card');
    if (fed) {
      const right = fed.nextElementSibling;
      const disclosure = node('details', null, 'network-federation'); disclosure.id = 'network-federation';
      disclosure.append(node('summary', 'Across networks · optional'), node('p', 'This uses the configured relay to connect separate networks. It is separate from local LAN messaging.'));
      fed.before(disclosure); disclosure.append(fed);
      if (right && !right.classList.contains('card')) right.append(disclosure);
    }
    copy('#panel-mesh .mcd-title', 'Connected TLI computers');
    copy('#panel-mesh .mcd-subtitle', 'Reported health of the TLI host and known peers. Missing information stays unknown.');
    copy('#panel-homeauto .page-title', 'Smart home');
    copy('#panel-homeauto .page-subtitle', 'Your rooms, your devices. Connected directly over your network.');
    copy('#shelly-refresh-all-btn', 'Refresh states');
    copy('#panel-tli-chat .tli-chat-titleblock .card-subtitle', 'LAN messages and reviewed file offers between trusted TLI computers. Each file needs receiver consent, is verified into an encrypted TLI Inbox, and is downloaded separately.');
    copy('#panel-tli-chat .tli-transfers-card .card-title', 'Historical downloads');
    copy('#panel-tli-chat .tli-transfers-card .card-subtitle', 'Older download requests. Use Encrypted file Inbox for new reviewed transfers.');
    copy('#panel-tli-chat .tli-empty-title', 'No historical downloads');
    copy('#panel-tli-chat .tli-empty-sub', 'Use Encrypted file Inbox for new reviewed transfers.');
    const discovery = document.querySelector('#panel-tli-chat .info-list');
    if (discovery) { discovery.replaceChildren(...['Discovered computer names and addresses need a separate identity and HTTPS trust review.', 'A computer can remain listed while its current connection is unavailable.', 'Both computers review text-message permission. Failed delivery keeps the draft and offers a deliberate retry.'].map(text => node('li', text))); }
    copy('#shelly-discover-btn', 'Find Shelly devices');
    copy('#panel-automations .page-subtitle', 'Build a manual routine, review its exact targets and choose when to run it.');
    for (const id of ['ps-print-status', 'ps-scan-status', 'devices-printers-summary']) byId(id)?.setAttribute('role', 'status');
    copy('#panel-tools .card-title', 'Utilities');
    copy('#panel-tools .card-subtitle', 'Run an existing tool on the TLI host, review its output, then ask AI for an explanation if useful.');
    copy('#tools-output > .card-title', 'Tool result');
    copy('#tools-output > .card-subtitle', 'Execution result and optional AI interpretation are separate.');
    copy('#panel-scripts .card-title', 'Generate a script');
    copy('#panel-scripts .card-subtitle', 'Ask AI to draft code. Review the result before running it in your own shell; generation does not execute the script.');
    copy('#scripts-preset-backup-folder', 'Draft folder backup script');
    copy('#scripts-preset-backup-docs', 'Draft document backup script');
    copy('#scripts-preset-backup-media', 'Draft photo & media backup script');
    copy('#panel-hub .hub-subtitle', 'Manage optional themes, prompts, scripts, routine packages and apps.');
    copy('#hub-tabs [data-type="ai_preset"]', 'Prompt presets');
    copy('#hub-tabs [data-type="publish"]', 'Share on this host');
    copy('#hub-settings-drawer .hub-settings-note', 'When enabled, TLI requests the package registry from the address above. A remote registry receives that network request. Your conversations and notes are not included. You can use a registry hosted on your own network.');
    const note = node('p', 'Installing adds a package to the host. Applying a theme, using a prompt preset, running a script and publishing to your host registry are separate actions.', 'network-hub-note');
    byId('hub-tabs')?.before(note);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
