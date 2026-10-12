# Guided desktop update validation

Validated locally on October 11, 2026 (America/New_York). This is an application
source change, not a published release or an update of the running installation.

The supported workflow checks the platform release catalog, stages a checksum
verified complete package, and opens its folder on the host owner's request.
The local updater requires TLI to be stopped and an explicit destination
confirmation. It backs up replaced application files, preserves private state,
and supports rollback. The normal launcher prepares dependencies afterward;
download completion never changes the running version or claims restart success.

## Results

- 220 focused backend, installer, packaging, launcher, security-boundary and
  startup tests passed. Output: `build_work/self-update/backend-tests.txt`.
- 52 focused frontend update, preference, host lifecycle and release-identity
  checks passed. Output: `build_work/self-update/focused-frontend.txt`.
- 14 real-browser checks passed at 1440px and 390px with zero page errors. All
  network and host actions were intercepted; no live updater, quit, restart or
  file-manager action ran. Harness: `scripts/verify_update_browser.cjs`; report
  and screenshots: `build_work/updates/browser/`.
- An actual 439-file source ZIP was built, verified, extracted, installed into
  a disposable older folder, and rolled back. The real process guard was used.
  Data, Vault, identity, update settings, models, Python environment, legacy
  device/model settings, private memory and unknown-file canaries were unchanged.
  Every application hash was verified, and rollback restored every original
  canary and removed newly installed files. Exact archive checksum and scope:
  `build_work/self-update/package-rehearsal.json`. Optional native launcher and
  inference binaries were omitted from this source-package rehearsal.

The complete frontend suite on bundled Node 24 reported 1,549 passes and nine
failures. All nine are existing `node-trust.test.cjs` VM fixtures missing
`AbortController`; the same failures reproduce against the pre-change snapshot
at `build_work/self-update/baseline/release-snapshot-0icraoyn/source`.
The system Node 20 additionally lacks `node:sqlite`, which the website test
requires; bundled Node 24 runs that test successfully. These unrelated fixtures
were not changed by the updater work.

## Release boundary

No version bump, public package replacement, release-catalog edit or website
deployment was performed. Publish a new, higher-version package containing the
inventory and updater before advertising `updater: guided-v1` in the platform
catalog. Existing published ZIPs are not retroactively update-capable.

Native macOS execution and real dependency installation remain platform release
checks. Application rollback does not roll back dependency changes or later
saved-data changes. An interrupted update requires recovery; the startup guard
becomes available during the first upgrade after its updater and main files are
installed. Instructions therefore require keeping TLI closed until completion.

User and publisher steps are in [TLI_UPDATES.md](TLI_UPDATES.md).

## Automatic discovery follow-up

The host now checks after startup and every six hours while running, enabled by
default and respecting saved opt-outs. The scheduler starts/stops with the host;
saved preference changes wake it. Manual checks share its timing, and late
background responses cannot replace an active download or a changed preference.
Offline automatic checks retain known availability and show their error only in
Settings. In-app banner dismissal is specific to the release for the page
session, so a newer release can prompt again. Checks never download or install.

Validation: 139 focused backend/update/startup/security tests and 56 focused
frontend/update/preferences/lifecycle tests passed. Results are in
`build_work/self-update/automatic-backend-tests.txt` and
`build_work/self-update/automatic-frontend-tests.txt`. No publication or release
metadata changes were made for this follow-up.

## HTTPS download recovery follow-up

The reported v1.4.1-beta Windows download of v1.4.3-beta failed with
`CERTIFICATE_VERIFY_FAILED`. The exact issuer error was cropped in the photo;
the affected Dell's certificate store was not inspected. The release catalog
and GitHub asset redirect both worked on the development PC, so the affected
machine's exact cause has not been reproduced.

The shared release-check/download transport now adds certifi's Mozilla root
bundle to Python's default trust store. It preserves platform/administrator
roots, hostname and certificate checks, secure SSL defaults and HTTPS-only
redirects. certifi is a direct, versioned dependency; the existing launcher's
dependency check detects missing or older copies before startup. Certificate
failures retain their diagnostic detail and explain the browser-download route.
Settings and the banner offer the fixed official releases link on errors;
automatic-check failures remain nonintrusive.

Validation:

- 122 focused backend updater, TLS, installer and packaging tests passed,
  including real loopback handshakes for missing system roots, preserved system
  roots, untrusted issuers, wrong hostnames, expiry and redirect checks.
  Output: `build_work/self-update/tls-backend-tests.txt`.
- 49 focused frontend tests and 14 intercepted real-browser checks passed.
  Error recovery was visually checked at 1440px and 390px. Outputs:
  `build_work/self-update/tls-frontend-tests.txt` and
  `build_work/updates/browser/`.
- The actual public v1.4.3-beta Windows ZIP was downloaded with the updated
  transport into a disposable v1.4.1-beta installation. Its published SHA-256
  matched, all 475 inventoried files were verified, and the updater reached
  `ready` while original application/data/model canaries stayed unchanged.
  Report: `build_work/self-update/tls-download-rehearsal.json`.
- A metadata-only dependency rehearsal rejected missing/2025 certifi and
  accepted the declared minimum (2026.1.4) and a newer version. No dependency
  installation or system trust-store change was performed.

These source changes are not included in the already published v1.4.3-beta
archive. No new release, replacement package, website deployment, running-host
restart or change on the affected Dell was performed for this follow-up.
Existing clients blocked on TLS can use the browser-download/local-updater
instructions in [TLI_UPDATES.md](TLI_UPDATES.md).
