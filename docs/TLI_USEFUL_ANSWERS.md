# TLI anniversary: useful answers from the right information

Historical checkpoint record. The later [continuity program](TLI_CONTINUITY_PROGRAM.md)
ran the installed Standard model in isolation and added repeated-line excerpt
selection. Real answers were scored and the quality gate failed; the earlier
preparation-only passes below must not be read as current model certification.

This checkpoint improves existing Chat, Notes & fixes and selected-document
questions. It adds no models, inference requirements, background learning or
search index. The running host and its data are outside the verification scope.

## The five changes

### 1. Exercise the preparation that Chat actually uses

The earlier answer-review tool supplied handwritten messages directly to a
provider. Those cases remain useful as prompt-review examples, but could not
detect a retrieval failure. Synthetic persisted notes, conversations and reports
now exercise the application's actual preparation code separately. Checks cover
current revisions, deleted and irrelevant notes, scope, optional memory and input
limits, with receipts and captured-input hashes available for review. Route tests
also inspect the exact provider requests through synthetic transports.

Passing these checks proves what information TLI supplies. It does not prove
that a Qwen model understands it or returns a correct answer. Real inference
and human answer review remain explicitly launched, optional checks; neither was
run against the user's model during this batch.

### 2. Recognize a limited follow-up topic

A narrowly recognized short follow-up can reuse a recent user-authored topic
within the same owned conversation. Assistant text is never a source of retrieval
terms. Current note versions are looked up again; older answers do not resurrect
deleted notes or overwrite corrections. Selected computer restrictions and the
saved-notes setting still apply. An unrelated question, another conversation or
a standalone reference exchange does not silently become the retrieval subject.

New ordinary-answer receipts retain a bounded optional recall scope so a later
follow-up can check the selected computer. Older receipts without that scope
remain readable; ambiguous selected-computer recall stays conservative.
This is deterministic word matching. It can miss a useful note, and does not
establish that a past fix explains the computer's current condition.

### 3. Review a correction against an existing note

The existing chat review offers a new copy or **Update existing note**. Selection
is explicit; the current note and proposed title, text, category and computer are
visible before Save. Updates require the owned note's exact reviewed revision.
Conflicts retain the proposal for another review, without automatic merge or retry.

The update keeps the note ID and creation time, records the newly reviewed chat
source and changes only the chosen note. Replacing a confirmed historical fix
with an AI suggestion removes its diagnostic-confirmation association. It does
not claim the new advice was tested. New-copy saves retain their existing
duplicate protection. Drafts stay in memory and clear on lock.

### 4. Choose useful whole-line document excerpts

The existing four-file, 64 KiB UTF-8 .txt/.md limit remains. A document that fits
keeps its complete numbered reference. If the formatted text exceeds the request
budget, TLI selects whole lines using question words and nearby context, or
representative positions for a broad question. It reselects against the chosen
runtime's available configured-context estimate before transport.

Each excerpt receipt records original line ranges, included and omitted line
counts, selection method and the normalized whole-document hash. A selected file
can be entirely omitted; that is reported as omitted, never empty. The model is
told that omitted passages may matter and that it cannot claim a full review.
An indivisible long line may still fail with a useful explanation. Original files
are never changed. Candidate budget checks and range counts are bounded.

Only the current question and these references are sent. History, other notes,
Vault content, images, tools and selected computer/report context remain excluded.
No new forwarding or provider fallback is introduced. Citations remain model
output, not verified guarantees. Receipts contain no source body, although a
saved answer can quote it. Older receipts without coverage remain readable.

### 5. Show and improve response delivery

The response indicator measures browser-observed waiting, first text and elapsed
time for the current request. It does not label waiting as model reasoning or
claim to measure a server's internal stages. Completion and interruption have
different labels. Stop ends receipt in the current view without claiming that
server-side actions stopped; retry still requires deliberate Send.

A transport delay was reproduced with a synthetic loopback SSE provider:
the default 512-byte read withheld a complete small first frame until subsequent
output or completion. The bundled stream now yields a frame when its newline
arrives, including split UTF-8 characters. The regression holds provider
completion behind an event, proving first text arrives before completion rather
than relying on a guessed latency threshold. Truncated streams still fail.

## Preservation

- Existing URLs, SSE event names, model selection and note IDs remain in place.
  Reviewed updates and document coverage use bounded optional metadata.
- No new inference, device actions, household file operations, downloads, live
  restarts, phone pairing or native builds are used by the tests.
- Existing recovery, authentication, ownership, encrypted-store and streaming
  suites remain release gates. Source changes after final verification require a
  new snapshot.

## Verification record

Pre-change snapshot: `build_work/useful-answers/release-snapshot-a7cn6ml2/source`,
498 files, source fingerprint
`718232d68ba9bf1e037f326a4563800fb6af0f5069c00cfc4fa1d14bb25c9892`.

Fresh isolated baseline: **1,571 backend, 609 frontend and 56 tooling tests
passed**, with 2,235 existing backend warnings. Logs are
`build_work/useful-answers/baseline-backend.log`, `baseline-frontend.log` and
`baseline-tooling.log`. The two new streaming regressions failed against the
previous transport and pass after the fix; these are demonstrated defects,
separate from baseline suite failures.

Final frozen source: `build_work/useful-answers/release-snapshot-rmwyezqt/source`,
**504 files**, fingerprint
`00a08203b690171945e3aba6b6616b90d411e11fb90d22b51eddabd09be2bd00`.
Snapshot verification confirms that the working-tree source matches exactly.

Complete frozen-source suites passed: **1,640 backend tests, 639 frontend tests
and 62 tooling tests**. Logs are `frozen-backend.log`, `frozen-frontend.log` and
`frozen-tooling.log` in `build_work/useful-answers`. The backend recorded 2,481
deprecation/configuration warnings, without test failures. Earlier intermediate
snapshot and browser logs are retained separately and are not the final candidate.

Final browser verification passed **64 checks across 22 themes**, with **26
current screenshots and four baseline screenshots**, no failures and unchanged
source hashes. It covers desktop, 390/320-pixel layouts, keyboard save, doubled
text, reduced motion, preserved drafts, update conflicts, duplicate prevention,
Stop, delayed responses and lock. Both note-review and document-coverage surfaces
were checked across the themes. Detailed visual review used Emerald Light and
Midnight. Simulated answer receipts do not claim to verify backend retrieval;
the preparation and route tests cover that separately.

- [Before/after review gallery](../build_work/useful-answers/review.html)
- [Final browser report](../build_work/useful-answers/browser-2026-09-08T05-29-50-257Z/report.json)
- [Frozen offline preparation report](../build_work/useful-answers/frozen-offline-answer-review.json)
- [Source and artifact verification manifest](../build_work/useful-answers/delivery-manifest.json)

| Area | Verification |
|---|---|
| Actual preparation and follow-ups | Encrypted synthetic stores, current revisions, deleted/irrelevant notes, exact route-captured provider requests, changed computer/reference boundaries and memory off. |
| Reviewed updates | Owned source and target, stale/missing revisions, simultaneous requests, byte preservation after rejection, unchanged custom categories and retired computer associations, no new confirmed-fix status. |
| Document excerpts | Whole lines, original hashes/ranges, omitted files, multilingual text, huge single lines, bounded work, actual configured-capacity refit and no original source body in saved receipts. |
| Response delivery | Real loopback frames before provider completion, split UTF-8, truncated stream failure, browser timing, Stop during preparation/streaming, no automatic replay. |
| Existing TLI | Complete authentication, streaming, device/action, model lifecycle, persistence and separate-copy recovery regressions, plus repository tooling. |

The independent update-path review found and closed two preservation defects:
unchanged older categories and unavailable-computer associations can now survive
a reviewed text update, while new assignments remain validated. A subsequent UI
review removed carried unsupported choices when switching back to a new note.

This is a source/browser checkpoint. A normal manual TLI restart loads backend
changes; no live restart was performed. Physical phones, native installations,
screen-reader acceptance and real-model answer quality remain unverified.

The expanded offline corpus has **17 cases**: nine actual Chat-preparation cases
and eight clearly identified handwritten provider fixtures. All nine preparation
cases pass; model and human-review results stay **not run**. The CLI records
preparation failures and exits nonzero, without sending those cases to a provider.
To produce a new report with the existing backend Python environment:

```powershell
backend/.venv/Scripts/python.exe scripts/evaluate_ai_answers.py --output build_work/new-answer-review.json
```

Reports are created exclusively and do not overwrite previous results. See
`build_work/useful-answers/answer-preparation-offline.json` for this batch's run.
The document preparation benchmark used synthetic in-memory text only: seven
runs per case, with median 0.078 ms for a short full-fit document and 68–321 ms
for the tested 64 KiB cases. These measurements are local preparation costs,
not model-response speed or a guarantee on another computer.
