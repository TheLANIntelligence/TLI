# Anniversary desktop batch: recovery, retained activity and saved places

Implemented in the working tree on September 7, 2026. This checkpoint groups
five everyday improvements using the existing desktop TLI application. It does
not package or restart the live installation. Companion work, Home Automation
expansion, voice and diagnostic rechecks remain parked. The separate memory and
conversation-continuity work is recorded in the subsequent
[memory checkpoint](MEMORY_CONVERSATION_CONTINUITY.md).

## 1. Protected Notebook and history backup

Settings → Data & Recovery now creates a portable, password-protected
`.tlibackup` archive and verifies an uploaded copy. Creation reads this account's
Notebook, owned AI conversations and saved diagnostic reports. It rejects an
unreadable or oversized source rather than silently omitting it. Original stores
and keys are not rewritten. Each source is limited to 16 MiB; the encrypted
archive is limited to 64 MiB.

The versioned format uses random salt, Scrypt and authenticated AES-256-GCM
encryption. The password is never persisted. Password operations require HTTPS
or a verified loopback connection. The downloaded bytes are checked against
their transfer checksum. The UI says a download was requested, because a browser
cannot establish whether the user saved a durable copy.

Verification validates archive integrity, exact allowed entries, record counts,
ownership metadata and readable saved-data formats. It writes an encrypted
temporary copy with an ephemeral key, reads it back and removes the temporary
files. It never imports, merges, overwrites or starts a live TLI installation.
The verdict separately states integrity, readable contents and no live restore.

**Scope matters:** this is a Notebook & history backup, not an installation
backup. Vault, host PIN/identity/keys, Companion credentials, other accounts,
models, configuration, devices, original attachments, saved places, storage
history and other sidecars are excluded and listed in the manifest. A future
recovery must deliberately map the archived account. Keep the password separately;
TLI cannot recover a lost archive password. Full installation recovery remains
unverified by this screen.

## 2. Activity that survives restart

The existing event bus now records eligible operational events in a bounded
host-local journal. It keeps up to 500 events for seven days, with a 256 KiB file
limit and a bounded asynchronous writer queue. Idle expiry is checked once per
minute. Detailed live events keep their existing SSE contract and in-memory feed.

Only fixed catalogue codes and event timestamps/cursors are persisted. Startup,
shutdown and known storage, cleanup and model-switch outcomes become generic
history. Original titles, bodies, node labels, filenames, commands, messages and
action payloads never enter this journal. Unsupported event types remain
live-only. A shutdown marker records reaching the recorder's shutdown step; it
does not claim the operating system exited cleanly.

The existing catch-up summary combines retained eligible events with the current
live feed. Review uses an additive durable cursor alongside the original cursor.
Retention, dropped entries, missing shutdown markers, replacement journals and
unavailable recording are explicit. Time while TLI was stopped was not observed.
Unreadable journal bytes are preserved and do not disable the live feed.

## 3. Saved storage observations and comparisons

Free Space now offers Save scan, Load saved scans and Compare against a selected
baseline. A scan produces an owner-bound, server-generated summary reference that
expires after 30 minutes. Saving is explicit, encrypted and idempotent. Up to
20 summaries are retained; a reviewed removal deletes only the selected summary
and frees a slot without touching the scanned folder or files.

Comparison requires matching host, root and volume/folder identity, matching
scan limits and exclusions, complete coverage and an earlier baseline. Unknown
identity, changed drives and partial scans produce reasons instead of numeric
growth claims. Summaries contain bounded immediate-folder totals, total observed
bytes, directly contained file bytes, time and coverage. More than 200 immediate
folders makes coverage incomplete for comparison.

Reports distinguish observed growth/shrinkage from newly observed and no-longer
observed names. They do not infer deletion or cleanup from missing names.
Comparisons use the two observations and never re-probe the filesystem. Display
filters do not change captured totals. No background scan or automatic save runs.

## 4. Narrator preferences and explanations

The dashboard offers host-wide Quiet, Balanced and Detailed modes. Balanced
remains the default. Quiet suppresses ordinary event narration and routine
measured check-ins. Detailed offers useful check-ins more frequently. Existing
critical alerts, warning persistence/hysteresis, duplicate suppression,
confirmation visibility and observed-health wording remain in force.

The controls explain why a warning is visible and distinguish unavailable or
stale monitoring. Settings are saved only after an authenticated successful
response. A failed write preserves the prior mode; changing mode does not reset
warning or confirmation clocks. No LLM, model routing or new notification panel
is involved.

## 5. Private saved places

Open Saved places from the dashboard, Files or Free Space. Favorites support
absolute host folder/mapped-drive paths, owned Notebook notes (including owned
legacy notes) and existing TLI panels. Files also offers Save this path.

Saving does not probe, open, scan or modify the target. Opening a folder populates
Files and leaves scanning explicit; Scan in Free Space explicitly requests a
scan and leaves its outcome to that panel. Notebook favorites open the current
owned note without claiming that it came from a chat receipt.

Each account has an encrypted sidecar with up to 100 favorites. Duplicate
targets do not create duplicates. Names and removals use revision checks, and
removal affects only the favorite. Missing drives and deleted notes retain
their favorites with availability details. Location checks are time-bounded
and capped at two outstanding probes, including probes blocked in the OS.
UNC paths are excluded; use a mapped drive on the host. Session lock and closing
the dialog discard private UI and late navigation. Saves preserve drafts on
failure and prevent edits while their request is pending.

## Compatibility and verification

Existing endpoints, SSE names, preset IDs and existing saved-data formats stay
in place. New endpoints and fields are additive; new persisted settings/history
use sidecar files. The existing Notebook opening API has an optional source hint
so favorite wording stays distinct from actual chat receipts. No migration,
model download, live provider call, native Companion build or live restart is
part of these checks.

The previous completed desktop baseline was 857 backend and 191 frontend tests,
with no failures recorded. All automated tests use temporary persistence and
fake providers/devices. The initial integrated run passed 957 backend tests;
the first frontend run exposed one extracted storage-scan fixture missing the
new history hook. The fixture was corrected while retaining its latest-scan-wins
assertions. This was a batch regression, not a pre-existing baseline failure.

Final integrated suites pass: **963 backend tests and 230 frontend tests**, with
zero failures. This is 106 additional backend cases and 39 additional frontend
cases beyond the carried baseline. Backend reports 1,110 warnings, including
existing deprecations and intentionally malformed archive-fixture warnings.

Source hashes, logs and synthetic desktop/narrow-browser
results are recorded in `build_work/anniversary-five-verification.json`.
Browser fixtures intercept every endpoint and use synthetic records. They check
desktop and 390-pixel phone layouts, light/dark presentation, unavailable data,
explicit retry/removal, retained drafts and truthful results. These are desktop
browser layout checks, not physical Companion acceptance or native-platform
installation testing.

Existing Python/Pydantic/FastAPI deprecation warnings remain separately recorded.
The intentionally malformed duplicate-ZIP fixture also emits a warning. Neither
warning type is treated as a passing restoration or deployment gate.
