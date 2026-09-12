/* Shared presentation only. Feature controllers remain the owners of data/actions. */
(() => {
  'use strict';
  const groups = ['Everyday', 'Home & network', 'Tools & creation'];
  const rows = [
    ['panel-dashboard2', 'Dashboard', 'compass', 0, 'home overview narrator health'],
    ['panel-main', 'AI Chat', 'chat', 0, 'main conversation assistant'],
    ['saved-notes', 'Notes & fixes', 'note', 0, 'notebook saved notes household memory setup preferences past fixes', 'shortcut'],
    ['panel-troubleshooting', 'Troubleshooting', 'tools', 0, 'problems cases fixes symptoms reports evidence'],
    ['panel-files', 'Files', 'folder', 0, 'file organizer folders'],
    ['panel-visualizer', 'Free Space', 'storage', 0, 'visualizer storage disk treemap cleanup'],
    ['panel-vault', 'Vault', 'lock', 0, 'encrypted secrets private files'],
    ['panel-mesh', 'Computers', 'network', 1, 'mesh peers nodes'],
    ['panel-companion', 'Phone Companion', 'phone', 1, 'phone companion pair pairing QR iPhone Android mobile secure connection'],
    ['panel-devices', 'Printers & USB', 'devices', 1, 'devices peripherals printers removable storage'],
    ['panel-homeauto', 'Smart devices', 'home', 1, 'home automation shelly relays home assistant integration'],
    ['panel-automations', 'Automations', 'flow', 1, 'routines triggers actions'],
    ['panel-tli-chat', 'LAN Messages', 'messages', 1, 'LAN chat TLI chat messaging transfers'],
    ['panel-tools', 'Utilities', 'tools', 2, 'tools diagnostics system'],
    ['panel-printshop', 'Print & Scan', 'printer', 2, 'printshop scanners'],
    ['panel-games', 'Performance & apps', 'game', 2, 'game optimizer games performance advice apps cpu ram obs streaming'],
    ['panel-scripts', 'Scripts', 'code', 2, 'generate backup scripts'],
    ['panel-builder', 'Builder', 'build', 2, 'coding projects agent'],
    ['panel-hub', 'TLI Hub', 'grid', 2, 'apps community packages themes presets'],
    ['panel-settings', 'Settings', 'settings', 3, 'preferences appearance security backups classic modern interface layout original UI'],
  ];
  // This catalogue describes existing workflows; opening help never probes or runs them.
  const help = {
    'panel-troubleshooting': ['Keep a problem, the steps you tried and its supporting evidence together.', 'The account and optional computer explicitly selected for this case.', 'Notes, reports and chat replies remain in their original stores. Changed or removed evidence is labeled.', 'Record steps and their outcomes. Resolved means you confirmed improvement; opening a case runs no checks or actions.'],
    'panel-dashboard2': ['Understand what needs attention and choose the next useful action.', 'The connected TLI host and separately identified computers or devices.', 'Check observation times; host access, AI readiness and system health are separate.', 'Review attention items or open a destination. Recorded activity is not a fresh health check.'],
    'panel-main': ['Ask a question with the context you choose to share.', 'The provider and computer shown in the chat context.', 'AI answers need an available provider. Some status and navigation requests use existing tools.', 'Review the answer and its context receipt. Opening a tool is not completing its work.'],
    'saved-notes': ['Keep setup details, preferences and past fixes so you can refer to them later.', 'Notes saved for the current TLI account on this host.', 'Without PIN protection, local access shares one owner. Vault notes have a separate passphrase.', 'Create a draft, save it explicitly, or select up to four notes for a separate question.'],
    'panel-files': ['Prepare and review changes to files in a chosen folder.', 'The exact folder and host shown in the operation preview.', 'The host needs access to the folder. AI suggestions require available AI and are only advice.', 'Choose folder → prepare changes → review → results. Inspect collisions and partial outcomes.'],
      'panel-visualizer': ['Choose a location, inspect what uses space and review selected files.', 'The exact drive or folder on the TLI host, not the computer running this browser.', 'Choose Scan to start a quick overview, or request a deeper scan. Check the observation time, exclusions and incomplete coverage.', 'Scans and comparisons never delete files. Cleanup needs a separate exact-file review. Files moved to Trash may still occupy disk space.'],
    'panel-vault': ['Keep files, secrets and Vault notes behind a separate passphrase.', 'The Vault for this TLI account on the connected host.', 'Unlock with the Vault passphrase. An access PIN and a Vault passphrase serve different purposes.', 'Upload, retrieve or edit Vault items. Notes & fixes and conversation backups do not include Vault content.'],
    'panel-mesh': ['Connect another TLI computer and review the computer roster.', 'Each computer is identified separately, even when names match.', 'Peers must be reachable. Reported capabilities or installed files do not confirm a running model.', 'Review each computer’s status and time. Phone Companion pairs the native app; Browser satellite connects a browser.'],
    'panel-companion': ['Connect the installed TLI Companion app to this host.', 'This TLI host and the phones you explicitly pair with it.', 'Owner PIN access, HTTPS, LAN access and an address covered by the host certificate.', 'Review connection setup, create a single-use pairing QR, then manage phone access. Opening this page creates no invitation.'],
    'panel-devices': ['Review printers, queues and USB storage reported by the host.', 'Devices attached to or configured on the TLI host.', 'Printer and scanner support depends on host drivers and the operating system.', 'Refresh inventory, open OS settings or explicitly send a test page. Submission does not confirm physical printing.'],
    'panel-homeauto': ['Control registered smart devices with an explicit target.', 'The named device, identifier and relay shown for the action.', 'A supported driver and reachable device are required. Unknown or ambiguous targets do not run.', 'Discover supported devices, review their reported state and choose an action. No matches is different from discovery failure.'],
    'panel-automations': ['Prepare and deliberately run a saved routine.', 'The exact registered devices and relays named in its reviewed steps.', 'Preview every target, save the routine and review the current targets before running it. Automatic triggers are not active in this installation.', 'Saving does not run a routine. Results describe each attempted step and any failure or partial completion.'],
    'panel-tli-chat': ['Send messages and files to a selected TLI recipient.', 'The selected recipient and connection shown in this conversation.', 'The recipient must be reachable. Optional cross-network connections can use an external relay.', 'Check message and transfer status. Retry deliberately after a connection failure.'],
    'panel-tools': ['Answer a specific system or network question using an existing utility.', 'The host, address or path entered in the tool parameters.', 'Available tools depend on the host. Diagnostics to public addresses contact the internet.', 'Run the tool and inspect measured output first. Asking AI to explain it is a separate action.'],
    'panel-printshop': ['Print a document or retrieve a scan from the host.', 'The selected host printer or scanner.', 'The host needs a supported device, driver and access to the selected file.', 'A print result confirms submission, not paper output. A completed scan provides a downloadable file.'],
    'panel-games': ['Record a bounded CPU and memory observation, then review or save the evidence.', 'The computer hosting TLI and the exact app launch selected here.', 'The app must be running and identifiable. AI is needed only when you explicitly request game advice or send a report in Chat.', 'Choose an app → Start 30-second observation → Review → Save if useful. No tuning, FPS measurement or automatic repair.'],
    'panel-scripts': ['Draft a script for a task and review it before use.', 'The operating system, paths and task described in your request.', 'Generation requires an available AI provider. Check commands and paths before running anything.', 'Copy or download the draft. Generating a backup script does not create a backup.'],
    'panel-builder': ['Work on a selected project through tasks, proposed changes and review.', 'The exact project folder opened on the TLI host.', 'Review project permissions and the operation being approved. Commands run with host access.', 'Keep proposed, applied and executed work distinct. Review diffs and receipts; rollback covers its recorded snapshot scope.'],
    'panel-hub': ['Browse packages and inspect what each action will change.', 'The package source and this TLI host or browser.', 'A package listing is not a security review. Read its source and effect before choosing an action.', 'Install a package, apply a theme, change a prompt or explicitly run a script. Sharing on this host is not public publication.'],
    'panel-settings': ['Configure appearance, AI, access and saved-data tools.', 'Each setting identifies whether it applies to this browser, account or host.', 'Some controls require owner access or HTTPS. Startup changes apply after a manual restart.', 'Save the relevant settings. Check reads saved data; Create makes a scoped backup; Verify checks an archive without restoring it.'],
  };
  const navigation = rows.map(([id, label, icon, group, aliases, kind = 'panel']) => {
    const [purpose, target, prerequisites, result] = help[id];
    return {id, label, icon, group: groups[group] || 'Settings', aliases, kind, purpose, target, prerequisites, result};
  });
  const paths = {
    compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6Z"/>',
    chat: '<path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z"/><path d="M7 9h8M7 13h5"/>',
    note: '<path d="M6 3h12v18H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM7 3v18M10 8h5M10 12h5"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z"/>',
    storage: '<path d="M5 3h14l3 13v5H2v-5ZM2 16h20M6 19h.01M10 19h.01"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    network: '<rect x="7" y="2" width="10" height="7" rx="1"/><path d="M12 9v5M5 14h14M5 14v3M19 14v3"/><rect x="1" y="17" width="8" height="5" rx="1"/><rect x="15" y="17" width="8" height="5" rx="1"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/>',
    devices: '<rect x="3" y="3" width="13" height="12" rx="2"/><path d="M9 15v4M5 19h8"/><rect x="18" y="10" width="4" height="11" rx="1"/>',
    home: '<path d="m3 10 9-8 9 8v11h-7v-7h-4v7H3Z"/>',
    flow: '<circle cx="6" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="M6 8v8a3 3 0 0 0 3 3h6M11 5h7v7m-3-3 3 3 3-3"/>',
    messages: '<path d="M3 3h15v11H8l-5 4ZM9 17h7l5 4V9"/>',
    tools: '<path d="m14 6 4-4a6 6 0 0 1-8 8l-7 7a3 3 0 0 0 4 4l7-7a6 6 0 0 0 8-8l-4 4Z"/>',
    printer: '<path d="M6 8V2h12v6M6 17H2V8h20v9h-4M6 14h12v8H6ZM18 11h.01"/>',
    game: '<path d="M7 7h10a4 4 0 0 1 4 4l1 7a2 2 0 0 1-3 2l-4-4H9l-4 4a2 2 0 0 1-3-2l1-7a4 4 0 0 1 4-4ZM6 10v5M3.5 12.5h5M16 11h.01M19 14h.01"/>',
    code: '<path d="m8 5-7 7 7 7m8-14 7 7-7 7M14 2l-4 20"/>',
    build: '<path d="m3 7 9-5 9 5v10l-9 5-9-5ZM3 7l9 5 9-5M12 12v10M7 5l9 5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m10 2-1 3-3 1-3-1-2 4 2 3-1 3 2 4 4-1 2 4h4l1-3 3-1 3 1 2-4-2-3 1-3-2-4-4 1-2-4Z"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    bell: '<path d="M5 10a7 7 0 0 1 14 0v6l2 2H3l2-2ZM9 21h6"/>',
  };
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  function icon(name) { const e = node('span', null, 'ui-icon'); e.setAttribute('aria-hidden', 'true'); e.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.grid}</svg>`; return e; }
  function openNotes() { if (window.TLINotebook?.open) window.TLINotebook.open(null, {source: 'navigation'}); }
  function navContents(button, item, mobile = false) {
    button.replaceChildren(icon(item.icon), node('span', item.label, mobile ? 'tli-bn-label' : 'ui-nav-label'));
    button.title = item.label + ' — ' + item.purpose;
  }
  function buildNavigation() {
    const nav = document.querySelector('.sidebar-nav'); if (!nav) return;
    const old = new Map([...nav.querySelectorAll('[data-panel-target]')].map(b => [b.dataset.panelTarget, b]));
    const sections = new Map();
    for (const [i, name] of groups.entries()) {
      const group = node('details', null, 'tli-nav-group ui-nav-group'); group.open = i === 0;
      group.dataset.uiGroup = name;
      const summary = node('summary', name, 'sidebar-section-title'); summary.id = 'nav-group-' + i;
      group.setAttribute('aria-labelledby', summary.id); group.append(summary); sections.set(name, group);
    }
    const settings = node('div', null, 'tli-nav-settings');
    navigation.forEach(item => {
      let button = old.get(item.id);
      if (item.kind === 'shortcut') { button = node('button', null, 'ui-nav-shortcut'); button.type = 'button'; button.id = 'ui-open-notes'; button.addEventListener('click', openNotes); }
      if (!button && item.kind === 'panel') {
        button = node('button', null, 'side-nav-button'); button.type = 'button'; button.dataset.panelTarget = item.id;
      }
      if (!button) return;
      navContents(button, item);
      (sections.get(item.group) || settings).append(button);
    });
    nav.replaceChildren(...sections.values(), settings);
    const bottom = document.querySelector('.tli-bottom-nav');
    const more = $('tli-bn-more-btn');
    if (bottom && more) {
      const buttons = ['panel-dashboard2', 'panel-main', 'panel-files'].map(id => {
        const item = navigation.find(n => n.id === id);
        const button = bottom.querySelector(`[data-panel-target="${id}"]`) || node('button', null, 'tli-bn-item');
        button.type = 'button'; button.dataset.panelTarget = id; navContents(button, item, true); return button;
      });
      const alertDot = $('tli-bn-alert-dot');
      more.replaceChildren(icon('more'), node('span', 'More', 'tli-bn-label'));
      if (alertDot) more.append(alertDot);
      bottom.replaceChildren(...buttons, more);
    }
    const grid = document.querySelector('.tli-more-grid');
    if (grid) {
      const prior = new Map([...grid.querySelectorAll('[data-panel-target]')].map(b => [b.dataset.panelTarget, b]));
      grid.replaceChildren();
      [...groups, 'Settings'].forEach(name => {
        grid.append(node('h3', name, 'ui-more-heading'));
        navigation.filter(item => item.group === name).forEach(item => {
          const b = prior.get(item.id) || node('button', null, 'tli-more-item'); b.type = 'button';
          if (item.kind === 'panel') b.dataset.panelTarget = item.id;
          else b.addEventListener('click', () => { $('tli-bn-more-btn')?.click(); openNotes(); });
          navContents(b, item); grid.append(b);
        });
      });
    }
  }
  const introductions = {
    'panel-troubleshooting': ['Troubleshooting', 'Keep the problem, what you tried and what helped in one place.'],
    'panel-dashboard2': ['Dashboard', 'Your home, in focus. Pick up where you left off.'],
    'panel-files': ['Files', 'Organize your folders with a clear preview of every change.'],
    'panel-visualizer': ['Free Space', 'Find what is taking up space. Review your choices before cleanup.'],
    'panel-mesh': ['Computers', 'Your TLI computers, their connections and reported capabilities.'],
    'panel-companion': ['Phone Companion', 'Pair the installed TLI Companion app and manage its access to this host.'],
    'panel-devices': ['Printers & USB', 'Printers, queues and removable storage on the TLI host.'],
    'panel-homeauto': ['Smart devices', 'Control registered devices and see which relay each action affects.'],
    'panel-tools': ['Utilities', 'Run an existing tool, review its output and choose whether to ask AI.'],
    'panel-games': ['Performance & apps', 'Observe one app on the TLI host, review CPU and memory, then decide what to try.'],
    'panel-scripts': ['Scripts', 'Generate and review a script. Creating a script does not run it.'],
    'panel-printshop': ['Print & Scan', 'Choose a printer or scanner connected to the TLI host.'],
    'panel-tli-chat': ['LAN Messages', 'Explicit text conversations between reviewed TLI computers.'],
    'panel-automations': ['Automations', 'Prepare a routine, review its exact targets and run it when you choose.'],
    'panel-hub': ['TLI Hub', 'Browse packages, themes and prompt presets for your TLI setup.'],
    'panel-vault': ['Vault', 'Keep private files, secrets and Vault notes behind a separate passphrase.'],
  };
  function headers() {
    navigation.filter(n => n.kind === 'panel').forEach(item => {
      const panel = $(item.id); if (!panel) return;
      let header = panel.querySelector('.page-header');
      let title = header?.querySelector('.page-title');
      if (!header && ['panel-main', 'panel-settings'].includes(item.id)) { header = panel.querySelector('.card-header-row'); title = header?.querySelector('.card-title'); }
      if (!header && item.id === 'panel-builder') { header = panel.querySelector('.builder-header'); title = header?.querySelector('.builder-title'); }
      if (!header) { header = node('div', null, 'page-header'); const names = node('div'); title = node('h2', item.label, 'page-title'); names.append(title); header.append(names); panel.prepend(header); }
      header.classList.add('ui-page-header');
      if (title) { title.id ||= 'ui-title-' + item.id; title.tabIndex = -1; title.setAttribute('role', 'heading'); title.setAttribute('aria-level', '1'); panel.setAttribute('aria-labelledby', title.id); }
      if (introductions[item.id]) {
        if (title) title.textContent = introductions[item.id][0];
        let sub = header.querySelector('.page-subtitle');
        if (!sub) { sub = node('p', null, 'page-subtitle'); (title?.parentNode || header).append(sub); }
        sub.textContent = introductions[item.id][1];
      }
      if (!['panel-main', 'panel-settings', 'panel-builder'].includes(item.id)) {
        const scope = node('p', 'TLI host: checking…', 'ui-target-line'); scope.dataset.uiHost = 'true'; header.after(scope);
      }
      const guide = node('details', null, 'ui-section-help');
      guide.dataset.sectionHelp = item.id;
      guide.append(node('summary', 'About ' + item.label));
      const body = node('div', null, 'ui-section-help-body');
      body.append(node('p', item.purpose));
      const list = node('dl');
      for (const [label, text] of [['Affects', item.target], ['Before you begin', item.prerequisites], ['What to expect', item.result]]) {
        const row = node('div'); row.append(node('dt', label), node('dd', text)); list.append(row);
      }
      body.append(list); guide.append(body); header.after(guide);
    });
    const label = document.querySelector('.device-chip-label'); if (label) label.textContent = 'TLI host';
    const footer = document.querySelector('.sidebar-footer'); if (footer?.firstElementChild) footer.firstElementChild.textContent = 'Connected to';
    if (footer?.lastElementChild) footer.lastElementChild.textContent = 'Your private home console';
    const sidebarLabel = document.querySelector('.sidebar-label'); if (sidebarLabel) sidebarLabel.textContent = 'HOME CONSOLE';
    const search = $('tli-search-launcher'); if (search?.firstElementChild && !search.firstElementChild.matches('kbd')) search.firstElementChild.replaceWith(icon('search'));
    renderHostIdentity();
  }
  function renderHostIdentity() {
    const state = window.TLIHostIdentity?.get(), name = state?.name || 'Not confirmed';
    for (const id of ['device-name-chip', 'footer-device', 'ndv-node-val', 'node-switcher-label']) if ($(id)) $(id).textContent = name;
    document.querySelectorAll('[data-ui-host]').forEach(e => { e.textContent = 'TLI host: ' + name; });
    for (const id of ['visualizer-device-tag', 'tools-device-tag']) if ($(id)) $(id).textContent = 'TLI host: ' + name;
  }
  function dashboardAccess(locked) {
    const panel = $('panel-dashboard2'); if (panel) panel.dataset.access = locked ? 'locked' : 'available';
    const notice = $('dashboard-access'); if (notice) notice.hidden = !locked;
  }
  function dashboard() {
    const wrap = document.querySelector('#panel-dashboard2 .nd-wrap'); if (!wrap) return;
    if ($('nd-attention')) return; // The current Dashboard owns its static reading order.
    const suggested = wrap.querySelector('.nd-suggested-region'); const activity = $('activity-catchup');
    if (suggested && activity) activity.before(suggested);
    const live = wrap.querySelector('.nd-bottom');
    if (live) { const detail = node('details', null, 'ui-live-detail'); detail.append(node('summary', 'Live activity feed')); live.before(detail); detail.append(live); }
    const subtitle = $('ndv-node-val')?.parentNode.querySelector('.nd-vital__label'); if (subtitle) subtitle.textContent = 'TLI host';
  }
  function syncNavigation(event) {
    const active = event?.detail?.panelId || document.querySelector('.panel-container:not([hidden])')?.id;
    const b = document.querySelector(`.sidebar-nav [data-panel-target="${active}"]`);
    if (b?.closest('details')) b.closest('details').open = true;
    if (event && event.detail?.focus !== false) {
      const title = $(active)?.querySelector('[aria-level="1"]');
      if (title && !document.querySelector('dialog[open], #tli-lock-screen:not(.hidden)')) title.focus({preventScroll: true});
    }
  }
  function accessibleOverlays() {
    const selector = 'dialog, .modal-overlay, #tli-cmd-overlay, #tli-more-drawer, #tli-lock-screen, #tli-onboard, #chat-history-drawer';
    const states = new Map(); let lastFocus = document.activeElement;
    document.addEventListener('focusin', e => { lastFocus = e.target; });
    const visible = e => e.isConnected && !e.hidden && !e.classList.contains('hidden') && e.getAttribute('aria-hidden') !== 'true' && (e.tagName !== 'DIALOG' || e.open) && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const controls = e => [...e.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex="0"]')].filter(n => !n.disabled && visible(n));
    function scan() {
      document.querySelectorAll(selector).forEach(e => {
        const open = visible(e), old = states.get(e);
        if (open && !old?.open) {
          states.set(e, {open: true, returnTo: e.contains(lastFocus) ? null : lastFocus});
          if (e.tagName !== 'DIALOG') { e.setAttribute('role', 'dialog'); e.setAttribute('aria-modal', 'true'); }
          if (!e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')) e.setAttribute('aria-label', e.querySelector('h2,h3,.modal-title,.chat-history-drawer-title')?.textContent.trim() || 'TLI dialog');
          if (!e.contains(document.activeElement)) (controls(e)[0] || e).focus({preventScroll: true});
        } else if (!open && old?.open) {
          states.set(e, {...old, open: false});
          const another = [...states].some(([other, s]) => other !== e && s.open && visible(other));
          if (!another && old.returnTo?.isConnected && visible(old.returnTo)) old.returnTo.focus({preventScroll: true});
        }
      });
    }
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; scan(); }); } }).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden','class','open','aria-hidden','style']});
    document.addEventListener('keydown', event => {
      const active = [...states].filter(([e,s]) => s.open && visible(e)).map(([e]) => e).at(-1); if (!active) return;
      if (event.key === 'Tab') { const focusable = controls(active), first = focusable[0], last = focusable.at(-1); if (!first) { event.preventDefault(); return; } if (event.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { event.preventDefault(); first.focus(); } }
      if (event.key === 'Escape' && !event.defaultPrevented && !active.matches('#tli-lock-screen, #tli-onboard')) {
        // Let feature owners decide if closing an operation is currently permitted.
        if (active.tagName === 'DIALOG') return;
        if (active.id === 'tli-more-drawer') { $('tli-bn-more-btn')?.click(); event.preventDefault(); }
        else { const close = active.querySelector('[data-close-modal], .modal-close, #chat-history-close'); if (close) { close.click(); event.preventDefault(); } }
      }
    });
    scan();
  }
  function init() {
    document.body.dataset.tliUi = 'anniversary';
    const brand = $('tli-title-typed'); if (brand) { brand.textContent = brand.dataset.full || 'TheLANIntelligence'; brand.dataset.typed = 'done'; }
    const builderStart = $('builder-backend-pill'); if (builderStart) { builderStart.title = 'Start or recheck Builder AI'; builderStart.setAttribute('aria-label', 'Start or recheck Builder AI'); }
    const main = document.querySelector('main'); if (main) { main.id ||= 'tli-main-content'; main.tabIndex = -1; const skip = node('a', 'Skip to content', 'ui-skip-link'); skip.href = '#' + main.id; document.body.prepend(skip); }
    buildNavigation(); headers(); dashboard(); syncNavigation(); accessibleOverlays();
    $('dashboard-unlock')?.addEventListener('click', () => window.TLIPinLock?.checkAndLock?.());
    window.dispatchEvent(new CustomEvent('tli:ui-ready'));
    document.addEventListener('click', event => {
      if (event.target.closest('[data-open-notes]')) openNotes();
    });
    document.addEventListener('tli-panel-switched', syncNavigation);
  }
  window.addEventListener('tli:host-identity', renderHostIdentity);
  window.addEventListener('tli-session-locked', () => { window.TLIHostIdentity?.setLocked(true); dashboardAccess(true); });
  window.addEventListener('tli-session-unlocked', () => { window.TLIHostIdentity?.setLocked(false); dashboardAccess(false); });
  window.TLIUI = { navigation, icon, openNotes, hostIdentity: window.TLIHostIdentity };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
