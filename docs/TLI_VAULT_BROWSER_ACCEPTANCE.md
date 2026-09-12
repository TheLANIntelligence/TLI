# Vault browser acceptance

This record accompanies the Vault rebuild. It describes browser verification, separately from the backend persistence and encryption checks. All browser services are intercepted synthetic fixtures; the harness never starts live TLI or accesses household files, devices, credentials or models.

## Frozen baseline

- Source: `build_work/vault-rebuild/release-snapshot-7gxfd2vz/source`.
- Source fingerprint: `8f081ab67767fd146085627537b90ab7bef80e5bdf1b82be8e7d3c8fff827834` (462 files).
- Matching baseline screenshots and report: `build_work/vault-rebuild/before-2026-09-07T22-36-08-229Z/`. The earlier first capture is retained at `before-2026-09-07T22-12-32-443Z/`.
- Captured 48 lifecycle state views and 74 layout records at 1440, 1024, 390 and 320 pixels in Emerald Light and Midnight.
- No JavaScript page errors occurred in that baseline.
- Baseline failures: the 320-pixel notes view overflowed at 200% text size in both themes. Existing danger buttons had 1.45:1 text contrast on white; active tabs were 3.26:1 in Emerald Light; secret names were 4.19:1 in Midnight.

## Reusable verification

Run from the repository with Playwright available to Node:

```powershell
node scripts/verify_vault_workspace_browser.cjs
```

The script loads the complete real SPA and its real Vault controller at an intercepted test origin. All non-Vault operations remain blocked. It checks:

- Setup required, locked, failed passphrase, active lockout, unavailable and unlocked states.
- Files, secrets and notes across desktop, tablet and 390/320-pixel browser layouts; 200% text at 320 pixels.
- Every selectable theme against all three content tabs, including measured solid-color text contrast.
- Arrow, Home and End tab navigation.
- Local search/sort and a 501-file synthetic collection, including long and markup-like names.
- Duplicate unlock, upload, deletion and note-save requests.
- Failed deletion and failed collection refresh retaining prior results.
- Failed upload retaining the selected file and explicit retry.
- Rejected secret save/delete results retaining the draft or saved row, with an always-visible operation result.
- Failed note save retaining its title/body, successful save establishing its actual saved identifier, and cancellation of an existing-title collision.
- Session lock and authentication rejection clearing private DOM values and metadata, including a delayed note response arriving after lock.
- Immediate private-content clearing during a lock request and truthful handling of a server lock failure.
- Command-palette locking through the same Vault controller.
- A visible-access recheck preserving an unsaved note without reloading private collections; an expired owner unlock clearing the view.
- No unintended non-Vault mutation requests and no private fixture values persisted in browser storage.

Before/after images are collected in `build_work/vault-rebuild/review.html`. Each completed run writes its frontend source hashes and records whether a source file changed during capture. Source changes require another final run.

## Current result

Passed on 2026-09-07. Final report and images: `build_work/vault-rebuild/after-2026-09-07T22-38-09-971Z/`.

- 48 lifecycle state views.
- 207 layout records, including all 22 themes and 200% text at 320 pixels.
- 156 solid-background contrast checks with no failing text pairs.
- 24 visible-field label checks with no missing labels.
- 15 controller behavior groups passed.
- Zero JavaScript page errors, unexpected Vault operations, non-Vault mutations, duplicate IDs or horizontal control overflow.
- Frontend source hashes matched at the beginning and end of capture. Each exact file hash is recorded in `report.json`.

The new secret-save browser case demonstrated an integration defect: the controller wrote operation feedback to `vault-secret-status`, but the corresponding element was absent. An always-visible status paragraph now exists outside the Add secret disclosure; the final run verifies failed secret saves/deletes are visible and preserve input/data.

Regular file fixtures use the backend's normalized stored names and IDs. The oversized collection and markup-like names are deliberate frontend robustness inputs, not claims that the backend preserves original filenames. Full-height notes screenshots use the same 1440/390-pixel widths with a taller viewport so the complete editor and actions can be inspected.

Separate repository checks also passed: 459 frontend tests (`build_work/vault-rebuild/full-frontend-final.log`) and 1,195 backend tests (`build_work/vault-rebuild/full-backend-final.log`). These counts are separate from the browser matrix above.

## Limits

This is browser fixture acceptance. Physical phones, operating-system text scaling, a screen reader, real file downloads and real network interruptions have not been validated by this harness. Computed contrast covers solid backgrounds; gradients, opacity and filters are reported for separate visual review. No cryptographic assurance is inferred from screenshots or intercepted API responses.
