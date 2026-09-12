/* Organize existing Settings controls. No persistence, provider checks or saves. */
(() => {
  'use strict';
  const groups = [
    ['general', 'General', 'Appearance and everyday preferences.'],
    ['ai', 'AI & chat', 'Choose your AI, where it runs and how it replies.'],
    ['access', 'Security & connections', 'Protect access and connect this TLI computer to your network or phone.'],
    ['data', 'Saved data & backups', 'Understand, check and back up your saved information.'],
    ['app', 'App & troubleshooting', 'Updates, licensing and tools for investigating a problem.'],
  ];
  // Search only stable labels and keywords, never saved values, results or credentials.
  const catalog = [
    ['settings-section-appearance', 'general', 'This browser · saves immediately', 'appearance theme color dark light display interface layout classic modern old original'],
    ['settings-section-narrator', 'general', 'TLI host · shared setting', 'narrator quiet balanced detailed warnings notifications alerts'],
    ['settings-section-host-profile', 'general', 'TLI host · explicit save', 'background activity system hardware performance profile lite balanced power'],
    ['settings-section-ai-model', 'ai', 'TLI host', 'local bundled qwen model install download running selected library ram'],
    ['settings-section-chat', 'ai', 'This browser · explicit save', 'chat preferences teaching temperature tokens response length brain'],
    ['settings-section-intelligence', 'ai', 'Browser choices + host settings', 'routing mesh lan cpu memory ai source'],
    ['settings-section-lm-studio', 'ai', 'TLI host · explicit save', 'lm studio external provider server model url'],
    ['settings-section-model-capabilities', 'ai', 'TLI host', 'vision image capabilities provider model support'],
    ['settings-section-search', 'ai', 'This browser · saves on change', 'web online search searxng results receipts internet'],
    ['settings-section-security', 'access', 'TLI host · protected changes', 'security access pin password passphrase vault lock reset'],
    ['settings-section-node-identity', 'access', 'TLI host · explicit save', 'computer name role standalone member host node network'],
    ['settings-section-identity', 'access', 'TLI host · read-only', 'fingerprint public key cryptographic trust identity'],
    ['settings-section-companion', 'access', 'TLI host · reviewed changes', 'companion phone iphone android pair pairing startup https certificate port secure lan'],
      ['settings-section-mcp', 'access', 'TLI host · reviewed local connections', 'mcp model context protocol integration client server tools review invoke local bridge grant revoke'],
    ['settings-section-memory-images', 'data', 'Your account on the TLI host', 'notebook notes memory images retained screenshots delete'],
    ['data-recovery-settings', 'data', 'Your account on the TLI host', 'recovery backup notes notebook chat history diagnostic reports archive password verify saved data'],
    ['settings-browser-data-card', 'data', 'This browser only', 'legacy history browser preferences export import json clear'],
    ['settings-section-updates', 'app', 'TLI host', 'software updates version release manifest url automatic startup'],
    ['settings-section-license', 'app', 'TLI host · explicit save', 'license licence pro key activate subscription'],
    ['debug-settings-card', 'app', 'Current browser session', 'debug logs troubleshooting errors download console'],
  ];
  const make = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
  function init() {
    const panel = document.getElementById('panel-settings');
    if (!panel || panel.dataset.settingsWorkspaceBound) return;
    const layout = panel.querySelector('.main-columns'), card = panel.querySelector('.settings-main-card');
    const search = document.getElementById('settings-search'), searchStatus = document.getElementById('settings-search-status');
    if (!layout || !card || !search || !searchStatus) return;
    panel.dataset.settingsWorkspaceBound = '1'; layout.classList.add('settings-workspace');
    const sidebar = make('aside', null, 'settings-sidebar');
    const nav = make('nav', null, 'settings-category-nav'); nav.id = 'settings-category-nav'; nav.setAttribute('aria-label', 'Settings categories');
    sidebar.append(nav); layout.prepend(sidebar);
    const info = panel.querySelector('.settings-info-card'); if (info) sidebar.append(info);
    const content = make('div', null, 'settings-groups'), sections = new Map(), records = new Map();
    const results = make('div', null, 'settings-search-results'); results.id = 'settings-search-results'; results.hidden = true;
    card.append(results, content);
    let active = 'general', pending = false;
    const clear = document.getElementById('settings-find-clear');
    const companion = make('article', null, 'settings-section'); companion.id = 'settings-section-companion';
    companion.append(make('h3', 'Phone Companion', 'settings-section-title'));
    const companionBody = make('div', null, 'settings-section-body');
    companionBody.append(make('p', 'Connect the native iPhone or Android app, review this host’s secure network setup and manage paired phones.'));
    const companionOpen = make('button', 'Open Phone Companion', 'btn-outline'); companionOpen.type = 'button'; companionOpen.id = 'settings-open-companion';
    function openCompanion() {
      if (window.TLICompanion?.open) return window.TLICompanion.open();
      if (typeof window.switchPanel === 'function') window.switchPanel('panel-companion');
    }
    companionOpen.addEventListener('click', openCompanion); companionBody.append(companionOpen); companion.append(companionBody); card.append(companion);
    for (const [key, title, desc] of groups) {
      const group = make('section', null, 'settings-group'); group.id = 'settings-group-' + key;
      const heading = make('h2', title); heading.id = group.id + '-title'; group.setAttribute('aria-labelledby', heading.id);
      group.append(heading, make('p', desc, 'settings-group-description')); content.append(group); sections.set(key, group);
      const button = make('button', title); button.type = 'button'; button.dataset.settingsCategory = key;
      button.setAttribute('aria-controls', group.id); button.addEventListener('click', () => open(key)); nav.append(button);
    }
    const narrator = make('div', null, 'settings-section'); narrator.id = 'settings-section-narrator';
    const narratorHeader = make('div', null, 'settings-section-header'); narratorHeader.setAttribute('role', 'button'); narratorHeader.tabIndex = 0;
    const narratorNames = make('div'); narratorNames.append(make('div', 'Narrator & alerts', 'settings-section-title'), make('div', 'Control how often TLI reports observed changes.', 'settings-section-subtitle'));
    narratorHeader.append(narratorNames, make('span', '▾', 'settings-section-chevron'));
    const narratorBody = make('div', null, 'settings-section-body');
    narratorBody.append(make('p', 'Choose Quiet, Balanced or Detailed in the existing Dashboard controls. Critical alerts remain visible in every mode.'));
    const narratorButton = make('button', 'Open Narrator settings', 'btn-outline'); narratorButton.type = 'button'; narratorButton.id = 'settings-open-narrator';
    const narratorStatus = make('p', '', 'small-meta'); narratorStatus.setAttribute('role', 'status');
    narratorButton.addEventListener('click', () => {
      const target = document.getElementById('narrator-preferences');
      if (!target) { narratorStatus.textContent = 'Narrator settings are not available in this view. Open the Dashboard to check.'; return; }
      if (typeof window.switchPanel === 'function') window.switchPanel('panel-dashboard2');
      else document.querySelector('[data-panel-target="panel-dashboard2"]')?.click();
      target.open = true; target.scrollIntoView({ block: 'center' }); target.querySelector('summary')?.focus();
    });
    narratorBody.append(narratorButton, narratorStatus); narrator.append(narratorHeader, narratorBody); card.append(narrator);
    const profileRow = document.getElementById('settings-system-profile')?.closest('.settings-row');
    const profileSave = document.getElementById('settings-system-profile-save');
    if (profileRow && profileSave) {
      const profile = make('div', null, 'settings-section collapsed'); profile.id = 'settings-section-host-profile';
      const header = make('div', null, 'settings-section-header'); header.setAttribute('role', 'button'); header.tabIndex = 0;
      const names = make('div'); names.append(make('div', 'Host background activity', 'settings-section-title'), make('div', 'Adjust how much background work the computer hosting TLI performs.', 'settings-section-subtitle'));
      header.append(names, make('span', '▾', 'settings-section-chevron'));
      const body = make('div', null, 'settings-section-body'), buttons = make('div', null, 'button-row');
      body.append(profileRow); const help = document.getElementById('settings-profile-help'); if (help) body.append(help);
      buttons.append(profileSave); body.append(buttons); profile.append(header, body); card.append(profile);
    }
    function titleOf(item) { return item.querySelector('.settings-section-title, .collapsible-header-title, summary')?.textContent.trim() || item.id; }
    function register(row) {
      const [id, category, scope, keywords] = row, item = document.getElementById(id);
      if (!item || !panel.contains(item) || records.has(id)) return;
      const title = titleOf(item);
      item.dataset.settingsItem = id;
      // Preserve all existing controls, handlers, drafts and controller closures.
      sections.get(category).append(item);
      const body = item.querySelector('.settings-section-body, .collapsible-body, .data-recovery-body, .native-companion-body, .tli-int-body');
      if (body) body.prepend(make('p', scope, 'settings-scope-note'));
      const labels = [...item.querySelectorAll('.settings-section-subtitle, .settings-row-title, .field-label')].map(el => el.textContent).join(' ');
      records.set(id, { item, category, title, scope, query: (title + ' ' + keywords + ' ' + labels).toLocaleLowerCase() });
    }
    function collect() {
      pending = false; catalog.forEach(register);
      // Keep future injected settings reachable even before their category is configured.
      for (const item of [...panel.children]) {
        if (item === layout || !item.matches('details, .card, .settings-section')) continue;
        if (!item.id) item.id = 'settings-extra-' + records.size;
        register([item.id, 'app', 'See the controls below for scope', titleOf(item)]);
      }
      window.TLISettingsSections?.refresh?.();
      // Give older unlabeled fields an accessible name without changing their IDs.
      for (const item of records.values()) for (const field of item.item.querySelectorAll('input:not([type=hidden]), select')) {
        if (field.labels?.length || field.hasAttribute('aria-label') || field.hasAttribute('aria-labelledby')) continue;
        const label = field.closest('.settings-row')?.querySelector('.settings-row-title')?.textContent || field.getAttribute('placeholder');
        if (label) field.setAttribute('aria-label', label);
      }
      render();
    }
    function render() {
      const classic = document.documentElement.dataset.interface === 'classic';
      const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      clear.hidden = !words.length; results.hidden = !words.length; content.hidden = !!words.length;
      for (const button of nav.children) { if (!words.length && button.dataset.settingsCategory === active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
      for (const [key, group] of sections) group.hidden = !classic && key !== active;
      results.replaceChildren();
      if (!words.length) { searchStatus.textContent = ''; return; }
      const matches = [...records.values()].filter(record => words.every(word => record.query.includes(word)));
      searchStatus.textContent = matches.length ? matches.length + (matches.length === 1 ? ' setting section found.' : ' setting sections found.') : 'No matching settings. Try a broader term, such as model, PIN or backup.';
      for (const record of matches) {
        const button = make('button', null, 'settings-search-result'); button.type = 'button'; button.dataset.settingsResult = record.item.id;
        button.append(make('strong', record.title), make('span', groups.find(group => group[0] === record.category)[1] + ' · ' + record.scope));
        button.addEventListener('click', () => open(record.category, record.item.id)); results.append(button);
      }
    }
    function open(category, id) {
      if (id === 'native-companion-settings') { openCompanion(); return; }
      if (!sections.has(category)) return;
      active = category; search.value = ''; render();
      if (!id) {
        if (document.documentElement.dataset.interface === 'classic') sections.get(category).scrollIntoView({block:'nearest'});
        return;
      }
      const record = records.get(id); if (!record) return;
      record.item.hidden = false;
      if (record.item.tagName === 'DETAILS') record.item.open = true;
      else if (record.item.classList.contains('settings-section')) record.item.classList.remove('collapsed');
      else {
        const header = record.item.querySelector('.collapsible-header');
        if (header?.getAttribute('aria-expanded') === 'false') header.click();
      }
      const heading = record.item.querySelector('.settings-section-header, .collapsible-header, summary');
      if (heading) { heading.tabIndex = 0; heading.focus({ preventScroll: true }); }
      record.item.scrollIntoView({ block: 'nearest' });
    }
    search.addEventListener('input', render);
    panel.addEventListener('focusin', event => {
      // Remember the last edited category even when the next focus is the
      // header's interface switch, outside this panel.
      const focused = event.target.closest('.settings-group');
      if (focused) active = [...sections].find(([, group]) => group === focused)?.[0] || active;
    });
    function arrangeInterface() {
      // Reorder the same containers so keyboard order follows the visible
      // layout. Keep every field, draft and owning controller in place.
      const classic = document.documentElement.dataset.interface === 'classic';
      if (!classic) {
        const focused = document.activeElement?.closest('.settings-group');
        if (focused) active = [...sections].find(([, group]) => group === focused)?.[0] || active;
      }
      const first = classic ? card : sidebar, second = classic ? sidebar : card;
      if (first.nextElementSibling !== second) layout.insertBefore(first, second);
      render();
    }
    window.addEventListener('tli:interface-change', arrangeInterface);
    clear.addEventListener('click', () => { open(active); search.focus(); });
    search.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); open(active); } });
    window.addEventListener('tli-session-locked', () => { search.value = ''; render(); });
    document.addEventListener('click', event => {
      if (event.target.closest('#tli-upgrade-cta')) open('app', 'settings-section-license');
      if (event.target.closest('#tli-pin-nudge-go') || (event.target.closest('#panel-vault') && event.target.closest('[data-panel-target="panel-settings"]'))) open('access', 'settings-section-security');
    });
    const observer = new MutationObserver(records => {
      if (!records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && !node.closest?.('#settings-search-results') && (node.matches?.('details, .settings-section, .card') || node.querySelector?.('.settings-section'))))) return;
      if (!pending) { pending = true; queueMicrotask(collect); }
    });
    observer.observe(panel, { childList: true, subtree: true });
    window.TLISettingsWorkspace = { open, refresh: collect };
    collect();
    arrangeInterface();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
