# TLI Companion private beta

Use [Current Companion beta delivery](TLI_COMPANION_CURRENT.md) for the current
Android build, verified source/artifact evidence and remaining physical checks.
The checkpoint links below retain historical context.

The subsequent [screenshot continuity checkpoint](COMPANION_SCREENSHOT_CONTINUITY.md)
adds reviewed image destinations, explicit screenshot-computer guidance and
failed-send recovery to this existing native app. It does not replace its
pairing, inference routing or native transport.

The native iPhone/Android app lives in `mobile/`. It adds Today, Ask TLI, Home,
photo troubleshooting, shared conversation history, rooms, favorite controls and
connection settings. The existing desktop and browser Companion remain available.
The backend, device drivers, inference providers and encrypted data formats stay
shared. The native app does not run inference or require a runtime cloud account.

## Pair a phone

1. Install a native preview/development build. Expo Go cannot load the pinned
   transport module. For build commands and platform requirements, see
   [the mobile README](../mobile/README.md).
2. Open **Home & network → Phone Companion**. Its four stages are **Owner access →
   Secure connection → Pair your phone → Manage paired phones**. Follow its link
   to set an owner PIN in Settings and unlock. Under **Secure connection →
   Host startup & network access**, choose secure home-network access, review and
   save. Stop TLI normally and start it with its launcher. Saving does not restart
   the server. Advanced environment overrides remain supported:

   ```powershell
   $env:TLI_ENABLE_TLS="1"
   $env:TLI_LAN_MODE="1"
   .\TLI_Start.bat
   ```

   macOS: `TLI_ENABLE_TLS=1 TLI_LAN_MODE=1 bash TLI_Start.command`.
   Linux: `TLI_ENABLE_TLS=1 TLI_LAN_MODE=1 bash TLI_Start.sh`.

3. Open the printed HTTPS desktop URL and unlock with the owner PIN. An existing
   explicit `TLI_HOST` overrides LAN mode; use a LAN bind rather than loopback.
   The locally generated certificate can produce a desktop browser trust warning.
4. Return to **Phone Companion**. Settings, Computers, onboarding and Ctrl+K link
   here without creating an invitation. Choose a listed certificate-valid LAN
   address if the host has several interfaces, then choose **Create pairing QR**.
5. In the phone app, scan the QR, confirm the TLI name and name the phone. The
   complete pairing bundle is an alternative when camera access is unavailable.
   Codes expire after five minutes and can be used only once.

Phone requests use a separately issued device credential. Satellite heartbeat
secrets are not native credentials. **Computers → Browser connection → Browser
satellite** creates a separate browser invitation; do not scan it with the native
app. Phone Companion lists paired phones and can remove their access. Hiding a
native pairing code does not revoke it; it remains single-use until expiry.
Forgetting on the phone clears its local pairing;
desktop revocation denies future requests with that credential.

Settings in the native app offers **Review replacement pairing**. The current
pairing remains selected until the reviewed candidate passes identity/access
checks and protected storage succeeds. See [startup and recovery behavior,
verification and rollback limits](SAFE_STARTUP_COMPANION_RECOVERY.md).

HTTP installations are unchanged until HTTPS is explicitly enabled. Requested
HTTPS never silently falls back to HTTP when the certificate is broken. The
launchers use the configured scheme when opening the desktop browser.

## Trust, recovery and compatibility

The QR supplies the public server certificate, selected private IPv4 HTTPS origin,
node identity and a short-lived invitation. The native URLSession/OkHttp module
uses only that certificate as its trust anchor, checks exact identity, hostname
and validity, and rejects redirects. It never changes the phone's system trust
store or global React Native networking. Credentials are kept in platform secure
storage; only their hashes are persisted in `data/companion/credentials.json`.

A changed address must still be present in the certificate SANs. For a new address
outside those SANs, stop TLI and back up the existing certificate/key pair from
the installation's `data/tls/` directory before explicitly renewing them and
restarting. Keep the backup private. A new certificate requires fresh pairing on
each phone. Do not delete the companion registry, vault, or model settings to
repair connectivity. Automatic certificate rotation, mDNS discovery and remote
access are deferred; a stable LAN address is convenient for this private beta.

The app treats offline data as stale, cancels foreground requests when backgrounded,
and does not queue/replay commands. A lost response can mean the host already
acted; inspect device status before submitting again. Device acknowledgements
and observed state remain separate. Scene receipts retain individual failures.

Photos are selected deliberately, converted to bounded JPEGs, previewed, and
submitted with zero retention. The existing backend revalidates size and pixels,
removes metadata and requires an available vision model. It never silently
downloads/switches models or sends an image through text-only/mesh fallback.
Images are not embedded in saved conversations.

## API and persistence

All new routes are under `/api/companion/v1`:

| Operation | Contract |
|---|---|
| `GET /setup` | PIN/TLS/LAN readiness, certificate-valid origins and node identity |
| `POST /pairings` | Browser owner session only; accepts `origin`, returns `bundle`, `qr`, `expires_at` |
| `POST /pairings/redeem` | HTTPS single-use invitation; accepts `token`, `name`, `platform`; returns device credential and owner/node identity |
| `GET /paired-devices` | Owner's paired-device metadata, excluding credential hashes |
| `DELETE /paired-devices/{id}` | Revoke an owned device |
| `GET /bootstrap` | API version, node, capabilities and text-chat transport |
| `GET/PUT /preferences` | Owner's favorite canonical device IDs, scene IDs and `system/light/dark` theme |

Existing services serve activity, devices, actions, diagnostics and conversations.
Native Authorization is validated before routing, including legacy public read
routes; an invalid bearer never falls through to an open local session. Browser
session behavior is retained. Pairing invitations and device issuance share an
atomic file transaction so a failed write does not consume a token without
creating the device. No data migration or backend database is introduced.

Conversation operations serialize encrypted read/modify/write transactions.
Active turns conflict across phone and desktop with HTTP 409. Active conversations
cannot be deleted while a response is running. Completed local and mesh replies
are persisted on the owner's node before completion is reported. See the corrected
[SSE contract](SSE_SCHEMA.md); requests are not durably deduplicated after restart.

## Verification and release boundary

The [Household Notebook checkpoint](HOUSEHOLD_NOTEBOOK.md) adds private note
editing, explicit question attachments and shared answer receipts to the
existing native app. It uses the existing encrypted memory endpoints. Source
changes and local JavaScript exports do not replace installed native builds.

Settings also includes [Data & Recovery](DATA_RECOVERY.md): an explicit check of
the owner's Notebook, conversations and diagnostics on the paired TLI host.
Unavailable data and stale results remain visible. Manual guidance does not claim
a backup exists, and the phone does not hold a separate backup of these stores.

See the [dated validation record](TLI_COMPANION_VALIDATION.md) for completed checks,
cloud build results and the physical-device acceptance still required.

Run backend tests with temporary data and inert integrations:

```powershell
backend\.venv\Scripts\python.exe -m pytest backend/tests/ -q
$tliTests = @(rg --files frontend/tests -g '*.test.cjs')
node --test $tliTests
cd mobile
npm run check
npx expo install --check
npx expo export --platform ios --platform android --output-dir dist
```

`scripts/verify_companion_browser.cjs` checks the desktop pairing panel in an
isolated headless Edge browser using Playwright. It tests same-origin CSP loading,
literal untrusted labels, duplicate clicks, revocation, setup guidance and 390px
layout. It never calls a live TLI installation. Set `NODE_PATH` to a Playwright
installation if it is not otherwise available. Screenshots are generated under
the ignored `mobile/build-inspect/browser/` directory.

Cloud builds use the private Expo project `@sergeantseven/tli-companion`. The
root `.easignore` is an explicit mobile-source allowlist; EAS directory traversal
requires directory negations without trailing slashes. Before uploading, inspect
an archive and verify the native module is present and backend/runtime data,
models, secrets, signing credentials and build caches are absent. Desktop
distribution packaging excludes the separate mobile project.

Automated tests and compilation do not establish physical iPhone/Android TLS,
camera, screen-reader, keyboard, Wi-Fi-loss, or background/resume behavior.
The native module README lists those release checks. iOS simulator builds verify
compilation only; signed iPhone distribution also needs Apple developer credentials
and registered devices or TestFlight setup. No app-store publication is performed
by these source changes.
