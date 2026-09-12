# Reviewed Free Space cleanup

Implemented in the working tree on September 6, 2026. This is a building
checkpoint, not a packaged release. The user chose this batch after parking
diagnostic rechecks.

## September 9, 2026 Free Space rebuild addendum

This addendum describes the current implementation. The September 6 workflow
and verification record below remain a historical checkpoint; statements there
about direct-delete compatibility, automatic rescan, and simple latest-20
receipt retention are superseded here. This is not a claim that a new package
or a physical operating-system Trash operation has been verified.

### What changed and where to find it

Open **Free Space**, explicitly scan a chosen host location, and select individual
files from the observation. The selection bar opens **Cleanup review**. On
screens at or below 800 CSS pixels, review opens in a native modal drawer using
the same controls and selection. Close, Escape, or backdrop dismissal restores
those controls to their original position and returns focus; opening or closing
review does not scan or move files. Wider screens retain the inline disclosure.
Duplicate groups show at most 100 paths per page. A chosen keeper remains visible
in the keeper menu when it is on another page. Page changes select nothing, and
only explicitly checked paths enter the maximum-100-file cleanup request.

Ordinary backgrounding or leaving the panel retains the cleanup selection and
receipts in page memory, invalidates an unused preview and ignores late responses.
Returning does not automatically retry, check a receipt, or move files. Locking
clears private selections, duplicate maps and receipt DOM. Only an opaque
outstanding request ID and a content-free attention marker can remain so an
explicit result lookup can recover an interrupted view. They are not written to
browser persistence. Old callbacks cannot repopulate a newly unlocked view.

### Direct shortcuts now require review

- `POST /visualizer/delete` and `POST /cleanup/clean_safe` retain their URLs but
  return HTTP 409 with `detail.code = "review_required"`. They do not inspect,
  move, quarantine or permanently delete the submitted path.
- A queued Dashboard `cleanup_clean_safe` action only navigates to Free Space.
  The legacy Chat cleanup intent returns review instructions and a review-required
  result without calling the scanner, a device endpoint or the cleanup executor.
- Legacy cleanup scanner startup, timers and demand-trigger helpers are inert.
  `GET /cleanup/scan` only describes any retained legacy metadata; it never starts
  a scan. Ordinary health monitoring is not changed by this retirement.
- The authenticated legacy quarantine-receipt reader preserves existing files
  and reports their recorded reclaimed-space number as **unverified**, with
  `freed_bytes = null`. Quarantined files and original receipt bytes are not
  migrated or removed. File Organizer's separate existing Trash workflow remains
  distinct from Free Space's reviewed-file protocol.

The four reviewed `/visualizer/cleanup/*` routes remain in use with their existing
request fields. A preview is bound to the credential that created it as well as
its owner. A different session must create its own review. Authorization is
rechecked during preflight, before each move, and after the pre-dispatch journal
write. Expiry, revocation or locking stops subsequent dispatches; an operation
already attempted is described by its actual or unconfirmed outcome.

### Receipts, uncertainty and saved-data preservation

The receipt must be writable before dispatch. New receipts have an additive
`journal_version: 2`; the current item is persisted as `attempting` before the
Trash call, then recorded as confirmed, failed or unknown. After interruption,
a version-2 `pending` item is known not to have been dispatched, while an
`attempting` item remains unknown. Older pending records still become unknown
in the read response. Reading either version does not rewrite the stored bytes.

Unresolved outcomes are tracked separately from selection. **Clear selection**,
**Remove**, opening another observation, or loading an unrelated older receipt
cannot establish that an outstanding move was cancelled or successful. **Check
cleanup result** is a read-only lookup of the exact request. A confirmed unknown
path remains blocked from another Trash submission through this workflow; inspect the
original file and operating-system Trash instead. Other unrelated paths can be
reviewed. Confirmed failed or undispatched files require a fresh explicit preview.

Encrypted receipt history remains bounded to 20 records. Unresolved records take
precedence over ordinary recent receipts and are not silently evicted. If all
receipt slots contain unresolved operations, another move cannot begin without
a writable journal. Existing store encryption and owner mapping remain intact.
The missing-key guard now includes `intelligence/storage_history-*.json`: a
missing memory key must not cause a replacement key to be created over an
existing encrypted scan-history store. This does not add storage history to
backup or recovery scope.

Observed file sizes, known byte subtotals and unknown-size counts are separate.
A zero-size file is different from an unreadable file. No selected-byte or
moved-byte total is presented as measured freed space. **Review location again**
prepares that location; a fresh scan still requires an explicit scan action.
Nothing empties Trash or permanently deletes files.

### Focused verification for this addendum

A broader isolated run passed **352 backend tests** with **167 warnings** across
cleanup, storage history/review, the independent scan audit, saved-data/key
protection and health, Notes backups, troubleshooting-case backups, recovery
service/routes/current-reader verification, and existing action behavior.
[Run log - local evidence](LOCAL_EVIDENCE.md).

The cleanup controller passed **23 frontend tests**, including an actual
1,105-path synthetic group paged in memory, off-page keeper preservation,
exact submitted selection, drawer DOM/focus lifecycle, unknown sizes, lost
responses, lock and stale-401 handling, and unresolved results surviving
selection changes. These are isolated controller tests; the separate full-SPA
browser matrix supplies visual and browser-native interaction evidence.
[Controller log - local evidence](LOCAL_EVIDENCE.md).

Five independent synthetic scan regressions cover revoked cached credentials,
revocation while queued before any worker launches, denied file metadata,
unreadable directories and depth-limited unknown sizes. They are included in
the 352-test run, not an additional 352-plus-five count.
[Independent audit log - local evidence](LOCAL_EVIDENCE.md).
No household files were moved or scanned, no physical phone or real Trash
acceptance was performed, and no live TLI restart was used for these checks.
The new eager session-revocation hook also discards loaded scan caches and
requests cancellation of an active scan without releasing host admission until
worker exit is confirmed.

## September 6 historical workflow and verification record

The original checkpoint follows unchanged for traceability.

## Workflow

Free Space results now offer explicit cleanup checkboxes in the largest-file
summary, largest-file list, large-file search and duplicate groups. No file is
selected automatically. A review can contain up to 100 individual files;
folders are not eligible for this workflow.

1. Select files to review. For a discovered duplicate group, explicitly choose
   the copy to keep before selecting other copies. That copy remains unselected.
2. Use **Review selected files**. The host returns exact paths, known sizes,
   retained copies, eligibility and reasons for blocked items. Unknown sizes
   remain unknown. A preview does not move anything.
3. If every selection passes, use **Move reviewed files to Trash**. The backend
   rechecks the entire selection before the first move, then checks file and
   keeper identity immediately before each individual move.
4. Read the per-file receipt. Confirmed moves, failures, items not attempted and
   unconfirmed outcomes have distinct labels. A failure stops later moves.
   Reviewing files not moved creates a fresh preview; it does not execute them.

Selected files and previews stay in memory. A preview expires after ten minutes.
Changing a selection invalidates it. The latest 20 cleanup receipts per user are
saved using TLI's existing encrypted private store and can be loaded explicitly.
The receipt includes an explicit rescan action for refreshing the current folder.

## Boundaries and dependable outcomes

- Existing allowed deletion roots and protected-path rules are preserved.
  Protected system files and TLI's installation remain blocked. This does not
  grant cleanup access to arbitrary drives or folders merely because they scan.
- Paths must be absolute and contain no parent traversal. Device paths and
  alternate data streams are rejected on Windows. Links, junctions, reparse
  points, hard links and files whose identity cannot be verified are blocked.
- Duplicate cleanup supplied with a retained copy verifies separate file
  identities, matching sizes and full SHA-256 content. It rechecks these facts
  at execution preflight. A retained copy cannot also be selected in the batch.
  This is based on explicitly discovered groups, not a claim that all selected
  files have been searched for duplicates throughout the host.
- A 15-second cooperative checking budget bounds each preflight's hashing and
  iteration. Slow or blocked operating-system calls can exceed that budget;
  the implementation does not forcibly interrupt filesystem calls.
- Cleanup and the existing direct delete/Trash entry points share an in-process
  file-mutation lock. Concurrent requests receive a busy response. Replaying a
  completed review returns its result without executing it again.
- The initial receipt must be writable before any move. Confirmed moves are
  journaled individually. After a restart, unfinished entries are unconfirmed
  rather than assumed successful or automatically retried.
- If an execution response is lost, **Check cleanup result** performs a read-only
  lookup. It does not resubmit the cleanup. A failed Trash call whose original
  file identity cannot be confirmed is reported as unconfirmed.
- The new workflow has no permanent-delete or empty-Trash option. If Trash is
  unavailable it blocks cleanup. Restore files using the operating system's
  Trash or Recycle Bin; the existing TLI file Undo does not restore Trash.
- File sizes and bytes moved are not measured disk-space recovery. Files in
  Trash may still occupy space. Receipts leave `freed_bytes` unknown.
- Narrator/activity events contain outcome counts without private file paths.
  Detailed paths stay in the authenticated review and private receipts.

Trash operations use the operating system's path-based API. Rechecks reduce
stale-selection errors but cannot make moves atomic against external programs
changing files at the same instant. This is not an all-or-nothing transaction;
per-file receipts describe partial completion honestly.

## Interfaces and compatibility

The existing scan, file and delete URLs and formats remain available. Added
routes use the existing session-authentication dependency:

- `POST /visualizer/cleanup/preview`: `files` with `path` and optional `keep_path`.
- `POST /visualizer/cleanup/execute`: the opaque `preview_id` from a review.
- `GET /visualizer/cleanup/receipt/{preview_id}`: read-only result lookup.
- `GET /visualizer/cleanup/receipts`: recent private receipts.

`ok` represents complete execution success in an execution receipt. Per-file
`results` retain failures and uncertain outcomes. Preview `ok` indicates that
the review was produced; `can_execute` separately indicates eligibility.

No existing persisted format is migrated. Rolling back code leaves the optional
cleanup-receipts sidecar unused. Restore any moved files through the OS before
expecting rollback to affect their locations; code rollback does not undo moves.

## Verification

Baseline: 249 backend tests and 44 frontend tests passed, with no baseline
failures. Final checks: **276 backend tests passed** (229 existing warnings) and
**51 frontend tests passed**.

The 27 new backend tests cover rejected paths and protected locations, changed
files, hard links/reparse points, missing Trash, duplicate keep-copy checks,
hashing deadlines, partial failures, uncertain outcomes, writable journals,
concurrent requests, expiration, owner separation, restart replay and session
authentication. Seven new frontend tests cover explicit selection, blocked
previews, truthful partial results, fresh review on retry, keeper constraints,
duplicate clicks, read-only result recovery, selection limits and history views.

Tests establish temporary persistence and fake integrations before application
imports. The test harness blocks real Trash operations unless a test supplies
its own fake. Existing startup, chat streaming, authentication, model lifecycle
and persisted-data compatibility tests remain in the passing suite.

The disposable `backend/tests/cleanup_preview.py` fixture uses only temporary
files and a fake Trash directory. Browser checks at 1440 x 900 and 390 x 844
verified blocked-file reviews, an accurate partial receipt for a simulated
file-in-use failure, explicit duplicate keeper selection, a successful move
with the retained copy still present, recent receipts and a rescan of remaining
files. Both layouts fit without horizontal overflow; phone cleanup buttons
have a minimum height of 44 pixels.

These are isolated browser and fake-filesystem checks, not physical phone or
macOS/Linux Trash validation. No user files were cleaned, real models started,
or live TLI restarted. The live backend needs its normal restart to load the
new routes; this checkpoint does not restart it automatically.
