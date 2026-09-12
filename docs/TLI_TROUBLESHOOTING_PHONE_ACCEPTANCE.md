# Dependable troubleshooting: historical Beta4 Android acceptance

This preserves the Beta4 candidate and its unperformed scenarios. The current
candidate is listed in [Current Companion beta delivery](TLI_COMPANION_CURRENT.md);
the older build numbers and artifact hashes below are not current installation
instructions.

This is a physical-device record, separate from the browser preview, TypeScript
tests, native TLS tests and successful APK compilation. A software check does not
turn an unperformed phone scenario into a pass.

## Candidate identity

- App: **TLI Companion Beta**, public version **0.1.0**, Android build **4**.
- Package: `com.thelegatointelligence.companion.beta`.
- EAS build: `eab13feb-aab6-4748-a6e3-028ec434307e`.
- Frozen mobile source: the mobile subtree of source
  `134bb34b51dfe82f19ca290fed80d7348998ca5810feabc6026ee61947e014ea`.
- APK SHA-256: `06152bba2eaa31e59f596c3cd990dc13b98ee9b51408555549262c04df256afe`.
- APK v2 signature verified with Google Android apksig 8.2.1. The signer matches
  freshly verified Beta 3:
  `bb85fe308fb491a6e0335385edb4c56153b3296ab7cbe6cd3a672154d6ad6b60`.
- Native Gradle tests: **14 passed**; assembly passed. The inspected upload has
  exactly the 67 intended mobile source files. See
  `build_work/dependable-troubleshooting/android-beta/delivery-manifest.json`.
- Those 67 mobile build inputs have fingerprint
  `1cbbac0b3b7fbb4f22dd4dc2b0f03a00765a393f2ab0fc768f642f0fe1aced43`
  and are unchanged in the final host-source candidate.
- Final host-source identity:
  `cd5cc508c888457727c4cd6456d89b9d64810d35a8032f486f5c08fd41845f2e`.
  Its isolated verifier is `source_verified`; the report is under
  `build_work/dependable-troubleshooting/final-release/release-snapshot-reedl3cv`.
  The combined `build_work/dependable-troubleshooting/delivery-manifest.json`
  binds the APK and final host source. Do not substitute another APK based on its
  displayed version alone.
- Physical device / Android version: **not recorded**.
- Current status: **not run**. No existing pairing has been replaced for testing.

## Preserve the existing beta

The verified APK must have the same package and signing identity as Beta 3 and a
higher native build number. Install it as an update; do not uninstall the existing
beta or clear its app data. An update can retain pairing storage, but signature
compatibility alone does not prove that the phone retained or reopened it.

First check that the original pairing is still visible after updating and
restarting the app. Record the result without copying its token, PIN or bundle.
Use a separate Android test profile/device for synthetic-host pairing when
available. Otherwise, keep the household pairing intact and leave scenarios
requiring another pairing **not run** until there is a suitable test arrangement.
Do not replace household credentials merely to complete this table.

## Scenarios

Use an explicitly launched isolated LAN host with synthetic notes, conversations,
cases and provider/device responses for mutation and interruption checks. Record
its source identity and test-device identity with every result. Read-only review
of an existing pairing is not permission to run household actions.

| Scenario | Required evidence | Result |
| --- | --- | --- |
| Update without uninstalling | Installed package/build and prior pairing remain present; original app data was not cleared | Not run |
| App restart | Same paired host and identity reopen; host and AI readiness are reported separately | Not run |
| Normal isolated-host restart | Saved HTTPS address and identity remain; phone reconnects without creating a replacement pairing | Not run |
| Wi-Fi interruption | Interrupted text/draft remains where supported; reconnect does not send another message or repeat a check | Not run |
| Background/foreground | Late responses do not restore a dismissed review or execute work; return offers deliberate continuation | Not run |
| Stop a conversation | Partial answer is identified as stopped/interrupted and is not presented as complete | Not run |
| Evidence and context controls | Earlier conversation and Use saved notes reach the host contract; receipts identify supplied evidence without claiming the interpretation is verified | Not run |
| Guided checks | Review shows executing host, target, scope and internet contact; only explicit Run creates a check | Not run |
| Link/save conflict | A saved report survives a conflicting case save; draft remains and no diagnostic reruns automatically | Not run |
| Phone-to-desktop continuation | Same case/conversation IDs reopen; reviewed report link and outcome are visible, without automatic Chat submission or evidence attachment | Not run |
| Accessibility | Large text, keyboard, screen-reader order and controls remain usable on the recorded phone | Not run |

For each performed row, record **passed**, **failed** or **not run**, the timestamp,
device/OS, installed app build, host-source identity and a brief observation. Keep
failures visible. A failed row requires a concrete correction and another matched
candidate before repeating the affected check. Remote access and signed iPhone
distribution are outside this acceptance batch.
