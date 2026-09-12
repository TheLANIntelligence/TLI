# Classic and Modern TLI interfaces

The anniversary interface and an adaptation of TLI’s earlier interface are now
separate, selectable presentations of the same application. This corrects the
earlier implementation, which provided a Classic color palette but did not
restore the earlier layout.

## Choosing an interface

- Use **View → Classic UI / Modern UI** in the main header.
- Or open **Settings → General → Appearance → Choose your TLI interface**.
- Modern remains the default. The new browser preference is
  `tli_interface_style`; accepted values are `modern` and `classic`.
- Color themes remain independent. The existing `classicTli` identifier is
  preserved and now displayed as **Classic Mint** to distinguish the palette
  from the full Classic interface.
- If browser storage is unavailable, the layout applies for the current page
  and the interface status explains that it might not survive reloading.

## What changes

| Area | Modern | Classic |
|---|---|---|
| Navigation | Grouped, collapsible labeled sidebar | Compact icon-and-label rail with every group open |
| Workspaces | Spacious page headings and focused panels | Smaller headings, raised cards, wider multi-column workspaces |
| AI Chat | Open response layout, welcome starters, integrated composer | Bounded message well, speech bubbles, row composer, separate starter and recent-chat cards |
| Settings | Category navigation and one category at a time | Long-form sections with category jumps and information at the side |
| Dashboard | Prominent attention area and differentiated columns | Compact observed-health cards and balanced work columns |
| Files, Free Space, Vault and specialist tools | Anniversary workspaces | Current workflows adapted to the early card layout and density |
| Phone-sized browser | Current accessible navigation and controls | Responsive Classic cards with the same reachable destinations and controls |

The historical reference is the earliest retained Git snapshot:
`ff6c4e51a2b8476b1100a89fd964a4413b248afa`, labeled `v1.3.5-beta`, dated
May 3, 2026. Its recorded source hashes and synthetic screenshots were checked
against `frontend/history/provenance.json`. This is the earliest retained
reference, not a claim about TLI’s first day.

The live Classic interface reconstructs that composition around current
features. It does not run the old application, restore old defects, or remove
features added since then. The read-only **TLI through the years** exhibit stays
available separately.

## Preservation

The switch changes layout without reloading or navigating. Existing nodes and
their feature controllers are retained. Settings containers and Chat starter
controls are moved rather than cloned or recreated. Current panel, drafts,
selected files, text selection, scroll position and in-progress Chat belong to
the same application before and after switching.

No backend endpoints, SSE contracts, models, encrypted stores, account ownership
or native Companion code change in this checkpoint. It does not restart live
TLI, change its AI selection, run an action or migrate saved records. Session
locking continues to use the current controllers; changing layout cannot unlock
TLI or recover cleared private drafts.

The obsolete hidden “Classic vs Dashboard” selector was removed. It previously
changed the landing panel rather than the interface, and wrote a misleading
legacy preference on startup. Existing startup behavior still opens Dashboard
unless an explicit deep link applies; old browser preferences are not erased.

## Verification record

The source baseline was frozen before production edits:
`59a4735c0217cd652aec591e0dbb981d30a7819be3680cbcf0243990fe556875`, 719 files,
under `build_work/classic-interface/baseline/release-snapshot-1oe5xg25`.
The fresh baseline frontend suite passed **973/973** tests.

The visible-navigation audit also found a pre-existing defect: Troubleshooting
was in the shared navigation catalogue but missing from the original sidebar
markup, so the sidebar builder skipped it. The builder now creates missing
catalogue buttons, using the existing navigation handler in both interfaces.

A second pre-existing defect appeared at 320 pixels: the More drawer had a
maximum height but no scrolling, leaving its lower destinations beyond the
viewport. The shared drawer now scrolls in both interfaces. Its drag-to-close
gesture belongs to the handle, so ordinary menu scrolling does not dismiss it.
The frozen baseline reproduction is retained separately from the corrected
browser results.

The final 723-file source is
`6e158d670e10d9ecefaf5c4dea7e313fe037a0e97a14369e06bda0a1999daf6f`, frozen at
`build_work/classic-interface/final/release-snapshot-zg7vu_dp` and verified against
the working tree. Its complete frontend suite passes **986/986** tests,
including 13 interface-controller regressions.

The matched browser run passes **36 checks and 664 layout observations**, with
**93 screenshots**. Every one of the 19 panel destinations is reached through
visible navigation in both interfaces at desktop, tablet and 390/320-pixel
widths. Notes & fixes is additionally exercised through its existing dialog.
All **23 palettes** receive narrow-layout checks on Dashboard, Chat and Settings;
Emerald Light and Midnight receive detailed full-panel and enlarged-text review.
The **161 computed contrast scopes** report zero failures and zero unresolved
review items. This is scoped browser verification, not an accessibility
certification.

Behavior checks prove that selected files, unsaved Chat/Builder/note drafts,
field values, node identity, text selection, focus and a controlled in-progress
stream survive interface changes. No switch requests, automatic retries or
actions are observed. Persistence, unavailable storage, invalid preferences,
restored navigation groups, keyboard operation, session lock, More scrolling,
drag-to-close and Escape behavior are exercised. The final report records no
browser errors, unexpected actions or source drift.

Backend and native Companion source are byte-for-byte identical to the frozen
baseline. Their full suites were not rerun for this browser-only change; the
previous checkpoint’s 27-gate results retain their original source identity.
No model benchmark, native build or physical acceptance is claimed here.

- [Before, Modern and Classic review - local evidence](LOCAL_EVIDENCE.md)
- [Matched browser report - local evidence](LOCAL_EVIDENCE.md)
- [Full frontend log - local evidence](LOCAL_EVIDENCE.md)
- [Source and artifact manifest - local evidence](LOCAL_EVIDENCE.md)
- [Historical and visual assessment - local evidence](LOCAL_EVIDENCE.md)

Browser fixtures use intercepted synthetic responses and controlled streams;
they do not connect to live household data, devices or inference. Physical-phone,
screen-reader and native-platform acceptance remain **not run** for this
checkpoint. Earlier failures and intermediate candidates remain retained beside
the final results.
