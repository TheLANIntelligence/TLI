# Storage review and Narrator refinement

The Narrator now offers deterministic measured check-ins once a minute during healthy monitoring, announces sustained CPU/RAM recovery and restored monitoring, and keeps a critical disk warning visible alongside fresh activity. Existing five-minute event suppression, 30-second pressure timing, stale monitoring handling and ten-second confirmations remain. Storage scan completion emits an activity event; scanning does not change files.

Free Space fixes missing drive-picker helpers and uses the existing `/visualizer/scan` endpoint. `/visualizer/treemap` is also registered by the older file router with a different response; its compatibility contract is left intact. The scan alias now forwards concrete validated limits. The UI requests 18 folder levels and 50,000 entries, replacing the previous two-level scan. Scanning uses a cooperative 15-second budget, which cannot interrupt an individual blocked filesystem call.

Additive metadata reports skipped links/excluded directories, permission failures, depth, entry and time limits. Inspected file sizes are not presented as total drive usage or reclaimable space. Protected files and synthetic collapsed entries are excluded from review suggestions. No new persistence or data migrations are involved.

The initial view is a ranked file list with three review suggestions; map, folders and types remain available. Both map and list show scan coverage. Cleanup tools are expandable, binary installer data is no longer automatically categorized as an AI model, and AI analysis prepares a chat draft containing scan limitations. No cleanup is performed automatically.

Validation: 157 backend tests and 22 frontend tests pass in the existing isolated harness. Added coverage exercises scan limits, permissions, protected files, actual scan routing, drive-picker success/retry, stale response races, root navigation, AI drafts, measured Narrator cadence and recovery. Existing deprecation warnings remain.

Browser verification used the disposable preview installation and simulated drives/files: drive loading, scan summary, protected explanations, map switching, expandable tools and AI draft handoff. Layout checked at 1440px and 390px; cards fit without page overflow. The preview was stopped after checking. No live cleanup, real device action or production restart was performed. Existing uncommitted work was preserved.

## Follow-up: running backend still used the old scan alias

The reported N: failure was confirmed in the live backend log: the old alias passed FastAPI `Query` objects into the scanner's numeric limits, producing a TypeError. The interface had refreshed, but the backend process predated the fix. Its OpenAPI schema still lacked the new scan-limit parameters.

Restarted the backend with the existing project virtual environment and verified the updated endpoint schema. A read-only N: scan then returned successfully: 13,505 files, 286.51 GiB inspected, 15.011 seconds, partial due to the time budget and two exclusions; no permission failures. The Windows dev launcher now prefers that environment when it exists. The previous system Python lacks Pillow, which the updated application requires.

Error messages now distinguish backend failures, expired sessions, rejected requests, connection failures and display errors. Added regression coverage for scan defaults (the Query-object failure) and error classification. Validation: 158 backend tests and 23 frontend tests. No automatic cleanup was performed.

## Everyday reliability follow-up

Persistent disk and resource warnings now retain fresh activity alongside the warning. Simultaneous sustained CPU and RAM pressure is reported together. A transient high reading receives a status explaining the 30-second observation window, without becoming an alert. Monitoring loss discards the previous measured check-in so it cannot reappear after recovery.

Common cleanup locations now use iterative, bounded measurement: up to 10,000 entries and one second per location, with a shared five-second cooperative budget and a 20 GiB stopping threshold. Individual files are counted whole. Links and junctions are skipped. Counts that stop early or encounter unreadable entries are explicitly partial; zero inspected bytes is not presented as an empty folder when measurement failed. Individual blocked filesystem calls can still exceed the cooperative deadline.

The existing cleanup endpoint retains its fields and adds `size_partial` and `size_meta`. An inaccessible root can have unknown (`null`) existence. The interface shows the folder path, incomplete coverage and host-wide scope, since common folders may reside on a different drive from the selected scan. Large-file and duplicate tools remain available when common folders return no candidates. Guidance directs Windows system cleanup through built-in review tools and removes broad recursive-delete instructions for temporary folders. Trash requires personal review.

Guidance references: [Microsoft drive-space review](https://support.microsoft.com/en-us/windows/experience/storage-filemanagement/free-up-drive-space-in-windows) and [Apple storage review](https://support.apple.com/en-us/102624).

Validation: 171 isolated backend tests and 25 frontend tests passed, including fake-clock warning/activity checks, measurement limits, permission failures, junction exclusion, endpoint compatibility, and empty/partial cleanup UI results. Whitespace checks passed. This follow-up is a source change; the production backend was not restarted and no files were cleaned up. Physical phone and installed-platform verification remain release gates.

## Browser verification and duplicate accuracy

Browser testing at 390px found that the three-column cleanup search grid overflowed its panel by 125px even though the document itself did not overflow. The grid now adapts to available width. Verified panel and content widths match at 390px and 1440px. Duplicate summaries use the current theme text color, small files retain KB precision, and paths wrap for review on narrow screens.

Duplicate detection previously sampled only the first and last 64 KiB of large files. It now requires complete SHA-256 checks, groups by both size and hash, skips links/junctions and protected locations, excludes repeated hard-link identities, and rejects detectable file replacements or modifications before, during and after hashing. Windows directory-entry metadata can omit identity, and Windows path/handle ctime values can differ; comparisons use explicit path/handle identity, size and modification time, with ctime also used on POSIX.

Discovery, hashing and final validation share a cooperative 15-second budget and retain the existing entry ceiling. Partial results report time/entry limits, unreadable files, exclusions and changed files. Hashes describe inspected content at scan time, not a guarantee files will remain unchanged. Files below 4 KiB remain outside this feature's scope. As with the other scanners, an individual blocked filesystem call cannot be interrupted by this deadline.

Existing `groups`, `meta`, size/count/path and `wasted_*` response fields remain; additive metadata describes verification and coverage. The UI describes extra-copy bytes rather than promising freed space, warns when an older backend returns unverified matches, and prevents overlapping submissions from the same button. It performs no deletion. The large-file search still uses its older walker and should receive the same bounded-coverage audit before distribution.

The standalone startup check now handles the existing specific "not joined to any host" response as a normal state; authentication, unexpected request and server failures remain visible. No mesh API or connection behavior changed.

Validation: full backend suite 178 passed; frontend suite 28 passed. Targeted storage checks were rerun after final deadline and size-format adjustments. Browser checks used synthetic scans, partial cleanup estimates, unreadable folders and duplicate groups in the disposable loopback preview. The live installation's read-only schema confirms the earlier drive-scan repair is running; live port 8000 remained process 12908. No production restart, real duplicate scan, cleanup, device action or physical-phone certification was performed.

## Large-file search follow-up

The remaining large-file walker now uses an iterative, bounded search with a cooperative 15-second deadline, the existing 500,000-entry ceiling, explicit link/junction and protected-location exclusions, and a heap retaining only the largest requested results. The existing endpoint and response fields remain. Added metadata distinguishes incomplete traversal from limiting the returned list; totals continue to describe returned files rather than all drive usage. Individual blocked filesystem calls can still exceed the deadline.

The interface reports scan coverage even for empty results, shows returned versus found counts, and keeps earlier results and their original path/size threshold visible after a failed retry. Overlapping submissions from the same button are prevented. All returned rows are shown instead of silently clipping the list at 100. The previous "Reveal" control is accurately labeled "Scan folder" and preserves Windows/POSIX roots. Long names and full paths wrap within a contained table on phones; the 1 GB threshold now uses 1024 MB consistently with backend size units.

Validation: full isolated backend suite 183 passed, frontend suite 29 passed. Added coverage checks ranking, returned totals, entry/time limits, exclusions, permission failures, endpoint compatibility, failed retries, repeated submissions and root navigation. Browser verification at 390px and 1440px used a simulated partial search and a controlled HTTP 503 retry failure; panel width equals content width at both sizes and earlier file results remain available after failure. The preview uses temporary data and fake scanners. No real files or device states were changed.
