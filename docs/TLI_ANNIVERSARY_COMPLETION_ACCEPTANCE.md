# Anniversary completion: acceptance record

This record separates software verification, real-model assessment and physical
acceptance. It accompanies [the completion program](TLI_ANNIVERSARY_COMPLETION_PROGRAM.md).
It does not claim a production deployment, a working household VPN or a tested
phone upgrade merely because an archive or APK was built.

## Candidates

| Item | Current evidence |
| --- | --- |
| Preservation baseline | `cd5cc508c888457727c4cd6456d89b9d64810d35a8032f486f5c08fd41845f2e`; uncommitted source preserved |
| Final software candidate | `61db5f3fc236037a27401993a2871dee48d96aac0f4e890a26581f5b431284dd`; 699 frozen source files, 27/27 release gates passed including current-source equality |
| Desktop artifact | SHA-256 `17485b5565542a06d8de716593c51222f81932c6131c8780ab5c32af828c1e2c`; `final-candidate-3/release-snapshot-2e1l0p6a/TLI_candidate.zip` |
| Android Beta | 0.1.0 (5), `com.thelegatointelligence.companion.beta`; build `e976268e-1966-4065-bcf4-a11fb74d0856` |
| Mobile source | 70 inspected source files, fingerprint `10fa98538818f885b04cdd73e1b8ca8aa288ec15e8302070b411c109c24568e2` |
| Android artifact | SHA-256 `05ba3ea8e8ef2985338e225da91dc3bdbb851107f430b6f91ac7f7a5754d6424` |
| Signature compatibility | Passed: APK signature verified and signer matches Beta 4, with version code increased from 4 to 5 |
| Real-model comparison | Six existing CPU presets; 55 scored positions each, including a new 24-case holdout. 328 responses and two timeouts; 54 timing repeats completed. Independent review frozen before unblinding. **No validated winner**; quality acceptance failed |

The signed APK is under
`build_work/anniversary-completion/android-beta/TLI-Companion-Beta-0.1.0-5.apk`.
Its update evidence is in the adjacent `update-verification.json`. Update the
existing **Beta** without uninstalling it. This does not update the separate
production app or prove that its stored pairing survived an actual installation.

## Software checks

| Gate | Result and scope |
| --- | --- |
| Fresh runtime environment | **Passed** on the final candidate; runtime import and dependency consistency checked before test dependencies |
| Backend and extracted package | **Passed**: 2,270 repository tests; 2,258 package tests. Repository-only packaging and Git-reader exclusions are recorded and tested separately |
| Release tooling | **Passed**: 122 tests, including packaging exclusion and published evidence checks |
| Desktop and Companion | **Passed**: 958 frontend tests, 149 Companion tests, TypeScript and Android/iOS source exports |
| Native Android build | **Passed**: 14 native cloud tests and signed APK build; this is not physical acceptance |
| HTTPS, authentication and restart | **Passed** on actual owned loopback processes with synthetic certificates/PIN/data; no HTTP fallback, preserved identity and occupied-port protection |
| Upgrade/rollback/readability | **Passed** synthetic rehearsal against `a5f2104f134a0d0fe482e4b65acadd515699d2fb`; older code lacks Companion/Notebook/startup features. It is not a published anniversary baseline |
| Browser shell | **Passed**: 190 synthetic views, zero overflow/duplicate controls/failed sessions/changed source files |
| Model library, setup and report | **Passed**: 69 card checks and 120 onboarding/manual checks from the final source. 117 static report checks retained through exact HTML/JSON identity; combined record binds 131 screenshot hashes |
| Evaluation-input preservation | **Passed**: 55 exact supplied requests, six launch contracts and 330 published bindings. Two catalogue-description literals are explicitly reviewed; raw whole-source and launch-source equality remain false. Other receipt differences are check timestamps only |
| Feature/theme review | **Passed within recorded component scopes**; all 23 themes exercised in applicable matrices. Corrected `classicTli` views replace earlier incorrectly labeled fallback-theme evidence |
| Local MCP interoperability | **Passed** against official SDK 2.2.0 synthetic loopback servers/clients; does not certify arbitrary third-party tools |

Each browser report records its tested files. A matching feature controller with
later shared-shell changes is component evidence, not an assertion that its
entire screenshot came from the final source. The delivery gallery and coverage
record retain those distinctions.

The [delivery manifest](../build_work/anniversary-completion/delivery-manifest.json)
and [gallery](../build_work/anniversary-completion/review.html) bind the final
artifacts and coverage. Earlier checkpoint passes remain evidence for their own
source. The intervening `final-candidate-2` remains rejected for source drift
after the final onboarding fixes; it is not the delivered archive.

## Physical and configured-service acceptance

Device model, operating system and exact app/host identifiers must accompany an
actual result. None has been supplied for this checkpoint, so the following
remain **not run**.

| Gate | Status | Evidence needed |
| --- | --- | --- |
| Android update without uninstalling | **Not run** | Device/OS, Beta 4 → 5 installation and retained pairing |
| App and host restart | **Not run** | Same paired identity and intended origin after both restarts |
| Wi-Fi loss, backgrounding and stopped chat | **Not run** | Preserved interrupted text/draft where supported; no message or action replay |
| Case conflict and phone/desktop continuation | **Not run** | Synthetic case and evidence opened on both endpoints; conflict preserves edits |
| Private-route access away from Wi-Fi | **Not run** | User-configured routed private network reaches the existing certificate-valid LAN origin; no public forwarding or trust replacement |
| Local speech and playback | **Not run** | Actual browser language-pack support, microphone recognition, reviewed draft and local playback |
| Related-note semantic quality | **Not run** | An explicitly configured existing local embedding server and reviewed synthetic notes; endpoint tests do not prove retrieval quality |
| Real Home Assistant | **Not run** | Explicitly configured server, reviewed entities and user-chosen actions; synthetic transport results remain separate |
| User-installed MCP server/tool | **Not run** | Specific endpoint, reviewed invocation and observed effect; protocol interoperability alone is insufficient |
| Physical room display and device power history | **Not run** | Chosen room/device, reported timestamps/gaps and actual meter support |
| Signed iPhone distribution | **Not run** | Outside this Android-build checkpoint; source/type/export checks are available |
| Native installers and real-data restores | **Not run** | Separate native-platform/real-data acceptance; synthetic recovery does not replace it |

Do not replace household credentials, discard an existing pairing, uninstall an
app or restore over live stores merely to fill this table. Use an explicitly
launched isolated host for synthetic workflow tests. Failure and cancellation
remain visible; a retry must be deliberate.

## Deliberately unavailable automation

Saved manual routines and portable troubleshooting guides are implemented.
The legacy trigger definitions have no active executor. Unattended repairs,
automatic diagnostic rechecks, autonomous marketplace execution and new model
families are not enabled by this release. A guide records reviewed steps; a
routine runs only after its explicit target and action review.
