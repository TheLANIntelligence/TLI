# Welcome to TLI 1.4.0-beta

This is the new TLI desktop experience: Ask TLI, the refreshed workspace,
appearance themes, Files, Vault, reviewed LAN connections and small-app Builder.
The website's examples use illustrative data. Your new installation starts empty.

## Windows

The bundled inference runtime requires the
[Microsoft Visual C++ v14 x64 Redistributable](https://aka.ms/vc14/vc_redist.x64.exe).
If the launcher reports missing runtime dependencies, install it and reopen TLI.

1. Extract the **entire** Windows ZIP into a new, writable folder, such as
   `Documents\TLI-1.4.0-beta`. Do not run it inside the ZIP or copy it over an old TLI.
2. Open **TLI.exe**. Complete first-time setup when prompted. It prepares this
   installation's Python environment; internet access is needed the first time.
3. If Python cannot be installed automatically, install 64-bit Python 3.14 from
   [python.org](https://www.python.org/downloads/windows/), then retry.
   `TLI_Diagnostics.bat` shows setup errors in a visible window.

The Windows download targets 64-bit Windows 10/11. The launcher is not code-signed.
Only use the release linked from the TLI website and compare the published checksum.
Closing the browser leaves the Windows host running; use Local Setup to stop it.

## macOS

Requires **macOS 14 or newer on Apple Silicon**, or **macOS 13.3 or newer on
Intel**, for the bundled inference runtime.

1. Extract the Mac ZIP into a new folder, such as `Applications/TLI-1.4.0-beta`.
2. Install Python 3.10 or newer from
   [python.org](https://www.python.org/downloads/macos/) if it is not already present.
3. Open **TLI_Start.command**, or open Terminal in this folder and run
   `bash TLI_Start.command`. First setup prepares this installation's Python
   environment and needs internet access.
4. Keep Terminal open while TLI is running. Press **Control+C** there to stop TLI.

The Mac package contains Apple Silicon and Intel inference runtimes and chooses
the matching architecture. It is a Python-based ZIP installation, not a notarized
Mac application or a DMG installer.

## Start a conversation

The package includes the llama.cpp inference runtime, but **model weights are a
separate download**. Use TLI's model settings to select and download a model that
fits your computer, or select a configured LM Studio local server. Initial model
downloads need internet access. Speed depends on your model and hardware; the
Windows bundled runtime uses the CPU.

## Already installed an older TLI?

Keep the old folder and its `data/` and models intact. Stop the old TLI through its
own launcher or Terminal before opening the new one; both normally use port 8000.
The new download is a **separate installation**, not an in-place updater. Back up
your old installation before manually moving any saved data. This release does not
automatically migrate, delete, or replace your existing files.

The separate native phone Companion is not included in these desktop ZIPs.
Optional services and connected devices require their own configuration.

Release notes, checksums and support:
[TLI 1.4.0-beta](https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.0-beta).
