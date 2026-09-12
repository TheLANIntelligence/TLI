# Home awareness building checkpoint

The home console now gives users a compact catch-up summary and more useful
operation feedback. Existing devices, model selection, data formats and chat
streaming remain in place. No background language-model calls were added.

## Catch-up behavior

- The home panel says **Since you last checked** after an explicit review. The
  first visit says **Recent activity**. Opening, refreshing or leaving a page
  does not automatically mark events reviewed.
- Three groups are shown on the home screen, with recorded warnings first.
  Repeated events group by category, node, exact title and severity. Counts and
  latest details are visible; different devices or escalations remain separate.
- The expandable history contains every retained event, including repetitions
  and previously reviewed events. A recorded warning is not a claim that the
  condition is still present. Current alerts remain the place for present conditions.
- TLI retains the existing limit of 200 events in memory. Restart and overflow
  gaps are explicit. This is recorded activity, not a complete history of all
  changes in the home; nothing is inferred about unobserved time.
- Each event gains additive `stream_id` and `sequence` fields. Existing feed
  URLs, event names and fields are unchanged. A locked snapshot makes cursors
  consistent even when several threads emit events together.
- `GET /dashboard/activity-summary` reads the summary. Authenticated
  `POST /dashboard/activity-summary/review` accepts `{stream_id, sequence}` for
  the displayed snapshot. Events arriving during review remain new. An older
  tab cannot move a user's review position backwards; a cursor from a previous
  backend start is rejected with 409 and a refresh instruction.
- The only new persistence is an encrypted per-user cursor sidecar under the
  existing intelligence store. It follows TLI's session identity: open-access
  installations share the existing `local` identity. Review does not delete events.
  Existing configuration and data files require no migration.

## Narrator and operation results

- Ordinary event bursts wait briefly in a queue of at most eight messages,
  spaced by at least eight seconds on policy ticks. Events expire 30 seconds
  after receipt, so old news does not replay later. Higher severity can interrupt.
- Five-minute identical-event suppression, ten-second action confirmations,
  30-second CPU/RAM warning hysteresis, critical disk priority and stale-monitoring
  behavior remain covered by deterministic tests. Full activity is retained
  even when Narrator messages are suppressed.
- Model installations report start, validated completion, cancellation or failure.
  Install completion does not claim selection or runtime activation.
- Model switches report verified success only after startup, inference and saved
  selection succeed. Candidate failure and recovery have separate events.
- The treemap/scan, large-file and duplicate searches report start and truthful
  completion, partial coverage or failure. No cleanup is implied.
- Diagnostic requests report counts of passed, failed and unavailable checks,
  or an inability to complete. They do not claim a repair.
- New operation events contain summaries only: no requested file paths, custom
  model filenames, download URLs, probe error details or private diagnostic text.
- Live-feed action buttons check HTTP and handler success, prevent duplicate
  clicks, and retain an explicit retry after failure.

## Verification and limits

The previously recorded baseline was 232 backend tests and 36 frontend tests,
with no failing tests. During this checkpoint two scan tests needed their event
assertions updated for the new start/result pair; these were not baseline failures.

Final verification: **249 backend tests passed** (229 existing warnings) and
**44 frontend tests passed**. This includes cursor concurrency, authentication,
restart/overflow gaps, unchanged review positions on failures, retained history,
fake-clock Narrator bursts and escalation, truthful operation events, model
recovery, scan outcomes, existing startup and chat-streaming coverage.

All backend checks establish
temporary persistence and fake services before application imports. No real
model download, live model switch or live TLI restart is used.

The disposable browser fixture is `backend/tests/activity_preview.py` on loopback
port 8766. It uses fake events, resources and inert integrations. Desktop and
390×844 phone viewport checks cover grouping, long names, expandable history,
refresh and explicit review. The phone layout has no horizontal overflow and
44-pixel catch-up buttons. These are viewport checks, not physical phone or
macOS/Linux hardware tests.

Rolling back code leaves the optional cursor sidecar unused; existing data
formats remain readable. The live backend needs its normal restart to load the
new routes and event policy. This checkpoint does not restart it automatically.

The user subsequently parked the focused diagnostics/recheck batch and chose
reviewed Free Space cleanup instead. See [the subsequent cleanup checkpoint](REVIEWED_STORAGE_CLEANUP.md)
and the updated building order in [the roadmap](TLI_ANNIVERSARY_ROADMAP.md).
