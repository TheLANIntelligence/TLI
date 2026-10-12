# TLI chat streaming contract

Desktop, web Companion, and native Companion consume the same SSE payloads.
The canonical endpoint is `POST /api/ai/chat/stream` with JSON request bodies.
Browsers use their session cookie; native clients use
`Authorization: Bearer <device credential>` over pinned HTTPS.
Invalid native credentials are rejected even with PIN authentication disabled.

## Request

```json
{
  "message": "What does this printer error mean?",
  "conversation_id": "conv-existing-or-client-generated-id",
  "device_id": "comp_paired-phone-id",
  "target_id": "optional-canonical-device-id",
  "diagnostic_id": "optional-owned-report-id",
  "use_saved_memory": true,
  "use_conversation_history": true,
  "max_tokens": 300,
  "temperature": 0.2,
  "image_b64": "optional-base64-JPEG-or-PNG",
  "image_mime": "image/jpeg",
  "retention_days": 0
}
```

Only `message` is required. Omit unused fields. `session_id` remains a legacy
alias for `conversation_id`; the latter takes precedence. Ownership comes from
authentication. `device_id` is context, never authorization. Images pass the
existing 6 MB / 16 million pixel validation; native images use zero retention.

`use_saved_memory` is an optional strict boolean, defaulting to `true`, on the
POST chat endpoints. `false` skips fresh saved-memory retrieval and historical
note-revision lookups on this host; earlier conversation still applies unless
separately disabled. It conflicts with explicit `note_refs`.
Clients offering opt-out first check authenticated
`GET /api/intelligence/memory/capabilities` for `tli-memory-continuity-v1`.
Legacy mesh routes that cannot attest to opt-out reject it before forwarding.

`use_conversation_history` is a separate optional strict boolean, defaulting to
`true`, on all three POST chat endpoints. For ordinary text preparation, `false`
excludes earlier exchanges and prevents them from seeding follow-up note recall.
It does not delete history, disable fresh note retrieval, or remove explicit
current-question context. The browser and Companion expose **Use earlier
conversation** as a per-question choice, default on; successful completion resets
the next-question choice. It is not a persisted browser preference or a new
conversation-store format. An omitted field retains earlier-client behavior.

Before offering history opt-out, clients require the authenticated memory
capability response to explicitly include `use_conversation_history: true`:

```json
{
  "ok": true,
  "protocol": "tli-memory-continuity-v1",
  "use_conversation_history": true,
  "evidence_context_version": 1
}
```

Missing history capability is unsupported, not permission to send the question
as ordinary history-enabled chat. Legacy mesh paths cannot attest to this choice
and reject it before forwarding; clients do not silently switch provider or
transport. Explicit note/document questions retain their stricter standalone
sharing rules regardless of this flag. Screenshot guidance also retains its
separate existing rules. Deterministic observed-status replies need neither
history nor note retrieval and do not imply a model call occurred.

For ordinary questions carrying both `target_id` and `diagnostic_id`, the report
must belong to the authenticated owner and describe that target. A device report
matches its recorded `target.id`; a host report without a device target matches
the canonical inventory identity `node-<report.host.id>`. A mismatch rejects the
request before inference instead of relabeling old measurements as the selected
computer. Missing observation age does not mean current, and host identity alone
is not a health measurement. Authentication and conversation ownership still
apply when history is disabled.

### Optional screenshot guidance

`GET /api/intelligence/screenshots/context` uses existing session authentication
and returns registered computers and the current image provider's review key,
destination, capability note and checked time. It does not send an image, start
inference, or switch models. An unavailable provider is explicit.

The existing POST chat endpoints accept an optional `screenshot` object:

```json
{
  "task": "next_step",
  "target_id": "node-the-computer-shown",
  "other_computer": null,
  "provider_key": "64-character-key-returned-by-the-context-endpoint"
}
```

Tasks are `explain`, `error`, or `next_step`. A screenshot request also requires
`image_b64`. Omit both computer fields for unknown identity; use either a
registered computer ID or an optional user label. This identity is independent
of the browser's `device_id` and ordinary chat's `target_id`. A diagnostic report
must measure the chosen host, with no separate device target. Its timestamp and
scope stay attached. Screenshot guidance does not load implicit memory or run
actions, diagnostics, search, or mesh fallback.

The backend compares the review key with the provider it will actually call;
changed providers require rechecking and a new explicit send. Ordinary image
requests may supply `image_provider_key` for the same destination check while
retaining their existing context behavior. Both additions are optional for old
clients. Image provider redirects are rejected rather than forwarding the image.

## Frames

The content type is `text/event-stream`. Each frame is an unnamed SSE `data:`
event containing JSON, terminated by a blank line. Both LF and CRLF framing work.
The payloads do **not** use SSE `event: meta` names or `token` properties.

```text
data: {"type":"meta","session_id":"conv-123","handled_by":"llm","provider":"bundled","model":"standard"}

data: {"type":"delta","text":"The printer reports "}

data: {"type":"delta","text":"a paper jam."}

data: {"type":"done"}

```

- `meta`: `session_id` is the durable conversation ID. Optional fields include
  `provider`, `model`, `handled_by`, `host`, `context_categories`,
  `mesh_node`, `retained_image`, `screenshot_context`, `note_context`,
  `document_context`, `memory_context`, `conversation_context`, `evidence_context`,
  `observation_context`, `input_budget`, `source_ref`,
  and `user_source_ref`.
  Omitted fields are unknown. Merge successive metadata frames rather than
  replacing all earlier metadata.
  Screenshot context identifies the task, user-selected/unknown computer,
  attached report ID, `capture: "user_shared_snapshot"`, and
  `actions_performed: false`. The JSON chat counterparts also return this
  optional field. It describes this request, not an ongoing screen session.
- `delta`: append the string `text` verbatim. Image and diagnostic replies may
  arrive as one delta after processing.
- `done`: successful terminal event. Completed replies are persisted before
  emission. The current backend has no reliable token-limit `finish_reason`;
  clients must not invent one.
- `error`: failed terminal event with `detail`. Preserve partial text and mark
  failure, rather than presenting it as a completed answer.

```text
data: {"type":"error","detail":"No available image-capable model. The image was not sent."}

```

## Client behavior and concurrency

Decode UTF-8 incrementally; characters, JSON values, and frame delimiters can
span chunks. Consume only complete frames. Ignore comments and unknown extension
events. EOF without a complete `done` frame is interruption, including an
unterminated apparent done frame. Errors must not become success.

Reuse the returned conversation ID on phone and desktop. Overlapping turns for
one ID are rejected with HTTP 409 across streaming and JSON entry points.
Encrypted conversation-store transactions are serialized. There is no durable
request deduplication after a restart.

Guided screenshot assistant turns may also expose `screenshot_context` when read
from `/api/ai/conversations/{id}`. This is the same bounded task/computer/report
snapshot receipt used in response metadata, with `actions_performed: false`.
It contains no image bytes or provider review key. Older messages may omit it;
clients render those normally and do not infer that a prior image is available.

Ordinary local answers emit final `meta` before `done` with the **actual bounded
input** receipts. `memory_context` contains `use_saved_memory`, a status
(`included`, `none`, `disabled` or `unknown`), up to eight body-free note
references and `omitted_for_budget`. `conversation_context` contains status
(`included`, `none`, `limited`, `disabled` or `unknown`), `included_messages`,
`included_exchanges`, `omitted_messages` and `character_budget`. Unknown peer or
legacy context must not be displayed as zero memory use. Failed/partial streams
must not display successful receipts received before a terminal failure.

A disabled conversation receipt additionally includes
`use_conversation_history: false`, with all three message/exchange counts zero.
When the choice is enabled, the additive boolean may be omitted. Standalone
selected-note/document requests have zero history: status `none` when the flag
is enabled and `disabled` when explicitly off. Neither value changes their
standalone context rules. Old receipts without the boolean remain valid.

## Supplied-source evidence metadata

Successful answers may additionally carry `evidence_context` in JSON responses,
final SSE `meta`, and the bounded projection of stored assistant turns. It is a
server-built, versioned receipt of the **final supplied input** after whole-record
history/note trimming or document excerpt refitting. A provider cannot supply or
replace these source facts. It is not a transcript of hidden reasoning and does
not grant access to a source.

```json
{
  "evidence_context": {
    "version": 1,
    "interpretation": "ai",
    "sources": [{
      "handle": "N1",
      "kind": "note",
      "id": "f-printer",
      "label": "Printer cable suggestion",
      "provenance": "chat_ai",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "saved_at": "2026-09-08T10:00:00Z",
      "observed_at": null,
      "host_id": null,
      "target_id": null,
      "ranges": []
    }],
    "historical_notes": {"checked": false, "changed": 0, "unavailable": 0},
    "citations_checked": true,
    "citations": [{"reference": "[N1]", "handle": "N1"}],
    "invalid_citations": 0
  }
}
```

Version 1 contains at most 12 sources with distinct handles. Each has a bounded
ID (256 characters), label (240), provenance (64), optional 64-hex revision,
nullable recorded/observed dates and host/target IDs. Current construction uses:

| Kind | Handle | Meaning |
|---|---|---|
| `note` | `N1` onward | The exact supplied note revision; `saved_at` is its save time. Provenance retains values such as `chat_ai`, `chat_user`, `user` or `user_confirmation`; an AI suggestion is not a confirmed fix. |
| `report` | `R1` | An owned saved diagnostic report, with `recorded_measurement` provenance, recorded host/target and `observed_at`. It does not assert a fresh check ran for this answer. |
| `document` | `D1` onward | The selected normalized text hash in both ID and revision, filename as label, `selected_document` provenance and the actual supplied line ranges. Completely omitted documents have no supplied-source handle. |
| `observation` | `O1` | The backend observation topic/resource, host and observation time, with `host_observation` provenance. Its companion `observation_context` retains freshness/coverage details. |

Note and document sources require a revision. Only documents have `ranges`, at
most 32 sorted, nonoverlapping `{start, end}` spans of one-based original lines.
Existing ordinary recall supplies at most eight notes; explicitly selected-note
questions at most four. The existing selected-document limit remains four.
These receipt bounds do not increase input budgets or change attachment rules.

`interpretation` is `ai` for model answers and `backend` for deterministic
observation answers. A note's saved date, user-confirmed outcome or historical
report is not evidence of current system health. An observation marked current
is current only within the existing 30-second window **when answered**.

### History provenance and completed references

`historical_notes` contains `checked`, `changed` and `unavailable`. Counts are
bounded to 0–512 and refer to eligible historical note references, not unique
notes or a complete archive audit. Inspection is bounded to recent saved turns;
only annotations in whole historical exchanges actually supplied contribute
change/unavailability counts. `checked: false` requires zero counts and means
no such inspection is established. It does not mean every historical source
still exists.

When both history and saved-note use permit it, the server compares eligible
owned reference revisions against current notes. Changed, deleted or newly
out-of-scope notes can annotate the supplied historical answer as historical and
unavailable for current attribution. This does not reconstruct deleted note
bodies, copy them into receipts, or rewrite the saved conversation. Current
target scope and the existing standalone-reference recall boundary still apply.
Saved-note opt-out performs no fresh note lookup for this inspection.

New receipts may add `historical_notes.references`, at most 256 entries. Each
contains `exchange_index` (1–32 within the retained supplied exchanges),
`note_id`, bounded historical `title`, the earlier 64-character revision hash,
historical `handle` (`N1`–`N8`), and `status: "changed" | "unavailable"`.
When present, its entries agree with the aggregate counts. An absent list on an
older receipt remains absent; aggregate counts do not manufacture references.
These handles belong to their historical exchange, not the current source list.
Render them as inert provenance labels, not trusted links or replacement notes.
No note bodies are retained in this extension.

### Recorded report facts

An owned selected report may add `evidence_context.recorded_report`, with
`version: 1` and `basis: "saved_report"`. Its `report_id`, `host.id` and
`target.id` must agree with the supplied `R1` source. The same projection appears
as response-only `recorded_facts` on diagnostic report endpoints; it is not
written back into the underlying encrypted diagnostic record.

The projection carries report kind, host/target identity, optional selected
process identity, recording/observation times, duration, completion status,
sample counts, up to 64 checks, up to six measurements and explicit limitations.
`status` is `completed`, `partial`, `stopped`, `failed` or `unknown`. Unknown
fields remain null. `raw_samples_included` is always zero. Measurement entries
have a canonical key, label, scope, unit, valid sample count, mean, minimum and
maximum; host CPU and selected-process CPU are separate whole-host-capacity
percentages. Memory values use bytes. Performance aggregates are recomputed
from valid recorded samples, not inferred from free-text findings.

This is historical source evidence. Sampling completion does not prove that an
application's task finished or a repair succeeded. Conflicting nested host
identity cannot supply process measurements for another computer. Clients must
validate source binding and numeric/count consistency before presenting this
card as recorded facts; malformed facts must not become an empty successful
report. AI prose remains interpretation. Opening report history is read-only;
including a report in a new Chat request remains explicit.

Explicit selected-report summary questions can use the existing
`handled_by: "recorded_outcome"` path with backend interpretation and no model
call. Existing JSON fields, SSE event names and earlier receipt formats remain
valid; consumers may ignore these optional additions.

### Citation validation

`citations_checked: false` means unfinished reference checking; `citations` must
be empty and `invalid_citations` zero. After the full reply, the server checks
recognized source-reference forms against the final supplied-source set. It
retains at most 32 distinct valid `{reference, handle}` pairs and a bounded
invalid-occurrence count (0–10,000):

- `[N1]`, `[R1]` and `[O1]` must identify a supplied source of the matching kind.
- A document citation such as `[setup.md:L12-L16]` must name the exact supplied
  filename and fit wholly inside one included range. It cannot span omitted
  lines; a bare `[D1]` is insufficient.
- Invented handles, wrong filenames and out-of-range recognized references are
  unverified model text. Zero invalid references is not a guarantee that every
  claim has a citation or that every possible citation syntax was recognized.

These are source-identity and range checks, **not** factual entailment, verified
quotes, answer correctness or permission to act. The UI keeps citation-shaped
model links untrusted while streaming. Completed source controls open the
current note or saved report through existing authenticated readers without
attaching it to Chat, sending a message or running another check. A later changed
or missing source is handled by that reader; historical answer text stays intact.

### Transient state, persistence and older clients

Initial metadata can identify the provider or handling mode without evidence.
Merge later `meta` fields by key; do not fabricate an empty-source receipt from
an omitted field. Final metadata carries the completed source receipt before
`done`, after the successful reply has been saved. Treat it as provisional UI
state until `done`: an `error`, disconnect, EOF or session-lock transition must
not leave a partial answer displaying completed/verified source controls.

The optional receipt is projected when saved turns reopen. No document bodies,
decrypted note bodies or historical reconstructed text are stored in it; ordinary
saved questions/replies may themselves contain quotations. Invalid retained
receipts are omitted. Old turns without `evidence_context` remain readable and
are not retroactively assigned handles, freshness or provenance. Existing
`source_ref`, `note_context`, `document_context`, `memory_context` and
`observation_context` retain their separate contracts. Endpoint URLs, SSE event
names and persisted store versions are unchanged; older clients may ignore this
extension.

Completed persisted responses can additionally expose `source_ref` for the
assistant and `user_source_ref` for its user turn. Each pointer contains
`conversation_id`, `message_index` and a 64-hex `revision`. History GET returns
the corresponding `source_ref` on each eligible message. These pointers permit
authenticated review through `/api/intelligence/memory/from-chat/preview` and
explicit `/save`; they contain no source text and grant no access by themselves.

Check non-2xx responses before parsing. Never automatically replay chat POSTs
or switch transports after ambiguous failure: chat can execute actions.
Cancellation does not imply an already accepted device action was undone.
Let the user inspect state and explicitly submit again. Refresh read state on
reconnect. Native transport events carry request IDs and ordered headers/chunks
so stale callbacks cannot update another conversation.

## Other transports and compatibility

`POST /api/ai/chat` is the JSON counterpart with `reply`, `session_id`,
`conversation_id`, `provider`, `model`, and `elapsed_ms`.
`POST /chat` retains the LM Studio path with `reply`, `conversation_id`,
`model_used`, and `brain_used`. Choose the route before submitting;
an explicit new submission is required after an ambiguous failure.

`GET /api/ai/chat/stream` remains for existing browsers. Native clients use
authenticated POST so prompts and credentials are not placed in URLs.
Images never silently fall back to text-only inference or mesh forwarding.
The GET compatibility route accepts the optional `use_conversation_history`
boolean query parameter with default `true`; new clients should keep using POST.

## Explicit Notebook questions

The three existing POST chat endpoints accept optional
`note_refs: [{"id":"owned-note-id","revision":"64-lowercase-hex-revision"}]`,
with at most four distinct references. GET streaming does not accept these
attachments. Obtain revisions from the existing authenticated memory list;
changed/deleted/foreign notes are rejected before inference or action routing.

Notebook questions cannot combine photo/screenshot, device, diagnostic report
or Vault-secret context. Only the current question and selected note bodies
are provided; implicit history/memory and action/tool paths are bypassed.
Bundled requests use the existing AI routes. Selected LM Studio requests use
`POST /chat` with `brain: "lmstudio"`. Failed note questions are not retried or
forwarded to another provider or mesh peer.

Successful JSON replies and stored assistant turns can include:

```json
{
  "note_context": {
    "notes": [{"id":"f-note","title":"Spare SSD location","revision":"…","source":"user","category":"general","updated_at":"2026-09-06T12:00:00Z"}],
    "actions_performed": false
  }
}
```

This is bounded reference metadata, without note bodies. Optional `device_id`
identifies a saved association; a missing date stays unknown. Streaming emits
`note_context` in a second `meta` frame after successful persistence and before
`done`. Interrupted/failed responses do not receive a completed note receipt.
Render it as **Notes provided to AI**, not proof of current device health or of
the model's faithfulness. See [Notebook details](HOUSEHOLD_NOTEBOOK.md).

## Explicit document questions

The three existing POST chat endpoints accept optional
`documents: [{"name":"setup.md","text":"User-selected UTF-8 text"}]`.
Up to four distinct `.txt`/`.md` filenames and 64 KiB of combined UTF-8 text are
allowed. GET streaming does not accept document attachments. The backend rejects
invalid files and incompatible note/image/device/report/Vault context before
inference or action routing. Only the current question and selected document
text are provided; actions, tools, implicit history and memory are bypassed.

Before a document POST, the desktop client requires authenticated
`GET /api/ai/documents/capabilities` to return
`{"ok":true,"protocol":"tli-document-questions-v1"}`. An unavailable or older
backend must not receive the document question as an ordinary chat request.

Use bundled AI through the existing AI routes or explicitly selected LM Studio
through `POST /chat` with `brain: "lmstudio"`. Document questions do not retry
against another provider or forward through mesh. Failed or interrupted sends
must retain their selection for explicit retry.

Successful JSON replies and assistant history entries can include:

```json
{
  "document_context": {
    "documents": [{"name":"setup.md","sha256":"64-lowercase-hex-characters","line_count":3,"chars":82}],
    "actions_performed": false
  }
}
```

Hashes cover text with line endings normalized to LF. `chars` is the Unicode
character count; `line_count` counts LF-delimited lines, including a trailing
empty line. No document body is stored in this receipt. Normal questions and
AI replies are still saved, and a reply may quote the source text.

Streaming first identifies `handled_by: "documents"` and the provider. After
successful persistence it emits a second `meta` with `document_context`, then
`done`. A failed/interrupted response must not receive a completed receipt.
Merge metadata frames and display **Documents provided to AI**. Numbered citations
in the answer are model output; the optional v1 evidence receipt checks supplied
source identity and ranges, not the truth of a claim. Earlier
clients may ignore this optional metadata; existing events and fields remain.

When selected documents require excerpts, each document may additionally contain
`coverage: {mode, selection, ranges, included_lines, omitted_lines}`. `mode` is
`full`, `excerpts` or `omitted`; `selection` is `full`, `question_terms`,
`representative` or `none`. Ranges are sorted, nonoverlapping original
`{start, end}` line numbers, at most 32 per document. Included plus omitted counts
equal the original `line_count`. Hashes and character counts still describe the
entire normalized selected document. Coverage contains no document body. Missing
coverage on older receipts does not prove which passages a previous model read.

Excerpt selection happens before transport and is refitted to the selected
runtime's budget. Only whole lines are supplied, with explicit omission guidance.
An oversized single line can still be rejected. Endpoint URLs, protocol capability
version and SSE event names are unchanged.

Reviewed chat saves accept optional `note_id` and `expected_revision` on the
existing `/api/intelligence/memory/from-chat/save` endpoint. Both identify an owned
current note that the user deliberately reviewed. Missing/stale revisions reject
updates; successful updates retain the note ID and creation time, return
`updated_existing: true`, and record the newly reviewed chat provenance. They do
not carry a historical diagnostic-confirmation badge onto the replacement text.

The browser's waiting/first-text/completion measurements are local, per-response
presentation state. They add no SSE fields, background probes or server-duration
claims. A stopped browser response does not attest to server-side cancellation.

New ordinary-answer `conversation_context` receipts may include
`recall_scope: {target_id: string|null, standalone_reference: boolean}`. This is
bounded server-written context metadata, not an action target. Follow-up recall
checks matching scope and excludes standalone reference exchanges. Existing
receipts without it remain valid; a previous selected computer is not guessed.

## Observed answers and text budgets

Specific host-status questions can return `handled_by: "observed_status"` with
`provider: "tli-tools"`. This is a deterministic observation, not proof that an
AI runtime is online. Do not set model readiness from such a reply.

Its additive `observation_context` contains `schema_version: 1`, `topic`,
`host: {id, name}`, `resource`, `source`, `observed_at` (nullable), `checked_at`,
`status` (`current`, `stale`, `unknown` or `unavailable`) and `coverage`.
`current` means within the existing 30-second window **when answered**. It is not
a continuing health assertion when reopened later. Observation replies do not
retrieve notes/history or run inference. Source text is data, never HTML.

Successful text inference may include an additive `input_budget` receipt with
`version: 1`, `provider`, `model`, `capacity_status`, `context_tokens`,
`capacity_source`, `reserved_output_tokens`, `character_limit`,
`input_characters`, `input_utf8_bytes`, `estimated_input_tokens`,
`formatting_allowance_tokens`, `estimation: "heuristic"`, `fit`, and `checked_at`.
Configured capacity uses `capacity_source: "owned_runtime_launch"` and
`fit: "estimated"`. Unknown capacity uses a null context size and `fit: "unknown"`.
These are planning estimates, not exact tokenizer counts or answer-quality checks.
Image inputs are outside this text-only accounting.

The final formatted text for document questions also passes the shared
12,000-character ceiling and any applicable configured-context estimate,
including the answer reserve. The existing 64 KiB upload-validation limit is not
a promise that every accepted upload fits an inference request.

Merge these optional fields from ordinary `meta` frames. Complete budgets are
emitted after successful persistence, before `done`. Internal provider-budget
frames are not new client SSE event names. Old clients can ignore the fields;
malformed retained receipts are omitted. An error or missing terminal event must
leave any displayed partial answer marked incomplete, with no automatic replay.

## Game Optimizer specialist stream

`POST /games/ask` is a separate, authenticated, text-only specialist route.
It does not run chat intents, actions, diagnostics, web lookup, memory retrieval
or mesh forwarding. The main chat frames documented above are unchanged.

The gaming client first reads `GET /games/advice_provider?provider=bundled` (or
`lmstudio`) to review the selected model and receive `provider_key`. This reads
selection, not readiness (`readiness: "not_tested"`). Additive `inference_host`
is the endpoint hostname only, without credentials, port, path or query. The UI
distinguishes this from the computer being analyzed; loopback means the computer
hosting TLI, which may differ from the browser's computer.

The request supplies that key plus `provider`, `game_name`, `preset`, optional
`question`, reviewed `system` hardware, `current_settings` with its exact
`config_game_name`, `corrections`, and optional same-game `history`. Corrections
contain CPU/GPU labels, RAM GB, playing resolution, target FPS and observations.

`GET /games/config_read` additionally returns `advice_controls`, a small quality
setting vocabulary from the three installed readers. `manual_values` maps those
keys to a listed current value; an empty string explicitly means Unknown.
For other games, `custom_settings` accepts named quality settings and optional
Low/Medium/High/Ultra current values. These menu options are marked unverified.
`avoid_settings` excludes up to six setting keys when the user chooses different
settings for a follow-up. The frontend includes only the latest completed
same-game advice when its history checkbox is selected. No gaming history is
persisted. None of these fields applies game settings.

When GPU or playing resolution is absent, the route returns a local
`meta.source: "context-needed"` response naming missing details without inference.
This clarification is not retained as AI advice.

The route validates field bounds and the complete formatted input budget.
Different-game settings/history are excluded. A changed model or endpoint
requires another selection review; no model starts, switches or provider
fallbacks occur. Legacy clients may omit the key and bind the selected provider
at preparation time. Selection and budget are rechecked before transport.
LM Studio responses identifying a different model are rejected.

The model selects and orders one to three exact candidate IDs in bounded JSON.
Raw model prose and partial JSON are never displayed. The backend validates
every choice before producing `meta.settings_plan` and rendered `t`. Current
values and provenance come from matching read data or explicit user values;
unknown stays unknown. Suggested values, rationale and tradeoffs come from the
candidate catalogue, not model-generated facts or benchmarks. The catalogue
prevents lowering known quality for Better visuals. Known-game rendered plans
and current-value controls explicitly ask the user to confirm reader-vocabulary
options exist in the installed game version. Visual-quality rationale identifies
known hardware without claiming measured headroom. Unknown current values
require checking direction before any trial. `settings_plan` items include
`id`, `key`, `label`, nullable `current`, `current_source` (`read`, `user`,
`unknown`), `suggested`, `scope`, `reason`, and `tradeoff`.

Frames retain the existing gaming format, with additive plan metadata:

```text
data: {"meta":{"source":"ai-advice","provider":"bundled","model":"standard","game_name":"Cyberpunk 2077","candidate_count":5,"history_count":0,"input_budget":{}}}

data: {"meta":{"source":"ai-advice","settings_plan":[{"id":"shadow_quality=Medium","key":"shadow_quality","label":"Shadow Quality","current":"High","current_source":"read","suggested":"Medium","scope":"installed reader vocabulary","reason":"A workload-reduction trial; the bottleneck is not established.","tradeoff":"Reduced shadow detail."}]}}

data: {"t":"1. Shadow Quality — High (read from this game) → try Medium. ..."}

data: [DONE]
```

On failure, no raw model output is emitted. An error is followed by the terminal
marker:

```text
data: {"error":"The AI could not produce a reliable settings plan.","meta":{"incomplete":true,"source":"ai-advice","received_text":false}}

data: [DONE]
```

`[DONE]` terminates delivery and does not override an earlier error. Clients
require nonempty text, a terminal marker and no incomplete/error frame before
presenting completed advice. The previous answer and draft survive failure or
Stop. Provider errors are explicit. The legacy nonstream `/games/recommend`
uses the same validator for AI advice and can still return its clearly labeled
fixed checklist if generation fails. Neither route measures attainable FPS.


## Explicit LAN inference (text chat)

`POST /api/ai/chat` and `POST /api/ai/chat/stream` accept optional
`lan_inference: {peer_id, trust_revision, resource_id, resource_revision}` from
the authenticated `/api/ai/lan/models` response. The browser explicitly checks
one reviewed peer; the host never automatically discovers or selects a worker.
Existing grants do not acquire the new `inference` permission automatically.
Both computers must review that permission. Unsigned `/tli/ai/chat` is retired
with HTTP 410; old mesh preferences cannot authorize sharing.

The primary TLI prepares the owned conversation, saved notes and current
context using the existing sharing settings. Device intents (including Shelly)
and factual fast paths run there first. Only prepared text goes to the signed
peer worker. Selected images, documents, standalone note/case references and
Vault secrets are rejected before preparation for this first slice.

Streaming uses the existing `meta`, `delta`, `done`, `error` format. The first
metadata includes `provider: "lan"`, `handled_by: "lan_inference"`, `model`,
`session_id`, `conversation_id`, and `inference_host: {id, name}`. `host` keeps
identifying the host whose context was supplied; it is not relabeled as the
compute worker. The final metadata carries locally computed context receipts
and source references after the complete assistant answer has been persisted
on the primary. Reopened conversation turns preserve `inference_host`.

A successful explicit upstream completion is required for `done`. An error,
missing completion, stale model, revoked grant/session or interrupted connection
ends with `error` and no `done`, completed-answer receipts or assistant turn.
There is no retry, local/cloud fallback or model lifecycle call from TLI. For
strict no-start behavior, disable LM Studio's Just in Time Model Loading setting;
TLI cannot atomically control unloading/reloading in that external runtime. The
user turn may already be saved. Nonstreaming uses the same pipeline and returns an
HTTP error on failure. Ordinary GET EventSource chat remains a local route and
does not accept a LAN selection.

The worker endpoint `/agent/peer/inference/stream` is a separate stateless,
signed HTTPS protocol, not a chat/session endpoint. It accepts bounded text
messages and produces only model metadata, text deltas and explicit completion.
It cannot call tools, execute device actions or access either user's saved
conversation. See [TLI LAN intelligence](TLI_LAN_INTELLIGENCE.md) for setup,
limits and the physical two-computer acceptance checklist.

## Detached host runs

Clients advertising `tli-runs-v1` submit Chat through `POST /api/runs` with a
durable `request_id` and the existing Chat payload. The host consumes the same
`meta`, `delta`, `done`, `error` events independently of the client connection.
`GET /api/runs/{id}/events?after=N` assigns monotonically increasing SSE IDs to
those events. A `snapshot` event contains current status/text/metadata/result
when the bounded replay buffer no longer covers the supplied cursor or only a
durable terminal result remains. A disconnected subscriber never cancels work.

`POST /api/runs/{id}/cancel` explicitly requests cancellation. Lost acceptance
responses are recovered by GET using the original request ID; clients must not
create a new request automatically. Restarted hosts mark unfinished work
`interrupted`, without replay. Settings and owner boundaries are documented in
[the shared workspace contract](TLI_SHARED_WORKSPACE.md).
