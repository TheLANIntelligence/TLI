# TLI on macOS

The current Mac desktop release is a Python-based ZIP installation with a
Terminal launcher. It is not a signed, notarized Mac application or a DMG.
It includes Apple Silicon and Intel inference runtimes; Python dependencies
and AI model weights are separate downloads. Platform and device support varies.

## Install and start

The bundled inference runtime requires **macOS 14 or newer on Apple Silicon**,
or **macOS 13.3 or newer on Intel**.

1. Download the Mac ZIP from the [official TLI download page](https://thelanintelligence.com/download/)
   and compare its published SHA-256 checksum. Extract the entire ZIP into a new,
   writable folder. Keep any older TLI installation intact.
2. Install Python 3.10 or newer from [python.org](https://www.python.org/downloads/macos/)
   if needed. For a python.org installation, run **Install Certificates.command**
   from its Python folder in Applications before first setup.
3. Open **TLI_Start.command** in the extracted folder. If macOS blocks it, follow
   the specific review steps below before proceeding.
4. First setup prepares `backend/.venv` inside this installation and downloads
   its Python dependencies. Keep Terminal open; the browser opens when the host
   starts. Use the address printed in Terminal if it does not open automatically.
5. Choose and download a model in TLI, or configure a provider such as LM Studio.
   The package includes inference runtimes, not model weights.

TLI defaults to local access. Existing saved startup settings can change its
address, port and HTTPS mode. Review **Settings → Security & connections** before
connecting other computers or phones; the launcher does not automatically enable
LAN access. Source-checkout setup is described in [README.md](../README.md).

The optional Terminal installer linked from the download page verifies the
release checksum and creates a new `~/Applications/TLI-<version>` folder. It
refuses to replace an existing folder, does not migrate old data, and does not
remove macOS security attributes. It still requires Python and a separate launch.

## If Apple could not verify TLI_Start.command

The message that Apple could not verify **TLI_Start.command** is macOS checking
the downloaded launcher before it runs. TLI's startup code cannot repair a
security decision that prevents that code from starting.

Only if you obtained the official release, checked its checksum, and trust that
copy, use Apple's per-file review process:

1. Choose **Done** in the warning.
2. Open **Apple menu → System Settings → Privacy & Security**.
3. Scroll to **Security** and find the notice for **TLI_Start.command**.
4. Choose **Open Anyway**, then **Open** in the follow-up prompt. Authenticate
   if macOS requests it.

These steps follow [Apple's guidance for opening downloaded software](https://support.apple.com/en-us/102445).
If the notice is absent, attempt to open that same file again and return to the
settings page. A managed Mac may restrict this choice; contact its administrator
if it remains unavailable.

Do not use these steps for a warning that software **will damage your computer**,
contains malware, or **is damaged**. Stop and check the download with support.
Do not disable Gatekeeper or remove quarantine attributes across the folder.
Right-click → Open is not a reliable alternative: Apple removed that override
for incorrectly signed or unnotarized software in
[macOS Sequoia](https://developer.apple.com/news/?id=saqachfa).

Running a shell command does not establish that a download is trustworthy or
make the release notarized. The lasting distribution improvement is a properly
packaged, Developer ID-signed and notarized Mac release, following
[Apple's Developer ID guidance](https://developer.apple.com/developer-id/).
The current ZIP does not provide that experience.

## Stop or update

Press **Control+C** in the Terminal that launched this installation to stop TLI.
Closing its browser tab does not stop the host.

For an update, download and extract the new package separately, back up important
saved data, and stop the original host. Open **TLI_Update.command** in the new
package, select the original installation folder, review it and type **UPDATE**.
Then reopen TLI from the original folder. See the
[update and recovery guide](TLI_UPDATES.md) for supported releases and rollback.

## Remove this installation

1. Export and verify backups you want to keep **outside the TLI folder**. A Saved
   work archive does not replace a separate Vault backup or a model backup.
2. Stop the host with **Control+C** and stop any separate TLI helper you started
   for this installation.
3. In Finder, check the exact installation folder and its contents, then move
   that folder to Trash when ready. Removing it also removes the saved data,
   Vault, local backups and model files stored inside it.
4. Remove only login items or shortcuts you added for that installation. Review
   browser site data, browser extensions and the native phone Companion separately.

**Uninstall_TLI.command** provides these manual steps; it does not kill processes
or delete files automatically. Models and backups stored elsewhere, Python and
LM Studio remain separate. See the [removal guide](TLI_UNINSTALL.md) for details.
