# Uninstall TLI

Each extracted TLI folder is a separate installation. Check its full path before
removing it, especially if you tested more than one release. Closing the browser
alone does not stop a Windows TLI host.

## Windows

After setup, use any of these entry points:

- **Windows Settings → Apps → Installed apps → TLI → Uninstall**. On Windows 10,
  the page is named **Apps & features**. Each entry includes the installation's
  folder name and a unique suffix.
- **Uninstall TLI** in the Windows Start menu.
- **Uninstall_TLI.bat** inside the installation you want to remove.

These open the same local removal window. Read its full installation path and
close TLI, its launcher, its model runtime and its optional host-start helper
before proceeding. Use that installation's Local Setup controls to stop the host
and helper when needed. Removal checks for running processes associated with
the folder and stops with instructions if it cannot verify that removal is safe.

Choose the result you want:

| Choice | What remains |
|---|---|
| **Remove Windows entries and keep all files** | The entire installation folder remains, including app files, Python environment, saved data, Vault and model downloads. Its verified Windows shortcuts and Installed apps entry are removed. You can later run TLI from the folder or restore the entries through Local Setup. |
| **Completely remove TLI and everything in this folder** | The whole displayed folder is permanently removed, including files you placed there yourself, saved conversations, accounts, settings, device configuration, Vault contents, local backups, logs, model downloads and the installation's Python environment. Its verified Windows entries are also removed. |

Full deletion requires typing **DELETE** after reviewing the folder. Make any
backups **outside that folder** first. A Vault backup still needs its passphrase
to recover. Deletion does not use the Recycle Bin and is not a secure disk wipe.
The uninstaller refuses full deletion of a Git checkout or a folder tree with
links/junctions; review those installations manually instead of bypassing the
check. It reports failures rather than treating partial deletion as completion.

Windows entries are scoped to the signed-in user and exact installation. Other
TLI copies are separate. Shortcuts created manually in other locations, entries
created by another Windows user, and old third-party installers may need manual
cleanup.

### Missing uninstall entry or older installation

The current Windows setup creates Installed apps and Start menu uninstall
entries alongside the normal app shortcuts. To add or repair the removal entry
without preparing Python or starting the host, open **TLI_Setup.bat** and select
**10 Add or repair Windows uninstall entry**. Source users can also run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\TLI_Setup.ps1 -Action RegisterUninstall
```

Run that command in the actual installation folder. It requires
`TLI_Uninstall.ps1` from the same release. If you move the folder later, recreate
its entries from the new location and remove the old stale shortcuts/entry.

Older published ZIPs do not gain this feature retroactively. Use a newer complete
release with the [guided updater](TLI_UPDATES.md) to add it to an existing folder,
then run that folder's Local Setup. Do not copy an uninstaller into an arbitrary
parent directory or run it from a new download to remove a different copy.

For an older installation that cannot be updated, stop its own host and helper,
back up what you need elsewhere, remove any startup entry that explicitly points
to that installation, then move only its verified installation folder to the
Recycle Bin. Remove shortcuts pointing to that same folder. Legacy installers
may have created a scheduled task or other startup entry; inspect its executable
and arguments before removing it. Do not remove processes or startup entries just
because their name resembles TLI.

## macOS and Linux

The ZIP/source installation has no system package uninstaller. Stop the host in
its launching Terminal with **Control+C** and stop any separate TLI helper or
runtime you started for that same folder. Back up anything needed outside the
installation, then move only that extracted folder to Trash using Finder or your
file manager. This includes local data, Vault and any models stored in that
folder. Remove any login items, launch agents, services or shortcuts you manually
created for it, after checking they point to that installation. There is no need
to stop unrelated programs using a particular network port.

The `Uninstall_TLI.command` and `Uninstall_TLI.sh` files provide manual guidance;
they do not automatically stop programs or delete files. The legacy Windows
`TLI_Installer/uninstall.bat` likewise provides a checklist instead of deleting
an assumed installation or stopping processes by name.

## Items outside the installation

Removing a TLI folder does not remove shared software such as Python, Microsoft
Visual C++ Redistributable, LM Studio or drivers. It does not delete models,
Vault exports, backups or other documents saved elsewhere, or undo actions
previously taken on connected devices. Review external files separately if you
want to remove them.

Your browser can retain TLI site preferences, cached files and local storage.
Use its site-data settings to remove the exact TLI address you used, and remove
any separately installed TLI browser extension or site shortcut. Uninstall the
native phone Companion separately on the phone. Desktop removal does not delete
an online download-registration account or revoke permissions held by other TLI
computers; review those separately where relevant.
