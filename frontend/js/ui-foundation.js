/* Shared presentation only. Feature controllers remain the owners of data/actions. */
(() => {
  'use strict';
  const groups = ['Main', 'Devices', 'Help', 'More', 'Settings', 'Files & Storage', 'Ask TLI'];
  // Presentation-only hiding: keep the workspace and saved references intact.
  const hiddenPanels = new Set(['panel-homelab']);
  const isPanelHidden = id => hiddenPanels.has(id);
  const rows = [
    ['panel-dashboard2', 'Dashboard', 'compass', 0, 'dashboard home overview narrator narrative health'],
    ['panel-main', 'Ask TLI', 'chat', 0, 'AI Chat main conversation assistant screenshot screen help image'],
    ['panel-files', 'Files', 'folder', 0, 'Files & Storage files file organizer organize folders put files in order tidy downloads'],
    ['panel-visualizer', 'Free Space', 'storage', 0, 'visualizer storage disk treemap cleanup make room disk full running out of space'],
    ['panel-games', 'Game Optimizer', 'game', 0, 'gaming games settings hardware AI optimization fps visuals get ready to play low fps smoother gameplay'],
    ['panel-vault', 'Vault', 'lock', 0, 'encrypted secrets private files'],
    ['panel-homelab', 'HomeLab', 'network', 1, 'homelab home lab infrastructure inventory server proxmox virtual machines containers storage pihole pi-hole dns filtering'],
    ['panel-mesh', 'Computers', 'network', 1, 'mesh peers nodes LAN network'],
    ['panel-homeauto', 'Smart home', 'home', 1, 'home automation shelly relays home assistant integration smart devices'],
    ['panel-automations', 'Routines', 'flow', 1, 'Automations routines triggers actions scenes set the scene lights together'],
    ['panel-companion', 'Connect phone', 'phone', 1, 'phone pair pairing QR iPhone Android mobile secure connection take TLI with me start TLI from phone host helper'],
    ['panel-printshop', 'Printers & scanners', 'printer', 1, 'Print & Scan printshop scan document'],
    ['panel-usb', 'USB drives', 'storage', 1, 'Printers & USB removable storage external drives'],
    ['panel-help', 'Help', 'tools', 2, 'support fix problem troubleshooting manual'],
    ['panel-more', 'More', 'grid', 3, 'advanced installed apps tools creation'],
    ['panel-settings', 'Settings', 'settings', 4, 'preferences appearance security backups classic modern interface layout original UI'],
    ['saved-notes', 'Saved notes', 'note', 6, 'Notes & fixes saved notes notebook household memory setup preferences past fixes', 'shortcut', 'panel-main'],
    ['panel-devices', 'Printer status', 'printer', 1, 'Printers & USB printer queues diagnostics', 'panel', 'panel-printshop'],
    ['panel-tli-chat', 'LAN Messages', 'messages', 1, 'LAN chat TLI chat messaging transfers', 'panel', 'panel-mesh'],
    ['panel-devices-home', 'Devices overview', 'devices', 3, 'Devices home network computers phone printers smart devices', 'panel', 'panel-more'],
    ['panel-troubleshooting', 'Fix a problem', 'tools', 2, 'Troubleshooting problems cases fixes symptoms reports evidence history', 'panel', 'panel-help'],
    ['panel-performance', 'App performance check', 'game', 2, 'Performance & apps slow browser cpu ram obs streaming slow computer app freezing', 'panel', 'panel-help'],
    ['panel-reports', 'Saved reports', 'note', 2, 'diagnostics history device context system checks', 'panel', 'panel-help'],
    ['panel-installed-apps', 'Installed apps', 'grid', 3, 'TLI apps launch applications', 'panel', 'panel-more'],
    ['panel-advanced', 'Advanced tools', 'tools', 3, 'developer tools creation', 'panel', 'panel-more'],
    ['panel-tools', 'Utilities', 'tools', 3, 'tools diagnostics system', 'panel', 'panel-more'],
    ['panel-scripts', 'Scripts', 'code', 3, 'generate backup scripts', 'panel', 'panel-more'],
    ['panel-builder', 'Create', 'build', 3, 'builder coding projects agent create apps', 'panel', 'panel-more'],
    ['panel-hub', 'Package management', 'grid', 3, 'TLI Hub community packages themes presets registry', 'panel', 'panel-more'],
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
    'panel-homelab': ['Bring saved TLI records together, inspect Proxmox and manage a selected Pi-hole client’s filtering groups.', 'Saved inventory and the exact HTTPS addresses and client IP you supply.', 'Refresh overview for saved inventory. Proxmox uses a read-only token; Pi-hole requires an unlocked TLI PIN and an application password.', 'Inventory does not confirm live health. Pi-hole changes require a review; a client pause lasts until explicitly restored. DNS activity may reflect a shared router.'],
    'panel-mesh': ['Connect another TLI computer and review the computer roster.', 'Each computer is identified separately, even when names match.', 'Peers must be reachable. Reported capabilities or installed files do not confirm a running model.', 'Review each computer’s status and time. Phone Companion pairs the native app; Browser satellite connects a browser.'],
    'panel-companion': ['Take your personal AI and conversations to your Android phone.', 'This workspace stays on your computer.', 'Keep this computer awake and your phone on the same home network for setup.', 'Follow Connect phone to prepare this computer, install the app and scan a private pairing code.'],
    'panel-devices': ['Review printers and queues reported by the host.', 'Devices attached to or configured on the TLI host.', 'Printer and scanner support depends on host drivers and the operating system.', 'Refresh inventory, open OS settings or explicitly send a test page. Submission does not confirm physical printing.'],
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
  help['panel-performance'] = help['panel-games'];
  help['panel-games'] = ['Choose a game setting to try and compare your own before and after readings.', 'The game and computer you choose; optional AI advice uses the selected provider.', 'Choose a game and a setting trial. Record readings from your game or overlay; AI advice is optional.', 'Apply the setting yourself, then compare the readings you entered. Keep or undo your change based on the result.'];
  const navigation = rows.filter(([id]) => !isPanelHidden(id)).map(([id, label, icon, group, aliases, kind = 'panel', parent = id]) => {
    const [purpose, target, prerequisites, result] = help[id] || [label === 'Devices' ? 'Your computers, smart devices, printers and phone, in one place.' : 'Choose a task to continue.', 'The target shown in the selected workspace.', 'Each workspace explains its requirements.', 'Opening a destination does not run an action.'];
    return {id, label, icon, group: groups[group], aliases, kind, parent, primary:parent === id && (group === 0 || group === 1), pinnable:parent !== id, purpose, target, prerequisites, result};
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
  function openNotes() { if (window.TLINotebook?.open) { window.switchPanel?.('panel-main'); window.TLINotebook.open(null, {source: 'navigation'}); } }
  function navContents(button, item, mobile = false) {
    button.replaceChildren(icon(item.icon), node('span', item.label, mobile ? 'tli-bn-label' : 'ui-nav-label'));
    button.title = item.label + ' — ' + item.purpose;
  }
  const pinKey = 'tli_navigation_pins_v1';
  let pins = [], retainedHiddenPins = [];
  try {
    const saved = JSON.parse(localStorage.getItem(pinKey) || '[]');
    if (Array.isArray(saved)) {
      retainedHiddenPins = [...new Set(saved.filter(isPanelHidden))];
      pins = [...new Set(saved)].filter(id => navigation.some(n => n.id === id && n.pinnable));
    }
  } catch {}
  const premium = () => document.documentElement?.dataset.experience === 'premium';
  const primaryIds = ['panel-dashboard2', 'panel-main', 'panel-builder', 'panel-files', 'panel-homelab', 'panel-homeauto', 'panel-mesh'].filter(id => !isPanelHidden(id));
  function rootFor(id) {
    if (premium()) {
      if (primaryIds.includes(id)) return id;
      if (['panel-visualizer', 'panel-usb'].includes(id)) return 'panel-files';
      if (id === 'panel-automations') return 'panel-homeauto';
      if (['panel-tli-chat', 'panel-companion'].includes(id)) return 'panel-mesh';
      if (['panel-games', 'panel-vault', 'panel-printshop'].includes(id)) return 'panel-more';
    }
    return navigation.find(n => n.id === id)?.parent || (String(id).startsWith('panel-app-') ? 'panel-more' : id);
  }
  function isActive(target, active) { return target === active || target === rootFor(active); }
  function navButton(item, cls = 'side-nav-button') {
    const button = node('button', null, cls); button.type = 'button';
    if (item.kind === 'panel') button.dataset.panelTarget = item.id;
    else button.addEventListener('click', openNotes);
    navContents(button, item, cls === 'tli-bn-item'); return button;
  }
  function setPinned(id, enabled) {
    if (!navigation.some(n => n.id === id && n.pinnable)) return false;
    pins = enabled ? [...new Set([...pins, id])] : pins.filter(p => p !== id);
    let saved = true;
    try { localStorage.setItem(pinKey, JSON.stringify([...pins, ...retainedHiddenPins])); } catch { saved = false; }
    buildNavigation(); syncNavigation();
    window.dispatchEvent(new CustomEvent('tli:navigation-pins-changed'));
    window.showToast?.(saved ? (enabled ? 'Pinned to your sidebar.' : 'Removed from your sidebar.') : 'Applied for this page. Browser preferences could not be saved.');
    return true;
  }
  function buildNavigation() {
    const nav = document.querySelector('.sidebar-nav'); if (!nav) return;
    const main = node('div', null, 'tli-nav-group simplified-main-nav'); main.setAttribute('aria-label', 'Main destinations');
    (premium() ? primaryIds.map(id => navigation.find(n => n.id === id)) : navigation.filter(n => n.primary)).forEach(item => main.append(navButton(item)));
    const pinned = node('div', null, 'tli-nav-group simplified-pins'); pinned.hidden = !pins.length;
    pinned.append(node('div', 'Pinned', 'sidebar-section-title'));
    pins.forEach(id => { const item = navigation.find(n => n.id === id); if (item && !(premium() && primaryIds.includes(id))) pinned.append(navButton(item)); });
    pinned.hidden = pinned.children.length < 2;
    const secondary = node('div', null, 'tli-nav-settings');
    ['panel-more', 'panel-help', 'panel-settings'].forEach(id => secondary.append(navButton(navigation.find(n => n.id === id))));
    nav.replaceChildren(main, pinned, secondary);
    const bottom = document.querySelector('.tli-bottom-nav'), more = $('tli-bn-more-btn');
    if (bottom && more) {
      const buttons = (premium() ? ['panel-dashboard2', 'panel-main', 'panel-builder', 'panel-homeauto'] : ['panel-dashboard2', 'panel-main', 'panel-files']).map(id => navButton(navigation.find(n => n.id === id), 'tli-bn-item'));
      const dot = $('tli-bn-alert-dot'); more.replaceChildren(icon('more'), node('span', 'More', 'tli-bn-label')); if (dot) more.append(dot);
      bottom.replaceChildren(...buttons, more);
    }
    const grid = document.querySelector('.tli-more-grid');
    if (grid) {
      grid.replaceChildren();
      for (const group of groups) {
        const items = navigation.filter(n => n.group === group);
        if (!items.length) continue;
        grid.append(node('h3', group, 'ui-more-heading'));
        items.forEach(item => {
          const button = navButton(item, 'tli-more-item');
          if (item.kind === 'shortcut') button.addEventListener('click', () => window._tliCloseMoreDrawer?.());
          grid.append(button);
        });
      }
    }
    window.TLILicenseAccess?.refreshUI?.();
  }
  const introductions = {
    'panel-troubleshooting': ['Troubleshooting', 'Keep the problem, what you tried and what helped in one place.'],
    'panel-dashboard2': ['Dashboard', 'Your TLI narrative, recent activity, and connected world.'],
    'panel-files': ['Files', 'Choose the files to organize and review where they will go.'],
    'panel-visualizer': ['Free Space', 'See what uses space on your computer.'],
    'panel-devices-home': ['Devices overview', 'Open a device workspace here or directly from the sidebar.'],
    'panel-homelab': ['HomeLab', 'Your computers, devices and infrastructure, together.'],
    'panel-mesh': ['Computers', 'Your TLI computers, their connections and reported capabilities.'],
    'panel-companion': ['Connect phone', 'Your personal AI, conversations and ideas on Android.'],
    'panel-devices': ['Printers & scanners', 'Review printers and their reported queues.'],
    'panel-homeauto': ['Smart home', 'Your rooms and devices, together.'],
    'panel-tools': ['Utilities', 'Run an existing tool, review its output and choose whether to ask AI.'],
    'panel-games': ['Game Optimizer', 'Try a game setting and compare your own readings. Ask AI for advice if useful.'],
    'panel-performance': ['App performance check', 'Record what an app is doing while the slowdown happens.'],
    'panel-scripts': ['Scripts', 'Generate and review a script. Creating a script does not run it.'],
    'panel-printshop': ['Printers & scanners', 'Choose a printer or scanner connected to the TLI host.'],
    'panel-tli-chat': ['LAN Messages', 'Explicit text conversations between reviewed TLI computers.'],
    'panel-automations': ['Routines', 'Prepare a routine, review its exact targets and run it when you choose.'],
    'panel-hub': ['Package management', 'Manage installed packages and your optional registry connection.'],
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
      if (item.id === 'panel-main' && title) title.textContent = 'Ask TLI';
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
      body.append(list); guide.append(body);
      const storageHelp = item.id === 'panel-visualizer' && document.getElementById('fs-more-tools');
      if (storageHelp) storageHelp.append(guide); else header.after(guide);
    });
    const label = document.querySelector('.device-chip-label'); if (label) label.textContent = 'TLI host';
    const footer = document.querySelector('.sidebar-footer'); if (footer?.firstElementChild) footer.firstElementChild.textContent = 'Connected to';
    if (footer?.lastElementChild) footer.lastElementChild.textContent = 'Your private AI';
    const sidebarLabel = document.querySelector('.sidebar-label'); if (sidebarLabel) sidebarLabel.textContent = 'Your private AI';
    const search = $('tli-search-launcher'); if (search?.firstElementChild && !search.firstElementChild.matches('kbd')) search.firstElementChild.replaceWith(icon('search'));
    renderHostIdentity();
  }
  function renderHostIdentity() {
    const state = window.TLIHostIdentity?.get(), name = state?.name || 'Not confirmed';
    const gameTarget = $('go-target-computer'); if (gameTarget) gameTarget.textContent = 'Computer analyzed: ' + name + (state?.id ? ' (' + state.id + ')' : ' · TLI host identity not fully confirmed');
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
    const heading = $('tli-workspace-title');
    if (heading) heading.textContent = navigation.find(item => item.id === active)?.label || 'TLI';
    document.querySelectorAll('.sidebar-nav [data-panel-target], .tli-bottom-nav [data-panel-target], .tli-more-item[data-panel-target]').forEach(button => {
      const selected = isActive(button.dataset.panelTarget, active);
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    if (event && event.detail?.focus !== false) {
      const title = premium() ? $('tli-workspace-title') : $(active)?.querySelector('[aria-level="1"]');
      if (title && !document.querySelector('dialog[open], #tli-lock-screen:not(.hidden)')) title.focus({preventScroll: true});
    }
  }
  function accessibleOverlays() {
    // Onboarding owns its focus and yields to PIN entry while access is locked.
    const selector = 'dialog, .modal-overlay, #tli-cmd-overlay, #tli-more-drawer, #tli-lock-screen, #chat-history-drawer';
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
      for (const e of states.keys()) if (!e.isConnected) states.delete(e);
    }
    let queued = null;
    const includesOverlay = node => node.nodeType === 1 && (states.has(node) || node.matches(selector) || !!node.querySelector(selector));
    new MutationObserver(records => {
      // Chat, progress and background panels change frequently. Only overlay
      // visibility or the addition/removal of an overlay needs a focus scan.
      // Layout reads belong in the next frame, not in a DOM-mutation microtask.
      const relevant = records.some(record => record.type === 'attributes'
        ? includesOverlay(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(includesOverlay));
      if (relevant && queued === null) queued = requestAnimationFrame(() => { queued = null; scan(); });
    }).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden','class','open','aria-hidden','style']});
    document.addEventListener('keydown', event => {
      // A key can arrive before the scheduled frame after an overlay opens.
      if (queued !== null) { cancelAnimationFrame(queued); queued = null; scan(); }
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
    window.addEventListener('tli:experience-change', () => { buildNavigation(); syncNavigation(); });
  }
  window.addEventListener('tli:host-identity', renderHostIdentity);
  window.addEventListener('tli-session-locked', () => { window.TLIHostIdentity?.setLocked(true); dashboardAccess(true); });
  window.addEventListener('tli-session-unlocked', () => { window.TLIHostIdentity?.setLocked(false); dashboardAccess(false); });
  window.TLIUI = { navigation, isPanelHidden, icon, openNotes, rootFor, isActive, setPinned, getPins: () => [...pins], syncNavigation, hostIdentity: window.TLIHostIdentity };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
