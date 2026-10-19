# TLI 1.4.7-beta — in-app updates and clearer everyday tools

This release adds **Download update → Install and restart** to Software Updates
and publishes the latest desktop improvements.

- Review the verified version and original host address before confirming an
  update. TLI stops its own managed host, installs application files, prepares
  missing dependencies and reopens the same installation. The browser verifies
  the new process and version before offering Reload. Failed or interrupted work
  is reported and never automatically replayed.
- HomeLab is hidden from everyday navigation while saved configuration remains
  intact. Task tools now live inside the chat composer with clearer examples,
  folder access and one Start task action.
- Game Optimizer offers concrete, manual setting trials, including exact menu
  values for any game. Enter your own before/after measurements to compare FPS,
  1% lows and frame time. TLI does not invent benchmark results or automatically
  apply a trial.
- The release includes the latest saved-data, session lifecycle, chat, Builder,
  device-tool and interface fixes from the current desktop source.

## Existing installations

**1.4.5-beta:** check inside TLI for the small **1.4.6-beta updater migration**.
Download it in the app and finish that update once with its included TLI_Update
launcher. Reopen the original installation and check again; **1.4.7-beta** can
then be installed using **Install and restart**.

**1.4.6-beta and newer:** use Settings → Software Updates. Finish active work,
download the offered package, review Install and restart, then confirm.

**Older or unsupported installations:** download the matching current Windows
or macOS ZIP, extract it separately and follow its `docs/TLI_UPDATES.md`. Do not
start a second installation or move saved data into a staging folder.

The updater preserves data, identity, PIN settings, trust, models and the Python
environment in the original folder. It retains backups of replaced application
files. Keep separate backups of important data and Vault content. Dependency
changes can require internet access. The desktop updater does not update the
separately distributed Android Companion.

This remains a beta release. Automated package, update, recovery and interface
checks do not establish every physical-device, LAN or game configuration.
