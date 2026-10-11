# Anniversary clean-environment and rollback rehearsal

This checkpoint uses an extracted source package and a newly created Python virtual environment on the Windows development host. It is not a fresh Windows VM, native installer test, or hardware certification. The running installation is not stopped or modified.

## Startup fixes

- Windows respects `TLI_PORT`, stops when requirements are missing or installation fails, and checks the address without killing another process.
- Backend startup no longer terminates processes occupying its port. Uvicorn still handles any race between the preflight check and binding.
- macOS/Linux launchers also use the non-destructive port check. Their shell syntax was checked with Git Bash; native startup on those platforms remains untested.
- Generated installation/rehearsal workspaces are excluded from Git and distribution packages.

## Reproduction

```powershell
backend\.venv\Scripts\python.exe scripts/verify_release.py --clean-environment --rollback-ref HEAD
```

The Git ref resolves to a recorded commit SHA. For this checkpoint the baseline was `a5f2104f134a0d0fe482e4b65acadd515699d2fb`, the last committed code before the current working changes. It is not represented as a previously published installer.

The verifier builds/extracts the candidate, creates a fresh venv, installs only runtime requirements, runs `pip check`, and imports the actual application before test dependencies are installed. It then installs the separate test harness, records exact dependency versions, and runs the isolated startup/chat/diagnostic/storage/action checks. On Windows it executes the extracted batch launcher against a temporary occupied port owned by the harness and verifies that the listener survives. The recorded run also uses an installation path containing spaces.

## Data round trip

Each stage runs in a new process with the same synthetic data directory and disabled networking, subprocess execution, inference, discovery and real device calls:

1. Previous code creates a vault secret and encrypted file, conversation, memory, device registries, saved action, node identity and settings.
2. Anniversary code reopens those records, adds a conversation message, memory fact, encrypted diagnostic history and failed-action receipt.
3. Previous code reopens the same records and writes another vault secret. The new diagnostic-history file remains byte-for-byte unchanged.
4. Anniversary code reads the old code's new secret and the diagnostic history again.
5. A copy of the complete synthetic pre-upgrade backup is restored to another directory and reopened by the previous code.

Wrong-password rejection is checked before correct vault unlocks. The backup includes encryption keys and legacy `vault_meta.json`, which can reside outside `data/` because its path is relative to the launch working directory. No metadata relocation or migration was introduced. A production backup plan must account for that file; copying only `data/` is not sufficient for every existing installation.

Both code versions use the same fresh dependency environment and Windows user account. The rehearsal does not establish dependency downgrades, transfer of DPAPI-protected keys between Windows accounts, compatibility with every historical version, or restore guarantees for untested real user data.

## Recorded result — September 6, 2026

The complete run passed in `build_work/release checks/anniversary-szugmizb/`: 210 packaged files, 50 referenced script/style assets, successful runtime dependency installation/import before test dependencies, 63 isolated application checks, the actual Windows batch launcher's occupied-port refusal, four code-transition stages, and synthetic backup restore. The main repository backend suite passed 164 tests. The live backend remained process 12908 throughout this checkpoint.

See that run's `report.json`, `dependency_versions.log` and per-stage logs for the exact evidence. Existing dependency deprecation warnings remain. Earlier harness failures involved route introspection under a newer FastAPI version and Windows asyncio's internal socket pair; both were corrected without relaxing the block on application networking.

The report, logs, dependency versions, candidate ZIP and synthetic backups remain in a unique directory under `build_work/release checks/` (or the default `build_work/release-checks/`). Failed earlier harness runs are retained separately; they are not successful release evidence.

Still required before distribution: native installer execution, macOS/Linux dependency/startup checks, physical phones/devices/mesh, and an approved real-data backup/restore validation. No release or version bump was performed.

## Storage follow-up package rehearsal

After the Narrator, cleanup-estimate, duplicate-verification and large-file-search fixes, `scripts/verify_release.py --rollback-ref HEAD` passed in `build_work/release-checks/anniversary-2o6hcmas/`. This run used the existing project Python environment; it does not replace the earlier fresh-dependency rehearsal. The candidate contains 210 files with 50 checked script/style references. Extracted-installation tests passed 79 checks (one Git-only case excluded), followed by all four synthetic code-transition stages and backup restore.

Candidate SHA-256: `237c5b3cbb0cfb61e6fd8e8e795dded29144dc72e8ffe1b27b69666593beffb6`. Baseline remains `a5f2104f134a0d0fe482e4b65acadd515699d2fb`. See the run's `report.json` and individual logs. Full source backend/frontend suites passed 183 and 29 tests respectively. The candidate was not published or installed over the running backend; native installers, physical devices and real-data restore remain outstanding gates.
