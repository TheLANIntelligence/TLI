/* Compatibility entry points. Smart devices links to the single manual-routine workspace. */
(() => {
  'use strict';
  function open() {
    if (typeof window.switchPanel === 'function') window.switchPanel('panel-automations');
    else window.TLIManualRoutines?.onOpen();
  }
  function setup() {
    const host = document.querySelector('#panel-homeauto .page-header');
    if (!host || document.getElementById('uae-open-routines')) return;
    const button = document.createElement('button'); button.id = 'uae-open-routines'; button.type = 'button'; button.className = 'btn-outline'; button.textContent = 'Manual routines';
    button.addEventListener('click', open); host.append(button);
  }
  window.TLIHomeAutoActions = { setup, onOpen: setup, loadDevices: open,
    refreshActions: () => window.TLIManualRoutines?.refresh(), refreshReceipts: () => window.TLIManualRoutines?.refresh() };
})();