/* Composes existing controls; every action stays with its existing owner. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  function init() {
    const slots = new Map();
    function move(el, target, before = null) {
      if (!el || !target) return;
      if (!slots.has(el)) { const anchor = document.createComment('Presentation home'); el.before(anchor); slots.set(el, anchor); }
      target.insertBefore(el, before);
    }
    const system = document.createElement('details'); system.className = 'premium-system-details';
    const summary = document.createElement('summary'); summary.textContent = 'Host readings'; system.append(summary);
    $('tli-device-popover')?.append(system);
    const helpSlots = [];
    for (const panel of document.querySelectorAll('.panel-container')) {
      const guide = panel.querySelector('.ui-section-help');
      const strip = panel.querySelector('.workflow-next');
      if ((!guide && !strip) || panel.id === 'panel-main') continue;
      const detail = guide || document.createElement('details');
      if (!guide) {
        const label = document.createElement('summary'); label.textContent = 'More ways to use this workspace'; detail.append(label);
        panel.append(detail);
      }
      detail.classList.add('premium-panel-details');
      helpSlots.push({guide, strip, detail, panel});
    }
    function compose() {
      const premium = document.documentElement.dataset.experience === 'premium';
      if (premium) {
        move(document.querySelector('.tli-device-menu'), document.querySelector('.header-right'));
        move($('ai-source-pill'), $('tli-device-popover'));
        move($('tli-state-bar'), system);
        move($('ui-open-notes'), $('chat-options'));
        move($('panel-main')?.querySelector('[data-pin-destination="saved-notes"]'), $('chat-options'));
        const dashboard = $('panel-dashboard2')?.querySelector('.nd-wrap');
        const workspace = dashboard?.querySelector('.dashboard-workspace-grid') || null;
        move($('home-launchpad'), dashboard, workspace);
        move($('home-resume'), dashboard, workspace);
        for (const {guide, strip, detail, panel} of helpSlots) { detail.hidden = false; if (guide) move(guide, panel); move(strip, detail); }
        const lock = $('tli-lock-btn'); if (lock && !lock.querySelector('svg')) lock.replaceChildren(window.TLIUI.icon('lock'));
      } else {
        // Restore exact nodes, preserving the controls, callbacks and values.
        for (const [el, anchor] of slots) if (anchor.parentNode) anchor.after(el);
        for (const {guide, detail} of helpSlots) if (!guide) detail.hidden = true;
      }
      system.hidden = !premium;
    }
    compose();
    window.addEventListener('tli:experience-change', compose);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
})();
