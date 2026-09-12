# Workspace cohesion: verification and coverage

Recorded September 10, 2026 (America/New_York; evidence timestamps use UTC).
This record covers the implemented Dashboard, Troubleshooting, Free Space and
Performance & apps refinement. It is a source and browser checkpoint, not a
production installation or physical-device acceptance certificate.

## Source and baseline

The baseline preserves the intended working tree, including existing uncommitted
anniversary work, in
`build_work/workspace-cohesion/baseline/release-snapshot-ytxkz03p/source`.
Its 785-file fingerprint is
`05f9aa8e95c94d17243b7c5c2b56dfa29c2afbb43f93484d5867353ae27ca071`.

The final candidate is
`build_work/workspace-cohesion/final-candidate/release-snapshot-swyteq08/source`.
Its 793-file fingerprint is
`2d1032ecf3df2b68c1b92422e976641445732b46824b789e12494c9be5ccca9b`.
The release snapshot verifier confirmed that the candidate and current source
match. Documentation and evidence are separately hashed in the
[delivery manifest - local evidence](LOCAL_EVIDENCE.md).

| Suite | Isolated baseline | Final candidate |
|---|---:|---:|
| Complete backend | 2,741 passed | 2,769 passed |
| Complete frontend | 1,093 passed | 1,132 passed |
| Complete tooling | 178 passed | 178 passed |

There were **no baseline test failures**. The baseline backend emitted 5,268
warnings and the final run emitted 5,269; warning details are retained in their
logs. The final backend run completed within the revised harness limit (592.30
seconds reported by pytest; 617.62 seconds including process overhead). See the
[baseline report - local evidence](LOCAL_EVIDENCE.md)
and [final report - local evidence](LOCAL_EVIDENCE.md).
Tests use sanitized environment settings and temporary persistence. The running
TLI application, live inference, discovery and real Trash operations were not
used by these checks.

The [source delta - local evidence](LOCAL_EVIDENCE.md) records
eight added and 29 modified allowlisted files, with no deleted files. The
[gallery check - local evidence](LOCAL_EVIDENCE.md)
loaded all 20 before/after image pairs and 12 local links without errors or
external requests.

## Browser matrices

These checks load the actual frozen SPA in headless Edge with synthetic accounts,
files, processes, observations and intercepted requests. Counts describe each
matrix, overlap between matrices, and must not be summed as unique user journeys.

| Area | Recorded coverage | Result |
|---|---|---|
| Complete shell | 190 views; original control inventory compared with this checkpoint's baseline | Passed; no overflow, duplicate IDs, failed sessions or source drift |
| Four-panel integration | 96 views, 20 session checks; aligned headings, immediate symptom draft, lock and navigation behavior | Passed |
| Dashboard | 22 behavior checks, 106 layout checks, 56 captures, 23 themes | Passed; no recorded contrast or overflow failures |
| Troubleshooting | 9 behavior checks, 254 layout checks, 60 captures, 23 themes | Passed |
| Performance & apps | 7 behavior checks, 90 layouts, 90 contrast checks, 49 captures, 23 themes | Passed |
| Hierarchical storage map | 5 behavior groups, 139 layouts, 26 captures, 23 themes | Passed |
| Complete Free Space workflow | 197 checks, 189 layouts, 46 contrast checks, 40 captures | Passed |
| Large results | 500-path synthetic observation, 12 layouts | Passed |
| Selected file inspector | Desktop and 320px Classic phone; 2 dedicated captures | Passed |

The integrated matrix includes Modern and Classic, Emerald Light and Midnight,
1920/1440/1024/390/320-pixel viewports and doubled text at 320 pixels. Focused
matrices add 2500/768-pixel layouts, every selectable theme, keyboard interaction,
reduced motion and fault states. Detailed visual inspection covered wide
Dashboard, unscrolled phone symptom entry, scoped check review, nested maps,
selected-file details, Classic Midnight and Performance's initial/recording
states. Browser keyboard and accessibility checks do not establish screen-reader
or physical-phone acceptance.

Evidence:

- [Full-shell report - local evidence](LOCAL_EVIDENCE.md)
- [Integrated capture report - local evidence](LOCAL_EVIDENCE.md)
- [Dashboard report - local evidence](LOCAL_EVIDENCE.md)
- [Troubleshooting report - local evidence](LOCAL_EVIDENCE.md)
- [Performance report - local evidence](LOCAL_EVIDENCE.md)
- [Storage reports and screenshot hashes - local evidence](LOCAL_EVIDENCE.md)
- [Troubleshooting and Performance source/evidence binding - local evidence](LOCAL_EVIDENCE.md)

## Behavior and preservation coverage

**Dashboard and identity:** exact drive/host reconciliation, stale or failed
readings, independently snoozed suggestions, receipt/target mismatch, duplicate
clicks, conflicting identity sources, old responses, acknowledged renames and
responses after lock. Shared labels use identity facts without retargeting tools.

**Troubleshooting:** opening an unsaved draft sends no mutation or AI request;
save-and-guidance remain explicit. Scoped Run, unavailable checks, save conflicts,
failed guidance, evidence selection, unsaved edits and late replies retain the
existing protections. Phone reading order puts the symptom editor first.

**Free Space:** hierarchy totals without double counting, collapsed/omitted and
unknown entries, Windows case-insensitive virtual-path collisions, bounded
rendering, list/map exact-path selection, cached folder navigation, 500-path
pagination, failed replacement preservation and duplicate keeper choices.
Selecting a map tile does not select cleanup. Protected files and grouped blocks
cannot bypass review. Existing cleanup authentication, preview expiry, partial
and uncertain receipts are exercised with synthetic data and fake Trash.

**Performance:** first-use setup, explicit process-list requests, protected custom
input, exact-process selection, recording/Stop/interruption, retained results and
late responses. Navigating from a problem does not start an observation.

Existing endpoint URLs, SSE names, encrypted records, ownership and backup scope
are unchanged. Scan representation fields are additive. The complete backend
suite includes existing storage, saved-work, recovery and compatibility tests;
this checkpoint does not perform a real-data restore. No native Companion source,
model selection, pairings or household files were changed by this batch.

## Superseded verification attempts

Development failures remain distinct from the clean baseline and final candidate:

- A frontend VM fixture lacked `addEventListener` after the shared identity
  listener was introduced. The fixture was corrected; the final complete
  frontend suite passes.
- The shell verifier initially used its much older default baseline, reporting
  controls already retired before this checkpoint. It was rerun against the
  retained working-tree baseline listed above.
- A browser run correctly detected edits made while it was running. Its result
  was superseded by the frozen candidate matrices, which report no source drift.
- Candidate `80cbabd048b4c4087ab02a94637a5b238f251445ec4f0a4786540d521c09e22d`
  hit the test harness's 600-second backend timeout. Its
  [failed report - local evidence](LOCAL_EVIDENCE.md)
  is retained. The final snapshot uses a bounded 1,200-second harness limit;
  that timeout is not counted as a passed gate or a baseline defect.
- Full-page phone review exposed the original inspector distance and
  saved-problem-before-editor ordering. Both were corrected before the final
  snapshot and recaptured in the matched matrices above.

## Explicitly not run

| Gate | Status |
|---|---|
| Physical Android/iPhone, real Wi-Fi interruption and retained pairing | Not run |
| Screen-reader operation on a physical device | Not run |
| New native package, installer, macOS/Linux installation | Not run |
| Live household scans, diagnostics, cleanup or device actions | Not run |
| Production restart and acceptance of the running installation | Not run |
| Real model evaluation or resolution of prior answer-quality failures | Not run |
| Real-data recovery or restore | Not run |

Refresh the browser to load the updated interface from this checkout. Backend
changes become active at the next normal host restart; this batch did not restart
the user's running TLI process. Earlier physical, model-quality and remote-access
roadmap gates remain separate and open.
