# Free Space workspace rebuild

This checkpoint rebuilds Free Space around **choose a location → understand what
uses space → review selected files → check the outcome**. It preserves TLI's
purpose as a private home console and keeps the existing Modern/Classic choice.

**Delivery status:** implemented and verified against frozen source
`dc39eb37926617ae0837528e035f02aee28e9c2cea753778406902daeec6951c`.
See the [coverage record](TLI_FREE_SPACE_ACCEPTANCE.md) and
[before/after review gallery - local evidence](LOCAL_EVIDENCE.md).

## Everyday workflow

### Choose a location

Free Space inspects storage accessible to the **computer hosting TLI**. A phone
or another browser does not change which computer performs the inspection.
Mounted network storage is inspected from that host; this is not remote-agent
execution.

The location navigator lists drive names, exact paths, capacity and availability.
Search and sort help with computers that have many drives. Choosing a drive,
quick folder, Dashboard shortcut or saved place prepares the location. **Scan**
starts inspection; merely opening the page or changing a location does not.

| Profile | Work limit | Intended use |
|---|---|---|
| Quick overview | 15 seconds, 50,000 entries, 18 levels | Start with a bounded view of a location. |
| Deeper scan | Up to five minutes, 500,000 entries, 30 levels | Explicitly inspect more of a drive or selected folder. |

The limits do not promise a complete drive inventory. Exclusions, inaccessible
entries and limits remain visible. Quick scanning retains the existing excluded
cache/application folders. Deeper scanning offers a deliberate option to include
them. Neither mode elevates privileges or follows links or junctions.

### Understand the observation

The observation identifies its host, root, time and coverage. Real counters,
elapsed time and work phases describe an active scan; a percentage is not invented
when the total amount of work is unknown.

The later [workspace-cohesion checkpoint](TLI_WORKSPACE_COHESION.md) makes a
hierarchical **Space map + list** the primary desktop view, with explicit Map/List
surfaces on phones. Largest entries, folder totals and File types describe the
same observation. The map and paginated keyboard-accessible list share selection
and folder breadcrumbs. Grouped representation retains measured bytes but cannot
be selected for cleanup; unknown sizes remain outside proportional area.
Pagination and displayed/returned counts prevent hidden result limits.
Opening a cached folder changes the view; scanning an uninspected folder requires
an explicit request.

Drive capacity, inspected file sizes and selected-file sizes measure different
things. They must not be subtracted to imply an unexplained amount of used disk
space. Failed size probes remain unknown, rather than zero-byte files.

Failed replacement scans preserve the earlier results and their observation
time. Stop requests remain in a stopping state until the worker exits. Usable
interrupted results are offered through **View partial results**; they do not
silently replace the previous observation. Navigating away is not cancellation.
Returning reconnects to existing work without resubmitting it.

### Find more, deliberately

Large-file search, Duplicate search, Common folders and Saved comparisons are
secondary tools. Each mounts independently and begins only on request. Failure
of one does not hide the others. Common folders are review locations, not a claim
that their contents can all be removed safely.

Duplicate matches require complete content hashing and an explicitly chosen
copy to keep before other copies are selected. Extra-copy bytes are file sizes,
not guaranteed space recovery. Failed replacement searches preserve their
previous result set and associated keeper selections.

Saved scans retain the existing small, encrypted owner-scoped summaries. Saving
is explicit. Comparisons require matching host, root, volume identity and scan
policy, an earlier baseline and complete comparable coverage. A partial or
incompatible observation explains why growth cannot be calculated.

### Review selected files

The review workflow still accepts up to 100 individual files. It shows exact
paths, known sizes, retained duplicate copies and blocked reasons before any
move. Scanning a folder does not grant cleanup permission outside the existing
allowed roots. Folders, protected locations, links and unverifiable identities
are not silently accepted as file selections.

**Move reviewed files to Trash** performs the existing host-side preflight,
identity checks and journaled moves. Reviews expire after ten minutes. Concurrent
mutations are serialized; completed requests do not replay. A failed move stops
later files and yields a per-file result.

The operation receipt is separate from the current selection. Editing or clearing
a selection cannot erase an uncertain attempt. **Check cleanup result** reads the
existing receipt without repeating the move. Session revocation stops subsequent
steps; an already attempted operation retains its actual or uncertain outcome.

Trash may still occupy disk space. The result describes files moved and their
sizes, not guaranteed freed bytes. There is no new permanent-delete or
empty-Trash action. Restore through the operating system's Trash/Recycle Bin;
the Files operation Undo is a separate feature.

## Useful handoffs

**Review in Files** prepares the exact path in the existing Files workspace.
It does not open a file in a host application, scan it or prepare a move plan.

**Prepare a question about this scan** first reviews a bounded summary with host,
root, time and coverage. It protects existing Chat drafts and context selections.
Sending remains explicit. AI interpretation cannot establish that a file is safe
to delete or that cleanup has completed.

## Implementation and compatibility

The vanilla-JavaScript SPA retains `panel-visualizer` and existing navigation
aliases. One Free Space controller owns its lifecycle and delegates exploration,
saved history and reviewed cleanup to explicit modules. Obsolete overlapping
handlers and presentation rearrangements are removed from the migrated area.
Files retains its separate controller and reviewed operation workflow.

New authenticated interfaces under `/visualizer/jobs` start work, report status,
retrieve results and request cancellation. Existing scan/search URLs retain
their response shapes through adapters to the same service. Legacy callers keep
their existing limit semantics. Private responses use `no-store`.

There is one intensive storage-read job per host. Request identifiers prevent
duplicate starts. Jobs belong to the requesting owner and session generation;
another account receives no private job details. Lock clears private browser
state and invalidates delayed responses.

The read-only worker starts before any application/state initialization in source
and packaged deployments. Its protocol carries no account keys or provider
credentials, and it does not initialize inference. All potentially blocking
filesystem probes run inside owned workers.
Cancellation has a two-second cooperative grace period, followed by termination
of only the owned child when necessary. Its slot is released only after exit.

Work is independently bounded by a 512 MiB worker ceiling, 25,000 retained tree
nodes and 32 MiB serialized results. Aggregate measurements survive explicit
representation collapse. Finished results are memory-only: at most four, within
64 MiB total, expiring after 30 minutes. A resource limit never becomes an empty
successful scan.

Two legacy mutation endpoints, `/visualizer/delete` and `/cleanup/clean_safe`,
remain addressable but refuse execution with `review_required`. Older queued
Dashboard cleanup handlers navigate to review without moving files. The separate
automatic cleanup scanner is retired; ordinary disk-health monitoring continues.
Existing quarantine contents and receipts remain untouched. Historical
"reclaimed" values are identified as unverified legacy estimates.

Storage history joins missing-key protection. This does not migrate records or
change the saved-work backup scope. Existing SSE contracts, encrypted formats,
model selection and interface/theme preferences remain intact.

## Verification record

The pre-change source snapshot contains 723 files with fingerprint
`6e158d670e10d9ecefaf5c4dea7e313fe037a0e97a14369e06bda0a1999daf6f`.
The fresh isolated baseline passed **2,431 backend tests** and **986 frontend
tests** with no failures. Six synthetic before screenshots were captured from
that frozen source. Existing warnings are retained in the baseline log.

Final verification passed **2,508 backend tests**, **1,026 frontend tests** and
**168 tooling tests**. The matched browser run passed **197 checks**, including
**189 layout observations**, all **23 themes** in Modern and Classic, and **46
solid-background contrast checks** with no findings. Forty after views join six
baseline views. The Windows packaged hidden worker passed real temporary-folder
Quick, Deep/include-excluded and unavailable-path checks, with unchanged fixture
bytes and confirmed worker exit.

The 738-file source snapshot, logs, actual authenticated synthetic API envelopes,
package hash and screenshots are bound in
[the delivery manifest - local evidence](LOCAL_EVIDENCE.md).
The final backend run reports 4,966 warnings; the baseline reported 4,963. Warnings
remain in the logs and are not hidden as test passes. There were no baseline or
final backend/frontend test failures.

Synthetic filesystem tests use fake Trash operations. No production restart,
model change, household scan or live cleanup ran. Physical phones, screen-reader
acceptance and native macOS/Linux package acceptance are **not run**. The POSIX
owned-process-group logic has synthetic tests; it is not claimed as native
platform validation. Earlier candidate snapshots and logs are retained, including
the candidate superseded by strict root-link and descendant-exit corrections.
