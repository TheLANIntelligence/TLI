# Section clarity and Phone Companion

Implementation checkpoint: 2026-09-07. TLI remains the existing private home console. This batch improves current browser workflows; it does not introduce a new product, provider, integration or native app build.

## Source and baseline

Before edits, `scripts/release_snapshot.py` preserved 470 allowlisted source files, including existing uncommitted anniversary work, at `build_work/section-clarity/release-snapshot-trt31s0w/source`.

Baseline fingerprint: `50035eb0ba4c1654605adabee6c711769e856bfb5b69f752e5cd9a9c67cd5642`.

Fresh baseline: **487 frontend / 1,196 backend tests passed**. No baseline test failures. Backend deprecation warnings are recorded separately in `baseline-backend.log`; they are not regressions introduced by this UI batch. Baseline browser screenshots were captured from that frozen source, not reconstructed from the new UI.

## Implemented checkpoints

1. **Notes & fixes and terminology.** The existing Notebook has a visible purpose, unsaved Setup detail / Preference / Fix to remember starters, explicit save/discard, in-memory unfinished drafts, source distinctions, account access explanations and pre-send selected-note conflicts. Use saved notes keeps its previous default. Old names remain search aliases; internal IDs, revisions and storage stay unchanged.
2. **Phone Companion discoverability and safeguards.** One controller owns `panel-companion`. Desktop/phone navigation, Settings, Computers, onboarding and search open that page. Owner access, secure connection, explicit native QR creation and access management are separate stages. The old browser invitation is labeled Browser satellite. Opening a destination never creates either invitation.
3. **Current section workflows.** Shared purpose, target, prerequisite and expected-result guidance covers every browser destination. Concrete preservation and action-result defects were fixed in Files, printer controls, Print & Scan and Builder. Existing recent Dashboard, Chat and Vault layouts remain.
4. **Help and integration.** The manual, About, onboarding and [capability reference](TLI_CAPABILITIES.md) describe current behavior. Old unconditional privacy, model activation, platform and duplicate-name claims were corrected. Theme tokens replace leftover hardcoded colors in migrated controls.

## Section-by-section coverage

The table distinguishes changed behavior from reviewed existing behavior. A section does not need every state: for example, opening help has no partial execution state. The browser record identifies exercised layouts and scenario checks; the complete controller/backend suites supply additional state and preservation coverage.

| Section | Change or reviewed behavior | Main verification |
|---|---|---|
| Navigation / search | One purpose catalogue; Notes & fixes aliases; real Phone Companion destination; desktop/More/search alignment. | Catalogue tests, search result action tests, all-panel keyboard guide checks, navigation requests audited for mutations. |
| Dashboard | Retained current awareness, readiness, observed health and activity-review workflow; Notes & fixes and phone links in More shortcuts. | Existing dashboard timing/status/race suites; full-shell layouts and guidance checks. |
| AI Chat | Use saved notes and visible standalone-note notice; selected notes and incompatible context shown before send. Current composer/indicator retained. | Chat streaming, context, note-revision, failure, duplicate submission and lock tests. |
| Notes & fixes | Clear introduction, unsaved starters for new/returning users, origin labels, shared-owner explanation, retained drafts and explicit discard. | Actual-controller starter/Back/Close/open-other/revision/lock tests; desktop/phone notes views and all-theme controls. |
| Files | AI advice labeled as suggestions, not a reviewed plan; category and whole-folder labels corrected; failed replacement retains advice. | Advice success/failure/duplicate/late-result tests and synthetic browser interaction. |
| Free Space | Shared guidance separates scan, saved comparison and cleanup review; paths, time and incomplete coverage retained. | Existing scan/cleanup/comparison/review/undo suites; full-shell and theme layout checks. |
| Vault | Existing passphrase workspace retained; copy distinguishes Vault notes from Notes & fixes. | Existing lifecycle, unreadable-store, atomic-write and lock tests; all-panel browser review. |
| Backups | Check saved data, Create backup and Verify backup remain distinct; scope and Notes & fixes name align. | Existing archive scope, wrong-password, corrupt-input, concurrency and unchanged-data suites; Settings browser checks. |
| Computers | Native phone link, secondary Browser satellite path; reported files do not claim confirmed running AI. Failed legacy refreshes retain node/directory details and resolve as failure instead of leaking an unhandled rejection. | Stable-identity/health suites; three refresh preservation regressions; 320px header fix; native navigation and unavailable-state checks. |
| Phone Companion | Four stages; confirmed readiness, reviewed startup, complete QR/manual bundle, 5-minute expiry, hide semantics and explicit access removal. | 16 new lifecycle/pairing tests plus 17 startup tests; updated dedicated-page and Settings browser harnesses. |
| Printers & USB | Explicit button IDs replace global button-text interception; one mutation owner validates results and coalesces duplicates. | Smart-device Discover isolation, printer handler result/duplicate/lock tests and browser request assertions. |
| Print & Scan | Confirmed job submission; previous preview/download retained until replacement data is successfully retrieved. | Failed metadata/download/content replacement cases, duplicates, token cleanup and late-lock checks; browser retained-scan scenario. |
| Smart devices | Discovery label identifies Shelly scope; target/relay and reported-state purpose remain visible. | Resolver/discovery tests and proof that discovery cannot open printer settings. |
| Automations | When → Then summary, enabled state/cooldown and Recent runs remain; saving is distinct from execution. | Existing failed load/save, target preflight, step-result and receipt tests; full-shell guidance/layout. |
| LAN Messages | Recipient/connection/transfer workflow retained; optional cross-network relay wording remains separate. | Existing message/transfer preservation and deliberate-retry tests; full-shell guidance/layout. |
| Utilities | Target/parameters and measured output remain primary; public-address network checks and LM Studio model-list limitations explained. | Existing built-in field/handler/result tests; full-shell guidance/layout. |
| Scripts | Generation, review, download and execution remain distinct; backup presets draft code, not backups. | Existing script/receipt tests; source review and full-shell guidance/layout. |
| Game Optimizer | Goals are not measured FPS; retained previous advice and Stop/interrupted state preserved. | Existing game response/cancel/failure tests; full-shell guidance/layout. |
| Builder | Per-project in-memory drafts; consume only submitted text/attachment IDs; guard competing requests; fresh approval after project switch; preserve preview on failure. | 16 new controller tests including late lock/401 cleanup, 403 draft retention and project-switch races. |
| TLI Hub | Each card names its catalogue source, installation state and effect; listing is not vetting and host sharing is not public publication. | Existing Hub action-result tests; package browser views and all-theme controls. |
| Settings / onboarding / About / help | Correct categories, access scope, AI readiness, phone entry point and practical prerequisites; obsolete activation/privacy claims removed. | 19 Settings behavior tests; updated Settings browser matrix; catalogue/manual source review. |

## Verification results

- Complete final frontend suite: **552 passed** (65 more than baseline).
- Complete final backend suite: **1,196 passed**, 2,070 existing warnings; isolated temporary persistence, fake providers and no live integrations.
- Updated Settings browser harness: **6/6** desktop/390/320 × Emerald Light/Midnight cases passed, including unavailable startup endpoint and retained startup draft across navigation.
- Updated dedicated Companion browser harness passed safe label rendering, complete invitation validation, forced duplicates, access-removal review, HTTPS guidance and 390px layout.
- Final full-shell browser pass: **338 layout checks, 144 keyboard-opened section guides, all 22 selectable themes, 36 state probes and 14 workflow scenarios passed**, with no JavaScript errors or unintended operation requests. Detailed layout review used 1440, 1024, 390 and 320 pixels in Emerald Light/Midnight; enlarged text and reduced motion were included. All-theme control checks targeted Files, Print & Scan, Phone Companion, Settings, Hub and Notes & fixes.
- The 36 state probes opened all 18 panel destinations under unavailable services and empty inventories. Each records actual requests and displayed status; a static view is not claimed as a successful refresh. Controlled operation scenarios separately covered failed/partial file execution, duplicate confirmations, retained advice/scans, native pairing and session lock. Remaining timing, cancellation, malformed-result and persistence combinations are covered by controller/backend tests rather than claimed as browser scenarios.
- **49 final screenshots** and **32 baseline screenshots** are indexed in [the before/after gallery](../build_work/section-clarity/review.html). Raw final evidence: `build_work/section-clarity/after-2026-09-08T00-11-29-860Z/report.json`. Source was unchanged throughout that pass. The gallery uses baseline `before-2026-09-08T00-02-48-886Z`; all four desktop/phone × light/dark gallery combinations passed image loading, overflow and JavaScript checks.
- Final source snapshot: `build_work/section-clarity/release-snapshot-_3taprpv/source`, **477 files**, fingerprint `127cc15d5a3d1c7d1665a4d8b257075d5f09085e14f7257849f69369f1cc94ac`. The full **552 frontend tests also passed directly from this frozen source**. Runtime data, credentials and models are excluded by the existing source allowlist.

Logs and screenshots live under `build_work/section-clarity/`; the Settings harness keeps its existing output location under `build_work/anniversary-ui/`. Intermediate copy-expectation failures were corrected when renaming Notes; they were not baseline failures. Demonstrated layout fixes included the Computers action row at 320px, Files advice heading, enlarged scan controls, Companion origin selector and legacy theme colors. The unavailable-service sweep also exposed and fixed a rejected legacy Mesh refresh promise; prior node and directory details now remain with unavailable status.

## Preservation and acceptance limits

No backend endpoints, SSE event contracts, note revision formats, encrypted stores, model configuration, ownership defaults, Companion protocols or browser-satellite tokens were migrated. Existing uncommitted changes were preserved. No production installation was restarted, model switched/queried/downloaded, native app rebuilt, phone paired, household file scanned/changed or household device operated.

Browser viewport, keyboard/focus, reduced-motion and enlarged-text checks do not establish physical phone, native platform, screen-reader hardware or live-installation acceptance. Those remain separate and **not run in this batch**. Backup verification still does not restore live data or provide whole-installation/Vault recovery.
