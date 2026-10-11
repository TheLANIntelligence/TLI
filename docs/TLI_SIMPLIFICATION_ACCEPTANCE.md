# TLI Simplification Release — acceptance record

Implementation date: 13 September 2026. The frozen source candidate passed the full backend/frontend suites and
the browser checks recorded below. Production restart, deployment and native app distribution are outside
this source delivery.

## Delivered behavior

The shared navigation catalogue presents Home, Ask TLI, Files & Storage,
Devices, Game Optimizer and Vault, with Help, More and Settings below them.
Secondary workspaces retain their controllers and can be pinned. Desktop,
mobile-browser navigation, keyboard search aliases and saved places resolve
the same destinations. Child workspaces keep their parent selected; access
checks do not depend on sidebar visibility.

- Files & Storage connects Organize and Free Space through explicit preparation.
  Preparation does not scan or execute. Search, individual/category selection,
  editable destinations and Leave here create exact subsets. The 500-file limit
  refuses oversized operations. Blocked-file removal requires a fresh review;
  conflicting drafts and failed replacement scans retain prior work. Cleanup,
  partial outcomes and guarded Organizer Undo remain distinct workflows.
- Game Optimizer reads the host hardware and one of the three existing game
  configurations, accepts corrections and goals, then uses the selected
  Integrated or LM Studio provider through an inference-only adapter. Model
  identity, input budgets, complete responses and bounded setting choices are
  checked. Current values retain their source; unsupported game menus and
  unknowns stay explicit. Previous advice and contextual follow-ups are retained.
  Users apply trials in the game themselves.
- Devices groups Computers, Smart devices, Routines, Phone Companion, Printers &
  scanners and USB drives. Computer messages/transfers and USB storage handoffs
  open from their relevant device. Routines support revision-checked editing,
  duplication, archive/restore and Home favorites, preserving target review and
  per-step outcomes.
- Saved notes sit under Ask TLI. Help contains troubleshooting, case history,
  guided checks and app performance observations. More separates installed app
  launchers from Advanced tools and package management. Themes, Modern/Classic,
  projects, registries, notes, receipts, backups and existing storage owners remain.

The [workflow guide](TLI_SIMPLIFICATION_RELEASE.md) maps every former destination.
The [browser manual](../frontend/manual.html) and [root manual](../TLI_MANUAL.md)
describe current user flows.

## Preservation and scope

Implementation began from an allowlisted snapshot of the working tree, including
existing uncommitted source. The baseline has 807 files and SHA-256 fingerprint
`94c4ba98a42875edf9f3058cc3a28bfff71de146abd05ce68ad2d62b6c2e7d39`:
`build_work/simplification/baseline/release-snapshot-63golfbz/`.
Its source policy excludes private/runtime data, model weights and generated
builds. Public Markdown guidance is preserved separately in the final delivery.

All 105 allowlisted native mobile source files match the baseline exactly.
The Home Power and Companion backend routers also match. Native Scene APIs and
storage remain unchanged. Guided diagnostic results retain the legacy
`panel-games` field for installed Companion validators and add
`desktop_panel: panel-performance`; desktop Help routing accepts the legacy
handoff. Desktop Routine synchronization needs a separate native release.

No household files were organized or moved to Trash, no live home devices were
operated, and no package install or user project execution was used for these
tests. Browser APIs use synthetic intercepted responses; backend tests use
isolated temporary state. Real-model review used only an already-running
Integrated runtime, without starting or changing it.

## Verification evidence

The final source candidate contains **821 allowlisted files**.
SHA-256 fingerprint:
`26d0df9bf3e96d60bd7a74f373ca9e58630862e72d3d8795930b22e0b900d132`.

Evidence paths below are relative to the repository root. They identify local
generated verification artifacts, which are not included in the public source
repository.

Candidate manifest: `build_work/simplification/candidate/release-snapshot-c8jcnfpu/manifest.json` ·
Snapshot/source match verification: `build_work/simplification/final-snapshot-verification.json` ·
Changes relative to the preserved baseline: `build_work/simplification/candidate-changes.json`.
The delta is 14 added and 45 changed source files, with 762 baseline files
unchanged and none removed. Public guidance has its own
hash manifest at `build_work/simplification/candidate/release-snapshot-c8jcnfpu/guidance-manifest.json`.

| Check against frozen source | Result | Evidence |
| --- | --- | --- |
| Complete backend suite | 2,891 passed | pytest log: `build_work/simplification/final-backend.log` |
| Complete frontend suite | 1,266 passed; zero failures/cancellations/skips | Node test log: `build_work/simplification/final-frontend.log` |
| Entire SPA navigation and palette matrix | 727 layout checks, 56 captures, zero failures; 23 palettes in both interfaces | Browser report: `build_work/simplification/browser-2026-09-13T20-44-47-878Z/report.json` |
| Storage workflow browser checks | 12 behavior groups, 18 layouts/captures, zero failures | Storage report: `build_work/simplification/storage-browser/2026-09-13T20-45-17-688Z/report.json` |
| Game workflow browser checks | 5 behavior groups, 8 layouts/captures, zero errors | Game report: `build_work/simplification/game-browser/2026-09-13T20-45-18-279Z/report.json` |
| Routine controller browser checks | 16 workflows, 56 layout/contrast checks, 17 captures, zero errors | Routine report: `build_work/simplification/candidate/release-snapshot-c8jcnfpu/source/build_work/anniversary-completion/routine-browser/2026-09-13T20-45-19-022Z/report.json` |
| Interface continuity | 8 checks; active stream, attachments, drafts, focus and locking retained | Continuity report: `build_work/classic-interface/browser-2026-09-13T20-44-48-074Z/report.json` |

The SPA matrix covers 1440, 1024, 390 and 320-pixel viewports in Emerald Light
and Midnight, with a separate all-palette smoke pass. The populated Game
workspace adds 768-pixel checks. Visible secondary pins, saved-place links,
legacy keyboard-search aliases, parent selection, navigation restrictions,
USB handoffs and lazy installed-app loading/session locking are exercised.
Storage checks cover subsets, 500/501, blocked files and fresh review, draft
conflicts, failed scans and missing candidates. Backend tests cover actual
temporary-file collisions/partial outcomes and routine revision/execution
conflicts; synthetic browser success is not a real file/device outcome.

The local interactive before/after review at `build_work/simplification/review/index.html` compares six
workspaces in Modern/Classic at desktop and narrow widths. Final Home desktop,
Classic Devices in a narrow dark palette, populated file review, and narrow
Game screens also received visual inspection. Reports identify synthetic data.

Commands used the repository virtual environment for pytest and Node's test
runner against the frozen tree. Browser harnesses used Edge Chromium through
Playwright; the SPA, storage, game and continuity scripts received `--source`
pointing at the candidate. The routine script ran directly from the candidate
because it resolves its own source root. No production server was started.


## AI answer quality and practical limits

The actual game route and inference adapter completed four final advice cases
with the already-running Qwen2.5-3B-Instruct-Q4_K_M.gguf Integrated model; a fifth
case with missing GPU/resolution requested clarification without inference.
Cases covered materially different hardware, unknown current values, manual
settings for another game and follow-up exclusions. Raw prose from earlier
reviews failed quality requirements; the shipped path validates bounded model
choices and renders source-derived current values, rationale and tradeoffs.

LM Studio was unavailable for live answer review. Its transport, exact model
binding, changed-model rejection and failure behavior were tested synthetically.
The live review called the actual route/adapter in an isolated process because
the production TLI API was unavailable; it does not establish live app startup
or production provider-selection integration. See the
[Game Optimizer validation record](TLI_GAME_OPTIMIZER_VALIDATION.md) for exact
inputs, returned trials, provider identity, timestamps and source hashes.

The game catalogue is deliberately limited to quality-setting trials supported
by the existing readers or explicitly named by the user. It does not validate
every game/menu version, measure FPS, promise a gain or apply settings. Physical
device, native distribution, screen-reader and real gaming acceptance are not
claimed by simulated browser or transport checks.

Automatic organization, AI executable file plans, cross-drive archiving,
automatic scheduling, public marketplace development, major Builder expansion,
additional themes and new peer inference remain deferred as planned.
