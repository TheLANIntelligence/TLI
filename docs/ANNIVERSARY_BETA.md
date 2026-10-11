# Anniversary beta: matched builds and recovery acceptance

**Companion work paused by the user on September 7, 2026.** The signing prompt
and isolated phone test host were stopped. Preserve the existing artifacts and
the unrun phone acceptance gates; resume core desktop development independently.
The results below remain a historical record, not a request for Apple sign-in.

This checkpoint prepares an isolated desktop source candidate and a separate
**TLI Companion Beta** for Android and iPhone. It does not update the owner's
running TLI, install over the current Companion, or publish an app-store release.

## Candidate identity and packaging

The snapshot includes allowlisted working-tree source, including the existing
uncommitted anniversary changes. Its manifest records each source file's SHA-256
and a canonical source fingerprint. No commit, reset or stash is required.
Generated dependencies, exports and reports remain outside the fingerprint.
Source drift requires a new verified candidate; failed attempts remain separate.

Desktop packaging excludes the full legacy `backend/ai/memory/` subtree. Tests
use synthetic names and prove directory pruning without reading original memory.
Desktop and mobile archives exclude runtime data, keys, credentials, weights,
development environments and previous artifacts. Needed runtime binaries remain.

`scripts/verify_release.py` creates a unique ignored workspace under `build_work`:
the source snapshot and manifest, desktop ZIP and SHA-256, extracted installation,
fresh dependency environment when requested, logs and `report.json`. The report
keeps source verification, native builds and physical acceptance separate.

Complete local verification:

```powershell
backend\.venv\Scripts\python.exe scripts/verify_release.py --clean-environment --with-mobile --rollback-ref a5f2104f134a0d0fe482e4b65acadd515699d2fb --node <supported-node-executable>
```

Node 22.13+ is required. `--npm-cli` can specify npm-cli.js when the selected Node
runtime does not bundle npm beside its executable. Existing requirements and the
mobile lockfile are installed into the candidate environment without changing
the live installation. Exact dependency versions are captured in the logs.

## Verification scope

The complete backend, desktop, mobile and developer-harness suites run against
the captured source. Current backend tests also run against the extracted package.
Only the packaging tests (developer packager absent from distribution) and the
single Git-dependent previous-actions-reader test are excluded from that second
run; their source-suite results are recorded separately.

Startup overrides from the invoking shell are sanitized. Test persistence is
established before imports, including the legacy relative Vault metadata path.
Discovery, updates, real device calls and model inference remain disabled.

The HTTPS rehearsal starts only owned test processes with synthetic PIN/TLS
state. It checks real authentication, a persisted bearer credential, saved ports,
restart continuity, unavailable AI, occupied-port preservation and refusal to
serve HTTP when HTTPS setup fails. Fixture checks do not certify native TLS or
physical phone behavior.

The recorded Git baseline predates Companion and is not a previous published
anniversary release. Synthetic upgrade/rollback checks distinguish old readable
formats from unsupported new features, preserve additive state, and explicitly
account for old code ignoring saved startup settings. This is not a real-data
restore, cross-account Windows key transfer, native installer rollback or
in-place production Companion upgrade test.

## Separate Companion Beta

The beta variant uses name `TLI Companion Beta`, scheme `tli-companion-beta`, and
package/bundle identifier `com.thelegatointelligence.companion.beta`. Existing
production identifiers and build profiles remain unchanged. Pairing storage keys
remain app-scoped; the beta neither shares nor copies the current app's pairing.
Generated native configuration is checked for URL-scheme collisions and shared
storage entitlements.

Build only the inspected, verified snapshot's mobile source with the existing
EAS project and internal `beta` profile. Native build numbers increment, while
the public version stays unchanged. Android produces an APK and runs the existing
native transport JVM tests. iPhone requires beta-specific signing and a profile
including the actual test device; a simulator build is not a substitute.

For both archive inspection and submission, set `EAS_NO_VCS=1` and set
`EAS_PROJECT_ROOT` to the **absolute snapshot mobile directory**. Without that
explicit root, EAS can discover the enclosing working repository even in no-VCS
mode. Set `TLI_APP_VARIANT=beta` and compare archived file hashes with the mobile
files in the snapshot manifest before uploading. Use the inspected EAS CLI and
the supported Node runtime, not an implicit install of the latest CLI.

Cloud archive contents, source identity, build IDs, URLs and downloaded artifact
hashes must be recorded. Build success alone does not mark phone acceptance done.

## Physical acceptance

Use only an explicitly launched synthetic LAN test host and separate beta
pairings. A second app identity does not isolate data if deliberately paired to
the live host: do not use the household installation for this rehearsal.

Record device model, OS, exact native build and source fingerprint for both phones.
Each scenario in the candidate report starts as **not run** and becomes **passed**
or **failed** only from an observed result:

- Pairing/app restart; host restart with retained identity and selected port.
- Replacement verification/cancellation, rejected certificates and revocation.
- Wi-Fi/background interruption without automatic replay.
- Shared conversations, Notebook edits/conflicts and screenshot-send recovery.
- Data & Recovery, separate AI readiness, camera/LAN permissions.
- Keyboard, large text, screen-reader navigation and original Companion intact.

Fix demonstrated failures and rebuild any changed source before repeating checks.
Native macOS/Linux startup, production-app in-place upgrades and real-data
restoration remain separate unverified gates.

## Results

Pre-change baseline on September 7, 2026: **648 backend, 138 desktop and 78 mobile
tests passed**, with 934 backend warnings and no baseline failures.

The September 7 candidate is **source verified; physical acceptance pending**:

- Workspace: `build_work/release-snapshot-pa351kk9`.
- Source fingerprint: `e4b428c6657303cb2f4aeaf1ccd5b69af8da48fb4d9350a0ab00f1465de34d4d`
  (369 source files, including the intended uncommitted work).
- Desktop: `TLI_candidate.zip`, 234 files; SHA-256
  `ddb6bf2bc0ed314ed40486bb63adb943e6100a93f4ed371b6abdc90997833a36`.
- Public versions remain desktop `1.3.5-beta` and Companion `0.1.0`.
- Full source backend: **656 passed**, 937 warnings. Extracted installation:
  **644 passed, 1 deselected**, 936 warnings; the 11 packaging tests and the one
  Git-dependent test passed in the source run.
- Desktop: **141 passed**; Companion: **83 passed**, strict TypeScript and both
  Hermes exports passed; release tooling: **40 passed**.
- Fresh runtime-only imports, resolved dependency checks, all eleven real HTTPS
  checks, occupied-port preservation and all five historical storage stages passed.
  Detailed results and resolved dependencies are in the candidate `report.json`
  and referenced logs. Independent review confirmed the security files remained
  byte-identical through the historical cycle and backup restoration.

The first isolated candidate (`release-snapshot-t7gbnujf`) exposed a verifier
path-resolution error when tests changed the working directory. It is retained
as a failed attempt. Absolute test exclusions and a regression test corrected the
harness. The next candidate (`release-snapshot-7fd022oq`) passed source checks but
browser acceptance exposed two defects: a fourth simultaneous toast could freeze
the UI, and Windows TLS transport cleanup could leave Uvicorn waiting indefinitely
after a disconnected browser. Capacity eviction now removes the oldest toast
synchronously; normal dismissal remains animated. Uvicorn now bounds active-request
and transport drain to 30 seconds before normal lifespan cleanup. This is not a
promise that every possible shutdown callback finishes in 30 seconds, and it adds
no automatic retry of interrupted requests.

`release-snapshot-6zyskto0` was correctly rejected for source drift while the
shutdown correction was being completed. The complete final candidate above
passed after both corrections. Failed attempts and original artifacts remain.

Scoped Edge browser checks passed for PIN unlock, pairing QR creation, a 100-toast
burst, Notebook saving and Data & Recovery at desktop and 390px widths. The closed
More drawer stays outside the viewport; no horizontal overflow was observed.
Mesh's expected HTTP 403 remains recorded because that operation is disabled in
the fixture. A disposable browser context accepted only the synthetic-host origin;
no operating-system trust setting changed, and this does not certify native TLS.

Native build records are maintained separately in the candidate's
`native-builds.json`; both phones' scenario results start as **not run** in
`report.json`. Source verification is not beta validation.

### Android artifact and remaining phone gates

[Android Beta build bb65590a-d13b-4cc3-8a8d-acb9ccede364](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/bb65590a-d13b-4cc3-8a8d-acb9ccede364)
completed as **0.1.0 (2)**. The signed APK is retained under the final workspace's
`native-build-evidence/` directory (121,918,027 bytes), SHA-256
`d61b8479d4eab4d9ff2b6cff7b9ec6a252cf35d83e2e5de52e3376de7a3aaea5`.
All 13 native transport tests and ten packaged-identity/permission/storage checks
passed. Local full `apksigner` verification and physical installation are not run.
EAS Expo Doctor reported one pre-existing direct `expo-modules-core` dependency
advisory (20 of 21 checks); native compilation succeeded. Dependencies were not
changed to hide that advisory.

Android was submitted from the original `fa13b17…` whole-source snapshot. All 65
mobile manifest entries and all 56 upload-archive files match the final candidate
byte-for-byte, including the archive content hash
`11bd1e7c731e14f41a27ec95cf6dbc80299faa8f40ab8bf095e30a8d399d8d1e`.
Both identities and the equivalence proof remain recorded; desktop-only fixes did
not require replacing the unchanged native artifact.

The signed **iPhone** internal build is **pending interactive Apple login, team
selection and test-device provisioning**. No iPhone build was submitted. Both
physical acceptance records remain **not run**; use the separate
[phone procedure and result sheet](ANNIVERSARY_BETA_ACCEPTANCE.md).

### Isolated LAN host

The final candidate was explicitly launched on a private LAN address at port
8778 using only the marked synthetic
`build_work/release-snapshot-pa351kk9/phone-fixture` directory. Sample PIN: `739182`.
Its real LAN stop/restart passed, preserving all eight checked security files
byte-for-byte, the synthetic saved bearer and the browser-created Notebook note.
The latest launch at 02:18 EDT on September 7 has a two-hour lifetime. Availability
after that must be rechecked; LAN/firewall reachability from the phones is not yet
verified. The existing household installation is not used by this host.

To reproduce the launch from the repository directory, replace the documentation
example address `192.0.2.10` below with the rehearsal computer's assigned LAN
address. The original machine's address is omitted from this public record. An
existing recovery fixture needs its original bind address and matching
certificate; this example does not migrate them.

```powershell
$candidateRoot = Join-Path (Get-Location) 'build_work/release-snapshot-pa351kk9'
$rehearsalAddress = '192.0.2.10' # Documentation example; replace before running.
& "$candidateRoot/installation/backend/.venv/Scripts/python.exe" -X utf8 "$candidateRoot/source/scripts/rehearsal_host.py" --code-dir "$candidateRoot/installation" --data-root "$candidateRoot/phone-fixture" --serve-lan --host $rehearsalAddress --port 8778 --lifetime 7200
```

Use the printed HTTPS address in a normal browser. The in-app browser cannot
accept this synthetic self-signed certificate; no OS trust store was changed.
Keep the same data directory, bind address and port for recovery acceptance.
`-X utf8` prevents Windows console encoding from disrupting synthetic certificate
initialization. An earlier launch without it was retained separately, not reused.
