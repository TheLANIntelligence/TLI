# Start TLI from Companion

Host Start lets an already paired phone start the TLI backend on an awake Windows
computer whose user is signed in. A separate HTTPS helper stays available when
the main TLI app stops. It does not wake a sleeping computer, turn on a powered-off
computer, create a VPN route, or operate as a Windows service before sign-in.

## Set it up locally

1. Prepare the existing installation normally, enable its owner PIN and secure
   LAN startup, and pair Companion over the reviewed HTTPS certificate.
2. In the installation folder, double-click `TLI_Setup.bat`. Choose **Enable phone host
   start**, review the local configuration, and then choose **Start helper**.
   The separate default helper port is 8001; choose an unused port if needed.
3. Optionally choose **Start helper at sign-in**. This creates a shortcut for the
   current Windows user after an explicit local confirmation. It does not install
   a machine service, change firewall rules or grant access before sign-in.
4. Open desktop **Phone Companion → Start TLI from your phone → Check Host Start
   setup**. This reads configuration only; it does not claim the helper listener
   is reachable. The exact helper address stays visible; **Connection details**
   reveals its installation identity and certificate fingerprint. **Set up on
   this computer** reveals the detailed local setup steps.
5. While main TLI is still online, open **Settings → Start TLI from your phone** in
   a compatible installed Companion build. Choose **Review Host Start setup**,
   review the separately addressed helper, then **Allow Host Start on this phone**.
   No start request is sent during setup.

The helper uses the same certificate and numeric private LAN IPv4 address as the
existing pairing, on a separate HTTPS port. If using the existing routed private
network workflow away from home, allow that exact helper port in addition to
main TLI's port. The app does not infer whether a VPN or route is active.

## Use it from the phone

When the main connection fails, **Open Host Start options** leads to Settings.
Choose **Check helper status**. The app distinguishes these outcomes:

| Observed result | Meaning and next step |
| --- | --- |
| Helper unreachable or unverified | The phone cannot establish the helper's state. Check the computer and network; it does not prove that TLI is stopped or the computer is asleep. |
| Helper reached; TLI stopped | Start is offered only after this authenticated, identity-matching status check. |
| TLI is starting | The helper reports startup in progress. TLI is not yet presented as ready; deliberately check status again. |
| Helper confirms TLI running | Check the original paired TLI connection. Helper availability and main-app connectivity remain separate. |
| Fresh paired main connection succeeds | TLI is ready on this phone. AI availability is still reported separately. |

The stopped-state check is usable for starting for 30 seconds. After that, check
again. Duplicate taps reserve one request. A timeout or interruption does not
automatically retry a start; check status before deciding what to do next.
Backgrounding, pairing replacement, Forget and rejected access invalidate
pending observations. Messages, actions and starts are never queued for later.

Use the local setup menu for **Status**, **Stop helper**, **Disable phone host
start**, **Stop TLI**, or removal of the optional sign-in shortcut. Removing a
phone's paired access, changing the owner PIN/certificate, or disabling the local
helper invalidates its startup authority. Forget removes the helper credential
from protected phone storage alongside the main pairing selection.

## Connection and authority contract

- Main TLI advertises `host_control` in its authenticated Companion bootstrap.
  Desktop owner setup is `GET /api/host-control/v1/setup`. Advertisement
  `available` describes eligible saved configuration, not listener reachability.
- After explicit review, the phone sends `POST /api/host-control/v1/grant` through
  its original paired transport with the original Companion bearer. It receives
  a restricted `tlih_` credential; the main credential is never sent to the helper.
- The protected helper envelope is associated with the existing node, device,
  owner, original origin and certificate. A different pairing cannot reuse it.
  Setup writes and removals share the existing protected-storage write queue.
- Native `requestHelper(configuration, request)` creates an isolated pinned
  client/session for one request. It does not temporarily reconfigure the main
  transport. Both platforms compare the advertised SHA-256 fingerprint with the
  existing paired DER certificate before sending and retain exact leaf,
  certificate-validity and hostname verification. Redirects are rejected.
- The native helper bridge accepts only `GET /host-control/v1/status` and
  `POST /host-control/v1/start`, a restricted helper bearer, nonstreaming JSON,
  at most 4 KiB request bodies and 64 KiB responses. Helper calls are bounded to
  20 seconds. Cancel/reset closes their independent sessions without replacing
  the main connection's trust.
- Status and start receipts must match the reviewed node/helper identities and
  supported backend states. Start receipts additionally match the submitted
  request ID and include an explicit accepted result. The backend owns duplicate
  request handling and installation/readiness proof; the phone cannot authorize
  commands, paths, scripts, model starts or arbitrary origins.

## Verification and distribution boundary

The desktop Companion suite passed 49 tests. The complete mobile TypeScript
suite passed 204 tests, including thirteen Host Start tests, and TypeScript checking
passed. The Kotlin/Swift native sources passed the existing syntax parser. New
platform policy tests cover scope restrictions, main-credential rejection,
stream rejection and body limits. Native API compilation, platform tests and
physical-device TLS/background behavior still require their platform toolchains;
syntax and mocked transport tests are not substitutes for those checks.

`scripts/verify_host_start_browser.cjs` passed six synthetic browser layouts at
1100, 390 and 320 pixels in light and dark themes. It checks deliberate setup
reads, unavailable/older hosts, absence of mutations, lock cleanup, and truthful
listener uncertainty. Native disclosures also pass keyboard Enter/Space,
tab-order and visible-focus checks without making requests. The collapsed card
is 414 pixels tall at a 390-pixel viewport; expanded content remains within the
viewport width. Screenshots/report are under
`build_work/host-start/browser-2026-09-17T06-01-33-325Z`.

These native source changes require a future compatible Companion distribution.
An older installed build reports that Host Start needs a compatible release.
The web preview does not make real helper requests. This implementation work did
not build or distribute a native binary, install a host helper/service, change a
live firewall/VPN, or start/stop the user's production TLI.
