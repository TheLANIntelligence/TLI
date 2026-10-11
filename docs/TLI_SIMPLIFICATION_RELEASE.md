# TLI Simplification Release

Source implementation, September 13, 2026. Final integrated verification and
before/after review captures are linked from the
[release acceptance record](TLI_SIMPLIFICATION_ACCEPTANCE.md). Production restart,
deployment and native Companion distribution are outside this delivery.

The desktop left sidebar directly offers **Home, Ask TLI, Files, Free Space,
Game Optimizer, Vault, Computers, Smart devices, Routines, Phone Companion,
Printers & scanners and USB drives**. Help, More and Settings remain available.
The Devices overview is retained as a secondary destination and for legacy
links; it no longer bundles those individual entries in the desktop sidebar.
Specialist tools can still be pinned. Searching a previous feature name still
helps locate it. Earlier acceptance captures record their original checkpoint;
this destination map describes the current navigation. See the
[direct sidebar follow-up](TLI_SIDEBAR_DIRECT_ACCESS.md) for its verification and
updated captures.

## Where existing features live

| Previous destination | Current location | Retained destination or entry |
|---|---|---|
| Dashboard | Home | `panel-dashboard2` |
| AI Chat | Ask TLI | `panel-main` |
| Notes & fixes | Ask TLI → Saved notes | `saved-notes`, existing notes drawer |
| Files / File Organizer | Files → Organize | `panel-files` |
| Free Space / Storage Visualizer | Free Space | `panel-visualizer` |
| Vault | Vault | `panel-vault` |
| Devices overview | Secondary navigation / legacy Devices links | `panel-devices-home` |
| Computers / Mesh | Computers | `panel-mesh` |
| Phone Companion | Phone Companion | `panel-companion` |
| Printers & USB | Printers & scanners → Printer status; USB drives | `panel-devices`; USB view `panel-usb` |
| Print & Scan | Printers & scanners → Print & scan | `panel-printshop` |
| Smart devices / Home automation | Smart devices | `panel-homeauto` |
| Automations | Routines | `panel-automations` |
| LAN Messages / TLI Chat | Computers → Messages & files | `panel-tli-chat` |
| Troubleshooting | Help → Fix a problem | `panel-troubleshooting` |
| Performance & apps | Help → App performance check | `panel-performance`; the old `panel-games` destination now presents Game Optimizer |
| Game advice | Game Optimizer | `panel-games` |
| Saved diagnostics / device reports | Help → Saved reports | `panel-reports`, former diagnostic content from `panel-devices` |
| Utilities | More → Advanced tools → Utilities | `panel-tools` |
| Scripts | More → Advanced tools → Scripts | `panel-scripts` |
| Builder | More → Advanced tools → Builder | `panel-builder` |
| TLI Hub / packages | More → Advanced tools → Package management | `panel-hub` |
| Installed app launchers | More → Installed apps | `panel-installed-apps`, existing app destinations |
| Settings | Settings | `panel-settings` |

Printers and removable storage have separate entry points. App performance
observations and game recommendations also have separate destinations. Neither
split removes the underlying specialist workflow. Settings, security, backups,
saved notes, conversations and Vault remain in their existing owners and stores.

On narrow screens the compact navigation keeps Home, Ask TLI and Files close at
hand, with the remaining destinations available through More. Organize/Free
Space and device workflow subnavigation remain available inside the workspaces.
Pinning a specialist adds a shortcut; it does not run that feature or change its data.

## Organize selected files

1. Open Files → Organize. Choose a familiar folder or a saved place.
   Folder tiles and handoffs prepare the location; **Scan folder** starts the
   listing. The target is the computer hosting TLI, even when using another
   browser or a phone.
2. Select files individually, search their names or filter by file type.
   A fresh folder starts with nothing selected. The list shows 50 matches per
   page, and filtering or paging never adds files to the selection.
3. Review the destination subfolders. **Select matching files** adds the matching
   scope; **Leave matching files here** removes it. **Leave all files here** clears
   the selection. Unselected files are excluded from the operation.
4. Use **Review moves**. Check every source and destination, then confirm the
   exact reviewed operation. A blank destination must be resolved before review.
   A blocked review offers **Leave blocked files here**; this changes the draft
   and requires another review before any move.
5. Read the per-file results. Use **Review undo** for recorded moves or renames.
   Partial and unconfirmed outcomes remain distinct from successful completion.

One organize operation is limited to 500 selected files. An oversized bulk
selection leaves the current selection unchanged; it never silently takes the
first 500 or schedules later batches. Complete a batch deliberately before
preparing another. Files inside existing subfolders are not included in the
Organizer listing. Destinations remain subfolders of the selected root; this
release does not add recursive organization or cross-drive archival.

The image, installer and archive recipes now add exactly that category to the
draft. Other explicitly selected files remain selected. AI suggestions, folder
summaries and prefix rename remain under More tools. AI output is written advice:
it does not replace the draft, approve a move or become executable rules. Prefix
rename retains its existing whole-folder review and is not narrowed by the
Organizer's selection filter.

## Working with Free Space

Use Free Space to inspect a drive or folder and understand its recorded storage
usage. Quick and Deep scans, map and list, large-file search, verified duplicate
search, saved comparisons and cleanup receipts retain their existing behavior.
The selected location and a retained observation can differ; the observation's
host, root, time and coverage remain visible.

**Review this folder in Files** carries the folder and observation context into
Organize. When a real file was selected, it is offered as a candidate after the
folder listing matches its exact path. Review the candidate filenames and choose
**Add matching files to plan**. A grouped map block, nested file or missing file
does not turn into an implicit recursive move.

If Organize already contains a different folder draft, TLI presents the current
and requested locations. **Keep current draft** leaves it alone. **Use this
folder** prepares the new path; the prior scan and selection remain available
until a replacement scan succeeds. **Return to the previous folder draft**
restores that retained location. Failed or malformed replacements retain the
previous result. Locking clears private draft and handoff state.

Organizing files within a drive does not free capacity. Free Space cleanup is a
separate workflow, limited to 100 individually selected files with its own review,
duplicate keeper requirements and receipt. It moves eligible files to the OS
Trash or Recycle Bin. Trash can still occupy space; moved file sizes are not
measured freed capacity. Restore Trash items through the operating system, not
Organizer Undo. This release adds no permanent-delete or empty-Trash action.

## Other everyday workflows

- Computers, Smart devices, Routines, Phone Companion, Printers & scanners and
  USB drives open directly from the desktop sidebar. Saved routines are reviewed and deliberately run;
  this release adds no schedule or automatic trigger. Saving or favoriting a
  routine does not run it.
- Game Optimizer starts with a game, a goal and Analyze this PC. Review hardware,
  playing resolution and known setting values before Get my settings plan. AI
  selects up to three quality trials; displayed current values come from reads
  or your explicit selections. For other games, name quality controls from the
  menu; their available options remain unverified. Report what you tried and
  measured, then keep same-game context or choose different settings for the
  follow-up. Invalid AI plans preserve the previous advice. Settings are not
  applied and FPS gains are not measured or promised. Help → App performance
  check retains bounded CPU and memory observations. See
  [Game Optimizer validation](TLI_GAME_OPTIMIZER_VALIDATION.md) for model review
  scope and test evidence.
- More separates installed app launchers from package management and developer
  tools. Opening a navigation card does not approve a package install, code
  change or script execution.

## Implementation and verification scope

`frontend/js/ui-foundation.js` owns the destination catalogue and sidebar pins.
`frontend/js/simplification.js` composes directories, subnavigation and specialist
links. Existing feature controllers retain their operation and draft ownership.
Saved-place panel labels and options use this same catalogue. The backend retains
an ID-only allowlist accepting the current panels and legacy saved destinations;
reading old favorites does not rename them or rewrite their stored bytes.

`TLIStorageWorkspace.prepare({view, root, hostId, candidatePaths, observation,
source})` coordinates storage entry points. `view` is `organize` or `space`.
It returns `prepared`, `draft-conflict` or `unavailable`. Preparation never starts
a filesystem scan or a file-changing request. Candidate paths are capped at 500;
known host mismatches and malformed handoffs are rejected. Observation metadata
is context, not execution authority. Saved places, Free Space and global storage
navigation use this interface; existing panel IDs and compatibility helpers remain.

Files uses its existing `{path, actions}` operation payload with an explicitly
selected subset. The backend operation protocol and recorded undo formats are
unchanged. Exact-path preflight, ten-minute preview expiry, collision refusal,
protected locations, file identity checks and truthful partial results remain.
Editing a selection or destination invalidates its previous review. A lost
execution response never triggers automatic retry.

At this checkpoint, 147 focused frontend checks pass across file operations,
handoffs, Free Space, saved places, cleanup, history and related retained
workflows. These include 17 new selection, handoff and catalogue regressions.
The 61 isolated backend checks across file operations and saved places also pass,
including preservation of legacy favorite bytes and support for current panel IDs.
Fixtures use synthetic state and owned
temporary files; no household scan, household move or real Trash cleanup was
performed.

The dedicated [storage browser report](../build_work/simplification/storage-browser/2026-09-13T20-13-59-570Z/report.json)
records 12 behavior groups, 18 layout checks and 18 screenshots using the actual
SPA in Edge at 1440, 390 and 320 pixels. It verifies exact selected subsets,
category destinations, the 500/501 boundary, blocked-file removal and fresh
reviews, conflicting drafts, failed replacements, missing handoff candidates,
shared saved-place labels and lock clearing. It reports no JavaScript errors,
control/document overflow, duplicate IDs or execution requests. The storage
source hashes remained unchanged during that run. Desktop Emerald Light and
narrow Emerald Light/Midnight screenshots received visual review.

Final full-suite, all-theme and release acceptance belongs to the integrated
release record and must not be inferred from these focused checks.

Native-app distribution, installer signing and physical-device acceptance are
unchanged by this checkpoint. No scheduled work or automatic file/device changes
are introduced by this navigation and storage workflow release.

### Companion diagnostic compatibility

The guided-check API retains its legacy performance `panel: panel-games` value
for installed Companion validators and adds `desktop_panel: panel-performance`.
The desktop renderer maps performance checks to Help directly, accepting either
legacy or current panel identifiers. This keeps native checks compatible without
a client distribution. Native scenes remain unchanged.
