# Anniversary continuity program — September 8, 2026

The five requested feature areas are implemented together. This is a source and
Beta testing checkpoint, not a claim that every acceptance gate passed. The real
Standard Qwen answer-quality gate **failed**; physical Android upgrade/pairing
and iPhone acceptance remain unperformed. Frozen native Vault recovery is
unavailable in this checkpoint; source/Python recovery is verified in isolation.

## What is available

| Area | Implemented workflow | Preservation boundary |
|---|---|---|
| Vault | Check, create a complete portable backup, verify, and review/recover into a new folder; retrieve a prepared download after leaving the view | Unlocked creation; files and Vault notes plus this account's secrets/logins; new archive password and recovered passphrase; current-reader verification before publication; locked result; no live replacement |
| Useful AI | 23 scored real responses, bounded isolated runtime, source/model/runtime/corpus hashes, Technical details validation record, repeated-line excerpt improvement | Installed weights read only; CPU mode and actual configured context recorded; live inference, selection, household context and devices untouched |
| Phone Companion | Notes & fixes, saved-notes choice, context receipts, reviewed note saves/updates, clearer interruption, Computers/reports, Troubleshooting and connection evidence | Existing pairing keys, Beta identifier and signing lineage; no automatic replay; desktop-only destructive/admin/recovery operations stay on desktop |
| Troubleshooting | Account-scoped encrypted cases with manual steps, stable targets and reviewed evidence links; desktop and Companion entry points | No evidence-body copies or automatic diagnostics; revisions/idempotency, unavailable/changed references and lock cleanup; saved-work v2 supports cases while v1 remains accepted/default for old callers |
| Classic/history | Classic TLI appearance and About → TLI through the years | Modern remains default; current controllers and protections; historical views use synthetic content and execute no archived scripts |

Detailed contracts: [Vault](TLI_VAULT_BACKUPS.md),
[Troubleshooting](TLI_TROUBLESHOOTING.md), and the existing
[Companion guide](TLI_COMPANION.md). The local model record is available at
`/answer-validation.html`; its complete synthetic responses and separate scores
are bundled at `/assets/answer-validation.json`.

## The important AI finding

The reference artifact is `Qwen2.5-3B-Instruct-Q4_K_M.gguf`, SHA-256
`9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94`.
The runtime executable is SHA-256
`3b0ada0e76b1cc5668c7e2bbac7784a6e978de9535aa2ad1f749893f79456e58`.
Conditions were Windows CPU, four threads, 4096-token context, 384 output tokens,
temperature zero, a 120-second startup limit and 60-second request limits.
Every evaluation child was stopped by its owning harness. Other presets were
not evaluated, and model cards do not claim to verify an installed local copy.

All 23 final requests received answers. Nine used current ordinary-chat
preparation, one used current document preparation, five used the production
prompt with synthetic observations and eight retained handwritten stress inputs.
All preparation assertions passed. An earlier complete run fabricated a
historical repair after a note was deleted and denied a cable fix explicitly
included in document line 3. Narrow prompt and document-grounding changes fixed
those two answers in the final full regression, but independent review still
found false technical advice about Unicode paths and an unsupported conclusion
that no further checks were needed from a historical note. Document citations
also remain unreliable. No new live-execution claim, cross-account canary or
ignored saved-notes opt-out was observed in this corpus. This does not establish
safety for other questions. Human/physical user review is not run.

Scores for grounding, useful next steps, context and action claims are separate;
there is no aggregate accuracy percentage. The exact final answers hash is
`441a3de166e31d40265a861212339b92fde64e44a35e021e71765fd8e51af0c6`.
The reviewed AI-source fingerprint is
`cadf80d2af69d1f4b61043ce345f443931eaeb361dfb84f4d3871e61bc786887`;
it is not the whole-release fingerprint.

The final candidate contains one additional source change relative to that
recorded inference run: `tli_state.py` includes Troubleshooting case files in
missing-key protection. The source-byte fingerprints therefore differ; they
are not described as identical. Fresh offline preparation from the final frozen
candidate reproduced **all 23 fixture and model-message hashes** with the same
384-token limit, 4096-token context, temperature zero and other generation
settings. No model execution was repeated for this comparison. The recorded
answers retain their original source identity and failed verdict; the added
case-key protection is covered separately by the final backend tests.
[Exact source difference and request-equivalence evidence - local evidence](LOCAL_EVIDENCE.md).

The failed intermediate trial with an invalid capacity-source receipt enum and
the trial with an incorrectly decoded Unicode fixture remain recorded separately
under `build_work/anniversary-continuity`. They are not acceptance evidence.
The final measurement run corrected both harness defects. Document selection
now prevents identical repeated lines from consuming the entire excerpt budget.
The historical-outcome and document-grounding improvements were retested against
all 23 cases, not just the improved examples. Prompt-only changes did not reliably
correct the model's Unicode misconception across the regression runs. Standard's
answer quality still fails acceptance. That remains an explicit next gate.

## Historical provenance

The earliest retained Git source is
`ff6c4e51a2b8476b1100a89fd964a4413b248afa`, May 3, 2026, labeled
`v1.3.5-beta`. It is an early retained reference, not proof of the project's first
day or a previously published anniversary release. Dashboard, Chat, Vault, Files
and Settings each have early and anniversary exhibits. Local PNG previews and
inert full HTML views contain synthetic examples. Source and preview hashes are
recorded in `frontend/history/provenance.json`.

Classic is appearance only. Neither Classic nor the retrospective rolls back
application code, encrypted data, model selection or configuration.

## Verification and delivery record

Pre-change source snapshot:
`build_work/anniversary-continuity/baseline/release-snapshot-sf4utu1g/source`.
Fingerprint: `6ecd791cb248495f12d061ada69bd40b81b7bea54159598a651adcdcfc2f95b3`.
Fresh isolated baseline: **1702 backend/tooling, 646 frontend and 83 Companion
tests passed**, plus TypeScript. No baseline failures. Existing dependency and
deprecation warnings are distinct from failures.

The final frozen source is **570 files**, fingerprint
`f14d649a2157e88a190a989bbbded8066c136849b1833d272944ced710552d7a`.
The complete fresh-installation verifier reports `source_verified`:

- **1729 backend**, **72 release-tooling**, **675 desktop frontend** and
  **108 Companion** tests passed; TypeScript and Android/iOS Hermes exports pass.
- The extracted desktop package passes **1717 backend tests**, with the one
  Git-dependent previous-reader test explicitly deselected and the
  repository-dependent packaging tests run in the source suite instead.
- Runtime dependencies install in a fresh Python environment and import before
  test dependencies are added. Resolved versions and dependency checks are logged.
- Actual loopback HTTPS startup/restart, PIN/bearer authentication, identity
  preservation, unavailable AI, occupied-port refusal and synthetic
  seed/upgrade/rollback/return/backup recovery pass. Only harness-owned processes
  are stopped. The compatibility commit remains
  `a5f2104f134a0d0fe482e4b65acadd515699d2fb`; its older capabilities are reported
  separately rather than presented as an anniversary release.
- The final source matches the snapshot after all checks. The desktop archive
  SHA-256 is `d2d16da5044d97901d7120427248ddefcd9e641f1788fb1e6350e046361ceb6b`.

Final browser verification covers **190 section views**, **23 themes / 874
layouts**, **115 enlarged-text views**, eight answer-evidence layouts, and
15 Vault behaviors / 15 layouts against the final snapshot. The original theme
command's exit 1 is preserved: it required review of 23 AI-pill gradients, rather
than finding a measured contrast failure. A separate conservative compositing
proof resolves those exact entries, with a minimum 7.845:1 contrast ratio.
The Companion has 40 browser checks and seven actual Android native transport
tests in addition to its unit suite. Keyboard/browser fixtures are not physical
screen-reader acceptance.

[Review all five areas and before/after views - local evidence](LOCAL_EVIDENCE.md),
[read the delivery instructions - local evidence](LOCAL_EVIDENCE.md),
or inspect the [source/artifact/evidence manifest - local evidence](LOCAL_EVIDENCE.md).
The first candidate is retained as superseded: every executed gate passed, then
the source-drift guard correctly rejected it after deliberate final fixes.
It is not the delivered candidate.

Current verification outputs and the source/artifact manifest are under
`build_work/anniversary-continuity`. Focused recovery checks authenticate each
entry, reopen the separate copy with the current application and compare source
bytes. Fixtures cover ownership, missing keys, malformed archives, failed
destinations, cancellation, duplicate operations, revision conflicts and lock
transitions. Browser results are synthetic fixtures, not physical-phone proof.

Android Beta uses version `0.1.0`, native build **3**, identifier
`com.thelegatointelligence.companion.beta`, and the existing EAS project. The
submitted 64-file mobile source fingerprint is
`9e375e5814359c8434725a6490a699838dc00ad682207500ec2972d2e5c20688`.
The build is [b1f25bf4-17b9-4bd8-a37e-2f91d893fbb1](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/b1f25bf4-17b9-4bd8-a37e-2f91d893fbb1).
Its final delivery manifest records the actual APK hash, cryptographic verifier,
package/version and comparison with Beta 2's signer. Update the existing Beta;
uninstalling it would discard app-scoped pairing. A source/export/build pass is
not evidence that an upgrade or retained pairing was tested on a phone.

Remote connectivity, voice, expanded home automation, automatic diagnostic
rechecks, autonomous operation and new model families remain deferred. Signed
iPhone distribution, physical Android upgrade/retained pairing, native desktop
installation, native packaged Vault recovery, real-household recovery and a
physical 4 GiB Vault archive trial are explicitly unverified.
