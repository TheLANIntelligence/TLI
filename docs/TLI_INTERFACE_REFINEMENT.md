# Anniversary interface: a cohesive home console

Implemented September 7, 2026 in the existing working tree. TLI remains the
same private home console, with the vanilla JavaScript controllers and existing
panel IDs, endpoints, SSE events and data formats. This is a browser interface
checkpoint; it does not publish a release or replace a running installation.

## Shared shell and presentation

`ui-foundation.js` supplies a single navigation catalog, local outline icons,
page introductions and accessible overlay behavior. Existing control nodes and
feature controllers retain their listeners. Desktop groups reveal the active
page; phone navigation offers Dashboard, AI Chat, Files and a grouped More menu.
Search, Activity and Settings remain accessible. Previous destination names
remain searchable aliases.

`ui-foundation.css` defines reusable surfaces, controls, focus rings, page headers,
disclosures, dialogs and result presentation. Emerald Light uses neutral surfaces
with emerald accents; Midnight has a coordinated dark treatment. All existing
theme identifiers remain selectable. Contrast adjustments preserve their hues.
System fonts and local assets require no external design dependency.

The subsequent [theme refresh](TLI_THEME_REFRESH_ACCEPTANCE.md) consolidates all
palette definitions in `themes.css`, with explicit metadata in `theme-catalog.js`.
All 16 original choices remain; six new palettes and a visual Settings gallery
extend this foundation without changing feature controllers.

The header identifies the **TLI host**. A selected computer or a folder, drive,
printer or device still has its own target control; the host label does not
retarget tools. Native dialogs, custom overlays and the phone drawer have focus
containment, Escape handling where dismissal is permitted, and focus return.
Closed overlays are removed from the tab order. Closing a view is not described
as cancellation of server work.

## Dashboard, Chat and saved work

- Dashboard prioritizes the Narrator, observed readings, suggestions, favorites
  and activity catch-up. The full activity feed remains in a disclosure. Existing
  warning timing, confirmation visibility and explicit activity review remain
  owned by the existing Narrator policy.
- System observation age uses the successful probe timestamp and becomes stale
  after 30 seconds, including while another request is pending. Missing values
  remain unknown. The old combined readiness score is not presented as measured
  system health: AI readiness and Vault setup cannot prove system health.
- Chat retains its composer, explicit context, memory choice, working indicator
  and streaming owner. A separate escaped renderer handles code, links, lists
  and semantic, horizontally scrollable answer tables. Rendering is tested
  independently of streamed transport.
- **Saved notes** opens the existing Notebook: private setup details, preferences
  and past fixes. It is distinct from Vault notes, conversation history and the
  current message's explicitly included context.
- Ctrl+K retrieves private notes, conversations and favorites only after the
  user types a search. Requests and displayed results are bounded; changing the
  query, closing search or locking the session clears pending/private results.
  Opening a result resumes its existing view. It does not send, attach or execute.
- Model cards keep installation, selection, compatibility and confirmed running
  states visible. Filenames, quantization and resource calculations sit under
  Technical details. Model lifecycle behavior is unchanged.
- Header and Chat AI status share one display owner. Concurrent status reads are
  bounded and serialized; missing, stale and denied checks cannot claim Ready or
  a missing download. Existing local/LAN source choices and actual-answer source
  reporting remain separate from those availability observations.

## Files, Free Space, Vault and backups

- Free Space presents drives, scan status and largest results before optional
  Map, filters, saved comparisons and advanced searches. Keyboard-accessible
  lists and folder controls provide an alternative to the map. Cleanup stays
  in a compact review disclosure with the existing review/execute boundary.
- Files follows Choose folder, Prepare changes, Review, Results. Replacement
  scans keep the prior file list, tree, preview metadata and original expiry
  until all replacement responses validate. Path edits do not rewrite a prior
  operation receipt. Failed replacements and partial outcomes stay visible.
- Vault distinguishes not set up, locked, unlocked and unavailable. A failed
  status request cannot masquerade as an empty or uninitialized Vault. Files,
  secrets and notes retain existing ownership and encryption behavior.
- Backups retain Check saved data, Create backup and Verify backup. Verification
  checks an isolated archive copy; no Restore button or live restore is added.
- Printer selection is awaited before Print & Scan opens its selected target.
  A selection does not print, and job submission does not claim physical output.

## Computers, devices and specialist tools

- Computers uses stable identity rather than friendly names to distinguish
  peers. The backend health roster no longer hides different identities sharing
  a name or address. Missing readings/capabilities remain unknown; failed refresh
  preserves prior observations and their time.
- Smart-device operation is separate from Add device and connection details.
  Existing IDs, explicit relays, ambiguity resolution and action guards remain.
- Automations explains When and Then, preserves failed-load/save drafts and
  reports actual results. Failed loads do not look like an empty collection.
- LAN Messages keeps conversations and transfers primary, with cross-network
  configuration in a secondary disclosure and accurate connection wording.
- Utilities supplies labeled fields for built-in tools, advanced arguments for
  custom tools, measured output first and an explicit AI explanation action.
- Game Optimizer retains prior advice, provides Stop and labels interrupted
  output. Scripts distinguishes generating text from running it or making a
  backup. Builder keeps project/task/diff/rollback controls; opening it reads
  status without automatically warming inference.
- Hub labels actual installation/application/publication effects and checks
  failed responses. Installing a theme and applying it remain separate actions.
- Settings, onboarding, lock screens, About and the standalone guide use the
  shared appearance and updated destination/capability wording.

## Preservation and verification

The pre-edit snapshot is
`build_work/anniversary-ui/release-snapshot-s68b3uxw`, fingerprint
`91c2730e7e7259a913350e283cbda9a4aa6df85511d899d382bf8861144ba1ad`.
It includes the intended uncommitted source, using the existing allowlist to
exclude private runtime data and generated artifacts. No reset, stash or commit
was needed. Original source IDs are checked against this snapshot; pre-existing
runtime replacements of welcome/loading/empty placeholders are documented in
the browser report.

Baseline: **360 frontend tests and 1,148 backend tests passed**. The corrected
whole-shell baseline fixtures record four existing responsive overflows and an
automatic Builder warm request on opening the page. These are separate from
new failures, and have been corrected in this checkpoint.

Final integrated checks all pass:

| Check | Passed coverage |
| --- | --- |
| Backend regression suite | 1,149 tests; existing dependency warnings remain |
| Frontend regression suite | 422 tests |
| Complete shell | 170 panel/viewport/theme views |
| Dialogs, onboarding, lock and help | 72 views with keyboard focus checks |
| Storage workflows | 18 views including retained failures and explicit review |
| Large storage results | 12 views using 500 files and nested long paths |
| Computers, devices and specialist tools | 152 views/interactions |
| All selectable themes | 16 themes, 352 layouts and 80 expanded 200% text checks |
| Search, Chat, Settings and observation status | 26 integrated behavior cases |
| Header/Chat AI agreement | Healthy and unknown provider cases |

Final browser reports contain no unexpected action/inference requests, horizontal
overflow, duplicate IDs, missing original static controls or JavaScript errors.
Measured text/control contrast pairs pass; this is not a complete accessibility
certification. Final source hashes are recorded and were rechecked after testing.
The pre-existing source-extraction Narrator test was updated to supply its new
presentation helper; its original failure-message assertion remains, with an
additional observation-state assertion.

Automated logs, before/after screenshots, exact source hashes and the final
coverage index are under `build_work/anniversary-ui/verification.json`.
Browser fixtures load the actual shell and controllers, intercept all requests,
and use synthetic names, paths, providers, devices and conversations. They cover
1440/1024/768/390/320-pixel layouts, all 16 selectable themes, expanded controls
at 200% text sizing, reduced motion and keyboard interaction. Specialized flows
exercise search, streaming, retained previews, duplicate requests, errors,
partial results, cancellation and session lock.

The Chat and Settings verifiers retain their original strict single-panel mode.
Their explicit `--anniversary` mode instead checks preserved panel/control IDs
and behavioral gates for the now-authorized complete interface redesign; the
whole-shell verifier covers changes outside those two panels.

No automated check restarts live TLI, changes its selected model, downloads a
model or acts on household files/devices. Existing format compatibility is
covered by the isolated backend suite. Browser viewport checks are not physical
phone, native installation or screen-reader application acceptance. Real AI
answer quality, physical printing, live network conditions and real-data restores
remain outside this browser checkpoint. No data migration was introduced.
