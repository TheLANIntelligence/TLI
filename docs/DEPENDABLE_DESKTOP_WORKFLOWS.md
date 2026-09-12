# Dependable desktop workflows

This September 7 anniversary batch improves File Organizer, command-palette
shortcuts and questions about explicitly selected documents. Companion work
remains paused. This is a working-tree checkpoint, not a packaged release or a
restart of the live installation.

## File Organizer

Organize, bulk rename and undo show the exact source and destination paths
before confirmation. The backend rechecks the entire plan under the existing
file-mutation lock before changing anything. Changed files, duplicate paths,
collisions, protected locations, links and junctions prevent execution. TLI
does not overwrite a destination. Only ordinary files with a verifiable identity
are eligible; unsupported locations require the user's file manager.

New browser requests use owner-bound previews that expire after ten minutes.
Confirmation must match the reviewed operation and file identities. Repeating a
confirmed preview returns its receipt instead of moving the files again. A busy
operation is rejected for explicit retry, without starting a competing mutation.
The UI shows per-file success, failure, unknown outcome and partial completion.

Undo now requires the existing session authentication. It verifies the moved
file's identity and original destination before restoring it. Edited files,
replacement files and occupied original paths are preserved. Unresolved undo
records remain available; old records without identity evidence are preserved
but cannot be safely undone automatically. Recovery-record failures stop further
work and are reported; uncertain operations require manual inspection.

The existing `/file/organize`, `/file/rename` and `/file/undo` URLs and legacy
response fields remain. Additive fields include `ok`, `status`, `preview_id`,
`expires_at`, `can_execute`, `items`, `results`, `operation_id` and
`undo_available`. Existing `moves` and `renames` records remain readable with
additional identity and outcome evidence. Legacy direct confirmations still
receive the backend preflight; the current UI always previews first.
Before any preview or confirmation POST, the UI requires the authenticated
`GET /file/operations/capabilities` protocol response. An old still-running
backend must not mistake a new preview request for a legacy rename operation.

## Desktop shortcuts

- **Lock TLI** and the header lock use the same explicit browser-lock operation.
  It revokes the requesting browser's PIN cookie and hides the local session.
  Other browsers and Companion credentials remain connected. If server
  revocation cannot be confirmed, the lock screen says so and offers explicit
  retry. A host without a configured PIN cannot claim to be securely locked.
- **Lock Vault** and **Rotate Logs** await both HTTP and handler results. A log
  below the rotation threshold is described as unchanged, not rotated.
- **Review Temp Cleanup** opens the existing Storage review. It does not delete
  files. **Open Dashboard** and **Open Tools** describe navigation rather than
  claiming a refresh, repair or tool execution completed.
- Pending shortcuts remain guarded when the palette closes and reopens.
  Failures are visible and never retry automatically.

The authenticated additive `POST /system/pin/lock` endpoint revokes only the
current browser cookie session. It does not change PIN settings or saved data.

## Ask about documents

In AI Chat, choose **Ask about documents**, select files, review their text, then
choose **Use in chat** and write a question. Selecting or previewing a file sends
nothing. Documents come from the browser's explicit file chooser; the backend
does not open an arbitrary host path or search other folders.

The first scope is one to four UTF-8 `.txt` or `.md` files totaling at most 64 KiB.
Names must be distinct and bounded; invalid encoding, empty/binary content and
oversized input are rejected. Selected text stays in browser memory until used
or removed. New chat, page exit and session lock clear it. No document index,
embedding model, database, automatic extraction or persistent attachment store
is introduced.

Before sending any document question, the browser requires an authenticated,
uncached `GET /api/ai/documents/capabilities` response identifying the supported
document protocol. A page served by an older still-running backend will block
the send, rather than let that backend ignore the attachment and execute the
question as an ordinary chat command. The normal TLI restart is left to the user.

The existing bundled AI or selected LM Studio receives the current question and
numbered document text as untrusted reference data. This path bypasses actions,
tools, diagnostics, implicit memory and conversation context. Combining it with
Notebook, image, device/report or Vault context is rejected. It does not forward
documents through mesh or retry against another provider.
Document payload transports reject HTTP redirects. Malformed provider responses
fail without creating a successful document receipt.

The prompt asks for references such as `[setup.md:L2-L4]`. These are model-written
citations, not verified proof of an answer. Check them against the original file.
The full reference is sent without truncation; a model's smaller context limit
can require the user to select shorter excerpts. Real-model answer quality and
large-document performance were not evaluated in this batch.

Successful replies show **Documents provided to AI**, with filenames, line counts
and content hashes reported by the host. These are provenance metadata; the
browser does not independently verify their digests. Conversation history retains only this bounded attachment
metadata alongside the normal question and answer. Answers may quote document
text. The source attachment itself is not saved and must be reattached for a
later question. Failed or interrupted sends retain the selections and question
for explicit retry. Receipts are described in [the SSE contract](SSE_SCHEMA.md).

## Verification and limits

The recorded pre-batch source baseline passed 656 backend and 141 desktop
frontend tests; there were no recorded baseline failures. Its fingerprint was
`e4b428c6657303cb2f4aeaf1ccd5b69af8da48fb4d9350a0ab00f1465de34d4d`
in `build_work/release-snapshot-pa351kk9`. These historical checks are separate
from this batch's verification.

Integrated checks passed **857 backend tests** and **191 desktop frontend tests**.
The backend emitted 1,002 warnings (mostly deprecations) and no failures. Logs are retained
in `build_work/desktop-workflows-backend-tests-final.log` and
`build_work/desktop-workflows-frontend-tests-final.log`. Changed JavaScript files
also passed syntax checks.

Backend tests establish temporary persistence before application imports and fake providers,
hardware and device side effects. Browser checks intercept every network request
and use synthetic documents and operation results. They cover desktop and
390-pixel phone browser layouts; they are not native Companion acceptance.

Document browser fixtures passed at 1440 × 1000 and 390 × 844, including source
review, inert text, failed-stream draft retention, explicit retry, source receipts
and keyboard cancellation. Screenshots also cover dark and light themes. Evidence:
`artifacts/desktop-workflows/documents-2026-09-07T06-57-57-538Z/results.json`.
Shortcut fixtures passed at 1440 × 960 and 390 × 844, including duplicate requests
and lock failure/retry: `build_work/shortcut-qa-Chqgjq/report.json`.
File Organizer fixtures passed at 1440- and 390-pixel widths in light and dark
themes: reviewed moves, partial receipts, undo review, changed rename previews,
successful rename receipts and old-backend rejection. A demonstrated phone
layout issue was fixed: long reviewed paths now wrap inside the Files panel.
Evidence: `build_work/file-operations-qa-a1vna8/report.json`.

No real files were organized or renamed during testing. No live TLI restart,
model download, model switch, native build, store submission or production-data
upgrade was performed. Existing uncommitted work, installation data and previous
artifacts were preserved. Physical macOS/Linux file operations and real-model
document quality remain unverified.
