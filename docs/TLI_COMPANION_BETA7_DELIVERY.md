# Historical Companion Beta7 delivery

This is the current native delivery record for the **finish the fix**
checkpoint. Earlier build records remain historical evidence. A successful build
and compatible signature do not establish that a physical phone retained its
pairing or completed a scenario.

## Android candidate

Beta **0.1.0 (7)** built successfully from the existing internal `beta` profile
and EAS project. Its APK signature, package and higher build number are verified
against the retained Beta6. Do not substitute a prior APK based on the shared
public version `0.1.0`.

- Package: `com.thelegatointelligence.companion.beta`.
- [EAS build a86b04ab-a580-4b9d-be80-367d0a7fa168](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/a86b04ab-a580-4b9d-be80-367d0a7fa168).
- [Local Beta7 APK - local evidence](LOCAL_EVIDENCE.md)
  (**122,100,559 bytes**), SHA-256
  `949691b7c0985f9da21927e959c6016e3c41b75ee3d95f4d9c14b8356d582c25`.
- Android v2 signature verified with Android apksig 8.2.1. Signer SHA-256:
  `bb85fe308fb491a6e0335385edb4c56153b3296ab7cbe6cd3a672154d6ad6b60`.
  Beta6 was freshly verified with the same tool; its package and signer match,
  and its native build number is 6. Neither verification reported errors or warnings.
- Frozen mobile build inputs: **76 files**, fingerprint
  `98042f5f0040d195bbddaedf1991df90fdb9a93bf4447053ac4239aba0ccd2f0`.
- The inspected EAS upload matches those 76 allowlisted files. Private data,
  household configuration, signing credentials and local dependencies are excluded.
- This is a mobile-only source identity. The final host release binds the same
  mobile subtree separately; its whole-source fingerprint is a different value.

Install this APK as an **update** to the existing TLI Companion Beta. Do not
uninstall it or clear its app data. The verified signing lineage permits an
in-place update; retained pairing and actual phone operation remain untested.
Full bindings are in the [update verification - local evidence](LOCAL_EVIDENCE.md)
and [mobile delivery manifest - local evidence](LOCAL_EVIDENCE.md).
The [Beta6 verification and artifact - local evidence](LOCAL_EVIDENCE.md)
remain historical evidence and were not replaced.

## What this phone update adds

Beta7 adds **Review next-check guidance** to a clean saved Troubleshooting case.
Choose the exact whole steps, link descriptions and optional report facts; preview
the report and acknowledge the selection. The guidance separates known saved
details, missing evidence, tried/planned/skipped steps and one available read-only
observation. It is rule-based guidance, not an AI diagnosis or an inferred repair.

**Review suggested check** refreshes its executing host, measured target and scope.
The existing **Run this check** sends the exact case selection and digest for a
final server revision check. It never runs on navigation, attaches to Chat or
replays after reconnect. Saving a report, reviewing its link and saving that link
to the case remain separate actions. Dirty drafts block guidance; conflicts retain
earlier results as historical and revoke their suggested Run. Backgrounding or
credential revocation clears private guidance and ignores late responses.

Partial peer observations now accept explicitly missing measurements with verified
coverage; null values remain unknown. Retained cases may omit optional native-node
metadata, while their selected stable computer identity remains mandatory.
Desktop LAN file transfer does not add a phone transfer runner in this build.

The report, receipt, peer and build-identity features introduced in Beta6 remain:

Saved report and Chat cards display the host's validated recorded facts: executing
host, selected target/process and process start identity, recorded interval,
completed/partial/stopped state, sample coverage and limitations. Host CPU and
selected-process CPU retain different labels. Memory uses MiB; absent samples
remain unknown. These are saved observations, not current health or a confirmed
repair. Invalid identities or malformed summaries show unavailable details.

Historical note receipts identify an earlier exchange, source handle, title and
revision when the source changed or became unavailable. An old `N1` is not a link
to today's note. A case can explicitly include one current linked report's bounded
facts: select, preview, acknowledge, then send deliberately. Navigation does not
load report facts into Chat; conflicts preserve the proposed selection.

Guided checks opt into the host's additive peer-observation capability. Review
shows the actual executing peer and selected inventory target. The response must
match the reviewed identity, scope and observation time; it cannot silently use
the local host. Existing hosts retain their original local choices.

Settings reads the installed app's native version/build/package through
`expo-application`. An explicit host-version check shows startup identity and
whether the host files match, require restart or remain unknown. Matching files
are not a model-quality, phone-compatibility or physical-device certification.

## Verified source evidence

| Evidence | Result and scope |
| --- | --- |
| Companion tests | 183 passed |
| Strict TypeScript | Passed |
| Android and iOS Hermes exports | Passed; iOS export is not a signed iPhone build |
| Android native build | 14 transport JVM tests passed; release assembly passed |
| APK update identity | Signature verification passed; same package and signer as Beta6, native build7 greater than6 |
| Compiled React Native browser preview | 144 checks, 120 screenshots, eight layouts at320/390/760/1440 in light/dark; keyboard and reduced-motion checks; zero errors/overflow; synthetic in-memory host only |
| Latest next-check, case and peer API fixtures | Frozen phone validators accepted actual isolated route envelopes, including exact selected report/step and suggested-run bindings |
| Complete mobile evidence | 102 source/test/config hashes; 76 exact APK upload inputs; no source drift during browser checks |
| Dependency review | No dependency or lockfile change from Beta6; existing `expo-application` reads actual native build metadata |
| Pairing/session/client/protocol/native transport | Source byte-identical to the baseline |

Evidence is retained under `build_work/finish-the-fix`: [complete mobile evidence - local evidence](LOCAL_EVIDENCE.md),
mobile test/typecheck/export logs; [compiled browser report - local evidence](LOCAL_EVIDENCE.md);
and the `android-beta` source/archive/signature records.
No live household or phone operation was performed by these checks.

## Physical acceptance still required

All scenarios below are **not run**. Record phone model/OS, installed native build,
host release identity, time and the observed outcome when a user performs one.

| Scenario | Evidence needed |
| --- | --- |
| Update the existing Beta without uninstalling | Same package and signing identity; higher build number; prior pairing and local data still present after restart |
| Retained connection | Exact paired HTTPS address and identity reopen; failed trust/access does not replace credentials |
| Read-only evidence | Saved partial/stopped report, process scope and old source references remain readable; opening them performs no check or Chat send |
| Reviewed case report | Exact selected report preview and receipt match; stale revision preserves the question and choices |
| Next-check guidance | Saved tried/skipped outcomes and historical scope stay distinct from the suggestion; cancel review before deliberately running; report link saves separately; stale case/report refuses Run |
| Peer observation | Explicit review names the trusted executing peer; revoke/timeout/mismatch never substitutes the local host |
| Wi-Fi interruption and backgrounding | Draft/partial state remains truthful; returning never automatically resends or repeats an action |
| Accessibility | Actual large text, screen-reader order, keyboard and focus work on the recorded phone |
| Optional off-LAN route | User-managed private route reaches the exact paired host with its pinned identity; a same-LAN connection check does not prove remote access |

Use an isolated synthetic host and a suitable test profile/device for scenarios
that would otherwise replace the household pairing or mutate real devices. Do not
copy PINs, tokens, private keys or pairing bundles into test records. Preserve the
installed Beta and its data; signature compatibility alone does not prove retained
pairing. iPhone signing/provisioning, installation and physical acceptance remain
unperformed for this checkpoint.

The [older validation record](TLI_COMPANION_VALIDATION.md) and
[Beta4 troubleshooting acceptance record](TLI_TROUBLESHOOTING_PHONE_ACCEPTANCE.md)
retain their original evidence and unperformed checks. Setup and the existing
private-network policy are in [TLI_COMPANION.md](TLI_COMPANION.md).
