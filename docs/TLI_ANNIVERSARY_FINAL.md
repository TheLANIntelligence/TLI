# TLI anniversary: final testing checkpoint

Remote access is **deferred**, as requested. The anniversary software is assembled
into one source-bound desktop test package and the existing Chat-first Android
Beta8. This is ready for extensive hands-on testing; it is not a claim of physical
device validation or universally correct AI answers.

**Start here:** [hands-on guide](TLI_ANNIVERSARY_HANDS_ON.md) ·
[everything upgraded](TLI_ANNIVERSARY_UPGRADE_SUMMARY.md) ·
[review gallery - local evidence](LOCAL_EVIDENCE.md) ·
[source and artifact manifest - local evidence](LOCAL_EVIDENCE.md).

## What this completion pass did

- Preserved the resumed working-tree source before changes. The original paused
  baseline and prior delivery artifacts remain available; nothing was reset or
  stashed.
- Archived the unfinished remote-only backend and mobile additions with hashes,
  then restored the accepted pairing/readiness and Settings behavior. No private
  network, route, firewall or public exposure was configured.
- Matched all **77 mobile upload inputs** to the verified Beta8 APK. After
  archiving the unfinished remote-only files, the accepted mobile tree passes
  all 191 tests and strict TypeScript without test filters. No rebuild, new native
  version or credential change is needed.
- Corrected an optional room-display lifecycle race: a queued close event from
  the previous opening could clear a newly reopened display. A reproduced old
  failure, focused regression and real browser checks cover the fix.
- Completed a new prospective Standard-model evaluation, including a newly frozen
  24-question confirmation set and the retained 20 development questions.
  The experimental case-answer preparation was rejected because it introduced regressions. Its source and results are archived; the accepted package restores the previous preparation.
- Completed clean installation, extracted-package, HTTPS restart, rollback,
  recovery, frontend, mobile and all-theme verification. Release exports now
  explicitly clear Metro's transform cache; the expanded full suites retain
  bounded timeouts sufficient to finish.
- Consolidated current delivery information and corrected stale Beta7 wording.

## What the anniversary now includes

| Area | Implemented scope |
|---|---|
| The home console | Cohesive navigation, page layouts, status and feedback; full Modern and Classic interfaces; 23 palettes; searchable destinations and retained work; a read-only historical retrospective. |
| Conversation | Local/provider-aware Chat, visible working states, shared history, deliberate earlier-conversation and saved-note controls, selected images/documents/report context, source receipts and reviewed handoffs. Companion opens Chat with a persistent message field. |
| Useful reference | Notes & fixes, source and revision distinctions, reviewed saved answers, selected-note questions, PDF/DOCX text review, optional explicit related-note retrieval and user-entered relationships. |
| Troubleshooting | Symptom entry, an explicitly selected computer, known/missing/already-tried facts, one reviewed eligible check, linked reports, manual outcomes, revision conflicts and saved-work preservation. An outcome is not an automatic repair. |
| Performance & apps | Bounded host/process observations with exact process identity, partial/unknown readings, Stop, explicit report saves and reviewed next steps. No automatic tuning or causal/FPS claims. |
| Storage and Files | Explicit quick/deeper jobs, cancellation, retained results, location navigation, hierarchical map and matching file records, independent searches, reviewed Trash operations, per-file receipts and guarded Files operations/undo. |
| Vault and recovery | Passphrase-protected Vault states; complete scoped portable Vault backup; saved-work archives; Check/Create/Verify; authenticated separate-folder recovery with current-reader checks and source preservation. No merge over live data. |
| Computers and LAN | Stable computer identity, reviewed bilateral trust, supported peer observations, encrypted consent-based file handoff, LAN messages and clear target/scope reporting. |
| Awareness and existing tools | Narrator/catch-up, saved places, reviewed manual routines, device/room relationships, optional room display, existing smart-device, printer, utility, script, Builder and Hub workflows with explicit effects and prerequisites. |
| Optional extensions | Configured push-to-talk, image assistance, reviewed MCP/HA interfaces and temporary embedding search retain their existing narrow implementations. Real service/hardware acceptance is separate; no automatic trigger executor or unrestricted autonomous repair is introduced. |

The [capability reference](TLI_CAPABILITIES.md) gives the actual prerequisites and
limits. Earlier roadmap paragraphs describe historical checkpoints; they do not
override the current explicit deferral of remote access.

## Matched software verification

Final source: **796 files**, fingerprint
`4e36dcadc8b45e3ca0a98da73468bc91365493d30c8b641a2c6759c91150e190`.

| Check | Result |
|---|---|
| Fresh pre-pause baseline | 2,769 backend, 1,132 frontend and 178 tooling passed; no pre-existing suite failures. The earlier interrupted run remains recorded as incomplete. |
| Complete release verifier | All 27 software stages passed |
| Repository backend | 2,769 passed |
| Extracted-package backend | 2,757 passed; only repository packaging tests and the Git-dependent previous-reader test excluded here and run in the repository |
| Desktop frontend | 1,133 passed |
| Tooling | 178 passed |
| Companion | 191 passed; strict TypeScript passed |
| Mobile exports | Android, iOS and web passed with an explicit clean Metro rebuild |
| Installation and recovery | Fresh runtime-only import before test dependencies; resolved dependencies recorded; owned loopback HTTPS/PIN stop/restart; occupied test listener preserved; synthetic upgrade/rollback/return and restored-copy reads passed |
| Modern and Classic | 36 behavior checks, 664 layout scopes, all 23 themes; no product failures or source drift |
| Broader theme audit | 552 layout scopes and 115 enlarged-text scopes; no overflow or contrast failures; saved settings preserved |
| Room display | 15 focused tests, 11 theme checks and 3 full-SPA flows passed; exact relevant final source bound |
| Android artifact | Beta8 package/build, valid signature and signer compatibility with Beta7 already verified; all 77 upload inputs match the final source |

Overlapping checks are not added together as unique coverage. Browser records use
synthetic data and intercepted requests, not real household acceptance. The
compatibility commit `a5f2104f134a0d0fe482e4b65acadd515699d2fb` predates Companion;
it is an explicit synthetic compatibility reference, not a previously published
anniversary release.

An older theme-audit script failed its restoration assertion because it cycled
the applied palette without restoring the initial one. The failure is retained.
The corrected audit calls the real theme controller to restore the palette, then
keeps both original storage and selection assertions. No product assertion was
weakened and no production theme fix was needed. Deprecation warnings remain in
the complete test logs and are not represented as failures or silently removed.

## AI quality is a separate result

The trial did not meet the frozen retention gates. On the 15 retained model questions, grounding fell from 12/30 to 10/30 and four questions gained a zero score in at least one dimension. On the 24 newly frozen confirmation questions, some totals improved, but truthful-action scores fell from 41/48 to 40/48, one critical invented-action answer remained, six questions gained a zero score and one response hit its output limit. Both versions fail the strict quality gate. The previous preparation is retained to avoid accepting that regression; it is not a validated winner. Active model selection and the default remain unchanged. Baseline preparation inputs were checked against the accepted source without running more inference; the rejected trial's answer scores are not attributed to the delivered preparation.

See the [actual model check](TLI_ANNIVERSARY_FINAL_MODEL_CHECK.md) for frozen
questions/scoring, baseline and candidate answers, timing/load, source bindings,
separate automated/agent assessment and failures. No model was downloaded,
selected, installed or substituted during this completion pass. Only owned
evaluation processes were stopped; the existing live model was untouched.

## Artifacts and acceptance still requiring people or hardware

- [Desktop source test package](https://github.com/TheLANIntelligence/TLI/releases/download/anniversary-preview-1/TLI-Anniversary-Preview-1-source.zip), SHA-256
  `ccc89756dc9a2def512607a8e8e39504cb66c50c86a5e6266b5b96a51caaa80c`. It excludes private runtime data and models and preserves
  required bundled runtime files. It is not an in-place updater or a native
  installer; test from a separate location and retain the existing installation.
- [Android Beta8](TLI_COMPANION_CURRENT.md): public version `0.1.0`, native build
  `8`, package `com.thelegatointelligence.companion.beta`, SHA-256
  `bacc0c4063f48527f54ab0196c9c58cd642e482548b310eaaf177390e377b5ff`.
  Install **over the existing Beta without uninstalling or clearing its data**.
  Reusing the already signed, source-matched artifact avoids unnecessary rebuilds.
- Physical Android update, retained pairing, real keyboard, interruptions,
  ordinary AI replies and desktop continuation: **not run**.
- Actual two-computer trust/observations/message/file handoff, physical room
  display/sensors, screen-reader and optional service acceptance: **not run**.
- Signed iPhone distribution, native Windows/macOS/Linux installation,
  in-place production upgrades and real-data restores: **not run** in this pass.
- Remote access, automatic rechecks/repairs, background learning, new model
  families and expanded integrations: **deferred**.

Use the [hands-on guide](TLI_ANNIVERSARY_HANDS_ON.md) and
[candidate acceptance record - local evidence](LOCAL_EVIDENCE.md) to record each result separately.
Automated verification did not restart live TLI, change model selection, pair a
phone, move household files or operate real devices. Restart the normal host only
when you choose to load the completed backend changes; refreshing a browser page
does not reload Python code.
