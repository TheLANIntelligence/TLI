# Dashboard: your home, in focus

Implemented in the working tree on September 7, 2026. This checkpoint refreshes
the existing home console; it is not a new application or a published release.

## What changed

The Dashboard now has one attention area containing the Narrator, its current
observation and a clearly identified next action. Compact cards distinguish the
TLI host, system-drive storage, registered smart devices and AI availability.
The host name is the primary identity instead of a large “Solo” label.

Recent activity uses readable event rows with expandable details. Coverage,
retention and previous review information remain available without dominating
the page. Reading or opening the Dashboard never marks activity reviewed.

Saved places now previews up to four existing favorites. Selecting one opens
its existing review dialog. The preview reads metadata when the Dashboard is
explicitly opened; it does not check a path, scan a drive, load a note body,
attach context, send a chat message or call AI. A failed refresh retains the
previous preview with an explanation. Locking clears private content and
rejects late responses.

Files, Free Space and Vault have clear navigation links beside saved work.
Additional shortcuts remain in a disclosure. Asking TLI opens AI Chat. Opening
Free Space can prefill the relevant drive; scanning still requires a user action.
The existing navigation, Narrator preferences and activity feed remain.

## Accuracy and dependable feedback

- Dashboard and header consume shared observation facts. Metric freshness still
  changes after 30 seconds, even if metric bands do not change. Missing readings
  remain unknown; failed refreshes retain prior observations with their time.
  Metric events retain the host timestamp internally, so a different browser
  clock does not turn a fresh reading into a stale or unknown one.
- The registered-device count comes from inventory. A metric event's placeholder
  count cannot overwrite it. Registered devices are not labeled as proven online.
- Dashboard AI availability uses the same selected-source facts as the header.
  Installed files and old observations do not establish that inference is ready.
- Storage actions name their actual target. A previously queued action for one
  drive is not represented as the current warning for another drive. New disk
  event descriptions use the actual mount instead of hardcoding `C:\`.
- A single action controller owns the action card. Requests show working,
  completed, failed or unavailable feedback. Duplicate clicks cannot send a
  competing request; failed actions remain available for explicit retry. Old
  Dashboard or queue responses cannot resurrect a consumed action or erase a
  newer completion receipt.
- Late requests cannot navigate or repopulate private Dashboard data after lock.
  Successful PIN authentication emits the existing unlock event so views can
  resume checking their state.

## Presentation and preservation

`frontend/dashboard-workspace.css` owns the Dashboard presentation. Superseded
Dashboard rules were removed from the older style layers. Existing theme tokens,
local outline icons and system fonts provide coordinated colors without adding
external assets or dependencies. All 22 theme choices remain available.

Existing panel IDs, controllers, endpoint URLs, SSE contracts, encrypted stores
and saved configuration formats remain. The command-center response only adds
the existing probe-error fact. Server Narrator suppression, warning duration,
severity priority and confirmation timing remain unchanged. Historical events
are not rewritten to repair old descriptions.

No live TLI restart, model switch, real inference, household scan, device action
or data migration was performed. Physical phones and native-platform acceptance
remain separate from the isolated browser results.

## Verification records

The pre-change source snapshot is
`build_work/dashboard-rebuild/release-snapshot-g7uujzap/source`, with fingerprint
`13f881d51ba191aa5ee282e80398d59de1ff4bd68bd1e64edb2ca0ae0bb49d42`.
It preserves the intended uncommitted source through the existing allowlist;
runtime data and credentials are excluded.

The frozen frontend baseline passed 459 tests. The relevant frozen backend
baseline passed 22 tests. Isolated before-state browser checks recorded the
status contradictions, low-contrast action controls, enlarged-text button
overflow, silent dismissal failures and navigation after a late locked response.
Those observations are recorded separately from the final acceptance results.

The complete final suites passed **487 frontend tests and 1,196 backend tests**.
The initial backend integration run found one assertion still expecting the old
“Storage Visualizer” name. The assertion now expects “Free Space for review”; the
complete backend rerun passed. Existing deprecation warnings remain in its log.

Final allowlisted source: `release-snapshot-kv678z5e`, 470 files, fingerprint
`50035eb0ba4c1654605adabee6c711769e856bfb5b69f752e5cd9a9c67cd5642`.

See [Dashboard browser acceptance](TLI_DASHBOARD_BROWSER_ACCEPTANCE.md) for the
final source identity, test totals, theme and viewport matrix, interaction checks
and before/after screenshots. Machine-readable reports and full suite logs live
under `build_work/dashboard-rebuild/`.
