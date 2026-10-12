# Current Companion beta delivery

The current signed Android testing candidate is **TLI Companion Beta 0.1.0 (13)**.
It adds clearer saved and nearby connections, recovery after Android network
changes, and bounded alternative-route checks for reviewed hosts. Shared Chat,
documents, conversation settings, Tools and Builder remain available through the
home TLI workspace. Physical release acceptance remains open.

Published for testing with [TLI 1.4.5-beta](https://github.com/TheLANIntelligence/TLI/releases/tag/v1.4.5-beta)
on the [production download page](https://thelanintelligence.com/download/).
Update the home host first, then install the APK over the existing Companion Beta.

## Get the candidate

- [EAS build 13](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/a0dc87dd-931e-4dc6-839e-ad94c23879a3).
- [Download the signed Android APK](https://expo.dev/artifacts/eas/paWw-BklhUOrb2YdMIm1AmvYhlCf_R1bpXOcU6sgrsc.apk).
- [Verified local APK](../build_work/seamless-mesh/TLI-Companion-Beta-0.1.0-13.apk).
- Package: `com.thelegatointelligence.companion.beta`; public version `0.1.0`;
  Android version code `13`.
- Android v2 signature verified; package and signer match the verified Beta10:
  `bb85fe308fb491a6e0335385edb4c56153b3296ab7cbe6cd3a672154d6ad6b60`.
- APK SHA-256:
  `57eff05b957a93f422a9848baacc8158b4d389c6cf8a75ab9ad233204edd825c`;
  124,712,045 bytes.

Install as an **update over the existing TLI Companion Beta**. Keep the same app
and its data: do not uninstall it or clear app storage. The package, signing
lineage and pairing-storage identity are preserved. This permits an in-place
update, but retained pairing after installation still needs verification on a
real phone.

Update the home TLI host before testing the new connection features, retaining
its existing runtime state and following its normal update/restart process.
See [Seamless TLI connections](TLI_SEAMLESS_CONNECTIONS.md) for host preparation
and the matching acceptance procedure, and
[Shared TLI workspace](TLI_SHARED_WORKSPACE.md) for phone workflows. New features
are capability gated on older hosts. The host holds the workspace and must be
running and reachable; start with both devices on the same home network.

For a fresh pairing, open **Connect device** on the updated desktop, select the
phone flow and create a fresh QR code. Scan it with the phone camera, open TLI
Companion Beta and review the host. Keep existing pairings when updating. Moving
an old literal-IP pairing to a stable hostname requires a reviewed invitation
upgrade; discovery cannot silently change the saved identity or certificate.

## What changed

- Saved and nearby connections distinguish discovery, saved permission and
  verified reachability. Seeing a host does not grant access. Computer trust and
  network setup remain explicit desktop-owner workflows.
- Android gathers multiple NSD address hints and uses bounded private DNS
  alternatives for reviewed hostnames. A route must pass the exact saved TLS
  certificate, hostname and signed identity challenge before receiving
  credentials. Only a proven route becomes active.
- Android network callbacks invalidate a previously active route when the local
  network changes. Foreground recovery verifies again and reads accepted Chat or
  Builder work by its existing run ID. It does not replay an uncertain message,
  action or generation, or silently choose another model.
- Chat remains the entry screen. Tools exposes conversations, active host work,
  settings, models, reviewed documents and Builder. Accepted work continues on
  the host while the phone is interrupted; retained drafts remain separate.
- Documents use bounded uploads and host extraction receipts, with provider and
  capability checks before submission. Builder retains immutable app versions,
  source review, ZIP export and the isolated Android preview.
- The native preview preserves the opaque iframe and response-header CSP inside
  a credential-free WebView. Generated code receives no TLI session or bridge;
  network loading, file/content access, permissions and navigation are disabled.
  Generated smoke checks are advisory. Hostile-content isolation still requires
  device testing.

## Verified

| Gate | Result |
| --- | --- |
| Mobile source | Strict TypeScript and 255 tests passed |
| Exports | Android, iOS and web JavaScript exports passed |
| Exact upload contents | 120 mobile-only files, 982,077 bytes; working, frozen and inspected upload hashes all matched, with no unlisted upload files |
| EAS Android release | Transport and preview native suites passed: 35 tests; release assembly and signing succeeded |
| Downloaded APK | Correct Beta package, public version and build 13; Android v2 signature verified and signer matches Beta10 |
| Compiled features | APK contains native network tracker, route resolver, pinned transport and preview classes; bundle contains connection protocol, saved/nearby UI, host runs and Builder markers |
| Physical Android and LAN | Not run: update/pairing retention, document picker/share sheet, preview egress, background recovery, two computers, DHCP/sleep/multiple adapters/blocked multicast/WAN-loss behavior |
| Native iPhone | Not built or physically tested; JavaScript export does not replace native validation |

Existing remote signing credentials and the Beta package identity were reused.
The Android APK is distributed separately from desktop packages; no iPhone
package or on-phone model is included.

## Evidence and remaining gates

- [APK verification](../build_work/seamless-mesh/android-candidate-verification.json),
  [source manifest](../build_work/seamless-mesh/android-source-manifest.json),
  [upload comparison](../build_work/seamless-mesh/android-source-verification.json),
  and [cloud native evidence](../build_work/seamless-mesh/cloud-native-evidence.json).
- [Mobile checks](../build_work/seamless-mesh/mobile-check-final.txt) and
  [Android, iOS and web exports](../build_work/seamless-mesh/mobile-export-final.txt).
- [Connection acceptance matrix](TLI_SEAMLESS_CONNECTIONS.md#rollout-and-acceptance),
  [shared-workspace acceptance gates](TLI_SHARED_WORKSPACE.md), and
  [native preview policy and device matrix](../mobile/modules/tli-preview/README.md).
- [Preserved Beta9 delivery](TLI_COMPANION_BETA9_DELIVERY.md) and
  [previous Beta10 verification](../build_work/phone-workspace/beta10-candidate-20261012/apk-verification.json).

This is a signed candidate for full testing. Automated tests and browser fixtures
do not establish real-phone or two-computer acceptance. Record in-place update
and pairing retention first, then normal use, Wi-Fi interruption, background
recovery, DHCP changes and changed-certificate rejection. Verify that accepted
work produces no duplicate messages, actions or Builder revisions.

Files/mesh sharing, Vault/routine editing, broader native tools and voice remain
follow-up work. Away-from-home routing, workspace replication, host failover,
on-phone inference and native iPhone delivery remain outside this implementation.
