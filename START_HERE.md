# Welcome to TLI 1.4.4-beta

This is the new TLI desktop experience: Ask TLI, the refreshed workspace,
appearance themes, Files, Vault, reviewed LAN connections and small-app Builder.
The website's examples use illustrative data. Your new installation starts empty.

## Windows

First-time setup prepares Python, TLI components and missing Microsoft x64
runtime prerequisites. It downloads the runtime directly from Microsoft and
checks its signature before running it. Windows may ask you to approve that
Microsoft installer. Setup never restarts your computer automatically.

1. Extract the **entire** Windows ZIP into a new, writable folder, such as
   `Documents\TLI-1.4.4-beta`. Do not run it inside the ZIP or copy it over an old TLI.
2. Open **TLI.exe** and choose **Set up TLI** when prompted. Progress stays in
   the TLI window. Internet is only needed to download missing Python or TLI
   components; a prepared installation can start offline. Your browser opens
   automatically when this installation is ready, including when optional local
   AI still needs attention. TLI then welcomes you with appearance, optional PIN
   and AI setup, accompanied by the welcome soundtrack. If the browser blocks
   music on arrival, **Let's begin** or **Play music** starts it. Music and volume
   controls remain available throughout setup. You can
   finish later and return from **Settings → AI → Welcome & setup**.
3. If Python cannot be installed automatically, install 64-bit Python 3.14 from
   [python.org](https://www.python.org/downloads/windows/), then retry.
   `TLI_Diagnostics.bat` shows setup errors in a visible window.

If local AI still needs the
[Microsoft Visual C++ v14 x64 Redistributable](https://aka.ms/vc14/vc_redist.x64.exe),
the launcher keeps repair guidance available while opening the app. Startup
details are available through **Open logs**, including `setup.log` for first-time
preparation. Model weights are downloaded separately through welcome setup or
Settings → AI.

The Windows download targets 64-bit Windows 10/11. The launcher is not code-signed.
Only use the release linked from the TLI website and compare the published checksum.
Closing the browser leaves the Windows host running; use Local Setup to stop it.

## macOS

Requires **macOS 14 or newer on Apple Silicon**, or **macOS 13.3 or newer on
Intel**, for the bundled inference runtime.

1. Extract the Mac ZIP into a new folder, such as `Applications/TLI-1.4.4-beta`.
2. Install Python 3.10 or newer from
   [python.org](https://www.python.org/downloads/macos/) if it is not already present.
   For a python.org installation, run **Install Certificates.command** from the
   Python folder under Applications before first setup.
3. Open **TLI_Start.command**. If macOS displays **“TLI_Start.command” Not Opened**
   and says Apple could not verify it, follow the steps below. First setup
   prepares this installation's Python environment. Internet is only needed
   if missing components must be downloaded.
4. Keep Terminal open while TLI is running. Press **Control+C** there to stop TLI.

The Mac package contains Apple Silicon and Intel inference runtimes and chooses
the matching architecture. It is a Python-based ZIP installation, not a notarized
Mac application or a DMG installer.

### If Apple blocks TLI_Start.command

For the TLI ZIP you obtained directly from the official release and trust:

1. Click **Done** on the warning.
2. Open **Apple menu → System Settings → Privacy & Security**.
3. Scroll to **Security** and find the blocked `TLI_Start.command` entry.
4. Click **Open Anyway**, then **Open** in the confirmation. Authenticate if asked.
5. Continue setup in Terminal and keep that window open while using TLI.

This approves that launcher; it does not turn off Gatekeeper for other software.
If the entry is missing, try opening `TLI_Start.command` once more, then return
to Privacy & Security. A managed Mac may require its administrator's help.
If the warning instead says the file **will damage your computer**, was moved
to Trash as malware, or is **damaged**, stop and report that exact message rather
than using these approval steps. See [Apple's instructions](https://support.apple.com/en-us/102445).

For a deliberate Terminal launch of a package you have reviewed, open Terminal
in the extracted folder and run `bash TLI_Start.command`. This does not sign or
notarize the package and is not a repair for a damaged or malware-blocked file.

## Start a conversation

Welcome setup works offline and does not require an AI download. You can use an
existing compatible model or local provider, or finish setup and configure AI
later. The package includes the llama.cpp inference runtime; model weights are
separate. Download a model only if you need one, or use TLI's model settings to
select a model you already have or a configured LM Studio local server. Model
downloads need internet access; using an installed local model does not. Speed depends on your model and hardware; the
Windows bundled runtime uses the CPU.

## Already installed an older TLI?

Use the updater in the **newly extracted package** to keep your original TLI
folder, saved conversations, Vault, settings, models and shortcuts together:

1. In the existing app, open **Settings → Software Updates → Check now**. For an
   updater-equipped release, prepare the download there; older apps can download
   the matching Windows or Mac ZIP from the TLI website and extract it separately.
2. Finish active work, stop the old TLI using its own local controls or Terminal,
   and stop the optional host-start helper if enabled. Closing the browser alone
   does not stop the Windows host.
3. In the **new package**, open **TLI_Update.bat** on Windows or
   **TLI_Update.command** on Mac. Select your **original TLI folder**, review the
   displayed destination, then type **UPDATE** when asked.
4. Open TLI from your **original folder or shortcut**. Startup prepares any
   missing components; this step may need internet access. The updater reports
   installed files separately from successful startup.

The updater verifies the package inventory and retains a backup of replaced
application files for rollback. It keeps your saved data and models in place;
you do not need to register again or move them into the extracted folder.
Back up important saved data before updating; the application-file backup does
not replace a data or Vault backup.

Older published ZIPs may not include `TLI_Update` and `TLI_RELEASE.json`. Those
packages cannot perform this guided update. Keep the original installation intact
and use a newer updater-equipped package; do not copy files over a running TLI.
See [the update and recovery guide](docs/TLI_UPDATES.md) for details.

The separate native phone Companion is not included in these desktop ZIPs.
Optional services and connected devices require their own configuration.

## Uninstall TLI

On **Windows**, use **Settings → Apps → Installed apps → TLI → Uninstall**
(**Apps & features** on Windows 10), **Uninstall TLI** in the Start menu, or
`Uninstall_TLI.bat` in the folder you extracted. The window shows the exact
installation. Choose **Remove Windows entries and keep all files** to retain
the entire folder, or choose full deletion to remove that folder, including
saved conversations, settings, Vault, backups and downloaded models. Full
deletion requires an additional confirmation and cannot be undone.

If an updated Windows installation is missing from Installed apps, open its
`TLI_Setup.bat` and choose **10 Add or repair Windows uninstall entry**. Older
published ZIPs do not gain this feature automatically; see the
[removal guide](docs/TLI_UNINSTALL.md) before removing an older installation.

On **macOS / Linux**, stop TLI in its Terminal with **Control+C**, back up files
you need, then move only the extracted TLI folder to Trash. Python, LM Studio,
externally stored models, browser data and the separate phone Companion are
not removed with the desktop folder.

Release notes, checksums and support:
[TLI 1.4.4-beta](https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.4-beta).
