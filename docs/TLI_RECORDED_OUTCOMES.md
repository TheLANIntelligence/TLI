# Recorded outcomes in chat

TLI can answer narrow completion and past-fix questions from an explicitly selected saved diagnostic report without starting AI, running a check or executing a repair. This applies to bundled JSON/SSE chat and the shared `/chat` route, including LM Studio selections.

Examples include “Did the checks finish?”, “Did the test print?”, “What fixed it last time?” and “Did you finish measuring Render, and is it fixed?”. General advice, coding and execution requests retain their existing routes. Selected notes, documents and images retain their separate sharing rules and take precedence.

The response distinguishes:

- Stored check outcomes: passed, failed, unavailable and unrecognized results are counted separately. A passed TCP check does not prove a page physically printed.
- Performance observation coverage: the recorded host, process ID/start time, status and sample count remain visible. Partial, stopped and failed observations stay incomplete. Completing all planned samples does not mean an application's own task succeeded or a repair worked.
- A report's user-confirmed fix: the exact confirmation is quoted and dated as the user's record. It is not an independent test or evidence of current health.
- No supplied outcome: TLI explains that no admissible outcome was supplied and asks for the relevant report or explicitly selected saved fix note. It does not search arbitrary cases, retrieve automatic note matches or turn historical assistant prose into a past repair.

An explicitly selected report is checked against the authenticated account and any selected target. Another account's report remains unavailable. Missing keys, corrupt records and target mismatches remain errors; they do not become an empty or successful outcome. These answers use the existing metadata-only `evidence_context` receipt, `interpretation: backend`, source `R1`, and `handled_by: recorded_outcome`. They do not produce an observation receipt or imply new measurement.

Ordinary AI questions about a selected performance report now receive its bounded stored summary, including host/process identity, times, status, expected and recorded sample counts, and per-metric sample coverage. Raw samples are omitted explicitly; their count is disclosed. The existing character/token checks still reject oversized required context rather than silently truncating records. No stored report format changes.

Validation uses synthetic encrypted stores and intercepted providers: all three route families, owner/target conflicts, missing keys, opt-out, prior assistant/deleted-note claims, incomplete observations, user confirmation attribution, literal quote escaping, and standalone-reference precedence. The frozen six-model comparison remains historical evidence; this checkpoint does not claim a new model-quality acceptance result or physical-device acceptance.
