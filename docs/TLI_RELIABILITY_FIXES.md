# TLI reliability corrections — September 12, 2026

This checkpoint follows the extensive anniversary-preview audit. It corrects
the demonstrated cleanup and authorization gaps, improves browser Chat on
phones, and tests a proposed change to how selected troubleshooting steps are
presented to the installed Standard model. It is source work, not a replacement
of the published preview or a claim of physical-device acceptance.

## Baseline and preservation

The pre-edit snapshot contains 796 files and has source fingerprint
`4e36dcadc8b45e3ca0a98da73468bc91365493d30c8b641a2c6759c91150e190`.
It matches the source in the preceding fresh audit. That audit passed all 27
release-verification stages while additional probes exposed the defects below;
passing the existing suite did not invalidate those findings.

The original audit, historical release, existing uncommitted work, active model,
pairings and household data are preserved. Verification uses isolated stores,
synthetic accounts, fake Trash operations and owned runtime processes. No live
TLI restart, native build, remote-access setup or publication is part of this
correction. A running server will need a normal restart to load changed backend
code; the verification harness does not perform that restart.

## Reviewed cleanup keeps its final checks after journal writing

Previously, the selected file and duplicate keeper were checked before the
attempt receipt was written. A pathname could change during that write and reach
Trash despite differing from the reviewed selection. The journal now precedes
the final file and keeper checks. Authorization is checked again after the
journal and after file inspection.

An affected item is not dispatched; subsequent items stop. Confirmed earlier
moves retain their receipts. Retrying the operation returns its recorded outcome
without dispatching again. Seven new regressions first failed against the
baseline, then passed; the focused cleanup/storage/action suite passed 95 tests.
The tests include same-content file replacements, keeper removal/replacement,
changes before the first or a later move, and revocation during inspection.

The OS Trash API still accepts a pathname. This closes the reproduced journal
window, not every possible external rename between the last check and OS
dispatch. Existing journal formats, uncertain outcomes and reviewed selection
requirements remain. See [Reviewed storage cleanup](REVIEWED_STORAGE_CLEANUP.md).

## Backup work retains its original authority

Saved-work creation, verification and separate-copy recovery capture authority
before reading request bodies or doing private work. They check it during
archive processing, readback and recovery staging, and before publication or
returning a result. Vault operations use the same credential binding. Prepared
Vault downloads check access before headers and each ciphertext chunk; failures
close their owned encrypted temporary files. Interrupted multipart parsing also
closes its temporary spools.

Revoking a credential that was valid when an operation began stops that operation
at the next check, even if PIN removal subsequently opens local access. A new
explicit request may use intentionally open local access with an already-stale
browser cookie. This preserves the normal two-browser PIN-removal workflow;
neither clearing cookies nor automatic retry is required. Invalid Bearer
credentials never become anonymous authority.

The new coverage includes real synthetic PIN sessions, two-browser PIN removal,
late body/upload revocation, download interruption, private-work checkpoints,
owner-lookup interleaving and no recovery publication after revocation. Archive
versions, scopes, encryption settings, ownership and existing records are
unchanged. Final component results are in the delivery evidence linked below.

Checks are not atomic with every OS operation. A blocking bounded read or KDF
finishes before the next callback; existing periodic Vault checks may wait up to
one second between checks. That scheduling interval is not a wall-clock stop
guarantee around a blocking call. Already-delivered bytes cannot be recalled. A copy published just
before revocation remains published even when its response is subsequently
suppressed. Separate-copy recovery never becomes a live-data merge.

**Stop waiting** or closing the view does not itself revoke the session or
cancel an already-running owned worker. That work may finish. Check its
destination or prepared download before making another explicit attempt;
reconnecting never automatically replays the request.

## Browser Chat makes the first question visible on a phone

Modern and Classic phone layouts now reserve space for the existing message
field and Send control. The conversation scrolls within its workspace, the
AI Chat heading remains visible, and optional section help is available in
Options. Selected or expanded context uses natural page flow so it cannot
overlap Send or a neighboring Classic card. The phone Chat metric strip has a
predictable grid while retaining its metric and freshness labels.

Compact sharing labels read **Saved notes** and **Earlier chat**, with full
accessible control names. Their values and sharing rules are unchanged. Opening
help or changing layout does not recreate the composer, replace a draft, attach
information or send a request. Lock still clears private state. Duplicate
branding and the empty welcome suggestions are reduced on phone Chat; desktop
help returns to its existing location. Free Space's narrow **Review cleanup**
label wraps at whole words beside its unchanged explicit checkbox.

Coverage includes first and completed replies, explicit context, Options/help,
keyboard use, enlarged text, reduced motion, lock, Modern/Classic and all 23
themes at desktop, tablet, 390- and 320-pixel widths. Browser fixture results do
not certify a physical Android keyboard or the native Companion app.

## Real-model assessment stays separate from software tests

The trial freezes six earlier audit questions and six new status/performance
variations before any new answer is examined. Baseline and candidate each receive
the same selected facts. Only their selected-case presentation differs; ordinary
Chat requests and deterministic controls must remain equal. The installed
Standard weights run on a separate owned loopback runtime, with CPU mode, four
threads, 4096 context tokens, 512 output tokens, temperature zero and bounded
startup/requests. The live model service is not used.

All 24 model requests completed. Both owned runtimes stopped and their source
snapshots remained unchanged. A phase-hidden paired packet supports independent
answer review against grounding, usefulness, context handling and action claims.
Retention rules were written before inference; a good example or an average
score cannot excuse a new critical failure. This small author-created set is not
an untouched independent holdout or a general accuracy estimate.

The raw answers still contain factual mistakes and invented attempts. In both
arms, a comment attached to a planned firmware upgrade was misread as evidence
of an attempted upgrade. The active model and recommendation remain unchanged.
The proposed change was **rejected**: despite fewer critical positions overall,
it introduced a new paired invented-action failure and new zero-score dimensions,
and did not meet the frozen non-regression rules. Only the trial's own production
edit was reverted; its source, new test and answers are archived with the evidence.
Existing answer preparation remains. Software checks must not be described as
proof of reliable AI judgment.

## Delivery and remaining acceptance

The integrated 798-file source
`f1becd4dfc11e8724b96d1afc93e02c3b3c85d6fa36dd2dd27f35dd44b9c2670`
passed all 27 release-verification stages: **2,800 repository backend, 2,788
extracted-package backend, 1,133 desktop, 178 tooling and 191 Companion tests**,
plus TypeScript, clean Android/iOS/web exports and synthetic HTTPS/recovery.
The packaged suite deselects its one Git-dependent reader test and excludes
repository-only packaging tests; these run in the repository suite. Existing
deprecation warnings remain visible in the logs.

The final browser matrices passed 568 overlapping check records across all
23 themes, with 181 screenshots and zero browser errors. All 154 tested frontend
components match the final source. The final source also prepares the same
12 evaluated baseline model requests and two deterministic controls. This input
equivalence does not turn the model's strict-quality failure into a pass.

The [review gallery](../build_work/reliability-fixes/review.html),
[final results](../build_work/reliability-fixes/RESULTS.md) and
[source/evidence manifest](../build_work/reliability-fixes/final-manifest.json)
record the frozen integrated source, complete verification, component evidence,
before/after views and trial decision. Final counts belong to that exact snapshot;
earlier focused runs and failed development attempts remain separately labeled.

Physical Android update/pairing/keyboard checks, two-computer operation, real
Trash, production installation and real-data recovery remain **not run** in this
batch. Remote connectivity remains deferred. No claim is made that all
anniversary acceptance gates are closed.
