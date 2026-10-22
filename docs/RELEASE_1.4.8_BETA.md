# TLI 1.4.8-beta — Intel Mac setup and update repair

This release fixes the Mac setup path that could select Python 3.15 and then
fail while compiling cryptography with missing OpenSSL or pkg-config.

- Mac startup, the optional website installer and the manual updater select
  standard CPython 3.10 through 3.14, preferring 3.13. Versioned python.org and
  Homebrew installations are found even when the default `python3` is unsupported.
  Prerelease and free-threaded interpreters are rejected before setup.
- Intel Macs download a hash-pinned TLI build of cryptography 50.0.2 with static
  OpenSSL 4.0.3. The wheel has the distinct version `50.0.2+tli.1`; its encryption
  code is unchanged from upstream. This avoids local Rust/OpenSSL compilation
  and avoids selecting an older encryption library when Intel wheels are absent.
- Startup verifies the installed wheel's version and recorded download hash.
  A failed download or installation check stops setup before starting a host.
  Everyday startup does not contact a package index when components are ready.
- An unsupported existing Python environment is preserved and gets specific
  repair instructions. Setup never deletes that environment or saved TLI data.

## Updating a working installation

On 1.4.6-beta or 1.4.7-beta, use **Settings → Software Updates → Check for updates
→ Download update → Install and restart**. Finish active work, review the update,
and confirm. TLI keeps the original installation, data, models and settings.
The updated Intel dependency requires an internet connection for its first
download. Android Companion is updated separately.

An existing 1.4.5-beta still receives the published 1.4.6 updater migration first.
Download it inside TLI, complete its included TLI_Update step once, then reopen
the original installation and check again for 1.4.8-beta.

## If Mac setup has already failed

Install standard Python 3.13 from python.org. If `backend/.venv` was created with
an unsupported interpreter, installing another Python alone will not replace it.
Follow [Repair a failed Mac Python setup](TLI_UPDATES.md#repair-a-failed-mac-python-setup):
fully quit TLI, preserve the old environment under an unused backup name, prepare
the supported environment, and apply this release from its separate
`TLI_Update.command` to the original folder. Do not move or reset saved data.

The bundled runtime still requires macOS 13.3 or newer on Intel, or macOS 14 or
newer on Apple Silicon. Release evidence distinguishes native Mac build/runtime
checks and minimum-OS inspection from a physical Ventura installation test.
The previously published packages and compatibility migration are unchanged.
