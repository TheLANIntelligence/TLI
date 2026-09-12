# Theme library refresh — verification record

This checkpoint refreshes TLI's existing themes and adds six choices. The application layout, saved data, model selection and public version remain outside this theme change.

## Preserved baseline

The intended working-tree source, including uncommitted anniversary work, was copied with `scripts/release_snapshot.py` before theme edits. The snapshot policy excludes runtime data, credentials, models and development environments.

- Source: `build_work/theme-refresh/release-snapshot-vp8u88fu/source`
- Manifest: `build_work/theme-refresh/release-snapshot-vp8u88fu/manifest.json`
- Fingerprint: `a42eff0a7be054a8ab577b8406e7a4f927ed2de85c6f7d39b3f691697cc8514a`
- Recorded files: 453

Checks ran against that frozen source:

| Baseline check | Result |
| --- | --- |
| Complete frontend suite | 422 passed; no failures |
| Existing selectable themes | 16 |
| Browser layouts | 352 checked; no horizontal control overflow |
| Simulated 200% text enlargement | 80 flows checked; no horizontal control overflow |
| Measured text contrast | No failures in the representative views |
| Browser errors or actual settings writes during palette inspection | None |
| Source fingerprint during browser checks | Unchanged |

Frontend log: `build_work/theme-refresh/baseline-frontend.log`.

Browser record: `build_work/anniversary-ui/theme-refresh-baseline-2026-09-07T21-31-49-976Z/themes-report.json`.

## Verified candidate

The 16 existing identifiers remain available, with six additions: Porcelain, Pacific, Copper, Rose Quartz, Arctic and Graphite. The browser gallery and native picker read the same catalog. Theme selection remains a preference of the current browser.

The final browser run used `scripts/verify_theme_library_browser.cjs`, which reuses the existing full-SPA fixture and contrast helpers. All 93 frontend source hashes matched between the beginning and end of verification.

After that matrix, only the standalone `frontend/manual.html` received a production follow-up: legacy badge and accent-button colors were connected to the same semantic theme tokens. The SPA files remain identical to the full matrix. A focused check then covered the final manual across all 22 themes: 132 badges and 946 numbered-step pseudo-elements passed, with no text-contrast failures, unresolved review items, JavaScript errors or storage writes. That check's source also remained unchanged. The full frontend suite passed again with 434 tests after this correction.

Focused manual record: `build_work/theme-refresh/manual-contrast-2026-09-07T21-56-02-710Z/report.json`; reusable check: `scripts/verify_manual_themes_browser.cjs`.

| Final check | Result |
| --- | --- |
| Complete frontend suite | 434 passed |
| Catalog, gallery and picker | All 22 themes available; six marked New |
| All 17 panels at 320 and 1440 CSS pixels | 748 layouts; no horizontal control overflow |
| Chat, Settings, Dashboard, Utilities and Hub contrast | 110 views; no measured failures or unresolved contrast review items |
| Simulated 200% text enlargement | 110 flows; no horizontal control overflow |
| Native control tone and body dark-mode classification | 44 checks passed |
| Unselected preview colors versus the applied palette | 44 checks passed |
| Keyboard theme choice, exactly one save and reload | All 22 themes passed |
| Other preferences, including an unknown future preference | Preserved during all selections |
| Choosing the already active card | No additional preference write |
| All, Light, Dark and New filters | Correct counts, keyboard operation and no saves |
| Manual tone | Matches each of the 22 saved themes |
| Rendering aliases | `cloud` → `cloudLight`; `emeraldDark` → `midnight`; saved values preserved |
| Unknown saved theme | Renders Emerald Light without rewriting the saved value |
| Failed browser storage write | Previous appearance and selection retained; failure feedback shown |
| Empty catalog | Native picker remains usable |
| Catalog script unavailable | Native Midnight selection applies dark tone, saves once and survives reload |
| Browser errors or operation requests | None |

Final matrix record and screenshots: `build_work/anniversary-ui/theme-library-verified-2026-09-07T21-49-07-733Z/theme-library-report.json`.

Fresh delivery screenshots: `build_work/anniversary-ui/theme-library-delivery-2026-09-07T21-51-13-378Z/`. These use newly timestamped synthetic observations; no live readings were accessed. Their frontend source hashes also remained unchanged.

Visual review: `build_work/theme-refresh/review.html`. Desktop galleries in Porcelain and Midnight, narrow galleries in Porcelain and Pacific, and enlarged-text samples were inspected. The gallery retains readable controls without horizontal clipping.

Additional targeted checks cover rendered semantic colors and reduced-motion toast visibility in existing feature panels. Candidate testing corrected a marginal New-badge contrast pair, invisible reduced-motion toast inheritance, and the missing-catalog selection fallback before final verification. These were candidate findings; the preserved baseline had no test failures.

The final source snapshot identity is recorded separately under `build_work/theme-refresh/final-source.json`, after completion of this record, to avoid putting a snapshot's own fingerprint inside its inputs.

## Limits

The browser harness serves the full SPA with synthetic intercepted responses. It does not connect to live TLI or download or run AI models. Text enlargement simulates doubled computed text sizes; it is not a physical-device accessibility acceptance test. Computed contrast checks cover solid foreground/background combinations; any gradients or opacity that prevent a dependable calculation are recorded for visual review.

Physical phones, native Companion, screen readers and operating-system high-contrast modes are not verified by this checkpoint.
