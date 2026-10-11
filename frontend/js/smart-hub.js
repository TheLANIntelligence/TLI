/* Home is a launchpad. Feature controllers still own every operation and draft. */
(function (root) {
  'use strict';
  const tasks = [
    {id:'space', panel:'panel-visualizer', icon:'storage', title:'Make room', detail:'See what takes space. Review what can go.', next:'Free Space'},
    {id:'organize', panel:'panel-files', icon:'folder', title:'Put files in order', detail:'Choose a folder, select files, review their new homes.', next:'Files'},
    {id:'game', panel:'panel-games', icon:'game', title:'Get ready to play', detail:'Get settings advice for your PC and your game.', next:'Game Optimizer'},
    {id:'routine', panel:'panel-automations', icon:'flow', title:'Set the scene', detail:'Bring device actions together in a routine.', next:'Routines'},
    {id:'ask', panel:'panel-main', icon:'chat', title:'Think it through', detail:'Ask a question or pick up your conversation.', next:'Ask TLI'},
    {id:'devices', panel:'panel-homeauto', icon:'home', title:'Look after my home', detail:'Find your lights, switches and connected devices.', next:'Smart devices'},
    {id:'phone', panel:'panel-companion', icon:'phone', title:'Take TLI with me', detail:'Connect your phone and review its access.', next:'Phone Companion'},
    {id:'print', panel:'panel-printshop', icon:'printer', title:'Print or scan', detail:'Choose a printer or bring a paper document in.', next:'Printers & scanners'},
    {id:'vault', panel:'panel-vault', icon:'lock', title:'Keep something private', detail:'Open your protected files, notes and secrets.', next:'Vault'},
    {id:'computers', panel:'panel-mesh', icon:'network', title:'Connect my computers', detail:'Check a connection, send a message or transfer a file.', next:'Computers'},
    {id:'help', panel:'panel-troubleshooting', icon:'tools', title:'Work through a problem', detail:'Keep checks, findings and the fix together.', next:'Troubleshooting'},
    {id:'create', panel:'panel-advanced', icon:'build', title:'Make something', detail:'Explore projects, scripts and installed tools.', next:'Advanced tools'}
  ];
  const defaults = ['space','organize','game','routine'];
  function normalize(value) {
    if (!Array.isArray(value)) return [...defaults];
    const result = [...new Set(value.filter(id => tasks.some(task => task.id === id)))].slice(0, 6);
    return result.length ? result : [...defaults];
  }
  const api = {tasks, normalize};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root?.document) return;
  root.TLISmartHub = api;
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const button = (text, cls, action) => { const e = node('button', text, cls); e.type = 'button'; e.addEventListener('click', action); return e; };
  const key = 'tli_home_tasks_v1';
  let locked = false, suspended = false, selected = [...defaults], recent = [], editor, returnFocus;
  function available() { return !locked && !suspended && root.TLIIntelligence?.isCurrent?.() !== false; }
  function open(panel) {
    if (!available()) return false;
    root.switchPanel?.(panel);
    return $(panel)?.hidden === false;
  }
  function load() { try { selected = normalize(JSON.parse(localStorage.getItem(key) || 'null')); } catch (_) { selected = [...defaults]; } }
  function renderTasks() {
    const list = $('home-task-list'); if (!list) return;
    list.replaceChildren();
    for (const id of selected) {
      const task = tasks.find(t => t.id === id);
      const b = button(null, 'home-task', () => { if (open(task.panel) && task.id === 'ask') $('chat-input')?.focus(); });
      b.dataset.homeTask = task.id;
      const icon = root.TLIUI?.icon(task.icon); if (icon) b.append(icon);
      const copy = node('span', null, 'home-task-copy');
      copy.append(node('strong', task.title), node('span', task.detail), node('small', task.next + ' →'));
      b.append(copy); list.append(b);
    }
  }
  function renderRecent() {
    const region = $('home-resume'), list = $('home-recent-list'); if (!region || !list) return;
    list.replaceChildren(); region.hidden = !available() || !recent.length;
    for (const id of recent) {
      const item = root.TLIUI?.navigation.find(n => n.id === id); if (!item) continue;
      const b = button(item.label, 'home-recent-link', () => open(id)); b.dataset.homeRecent = id; list.append(b);
    }
  }
  function closeEditor(restore = true) {
    if (!editor?.open) return;
    editor.close();
    if (restore && returnFocus?.isConnected && available()) returnFocus.focus();
  }
  function customize() {
    if (!available()) return;
    returnFocus = document.activeElement;
    editor.replaceChildren();
    const title = node('h2', 'Make Home yours'); title.id = 'home-edit-title';
    const intro = node('p', 'Choose up to six task shortcuts for this browser. Your sidebar and saved work stay available.');
    const choices = node('fieldset', null, 'home-task-choices'); choices.append(node('legend', 'Home shortcuts'));
    const hint = node('p', '', 'home-edit-status'); hint.setAttribute('role', 'status');
    const inputs = [];
    const count = () => inputs.filter(input => input.checked).length;
    function changed() {
      const n = count(); hint.textContent = n + ' of 6 selected';
      inputs.forEach(input => { input.disabled = n >= 6 && !input.checked; });
      save.disabled = !n;
    }
    for (const task of tasks) {
      const label = node('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = task.id; input.checked = selected.includes(task.id); input.addEventListener('change', changed);
      const copy = node('span'); copy.append(node('strong', task.title), node('small', task.next)); label.append(input, copy); choices.append(label); inputs.push(input);
    }
    const actions = node('div', null, 'home-edit-actions');
    const save = button('Save shortcuts', 'btn-primary', () => {
      if (!available() || !count() || count() > 6) return;
      const next = normalize(inputs.filter(input => input.checked).map(input => input.value));
      try { localStorage.setItem(key, JSON.stringify(next)); }
      catch (_) { hint.textContent = 'This browser could not save your shortcuts. Allow local storage and try again.'; return; }
      selected = next; renderTasks(); closeEditor();
    });
    actions.append(button('Reset choices', 'btn-outline', () => { inputs.forEach(input => { input.checked = defaults.includes(input.value); }); changed(); }), button('Cancel', 'btn-outline', () => closeEditor()), save);
    editor.append(title, intro, choices, hint, actions); changed(); editor.showModal();
  }
  function init() {
    const panel = $('panel-dashboard2'), wrap = panel?.querySelector('.nd-wrap'); if (!wrap) return;
    load();
    const launch = node('section', null, 'home-launchpad'); launch.id = 'home-launchpad'; launch.setAttribute('aria-labelledby', 'home-launch-title');
    const heading = node('div', null, 'home-launch-heading'), copy = node('div');
    const eyebrow = node('p', 'YOUR PRIVATE SMART HUB', 'home-eyebrow');
    const title = node('h2', 'What would you like to do?'); title.id = 'home-launch-title';
    copy.append(eyebrow, title, node('p', 'A little more order. A little more possibility.', 'home-launch-intro'));
    const ask = button('Ask TLI', 'btn-primary home-ask', () => { if (open('panel-main')) $('chat-input')?.focus(); });
    const icon = root.TLIUI?.icon('chat'); if (icon) ask.prepend(icon); heading.append(copy, ask);
    const list = node('div', null, 'home-task-list'); list.id = 'home-task-list';
    const footer = node('div', null, 'home-launch-footer');
    footer.append(node('span', 'Choose a task. TLI takes you to the next step.'), button('Edit shortcuts', 'home-text-button', customize));
    const resume = node('nav', null, 'home-resume'); resume.id = 'home-resume'; resume.hidden = true; resume.setAttribute('aria-label', 'Recently opened workspaces');
    const recentList = node('div', null, 'home-recent-list'); recentList.id = 'home-recent-list';
    resume.append(node('span', 'Back to', 'home-resume-label'), recentList, button('Clear', 'home-text-button', () => { recent = []; renderRecent(); }));
    launch.append(heading, list, footer); $('dashboard-access').after(launch, resume);
    // Keep the original optional action controls and their listeners reachable.
    const shortcuts = panel.querySelector('.nd-shortcuts'), explore = panel.querySelector('.dashboard-explore');
    if (shortcuts && explore) { const summary = shortcuts.querySelector('summary'); if (summary) { summary.id = 'nd-suggested-title'; summary.textContent = 'More ways to use TLI'; } panel.querySelector('.dashboard-secondary-column')?.append(shortcuts); explore.remove(); }
    panel.querySelector('.dashboard-chat-launch')?.remove();
    editor = node('dialog', null, 'home-edit-dialog'); editor.id = 'home-edit-dialog'; editor.setAttribute('aria-labelledby', 'home-edit-title'); document.body.append(editor);
    editor.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
    const vitals = [
      ['ndv-node-val', 'View computers', () => open('panel-mesh')],
      ['ndv-smart-val', 'Open smart devices', () => open('panel-homeauto')],
      ['ndv-ai-val', 'Choose AI', () => { if (available()) root.openModelManager?.(); }]
    ];
    for (const [id, text, action] of vitals) $(id)?.closest('.nd-vital')?.append(button(text + ' →', 'home-vital-link', action));
    renderTasks(); renderRecent();
    document.addEventListener('tli-panel-switched', event => {
      closeEditor(false);
      const id = event.detail?.panelId;
      if (available() && id !== 'panel-dashboard2' && root.TLIUI?.navigation.some(n => n.kind === 'panel' && n.id === id)) recent = [id, ...recent.filter(value => value !== id)].slice(0, 3);
      renderRecent();
    });
    window.addEventListener('tli-session-locked', () => { locked = true; recent = []; closeEditor(false); renderRecent(); });
    window.addEventListener('tli-session-unlocked', () => { locked = false; renderRecent(); });
    window.addEventListener('pagehide', () => { suspended = true; recent = []; closeEditor(false); renderRecent(); });
    window.addEventListener('pageshow', () => { suspended = false; renderRecent(); });
    window.addEventListener('storage', event => { if ((event.key === key || event.key === null) && !editor.open) { load(); renderTasks(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
})(typeof window === 'undefined' ? null : window);
