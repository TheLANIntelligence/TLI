/* Existing Automations panel contract; one reviewed routine controller owns requests. */
(() => {
  'use strict';
  window.TLIAutomations = {
    onOpen: () => window.TLIManualRoutines?.onOpen(),
    onClose: () => window.TLIManualRoutines?.onClose(),
  };
})();