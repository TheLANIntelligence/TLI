# TLI 1.4.4-beta

Improves desktop update downloads and automatically prompts when a newer
release is available.

- Release checks and downloads now use bundled trusted root certificates in
  addition to the operating system's certificate store. This addresses missing
  certificate trust in Python installations without disabling certificate or
  hostname verification, including redirects to the package download server.
- Certificate failures explain recovery and offer **Download from releases**.
  Retry remains available, and failed downloads do not replace application files.
- With automatic checks enabled, TLI checks at startup and every six hours while
  running. Saved preferences apply immediately; background failures stay in
  Settings, and dismissing a banner keeps that release quiet for the page session.
  Downloading and installing still require your action.

**If an older TLI cannot download this fix because of a certificate error:**
download the matching ZIP from this release in your browser and extract it into
a separate folder. Back up important saved data, finish active work, and stop
the original TLI host. Closing a browser tab alone does not stop the host.
Run the new package's `TLI_Update.bat` on Windows or `TLI_Update.command` on Mac,
select your original TLI folder, review the destination, and type `UPDATE`.
Keep using the original folder and shortcuts afterward. Saved data and models
remain with the original installation. First start may need internet to prepare
updated Python dependencies. Full instructions are in `docs/TLI_UPDATES.md`.

An incorrect clock or a certificate problem on the network can still prevent a
verified connection; this release does not bypass certificate checks. The
reported Dell's exact certificate-store condition was not reproduced locally.

Windows and macOS packages include the local inference runtime; model weights
and Python dependencies are not bundled. The separate phone Companion is not
updated by these desktop packages. See the attached checksums and verification
report for the exact tested archives.
