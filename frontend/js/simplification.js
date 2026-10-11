/* Navigation composition only. Feature controllers own their drafts and actions. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const make = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const descriptions = {
    'panel-mesh': 'See your TLI computers, check connections, or exchange a message.',
    'panel-homeauto': 'Control lights and switches, and connect supported devices.',
    'panel-automations': 'Save a sequence of device actions and run it when you choose.',
    'panel-companion': 'Connect your phone and manage its access to TLI.',
    'panel-printshop': 'Print a document, scan a page, or check your printers.',
    'panel-usb': 'Open files and inspect space on removable drives.',
    'panel-troubleshooting': 'Describe a problem, choose the affected computer, and find a useful check.',
    'panel-performance': 'Record a slow app, browser, game, or stream and review the readings.',
    'panel-reports': 'Revisit saved diagnostic reports and check the selected device.',
    'panel-tools': 'Run a specific system or network utility and inspect its output.',
    'panel-installed-apps': 'Open the apps already installed on this TLI host.',
    'panel-advanced': 'Coding projects, generated scripts, utilities, and package management.',
    'panel-builder': 'Ask about a project or prepare a code change for review.',
    'panel-scripts': 'Draft, inspect, and export a script for your own shell.',
    'panel-hub': 'Manage existing packages and an optional registry connection.'
  };
  const directories = {
    'panel-devices-home': ['panel-mesh', 'panel-homeauto', 'panel-automations', 'panel-companion', 'panel-printshop', 'panel-usb'],
    'panel-help': ['panel-troubleshooting', 'panel-performance', 'panel-reports'],
    'panel-more': ['panel-vault', 'panel-games', 'panel-automations', 'panel-companion', 'panel-printshop', 'panel-installed-apps', 'panel-advanced', 'panel-devices-home'],
    'panel-advanced': ['panel-builder', 'panel-scripts', 'panel-tools', 'panel-hub']
  };
  function open(id) { return window.switchPanel?.(id); }
  function button(id, label, cls = 'btn-outline') { const b = make('button', label, cls); b.type = 'button'; b.dataset.panelTarget = id; return b; }
  function card(item) {
    const b = button(item.id, null, 'simplify-card');
    b.append(window.TLIUI.icon(item.icon));
    const copy = make('span', null, 'simplify-card-copy'); copy.append(make('strong', item.label), make('span', descriptions[item.id] || item.purpose));
    const arrow = make('span', '↗', 'simplify-card-arrow'); arrow.setAttribute('aria-hidden', 'true');
    b.append(copy, arrow); return b;
  }
  function addSubnav(ids, labels) {
    ids.forEach(id => {
      const panel = $(id); if (!panel || panel.querySelector('.simplify-subnav')) return;
      const nav = make('nav', null, 'simplify-subnav'); nav.setAttribute('aria-label', 'Workspace views');
      ids.forEach((target, index) => {
        const b = button(target, labels[index], 'simplify-tab');
        if (target === id) b.setAttribute('aria-current', 'page'); nav.append(b);
      });
      const header = panel.querySelector('.page-header'); (header || panel.firstElementChild)?.after(nav);
    });
  }
  function updatePins() {
    const pins = window.TLIUI.getPins();
    document.querySelectorAll('[data-pin-destination]').forEach(b => {
      const pinned = pins.includes(b.dataset.pinDestination); b.textContent = pinned ? 'Unpin' : 'Pin'; b.setAttribute('aria-pressed', String(pinned));
      const name = window.TLIUI.navigation.find(n => n.id === b.dataset.pinDestination)?.label || 'destination';
      b.setAttribute('aria-label', (pinned ? 'Unpin ' : 'Pin ') + name + ' from sidebar');
    });
  }
  function workspaceLinks() {
    for (const item of window.TLIUI.navigation) {
      if (!item.pinnable) continue;
      const panel = $(item.id); if (!panel) continue;
      const parent = window.TLIUI.navigation.find(n => n.id === item.parent);
      const bar = make('div', null, 'simplify-workspace-links');
      const advanced = ['panel-builder', 'panel-scripts', 'panel-tools', 'panel-hub'].includes(item.id);
      bar.append(button(advanced ? 'panel-advanced' : parent.id, '‹ ' + (advanced ? 'Advanced tools' : parent.label), 'simplify-back'));
      const pin = make('button', 'Pin', 'simplify-pin'); pin.type = 'button'; pin.dataset.pinDestination = item.id;
      pin.addEventListener('click', () => { window.TLIUI.setPinned(item.id, !window.TLIUI.getPins().includes(item.id)); pin.focus({preventScroll:true}); });
      bar.append(pin); panel.prepend(bar);
    }
    updatePins();
  }
  function sync(event) {
    const active = event?.detail?.panelId || document.querySelector('.panel-container:not([hidden])')?.id;
    document.body.dataset.destination = window.TLIUI.rootFor(active) || '';
    if (active === 'panel-dashboard2') window.TLIRoutineFavorites?.render($('home-routine-favorites'));
    if (active === 'panel-installed-apps') window.TLIApps?.reload?.();
  }
  function init() {
    for (const [id, children] of Object.entries(directories)) {
      const grid = document.querySelector(`[data-destination-grid="${id}"]`); if (!grid) continue;
      children.forEach(child => { const item = window.TLIUI.navigation.find(n => n.id === child); if (item) grid.append(card(item)); });
    }
    const help = $('panel-help');
    const resources = make('div', null, 'simplify-help-links');
    const history = make('button', 'Troubleshooting history', 'btn-outline'); history.type = 'button';
    history.addEventListener('click', () => { open('panel-troubleshooting'); const find = document.querySelector('.troubleshooting-find'); if (find) find.open = true; $('troubleshooting-search')?.focus(); }); resources.append(history);
    const manual = make('a', 'Read the TLI guide', 'btn-outline'); manual.href = '/manual.html'; manual.target = '_blank'; manual.rel = 'noopener'; resources.append(manual); help?.append(resources);
    const noteButton = make('button', 'Saved notes', 'btn-outline'); noteButton.type = 'button'; noteButton.id = 'ui-open-notes'; noteButton.addEventListener('click', () => window.TLIUI.openNotes());
    const chatHeader = $('panel-main')?.querySelector('.ui-page-header'); chatHeader?.append(noteButton);
    const notePin = make('button', 'Pin', 'simplify-pin'); notePin.type = 'button'; notePin.dataset.pinDestination = 'saved-notes';
    notePin.addEventListener('click', () => window.TLIUI.setPinned('saved-notes', !window.TLIUI.getPins().includes('saved-notes'))); chatHeader?.append(notePin);
    addSubnav(['panel-files', 'panel-visualizer'], ['Organize', 'Free Space']);
    addSubnav(['panel-printshop', 'panel-devices'], ['Print & scan', 'Printer status']);
    const computers = $('panel-mesh')?.querySelector('.page-header'); computers?.append(button('panel-tli-chat', 'Messages & files'));
    const messages = $('panel-tli-chat')?.querySelector('.page-header'); messages?.append(button('panel-mesh', 'Computers'));
    const favorites = make('section', null, 'home-routine-favorites'); favorites.id = 'home-routine-favorites';
    const homeMount = $('dashboard-places-mount'); if (homeMount) homeMount.after(favorites);
    $('installed-app-refresh')?.addEventListener('click', () => window.TLIApps?.reload?.());
    const switcher = $('node-switcher'), hostMenu = $('tli-device-popover');
    if (switcher && hostMenu) { const label = make('p', 'Open another TLI computer', 'small-meta'); hostMenu.append(label, switcher); }
    workspaceLinks(); sync();
    window.TLILicenseAccess?.refreshUI?.();
    document.addEventListener('tli-panel-switched', sync);
    window.addEventListener('tli:navigation-pins-changed', updatePins);
  }
  window.TLISimplification = {open, directories};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
})();
