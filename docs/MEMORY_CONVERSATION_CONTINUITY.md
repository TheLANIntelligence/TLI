# Anniversary desktop batch: memory and conversation continuity

The later [useful-answer checkpoint](TLI_USEFUL_ANSWERS.md) adds bounded follow-up
recall and deliberate reviewed updates to existing notes. New answer receipts
carry optional computer scope for recall; old records load unchanged. Changed
note revisions reject replacement instead of merging or replaying it.

The later [grounded-answer checkpoint](TLI_ANSWER_QUALITY.md) extends this
implementation with provider-bound text estimates and an answer reserve. The
12,000-character ceiling remains, but it is no longer the only check when the
owned bundled runtime has a known configured context. Ordinary receipts still
identify the exact whole notes and complete exchanges provided.

Implemented in the working tree on September 7, 2026. This checkpoint extends
TLI's existing encrypted Notebook and conversations. It does not restart the
live backend, alter the selected model, or build the native Companion. Home
Automation expansion, voice and diagnostic rechecks remain parked.

## What changed

1. Ordinary bundled and LM Studio chat now share one context preparation path.
   Mandatory instructions, the latest question, host facts and explicitly
   selected diagnostic/device evidence stay whole. Recent complete exchanges
   receive space before optional saved notes. The final request retains whole
   notes and exchanges instead of slicing their text or structured references.
2. Automatic recall ranks current owned notes by titles, phrases and meaningful
   query words. Device notes require the selected device scope. Unrelated
   preferences no longer receive unconditional inclusion. Legacy unowned device
   memory is not silently promoted into this account's automatic recall.
3. Completed answers show **Context for this answer**: the exact note IDs,
   versions, source labels and dates provided, plus included/omitted history
   counts. Open current note uses the existing editor and its changed/deleted
   handling. A receipt proves that text was provided, not that an AI interpreted
   it correctly. Receipts are saved without note bodies and survive reopening.
4. **Save to Notebook…** opens the exact persisted user or assistant message.
   Users review the text, title and optional device before explicitly saving.
   Saving never invokes AI or a device. A changed/deleted source rejects before
   writing; repeated identical saves return the existing copy without overwriting
   later edits. User statements and AI suggestions retain distinct provenance.
5. Notebook offers a user-confirmed-fix filter and device/date/source search.
   Saving an AI response never makes it a confirmed fix. Existing confirmed
   fixes remain historical user reports, not current measured health.
6. **Search older chats** and the History drawer search retained owned titles and
   message text with explicit pagination and visible coverage. Opening a result
   resumes the saved conversation; it does not send its entire contents to AI.
   New Chat preserves saved history. Deletion remains explicit, checks actual
   backend results, and is blocked while a reply is active.

## Asking without saved memory

The checked **Use saved memories** control applies to each question. Unchecking
skips new saved-memory retrieval on this host. Earlier chat messages may still
quote saved information; New Chat leaves that history out. Correcting/deleting
a note affects subsequent retrieval, not text already present in old messages.

The setting is captured with the request, survives New Chat, and resets on a
page reload or session lock. Explicitly selected Notebook notes must be removed
before opting out. A fresh authenticated capability check prevents an older
host from silently ignoring the setting. Session expiry clears private controls
and resets Send/Stop; failures never automatically resend a question.

Generic image questions honor the same opt-out and report their actual textual
reference input. Images themselves keep existing validation/retention rules and
are outside the character estimate. Guided screenshots and explicit document or
Notebook questions keep their separate reference modes and existing receipts.

## Boundaries and compatibility

- The context cap remains **12,000 characters**, an estimate rather than a model
  tokenizer or guarantee of context-window fit. Up to 64 prior valid messages
  are considered as complete adjacent user/assistant pairs. The receipt counts
  omitted messages across the full retained thread. Oversized mandatory input
  fails before generation; the UI retains an ordinary failed draft.
- Existing mesh selection stays available. Legacy peers cannot attest to their
  final memory/history input, so their receipts remain unknown. Opt-out cannot
  use an unverifiable peer route. The old browser-direct LAN path has no local
  persisted source pointer; it does not fabricate one or offer chat-copy saving.
- Text transports carrying these private references refuse redirects. No new
  local memory payload is forwarded by the server's mesh adapter. Legacy routing
  is not a claim of isolated or memory-free processing on another host.
- Search has a 16 MiB stored-file limit and 10,000-record limit. Each page scans
  at most 250 conversations / 1 MiB of text, with per-conversation limits of 500
  messages / 128 KiB and 16 KiB per message. Limited coverage is visible. Missing
  results do not prove a conversation was deleted. Cursors expire after ten
  minutes and reject changed data, owners or queries; no search index is saved.
- Chat copies use an authenticated conversation ID, original message index and
  content revision. Source previews are capped at 32,000 characters; a saved
  note remains 1–2,000 characters. Source metadata is optional and bounded.
- Existing endpoint URLs, unnamed SSE event types, preset IDs, encrypted keys
  and JSON envelopes remain unchanged. New APIs and optional request/receipt
  fields are additive. Existing notes retain revisions unless actually edited.
  Older code can ignore new metadata and may drop it when rewriting records;
  no in-place downgrade or real-data restore was performed for this checkpoint.
- Native Companion code and builds are unchanged. Shared API regression checks
  remain in the backend suite; they do not validate new native controls.

## Verification

The preceding checkpoint passed 963 backend and 230 frontend tests with no
baseline failures. Checks here establish temporary persistence before imports,
use fake providers/devices and never access real household data or inference.

Focused coverage includes relevant/unrelated recall, edited/deleted notes,
owner isolation, full exchange budgets, endpoint opt-out, actual-input receipt
equality, persisted source revisions, duplicate saves, legacy data, malformed
metadata, incomplete streams, unavailable providers, auth expiry, older-host
fallback, pagination limits, navigation races and truthful deletion.

One pre-existing activity test exposed a Windows test-harness race: polling the
temporary JSON file while its writer atomically replaced it caused a sharing
error. The test now waits for committed writer state and reads durable bytes
after stopping the harness. The production activity recorder was not changed.
Other intermediate failures were assertions/fakes requiring the new optional
metadata and function arguments; the initial logs are retained separately.

Final suites: **1,101 backend tests and 282 frontend tests passed**, with no
failures. Existing backend warnings remain separate from failures. This includes
40 redirect cases proving no forwarding/replay or completed private-context
receipt, alongside the recall, saving and history coverage above.

Automated totals, source fingerprints and browser evidence are recorded in
`build_work/memory-continuity-verification.json`. Browser checks use intercepted
synthetic fixtures at desktop and 390px phone widths: integrated chat/receipts,
reviewed saving, confirmed-fix lookup and conversation search. They include no
live backend, model, pairing or physical phone acceptance. Actual model answer
quality remains unmeasured. New backend behavior requires a normal restart.
