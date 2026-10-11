/* Deliberate next steps. No inference, probes, saves or operation execution. */
(() => {
  'use strict';
  const templates = {
    folder: ['A folder needs attention', 'Describe the access error or organization task.', ['Confirm the exact folder and the computer hosting TLI. Keep the current file draft until you know which location you need.', 'Scan only when ready. Review the listing, missing entries and any permission failures before selecting files.', 'Review exact paths before moving or renaming. Record partial results and inspect an uncertain receipt before another attempt.']],
    space: ['Plan a storage cleanup', 'Describe the storage warning and what must be kept.', ['Choose the exact location in Free Space and explicitly scan it. Record the observation time and incomplete coverage.', 'Identify what must be kept or backed up. Size alone does not establish that a file is disposable.', 'Review individual cleanup paths and a duplicate copy to keep. Trash may still use space; record the actual result before deciding whether another scan is useful.']],
    computer: ['A computer connection needs attention', 'Describe which computer is unreachable and when it last worked.', ['Confirm the computer identity and address. Similar display names do not identify the same computer.', 'Check TLI is running on that computer and review its connection settings. Do not change firewall or trust settings without understanding the target.', 'Choose an available diagnostic with the correct executing host and target. Record the result and observation time.']],
    device: ['A smart device needs attention', 'Describe the physical device and the command or state that did not match.', ['Confirm the device address, registered identity and relay. A friendly name alone may be ambiguous.', 'Review the last reported state and its time. Check power and connectivity before deciding whether another read is useful.', 'If you choose to send a command, review its exact target and inspect the physical outcome separately from the acknowledgement.']],
    routine: ['Review a routine outcome', 'Describe the routine, what you expected and what actually happened.', ['Read the existing per-step receipt before another run. A lost connection can leave a partial or uncertain result.', 'Confirm every registered device and relay. Changed targets need another review; saving or favoriting a routine does not run it.', 'Record which steps succeeded, failed or remain uncertain. Run again only after a deliberate complete-target review.']],
    printer: ['A printer or scanner needs attention', 'Describe the selected device and the missing, queued or failed output.', ['Confirm the selected host printer or scanner and its installed driver. A browser on another computer still uses the TLI host.', 'Review Printer status and the operating-system queue. A submitted job does not establish that paper printed.', 'Record the physical output or download result. Inspect an uncertain job before submitting a duplicate.']],
    usb: ['A removable drive needs attention', 'Name the removable drive and describe what is missing or inaccessible.', ['Confirm the drive label and mount path on the TLI host. Do not assume a reused drive letter is the same device.', 'Use the drive row to prepare Files or Free Space, then explicitly scan the intended location.', 'Record access errors and incomplete coverage. Preserve useful files before considering any reviewed change.']],
    game: ['Compare one game setting', 'Describe the symptom, scene and result you want to compare.', ['Record the game, playing resolution, current setting value and the trial suggested in Game Optimizer.', 'Change one setting yourself and compare the same scene using your own FPS or frame-time display. TLI advice does not measure improvement.', 'Record what you observed and restore the previous value if worse. Use a same-game follow-up to describe the comparison.']],
  };
  function bounded(value, max = 2048, multiline = false) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new Error('The selected context cannot be carried safely. Shorten it or clear the control, then try again.');
    return value.trim();
  }
  function guide(kind, context = '', symptom = '') {
    const row = templates[kind]; if (!row) throw new Error('This checklist is unavailable.');
    const target = bounded(context, 2600), description = bounded(symptom, 1000, true);
    return {format:'tli-troubleshooting-guide', version:1, title:row[0], symptom:[description || row[1], target, 'Prepared from the open workspace. Context is not a fresh observation; choose the affected computer before saving.'].filter(Boolean).join('\n\n'), steps:[...row[2]]};
  }
  function draftText(kind, context = '') {
    const target = bounded(context, 2048);
    if (kind === 'inventory') return 'Draft a read-only script that lists immediate files and their sizes in a folder I choose, with a summary by extension. Ask me to confirm the host OS and exact folder first. Do not recurse, modify files, install dependencies or use the network.' + (target ? '\nExact folder to review: ' + JSON.stringify(target) : '');
    if (kind === 'backup') return 'Help me prepare a backup script. Start with a dry-run plan and ask for the host OS, source folder and a different destination. Show exactly what would be copied, report failures and do not overwrite existing destination files, move or delete sources. Do not execute anything.' + (target ? '\nSource folder to review: ' + JSON.stringify(target) : '');
    if (kind === 'inspect') return 'Inspect this project and explain its entry points, how to run it, and which existing tests cover its main behavior. Read only: do not edit files, install dependencies or execute commands. Identify unknowns and cite the files you used.';
    throw new Error('This starter is unavailable.');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {guide, draftText, bounded, templates};
  if (typeof window === 'undefined') return;
  const $ = id => document.getElementById(id), strips = new Map();
  let locked = false, epoch = 0, review = null, busy = false, returnFocus = null;
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const active = () => document.querySelector('.panel-container.active:not([hidden])')?.id;
  const allowed = () => !locked && !document.hidden && $('tli-lock-screen')?.getAttribute('aria-hidden') !== 'false';
  const host = () => window.TLIUI?.hostIdentity?.get?.().id || window.TLIHostIdentity?.get?.().id || null;
  function notice(message) { const box = $('workflow-status'); if (box) box.textContent = message; }
  function feedback(message, control) { if ($('workflow-dialog')?.open) return notice(message); const strip = control.closest('.workflow-next'); if (!strip) return; let box = strip.querySelector('.workflow-inline-status'); if (!box) { box = node('p', '', 'workflow-inline-status'); box.setAttribute('role','status'); strip.append(box); } box.textContent = message; }
  function button(text, action, cls = 'btn-outline') { const b = node('button', text, cls); b.type = 'button'; b.addEventListener('click', async () => { if (!allowed() || busy && action !== close || b.disabled) return; try { await action(); } catch (error) { if (allowed()) feedback(error.message || 'This next step is unavailable. Your work is unchanged.', b); } }); return b; }
  function context(panel) {
    if (panel === 'panel-files') { const root = bounded($('filesRootInput')?.value); return root ? 'Selected folder: ' + root : ''; }
    if (panel === 'panel-visualizer') { const root = bounded($('visualizerPathInput')?.value); return root ? 'Selected location (not necessarily the retained scan): ' + root : ''; }
    if (panel === 'panel-games') { const game = bounded($('go-game-input')?.value, 120); return game ? 'Game entered: ' + game : ''; }
    if (panel === 'panel-printshop') { const printer = bounded($('ps-printer-select')?.value, 256), scanner = bounded($('ps-scanner-select')?.value, 256); return [printer && 'Selected printer: ' + printer, scanner && 'Selected scanner: ' + scanner].filter(Boolean).join(' · '); }
    if (panel === 'panel-homeauto') { const address = bounded($('shelly-ip-input')?.value, 256), relay = bounded($('shelly-relay-input')?.value, 3); return address ? 'Device address entered: ' + address + (relay ? ' · relay ' + relay : '') : ''; }
    return '';
  }
  function close() { epoch++; review = null; busy = false; if ($('workflow-dialog')?.open) $('workflow-dialog').close(); $('workflow-review')?.replaceChildren(); notice(''); if (allowed() && returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); returnFocus = null; }
  function show(title) { if (!allowed()) return false; close(); returnFocus = document.activeElement; $('workflow-title').textContent = title; $('workflow-review').replaceChildren(); $('workflow-dialog').showModal(); $('workflow-title').focus(); return true; }
  function go(panel) { if (!allowed() || typeof window.switchPanel !== 'function' || !$(panel)) throw new Error('This workspace is unavailable.'); window.switchPanel(panel); if (active() !== panel) throw new Error('Open this workspace with the required access before continuing.'); }
  function settings(category, id) { go('panel-settings'); if (!window.TLISettingsWorkspace?.open) throw new Error('Settings controls are unavailable.'); window.TLISettingsWorkspace.open(category, id); close(); }
  function focusControl(id) { const el = $(id); if (!el) throw new Error('This control is unavailable.'); for (let parent = el; parent && parent !== document.body; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; el.scrollIntoView({block:'center'}); (el.querySelector?.('summary, input, button') || el).focus(); }
  function checklist(kind, panel) {
    const target = context(panel), prepared = guide(kind, target), hostId = host();
    if (!show(prepared.title)) return;
    const token = epoch; review = {kind, target, hostId};
    const content = $('workflow-review');
    content.append(node('p', target || 'No individual target was selected. Choose the affected computer in the problem draft.', 'workflow-context'));
    const label = node('label', null, 'workflow-field'), input = node('textarea'); input.id = 'workflow-symptom'; input.maxLength = 1000; input.rows = 3; input.placeholder = templates[kind][1]; label.append(node('span', 'What happened? (optional)'), input); content.append(label);
    const list = node('ol'); prepared.steps.forEach(text => list.append(node('li', text))); content.append(list, node('p', 'Prepare these steps as an unsaved problem. No check runs, and no observation or device selection is attached.', 'workflow-note'));
    const prepare = button('Prepare unsaved checklist', async () => {
      if (!review || token !== epoch) return;
      if (hostId !== host()) { notice('The connected host changed. Close and review this checklist again.'); return; }
      const value = guide(kind, target, input.value);
      if (!window.TLITroubleshooting?.open || !window.TLITroubleshooting?.prepareGuide) throw new Error('Troubleshooting is unavailable. Your current work is unchanged.');
      busy = true; prepare.disabled = true;
      try {
        await window.TLITroubleshooting.open();
        if (!allowed() || token !== epoch) return;
        if (hostId !== host() || active() !== 'panel-troubleshooting') { notice('The host or workspace changed. Close and review the checklist again. Nothing was prepared.'); return; }
        if (window.TLITroubleshooting.prepareGuide(value) !== true) { notice('Your existing problem draft was kept. Close this review and save or discard that draft before preparing another checklist.'); return; }
        close(); $('troubleshooting-symptom')?.focus();
      } finally { if (token === epoch) { busy = false; prepare.disabled = false; } }
    }, 'btn-primary'); prepare.id = 'workflow-prepare'; content.append(prepare);
  }
  function starter(kind, folder = '') {
    const text = draftText(kind, folder), destination = kind === 'inspect' ? 'panel-builder' : 'panel-scripts', id = kind === 'inspect' ? 'builder-chat-input' : 'scripts-prompt';
    if (!show(kind === 'inspect' ? 'Understand a project' : kind === 'backup' ? 'Plan a folder backup' : 'List files without changing them')) return;
    const token = epoch, hostId = host(), content = $('workflow-review');
    const label = node('label', null, 'workflow-field'), preview = node('textarea', null, 'workflow-draft'); preview.id = 'workflow-draft'; preview.value = text; preview.maxLength = 4000; preview.rows = 8;
    label.append(node('span', 'Edit the request before using it'), preview); content.append(label, node('p', 'This prepares text only. Review the folder, host and generated output before choosing any further action.', 'workflow-note'));
    const prepare = button('Use as an unsent draft', () => {
      if (token !== epoch || hostId !== host()) { notice('The connected host changed. Review this starter again.'); return; }
      const chosen = bounded(preview.value, 4000, true); if (!chosen) { notice('Write a request before preparing the draft.'); return; }
      go(destination); const input = $(id);
      if (!input || input.disabled || input.readOnly) { notice('This editor is unavailable or busy. Your current work was kept.'); return; }
      if (input.value.trim()) { notice('Your existing draft was kept. Close this review to finish or clear it before using a starter.'); return; }
      input.value = chosen; input.dispatchEvent(new Event('input', {bubbles:true})); close(); input.focus(); input.scrollIntoView({block:'center'});
    }, 'btn-primary'); prepare.id = 'workflow-prepare'; content.append(prepare);
  }
  function chooser(kind) {
    if (!show(kind === 'backup' ? 'What do you want to protect?' : 'Choose the tool for the task')) return;
    const box = $('workflow-review');
    const choices = kind === 'backup' ? [
      ['Vault files, notes and secrets', 'Open Vault’s own portable backup controls. Other saved-work archives exclude Vault.', () => { go('panel-vault'); focusControl('vault-backups'); close(); }],
      ['TLI notes, chats and reports', 'Review the archive scope in Saved data & backups.', () => settings('data', 'data-recovery-settings')],
      ['An ordinary folder', 'Prepare a backup-script request. You still choose source, destination and host OS.', () => starter('backup')],
    ] : [
      ['Understand a system or connection', 'Open existing Utilities and choose a measured check before asking AI.', () => { go('panel-tools'); close(); focusControl('tools-select'); }],
      ['Automate a repeatable file task', 'Start with a script draft. Generating text does not execute it.', () => starter('inventory')],
      ['Understand an existing code project', 'Prepare a read-only question for Builder; open the exact project separately.', () => starter('inspect')],
    ];
    for (const [title, description, action] of choices) { const row = node('div', null, 'workflow-choice'); row.append(button(title, action), node('p', description)); box.append(row); }
  }
  const definitions = {
    'panel-files': ['Keep this folder task together', [['Folder checklist', () => checklist('folder','panel-files')], ['Plan a backup', () => starter('backup', bounded($('filesRootInput')?.value))]]],
    'panel-visualizer': ['Decide what to keep before cleanup', [['Cleanup checklist', () => checklist('space','panel-visualizer')], ['Choose a backup', () => chooser('backup')]]],
    'panel-mesh': ['Need help connecting?', [['Connection checklist', () => checklist('computer','panel-mesh')], ['Host connection settings', () => settings('access','settings-section-node-identity')]]],
    'panel-homeauto': ['Continue with these devices', [['Prepare a routine', () => go('panel-automations')], ['Device checklist', () => checklist('device','panel-homeauto')]]],
    'panel-automations': ['An outcome needs a closer look?', [['Review a routine outcome', () => checklist('routine','panel-automations')]]],
    'panel-printshop': ['A job did not finish?', [['Printer / scanner checklist', () => checklist('printer','panel-printshop')]]],
    'panel-devices': ['Keep the queue and physical result together', [['Printer checklist', () => checklist('printer','panel-devices')]]],
    'panel-usb': ['Drive missing or unreadable?', [['Removable-drive checklist', () => checklist('usb','panel-usb')]]],
    'panel-vault': ['Protect the right information', [['Choose a backup', () => chooser('backup')]]],
    'panel-games': ['Compare a trial, then keep what helped', [['Record a settings trial', () => checklist('game','panel-games')], ['Review AI setup', () => settings('ai','settings-section-ai-model')]]],
    'panel-help': ['Not sure which tool fits?', [['Choose a tool', () => chooser('tools')]]],
    'panel-more': ['Start from the job you want to do', [['Choose a tool', () => chooser('tools')]]],
    'panel-builder': ['Before changing an unfamiliar project', [['Prepare an inspection question', () => starter('inspect')], ['Review AI setup', () => settings('ai','settings-section-ai-model')]]],
    'panel-scripts': ['Start with a reviewable request', [['Read-only file inventory', () => starter('inventory')], ['Plan a backup', () => starter('backup')]]],
    'panel-tools': ['Need to keep evidence with a problem?', [['Open problem journal', () => go('panel-troubleshooting')]]],
    'panel-installed-apps': ['Looking for an app that is not installed?', [['Review package sources', () => go('panel-hub')]]],
  };
  function init() {
    if ($('workflow-dialog')) return;
    const dialog = node('dialog', null, 'workflow-dialog'); dialog.id = 'workflow-dialog'; dialog.setAttribute('aria-labelledby','workflow-title');
    const header = node('header'), title = node('h2'); title.id = 'workflow-title'; title.tabIndex = -1; header.append(title, button('Close', close));
    const content = node('div'); content.id = 'workflow-review'; const status = node('p', '', 'workflow-status'); status.id = 'workflow-status'; status.setAttribute('role','status');
    dialog.append(header, content, status); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.addEventListener('close', () => { if (review || busy) close(); });
    for (const [id, [label, actions]] of Object.entries(definitions)) {
      const panel = $(id); if (!panel) continue;
      const strip = node('aside', null, 'workflow-next'); strip.dataset.workflowPanel = id; strip.setAttribute('aria-label','Next steps');
      strip.append(node('span',label,'workflow-next-label')); const links = node('div',null,'workflow-next-actions'); actions.forEach(([name, fn]) => links.append(button(name, fn, 'workflow-link'))); strip.append(links);
      const mount = panel.querySelector('.simplify-subnav') || panel.querySelector('.page-header') || panel.firstElementChild;
      const cleanup = id === 'panel-visualizer' && $('storage-cleanup-review')?.querySelector('.storage-cleanup');
      if (cleanup) cleanup.append(strip); else if (mount) mount.after(strip); else panel.append(strip); strips.set(id,strip);
    }
  }
  window.addEventListener('tli-session-locked', () => { locked = true; close(); strips.forEach(strip => strip.hidden = true); });
  window.addEventListener('tli-session-unlocked', () => { locked = false; strips.forEach(strip => strip.hidden = false); });
  window.addEventListener('pagehide', close);
  window.TLIWorkflowAssistant = {init, close};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
