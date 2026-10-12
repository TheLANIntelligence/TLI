/* Read-only uninstall guidance. Removal always takes place on the host computer. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
  function init() {
    const button = $('tli-uninstall-show'), guide = $('tli-uninstall-guide'), status = $('tli-uninstall-status');
    if (!button || !guide || !status || button.dataset.bound) return;
    button.dataset.bound = '1';
    let locked = false, epoch = 0, pending = null;
    const backupButtons = [$('tli-uninstall-saved-work'), $('tli-uninstall-vault')];
    function reset(message) {
      epoch++; pending?.abort(); pending = null;
      guide.replaceChildren(); guide.hidden = true;
      button.disabled = locked; button.textContent = 'Show uninstall steps'; button.setAttribute('aria-expanded', 'false');
      backupButtons.forEach(el => { if (el) el.disabled = locked; });
      status.textContent = message;
    }
    function render(info) {
      guide.replaceChildren();
      guide.append(node('h3', 'On the computer hosting TLI'));
      const path = node('p', 'Installation folder: '); path.append(node('code', info.installation_path)); guide.append(path);
      const steps = node('ol');
      if (info.platform === 'Windows' && info.supported && info.entrypoint) {
        if (info.registered) steps.append(node('li', 'Open Windows Settings → Apps → Installed apps (Apps & features on older Windows), search for TLI, choose the entry matching this installation folder, then choose Uninstall. You can also use Start → TLI → Uninstall TLI.'));
        else steps.append(node('li', 'Open this installation folder in File Explorer, then double-click Uninstall_TLI.bat.'));
        const entry = node('li', info.registered ? 'Alternatively, run this file from the installation folder: ' : 'Uninstaller for this installation: ');
        entry.append(node('code', info.entrypoint)); steps.append(entry);
        steps.append(node('li', 'Finish your work and quit TLI before confirming removal. Other browsers and connected phones will disconnect. Follow the uninstaller’s checks if TLI is still running.'));
        steps.append(node('li', 'Choose “Remove Windows entries and keep all files” to remove TLI’s Windows registration and shortcuts while retaining the installation and its saved data. Choose full removal to permanently delete this installation folder, including saved data and downloaded models inside it.'));
        steps.append(node('li', 'Review the folder and removal choice in the uninstaller, then confirm there. Closing this browser does not uninstall TLI.'));
      } else {
        guide.append(node('p', 'Automatic removal is unavailable for this installation.' + (typeof info.reason === 'string' && info.reason ? ' ' + info.reason : '')));
        steps.append(node('li', 'Finish your work and quit the TLI host. If you started it from a terminal, stop that process. Closing this browser leaves the host running.'));
        steps.append(node('li', 'After backing up, review the installation folder above on the host computer. Remove its files manually only when you are ready to permanently lose the saved data and models inside it. For a source checkout, preserve any work you want to keep.'));
        steps.append(node('li', 'Remove any TLI shortcuts or startup entries you added for this installation.'));
      }
      guide.append(steps);
      guide.append(node('p', 'External files, models stored elsewhere, LM Studio or other providers, Python and the Microsoft Visual C++ runtime are separate. TLI removal leaves them in place. Backups, update archives and browser site data outside this folder also remain.'));
      guide.hidden = false; button.setAttribute('aria-expanded', 'true');
      button.textContent = 'Refresh uninstall steps';
    }
    async function show() {
      if (locked || pending) return;
      const ticket = ++epoch, controller = new AbortController(); pending = controller;
      button.disabled = true; status.textContent = 'Checking uninstall options for this TLI host…';
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/system/uninstall', {method:'GET', credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal});
        if (!response.ok) throw new Error('Unavailable');
        const info = await response.json();
        if (ticket !== epoch || locked) return;
        if (!info || typeof info.platform !== 'string' || typeof info.installation_path !== 'string' || !info.installation_path || typeof info.supported !== 'boolean' || typeof info.registered !== 'boolean' || (info.entrypoint != null && typeof info.entrypoint !== 'string')) throw new Error('Invalid response');
        render(info); status.textContent = 'These are instructions only. Continue on the computer hosting TLI to remove this installation.';
      } catch {
        if (ticket !== epoch || locked) return;
        guide.replaceChildren(); guide.hidden = true; button.setAttribute('aria-expanded', 'false');
        status.textContent = 'The host’s uninstall details could not be loaded. On Windows, look for TLI in Installed apps, or Uninstall_TLI.bat in the TLI folder. Back up saved data before removal.';
      } finally {
        clearTimeout(timeout);
        if (ticket === epoch) { pending = null; button.disabled = locked; }
      }
    }
    button.addEventListener('click', show);
    backupButtons[0]?.addEventListener('click', () => {
      if (locked) return;
      if (window.TLISettingsWorkspace?.open) window.TLISettingsWorkspace.open('data', 'data-recovery-settings');
      else status.textContent = 'Open Settings → Saved data & backups to create and verify your Saved work archive.';
    });
    backupButtons[1]?.addEventListener('click', () => {
      if (locked) return;
      window.switchPanel?.('panel-vault');
      const target = $('vault-backups');
      if (target) { target.open = true; target.scrollIntoView({block:'nearest'}); target.querySelector('summary')?.focus(); }
      else status.textContent = 'Open Vault → Backup & recovery to create and verify your Vault archive.';
    });
    window.addEventListener('tli-session-locked', () => { locked = true; reset('Unlock TLI to view this host’s uninstall details.'); });
    window.addEventListener('tli-session-unlocked', () => { locked = false; reset('View the removal options for this installation before continuing on its host computer.'); });
    window.addEventListener('pagehide', () => reset('View the removal options for this installation before continuing on its host computer.'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
})();
