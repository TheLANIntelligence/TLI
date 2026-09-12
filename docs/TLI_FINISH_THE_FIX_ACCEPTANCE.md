# Finish the fix: acceptance record

This record belongs to the [next-check and file-handoff checkpoint](TLI_FINISH_THE_FIX.md).
Software, actual-model behavior and physical-device acceptance are independent.
Final candidate identifiers must accompany every performed physical scenario.

## Candidate identities

- Source: `05f9aa8e95c94d17243b7c5c2b56dfa29c2afbb43f93484d5867353ae27ca071`,
  785 files. Public desktop version remains `1.3.5-beta`.
- Desktop source ZIP: `2adfba0ae0c9fde92d2853ce040665f4d13bb7ebfab20a8d2bf998c720786dc3`.
- Android: `com.thelegatointelligence.companion.beta`, `0.1.0`, native build **7**.
  APK SHA-256 `949691b7c0985f9da21927e959c6016e3c41b75ee3d95f4d9c14b8356d582c25`.
  Signer `bb85fe308fb491a6e0335385edb4c56153b3296ab7cbe6cd3a672154d6ad6b60`,
  matching freshly reverified Beta6.
- [Matched manifest - local evidence](LOCAL_EVIDENCE.md),
  [release report - local evidence](LOCAL_EVIDENCE.md),
  [APK and update instructions](TLI_COMPANION_CURRENT.md).

## Software evidence

| Gate | Status | Scope |
|---|---|---|
| Fresh baseline | Passed | 765 files, fingerprint `57d2b9ab77db3349d91d404c131f97df9e2f95e5301007b51897e29c0ff4d9ca`; 2,633 backend, 1,048 frontend, 169 tooling; no baseline test failures |
| Frozen complete software verification | Passed | 27 stages; 2,741 backend, 2,729 extracted-package backend, 178 tooling, 1,093 frontend and 183 mobile tests |
| Dependency isolation | Passed | Fresh environment, runtime requirements/imports verified before test dependencies; resolved versions recorded |
| HTTPS startup/restart and occupied port | Passed | Synthetic certificates, real PIN/bearer auth, identity/port retention, no HTTP fallback; only harness-owned processes stopped |
| Synthetic upgrade/rollback/recovery | Passed | Recorded pre-Companion commit; preserved newer stores and explicit older-code limitations; no real-data restore |
| Next-check review and backend binding | Passed | Selected evidence/target/revisions, stale review refusal, separate Run and report/link outcomes; no actions on review/navigation |
| Secure transfer software | Passed | Account/peer/consent, bounded encrypted staging, exact receipts, lost responses, cancellation/revocation, missing keys, Windows parent replacement and malformed inputs |
| Actual loopback HTTPS transfer | Passed | Seven production-transport checks using two owned synthetic listeners; PIN, TLS, signatures, complete hash and receiver lock; eight focused tests and parent-exit cleanup proof |
| Browser next-check layouts | Passed | 8 workflow checks, 188 layout cases, 23 themes, Modern/Classic, desktop/tablet/390/320, enlarged text/reduced motion |
| Browser transfer layouts | Passed | 80 checks, 66 layout cases, 23 themes, Modern/Classic, desktop/390/320, keyboard/enlarged text |
| Compiled Companion web | Passed | 144 checks, 8 layouts, 120 screenshots; synthetic transport, not physical Android |
| Mobile source/exports | Passed | 183 tests, TypeScript, Android and iOS exports; same frozen mobile source as host candidate |
| Android artifact/signing | Passed | Beta7 v2 signature and Beta6 signer/package match, 76 upload inputs and 102 full mobile source files match candidate; 14 native build tests |
| Actual Standard collection/preparation | Passed | 19+1 baseline versus 15+5 final model/deterministic replies; JSON/SSE preparation agrees; no timeout/truncation, child runtimes stopped, source unchanged |
| Actual Standard answer quality | Failed | Full passes 5/20 → 8/20 from routing; final factual replies 5/5, model replies 3/15; false historical actions and context errors remain |

Software success does not clear the model-quality failure. Read the
[dimension scores and failures](TLI_FINISH_THE_FIX_MODEL_CHECK.md). Model
selection and recommendation are unchanged. One original final run was
superseded by test-harness hardening; another reached its 300-second source-suite
bound during concurrent work. Both attempts are retained. The unchanged source
then passed the complete serialized run. Source/extracted backend warnings
remain recorded (5,270/5,269).

Repository-only packaging tests and the Git-dependent older-reader case run in
the source suite; those are the only explicit extracted-suite exclusions.
The old compatibility commit is not a published anniversary release and cannot
read every newer feature. Older launch settings require equivalent explicit
environment configuration; newer note metadata is preserved without old-code
writes. No source/data migration is implied.

## Physical device evidence

No phone or household peer has been operated to fill these rows. A compiled
mobile-web screenshot is not native Android acceptance. An APK signature check
does not prove installation or retained pairing.

| Scenario | Status | Required record |
|---|---|---|
| Beta6 update in place, without uninstalling | Not run | Device/model, Android version, old/new build, package/signature, result |
| Original pairing retained after app and host restart | Not run | Same host identity/address and original pairing; manual restart recorded |
| Wi-Fi loss/background during chat and guided check | Not run | Interrupted state, preserved draft/text and no automatic request replay |
| Same problem and report continued on desktop and phone | Not run | Case/report IDs, selected computer, observed time, reviewed revision |
| Case/report revision conflict before Run | Not run | Stale review rejected, no check executed, draft preserved |
| Two updated computers review identities and permissions | Not run | Both source IDs, OS versions, identities, origins and explicit consent |
| File offered, accepted and verified by the intended receiver | Not run | Transfer ID, safe filename, byte count/hash and both host identities |
| File declined/cancelled or access revoked mid-transfer | Not run | No later content delivery; exact partial/uncertain receipt; prior files preserved |
| Lost acknowledgement and deliberate reconciliation | Not run | Status reviewed, no duplicate publication or automatic replay |
| Native accessibility and permission recovery | Not run | Large text, screen reader, keyboard/camera/LAN permission behavior |

Use synthetic, non-sensitive files and cases for acceptance. Keep the current
production Companion installed and its original pairing intact. A test that
cannot be performed stays **not run**; neither elapsed time nor availability of
a build is acceptance evidence. Signed iPhone distribution, native desktop
installers and remote Companion connectivity remain separate checkpoints.
