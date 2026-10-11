# Free Space: space map renewal

The space map now makes recorded folders easier to explore and restores useful
file actions through one popup shared by the map, list and inspector. The scan
reader also fixes a node-budget defect that could discard a folder after its
children had already been inspected, leaving a large unexplained grouped region.

Open **Free Space**, choose a location and explicitly start a scan. In
**Space map + list**, select an entry to inspect its name, exact path and recorded
size. **Look inside**, folder labels and breadcrumbs explore the folders already
present in that observation. Double-clicking a file focuses on its recorded
parent folder. These navigation actions do not start another scan. On wider screens, **Expand map** gives the drawing the full workspace width; **Map beside list** restores the split view. Long list names stay compact; their complete paths remain available in the inspector, action popup and Copy path.

## Map and list actions

Right-click a tile or list entry, press **Shift+F10** on a focused entry, or use
the visible **Actions** button. The same controls are available for touch through
the list and selected-entry inspector. Tiny tiles retain a paginated list
equivalent; their size does not make their recorded paths inaccessible.

The popup offers actions appropriate to the selected entry:

| Action | Effect |
| --- | --- |
| Inspect details | Shows the selected entry's recorded information. |
| Open recorded folder / Show parent folder in map | Explores an existing folder in this observation. |
| Copy path | Copies a real recorded path through the browser clipboard. |
| Review folder in Files | Opens a reviewed handoff to the existing Files workspace. A different Files draft is preserved; no scan, plan, host file launch or move runs. |
| Prepare folder scan | Places the folder in the scan-location field. Starting the scan remains a separate explicit action. |
| Hide from this view | Temporarily removes the selected file or displayed group from exploration. |
| Review cleanup / Review selected files | Uses the existing file-selection and reviewed Trash workflow. Opening the popup does not select files or execute cleanup. |

Grouped entries never impersonate real filesystem paths or become cleanup
selections. Protected files remain protected. Cleanup retains the existing
100-file limit, duplicate keeper checks, preview expiry, identity rechecks,
session checks and per-file outcomes. File sizes do not establish freed capacity;
moving files to Trash may leave their bytes on the same drive.

The legacy host **Open** and **Reveal** endpoints are not registered in the
running application, so this update does not advertise or restore host file
launching. **Review folder in Files** is the supported browser handoff.

Keyboard navigation, Escape and focus return are handled by the popup. Its
actions bind to the displayed observation and revision. Replacement results,
filtering, leaving the view, backgrounding and locking invalidate the relevant
controls; detached popup controls cannot restore an old selection or execute an
old action.

## Understand the area before interpreting it

Tile area stays proportional to known recorded file bytes. A large system file
can legitimately occupy much of the map. Its area is not artificially reduced
to make smaller files appear equally large. Folder totals and child bytes are
counted once, and the map does not derive unexplained disk usage by subtracting
inspected files from drive capacity.

**System files** and **Disk images** have distinct categories alongside the
existing file types. These colors describe extensions, not whether a file is
important, faulty or safe to remove. The protection checks remain independent
of the color palette.

There are two different kinds of grouped area:

| Map entry | What is available |
| --- | --- |
| Other mapped entries | Individual paths were retained but grouped to bound drawing. **Show grouped entries** reveals that subset of the same observation. |
| Other indexed contents or a host-created collapsed group | Known bytes were retained without all individual paths. The current observation cannot expand those missing paths. Prepare a narrower folder scan and start it explicitly if more detail is needed. |

The representation retains at most 25,000 tree nodes and draws at most 240
positive-size tiles at once. Display grouping preserves the represented byte
total. Unknown sizes remain unknown and contribute no area; zero-byte entries
remain distinguishable from unknown sizes. **Map accounting** explains recorded
scope, matching bytes and the available unknown-size and grouping information.
Partial scan coverage and omitted representations do not prove a folder is empty.

**Hide grouped bytes** can make individually recorded files easier to see.
**Hide from this view** can similarly remove a dominating file or display group.
The visible hidden-entry notice records matching hidden bytes and entries, and
**Show hidden entries** restores them. These are reversible display choices:
saved observations, complete recorded folder totals, cleanup selections and
household files are unchanged. A valid replacement observation clears these
temporary choices; a failed replacement keeps the previous observation.

## Preserve useful folders when the scan representation fills

The storage reader now reserves a directory's representation slot before
descending into its children. Descendants cannot use the last slots and then
cause their own parent to disappear. If a branch cannot be retained, its
inspection still contributes aggregate measurements without retaining orphaned
descendants. Fully inspected empty directories release unused reservations.

Existing scan-time, entry, depth and worker limits remain in force. Cancellation
preserves the bytes already inspected and keeps incomplete coverage explicit.
This changes neither storage-job response formats nor saved-scan formats.

An old observation cannot gain paths that its original scan did not retain.
After the updated backend is running, explicitly scan the location again to
benefit from the branch-retention fix. If the host still runs earlier code, use
its normal manual stop/start when convenient, then start a new scan. This source
update and its automated checks do not restart the live host or run a household
scan for you.

## Preservation and verification

Modern and Classic remain separate interface choices. All 23 themes and the
current theme/interface preferences are preserved; the renewed map consumes
the selected appearance. Existing observation and cleanup owners, encrypted
records, reviewed workflows, active model and native Companion remain intact.

The [verification results](../build_work/space-map-renewal/RESULTS.md) record
baseline findings, final source identity, automated coverage and remaining
limitations. The [before/after gallery](../build_work/space-map-renewal/review.html)
shows the renewed map and controls. Test counts belong to those matched results
rather than this workflow guide.

Automated checks use synthetic storage trees, isolated persistence, intercepted
browser requests and fake Trash behavior. Physical phones, screen-reader use,
household scans and cleanup, live restarts and native-platform acceptance remain
separate and are not claimed as performed by this checkpoint. Remote access
remains deferred.
