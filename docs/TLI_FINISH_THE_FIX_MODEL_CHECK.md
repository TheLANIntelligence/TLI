# Finish the fix: actual Standard answer check

The new next-check controls derive a supported observation from selected saved
facts. That is a backend workflow. Ordinary Chat still asks the installed
Standard Qwen to interpret evidence, and the model retains consequential factual
and context errors. **No validated model winner, recommendation change or model
selection change follows from this checkpoint.**

Independent manual assessment and a second review of the final answers are
complete. The combined result improves through four factual routing changes;
the remaining model answers do not improve. A completed inference request is
not a correct answer.

| Assessment dimension | Baseline, 20 questions | Final, 20 questions |
|---|---:|---:|
| Factual grounding | 17 / 40 | 23 / 40 |
| Useful next steps | 24 / 40 | 26 / 40 |
| Context handling | 19 / 40 | 23 / 40 |
| Truthful action claims | 33 / 40 | 33 / 40 |

Each question receives 0 (fails), 1 (limited) or 2 (meets the frozen rubric) in
each dimension. There is no combined score that hides a failed action claim.
Full passes across all four dimensions rise from **5/20 to 8/20**. The final
five deterministic responses all pass; only **3/15 model responses** pass all
four dimensions. On the same fifteen model questions, grounding/usefulness/
context/action totals are **13/16/14/23 → 13/16/13/23**, each out of 30. The
one changed model answer introduces a wrong-host attribution. Consequently the
ordinary model-answer quality gate remains **failed**, independently of passing
software and workflow checks.

## Prospective method

Eight earlier development questions were retained unchanged. Twelve additional
confirmation questions, expected evidence and the four scoring dimensions were
frozen before collecting answers or inspecting the final candidate. The new
questions cover recorded attempts, skipped steps, numerical facts, current versus
historical readings, comparisons, excluded notes, causal assertions, useful
measurements, phone scope, references without bodies, missing facts and recaps.

- Baseline source: `57d2b9ab77db3349d91d404c131f97df9e2f95e5301007b51897e29c0ff4d9ca`.
- Final source: `05f9aa8e95c94d17243b7c5c2b56dfa29c2afbb43f93484d5867353ae27ca071`.
- Confirmation questions: `d7dd9d9593fc3d51467a46c5b5981e70022a2b3235317a3947e890f590c586c4`.
- Scoring policy: `0a3dfb6a17ea2d8a242823eb50da76757270ffc18bb673fb9971f421fb9b24df`.

Actual JSON and SSE route preparation was captured using synthetic accounts,
cases and reports. Both routes must agree; preparation cannot run diagnostics,
retrieve excluded note bodies or modify the seeded stores. Remaining provider
requests were then sent sequentially to a separately owned loopback runtime.
The existing weights were read without changing the live installation or
contacting its inference service. Both owned runtimes stopped after collection.

Final collection contains **15 actual model responses and five deterministic
record-based responses**. Baseline collection contains 19 model responses and
one deterministic response. All model requests returned with a stop finish
reason; none timed out or hit the output limit. A renderer or hand-authored
response is not substituted for model output.

The retained eight-case fixture has a known chronological quirk: its case save
date predates its selected report. It remains unchanged historical regression
evidence. The twelve new cases have consistent chronology. This small check is
not a new blind comparison across models, nor a replacement for the earlier
strict comparison that found no validated winner.

## Evaluated artifact and conditions

| Item | Recorded value |
|---|---|
| Model | Existing `Qwen2.5-3B-Instruct-Q4_K_M.gguf`, Standard |
| Model SHA-256 | `9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94` |
| Runtime SHA-256 | `3b0ada0e76b1cc5668c7e2bbac7784a6e978de9535aa2ad1f749893f79456e58` |
| Execution | CPU, four threads, 4,096 context tokens, temperature zero |
| Bounds | 512 output tokens, 120-second startup limit, 90-second requests |
| Fresh resource check | Final run: 44.95 GB available RAM; requirement 9.23 GB |
| Startup | Baseline 1.810 seconds; final 2.037 seconds |
| Median first token | Baseline 0.419 seconds; final 0.535 seconds |
| Median completed response | Baseline 12.399 seconds; final 14.197 seconds |
| Sampled process RSS peak | Baseline 3,668,553,728 bytes; final 3,668,373,504 bytes |
| Mean / peak aggregate host CPU | Baseline 39.1% / 64.6%; final 52.4% / 91.1% |

These timings are observations, **not a speed-improvement claim**. The final run
overlapped isolated release verification; aggregate host load was higher and the
provider question sets differ because four questions now use saved facts
directly. Sampled peaks can miss shorter spikes. Model, runtime and supporting
DLL hashes, resource probes, response timing and complete raw results remain in
the runtime manifests. The broader source verification was rerun without that
concurrent workload after reaching its own time bound.

## What improved and what did not

Four additional factual questions now use the selected records directly:
current readings, recorded-versus-current comparison, and two questions about
attempted steps/outcomes. The direct path keeps RAM unavailable, retains the
recorded CPU/uptime, identifies skipped steps and does not invent a current
measurement or successful fix.

All fifteen remaining model questions have the same supplied messages and
request hashes in the baseline and final runs. Fourteen model answers are
byte-identical; one differs. Changes in the combined result therefore cannot be
described as the language model becoming more accurate.

Observed remaining failures include:

- **Skipped action reported as completed.** One answer starts, “Yes, the graphics
  driver was updated,” before contradicting itself and acknowledging that it was
  skipped and not attempted.
- **Known attempts treated as missing.** A question about unknown report fields
  instead denies the recorded browser-closing attempt and its outcome, then
  recommends repeating both that action and the skipped driver change.
- **Unsupported health conclusions.** An explanation treats historical 26% CPU
  as possible heavy load; another calls 37% normal and interprets 2,400 seconds of
  uptime as evidence of stability. Those readings alone establish neither claim.
- **Unhelpful or unsupported checks.** Some answers suggest driver changes,
  unspecified phone checks, or measuring the past, instead of the available
  target-bound observation.
- **Unavailable content confused with empty content.** A linked report whose
  body was excluded is described as containing no numerical data. The correct
  limitation is that those facts were not supplied.

The source/context controls held in preparation; these are errors in how the
model interprets supplied information. No diagnostic, driver change or device
action actually ran. Suggested actions and false historical action claims still
require scrutiny even when no execution occurs.

Use the **Known → Missing → Already tried → Review suggested check** workflow
for the supported next observation. Its facts, available check, target and
revision guards are separate from the model's explanation. It is not a general
diagnosis engine, and cannot prove the cause or success of a repair.

## Evidence

Raw evidence and the frozen policy remain local:

- [Scoring policy - local evidence](LOCAL_EVIDENCE.md)
- [Baseline route capture - local evidence](LOCAL_EVIDENCE.md)
- [Baseline actual answers - local evidence](LOCAL_EVIDENCE.md)
- [Final route capture - local evidence](LOCAL_EVIDENCE.md)
- [Final actual answers - local evidence](LOCAL_EVIDENCE.md)
- [Final runtime identity and telemetry - local evidence](LOCAL_EVIDENCE.md)
- [Independent final assessment - local evidence](LOCAL_EVIDENCE.md)
- [Paired assessment and separate response paths - local evidence](LOCAL_EVIDENCE.md)
- [Assessment and source/hash validation - local evidence](LOCAL_EVIDENCE.md)
- [Final quality conclusion - local evidence](LOCAL_EVIDENCE.md)

The original baseline assessment is preserved. Eight individual answer hashes
were initially calculated from Windows-decoded rather than UTF-8 text. An
[explicit hash-only erratum - local evidence](LOCAL_EVIDENCE.md)
corrects those references; raw answers, bound source files and every grade remain
unchanged. The first comparative summary is retained as superseded evidence.

Automated preparation assertions, independent agent assessment and physical
user acceptance are distinct. Physical acceptance of these answers is **not
run**. No prompts, routing or questions were tuned after inspecting this final
confirmation run; doing so would require a new confirmation set and candidate.
