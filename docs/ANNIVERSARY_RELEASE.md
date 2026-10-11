# Anniversary checkpoint: awareness and dependable actions

Implemented in the existing application, without a data migration or new runtime dependencies. The version remains 1.3.5-beta; this work does not publish a release or replace an installed copy.

## Checkpoints

1. **Test isolation:** collection establishes a temporary `TLI_ROOT` and working directory before application imports. Model storage and printer configuration are redirected. Import-time workers, inference, HTTP clients, discovery, ambient checks, and cleanup scheduling are isolated during tests. Each vault lifecycle test has independent metadata and blobs.
2. **Narrator:** the existing dashboard/event flow uses an in-memory deterministic policy. Identical category/node/title/severity events are suppressed for five minutes in the Narrator, while the activity feed retains them. CPU/RAM pressure requires 30 seconds to activate or clear. Critical disk warnings remain immediate. Successful confirmations last ten seconds unless interrupted by a critical alert. Missing, partial, failed, and stale monitoring are described explicitly. The frontend displays server Narrator decisions rather than overriding them with its old nine-second rotation.
3. **Targeting and results:** chat and saved Shelly actions share conservative device resolution. Unique exact names, IDs, addresses, aliases, and partial names can resolve; ambiguity blocks execution and fuzzy matches only suggest candidates. An address serving multiple relays requires a unique name/ID or `ADDRESS relay N`. Chat now sends the selected relay. Saved actions validate all targets before executing steps. Dashboard actions serialize concurrent confirmation requests, retain failures for explicit retry, and report actual handler results. Receipts and frontend messages distinguish success, partial completion, and failure. Navigation results describe the panel opened.

## Compatibility

- Existing endpoint URLs, SSE names, persisted registries, saved actions, and receipt files remain in place. Additional result metadata is additive; `ok` now accurately reflects execution success.
- Bundled inference, LM Studio, mesh routing, vault encryption, and memory formats were not replaced. Model routing, semantic memory, Skills, MCP, Home Assistant, and companion agents remain deferred.
- Previously ambiguous or typo-only commands may now ask for an exact target. This is intentional: they no longer select a device by registry order or fuzzy similarity.
- No automatic retry of partially completed operations. Review the receipt before an explicit retry, because completed steps can run again.
- Existing working-tree edits were retained. No repository-wide reorganization or automatic version bump was performed.

## Verification recorded on 2026-09-06

- Initial baseline: 70 passed, three vault lifecycle tests skipped. A legacy relative vault metadata path was detected during isolation verification; that file was restored and the test working directory was moved into the temporary installation. Per-test vault isolation subsequently eliminated the skips.
- Final backend suite: **120 passed, zero skipped**. Coverage includes fake-clock timing, ambiguity, multiple relays, preflight rejection, driver failures, partial cleanup/scenes, concurrent confirmations, lifecycle hook cleanup, SSE streaming/history, authentication, encryption, and existing formats.
- Frontend component suite: **six passed**. Success, partial failure, failure toasts, failed-receipt styling, stale-response handling, and disconnected monitoring are exercised with fake I/O. JavaScript syntax checks pass for all three modified client files.
- The committed pre-change actions reader successfully reads current saved actions and receipts. Existing saved-action bytes are unchanged by resolution/readback. This verifies format compatibility, not a full installer rollback.
- Browser checks used a disposable, loopback-only installation. Desktop navigation succeeded; failed actions displayed an error and remained retryable. At a 390 × 844 viewport, the action remained usable with no horizontal document overflow. Failed receipts showed an error indicator. An existing unpaired-mesh HTTP 400 console message was observed; the preview had no paired peers.
- Warnings remain in the test suite, including existing dependency/API deprecations.

Run from the repository root:

```powershell
& backend\.venv\Scripts\python.exe -m pytest backend/tests/ -q
node --test frontend/tests/anniversary.test.cjs
node --check frontend/app.js
node --check frontend/js/system-state-bar.js
node --check frontend/js/action-engine.js
```

For repeatable manual UI checks, `backend/tests/anniversary_preview.py` serves an isolated installation at `http://127.0.0.1:8766`. It requires the development/test dependencies, disables live integrations, and seeds navigation/failure actions only in temporary memory. Stop it after inspection.

## Remaining release gates

Physical Shelly/other devices, real mesh peers, a physical phone, macOS/Linux startup, packaged installers, and full installation rollback have **not** been exercised here. Before distributing an anniversary build, validate these against isolated installations and backed-up data. The automated tests and responsive browser checks do not establish those hardware/platform guarantees.
