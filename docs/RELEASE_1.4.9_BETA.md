# TLI 1.4.9-beta — first-start port conflict repair

A fresh installation can now open when another application already uses TLI's
default port. The launcher chooses an available local port, saves that choice,
and opens the address only after this installation proves it is ready.

- Works with the Windows desktop launcher, TLI_Start.bat and the Mac launcher.
- Leaves the application using the occupied port running.
- Keeps saved addresses, explicit port overrides and previously started
  installations unchanged. Retained startup records and unavailable ownership
  checks cannot authorize changing an installation's address.
- Preserves the Intel Mac setup repair and updater from 1.4.8-beta.

For a new Windows installation, extract the entire Windows ZIP into a new,
writable folder and open **TLI.exe**. Use **TLI_Start.bat** if you need the visible
startup window. On a Mac, open **TLI_Start.command**.

Existing installations can use **Settings → Software Updates → Download update
→ Install and restart**. Version 1.4.5 receives the existing 1.4.6 migration first.
Keep saved data in the original installation; do not copy it into a fresh folder.

This repair selects another port only for an unused installation with default
settings. If an older TLI is still running, close it through its own Stop or Quit
control. For an explicitly chosen or saved port conflict, see the port-conflict
steps in START_HERE.md. Closing the browser alone does not stop the host.

The attached SHA256SUMS.txt identifies the exact downloads. Verification scope
and results are recorded in RELEASE_VERIFICATION.json. No physical laptop or
minimum-version Mac acceptance is claimed by the automated checks.
