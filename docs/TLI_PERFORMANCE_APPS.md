# Performance & apps

Implemented checkpoint: 8 September 2026. This workspace records a short CPU and memory observation for one running app on the computer hosting TLI. It replaces the navigation label **Game Optimizer** while retaining `panel-games`, the existing feature controller contracts, and the previous name as a search alias. Game configuration readers and optional game advice remain available in a secondary disclosure.

## Everyday workflow

1. Open **Performance & apps**. Opening reads capabilities and retained observations; it does not enumerate processes, start sampling, read game settings, or call AI.
2. Choose **Read process list**, then select the exact app and launch. Matching names remain separate choices with their PIDs. Starters only fill an empty search field.
3. Start the explicit **30-second observation** while the relevant workload is running. The selected computer elsewhere in TLI does not retarget this observation: the target is always the TLI host.
4. Review recorded samples, missing measurements, observation times and scope. **Stop** requests an early finish and retains collected samples. A successful Stop request can still report `running` while the worker finishes its current sample.
5. Choose **Save report** to preserve the result in encrypted diagnostic history. Saving does not run another check, make a repair, or ask AI. The ordinary UI requires at least one recorded sample and a terminal observation state before enabling Save.
6. Open the saved report, review it for AI Chat, or offer it as evidence to a Troubleshooting case. These are separate explicit actions. Reviewing for Chat shows the report before attachment; **Include report in Chat** preserves an existing written question and separate selected notes/documents, and never sends a message automatically. A busy Chat blocks context replacement. Linking evidence uses the existing reviewed case workflow.

Failed refreshes or replacement operations leave previously displayed readings visible with their original times. Navigating away stops browser polling; it does not stop the host worker. Session lock, page hide and backgrounding additionally clear private workspace data and invalidate late responses, without claiming the host observation was cancelled.

## Identity, sampling and coverage

The process picker inspects at most the first 1,024 sorted host PIDs and returns at most 100 matches. Search matches a case-insensitive process-name substring or an exact PID. The response reports inspected, unavailable and returned counts, plus whether the list was limited. The picker excludes command lines, usernames and window titles; it does include the process name, PID, creation time and an executable path when accessible. Reading it does not sample CPU use.

Selection is bound to **PID and process creation time**, not a name alone. The backend rechecks this identity before starting and before each sample. Process creation timestamps use seconds since the Unix epoch; the comparison tolerance is 0.0001 seconds. Process exit, PID reuse, loss of identity access, or a change between known executable paths ends the observation with partial coverage. An inaccessible executable remains unknown and cannot support comparison.

The worker primes its own CPU counters and plans one sample per second, with the first sample after approximately one second and no more than 30 samples. Actual elapsed time is measured with a monotonic clock. Sampling is not hard real-time: excessive delay ends with `sampling_delayed`, and actual sample times remain visible.

| Metric field | Meaning and units |
|---|---|
| `host_cpu_percent` | Host CPU utilization, percent of total host CPU capacity. |
| `host_ram_percent` | Host RAM utilization reported by the operating-system probe, percent. |
| `host_ram_used_bytes` | Used host RAM reported by the probe, bytes. |
| `host_ram_total_bytes` | Total host RAM reported by the probe, bytes. |
| `process_cpu_percent` | App user + system CPU-time delta divided by actual elapsed time and logical CPU count, multiplied by 100. This is normalized to the whole host's logical CPU capacity. |
| `process_rss_bytes` | App resident memory, bytes. RSS includes shared resident pages and is not a measure of exclusively owned memory. The UI displays MiB using 1,048,576 bytes per MiB. |

Missing, invalid, nonfinite, negative and boolean probe values become `null`, never a fabricated zero. Valid percentages are capped at 100. Each sample records `elapsed_seconds` and `observed_at`; each metric summary contains `min`, `max`, `mean` and its usable `samples` count. With no usable values, summary numbers remain `null` and count is zero. A genuine measured zero remains zero.

The result distinguishes `running`, `completed`, `partial`, `stopped` and `failed`. Reasons include `stopped_by_user`, `process_exited`, `process_reused`, `process_identity_unavailable`, `process_executable_changed`, `some_metrics_unavailable`, `sampling_delayed` and `observation_unavailable`. Partial or failed work retains samples already collected. The common diagnostic check status `pass` means all planned samples for that metric were available; it is **not a health verdict**.

This workflow does not measure FPS, GPU load, temperatures, power use, frame times, or the cause of a slowdown. It does not tune settings or perform repairs. CPU and RAM measurements alone cannot establish why an app is slow.

## Retention, concurrency and preservation

One observation worker may run on the TLI host at a time, across all owners. This reservation is released only after the worker finishes, including after Stop. A competing start receives a retryable busy response without disclosing another owner's process details.

Terminal observations remain in host memory for **10 minutes after completion**, with a **20-result host-wide cap**. A new observation can evict the oldest terminal result at that cap. Listing, retrieving, stopping and saving are owner-scoped. Unknown, foreign and expired result IDs return the same unavailable response. Host restart loses in-memory observations. No observation is automatically saved.

Explicit Save uses the existing `diagnostics.save_report` helper and encrypted owner-scoped diagnostic store, which retains the latest 200 reports across diagnostic kinds. The complete report body is frozen for retry, including its timestamp and comparison; the stable report ID derives from the observation ID. Duplicate saves return the stored report without overwriting a later user-confirmed update. Conflicting content for the same report/request identity is rejected.

Saved performance reports use the existing common fields (`id`, `created_at`, `kind`, `host`, `target`, `checks`, `findings`, `next_steps`, `scope`, `verified_fix`, `comparison`) and add the full observation under `performance`. Their kind is `performance`, target is `null`, and `internet_checks` is false. Internal `_save_*` receipts support immutable, idempotent storage; clients must not treat these as editable report content.

Existing Saved data & backups archives contain whole diagnostic records, so additive performance data follows the same encrypted backup and separate-copy recovery path. Current-reader recovery compares reopened diagnostic history and individual reports with the recovered records. Unsaved observations are not included; recovery does not resume a worker or activate the recovered copy. See [separate-copy recovery](TLI_SEPARATE_RECOVERY.md). The performance-specific tests cover explicit encrypted save and preservation; the existing backup/recovery suites provide the shared archive and current-reader checks, rather than a new performance-only archive format.

### Comparison caveats

At save time, comparison may use a previous saved performance report only when the **host ID matches and both reports have the same known, normalized absolute executable path**. PID or display name alone is insufficient. Comparison includes the prior report ID and before/after means only for metrics with usable values in both reports.

This is a comparison of recorded observations, not a controlled benchmark. Workload, coverage, app version, background activity and elapsed time can differ. Executable paths are not content hashes: the same path can contain a newer application. Unknown executable identity disables comparison. Reopening a report shows its recorded comparison and does not start another measurement.

## HTTP API

Implementation: [performance service](../backend/intelligence/performance.py) and [authenticated routes](../backend/routers/performance_routes.py). All routes use the existing session authentication, including read-only capabilities and process selection. No new authentication scheme or SSE protocol is introduced.

Prefix: **`/api/intelligence/performance`**. Successful responses use `Cache-Control: no-store` and this envelope:

```json
{
  "ok": true,
  "protocol": "tli-performance-v1",
  "checked_at": "ISO 8601 timestamp",
  "actions_performed": false
}
```

Route-specific fields are additive. `actions_performed: false` means no repair or device action was performed; an explicitly requested observation does collect measurements, and Save does persist a report. `checked_at` is the response/check time, separate from each sample's observation time.

| Method and suffix | Request | Additional response fields |
|---|---|---|
| GET `/capabilities` | None. | `duration_seconds:30`, `interval_seconds:1`, `max_results:20`, `retention_seconds:600`, `metrics`, `scope`. No sampling. |
| GET `/processes` | Optional `q` (up to 120 characters), `limit` (1–100; default 100). | `host`, `processes`, `coverage:{inspected,unavailable,returned,limited}`, `scope`, picker `checked_at`. |
| GET `/observations` | None. | `observations`: this owner's retained result views, newest first. |
| GET `/observations/by-request/{request_id}` | Original opaque request ID. | `observation` if retained. This lookup never starts work. |
| POST `/observations` | JSON `request_id` (1–128 characters), `pid` (integer 1–2,147,483,647), `create_time` (finite positive numeric timestamp from the picker). | `observation`, `already_started`. Duration and interval are server controlled. |
| GET `/observations/{ident}` | Opaque observation ID. | `observation`. |
| POST `/observations/{ident}/stop` | No body required. | `observation`, `stop_requested:true`. The observation may still be `running`. |
| POST `/observations/{ident}/save` | JSON `request_id` (1–128 characters). | `report`: the saved common diagnostic record with additive `performance`. |

Start and Save bodies use strict validation and reject additional fields. A process entry is `{pid,create_time,name,exe}`; `exe` can be `null`. An observation view contains:

```text
id, observation_id, schema_version: 1, host, process,
status, reason, started_at, finished_at, expires_at,
duration_seconds, requested_duration_seconds, sample_interval_seconds,
expected_samples, samples, sample_count, summary, scope, saved_report_id
```

`finished_at`, `expires_at` and `saved_report_id` can be `null`. `samples` contains the six metric fields plus `elapsed_seconds` and `observed_at`. `summary` maps each metric to `{min,max,mean,samples}`. Do not infer readiness, current host health or a completed repair from these fields.

### Failure and deliberate retry

| Outcome | Meaning and next step |
|---|---|
| 401 | The existing session is unavailable/expired. The UI clears private state and invalidates pending responses. |
| 404 | Unknown, foreign, evicted or expired observation/request. Refresh retained observations; do not silently start a replacement. |
| 409 on Start | Another worker is active, the selected launch changed/cannot be identified, or the request ID was reused with different inputs. Wait for the active observation or explicitly refresh/reselect the process as appropriate. |
| 409 on Save | Observation is still running, or save identity/content conflicts. Review the retained state; do not overwrite the conflicting report. |
| 422 | Invalid strict input or invalid report content. Correct the input before another explicit request. |
| 413 on Save | Report exceeds the shared 256 KiB saved-report content bound. Existing reports remain intact. |
| 503 | Host process list or sampling-worker startup unavailable. A rejected startup removes its worker reservation. Persistence failures use the existing encrypted-store error handling. |
| Network failure or unreadable mutation response | The host outcome may be unknown. No mutation is automatically replayed. Use the original-request lookup or refresh retained observations before a deliberate retry. |

An identical Start request from the same owner returns its existing observation while that request is retained. Reusing the request ID with a different PID or creation time returns 409. This idempotence lasts within the in-memory retention window; it does not survive expiry, eviction or host restart. The UI's **Check original request** performs only the GET lookup. Choosing to review a new observation explicitly clears the process selection and warns that the original may have completed; a new Start still requires review.

Save freezes the source report and reuses a stable save request ID for explicit retry. Stop is idempotent for a retained observation. Browser read failures pause polling and preserve prior readings; they do not imply the server stopped. Opening, navigation, starters, report review and case handoff never automatically repeat Start, Save or an AI request.

## Retained game advice

The existing [game routes](../backend/routers/games.py) keep their URLs and now apply session authentication before detection, configuration reads and inference. Hardware reads, detection and settings reads require explicit controls; choosing a goal or opening the panel does not ask AI.

The three configuration readers remain **Cyberpunk 2077**, **The Witcher 3**, and **Red Dead Redemption 2**. The [registry](../backend/game_configs/registry.py) matches normalized complete aliases instead of substrings. Config results are bound to the exact reviewed game input; late results from an earlier game cannot be attached to a newly typed game. Advice requests include settings only with a matching `config_game_name`. The readers do not write settings.

The existing SSE text token field `t` and `[DONE]` termination remain intact. When no AI answer can begin, additive `meta.source:"static-guidance"` identifies the fixed generic checklist. An interrupted AI answer retains its partial text and reports `error` with `meta.incomplete:true`; it is not silently completed with the generic checklist. Stopping advice stops browser receipt of output and does not claim confirmed server cancellation.

A pre-existing reader import defect was repaired during this checkpoint: Windows paths in two module docstrings contained unescaped Unicode-escape sequences, preventing those modules from loading while the registry swallowed import errors. Raw docstrings restored all three reader imports. This was separate from the new observation workflow; targeted tests now exercise all three exact targets.

## Verification record

The [isolated browser verifier](../scripts/verify_performance_browser.cjs) ran against the frozen source at `build_work/dependable-troubleshooting/release/release-snapshot-uxn2z8rg/source`, full-source fingerprint `134bb34b51dfe82f19ca290fed80d7348998ca5810feabc6026ee61947e014ea`.

The [final browser report - local evidence](LOCAL_EVIDENCE.md) records **23 themes, 31 layout checks, 7 behavior flows and 12 screenshots**, with zero overflow, duplicate IDs, contrast failures, unresolved contrast review items or browser errors, and unchanged source. Detailed Emerald Light/Midnight views cover 1440, 390 and 320 pixels; checks include enlarged text, expanded measurement details and the legacy game-advice disclosure. All 23 themes receive the 390-pixel completed-state smoke check, not every possible operation state.

The seven browser flows cover opening with GETs only, inert starters and distinct PID choices, Stop with partial results, explicit Save, reviewed Chat attachment with draft preservation/no auto-send, failed-refresh preservation, and lock clearing without a Stop request. [Backend tests](../backend/tests/test_performance.py) additionally use fake hardware/processes/workers and temporary encrypted persistence for identity reuse, missing probes, bounds, owner isolation, concurrency, idempotence, retention, failed-save preservation and comparison. [Frontend controller tests](../frontend/tests/performance-workspace.test.cjs) cover uncertain starts, deliberate new requests, duplicate requests, late responses, background/lock handling and game selection binding.

The [before/after gallery - local evidence](LOCAL_EVIDENCE.md) links the exact reports and screenshots. Baseline screenshots came from `release-snapshot-bgccnb_b/source`, fingerprint `f14d649a2157e88a190a989bbbded8066c136849b1833d272944ced710552d7a`; the baseline was not expected to expose the new observation workflow. Local `build_work` artifacts are retained verification evidence and are excluded from release archives.

These are synthetic intercepted-browser and fake-process results, not acceptance on real workloads. Automated checks did not sample the user's running apps, call a live model, change game settings, restart live TLI, or operate household devices. Real operating-system counter behavior under load, physical-phone use, and native-platform observation behavior remain separate acceptance work. See the broader [dependable troubleshooting checkpoint](TLI_DEPENDABLE_TROUBLESHOOTING.md).
