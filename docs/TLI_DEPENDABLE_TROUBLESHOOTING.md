# Anniversary: a dependable troubleshooting partner

This checkpoint connects evidence, answers and an explicit next check. Software
implementation and final isolated source/package verification are complete. The
six-model comparison found no validated winner, and physical Android acceptance
remains not run. These outcomes are recorded separately below. Remote execution,
autonomous repairs and a new memory store are outside this checkpoint.

## Preservation and baseline

The pre-change snapshot contains 570 source files, fingerprint
`f14d649a2157e88a190a989bbbded8066c136849b1833d272944ced710552d7a`.
It includes the existing uncommitted anniversary work. No stash, reset, model
selection change or live-host restart was used.

Fresh isolated baseline: **1729 backend, 72 tooling, 675 browser and 108 Companion
tests passed**, plus TypeScript. The 3838 backend warnings are recorded separately
from failures. Evidence is under
`build_work/dependable-troubleshooting/baseline/release-snapshot-bgccnb_b`.

## Guided checks and outcomes

Troubleshooting follows Describe → Choose computer → Review a check → Run →
Review evidence → Record what helped. Opening the page, choosing a symptom or
reviewing choices does not run a diagnostic or contact an AI provider.

System and network checks execute on the TLI host. A device check tests TCP
reachability from that host to the registered address; it does not establish
remote CPU usage, successful printing or another device function. Duplicate
names remain separate identities. Remote selections cannot silently turn into
host resource measurements. Internet checks are off by default; review identifies
the external IP and DNS question before enabling them.

`GET /api/intelligence/diagnostics/options?computer_id=…` provides authenticated,
read-only choices with executing host, measured target and a scope revision.
The existing diagnostic POST accepts optional `expected_host_id`, `request_id`
and `expected_scope` fields for the guided flow. Host or scope changes reject
before checking. Existing valid request shapes remain supported; mismatched
remote targets for host-only checks are rejected before measurement. Supplying
the host's local inventory entry is normalized to an explicitly host-only report.

In-flight duplicate requests are rejected. Successful request receipts live in
the existing encrypted report so an explicit retry after restart can retrieve
that report without repeating the check. Uncertain failed requests are retained
in memory for ten minutes, bounded to 128 entries; they require reviewing history
and deliberately requesting a new check. There is no reconnect replay.

A successful check saves a report. Linking its reviewed pointer into a problem
draft and saving that problem remain separate actions. A case-save failure says
“Report saved; problem link not saved” and retains the draft. Closing a view does
not imply cancellation of server work. Resolved records the user's conclusion,
not measured recovery, and does not automatically create a confirmed-fix note.

## Performance & apps

The former Game Optimizer destination keeps `panel-games` and its search aliases.
Application observations run only on the TLI host, for a selected PID and process
creation time. A process is not necessarily an entire browser or application.
The maximum observation is 30 seconds; Stop or process exit leaves an accurately
identified partial result. CPU and memory readings do not prove a causal bottleneck.

Explicit saves use the existing encrypted diagnostic store. Their common report
fields remain readable by browser and Companion report views, and existing
saved-work backups include their additive performance data. Report IDs and save
receipts prevent overwriting a different observation. No tuning, configuration
writes, process termination or automatic AI calls belong to this feature.

See [Performance & apps contracts and verification](TLI_PERFORMANCE_APPS.md) and
the [Troubleshooting workflow](TLI_TROUBLESHOOTING.md) for the exact controls,
measurement units, failure behavior and persistence limits.

## Grounded answers and model comparison

The per-question Earlier conversation choice defaults on; switching it off
excludes history from that request without deleting saved conversations. Existing
selected-note/document restrictions remain. Saved-notes opt-out must cause no
new note lookup. Changed or unavailable historical sources are not reconstructed.
New evidence receipts describe the final supplied sources and the scope of
validated reference matches. A matching source handle is not proof of a correct
claim. Old answers and source bodies are not rewritten to repair attribution.
The additive fields and client completion rules are documented in
[the SSE contract](SSE_SCHEMA.md).

Model downloads are explicitly authorized into a separate evaluation directory.
The live selected model remains unchanged. The comparison includes compatible
existing text presets only, with production-matched launch settings, CPU execution,
four threads, 4096 context tokens, 512 output tokens, temperature zero, 120-second
startup and 90-second request bounds. Raw handwritten stress cases remain separate
from production-preparation cases. The sealed holdout is not used for prompt tuning.

The new six-preset comparison completed 384 planned attempts: 328 of 330 scored
responses and all 54 timing repeats. Power and Qwen3 8B each timed out once;
neither failed question was retried. Three agent reviewers assessed mixed blind
packets, with a 20-question independent overlap and nine adjudications frozen
before unblinding. **No candidate met the frozen quality criteria.** Qwen3 8B
improved grounding, context and usefulness counts over fresh Standard, but still
had hard failures, invalid references and an incomplete response set. The active
model and default remain unchanged.

The full [model comparison](TLI_MODEL_COMPARISON.md) and each model card's Technical
details retain these limitations. The earlier 23-case report stays available as
historical evidence. A response, valid source handle or passing preparation test
does not establish answer correctness. Timing and memory measurements apply to
the recorded artifacts and CPU conditions, not a different computer or mode.

## Acceptance and delivery status

The final candidate contains **600 source files**, fingerprint
`cd5cc508c888457727c4cd6456d89b9d64810d35a8032f486f5c08fd41845f2e`.
Its clean-install verifier completed with `source_verified`: **1798 backend,
116 release-tooling, 697 frontend and 117 Companion tests passed**, together with
TypeScript and Android/iOS exports. The extracted desktop package passed **1786
backend tests**, with one explicitly Git-dependent test deselected; repository
packaging tests and the previous-reader check ran in the source suite. The 3997
source-backend warnings are retained in the logs, not counted as failures.

The fresh environment installed runtime requirements and verified application
imports before adding test dependencies. Final real loopback HTTPS/PIN/bearer,
occupied-port, stop/restart, identity, no-HTTP-fallback and synthetic
upgrade/rollback/return/backup-recovery checks all passed. The final source-drift
check passed. The recorded old-code compatibility limits below still apply.

The final report and desktop archive are under
`build_work/dependable-troubleshooting/final-release/release-snapshot-reedl3cv`.
`TLI_candidate.zip` has SHA-256
`a8b69142656d632993361f279ff4398c0301a6ad33c0cb69219dc48608284812`.
Its public version remains `1.3.5-beta`; this is an internal source package, not
evidence of a live or native-installer upgrade.

The evaluated source fingerprint is
`fad878234ae76a8b4d78dd85c9b75066999bc4b5934994c515489f879b908051`.
The final candidate adds only the reviewed comparison publication, reference
metadata and verification changes. Under the final clean Python environment,
all **55 supplied request hashes** matched that evaluated source and every
collected request across all six models. No inference was repeated for this
equivalence check. Its evidence is `final-input-equivalence.json`, SHA-256
`b8e743362edd373d59c9bc52243df194e1840688a15b66b50fef99d7376c0f84`.

### Preserved earlier candidate record

The application/mobile candidate `134bb34b51dfe82f19ca290fed80d7348998ca5810feabc6026ee61947e014ea`
passed **1797 backend, 99 tooling, 695 browser and 117 Companion tests**, TypeScript,
Android/iOS exports and the extracted-package suite (**1785 passed, one explicitly
Git-dependent test deselected**). Repository-dependent packaging tests ran in the
source suite. A fresh environment installed runtime requirements and verified
application imports before installing test dependencies.

Real loopback HTTPS checks passed with synthetic PIN authentication, bearer
authentication, saved ports, normal stop/restart, identity preservation and refusal
to fall back to HTTP after an invalid TLS configuration. The occupied-port check
left the existing listener running. Synthetic upgrade/rollback/return against
`a5f2104f134a0d0fe482e4b65acadd515699d2fb` passed with the recorded limits of that
older code; it predates Companion and is not a published anniversary release.

The candidate's final source-drift check correctly failed after two evaluation
harness files were corrected. Application and mobile files did not change. This
report remains a failed candidate record; its successful checks are evidence for
that exact snapshot, not a substitute for the final candidate verification.

### Browser, model and phone evidence

Current browser evidence covers all 23 selectable themes, 320/390-pixel layouts,
tablet/desktop, enlarged text, keyboard interactions and reduced motion. Guided
Troubleshooting has 101 passing checks; Performance has 31 layout/contrast checks
and seven behavior groups. Grounded Chat has 13 reviewed layouts and three behavior
groups. The Companion web export has 56 checks and 36 screenshots across four
layouts. These use intercepted synthetic responses and do not contact a live TLI
host, model or household device.

The final comparison report additionally passed **117 browser checks** across
20 screenshots. Model Technical details passed **88 checks** across 26 layouts
and all 23 themes. The combined before/after gallery and coverage record bind
136 artifact hashes. A separate publication audit checked all 330 assessments,
score counts, safety gates, timing summaries and published source bindings.

- Final source/package verification and evaluation-input equivalence: **passed**.
  `build_work/dependable-troubleshooting/delivery-manifest.json` binds the exact
  desktop, Android, source, comparison, coverage and acceptance records.
- Model comparison and blinded assessment: complete, with **no validated winner**.
  Two earlier interrupted attempts remain explicitly invalid harness evidence;
  neither was used as a quality result. The completed comparison retains its two
  real request timeouts separately from those invalid harness attempts.
- Android Beta **0.1.0 (4)**: built; all 14 real Gradle transport tests passed.
  The APK's v2 signature, package and signer match the freshly verified Beta 3,
  and its native build number is higher. See the
  [physical acceptance record](TLI_TROUBLESHOOTING_PHONE_ACCEPTANCE.md) for the
  artifact identity and unperformed phone scenarios.
- Physical Android update, retained pairing, interruption and desktop continuity:
  not run. Browser fixtures and source checks are not physical-device evidence.
- Signed iPhone distribution, remote connectivity and live-installation upgrades:
  outside this checkpoint.

Final artifacts and exact candidate/source identities are recorded under
`build_work/dependable-troubleshooting`. Existing acceptance records and artifacts
remain available; failed and unperformed gates must not be overwritten as passes.
