# TLI premium experience

TLI opens on Dashboard, with its Narrator, observations, recent activity and
saved places visible. Dashboard is the first primary destination on desktop and
mobile. Ask TLI remains one click away: ordinary conversation, writing, learning,
planning and coding require no selected computer or diagnostic problem. Create,
Files, Smart home and Computers remain primary desktop destinations. More
retains Vault, games, routines, printing, phone setup and specialist tools.

In the premium dashboard, the Narrator precedes task shortcuts. Compact storage,
registered-device and AI indicators live in the header beside the existing host
menu. Selecting an indicator opens its readings and an explicit navigation action.
Storage warnings remain visible, with previous or unavailable readings labeled.
The original status cards remain available in Legacy. No new network polling is
introduced: the header uses the existing presence, identity and AI snapshots,
plus a single scheduled freshness update. Locking clears private detail values.
The Narrator, its settings, action receipts and refresh lifecycle are retained.

The sidebar has one TLI mark, colored by the chosen theme. All 23 palette IDs
remain supported, including the colored light/dark and OLED appearances. Fonts
are bundled locally (Inter 4.1; SIL Open Font License in assets/fonts), as are
the outline SVG icons. Theme changes make no network requests.

## Appearance and compatibility

Settings → General → Appearance contains the new/legacy workspace choice,
Selected theme/Follow system appearance, a quick palette picker and an All /
Light / Dark gallery. System uses Emerald Light or Midnight and remembers the
explicit palette without rewriting it when the OS changes appearance.

Modern and Classic refer to the legacy layouts, not the new experience. Legacy
shows an explicit **Legacy layout** selector and **Use new TLI** button in its
header. The button applies the new experience in place, preserving mounted work.
Opening `/?experience=premium` also explicitly activates and saves the new
experience in that browser. The parameter is consumed without losing other URL
parameters or its fragment, so it cannot override a later selection on reload.
Both entry points leave colors and the saved Modern/Classic choice intact.

- `tli_experience_v1`: `premium` (default) or `legacy`, browser-local.
- `tli_interface_style`: existing `modern`/`classic`, preserved independently.
  Premium uses the effective Modern structure without overwriting this choice.
- `tli_settings.defaultTheme`: unchanged explicit palette preference and aliases.
- `tli_settings.appearanceMode`: `theme` (default) or `system`. The existing
  Settings owner atomically saves this with the chosen palette; failed saves
  restore the earlier appearance. Unrelated settings are preserved.

Presentation switches keep the same feature controls and controller instances.
Drafts, stream ownership, selected context, focus/selection and reading anchors
remain with their owners. Old styles remain for the legacy experience; premium
shared primitives and feature styles are explicitly scoped to that experience.
There is no framework, backend API or stored application-data migration.

## Workspaces

Chat uses a readable conversation column and a stable composer. History and
recent conversations use real saved data. Context, memory, model routing and
other options are expandable. No example conversations or device states from
the design mockups are shipped as real content.

Create separates Browser apps from Repository work without rebuilding their
controllers or discarding drafts. The app brief sits beside the preview,
revision/source controls and checks. Generated previews retain their existing
opaque browser isolation and account/revision checks.
The entry screen names HTML/CSS/JavaScript and concrete examples, explains the
three-file ZIP export, and keeps experimental quality and reload-resetting app
data visible. Scope & reliability distinguishes this from native apps, persistent
data, connected services, and the existing repository workflow. These are scope
clarifications, not additional generation capabilities or new model benchmarks.

Smart home groups Shelly relays by saved room metadata and stable names. The
primary control reads status when it is stale or unknown; an acknowledged
command and a subsequently verified device state remain separate. Exact relay
identity, measurements and advanced controls stay available in Device details.
Home Assistant and routines remain accessible.

Files retains drive/folder scope, explicit scanning, review and Explorer reveal.
Computers retains trust review, device details and reported capability limits.
Secondary guidance is available in the workspace disclosure. PIN, onboarding,
Vault, Settings and specialist pages share the same palette/control foundation.

## Windows launcher

The rebuilt TLI.exe uses a single TLI wordmark and the Emerald light/dark family.
It follows Windows app appearance at launch, with SystemColors in high-contrast
mode. Native launch cannot read a browser's private localStorage, so browser
palette selection is intentionally independent. Existing verified ownership,
hidden worker, readiness, error and shutdown behavior is unchanged.

## Validation

See scripts/verify_premium_workspace_browser.cjs for real-SPA synthetic browser
coverage of navigation, all themes, local fonts, mounted draft preservation,
desktop/mobile layouts and a repeated-navigation timing proxy. Supporting
scripts cover actual chat streaming, connected workflows, theme persistence,
drive switching/Explorer reveal, and native launcher lifecycle fixtures.

Browser fixtures intercept every request: they never operate household devices,
scan user files, or use the live model. Device checks therefore establish UI and
protocol behavior, not physical relay operation. Desktop viewport simulation is
not a physical-phone or screen-reader audit. Navigation-to-animation-frame
timings are lab observations, not field INP certification.

### Acceptance run — September 29, 2026

- Frontend regression suite: 1,431 passed.
- Focused backend checks for browser lock, home controls, file reveal, packaging
  and launcher: 79 passed.
- Whole-SPA premium browser run: 86 desktop/mobile/theme layouts, including
  320px width; no horizontal overflow, duplicate IDs or browser errors.
  Repeated navigation measured 32.6ms at the 75th percentile in this fixture.
- All 23 themes: persistence, aliases, preview isolation, failed-save recovery,
  System transitions and 253 rendered text/control contrast checks passed.
- Chat stream/cancel/context/history and mounted draft/focus preservation,
  Create revisions, Shelly acknowledgement/verification, computer inspection,
  drive switching and Explorer reveal passed their synthetic browser checks.
- The rebuilt Windows launcher passed light and dark lifecycle fixtures.
- The verified installation-owned host was stopped gracefully and restarted
  through the managed launcher. Live HTTPS readiness returned `matched` release
  compatibility, the integrated model reported healthy, and the new CSS,
  JavaScript and locally bundled font assets all returned HTTP 200.

Evidence is retained under `build_work/premium-ui`,
`build_work/anniversary-ui`, `build_work/free-space-scope` and
`build_work/launcher-qa`. Offline browser fixtures blocked external traffic;
this is not a physical WAN-disconnection or physical Shelly-switch test.

### Dashboard restoration follow-up

Dashboard is again the default landing page and first desktop/mobile destination.
The Narrator and status cards appear before task shortcuts; original controllers,
settings, action receipts and activity remain intact. Explicit Chat deep links
still open Chat, and appearance changes keep the original Narrator node mounted.

The follow-up passed 52 targeted frontend tests, 22 Dashboard behavior scenarios
(including stale/offline observations, Narrator severity, lock/unlock and action
receipts), and 136 browser layouts across all 23 themes and widths down to 320px.
Repeated navigation measured 32.8ms at the 75th percentile in the synthetic run.
Evidence: `build_work/premium-ui/acceptance-2026-09-29T23-42-51-735Z` and
`build_work/dashboard-rebuild/after-2026-09-29T23-43-23-447Z`.

### Compact header follow-up

The header facts adapter reuses `TLIPresence`, `TLIAISource` and host identity.
Only the earliest pending freshness boundary schedules a local timer; there are
no additional requests. The device count is registered inventory, not an online
count. A selected LAN model is not labeled ready. A full drive stays a visible
warning even when the retained observation becomes stale. Opening Free Space
prepares the recorded mount path through the existing storage controller and
does not scan it. Detail dialogs support keyboard dismissal and clear on lock.

Validation: 1,439 frontend tests; 115 header layouts across all 23 palettes and
five widths from 1800px to 320px; 46 header/detail contrast checks; the existing
136-workspace layout run and all 22 Dashboard behavior scenarios passed. Browser
fixtures verified keyboard focus, appearance/draft retention, local freshness
expiry and zero action/scan requests. Evidence:
`build_work/header-status/2026-09-30T00-16-31-817Z`,
`build_work/premium-ui/acceptance-2026-09-30T00-16-58-734Z` and
`build_work/dashboard-rebuild/after-2026-09-30T00-16-58-766Z`.

After source changes, use a normal managed host restart and refresh existing
browser tabs so the release guard recognizes the new frontend/backend snapshot.
Never bypass the release guard or force-stop an unrelated process.

### Atmospheric identity — October 1, 2026

The approved browser mockups now use production styles in the existing shell,
Dashboard, conversation and connected-workspace stylesheets. There is no runtime
mockup overlay. `themes.css` supplies distinct navigation and focal-surface roles
for all 23 palettes: `--theme-nav-*`, `--theme-hero-*`, and `--theme-glow`.
Reading surfaces remain opaque. Semantic warning, error and device-state colors
remain independent of the selected accent; dark focal panels have dedicated
readable semantic colors. Both OLED palettes retain black canvas, sidebar and
header backgrounds without canvas lighting.

The sidebar and single TLI mark follow the palette. The Dashboard narrator is the
focal panel, followed by compact shortcuts, activity and saved places. Ask TLI
uses a larger welcome panel and raised composer while retaining quiet message
surfaces. Smart home distinguishes verified-on, verified-off and unknown states;
the existing shimmer still stops for pending updates, rename, hidden panels and
reduced motion. Name-derived fixed SVG device artwork is decoration only and
never determines capabilities or control behavior.

Create, Files, Computers, Settings, Vault, PIN entry and dialogs use the shared
surface, typography and control roles. Free Space keeps its bounded, independently
scrolling file list. The mobile chat header preserves its compact two-row layout.
Appearance previews redeclare palette roles locally so they match the interface
without inheriting the currently selected colors.

Theme IDs, aliases, Settings-owned persistence, System mode and Legacy choices
are unchanged. Styling does not reconstruct controllers or introduce API calls.
Theme changes retain mounted drafts, streams, scans and device action receipts.

Verification uses the actual local SPA with intercepted synthetic services:

- `verify_atmosphere_ui_browser.cjs`: all 23 palettes, 395 checks, 93 layouts,
  36 desktop/mobile captures, OLED black surfaces, preview isolation, original
  DOM identity, focus, device states and shimmer gates.
- `verify_premium_workspace_browser.cjs`: 136 layouts down to 320px, preserved
  Dashboard/Narrator, Legacy round trips and repeated-navigation p75 of 33.8ms
  in this run (a local lab proxy, not field INP).
- `verify_premium_contrast_browser.cjs`: 253 computed text/control checks with
  no measured failures, including PIN entry, and System appearance transitions.
  Complex gradient/pseudo-element surfaces receive separate visual review;
  these counts are not a claim of complete WCAG certification.
- `verify_storage_large_results_browser.cjs`: 500 sample files, 12 checks for
  bounded list scrolling, map selection, paging and navigation.
- `verify_chat_workspace_browser.cjs --premium`: six browser scenarios,
  including actual held SSE responses across Emerald Light, Lavender, Pacific
  and OLED changes, retaining the same reply, busy state and scroll without
  another generation request. The isolated fixture explicitly activates Chat
  and asserts composer visibility, matching production navigation.
- `verify_space_map_renewal_browser.cjs --quick`: 12 checks and 38 layouts.
  `verify_free_space_scope_browser.cjs`: seven layouts, drive switching,
  Explorer reveal availability, scan failure recovery and active scans retaining
  the same job/progress across palette changes without extra starts or cancels.

Supplemental raster checks sampled actual text-fragment backgrounds across all
palettes at 1440px, 390px and 320px, including the pseudo-element lighting.
They identified low contrast in small mobile welcome copy; that copy now uses
the full hero reading color. A real paused shimmer frame also identified low
contrast in the small Shelly badge, which now uses the full reading color while
the shimmer remains unchanged. Device metadata keeps its quieter role. The
device check changes palettes while an intercepted command is held pending,
retains the same disabled control, sends exactly one command, and waits for the
confirmed state before reporting completion.

Evidence: `build_work/atmosphere-ui/browser-2026-10-02T01-40-03-719Z`,
`build_work/premium-ui/acceptance-2026-10-02T01-39-11-224Z`, and the matching
`build_work/anniversary-ui` runs. UTC artifact timestamps fall on October 2.
All external requests were intercepted; physical WAN disconnection, physical
Shelly operation and assistive-technology certification were not performed.
