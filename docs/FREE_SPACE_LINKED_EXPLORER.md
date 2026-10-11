# Free Space linked explorer

The folder tree, extension filters and treemap inspect one validated storage
observation. Expanding a retained folder or changing a display filter does not
start another scan. A smoother interface does not enlarge scan coverage or
restore file paths discarded from the result.

## Workspace behavior

Free Space opens the linked explorer by default. At 1,100 CSS pixels of available
workspace width, the retained folder tree takes 60% of the split and the map and
extensions take the remainder. Drag the separator or use its arrow keys to adjust
that proportion. Below 1,100 pixels the panes stack; below 760 pixels, Tree, Map
and Types buttons share the same scope and selection. Only the pane proportion
is saved as a presentation preference.

Disclosure arrows expand retained children without changing the focused folder.
Click an entry to inspect it; double-click a folder or press Enter on its tree row
to focus that folder. Arrow keys navigate the tree, Space selects, and breadcrumbs
return to recorded ancestors. Selecting a map file reveals its tree row. Search
and extension filters preserve ancestor context; clearing a filter restores the
manual expansion state. Extensions continue to show the scope's distribution
while an extension filter is active.

Sibling sorting preserves the hierarchy. Counted logical size is the default;
On disk stays a separate measurement. Parent percentages use the selected size
measure and remain unavailable for an unknown or zero parent total. The tree
mounts only its visible window plus overscan and, when necessary, one focused row.
The existing treemap remains bounded to 240 display leaves. Extension summaries
show at most 80 groups per page while preserving the full distribution totals.

The selected-item area supplies recorded measurements, observation time,
limitations, Open location, Copy path, Explain this and supported cleanup review.
Inspection does not select files for cleanup. The existing exact-file preview,
confirmation and outcome receipt still govern cleanup.

Changes opens the existing saved-scan comparison and capacity timeline. Selecting
an entry does not request history automatically. Once a supported comparison is
loaded, a matching retained root, immediate folder or file can show its measured
change. Missing paths explicitly report comparison unavailable; absence from
bounded history never means unchanged or deleted. Cached comparison and selected
paths clear with the session and are invalidated when their scan or baseline
changes.

## Explain a selected entry

`POST /visualizer/investigate` accepts the existing `job_id`, optional `question`
and optional `baseline_id`, plus an optional `selected_path` string of 1–4096
characters. Omitting `selected_path`, or sending `null`, preserves the whole-scan
answer and response shape.

The server resolves a selected path only against the authenticated job's retained
tree. It performs no path resolution against the filesystem, scanned-file content reads,
new scans, provider calls or cleanup actions. Paths are absolute; parent
traversal and NUL characters are rejected. The traversal is bounded to 25,000
nodes. An unretained path returns 404, including one present only in a separate
largest-file summary. Synthetic aggregate selections return 422; ambiguous or
unsupported retained trees return 409. A real file whose name resembles a
synthetic bucket remains selectable when it is not marked synthetic.

The response retains `protocol: "storage-investigation-v1"` and `local_only:
true`. Selected answers add:

| Field | Meaning |
| --- | --- |
| `evidence.selected_path` | Canonical spelling from the retained result. |
| `evidence.selection.path`, `name`, `kind` | Selected file or directory identity. |
| `logical_bytes`, `counted_logical_bytes` | Observed logical size and its contribution to counted totals. Unknown sizes remain `null`. |
| `allocated_bytes`, `allocated_known_bytes`, `allocated_partial` | Complete allocation when available, measured contribution, and allocation uncertainty. |
| `file_count`, `retained_children`, `modified_at` | Observed descendant file-name count, immediate nonsynthetic retained children, and recorded modification time. Metadata may be unavailable. |
| `partial`, `scan_partial`, `size_known`, `size_reason` | Selected-entry coverage separately from overall scan coverage. |
| `hardlink_duplicate` | Additional name whose bytes were counted elsewhere. |
| `representation_limited`, `omitted_entries`, `omitted_bytes` | Grouping or path omission inside the selected subtree. Entry counts describe omitted/grouped tree entries, not necessarily individual files. |

The fields after `evidence.selection.path` in this table belong to
`evidence.selection`. Existing top-level evidence totals, categories, capacity
and history comparison continue to describe the original scan scope. A selected
answer explicitly qualifies a supplied baseline comparison; it does not attribute
whole-scan growth to the selected path.

The UI binds the answer to its job, root and selected path, discards responses
after selection/session changes, and renders reply text without executing markup.
The backend checks the original credential and owner when retrieving the result
and rechecks access before returning private evidence.

## Measurement and coverage boundaries

A hard-link alias retains its logical size but contributes zero counted bytes.
That zero does not mean it occupies no allocation or that removing the name will
release space. Unknown allocation is never replaced with logical size. A
modification timestamp alone does not establish growth. Folder explanations
cannot authorize removal of the folder or its unretained contents; individual
cleanup still uses the existing separate review flow.

For a selected file, a temporary/cache-like path is only a category hint. Its
recommendation requires review and explicitly leaves ownership, whether the file
is in use, and removal safety unverified. Protected entries remain blocked; this
selected-entry rule does not change the existing whole-scan classifications.

Scan coverage and retained representation are independent. A folder may have
measured totals while some individual paths have been grouped or omitted.
Expansion cannot recover those paths. Extension filtering and virtualized rows
describe retained evidence, not an exhaustive drive inventory. Saved history
contains bounded summaries, not a reopenable complete tree.

The scanner limits remain unchanged: Quick uses 15 seconds, 50,000 entries and
depth 18; Deep uses 300 seconds, 500,000 entries and depth 30. Results retain at
most 25,000 tree nodes, collapse children beyond 2,500 per directory, and have a
32 MiB response bound. Workers retain their 512 MiB memory bound and one-reader
admission rule. Excluded folders, unreadable entries, links and reparse points
continue to affect coverage. The engine remains bounded directory enumeration.

## Separate indexing benchmark

Full-drive indexing is a separate performance and architecture evaluation. This
interface change does not introduce an MFT reader, persistent full inventory,
larger scanner budgets, or a claim of full-drive scan speed.

Benchmark the existing traversal on disposable fixtures first: wide directories,
deep nesting, many small files, large files, aliases, unknown allocation and
permission gaps. Record enumeration time, metadata/allocation time, peak worker
memory, serialization size, retained versus inspected entries, cancellation
latency and limit reasons. Measure tree filtering/rendering separately using
synthetic retained results up to the supported node limit.

If evidence supports a larger inventory, evaluate bounded worker output chunks
and a parent-managed, job-scoped index with paginated children, search and
aggregate queries. Preserve owner/session binding, expiry, resource budgets,
read-only worker behavior and cancellation. Such an index requires its own
coverage and persistence design; increasing a JSON limit is not a substitute.

## Backend verification

The selected-path suite and existing storage intelligence, job and authenticated
API fixture suites passed together: 127 tests. Coverage includes canonical
retained paths, synthetic/missing selections, unknown sizes, hard-link accounting,
omitted metadata, traversal bounds, session/owner isolation, revocation before
delivery, whole-scan compatibility, distinct Unicode path names and no new
filesystem/provider calls for selected metadata.

Relevant implementation: `backend/intelligence/storage_diagnosis.py`,
`backend/routers/visualizer.py`, and
`backend/tests/test_storage_selection_diagnosis.py`.

## UI verification

The complete frontend test suite passes: 1,495 tests. This includes the new pure
tree model, selected-history evidence, linked controller, privacy, partial
allocation, focus retention, and bounded extension rendering checks.

Three intercepted-API browser suites pass in headless Edge: 34 checks total,
including 13 layout captures across light/dark themes and modern/classic layouts.
They exercise actual SPA markup and controls with synthetic observations; they
do not call the running host or perform filesystem scans or cleanup.

- `scripts/verify_free_space_linked_browser.cjs`: 25,000 retained nodes, shared
  selection and filters, tree keyboard navigation, folder focus, explanation
  expiry, pane resizing, 760/1,100-pixel layout behavior, 200% CSS zoom and lock
  clearing. The final run initially mounted 37 tree rows and completed initial
  scan-response rendering in 883 ms on the test machine. Expanding all 24,999
  entries retained bounded mounted rows. This is UI timing, not scan timing.
- `scripts/verify_free_space_rebuild_browser.cjs --quick`: existing scan status,
  cancellation, failed replacement, scope guards, exact-file cleanup review,
  delayed session responses, themes, keyboard focus and enlarged text.
- `scripts/verify_free_space_v2_browser.cjs`: allocation/hard-link presentation,
  explicit investigations, selected saved-history changes and unavailable paths,
  retention and opt-in monitoring.

Reports and screenshots are under `build_work/free-space-linked/browser/`,
`build_work/free-space-linked/browser-regression/`, and
`build_work/free-space-v2/browser-focused/`. Physical devices and screen-reader
announcements have not been manually tested. Asset version hashes were refreshed
for the linked explorer's script, map model and stylesheet.
