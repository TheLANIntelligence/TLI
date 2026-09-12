# Free Space acceptance and coverage

Date: September 9, 2026. This record covers the browser workspace and its storage
read/cleanup services. It does not certify a production installation.

## Matched candidate

- Source: `dc39eb37926617ae0837528e035f02aee28e9c2cea753778406902daeec6951c`, 738 allowlisted source files.
- Source folder: `build_work/free-space-rebuild/final-accepted/release-snapshot-01hjhv6r/source`.
- Relative to the retained baseline: 15 added source files, 33 changed source files, no removed files. Superseded code was removed within migrated files.
- Windows worker-only verification executable SHA-256: `7d2fdbd140d7dfe1cfecd0c1115219a26389a7b881d1169c43cc964a6ed0e474`.
- Runtime: Python 3.14.0, pytest 9.0.2, Node 24.19.0, Playwright with installed Microsoft Edge, PyInstaller 6.18.0.

The executable is a hidden-worker packaging test artifact, not an installer or a
claim that the running application was upgraded. The source manifest excludes
private runtime data and model weights. Documentation and evidence hashes are
recorded separately in the [delivery manifest - local evidence](LOCAL_EVIDENCE.md).

## Recorded results

| Gate | Result | Evidence |
|---|---|---|
| Fresh baseline backend / frontend | Passed: 2,431 / 986 | `baseline-checks/report.json` |
| Complete frozen backend | Passed: 2,508, with 4,966 recorded warnings | `accepted-checks/backend.log` |
| Complete frozen frontend | Passed: 1,026 | `accepted-checks/frontend.log` |
| Complete tooling suite | Passed: 168 | `accepted-checks/tooling.log` |
| Matched full-SPA browser | Passed: 197 checks, 189 layout observations, 40 screenshots | `browser-2026-09-09T05-31-32-844Z/report.json` |
| Themes and interfaces | Passed: all 23 themes, Modern and Classic; desktop 1440, tablet 900, 390 and 320 px | Same browser report |
| Computed text contrast | Passed: 46 theme/interface checks, no findings or unresolved complex backgrounds | Same browser report |
| Authenticated API/browser contract | Passed: all four operations and cancelled partial results; real isolated session cookie | `accepted-api-fixtures/envelopes.json` |
| Windows packaged hidden-worker startup | Passed: Quick exclusions, Deep inclusion, unavailable root, confirmed exit and byte-preserved temporary fixtures | `packaged-worker-accepted/report.json` |
| Native macOS/Linux package acceptance | Not run | POSIX process-group helpers have synthetic coverage only |
| Physical phone / screen reader | Not run | Browser viewport and keyboard fixtures are separate evidence |
| Production install/restart, household scans, live Trash | Not run | Deliberately outside this batch |

Evidence paths above are under `build_work/free-space-rebuild/`. The before views
come from the original frozen source. Earlier intermediate snapshots and logs
are retained rather than overwritten; only the candidate above is the final
software-verification identity. Baseline warnings were recorded separately.

## Coverage by responsibility

| Responsibility | Exercised behavior and limits |
|---|---|
| Admission and privacy | Auth before every read route; owner/session isolation; duplicate request IDs; changed-request conflicts; generic competing-job response; bounded cache/expiry; eager revocation and delayed response invalidation. |
| Worker ownership | Pure source bootstrap and early packaged dispatch; cooperative Stop; bounded termination; resource/transport errors; parent shutdown paths; confirmed Windows Job descendants; synthetic POSIX group presence/uncertainty. Only owned processes are stopped. |
| Filesystem reading | Synthetic large trees and representation bounds; depth/entry/time limits; path length/root handling; denied stats; unknown and lower-bound sizes; root/ancestor symlink and junction rejection; unavailable drive rows; source identity/read-only preservation. |
| Searches and results | Independent explicit operations; large-file limits; full duplicate hashing/cancellation; keeper choices retained after failure; paged duplicate groups; prior scans retained on failed/stopped replacement; explicit partial-result review. |
| Exploration | Exact paths, observed host/time, breadcrumbs, sorting, 50-row pages and counts; Map/list equivalence; inert untrusted filenames; unknown sizes; loading/empty/partial/failed/unavailable states. |
| Reviewed Trash | Existing 100-file limit, protected locations, keeper validation, identity changes, expiry, journal receipts, missing keys, auth between moves, partial/uncertain outcomes and no replay. Browser duplicate-click and Clear tests use fake moves. |
| Legacy cleanup | Both legacy mutation endpoints refuse execution; Dashboard and Chat cleanup shortcuts lead to review without scanning or moving files; old quarantine records remain readable and untouched. |
| Preservation | Storage history key protection, existing scan-policy comparison restrictions, encrypted saved-work formats, backup/recovery readback and old record compatibility exercised in the complete backend suite. No backup scope expansion. |
| Handoffs | Location/navigation does not start scans, prepare file mutations or invoke AI. Reviewed Files and Chat handoffs protect existing path/text/context drafts. |
| Browser lifecycle | Panel/background pause and same-job return; BFcache handling; lock clears private observations; delayed result cannot restore them; opaque unresolved operation identity retained independently. |
| Accessibility | Keyboard tabs, sorting and map equivalents; native phone review dialog, Escape/focus return; reduced-motion fixtures; doubled-text simulation; long names and 320 px controls. No physical screen-reader claim. |

Memory and transport bounds are checked through configured OS limits and
synthetic error/overflow cases. This is not a benchmark claiming that every
real volume, permission arrangement or hardware load has been exercised.

See the [workflow guide](TLI_FREE_SPACE_REBUILD.md),
[before/after gallery - local evidence](LOCAL_EVIDENCE.md), and
[complete anniversary inventory](TLI_ANNIVERSARY_UPGRADE_SUMMARY.md).
