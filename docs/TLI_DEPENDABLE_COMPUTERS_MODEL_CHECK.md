# Dependable computers: actual Standard-model check

The new case/report handoff preserves the reviewed evidence, but **Standard's
interpretation remains unreliable**. The deterministic report summary was
fact-bound. Seven real model answers all completed, yet several misread known
measurements or past steps. This is an eight-question development smoke check,
not a new holdout, comparison or validated model recommendation.

## What was tested

The questions and rubrics were frozen before answers were collected. Actual
synthetic JSON and SSE Chat routes prepared the input. Seven captured provider
requests then ran sequentially in a separate loopback runtime; the eighth
question used TLI's deterministic record-summary response without inference.

The selected case concerned stuttering on **Den**. Closing the browser was
recorded as tried, with the stutter continuing. A graphics-driver update was
skipped and not attempted. The explicitly selected report recorded **26% CPU**,
**unavailable RAM** and **900 seconds uptime** on **September 1, 2026**. It supplied
no current measurements, GPU readings, network evidence or established cause.
One question shared only the report reference, withholding those measurements.
Saved notes and earlier conversation were disabled throughout.

- Host source: **765 files**, fingerprint
  `57d2b9ab77db3349d91d404c131f97df9e2f95e5301007b51897e29c0ff4d9ca`.
- Question/rubric fingerprint:
  `381be8c3c7e213207df6ffacfd2d7277da4bc517c1dbfdc6e802bd24785537e2`.
- Artifact: **Qwen2.5-3B-Instruct-Q4_K_M.gguf**, SHA-256
  `9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94`.
- Runtime executable SHA-256:
  `3b0ada0e76b1cc5668c7e2bbac7784a6e978de9535aa2ad1f749893f79456e58`.
- CPU mode, four threads, 4,096 context tokens, 512 output-token limit,
  temperature zero, 120-second startup and 90-second request limits.
- Existing weights were read without downloading, changing selection or calling
  the live inference service. The harness stopped its own process successfully.

## Results by question

These scores are **agent assessment**, not automated truth detection or physical
user acceptance. Scale: **0 fails**, **1 limited**, **2 meets the frozen rubric**.
Grounding, useful next steps, context handling and truthful action claims are
scored separately. No composite percentage is used to hide a failed dimension.

| Question | Grounding | Next steps | Context | Action claims | Finding |
|---|---:|---:|---:|---:|---|
| Summarize this report — deterministic backend | 2 | 2 | 2 | 2 | Correct historical host, time, CPU, unknown RAM and uptime; no current-health or repair claim. |
| Current CPU and RAM | 2 | 2 | 2 | 2 | Correctly requires fresh measurements; useful generic OS guidance, but misses the direct TLI check entry point. |
| Possible causes and next check | 0 | 1 | 1 | 2 | Treats the historical 26% reading as possible evidence of heavy load during playback, which it cannot establish. |
| Compare then with now | 0 | 2 | 1 | 2 | Correctly requires a new sample, but incorrectly says the old report lacks CPU details. |
| What was tried and did it work? | 0 | 0 | 0 | 2 | Loses the recorded browser outcome and says uptime was unavailable despite 900 seconds being supplied. |
| Reference only: which numbers can be quoted? | 1 | 0 | 1 | 1 | Quotes no withheld measurements, but drifts into unrelated advice and says to update drivers again despite the skipped step. |
| Does this describe my phone or Wi-Fi? | 1 | 1 | 1 | 2 | Correctly distinguishes Den from the phone and excludes Wi-Fi conclusions; loosely describes unavailable RAM and excluded resolution. |
| What should I check next? | 1 | 0 | 0 | 1 | Recommends a driver change instead of a bounded observation, ignores unknown RAM and again implies a previous driver attempt. |

Only **one of seven model answers** met all four dimensions under this strict
review. The separate deterministic answer met its rubric. The driver wording is
an unsupported implication about a historical attempt; it is not a claim that
TLI just executed a repair. No fabricated completed TLI operation or invented
current numerical reading was found in these seven answers. That small sample
does not establish that either failure is impossible.

The original mechanical flags were empty for every model answer. Agent review
nevertheless found semantic errors. Automated checks confirmed matching JSON/SSE
preparation, no excluded private canaries in supplied inputs or answers, no
withheld 26%/900-second values in the reference-only answer and no unknown simple
bracket source handles. Those checks do not prove causal truth, complete citation
correctness or useful advice. A valid `[R1]` identifies the source, not the truth
of every sentence beside it.

An independent agent reviewed the same unedited inputs and answers. Both reviews
agree that only the current-readings answer meets all four dimensions, and that
the separate deterministic summary meets its rubric. Partial-credit judgments
differ for the tried, reference-only and phone-scope answers. Both score sets
and their explanations are retained; the table above is the primary review,
not an average or a blind model comparison.

## Timing and memory

Startup took **1.709 seconds**. All seven model requests completed with **zero
timeouts**, in **11.333–26.924 seconds**. The first uncached request took **18.692
seconds** to its first token. Later requests with largely reused prompt prefixes
took **0.376–0.556 seconds**; the reference-only prompt took **7.625 seconds**.
These conditions are different and must not be averaged into a uniform latency
claim. This smoke check did not repeat timing cases.

Sampled peak resident memory for the owned runtime was **3,617,529,856 bytes
(3.37 GiB)**. Aggregate host CPU averaged **43.7%** and peaked at **93.6%** during
the run. The 0.5-second sampler may miss shorter spikes; other host load was not
controlled. Resources were checked before launch, with about 32.4 GiB available
against the harness's 8.6 GiB requirement. Runtime/model hashes and source remained
unchanged, and the owned child exited after collection.

## Limits and next work

The inputs were not tuned after observing these answers. The capture fixture
uses a fixed case-save date that predates its linked September report; that
synthetic chronology is retained and is not graded as a real event sequence.
These eight development questions cannot replace the earlier sealed comparison.
**No validated winner** remains the conclusion of that broader evaluation.
The active model and default stay unchanged.

The next quality work should test whether the next proposed check follows the
actual missing evidence, whether known outcomes survive paraphrasing and whether
historical measurements are interpreted conservatively. It needs prospective
questions and fresh validation. More evidence panels alone cannot make an
unsupported explanation correct. Physical phone/household acceptance remains
**not run**.

## Evidence

- [Prospective questions and rubrics](../scripts/fixtures/tli_dependable_computers_quality.json).
- [Actual JSON/SSE route capture - local evidence](LOCAL_EVIDENCE.md)
  and [supplied provider inputs - local evidence](LOCAL_EVIDENCE.md).
- [Complete unedited model answers - local evidence](LOCAL_EVIDENCE.md)
  and [runtime, hashes and telemetry - local evidence](LOCAL_EVIDENCE.md).
- [Per-case primary assessment - local evidence](LOCAL_EVIDENCE.md).
- [Independent agent review - local evidence](LOCAL_EVIDENCE.md).
- [Earlier strict comparison](TLI_EVIDENCE_LED_TROUBLESHOOTING.md) and
  [current acceptance record](TLI_DEPENDABLE_COMPUTERS_ACCEPTANCE.md).

Raw collection reports intentionally retain their original unassessed fields;
the dated assessments above are separate records and do not rewrite responses.
