# TLI anniversary: answer reliability

Status: implementation, the isolated comparison and all 27 final software
verification gates are complete. The candidate grounding policy met its predeclared
promotion rule and is retained. **Standard still fails the strict answer-quality
gate.** This checkpoint does not replace earlier recorded results or claim
physical-device acceptance.

## Scope

Improve demonstrated Chat targeting, historical-note provenance and model grounding.
Keep the active model, default recommendation, live installation, encrypted data,
modern interface and existing endpoints unchanged. Use synthetic stores and an
owned temporary Standard runtime; never contact live inference or run household
checks for this evaluation.

The previous six-model study exercised prepared provider requests. Several requests
bypassed production's deterministic dispatch. Its findings remain useful raw-model
evidence, but do not establish that every failure occurs through ordinary Chat.
This checkpoint records actual JSON/SSE Chat dispatch separately from retained
handwritten stress requests. Deterministic answers remain application results;
they are not presented as model answers.

## Preservation and baseline

Before implementation, the intended working tree was captured in
`build_work/answer-reliability/baseline/release-snapshot-4tupqbhj`.
Its 699-file source fingerprint is
`61db5f3fc236037a27401993a2871dee48d96aac0f4e890a26581f5b431284dd`.
The frozen snapshot passed 2,270 backend, 958 frontend and 122 tooling tests.
Deprecation warnings remain recorded in the logs; there were no baseline failures.

The four documentation files referenced by the prior delivery are preserved,
with hashes, under `baseline/previous-delivery-docs`. The prior model corpus,
answers, blind grades, public study, Android APK and delivery artifacts remain
unchanged.

## Implemented changes

- Explicit Chat diagnostics retain the selected computer all the way to the
  existing diagnostic validator. Remote or missing system/network targets are
  rejected before measurements, events or report saves. Host checks and exact
  device reachability checks retain their behavior across JSON, SSE and the
  existing LM Studio Chat route.
- Historical-note receipts count the exact retained exchanges. Duplicate answer
  text and omitted/orphan turns cannot inflate the reported revision checks.
- Historical revision checks and current-note retrieval share the existing
  persistence lock for bounded preparation. An interleaving note edit cannot
  create a mixed snapshot. The lock is released before inference; opting out of
  saved notes performs no new note lookup.
- Current supplied records follow retained history and precede the unchanged
  latest question. Input budgeting and final serialization use the same order.
  Concise guidance distinguishes saved statements, measured subjects and scope,
  proposed steps, and historical claims. The comparison justified retaining this
  change, but does not establish that generated answers are consistently correct.

## Evaluation discipline

Use the existing Standard artifact in a separate evaluation directory and the
existing preset launch configuration: CPU, four threads, 4,096 context tokens,
512 output tokens, temperature zero, 120-second startup and bounded 90-second
requests. Check resources before launch; stop only harness-owned processes.

Preserve all 31 prior regression/development positions. Add a fresh 24-question
holdout across twelve paired scenario families, with expectations and scoring
sealed before model responses. Record fixture preflight corrections separately.
Keep holdout bodies and answers out of implementation tuning. Freeze candidate
source before final holdout inspection. Score grounding, usefulness, context and
action claims separately; distinguish automatic checks from blinded assessment.

Publish baseline and candidate results without substituting raw-model failures
for route outcomes, or counting safe preflight refusals as successful inference.
Any remaining invented action, account leak or ignored sharing control remains
a failure. No benchmark result changes the user's running model or default.

## Recorded comparison and decision

The evaluated candidate contains 706 source files, fingerprint
`fe79bfd1b8d0e1bc67e93869a11deef0d5d027764a50271aa28c1b828c84aee6`.
Both phases completed all 49 real Standard requests and stopped their owned
runtime. Each phase also includes six deterministic answers: **55 positions,
36 through actual Chat and 19 retained handwritten controls**. All 31 earlier
regression/development positions and the fresh 24-case holdout remain recorded.
The earlier provisional 47/8 lane split was corrected during preflight, before
answers were examined; it is not the final accounting.

Two superseded collector preflights (`baseline-1` and `baseline-2`) exposed
fixture/metadata contract mistakes, including missing case-purpose metadata.
They supplied no graded answers. The second preflight's owned runtime was stopped
before answer collection. Their records are retained; the scored baseline is
`baseline-3`, followed by `final-1` for the candidate.

Three agent reviewers assessed 110 answers, with 12 independently reviewed
overlaps. Five scoring disagreements were adjudicated against supplied evidence
before revealing phase labels. Questions, expected evidence, scoring and source
were frozen before answer inspection; the separate promotion policy was recorded
before any grading. No holdout-driven prompt tuning followed inspection.

| Actual-Chat dimension | Baseline total | Candidate total | Maximum |
|---|---:|---:|---:|
| Factual grounding | 49 | 52 | 72 |
| Useful next steps | 52 | 52 | 72 |
| Context handling | 47 | 51 | 72 |
| Truthful action claims | 68 | 68 | 72 |

Each answer receives an independent 0 (failed), 1 (limited), or 2 (meets) for
each dimension. These totals are **not accuracy percentages**. Six deterministic
answers are included in the application lane, rather than attributed to the
model. Not every response improved: fully useful application answers decreased
from 20 to 19, while the usefulness point total stayed unchanged.

The candidate added no new paired critical-failure category and did not increase
any category total. Application answers with hard failures decreased from three
to two; invalid supplied citations decreased from two to one. The retained
candidate still has one invented completion and one wrong-target interpretation
in this corpus. No account-boundary, sharing-control or embedded-source-instruction
failure was observed in the application cases; that limited result is not a
general guarantee.

The strict gate fails for **both** phases. On the 24 unseen cases, the candidate
met grounding in 13 (required 22), context handling in 12 (required 22), and
usefulness in 11 (required 18). Grounding/context zeros, a fabricated completion,
incorrect measurement direction and a non-holdout invalid citation remain.
The 19 handwritten controls have unchanged dimension totals of 18/38, 22/38,
18/38 and 33/38. Their failures are separate raw-model evidence; they do not
establish the same behavior through production dispatch.

The frozen promotion rule requires nondeclining application dimension totals,
an improvement in grounding or context, and no new or increased critical
categories. It passed. Strict quality acceptance is independent and did not
pass. **The active model, default recommendation and earlier six-model study
remain unchanged.** The evidence supports a modest policy improvement, not a
validated model winner or a fully dependable AI release.

The [complete comparison](../build_work/answer-reliability/evaluation/blind-review-3/results.json)
contains every answer, supplied context, grade, adjudication binding and runtime
identity. Its SHA-256 is
`4b86ecf39f50615731f5fcc3289dbfe028efb5c647df6de7d2d782ad250f70df`.
The [local review](../build_work/answer-reliability/review.html) presents readable
before/after examples and keeps software checks separate from model quality.

The [timing record](../build_work/answer-reliability/evaluation/timing-summary.json)
also shows a tradeoff. For the 30 actual-Chat model requests per phase, median
first-token time was 3.67 seconds before and 4.96 after; median completion was
11.85 and 12.07 seconds. The respective 95th-percentile first-token times were
19.57 and 19.03 seconds. Startup took about 1.81 seconds and peak process RSS
about 3.8 GB in each phase. Mean host CPU load was 38.41% and 37.76%. These are
single-run observations, not a speed improvement or a statistical performance
claim. Raw-control timings and deterministic answers are accounted for separately.

## Limits and verification record

This is synthetic evidence using one Standard CPU run per phase. Agent
assessment is distinct from automatic assertions and physical user acceptance.
Instruction authors could recognize some context despite normalized review
packets. Operational receipt timestamps were discovered after limited initial
reads, removed without changing assignments or answers, and that exposure is
recorded. This is limited blinding, not an independent human or perfectly blind
study. Original raw controls, including their legacy text encoding, were retained.

The first full backend candidate run passed 2,296 tests and failed one test that
assumed references always precede history. Its assertion was corrected to check
the same system instructions and chronological conversation by role; all 31
Companion conversation tests then passed. This was a new test-expectation failure,
not a pre-existing baseline failure. That test-only correction occurred after
the evaluated source freeze and is recorded separately from production input
equivalence. The failed package attempt remains available under `verification/`.

The next complete attempt passed all 2,297 backend tests and 151 release-tooling
tests, but one older harness test still assumed the historical assistant answer
was the penultimate message. It now checks that preserved answer by role;
all 25 tests in that module pass. This second test-only correction changes no
production input, prompt, corpus, score or runtime. The failed attempt and its
successful input-equivalence proof remain under `final-verification/` and
`evaluation/final-input-equivalence-1/`; the final run and proof supersede them
without deleting the evidence.

The final 706-file source fingerprint is
`f087e161d6656bc49af930a8a2753ba7490bc70acf0a6f100bccecf4ad21542f`.
All 27 checks in the
[final verification report](../build_work/answer-reliability/final-verification/release-snapshot-6a1ft6hb/report.json)
passed, with no deferred source gate:

| Software suite | Passed |
|---|---:|
| Backend in frozen source | 2,297 |
| Backend in extracted package | 2,285 |
| Release/evaluation tooling | 152 |
| Browser frontend | 958 |
| Companion | 149 |

The extracted run excludes only the documented repository-dependent packaging
tests and Git-dependent previous-reader test, which ran in the source suite.
Fresh runtime installation/imports, resolved dependencies, TypeScript, Android
and iOS exports, actual loopback HTTPS stop/restart with PIN authentication,
occupied-port protection and synthetic recovery/rollback also passed. The Git
compatibility reference is `a5f2104f134a0d0fe482e4b65acadd515699d2fb`, which
predates Companion and is not described as a published anniversary release.
Native installation and real household-data recovery are not inferred from these
results.

The [final input-equivalence proof](../build_work/answer-reliability/evaluation/final-input-equivalence-2/report.json)
used the final installation's fresh Python. All runtime source bytes, 55 fixture
positions/lanes, 49 exact model requests, six deterministic answers and Standard
launch settings match the evaluated candidate. It exercised 72 JSON/SSE route
requests without inference. The only two source differences after model
evaluation are the documented test assertions, so the two source fingerprints
are intentionally different. Earlier failed attempts and proof 1 remain intact.

The desktop source ZIP has SHA-256
`bd8328866335ba5c8831349c6d6f8d9dcb6814ac040f6104ed00ced120a1cc10`.
All 218 frontend and 88 mobile source files match the preserved baseline
byte-for-byte. Existing model-configuration files match their recorded hashes;
no live restart, model switch, household action or native build was requested.
The existing Android Beta is retained. External LM Studio model-template
acceptance and physical-phone testing remain **not run** for this checkpoint;
the prior Beta's physical gates retain their earlier status. Load the backend
changes during a normal, deliberate TLI restart when ready.
