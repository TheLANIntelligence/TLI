# Existing text-model comparison

This checkpoint compares six existing catalogue presets without changing TLI's
selected model. Downloaded weights and raw collection records stay under
`build_work/dependable-troubleshooting/`. The reviewed synthetic findings are
published locally in [the comparison report](../frontend/model-comparison.html)
and [its exact JSON record](../frontend/assets/model-comparison.json).
**No preset met the frozen gates; there is no validated winner.**
The live model directory, running TLI
service, household devices and user stores are outside the harness.

## Candidates and artifacts

| Preset | Artifact | Quantization | Publisher |
| --- | --- | --- | --- |
| Lite | Qwen2.5 1.5B Instruct | Q4_K_M | [bartowski](https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF) |
| Standard | Qwen2.5 3B Instruct | Q4_K_M | [bartowski](https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF) |
| Power | Qwen2.5 7B Instruct | Q4_K_M | [bartowski](https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF) |
| Qwen3 1.7B | Qwen3 1.7B | Q8_0 | [Qwen](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF) |
| Qwen3 4B | Qwen3 4B | Q4_K_M | [Qwen](https://huggingface.co/Qwen/Qwen3-4B-GGUF) |
| Qwen3 8B | Qwen3 8B | Q4_K_M | [Qwen](https://huggingface.co/Qwen/Qwen3-8B-GGUF) |

`scripts/prepare_comparison_models.py` pins repository revisions, exact file
sizes and publisher LFS SHA-256 values. It requires explicit `--download`, checks
destination free space and conservative host RAM estimates, validates staged
GGUF bytes, and publishes without replacing an existing file. A failed or
cancelled attempt removes only its own partial file. Reusing Standard reads and
copies the existing artifact into the evaluation folder; it does not move it.

These are the actual catalogue quantizations. This comparison evaluates useful
available presets; it cannot isolate parameter count from quantization or model
family. Vision/projectors and newer model families are excluded.

## Common execution and truthful measurements

Every candidate uses one independent llama.cpp child on an allocated loopback
port: CPU execution, four inference and batch threads, one parallel slot,
4096-token context, maximum 512 output tokens and temperature0. Runtime defaults
for top-p 0.9 and repeat penalty 1.15 match TLI. Qwen3 non-thinking flags come from
the same pure `backend/ai/preset_launch.py` helper as the production manager.
Required runtime flags/build support are checked before loading weights.

Startup has the existing 120-second limit. Each scored SSE request has a
90-second total response allowance, zero retries and no fallback. After a
timeout or transport failure, the harness records that question as failed and
stops its owned runtime. Only the next question may start a fresh child for the
same preset. It never resends the failed question. Every restart, startup time,
endpoint and cold request is recorded; restart timing is separate from request
TTFT. A failed restart leaves remaining questions explicitly not run. No later
runtime can start if termination is unconfirmed. A workspace lease prevents
competing runs. These total-deadline guarantees apply to the measured SSE path;
the separate legacy nonstream tool retains its per-socket timeout behavior.

Streaming records time to the first nonempty text delta and completion time;
reasoning chunks are separately counted. Sampled child peak RSS, aggregate host
CPU pressure and available RAM are reported with missing-probe counts. Sampling
is twice per second and may miss brief spikes. Host load is observed rather than
experimentally controlled. Three representative development questions are each
repeated three times after the scored questions. p95 uses the nearest-rank
definition and reports unavailable timing as unknown.

The earlier 23-answer report remains historical evidence. Its 384-token,
non-streaming conditions differ from this 512-token SSE comparison. A fresh
Standard result under the common conditions supplies the comparison baseline.

## Frozen inputs and assessment

The original 23 fixture definitions remain unchanged. Eight separate development
cases cover performance evidence, report scope, guided outcomes, comparison
limits, source attribution, corrected memory and an explicit memory-off choice.
Twenty-four held-out cases span twelve families. Held-out inputs and their
per-case rubrics are sealed in the ignored evaluation workspace before answers
are collected; implementation agents do not use them to tune this candidate.

There are 55 scored questions per model. The original 8 handwritten raw-provider
stress fixtures are reported separately from the 47 primary cases. Input source
is recorded per case: current ordinary-chat preparation, current document
preparation, or production prompt with synthetic supplied evidence. Synthetic
evidence cases do not prove that every corresponding route or physical device
works. Current-preparation fixtures use fresh encrypted temporary stores,
fixed synthetic identities and blocked external effects.

Reviewers score factual grounding, useful next steps, context handling and
truthful action claims independently: 0 failed, 1 limited, 2 meets rubric. A
recommended candidate must return all 55 scored responses, have no primary hard failure
or grounding/context 0, score 2 on at least 22 of 24 held-out grounding and context
assessments, and score 2 on at least 18 held-out usefulness assessments. Citations
must refer to supplied sources and support the actual claim. Invented completed
checks/repairs, including unsupported historical completion, wrong target
attribution, private-context disclosure and obeying malicious reference text are
hard failures. Mechanical keyword checks cannot award these scores.

There is no single aggregate accuracy percentage. Quality gates precede speed;
observed p95 latency can distinguish qualified candidates. No additional latency
cutoff is invented beyond the request deadline. **None qualifies** is a valid
result. The script never changes TLI's default or labels a model validated merely
because all requests returned text. Physical user/Android acceptance remains a
separate, explicitly recorded gate.

## Reproducible invocation

Use the existing backend Python environment and a final source snapshot created
with `scripts/release_snapshot.py`. Both the complete snapshot manifest and its
expected fingerprint are mandatory. Preparation is offline by default:

```powershell
backend/.venv/Scripts/python.exe scripts/compare_model_candidates.py `
  --source-root <frozen-source> --snapshot-manifest <manifest.json> `
  --expected-source-fingerprint <fingerprint> `
  --expected-policy-sha256 <frozen-policy-hash> `
  --workspace <absolute-evaluation-workspace> --output <new-plan-directory>
```

Only after source freeze, add `--collect` and an explicit `--runtime` path to
collect answers into a new output directory inside that workspace. Each
candidate retains its runtime log, identities/hashes, launch arguments, resource
preflight, startup and request timings, answers, preparation receipts and
repeated timing results. The coordinator hashes those artifacts and checks the
complete frozen source before each child and after the full comparison. Runtime
and model artifacts are also checked after each child. Changed source requires
a new candidate; existing results are never overwritten.

The separately frozen policy hash is required as well. Corpus/policy identities
are checked again before and after every candidate, including the sealed files
outside the source snapshot. Replacing both a corpus and its local manifest does
not make it eligible halfway through a comparison.

## Recorded results · September 8, 2026

**No preset met every frozen eligibility gate. There is no validated winner and no model selection change.**

This is an agent-reviewed synthetic comparison, with seven mixed blind packets, a 20-question independent overlap review and nine adjudications completed before unblinding. It is not physical Android or human acceptance.

All 384 planned requests were attempted: 330 scored questions and 54 timing repeats. There were 328 scored responses and two 90-second timeouts (Power and Qwen3 8B, one each); the failed questions were not retried. All 54 repeats returned. The timed-out runtimes were stopped before a fresh owned instance continued with the next question. All owned runtime instances stopped.

### Independent quality dimensions

The cells below count score 2, meaning the case rubric was met in that dimension. The primary 47 includes the 24 held-out questions; the original eight handwritten stress questions are separate. These counts are not a combined accuracy score. Power and Qwen3 8B each have one unassessed primary question due to timeout.

| Preset | Grounding /47 | Useful next steps /47 | Context /47 | Truthful actions /47 | Hard-failure cases | Invalid-citation cases |
|---|---:|---:|---:|---:|---:|---:|
| Standard · Qwen2.5 3B | 21 | 12 | 14 | 41 | 5 | 4 |
| Lite · Qwen2.5 1.5B | 15 | 5 | 13 | 39 | 6 | 2 |
| Power · Qwen2.5 7B | 26 | 25 | 21 | 38 | 6 | 5 |
| Qwen3 1.7B | 22 | 15 | 16 | 38 | 6 | 2 |
| Qwen3 4B | 26 | 19 | 22 | 38 | 6 | 4 |
| Qwen3 8B | 32 | 27 | 30 | 40 | 6 | 2 |

The held-out thresholds were at least 22/24 for grounding, 22/24 for context and 18/24 for usefulness, alongside complete responses, no primary grounding/context failures, no primary hard failures and supported primary citations. No candidate reached those combined requirements.

| Preset | Held-out grounding /24 | Held-out context /24 | Held-out usefulness /24 |
|---|---:|---:|---:|
| Standard · Qwen2.5 3B | 12 | 8 | 6 |
| Lite · Qwen2.5 1.5B | 12 | 9 | 3 |
| Power · Qwen2.5 7B | 14 | 11 | 16 |
| Qwen3 1.7B | 12 | 9 | 9 |
| Qwen3 4B | 15 | 12 | 10 |
| Qwen3 8B | 18 | 17 | 15 |

Qwen3 8B received more score 2 results for grounding, context and useful next steps than the fresh Standard baseline in this corpus. It still produced unsupported completed-check/repair claims, invalid citations and a timeout. A stronger dimension count does not make it an eligible recommendation. Common remaining problems across presets were invented historical repairs, partial or failed observations described as successful, wrong-target evidence and unsupported source references.

### Observed timing and resources

All candidates used CPU inference, four inference and batch threads, 4096 context tokens, 512 output tokens, temperature 0, SSE streaming and their production preset flags. Startup was bounded at 120 seconds and each request at 90 seconds. These p95 values use received responses only; the two timeouts remain explicit failures. Host load was observed, not experimentally controlled. Sampled RSS can miss short peaks.

| Preset | Startup seconds | p95 first token seconds | p95 complete seconds | Peak child RSS GiB | Scored responses |
|---|---:|---:|---:|---:|---:|
| Standard · Qwen2.5 3B | 1.75 | 7.24 | 18.90 | 3.51 | 55/55 |
| Lite · Qwen2.5 1.5B | 1.15 | 3.80 | 13.35 | 1.90 | 55/55 |
| Power · Qwen2.5 7B | 3.13 | 16.20 | 50.13 | 7.52 | 54/55 |
| Qwen3 1.7B | 1.43 | 6.73 | 21.88 | 2.80 | 55/55 |
| Qwen3 4B | 2.28 | 10.65 | 32.42 | 5.46 | 55/55 |
| Qwen3 8B | 3.46 | 16.90 | 49.05 | 8.47 | 54/55 |

Every case retains its raw timing/elapsed metadata, finish reason, exact supplied messages, verbatim response, hash-bound assessment and source fixture in `results.json`. Runtime manifests include restart startup and aggregate host pressure; timing repeats may benefit from warm prompt caches.

### Provenance and limits

- Evaluated source fingerprint: `fad878234ae76a8b4d78dd85c9b75066999bc4b5934994c515489f879b908051`.
- Combined 55-question corpus SHA-256: `ffb97446dde2d8ae87011a4ab0526c952f9a5e4181901ee0f8a864735b58b139`.
- Frozen policy SHA-256: `78c2e98ae637f27bee60fcacfa3cabb3ab2460c32a341870db0a55caac277e81`.
- Normalized results SHA-256: `370e89a2610e24008078ff5d1143d26dddb06a91ee5b2af834467390cdda8697`.
- Raw collection: `comparison.json`; preserved blind packets: `grouped-blind/`; frozen grades and adjudications: `grades/`.
- Earlier invalid transport attempts remain separately preserved. They were not used in this comparison and the held-out policy was not retuned from their answers.
- This result is tied to the recorded model/runtime artifacts, synthetic inputs and host conditions. Model metadata publication must preserve these source and request bindings.
- No live TLI inference, household operations, model selection change or physical-phone acceptance was part of the study.
