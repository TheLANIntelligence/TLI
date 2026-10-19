# TLI 1.4.6-beta — updater migration

This compatibility release gives existing 1.4.5-beta installations the new
in-app updater. It retains the previous product features and package format so
the installed 1.4.5 validator can download and verify it.
It also validates the original host-address header before framework URL
normalization when admitting local controls and supported paired clients.

Open **Settings → Software Updates → Check for updates → Download update**.
Once the package is ready, open its folder, finish active work and stop the
original TLI host. Run the new package's **TLI_Update.bat** (Windows) or
**TLI_Update.command** (Mac), select the original TLI folder and confirm.
Reopen TLI from the original folder or shortcut. This last manual completion is
needed because the already-installed interface cannot install and restart.

Then check for updates again and download **1.4.7-beta**. Choose **Install and
restart** in TLI, review the version and destination, and confirm. TLI preserves
saved data, identity, settings, models and the existing Python environment.
Changed Python dependencies may need internet access. The host restarts only
after installation finishes; the browser confirms the new running version.

Desktop updates require the normal local launcher. Remote browsers, phones,
diagnostic hosts and legacy frozen backends do not gain host update authority.
Optional host-start helpers and separate launcher windows must be closed when
reported by the review. No processes are forcibly killed. Android is updated
separately.
