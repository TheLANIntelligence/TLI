# Restarting and quitting TLI

Open the **Device** menu in TLI and choose **Restart TLI…** or **Quit TLI…**.
The same controls are in **Settings → App & troubleshooting**. Review the
confirmation before continuing. These controls are available on the host
computer through its local TLI address when started with the desktop launcher.
When the update notice says the application files changed, its **Restart TLI…**
button opens the same confirmation. Checking the version never starts a restart.
An older running backend that lacks these controls explains the one-time local
Setup restart needed to load them.

Closing the browser tab leaves TLI running for background work and connected
devices. **Quit TLI** requests normal backend shutdown; the browser tab stays
open. Use the TLI shortcut to open it again. The optional phone-start helper
remains available if separately enabled in Setup.

**Restart TLI** waits for the recorded backend process to exit before starting
TLI again. The page checks for a new instance of this installation. An unlocked
PIN session may need unlocking again. If saved settings change the local
address, use the reviewed **Open TLI** link. Do not assume a disconnected page
means the action finished: lost replies are reported as unconfirmed.

Finish important work first. Restart and Quit may interrupt active chats, scans,
file operations and connected clients. An active model installation blocks the
request until it finishes, or cancellation finishes. Other programs, including
external model providers, are not closed.

## Implementation and verification

The existing host-control router exposes local browser capabilities, a short-lived
review, confirmation, a receipt and read-only boot identity. Companion credentials,
LAN clients, proxy headers, foreign origins and non-owner accounts cannot invoke
desktop lifecycle actions. Mutation requests require the current same-origin
browser and are bound to the original session, installation, process generation
and reviewed startup settings.

An accepted response is sent before a hidden helper is dispatched. The helper
uses the existing signed local stop request and normal backend shutdown. It
never kills a process by name or port. Restart requires confirmed exit of the
recorded process; ambiguous process inspection does not authorize another launch.
Receipts and locks prevent duplicate dispatch. Unknown results are not retried
automatically. Source deployments started from a diagnostic console remain
managed by that console.

Relevant sources: `backend/routers/host_control_routes.py`,
`backend/host_lifecycle.py`, `backend/host_launcher.py`, and the frontend
lifecycle controller, `frontend/js/host-lifecycle.js`. The launcher footer and
both user manuals explain the background behavior. Bundled AI shutdown uses
retained Windows process handles and verified Job Object membership instead of
PID-based termination.

Tests use isolated state and simulated processes. Browser
checks use synthetic API responses; they do not stop the installed TLI session.
The native launcher was rebuilt and its setup, startup and failure layouts
checked. Existing running installations need one backend restart to load these
new routes; subsequent restarts and quits can use the in-app controls.
