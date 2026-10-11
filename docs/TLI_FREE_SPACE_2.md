# Free Space 2.0 — local storage intelligence

## Inspection and implementation

This upgrade extends the existing Free Space workspace. Before implementation,
the repository already had a read-only child-process scanner, Quick/Deep profiles,
job progress and cancellation, a bounded D3 treemap, paginated explorer, drive
cards, full-hash duplicate checks, encrypted owner-scoped folder summaries,
reviewed Trash operations, and disk-pressure events in Ambient/Narrator.
Those services and their authentication contracts remain in use.

The gaps addressed here are physical allocation metadata, hard-link accounting,
file-level snapshot evidence, capacity-versus-file growth accounting, configurable
history retention, local evidence diagnosis, and opt-in capacity trends/schedules.
No external database, additional scanning service, raw NTFS parser, dependency,
automatic cleanup, or alternative Free Space application was introduced.

## Scan and explore

Choose a drive or significant folder, then explicitly start Scan. Quick retains
the existing 15-second/50,000-entry/18-level budget. Deep retains the five-minute,
500,000-entry, 30-level ceiling; including normally excluded folders is explicit.
Opening a panel, choosing a drive, investigating a result, or comparing history
does not start a traversal.

The existing owned worker keeps its 512 MiB memory ceiling, 25,000 retained tree
nodes and 32 MiB response limit. There is one intensive storage reader per host.
Progress reports actual work rather than an invented completion percentage.
Cancellation requests cooperative exit then terminates only the owned worker;
new admission waits for confirmed exit. Finished results remain session-bound,
expire after 30 minutes, and share the existing four-result/64 MiB cache.

Windows uses supported `GetFileInformationByHandleEx(FileStandardInfo)` through
a metadata-only, shared, non-following handle to read allocation. POSIX uses
`st_blocks` when available. Unsupported or inaccessible allocation stays unknown.
The fallback enumerates directories with `os.scandir`; **MFT scanning is not
implemented**, and the scanner reports that fact. The application does not need
administrator elevation. This is not a WizTree-speed claim.

Scans record counted logical bytes, per-path logical sizes, allocation where
known, modified/creation timestamps where supported, extension, category and
recursive file counts. Hard-link identities count bytes once; other aliases
retain their path/true logical size with zero counted bytes. Unknown identities
make accounting incomplete. Reparse points, junctions and symbolic links are
excluded, including ancestors of explicitly selected roots.

The UI adds logical/allocated weighting and ordering, extension filtering,
metadata columns and largest-consumer panels to existing map/list navigation.
Allocation that cannot be established is excluded from proportional area and
remains visible as unknown. Tree aggregation preserves counted bytes. Lists use
50-row pages; grouped or unretained paths are never actionable cleanup targets.
Windows, Users, AppData and ProgramData shortcuts use host-provided paths. Their
presence is navigation guidance, not a safe-to-delete claim.

## Snapshots and growth

The existing encrypted JSON history remains owner-scoped under `data/intelligence`.
Snapshots extend the existing version-1 envelope without rewriting older records.
They retain up to 200 immediate-folder summaries and 500 file observations, with
an additional 24 KiB per-snapshot file-summary bound. History is limited to 20
snapshots, 1 MiB plaintext and 2 MiB encrypted-file read size. It does not retain a
complete large-volume inventory indefinitely.

Saved scans can be compared with a current receipt or another saved scan.
Compatibility checks include host, root, volume/root fingerprint, scan policy and
chronology. Complete compatible scans support total/folder differences and file
changes. Retained path sizes use logical size, so changing which hard-link alias
was counted does not fabricate file growth. Folder attribution is qualified or
withheld when hard-link ownership can shift between folders.

For incomplete but otherwise compatible observations, only paths actually
observed in both scans can support a recorded size-change statement. Partial
coverage cannot establish complete storage growth, new-file creation or deletion.
With a bounded top-file summary, absence may simply mean a file fell out of the
retained selection. Even complete added/removed path observations may be moves or
renames, rather than creation/deletion of content.

Volume capacity is sampled separately inside the child. A directory scan's
logical-byte change is never subtracted from whole-volume free space. An
unexplained-byte difference is available only with compatible complete
whole-volume allocation measurements. It is an accounting remainder, not an
invented explanation. Capacity samples can remain comparable when file coverage
is incomplete, with file-growth attribution unavailable.

Retention permits 1–20 snapshots and 0–3650 days (0 means no age cutoff). Automatic
pruning is opt-in; default behavior preserves existing summaries and reports the
limit. Explicit maintenance removes only this owner's saved summaries. It does
not remove scanned files. Settings stores join the existing missing-key protection.
Storage history remains outside the existing three-area saved-work backup export.

## Investigation and cleanup

`POST /visualizer/investigate` accepts a session-bound job receipt, a question and
an optional saved baseline. It never accepts client-supplied file sizes as
evidence or arbitrarily browses a supplied path. It returns bounded structured
evidence, explanations and conservative recommendations.

The storage adapter runs within TLI's existing deterministic answer/intent layer
for both bundled chat endpoints and legacy `/chat`. Questions such as “Find my
largest files”, “What grew overnight?” and “Why is my C: drive always full?” use
the latest eligible scan for that session and requested drive. Without a scan,
TLI asks for an explicit scan rather than inventing evidence. This implementation
uses deterministic local diagnosis, not generative model analysis. It needs no
running model and sends neither inventory nor file contents to a model/provider.
General-purpose conversation and existing selected-context workflows remain.

Path-rich replies are displayed in the active answer but conversation history
stores a neutral local-review receipt, preventing later provider prompts from
implicitly inheriting the inventory. Access is rechecked before delivery,
including between streaming metadata and the private text. The existing optional
Chat-summary handoff remains an explicit user-reviewed draft.

Recommendations distinguish generally safe-to-review temporary/browser cache
files, files requiring personal review (downloads, backups, models, installers),
and protected/unknown critical data. They explain consequences and observed
sizes, without promising recovered space. Windows system-managed areas point to
Windows Storage settings/Disk Cleanup. Recommendation cards do not execute actions.

The existing exact-file preview, explicit confirmation, identity checks, expiry,
owner/session binding, journaled Trash moves and outcome receipts remain the only
Free Space file-removal flow. No permanent deletion or empty-Recycle-Bin endpoint
was added. Trash can continue occupying disk space.

Duplicate search now reduces candidates by size, then partial SHA-256 sampling,
then full SHA-256 verification. Matching names or partial hashes never establish
duplicates. Protected paths, hard-linked aliases, changed and unreadable files are
excluded or reported. Review still requires a retained copy and explicit selection.

## Monitoring

Storage monitoring is off by default. Saving enabled settings starts a monitor
for that authenticated session. It consumes the existing Ambient capacity samples
and emits deduplicated events through the existing event bus, Recent Activity and
Narrator integration. The global event is generic; private evidence stays in the
owner's monitor view. Existing host disk-pressure alerts remain in place.

Thresholds, sampling interval, growth window, cooldown and scheduled scan interval
are configurable. Sudden free-space loss and four-observation sustained declines
are capacity evidence, not attribution to particular files. Critical escalation
has its own cooldown key. Clock regressions and changed reported capacities reset
the trend baseline.

Optional scheduled Quick scans require a completed job receipt to authorize the
scope. They use the same host admission gate, fixed Quick budgets and bounded
history. Comparable scheduled scans can report observed growth and large added
paths. Busy hosts defer the scan. Full history or unavailable receipts produce an
explanation instead of silent eviction or unlimited retries.

Credentials and scheduled paths are not persisted. Monitoring pauses after lock,
credential expiry or restart; reload and save settings to resume. Active monitors
are bounded to 16 owners, 16 mounts per owner, 256 samples per mount and 32 findings.
The effective retained window may be shorter than the requested window. Capacity
samples identify mount points, not physical volume fingerprints; replacing an
equal-capacity removable disk can resemble sudden consumption. Scan comparisons
use the stronger volume/root identity check.

## Files and verification

Backend work: `storage_scan_algorithms.py`, `storage_scan_worker.py`,
`storage_jobs.py`, `intelligence/storage_history.py`, new
`intelligence/storage_diagnosis.py` and `intelligence/storage_monitor.py`, existing
`routers/visualizer.py`, `ambient.py`, `activity_history.py`, `tli_state.py`, and both chat routers.

Frontend work: `index.html`, `js/visualizer.js`, `js/storage-map.js`,
`free-space-workspace.css`, and the existing history controller inside
`js/visualizer.js`. The existing theme variables and emerald identity remain.

Test changes: `backend/tests/test_storage_metadata.py`,
`backend/tests/test_storage_history_v2.py`, `backend/tests/test_storage_intelligence.py`,
`backend/tests/test_storage_representation.py`,
`frontend/tests/free-space-intelligence.test.cjs`, and
`frontend/tests/storage-history.test.cjs`. Browser tooling extends
`scripts/verify_free_space_rebuild_browser.cjs` and adds
`scripts/verify_free_space_v2_browser.cjs`. This document records the upgrade.

Tests cover sparse allocation on a real Windows temporary file, hard links,
unknown allocation/identity, reparse exclusions, bounded representations, sampled
hash false positives, history/retention and owner boundaries, capacity accounting,
low-space/growth samples, scheduled admission, revocation during delivery,
local-only chat, and UI scope/lock races. Actual browser checks use synthetic API
fixtures and the real SPA. No household scan, real cleanup, production restart or
installer replacement is part of this change.

Native macOS/Linux packaging, full physical-drive benchmarks, live Windows ACL
coverage across household volumes, physical phones and screen readers still need
release validation. The scanner is a bounded observation, not an atomic filesystem
snapshot; files may change during enumeration. Allocation excludes filesystem
metadata and unenumerated alternate streams, and shared extents may overlap.

### Recorded checks (October 7, 2026)

- Full isolated backend checkpoint: **3,418 passed**, 6,319 reported warnings.
  Later changes were exercised by the final focused storage/chat/activity suite.
- Final focused backend suite: **353 passed**, 243 reported warnings.
- Complete final frontend suite: **1,456 passed**, zero failures.
- Final focused Edge suite: **5/5 passed**, zero page errors, six screenshots.
- Updated existing Edge smoke: **21/21 passed**, 13 layout observations,
  24 screenshots, zero page errors, source unchanged throughout the run.
  Covers Modern/Classic, emerald light/dark, desktop/narrow views and enlarged
  text, with explicit keyboard checks for horizontally scrolling metadata tables.
- Python compile checks and `git diff --check` for changed tracked source passed.

Browser reports: [focused new workflows](../build_work/free-space-v2/browser-focused-final/report.json)
and [existing workflows and layouts](../build_work/free-space-v2/browser-quick-final/report.json).
The older browser script's mismatched-scope and disclosure assertions were updated
to verify the current UI contract, preserving its behavioral checks. Synthetic
browser fixtures do not establish real-volume performance or installed-app status.
