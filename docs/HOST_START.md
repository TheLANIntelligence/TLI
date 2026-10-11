# Optional phone host start on Windows

Phone host start is off by default. It starts only this TLI backend on an awake
computer where its Windows user is signed in. It cannot wake a sleeping PC,
start Windows before sign-in, control arbitrary programs, or shut down TLI.
It does not configure a VPN, internet port forwarding or Windows Firewall.

## Everyday launch

Double-click **TLI.exe** in the extracted folder. The Windows app shows startup
progress and guides first-time setup, which adds Desktop and Start menu shortcuts.
The launcher's **Add Desktop & Start Menu shortcuts** button can recreate them.
Open **TLI** from either place or search for it in
Windows. It reuses the installation's Python environment and checks installed
dependency versions locally. Dependencies are installed only when required.
An occupied backend address must prove that it belongs to this
installation before TLI reuses it. Foreign or unrecognized listeners are left
alone. Backend output is kept in `data/host_control/backend.log`; at the next
launch, a log larger than 2 MiB is rotated to one previous log.

The launcher shows progress while waiting for TLI to become reachable. Loading
the local AI model can take longer than a minute on a cold start; the launcher
allows up to five minutes instead of reporting failure after 45 seconds. If
TLI is still starting after that, opening TLI again keeps waiting for
the same process. If the backend exits, the launcher reports it promptly and
points to the log and visible diagnostic launcher.

Local Setup's **Desktop & Start menu app** option recreates the app shortcuts.
Shortcuts belong to this installation; unrelated shortcuts are preserved. No
Windows service or sign-in startup is enabled by adding them. Closing the browser
does not stop the backend. `TLI_Start.bat` remains a command-line fallback and
`TLI_Diagnostics.bat` retains a visible diagnostic launch. `TLI_Setup.bat` provides
the optional helper controls.
Choose **Stop TLI** in local setup after finishing active work, then type STOP.
It requests normal shutdown only for a recorded child of this installation whose
process generation and running identity still match. A backend started in a
diagnostic console must be stopped from that console. No unrelated process is
terminated, and a shutdown timeout never falls back to forced termination.

## Enable deliberately on the host

1. Start TLI normally, set its desktop PIN, save Secure LAN startup with HTTPS,
   and restart normally. Pair Companion using the certificate-covered LAN IP.
2. Run `TLI_Setup.bat` on this same computer and choose **Enable phone host
   start**. Enter the existing desktop PIN locally. The default separate HTTPS
   helper port is 8001; `TLI_Setup.ps1 -Action EnableHostStart -HelperPort 8002`
   selects a different unused port. No certificate is regenerated.
3. Choose **Start helper**. Review its status and use **Start helper at sign-in**
   if desired. This installs a shortcut for the current Windows user, not a
   privileged Windows service. No automatic elevation is used. If Windows
   blocks incoming access, review the existing firewall policy yourself.
4. In a compatible Companion build, while the main TLI backend is reachable,
   explicitly review and save the helper connection. The phone uses the same
   reviewed certificate and host identity with a separate restricted token.
5. When the backend later stops, explicitly check the helper and request Start.
   Accepted means the process launch was requested. Only reconnection to the
   original TLI backend confirms readiness. A missing helper or sleeping host
   remains unavailable; requests are not queued for later replay.

Older installed Companion builds can continue ordinary paired operations but
need an updated native client to expose the helper review/status/start controls.

## Local lifecycle and recovery

`TLI_Setup.ps1 -Action Status`, `StartHelper`, `StopHelper`, `StopTLI`, `DisableHostStart`,
`EnableSignIn`, and `DisableSignIn` are local operations. Stopping the helper
leaves an already running backend alone. Disabling removes startup authority and
the setup script's sign-in shortcut. Changing the desktop PIN, installation
identity, saved startup settings or HTTPS certificate invalidates existing
helper setup; review and enable it again locally. Revoking a paired phone also
revokes its restricted helper token immediately on its next request.

Logs and bounded startup receipts are under `data/host_control`. Receipts record
intent before process creation; duplicate request IDs never launch again. If a
crash leaves an uncertain attempt, inspect the desktop and logs instead of
repeatedly pressing Start. No process occupying a port is killed automatically.
A full receipt store refuses new requests instead of discarding replay history.

Keep this installation directory and its private data accessible only to trusted
local Windows users, just as with the existing PIN and paired-device stores.
The helper does not grant a boundary against another program running as the same
Windows user. Moving/copying the installation requires explicit local setup.

## Building the Windows entry point

Run `powershell -NoProfile -File build_launcher.ps1` on Windows to build the small
`TLI.exe` from `desktop/TliLauncher.cs`. It uses Windows .NET Framework and the
existing TLI icon; it does not bundle another browser or Python runtime.
The ZIP packager includes this exact executable and excludes machine-specific
shortcuts. Rebuild it after changing the C# source. Public releases should sign
the executable; a local build is unsigned.

`powershell -NoProfile -File scripts/verify_windows_launcher.ps1` compiles an
isolated native harness, exercises synthetic success/failure/close behavior and
saves UI captures under `build_work/launcher-qa`. It does not launch the real
backend or browser. Python worker and shortcut tests cover verified reuse,
protocol failures and preservation of unrelated shortcuts.
