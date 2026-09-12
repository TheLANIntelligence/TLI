# TLI anniversary: grounded answers and dependable conversation

This is the historical record of the first grounded-answer checkpoint. The later
[useful-answer checkpoint](TLI_USEFUL_ANSWERS.md) extends evaluation through actual
Chat preparation, adds reviewed note updates and explicit whole-line document
excerpts, and measures response delivery. The earlier handwritten provider cases
remain separate from preparation verification and real-model answer acceptance.

This checkpoint improves the existing Chat experience and its relationship to
host observations, saved context and available inference. It adds no models,
integrations, background learning or persistent-data migration.

## Answers tied to the question

The old bundled tool shortcut matched broad words such as `CPU`, `RAM`, `drive`
and `why is my`, then returned storage output first. The shared observed-answer
service now classifies whole, specific host-status questions before action
routing. Bundled Chat, bundled streaming Chat and the existing `/chat` route use
the same observations for these questions.

CPU uses the existing dashboard observation. Memory and storage use passive
local operating-system readings. Network answers describe local interfaces;
they do not scan the LAN, ping another machine or establish internet health.
Printer answers describe the retained inventory and its observation age, without
silently running discovery. A single sample cannot establish a sustained overload
or the cause of a slow connection. General explanations, code questions and
device commands are not intercepted just because they mention a topic.

Replies identify the TLI host, resource, source, observation time and coverage.
The existing 30-second freshness rule applies. Empty, unavailable and stale
observations have different meanings; missing readings do not become zero.
Explicit drive questions retain the drive. Larger inventories state omissions.
Recorded observations remain historical when a conversation is reopened.

Storage reads inherit the existing operating-system volume helper's latency;
an unresponsive mounted drive can delay that read. This checkpoint does not add
a new polling process or a hard timeout around operating-system enumeration.

An explicitly selected diagnostic report prevents a new diagnostic or unrelated
host shortcut. Device/report context takes precedence over host-only shortcuts;
reference-only questions continue through their existing controlled provider
paths. Device commands retain the existing ambiguity resolver. Narrow utility
questions no longer use unauthenticated HTTP calls back to the host or assume
relay zero for every registered smart device.

## Context that fits more predictably

Ordinary chat, selected-note questions and formatted document questions share a
final text-budget check. The existing 12,000-character ceiling remains. The check
counts final formatted reference text, a message/template allowance and the
requested answer reserve. Whole optional notes and complete recent exchanges may
be omitted with matching receipts; required instructions, the latest question and
explicitly selected references are never silently sliced.

The bundled runtime records its actual owned launch configuration in memory.
Its configured context size is used only while the process and model identity
still match. Final validation occurs inside the existing generation guard.
Changing capacity cannot authorize an oversized request prepared earlier.

Token estimates are **heuristics**, not tokenizer measurements. The estimate
accounts more conservatively for punctuation, code and non-ASCII UTF-8 than a
single English character ratio. Configured context is not a guarantee that input
fits or that an answer will be useful. LM Studio's effective capacity remains
unknown with the current adapter; it receives the character limit and an explicit
answer limit. Missing runtime metadata is unknown, never guaranteed fit. Images
retain their separate path and are outside text-only capacity claims.

Chat no longer uses LM Studio's inference-based readiness probe before the actual
question. Each attempted provider validates its own input. Failure after an
uncertain generation request does not silently send the question to another
provider. Additive, bounded `input_budget` and `observation_context` receipts are
available in responses and saved history; existing endpoints, SSE names and
saved formats remain compatible.

## Interrupted work and private scope

An interrupted response keeps the text already received and labels it incomplete.
**Review question to retry** prepares the composer only; the user must send it.
Newer typing is preserved. A failed or interrupted answer is not saved as a
completed assistant response. Partial display is temporary and is cleared when
the conversation changes or the session locks.

Successfully opening a different conversation clears the previous device/report
selection. A failed history load leaves the current view and context intact.
New Chat, lock and session expiry invalidate pending private-context reads.
An old response cannot repopulate a cleared context or lock a newer session.
Stopping browser receipt does not claim a server-side action was cancelled.

## A repeatable answer-review set

`scripts/evaluate_ai_answers.py` contains no application imports or household-data
access. Its eight synthetic cases cover corrected notes, deleted-note history,
irrelevant preferences, explicit computer scope, document citations, injected
document instructions, Unicode/code and unsupported capabilities.

The default command produces an **offline review plan**, with every model and
human-review result marked **not run**:

```powershell
backend/.venv/Scripts/python.exe scripts/evaluate_ai_answers.py --output build_work/answer-review-plan.json
```

An optional, separately launched local evaluation requires all three explicit
arguments below. Replace the example port and model identifier with the intended,
already available runtime. This command **does request inference**; it was not run
against the user's model during this checkpoint.

```powershell
backend/.venv/Scripts/python.exe scripts/evaluate_ai_answers.py --run-local --endpoint http://127.0.0.1:1234/v1 --model EXACT_MODEL_ID --case corrected-note --output build_work/answer-review-local.json
```

Only literal loopback IP endpoints are accepted. There are no redirects, inherited
proxies, tools, retries, provider fallback, downloads or model lifecycle calls.
Case count, response size, per-case timeout and output tokens are bounded. Existing
reports cannot be overwritten. A provider may itself load the explicitly requested
model when receiving the request; the harness does not guarantee otherwise.

Reports record fixture and relevant source hashes, requested/reported model IDs,
limits, elapsed time, available usage counts and completion reason. Mechanical
flags identify missing expected topics, invalid citations and potential false
action claims; they are **review hints, not an accuracy score**. Every case retains
a human-review rubric. Fake-provider tests validate the harness, not Qwen quality.
No real-model answer quality has been established by this checkpoint.

## Preservation and next recovery checkpoint

The audit also found an archive-validation mismatch: a malformed saved-chat source
could pass the backup check while the current notes reader rejected it. The shared
memory validator now gives ordinary reads, saved-data checks and archive validation
the same acceptance rules. Valid legacy notes remain supported. No recovery writer
or Restore control is added here.

The next data checkpoint remains reviewed recovery of Notes & fixes, conversations
and diagnostic history into a **separate empty location**, followed by real reader
reopen checks. Merging into current data, whole-installation recovery and Vault
recovery are separate work. Diagnostic rechecks, Home Automation expansion, voice,
native Companion builds and physical-phone acceptance remain parked.

## Verification record

Fresh baseline: **552 frontend tests and 1,196 backend tests passed**, with the
existing 2,070 backend warnings recorded separately. The source snapshot includes
all existing uncommitted source work:

- Source: `build_work/answer-quality/release-snapshot-5jtot5q2/source`
- Fingerprint: `127cc15d5a3d1c7d1665a4d8b257075d5f09085e14f7257849f69369f1cc94ac`
- Logs: `build_work/answer-quality/baseline-frontend.log` and `baseline-backend.log`.

Final application checks: **1,459 backend tests passed** (2,235 warnings) and
**582 frontend tests passed**, including the frontend suite repeated against the
frozen source. The backend warnings are recorded in the log; they are not test
failures. The 77 focused budget tests include changed-model/endpoint races,
oversized formatted references and preservation of generic Builder/file providers.

- Final source: `build_work/answer-quality/release-snapshot-4z34imau/source` (491 files).
- Fingerprint: `8205aedb5ec691c74079793816c6d59203b5c29969fd740463d596d87dd07b06`.
- Snapshot verification confirmed that the source matches the working tree.
- Backend log: `build_work/answer-quality-final-backend.txt`.
- Frontend logs: `build_work/answer-quality/frontend-recovery-rerun.txt` and `frontend-frozen.log`.

The additional developer-tooling run exposed one pre-existing failure in the
HTTPS restart rehearsal. Running that focused test against the untouched baseline
reproduced it. The assertion expected the older live-only `restarted` coverage,
while retained activity correctly reports `retained_partial` with a restart gap.
The updated harness checks changed stream identity, preserved review position and
the applicable explicit coverage gap, alongside the existing authentication and
byte-preservation gates. Its focused run passed. Baseline and current reports are
`build_work/answer-quality/https-baseline-report.json` and `https-current-report.json`.
All harness-owned processes stopped; only an isolated loopback host was launched.
The final complete developer-tooling suite passed **56 tests**; its log is
`build_work/answer-quality/tooling-final.log`.

Browser verification passed **48 checks across all 22 selectable themes**, with
18 current screenshots, no script/request errors or contrast failures, and
unchanged source hashes. Detailed checks covered 1440/390/320-pixel views,
Emerald Light/Midnight, keyboard-only retry review, streaming and resumed receipts,
doubled text and reduced motion. Long cards remain internally scrollable.

- [Before/after review gallery - local evidence](LOCAL_EVIDENCE.md)
- [Current browser report - local evidence](LOCAL_EVIDENCE.md)
- [Frozen-source before views - local evidence](LOCAL_EVIDENCE.md)
- [Offline model review plan - local evidence](LOCAL_EVIDENCE.md)

The two baseline screenshots reproduce partial text being overwritten by an error;
the updated screenshots retain the answer and newer draft. These are synthetic
browser fixtures, not physical-phone, native-platform, screen-reader or real-model
acceptance. Automated checks used temporary persistence, fake providers/readers
and intercepted requests. Live TLI was not restarted, its model was not queried or
switched, and no household files or devices were operated.
