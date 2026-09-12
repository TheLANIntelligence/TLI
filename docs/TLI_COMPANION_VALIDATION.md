# Companion beta validation — historical records through 2026-09-07

For the current native candidate and its checks, use
[Current Companion beta delivery](TLI_COMPANION_CURRENT.md). The pause and signing
limitations in this older checkpoint do not describe the current Android work.
Physical testing remains a separate, unperformed gate.

The companion source and desktop integration are implemented. This record separates
automated evidence from the physical-device acceptance needed before inviting beta
owners. Setup instructions are in [TLI_COMPANION.md](TLI_COMPANION.md).

## Anniversary matched-build checkpoint — September 7

The [matched beta and recovery record](ANNIVERSARY_BETA.md) was the candidate
record for this historical checkpoint. Its frozen source fingerprint is
`e4b428c6657303cb2f4aeaf1ccd5b69af8da48fb4d9350a0ab00f1465de34d4d`.
Source checks passed: 656 backend, 644 extracted-package backend, 141 desktop,
83 Companion and 40 release-tooling tests, strict TypeScript, both Hermes exports,
fresh runtime dependencies, actual HTTPS restart and synthetic historical rollback.

This candidate uses separate **TLI Companion Beta** application identifiers;
the original Companion and its pairing remain untouched. Native results are in
`build_work/release-snapshot-pa351kk9/native-builds.json`. Android Beta **0.1.0 (2)**
built successfully with 13 native transport tests and exact mobile-source
equivalence to this desktop candidate. iPhone signing awaits interactive Apple
login and physical-device provisioning. Physical iPhone and
Android acceptance is still **not run**; automated source checks do not complete
that gate. The older artifacts below remain available as historical evidence and
must not be mistaken for these anniversary beta builds.

## Automated evidence

| Check | Result |
|---|---|
| Full isolated backend regression suite | 369 passed; real authentication tests use temporary state and inert integrations |
| Existing frontend Node regression suite | 64 passed |
| Mobile TypeScript and client/parser tests | Strict typecheck passed; 15 tests passed |
| Expo dependency alignment | Passed |
| iOS and Android Hermes exports | Passed |
| Desktop pairing in headless Edge | Passed: CSP loading, literal untrusted labels, duplicate clicks, revoke, setup guidance and 390px layout |
| Native autolinking and syntax | Both platforms passed; actual cloud compilation also passed for the initial builds |
| Android release and JVM transport tests | Final signed APK built successfully; 13 native JVM tests passed in EAS; packaged camera/network permissions and SecureStore backup exclusions verified, microphone permission absent |
| iOS simulator release | Final Xcode build passed; packaged LAN/camera/photo descriptions and scoped ATS settings verified, microphone declaration absent |

Backend coverage includes single-use invitation expiry/reuse, concurrent redemption,
revocation, invalid bearer precedence, HTTPS enforcement, cross-owner resources,
TLS key/date/SAN validation, split/interrupted chat streams, simultaneous browser and
phone submissions, conversation deletion during a turn, durable completion, local
and mesh history continuity, retained provenance, partial scene outcomes, validated
images, metadata removal and zero-retention behavior. Passing tests use fixtures;
they do not prove a particular printer, model or phone works in the field.

Android's native tests use the production pinned client with real JVM TLS handshakes
and certificates generated in memory. They cover paired success, a different leaf,
a reissued leaf with the same public key, expired/future validity, hostname mismatch
and redirects. Rejected connections must write no HTTP headers/body and deliver no
request to the fixture server. Separate policy tests cover private origins, header
and path injection, HTTP error buffering and incremental UTF-8 decoding.

## Build artifacts

- [Final iOS simulator build](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/a61419f5-0b39-4385-ba89-4ac55ca58859), version 0.1.0 (1), iOS 16.4+.
  Local archive: `mobile/build-inspect/ios-simulator-a61419f5.tar.gz`.
  SHA-256: `4441afa449cc153fc04dafb0d4bef2d81788fa813ec774a72a52ba01cae4c4c0`.
- [Final Android build](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/c26f157c-f4d5-481b-88f3-8f24e0fd08a0), version 0.1.0 (1), Android 7+ (min SDK 24, target 36).
  Local APK: `mobile/build-inspect/tli-companion-c26f157c.apk` (121,841,099 bytes).
  SHA-256: `0e0e969cbc8c2ac1aec9966f1fbf6e6d2bcc346d05b2350d6596b4333ef89111`.

These builds include uncommitted companion work. EAS's displayed Git commit alone
does not identify their full source. Earlier build attempts are superseded by the
final links here. EAS currently reports archive expiry on 2026-09-20.

## Physical acceptance record

The later [screenshot guidance/send recovery checkpoint](COMPANION_SCREENSHOT_CONTINUITY.md)
records newer source checks and local JavaScript exports. It does not replace
the native build artifacts above or claim that physical acceptance is complete.
The subsequent [Household Notebook checkpoint](HOUSEHOLD_NOTEBOOK.md) records
478 backend, 105 desktop and 46 Companion passing tests, typechecking and local
iOS/Android Hermes exports on 2026-09-06. It also remains source-only relative
to the native artifacts above.

The subsequent [Data & Recovery checkpoint](DATA_RECOVERY.md) adds explicit saved
data checks and recovery guidance to both clients. Its final suites passed with
549 backend, 115 desktop and 56 Companion tests. Strict TypeScript checks and
local iOS/Android Hermes exports passed. Installed native artifacts above remain
unchanged; this checkpoint is source-only too.

The [safe startup and connection recovery checkpoint](SAFE_STARTUP_COMPANION_RECOVERY.md)
adds persistent reviewed startup settings, protected security preflight, latest
connection results and reviewed pairing replacement. Its final suites passed with
648 backend, 138 desktop and 78 Companion tests. Strict TypeScript and local
iOS/Android Hermes exports passed on 2026-09-06; output is
`mobile/.expo/verification-connection-recovery-20260906` (ignored).
The native build artifacts above still predate this source.

All rows below remain **not run** on both a physical iPhone and Android phone.
Record the device/OS, TLI host version, model, result and reproduction details when
testing; do not record pairing bundles, credentials or private photos in issue logs.

| Journey | Required observation |
|---|---|
| Fresh install and pairing | Scan desktop QR without typing an address; confirm host; restart phone app and reconnect using protected credentials |
| Normal host restart | Save reviewed HTTPS/LAN/port choices, stop/start an isolated host normally, and confirm actual URL, identity, PIN enforcement and phone reconnection; check environment overrides explicitly |
| Replacement pairing | Keep current credentials through trust, identity, access and storage failure; cancel while verifying; confirm a successful durable selection after an app restart; old cleanup cannot erase the new pairing |
| Permission recovery | Deny and later allow camera/local-network access; photo-library selection remains deliberate; no microphone prompt |
| Native trust rejection | Wrong, expired and hostname-mismatched certificates fail before the test server receives credentials or an image; replacement requires fresh pairing |
| Revocation | Remove phone access on desktop; next request ends its session and cannot fall through to anonymous access |
| Today and favorites | Dates and stale state are clear; a favorite control is reachable within two taps; useful updates open device/conversation context |
| Home and scenes | Verify a successful control against observed device state; mixed-success scenes show individual failures |
| Photo troubleshooting | Capture a printer error, preview, select the printer, attach existing diagnostic evidence and explicitly send |
| Desktop continuity | Open the same conversation ID on desktop; follow up using earlier analysis and preserve known host/model provenance |
| Household Notebook | Create/edit a note across phone and desktop; reject concurrent stale edits; attach reviewed notes explicitly; retain them after a failed question; reopen an answer receipt and identify edited/deleted references |
| Data & Recovery | Start checks explicitly; distinguish readable/unavailable/not-created/not-checked sample stores; preserve stale results after Wi-Fi loss; invalidate responses after backgrounding or pairing changes; verify guidance and large text without modifying original data |
| Vision and image recovery | Text-only model explains unavailable vision; unsupported/oversized images fail clearly; no automatic model switch/download or image retention |
| Wi-Fi loss and resume | Interrupt both chat and a command; show uncertainty/interruption, queue nothing and never automatically replay the request |
| Background and keyboard | Cancel active work on background; refresh reads on return; keep message and Send controls visible above the keyboard with photo preview |
| Accessibility | Check largest text sizes, VoiceOver/TalkBack reading order and labels, light/dark contrast, comfortable targets and portrait safe areas |

## Signing boundary

EAS is configured for `@sergeantseven/tli-companion`; uploaded archives contain
only the mobile allowlist. Conversations, runtime data, models, private TLS keys
and desktop sources are excluded. Android signing credentials were created in EAS.

EAS initially had no suitable iPhone internal-distribution signing credentials.
The owner has confirmed an enrolled Apple Developer account and is completing
interactive sign-in and device registration in a separate terminal. No signed
iPhone preview has been submitted yet. The simulator artifact is not installable
on an iPhone. These changes do not publish either app to a store or restart the
owner's live TLI installation.
