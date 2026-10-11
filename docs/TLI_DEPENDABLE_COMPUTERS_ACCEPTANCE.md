# Dependable computers: acceptance record

This record separates software verification, model-quality evidence and physical
acceptance. The matching source, reports and artifacts are recorded in
[`final-manifest.json`](../build_work/dependable-computers/final-manifest.json).
The [review gallery](../build_work/dependable-computers/review.html) shows synthetic
browser and Companion views. It is not the live installation.

## Candidate and software scope

- Desktop: frozen source archive, tested in a fresh Python environment and as an
  extracted installation. Exact final results are in the manifest.
- Android: **TLI Companion Beta 0.1.0, native build 6**, package
  `com.thelegatointelligence.companion.beta`. APK signature matches Beta5.
- iOS: source, TypeScript and Hermes export checks; no signed iPhone build.
- Baseline: 2,508 backend, 1,026 frontend and 168 tooling tests passed before
  implementation. No pre-existing test failures were recorded.

| Verification | Status | Evidence and boundary |
|---|---|---|
| Running-code identity, old-host handling and lock layout | Passed | 84 full-browser checks; no navigation mutations or automatic restart |
| Reviewed trust, signed requests and discovery/revocation races | Passed | 130 focused backend tests including startup/Companion compatibility; three real loopback TLS tests; fake peer/driver boundaries elsewhere |
| Computers/LAN Messages browser workflows | Passed | 90 checks, 74 layouts, 23 themes; both interfaces; new transfers explicitly unavailable |
| Case/report facts, explicit target and failed linking | Passed | 11 full-browser behavior groups, 376 layouts, 23 themes; saved report survives failed case link |
| Original routine credential and target checks | Passed | Synthetic tests cover revocation before binding, between steps and during target revalidation; no household drivers |
| Companion source and rendering | Passed | 170 tests, TypeScript, Android/iOS exports, 72 compiled-web checks and 14 native transport tests |
| Signed Android update compatibility | Passed | Beta6 package and signer equal Beta5; exact 75-file uploaded mobile source is bound to the host snapshot |
| Complete final source/package/recovery integration | Passed | 27 stages: 2,633 source backend, 2,621 extracted backend, 169 tooling, 1,048 frontend, 170 mobile tests; fresh dependencies, HTTPS restart and synthetic rollback |
| Actual Standard answers | Quality limitations confirmed | [Eight development questions](TLI_DEPENDABLE_COMPUTERS_MODEL_CHECK.md): seven real answers and one deterministic summary; zero timeouts, but semantic/continuity failures remain. Primary and independent agent assessments are separate from physical acceptance. |

Browser fixtures cover Modern/Classic, all 23 themes, desktop, tablet, 390/320px,
enlarged text and reduced motion across the listed suites. These are scoped
checks, not a claim that every physical device, screen reader or control has
been manually exercised. The synthetic test backend never uses household data.

## Physical acceptance

No physical device was operated in this checkpoint. Device/OS identifiers and
host identities therefore remain unrecorded rather than inferred from screenshots.
The beta artifact is ready for testing; a matching signature alone does not
prove an on-device upgrade or retained pairing.

| Scenario | Status | Required evidence |
|---|---|---|
| Two TLI computers exchange reviewed cards and reject changed identity | Not run | Both host source IDs, identities, OS versions and approved origins |
| Named peer CPU/RAM/uptime observation and explicit case link | Not run | Selected peer identity, observation time, report ID and case revision |
| Peer disconnect/revoke and deliberate text retry | Not run | Actual interruption result and absence of unintended replay |
| Beta5 → Beta6 update without uninstalling | Not run | Android model/OS, old/new native builds and successful signed update |
| Retained pairing after beta update and app restart | Not run | Original pairing remains usable without replacement credentials |
| Normal host restart with preserved identity | Not run | Same host identity and paired address after manual restart |
| Wi-Fi loss, backgrounding and stopped conversations | Not run | Interrupted text retained; reconnect sends no new message/action |
| Phone/desktop case continuation and revision conflict | Not run | Same case/report identities; conflict preserves the user's draft |
| Physical phone accessibility and permissions | Not run | Keyboard, large text, screen reader and denied-permission recovery |
| Household routine or file cleanup | Not run | Outside automated verification; explicit reviewed user operation |
| Away-from-home connectivity | Not run | Deferred separate remote-access checkpoint |
| Signed iPhone distribution / native desktop installers | Not run | Separate platform-specific builds and installation acceptance |

Existing production pairings, data, model selection and runtime were not
changed to satisfy these gates. Update the existing **Beta** APK in place when
performing Android acceptance; do not uninstall it or substitute the separately
identified production Companion app. Create a new acceptance record if source
or artifacts change.

## Remaining product work

1. Perform the physical two-computer and Android continuity scenarios above.
2. Add a bounded authenticated LAN file-transfer contract before re-enabling
   new transfers. Existing local historical downloads remain available.
3. Continue evidence-grounded answer evaluation. Prior strict comparisons still
   report **no validated winner**; passing transport/UI tests cannot change that.
4. Address remote Companion connectivity as its own reviewed checkpoint.

This checkpoint does not introduce remote repairs, automatic routine execution,
new inference models, voice, household automation expansion or data migrations.
