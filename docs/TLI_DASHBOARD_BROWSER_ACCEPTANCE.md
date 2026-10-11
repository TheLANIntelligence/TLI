# Dashboard workspace acceptance

The Dashboard refresh preserves TLI's existing controllers, endpoints, encrypted stores and Narrator timing. This record distinguishes browser fixture acceptance from real hardware acceptance.

## Isolation

`scripts/verify_dashboard_workspace_browser.cjs` loads the complete browser application in headless Microsoft Edge. Every request is intercepted at `tli-ui.test`. Host health, runtime readiness, registered devices, activity, saved places and action receipts are synthetic. Unexpected requests cannot reach the network. The fixture does not start TLI, restart the live application, launch inference or touch household files and devices.

Run with the existing Node/Playwright development environment:

```powershell
node scripts/verify_dashboard_workspace_browser.cjs
```

Use `--source <snapshot>/source --before` for baseline acceptance, `--visuals-only` for layout review and `--behaviors-only` for interactions. The report fingerprints all frontend source files before and after verification; a changing source requires a new run.

## Frozen baseline

- Source: `build_work/dashboard-rebuild/release-snapshot-g7uujzap/source`
- Release source fingerprint: `13f881d51ba191aa5ee282e80398d59de1ff4bd68bd1e64edb2ca0ae0bb49d42`
- Visual evidence: `build_work/dashboard-rebuild/before-2026-09-07T23-01-16-620Z/report.json`
- 48 state views at 1440, 1024, 390 and 320 pixels in Emerald Light and Midnight; all 22 selectable themes; 94 layout checks.
- No browser JavaScript errors or uncontrolled mutations.
- Two demonstrated baseline overflow findings: the action's **Not now** button at 320 pixels with doubled text, in both detailed themes.
- 58 contrast findings across repeated views: low-contrast secondary action text and storage-warning chips, plus Emerald Light/Sand Light primary action text.
- Interaction record: `build_work/dashboard-rebuild/before-2026-09-07T23-05-55-092Z/report.json`. Nine of twelve passed. A failed dismissal lacked feedback, an action response arriving after TLI locked could still navigate to Free Space, and two dispatched confirmation events could send competing requests.

## Candidate acceptance

**Passed, 7 September 2026.**

- Accepted source snapshot: `build_work/dashboard-rebuild/release-snapshot-kv678z5e/source` (470 source files).
- Source fingerprint: `50035eb0ba4c1654605adabee6c711769e856bfb5b69f752e5cd9a9c67cd5642`.
- Browser report: `build_work/dashboard-rebuild/after-2026-09-07T23-21-12-127Z/report.json`.
- Frontend hash-map fingerprint: `88a50bcf322a6335c127b113d777269a5ef184bcde6a5a665cc1e7af221d5cce` (SHA-256 of the report's ordered frontend hash map).
- Browser: Microsoft Edge / Chromium `152.0.4191.66`, reduced motion enabled.
- **56 state views, all 22 selectable themes, 104 layout checks and 22 behavioral scenarios passed.** No horizontal control overflow, computed text-contrast failures, browser JavaScript errors or unintended mutations were observed.
- Frontend source fingerprints were identical at the start and end of the complete pass.
- The integrated repository suites passed **487 frontend tests** and **1,196 backend tests**, recorded separately by the main implementation verification.

The baseline findings above remain separate from the candidate result. Intermediate `after-*` reports are diagnostic records; runs marked `sourceUnchanged: false` are not accepted candidates.

The [comparison gallery](../build_work/dashboard-rebuild/review.html) switches between before/after healthy, critical, stale, unknown and failed-refresh states on desktop and phone fixtures, in Emerald Light and Midnight. Its images were checked in the browser after generation. The [compact desktop preview](../build_work/dashboard-rebuild/after-2026-09-07T23-21-12-127Z/critical-viewport-1440-emeraldLight.png) is 1440×1000; full-workspace desktop images and the [320-pixel enlarged-text view](../build_work/dashboard-rebuild/after-2026-09-07T23-21-12-127Z/text200-320-emeraldLight.png) are retained alongside the report.

## Required browser coverage

- Healthy, critically full disk, stale, missing monitoring, empty activity/devices and unavailable refresh states.
- Action progress, success, failure, explicit retry and failed dismissal.
- Partial completion and failed secondary actions keep their failure receipts and do not claim success.
- Single mutation despite competing confirmation requests.
- An older command-center response cannot resurrect a dismissed action. A legacy health fallback does not silently clear it.
- Activity refresh preserves previous results on failure. Opening history does not mark it reviewed; review is explicit and duplicate requests are coalesced.
- New activity offers a refresh without replacing or acknowledging the reviewed snapshot.
- TLI lock clears activity and pending actions; delayed responses cannot repopulate private state or navigate.
- The real PIN UI locks and unlocks against a synthetic authentication response; confirmed unlock resumes Dashboard observations.
- Saved places opens through its existing private dialog; Escape closes it and restores focus without action execution.
- All selectable themes, 1440/1024/390/320-pixel layouts, 200% text simulation, reduced motion and computed text contrast.
- More shortcuts is expanded for the theme checks. Large retained history (120 rows) and long paths exercise wrapping and bounded scrolling.

## Limits

Physical phones, native desktop platforms, operating-system text enlargement and assistive technology are not run by this fixture. Contrast measurements cover solid backgrounds; gradients or filters are separately listed for visual inspection. No claim is made that synthetic provider readiness proves a real model is useful or available.
