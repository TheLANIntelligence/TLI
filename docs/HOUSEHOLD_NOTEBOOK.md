# Notes & fixes

The anniversary notebook makes TLI's existing encrypted memory useful from
desktop and the native Companion. It stores information the user deliberately
saves: supplies, equipment locations, preferences and confirmed fixes. These are
saved notes, not proof of current device state. The browser destination is now
**Notes & fixes**; Notebook, Saved notes and memory remain search aliases and
internal identifiers remain unchanged. Access follows the current TLI account.
When PIN protection is disabled, local access shares one owner.

## Everyday use

Open Notes & fixes from the sidebar, Chat, Settings or search. Keep setup details,
preferences and past fixes so you can refer to them later. Setup detail,
Preference and Fix to remember starters open unsaved drafts; only explicit
saving writes a note. The fix starter never creates a Confirmed fix badge.
Drafts survive Back, Close and opening another note in memory, offer explicit
discard, and clear on session lock. Search by title or text, create a note,
correct it, or review its deletion. Device association is optional and uses the
existing inventory. The editor shows source and saved times; unknown dates stay
unknown. Older facts remain available without re-importing or changing keys.

**Use saved notes** preserves its existing default. Ordinary chat may include
relevant notes when enabled; disabling it does not remove earlier conversation.
Vault notes are a separate passphrase-protected store.

Choose up to four notes for a question, then review the attached notes in Chat
and press Send. Selecting notes never submits a question. Notebook questions
stand alone: remove photo, device, report or vault-secret context first. They
provide only the chosen notes and current question through the configured
bundled or LM Studio route, without executing device commands or diagnostics.

The answer's **Notes provided to AI** receipt identifies the supplied note
versions and their dates. It establishes what was provided, not whether the
model interpreted it faithfully. It survives reopening the shared conversation
on desktop and Companion. Opening a referenced note shows its current version;
edited or deleted notes are distinguished from the historical reference.

## Dependability and privacy

- An opaque revision binds each edit, deletion and chat attachment to the note
  the user reviewed. Concurrent edits fail with a conflict instead of overwriting
  a newer change. Changed or deleted attachments must be reviewed again before
  inference; no automatic retry is made.
- Validation checks ownership, versions, combinations and a bounded text budget
  before inference, proxies, tools or action handling. Private note questions
  are not sent through mesh routes that cannot preserve their local scope.
- Note content is reference data, never tool instructions. A note question uses
  no action or diagnostic fast path, even if the question or saved text contains
  a command-like phrase.
- Failed requests preserve the editor or chat selections for an explicit retry.
  Pairing/session changes clear private client state. No new plaintext note
  store is added to browser or phone storage.
- The existing per-user encrypted memory envelope, note IDs and keys are kept.
  An unreadable store returns an error; the notebook refuses to overwrite it.
  Optional titles and display metadata require no migration. Untitled legacy
  facts are labelled “Untitled note”; missing dates are not invented.
- Historical receipts contain bounded metadata, not another copy of the note
  body. Deleting a note removes it from retrieval, but it does not erase existing
  conversation answers or their historical source labels.
- Unowned legacy device memories retain their existing PIN-disabled local-only
  access rules. They must be explicitly edited into owned memory before use as
  a reviewed notebook attachment.

## Interfaces

Existing `/api/intelligence/memory` GET/POST and `/memory/{id}` PATCH/DELETE
remain. Notes add optional `title` and computed `revision`. New editors submit
`expected_revision` on PATCH and as a DELETE query parameter. Older clients can
omit it; their existing request formats still work.

The three existing chat POST endpoints accept optional
`note_refs: [{"id": "…", "revision": "…"}]`. Successful JSON/SSE metadata and
stored assistant turns may include:

```json
{
  "note_context": {
    "notes": [{"id": "…", "title": "Spare SSD location", "revision": "…", "source": "user", "category": "general", "updated_at": "2026-09-06T12:00:00Z"}],
    "actions_performed": false
  }
}
```

Existing endpoint URLs, SSE names and ordinary text/image routing remain.
Install matching backend and client code when using the new attachment option;
an older backend cannot provide its validation contract. Existing Companion
build artifacts do not update themselves when its source changes.

## Verification

Baseline carried from the preceding checkpoint: 410 backend, 83 desktop and 35
Companion tests passed, with native typecheck and iOS/Android JavaScript exports.
No baseline failures were recorded.

- **478 backend tests passed**, including 68 new Notebook cases covering owner
  isolation, revisions, concurrent edits/requests, encrypted and legacy formats,
  corrupt or unreadable storage, missing keys, context validation, provider
  failures and incomplete streams. Existing deprecation warnings remain (821
  warnings in the complete run); these are separate from test failures.
- **105 desktop tests passed**, including 22 new cases for the Notebook editor,
  explicit attachments, stale-session cleanup, failure recovery, receipt/history
  rendering, rejecting malformed mutation confirmations, merging stream metadata
  and preserving LM Studio selection without provider fallback.
- **46 Companion tests passed**, including 11 new cases. TypeScript checking
  passed. iOS and Android Hermes exports completed in the ignored
  `mobile/.expo/verification-notebook-20260906` directory. These are JavaScript
  verification bundles; existing installable native builds were not replaced.
- Desktop fixture checked at 1440 × 900; the web Notebook dialog at 390 × 844
  stays within the viewport and scrolls vertically. The Companion browser
  fixture also fits 390 × 844 without horizontal overflow. UI checks exercised
  creating/searching notes, explicit attachment, successful and failed questions,
  opening a receipt, and distinguishing edited notes from historical references.
- Automated checks used temporary persistence and fake providers. No real model
  was downloaded, switched or queried, and live TLI was not restarted.

The isolated desktop preview is `backend/tests/notebook_preview.py`, serving
loopback port 8772. It establishes temporary persistence before app imports,
seeds sample notes, disables live networking/background integrations, and uses
fake model responses. “Simulate failure” in a question exercises response
failure without contacting a model. Native browser QA uses Companion's existing
sample transport.

Physical iPhone/Android keyboards, accessibility, pairing and actual model
answer quality remain separate acceptance checks. Source tests and JavaScript
bundle exports do not establish those guarantees. No live model, device,
personal-data migration or installation restart is required by automated checks.
