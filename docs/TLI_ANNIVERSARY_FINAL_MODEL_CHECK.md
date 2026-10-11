# Anniversary final model check — 11 September 2026

The case-specific evidence trial was **rejected** under the policy frozen before these responses. The previous `case_context.py` was restored exactly. **Neither preparation passed strict answer quality, and this study establishes no validated model winner.** Model selection and the live TLI runtime were unchanged.

The trial improved some attempted-action distinctions, but introduced other material errors. Its retained-development grounding score fell and four development questions acquired new zero scores. These mandatory failures were recorded before the new confirmation answers were attributed to their source. Confirmation subsequently showed additional failures; it could not override the rejection.

## Actual model results

Scores are agent assessments on four separate dimensions: grounding / useful next steps / context handling / truthful action claims. Each dimension is 0 (fails), 1 (limited), or 2 (meets). These are synthetic case results, not a percentage estimate of general accuracy.

| Cohort and preparation | Positions | Dimension totals | All four meet | Any zero score | Critical-failure positions |
| --- | ---: | --- | ---: | ---: | ---: |
| Retained development, baseline model | 15 | 12 / 14 / 13 / 24, each out of 30 | 3 | 9 | 2 |
| Retained development, rejected trial model | 15 | 10 / 15 / 13 / 29, each out of 30 | 3 | 9 | 0 |
| New confirmation, baseline model | 24 | 21 / 25 / 22 / 41, each out of 48 | 3 | 12 | 4 |
| New confirmation, rejected trial model | 24 | 25 / 27 / 27 / 40, each out of 48 | 5 | 9 | 1 |

The other five retained questions used deterministic answers in both versions. All five met all four dimensions; their replies and routing were identical. They are not credited as model improvement.

Baseline development critical failures were one invented action and one wrong-target claim. Baseline confirmation had three invented-action failures and one sharing/source-attribution failure. The rejected trial had one confirmation invented-action failure. No new paired critical category appeared, but critical failures were not eliminated. Ten paired questions acquired a new zero in at least one dimension: four development and six confirmation. The trial also had one invalid asserted citation and one response cut off at the output limit.

Strict confirmation quality required all 24 responses to finish, all four dimensions to meet on every answer, no critical failures, and no invalid asserted citations. Both preparations failed. The broader retention rule also required nondeclining model totals separately in both cohorts, a confirmation grounding/context gain, zero confirmation critical failures, and no new paired critical or zero-score failures. The trial failed that rule despite some gains.

## Concrete failures and improvements

- The retained skipped-update answer changed from the false “Yes, the graphics driver was updated” to a correct statement that no update was attempted. This is a demonstrated improvement on that question only.
- The trial's recorded-values answer added “within a normal range for both CPU and uptime.” No normal baseline or causal conclusion was supplied.
- In the new cable case, the recorded step was skipped with “I did not replace it.” The trial nevertheless said “the USB cable was replaced but not attempted.” The baseline also misread it as an unsuccessful attempt. Neither is an acceptable account of the record.
- The retained baseline still has serious errors. In a reference-only confirmation, it correctly noticed the report body was absent, then presented the separate case symptom as a quotation from that report. Restoring the baseline is a regression-control decision, not a claim that these errors are solved.

## Evidence and delivery binding

The same installed Standard weights were used in both isolated arms: `Qwen2.5-3B-Instruct-Q4_K_M.gguf`, SHA-256 `9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94`. The existing `llama_server.exe` SHA-256 was `3b0ada0e76b1cc5668c7e2bbac7784a6e978de9535aa2ad1f749893f79456e58`; runtime DLL hashes are retained in each manifest.

Each source used actual isolated Chat JSON and SSE input capture: 44 positions, 39 model requests and five deterministic answers. Generation was CPU, four threads, 4096 context tokens, 512 output tokens, temperature zero, a 120-second startup bound and 90-second request bound. There were no retries or timing repeats. All 78 model requests received a response; baseline had 39 normal stops, trial had 38 normal stops and one output-limit stop. Both owned runtimes exited and both evaluated source snapshots remained unchanged. No live inference service was contacted.

The delivered source fingerprint is `4e36dcadc8b45e3ca0a98da73468bc91365493d30c8b641a2c6759c91150e190`. A fresh capture in that release's Python environment matched **all 39 baseline model request payloads, all five deterministic replies, and two ordinary-Chat controls** exactly. This is input equivalence to the evaluated baseline, not another inference run or a claim that whole-source fingerprints match. The earlier `5bef64c9…` candidate proof remains archived and applies only to the rejected trial.

The restored case file SHA-256 is `bce62d8542bd632fc46f2a37f8a8cfeb7cd479a71fc88699a68c127a10476924`. The rejected case file and its trial-specific tests were archived before restoration/removal. No prompt was tuned after confirmation answers were inspected.

## Assessment limits

The trial author created the new 24 questions after freezing the prompt, and graded the retained 20 questions with phase labels visible. A separate agent manually graded all 48 new confirmation answers with phase/model/timing labels hidden. Identical selected facts were supplied in the review; static guidance and derived labels were omitted only from that grading view, with exact raw requests privately bound. All confirmation grades were frozen before phase attribution. This is a single independent agent review without human calibration, not an external user study. The older eight-case chronology quirk was retained; the 24 new cases use consistent dates.

Automatic checks establish source/hash integrity, actual-route preservation, transport completion, input equivalence and grade-shape completeness. They do not establish semantic correctness. Six synthetic assessment-validator guards and independent source reviews passed. Software release verification is recorded separately by the release process.

Timings are descriptive only: baseline/trial median response times were 24.695/21.862 seconds. Concurrent release suites and an unchanged pre-existing live runtime affected host load; mean host CPU was 49.2%/37.1%, with observed peaks of 100%/65.7%. Owned-child peak RSS was approximately 4.83/4.56 GB. These runs do not support a comparative speed claim. Physical and real-user acceptance were not performed.

Machine-readable records:

- [Final AI report](../build_work/anniversary-final/ai/final-report.json), SHA-256 `e263d6499fc19337cf82d9cf3902a0862169b418411561754b8e81bf0bf05256`.
- [Frozen scoring and retention policy](../build_work/anniversary-final/ai/policy.json), SHA-256 `c6d0674cb9be369c7392246378669475d9980ab70b4501e45e383ee9f4c3c196`.
- [Raw study manifest](../build_work/anniversary-final/ai/study-manifest.json), [quality summary](../build_work/anniversary-final/ai/quality-summary.json), and [assessment freeze](../build_work/anniversary-final/ai/assessment-freeze.json).
- [Independent confirmation assessment](../build_work/anniversary-final/ai/blind-review/confirmation-assessment.json), [restoration record](../build_work/anniversary-final/ai/rejected-trial/rollback-record.json), and [delivered baseline input proof](../build_work/anniversary-final/ai/accepted-input-equivalence.json).
