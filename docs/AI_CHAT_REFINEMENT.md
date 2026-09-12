# AI Chat refinement — September 7, 2026

Implemented in the working tree. This checkpoint optimizes the existing AI Chat
section of TLI. It does not redesign navigation, the dashboard, Narrator or other
panels. Existing uncommitted anniversary work and runtime data were preserved.

## Behavior

- A simpler conversation layout, compact composer, useful empty-state prompts,
  and existing History and New Chat controls in the chat header. Existing theme
  colors are retained. Recent Chats remains available on desktop; the History
  control opens the existing history browser at phone widths.
- One context strip shows explicitly selected computers, reports, notes,
  documents and images with independent removal controls. It reads body-free
  descriptors from the existing controllers; displaying a selection does not
  attach content or prepare/send a request. Context review retains the existing
  sharing and image-destination rules.
- The native saved-memory checkbox remains explicit. Turning it off does not
  erase earlier conversation. Additional chat controls remain under Options.
- Assistant text and receipts have more consistent spacing. User image previews
  are preserved by the enhanced message renderer. Failed and stopped sends retain
  their drafts and do not replay automatically.
- A persistent response indicator above the composer appears immediately for an
  accepted send: “TLI is working…” while preparing/waiting, then “TLI is
  responding…” after response text starts arriving. The waiting bubble remains
  visible until that first text. The indicator clears on completion, failure,
  cancellation, conversation changes and session locking. Older request callbacks
  cannot overwrite a newer request's indicator. Its live status text supports
  screen readers, and its dots remain static with reduced motion enabled.
- Whole-question AI-status requests, including “Is the Qwen model running?” and
  “Is the AI running?”, bypass device resolution and ordinary model generation.
  Bundled readiness uses a runtime health check; LM Studio uses only a recent
  cached readiness result and otherwise reports unknown. Remote mesh readiness
  is reported as unknown locally. These requests do not start or switch models,
  run inference probes or forward to a mesh host. Explicit attached-context
  questions retain their existing routes.
- Device names containing AI or Qwen still work as device commands. Intent
  result toasts use explicit handler success/failure metadata; missing metadata
  is informational instead of being assumed successful.

Existing endpoint URLs, SSE event names, authentication rules and persisted
formats are retained. The status reply adds `handled_by: ai_status` and
`provider: tli-status` values to existing metadata fields. Model installation,
selection and runtime lifecycle controls are unchanged.

## Verification

Before this checkpoint, isolated repository suites passed: **1,101 backend** and
**282 frontend** tests. No baseline failures were found in those suites.

After the changes, **1,144 backend** and **324 frontend** tests pass. Backend
tests use the repository's isolated temporary persistence, fake providers and
runtime processes. Existing dependency deprecation warnings remain. Added
coverage includes status routes, negative device-name cases, no inference or
device calls for status questions, client routing, typed result toasts and
independent context removal.

`scripts/verify_chat_workspace_browser.cjs` exercises actual chat modules and the
existing renderer against intercepted synthetic responses. All six combinations
of 1440, 390 and 320 pixel widths with emeraldLight/emeraldDark pass. It checks
context and memory controls, image review, streaming, long replies/code, retained
drafts after failure/cancellation, History/New Chat, duplicate requests and
horizontal overflow. A comparison with the pre-change HTML confirms that body
structure outside AI Chat is unchanged, excluding asset/script tags.

Local evidence is in `build_work/chat-refresh/verification.json`, suite logs in
the same directory, and the linked browser report with source hashes and
screenshots. The browser script can be rerun using Node with Playwright available
through `NODE_PATH`; it launches headless Edge and intercepts all application
requests without launching TLI.

The response-indicator follow-up passes **336 frontend tests** and all six
browser viewport/theme combinations. The browser harness holds routing and
stream content separately to verify waiting, first-text and completion states,
including failure, cancellation and stale callbacks. Evidence is recorded in
`build_work/chat-refresh/response-indicator-verification.json`. This follow-up
changes frontend presentation/lifecycle feedback only; backend suites were not
rerun because no backend code changed.

## Limits

- This is source verification, not a release or physical-phone acceptance.
  The browser fixture uses a simplified surrounding header; screenshots preview
  the actual chat panel and do not claim a full live-session check.
- Live TLI was not restarted, and no real model was downloaded, switched or used.
  Backend behavior takes effect after the application's next normal restart.
- The existing Markdown renderer is retained, including its limited pipe-table
  support. Model-status checks establish runtime readiness, not answer quality.
- The other proposed anniversary tracks (recovery, global search, broader
  consistency fixes and model usefulness evaluations) remain separate work.
