# TLI anniversary: evidence-led troubleshooting

Status: the real-model comparison is complete. Its prompt candidate did not
qualify for retention, and no model passed the strict quality gate. The final
build retains the report interface and deterministic safety improvements while
restoring the previous model preparation. All 27 isolated software gates pass
on that final build. Physical Companion acceptance remains not run.

## Purpose and preservation

Give users a reliable account of what a saved diagnostic actually measured,
while making AI explanations distinguishable from those recorded facts. Preserve
the current interface, model selection, encrypted records and live installation.

The original 706-file working-tree snapshot is
`build_work/evidence-led-troubleshooting/baseline/release-snapshot-lb1qjzs9`;
fingerprint `f087e161d6656bc49af930a8a2753ba7490bc70acf0a6f100bccecf4ad21542f`.
Fresh isolated baseline backend, release-tooling and frontend suites passed.
Earlier source, reports, model studies, documentation and Android artifacts remain
available. No reset, stash, live restart or household action belongs to these checks.

## Implemented behavior

- A bounded backend projection supplies the report's executing host, target or
  selected process, recording time, observation interval, completion status,
  usable sample counts and measured units. It is historical evidence, never a
  current health verdict or proof that an application's task or repair succeeded.
- Performance aggregates are calculated from saved samples. Missing, invalid or
  out-of-range samples remain unavailable rather than becoming zero. Host CPU
  and selected-process CPU stay separate. Conflicting nested host identity cannot
  transfer a process, interval or measurements to a different computer.
- Report endpoints add `recorded_facts` only to their responses. Selected-report
  Chat receipts add optional `evidence_context.recorded_report`, bound to the same
  report, host and target. Raw samples are omitted from model context and Chat
  receipts; report APIs retain their existing saved fields. Encrypted report
  stores are not rewritten, and older records/receipts remain readable.
- Explicit requests such as “Summarize this report” receive a deterministic
  summary of the selected, owner-validated report. Existing completion questions
  use the same recorded completion decision as the visible report. Suggestions
  never execute a check or repair.
- Ordinary AI questions retain the previous report summary, coverage and model
  guidance. The tested replacement measurement table was removed after its
  grounding/context results failed the prospective retention rule. Recorded
  facts remain available to deterministic answers and visible receipts, without
  changing that established model input. A source reference does not prove an
  AI interpretation is correct. Text limits and answer budgets are unchanged.
- Changed/unavailable note references identify their exact historical exchange,
  old note revision and historical handle. They contain no deleted note bodies
  and do not create links in the current source namespace. Saved-note opt-out
  still performs no new note lookup. Invalid or empty turns cannot create false
  user/assistant pairs or seed follow-up recall. Exact reference metadata is
  displayed in receipts; the model retains its previous counts-only historical
  warning rather than receiving the rejected extra reference JSON.
- Desktop report views show recorded facts separately from saved interpretations
  and suggested steps. Chat has a compact facts summary before the answer, with
  detailed measurements expandable. Opening history is read-only; including a
  report in Chat remains explicit.
- Reviewed repeat checks use the existing secure-random fallback where
  `randomUUID` is unavailable. A local failure before dispatch is distinguished
  from an uncertain request after dispatch; no automatic retry was added.

## Prospective evaluation

The questions, expected evidence and scoring were frozen before model answers.
The new study has 24 unseen questions across twelve paired families, twelve
public development questions and eight retained raw controls. Its 36 actual-Chat
cases are captured and replayed through both JSON and SSE routes. A further
55-case final Standard regression preserves the previous corpus separately.

Three comparison arms use existing verified artifacts: baseline Standard,
candidate Standard and candidate Qwen3 8B. Each runs sequentially in an owned
temporary CPU runtime with four threads, 4096 context tokens, 512 output tokens,
temperature zero, a 120-second startup limit and 90-second request limits. Qwen3
uses the production non-thinking configuration. Resource availability is checked
before every launch. No live inference service or model selection is used.

Grounding, useful next steps, context handling and truthful action claims are
graded separately. Deterministic outcomes, actual model answers, raw controls,
failed routes and missing responses remain distinct. Changed routing is not
reported as improved model reasoning. A candidate policy improvement and strict
model-quality acceptance have separate predeclared criteria. A challenger cannot
receive a new recommendation without passing the strict application gates.

The frozen policy is
`build_work/evidence-led-troubleshooting/evaluation/policy.json`, SHA-256
`be2b1b239515136eb4834380c8cbd32eaab42310eb992fa779fdc037e14adee7`.

This new study collects one response per case. Its timing measurements are
descriptive, not repeated-trial stability results. Earlier six-model timing
repeats remain separate historical evidence. The offline preflight's aggregate
budget-error counts were seen during implementation (three public cases and four
sealed positions), but sealed questions/evidence and candidate answers were not
read. Corrections used public and synthetic reproductions. This limited
preflight exposure is recorded; it is not an untouched black-box holdout.

### Review integrity and limitations

Three reviewers graded the 132 comparison positions; twelve answers received an
independent overlap review. Six overlap disagreements were sent to the third
reviewer, who had not originally graded that answer. Original grades and all
adjudications are preserved and frozen before private arm attribution is opened.
This is agent assessment against a frozen rubric, separate from executable
assertions and physical user acceptance.

The first review packets accidentally retained operational model/provider labels
inside input-budget receipts. Review stopped when this was noticed. Twelve
answers had already been read, nine with those operational labels displayed.
Those initial assessments remain preserved. Corrected packets retain the same
questions, answer order, answers, evidence and assignments; only the operational
model/provider receipt fields were removed. Original and corrected packets are
hash-bound. One reviewer was told another initial question's all-two scores; the
assignment audit confirms that question was not in their overlap allocation.

Model identities that were part of the actual capability evidence remain intact,
and implementation authors can recognize their context changes. Consequently
this review is only partially blinded and is not a double-blind study. Neither
questions nor scoring thresholds were changed after inspecting answers. The
holdout is now consumed; further tuning requires a new unseen holdout.

## Frozen model-study results and retention decision

The 36 actual-Chat positions per arm include the 24-question holdout. Each score
is 0, 1 or 2; these are separate dimensions, not one percentage of correctness.

| Frozen study arm | Grounding | Useful next steps | Context | Action claims | Received |
|---|---:|---:|---:|---:|---:|
| Baseline Standard | 41 | 52 | 43 | 64 | 36/36 |
| Candidate Standard | 39 | 55 | 40 | 65 | 36/36 |
| Candidate Qwen3 8B | 55 | 62 | 53 | 67 | 35/36 |

Each dimension has 72 possible points. The missing challenger answer is
unassessed, not a fabricated zero-grade response. Baseline includes one
deterministic route; the candidate arms use model answers for all application
positions. On the 35 common model-route positions, Standard grounding changed
40 to 37 and context 43 to 38. The separate public CPU-routing improvement must
not be called improved model reasoning.

**Do not retain the candidate model preparation.** The frozen rule required all
four application totals to be nondeclining and grounding or context to improve.
Grounding fell by two and context by three. Fewer invented-action cases (two to
one), better usefulness and better action wording do not override that rule.
The final build therefore restores the baseline model-facing report formatting
and historical-warning text. It retains response-only facts, deterministic
summaries, receipt metadata, invalid-turn barriers and the independently tested
device-status routing fix. This is a rollback of the failed preparation change,
not new tuning on the now-consumed holdout.

**No validated winner.** All three arms fail the strict gate. Fully grounded
holdout answers were 12/24, 11/24 and 17/24 respectively, below the required
22/24. Application invented-action cases were two, one and one; invalid supplied
citations were five, five and two. The challenger also timed out on one public
application question. It was stopped, was not retried, and later questions used
a replacement harness-owned runtime. No active model, default or recommendation
was changed.

The separate 55-case candidate Standard regression returned every answer. Its
36 application positions (seven deterministic, 29 model) scored 56/59/51/70,
with one critical false-history answer and two invalid citations. Its nineteen
handwritten provider controls scored 20/25/18/33, with two critical answers.
This retained corpus has no fresh paired baseline in this checkpoint and cannot
establish improvement. The eight raw controls in each new comparison arm are
also reported separately in the complete results.

Across comparison and retained regression there were 179 model attempts: 178
returned answers and one timed out, plus eight deterministic responses. Raw
controls are real inference with handwritten context, not production-route
coverage. Application JSON/SSE replay, automatic assertions, manual scoring and
physical acceptance remain distinct.

Successful median/p95 completion times across each comparison arm's model
requests were 9.10/25.02 seconds for baseline Standard, 10.17/23.61 seconds for
candidate Standard and 26.46/61.79 seconds for Qwen3 8B. Sampled peak process RSS
was approximately 3.77, 3.77 and 9.52 GB respectively. Aggregate host CPU averaged
43.9%, 36.4% and 37.1%; this was not an idle controlled laboratory. The timing
report separates application/control questions, first response, completion,
startup and failed-attempt cost. These are single-trial observations, not a
stable performance guarantee.

[Complete model results](../build_work/evidence-led-troubleshooting/evaluation/results.json),
[timing and resources](../build_work/evidence-led-troubleshooting/evaluation/timing-summary.json)
and [retained regression review](../build_work/evidence-led-troubleshooting/evaluation/retained-review-1/review.md)
preserve the exact responses, source bindings and limitations. Results belong
to the frozen evaluated source below, not to a newly evaluated final rollback.

## Software verification and source identities

The final 719-file source fingerprint is
`59a4735c0217cd652aec591e0dbb981d30a7819be3680cbcf0243990fe556875`.
All 27 checks pass with no deferred software gate in the
[final verification report](../build_work/evidence-led-troubleshooting/fallback-verification/release-snapshot-l9oqlzmi/report.json).

| Suite | Passed |
|---|---:|
| Backend in frozen source | 2,431 |
| Backend in extracted package | 2,419 |
| Release/evaluation tooling | 168 |
| Frontend isolated tests | 973 |
| Companion | 149 |

Fresh runtime dependencies/imports, recorded dependency versions, TypeScript,
Android/iOS exports, actual loopback HTTPS stop/restart with PIN authentication,
occupied-port protection and synthetic recovery/rollback also pass. The only
extracted-suite exclusions are the repository-dependent packaging tests and
Git-dependent previous-reader test; they run in the source suite. The compatibility
reference remains `a5f2104f134a0d0fe482e4b65acadd515699d2fb`, which predates
Companion and is not a published anniversary-release claim.

The final desktop source ZIP has SHA-256
`e57dc9730067ae0499dd22da0ad559286ed7281e71318f5479864aa21ce04d88`.
No native installer or live installation is implied by this source-package gate.

The evaluated predecessor has fingerprint
`a4577fe1fe768100156a6316a4985c87716e7d3d16802e26b0f3d0485e768054`.
Its separate 27-gate [verification](../build_work/evidence-led-troubleshooting/final-verification/release-snapshot-lksi92c7/report.json),
source archive and actual model results remain preserved. Only six backend/test
files differ in the final build; frontend and native source match that candidate.
The final build's 239 focused checks and complete verification were run again
after restoring the prior preparation. The rejected candidate's scores are not
relabelled as final-build model results.

The [no-inference baseline equivalence proof](../build_work/evidence-led-troubleshooting/evaluation/equivalence/fallback-final-env/report.json)
passes: all 91 common model requests have exactly equal messages and full
captured provider payloads. This comprises 64 actual-Chat cases and 27 handwritten
provider controls across the new and retained corpora. Both JSON and SSE are
exercised for every actual-Chat case. Standard launch arguments also match.
Two routing changes are explicitly separate: the public CPU explanation now
reaches Chat rather than a device-status handler, and an explicit report summary
now uses the deterministic recorded-facts answer. Six shared deterministic
responses are unchanged. All 99 positions are accounted for. This proves the
tested input restoration; it is not a new model-quality score or whole-source
equivalence claim.

The browser record covers 87 focused frontend checks, eleven behaviors, sixty
layouts and all 23 themes, with 37 after and four before screenshots. Its six
presentation components and all frontend files are unchanged in the final
source. The final static review page also passed desktop/320-pixel light/dark
checks, including keyboard disclosures and horizontal table access. These are
synthetic browser fixtures, not physical-phone results. Independent source and
model-arithmetic audits found no additional blocker. Source and observed model
configuration hashes are preserved; no claim of a full live-data audit is made.

## Recorded corrections during verification

The initial focused integration found old exact-shape assertions for historical
reference counts and the previous performance projection. They now assert the
new metadata plus preserved counts, scope and raw-sample omission. An initial
test import path mistake was also corrected. These were not baseline failures.

The first complete backend integration passed 2361 tests and failed two old
expectations: one ignored an omitted untrusted conversation role; the other
expected response-only report facts to be written into the report store. The
corrected assertions verify the omission count and unchanged persisted report.
Both failures and their superseding checks remain recorded.

Independent synthetic checks reproduced and closed numeric overflow, conflicting
host/process attribution, non-finite process timestamps and mismatched report
target binding. The evaluator audit also found that fixture generation overrides
could differ from the frozen collection settings. Preflight now rejects those
differences before starting inference. Its first capture is retained; no model
answers were collected under that superseded capture.

The public development baseline also exposed an ordinary CPU explanation being
misclassified as a device command: `on` matched inside `one`. Device status
recognition now requires a complete request, retains polite/direct targeting and
clarification, and takes read-only precedence when a device name contains an
action word such as “Start”. The focused routing record contains 135 passing
checks, including 50 new cases; no live device was contacted.

The next candidate's offline capture rejected seven report questions before
inference because the new facts expanded required context beyond the configured
4,096-token limit. The public full/partial/missing-sample cases reproduce the
failure. A lossless measurement table and removal of duplicate warnings correct
that regression without raising limits or dropping facts. The superseded source,
rejected capture and verification attempt remain preserved. No candidate model
answer was collected from that source.

After the model-retention decision, two focused tests still asserted the rejected
model-table format. They were changed to verify the restored summary/coverage
and the separate full recorded-facts receipt. The initial 237-pass/two-failure
record remains alongside the subsequent 239-pass run; neither is a baseline
failure.

## Companion and physical acceptance

This batch preserves native Companion source and the retained Android Beta
0.1.0 (5). It does not claim a new native report renderer or a new APK. Desktop
report facts are additive server fields; existing native readers retain their
current behavior. The identified native performance-summary presentation gap
requires a matched future Beta update and physical acceptance.

Update-without-uninstall, retained pairing, restarts, interruption handling,
phone/desktop continuation and away-from-home private-route tests require the
actual phone. No phone result, native installation or real-data recovery is
inferred from browser fixtures or passing software tests.

## Delivery record

- [Before/after views and exact answer examples](../build_work/evidence-led-troubleshooting/review.html)
- [Matched source and artifact manifest](../build_work/evidence-led-troubleshooting/delivery-manifest.json)
- [Final desktop source candidate](../build_work/evidence-led-troubleshooting/fallback-verification/release-snapshot-l9oqlzmi/TLI_candidate.zip)
- [Software, model and physical acceptance](../build_work/evidence-led-troubleshooting/acceptance.json)

The working source contains the final changes. Automated work did not restart
live TLI, change model selection or install a phone build. The prior Android
Beta remains a retained artifact, not a newly built match for this checkpoint.
