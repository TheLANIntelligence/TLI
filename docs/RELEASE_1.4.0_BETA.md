# TLI 1.4.0-beta

This release brings the current TLI desktop experience to the public Windows
and macOS downloads. It replaces the website's older 1.3.5-beta fresh-install
package with separate, prepared packages for each platform.

## Download and start

- **Windows 10/11, 64-bit:** extract `TLI_1.4.0-beta_Windows.zip` into a new
  writable folder and open `TLI.exe`. The launcher prepares Python dependencies
  and includes a CPU inference runtime. If supported Python is missing, setup
  uses Windows Package Manager to install Python 3.14 for your account.
  The bundled runtime also requires the
  [Microsoft Visual C++ v14 x64 Redistributable](https://aka.ms/vc14/vc_redist.x64.exe).
  If the runtime check reports missing dependencies, install it and retry TLI.
- **Apple Silicon macOS 14+ or Intel macOS 13.3+:** extract
  `TLI_1.4.0-beta_macOS.zip` into a new folder and open `TLI_Start.command`.
  Install Python 3.10 or newer first. Both Mac inference runtimes are included;
  TLI selects the architecture of its Python process. The Terminal window stays
  open while TLI runs. Stop it with Ctrl+C.

Use the named platform ZIPs in the release assets. GitHub's automatic **Source
code** archives do not contain the prepared launchers and inference runtimes.
Read `START_HERE.md` inside the package before first launch. Setup needs internet
access. Configure or download an AI model separately; model weights are not
included. LM Studio is also supported.

## Current desktop experience

- A five-step welcome with theme previews, optional PIN protection, guided AI
  setup and a choice of first destination. Unfinished setup can resume.
- General-purpose **Ask TLI** for conversation, writing, learning, planning and
  coding, with connected tools available when useful.
- Updated Home, navigation, Files, Free Space, Vault, computer connections,
  smart-device tools and reviewed manual routines.
- Small web-app creation with isolated previews and explicitly selected local
  or trusted LAN inference.
- Windows startup checks that reject a stale backend instead of opening old
  application code, and corrected feature reporting on fresh FastAPI installs.
- A Mac installer that verifies the archive checksum and refuses to overwrite
  an existing installation.

## Existing installations and beta limits

Extract into a **new folder**. Keep your old TLI folder, `data`, model files and
backups intact. This release does not automatically migrate existing private
state or overwrite your old installation. Stop the old TLI process using its
own controls before starting the new copy on the same port. Existing shortcuts
may still point to the old folder; launch from the new extracted folder first.

The legacy in-app updater remains on its existing channel. Install this desktop
release from the platform ZIP rather than using that updater.

These are source-based beta installations: the Windows launcher is unsigned,
and the Mac package is a shell launcher rather than a notarized application.
Platform package checks exercise extraction, dependency setup, application
identity, static UI assets and the native inference runtime. They do not certify
model quality, every physical device, or a two-computer/phone setup. Phone
Companion native builds are not included in these desktop ZIPs.
