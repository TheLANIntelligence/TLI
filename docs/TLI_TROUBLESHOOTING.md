# Troubleshooting: saved problems and reviewed evidence

Troubleshooting keeps an ongoing problem, the computer involved, saved evidence,
steps you planned or tried, and the improvement you confirmed together. It is an
account-scoped journal shared by the browser and supported Companion clients.
It does not diagnose a computer, rerun a report, send a chat message or operate a
device when opened or saved.

## Everyday use

Open **Troubleshooting**, choose **Start a problem**, and describe the symptom.
Selecting a computer records which computer is involved. It does not retarget
other tools. Add planned, tried or skipped steps and record their outcomes.

### Review and run an available check

The current workspace follows **Describe → Choose computer → Review a check →
Run → Review evidence → Record what helped**. **Review available checks** retrieves
authenticated capability choices; it does not run them. Each review identifies
the executing TLI host, measured target and scope. Optional internet checks name
their external contact before the user enables them.

System and network checks run on the TLI host. A registered device check measures
TCP reachability from that host, not remote CPU load, application behavior or a
working printer. Performance & apps starts a separate, explicit observation of
one selected host process. The phone can review saved performance reports; it
does not start desktop process sampling from its guided-check screen.

**Run this check** saves a diagnostic report independently of the problem. Review
the report before adding its link to the draft, then use **Save problem**. If the
report exists but the problem save fails, the view says **Report saved; problem
link not saved**. Keep the draft, review the conflict or failure, and save
deliberately. Neither saving nor reconnecting repeats the diagnostic.

Guided requests bind the expected host and reviewed scope. A host, target or scope
change rejects before measurement. In-flight duplicates do not run twice; saved
request receipts allow an explicit retry to retrieve the successful report even
after a host restart. An uncertain failure requires reviewing history and making
a deliberate new request. Closing a view does not cancel a server-side check.

Use **Link to a problem…** on a saved note, a diagnostic report or a completed
saved chat message. The explicit link action checks ownership and the source's
current revision. It adds a pointer to the open problem draft; **Save problem**
is a separate action. To add evidence to an existing problem, open that problem
first, then open its source and use the link action.

Evidence carries its original identifier, reviewed revision, display label and
linking time. It contains no copied note text, report body, conversation body,
password or file attachment. “Matches saved source” means the saved source still
has that revision. It does **not** mean a computer is healthy now. A changed or
missing source remains visible as a historical link. **Review latest source**
explicitly replaces the draft pointer, and another save is required to keep it.

Opening a linked source uses its existing note/chat view, or the separate
read-only report viewer. It does not attach the problem or its evidence to AI.
Existing chat draft/generation guards still apply. No whole-problem chat context,
automatic checks, automatic repair or learning is introduced.

**Resolved** requires an account of the improvement you personally confirmed.
This records your conclusion; it neither certifies current health nor creates a
verified fix in Notes & fixes. Archive hides a problem from active lists while
keeping it. Removing a problem requires an explicit review and never removes its
linked source records.

## Drafts and failure behavior

Browser drafts stay in memory across panel changes and backgrounding. They are
not browser-persisted, are not backed up, and clear when TLI locks or the page is
left. Failed saves retain the draft. A revision conflict never overwrites another
view's saved changes: explicitly discard the draft before reloading the saved
version. The user can keep the draft while reviewing the conflict message.

Reads arriving after a view closes, a newer read, or a lock cannot replace a newer
draft. Closing a view does not imply a server write was cancelled. Create request
identifiers are stored as hashes so deliberate retry of the same creation returns
its saved record instead of creating a duplicate. Reusing that identifier for
different details, or after its case was removed, is rejected. Updates and deletes
require the exact current revision; they are never automatically retried.

## Persistence and ownership

The new store is `data/intelligence/cases-<sha256(account)>.json`. Its normal TLI
AES-GCM envelope uses the host's protected `memory_key.bin` and associated data
`cases:<account>`. The store contains `version: 1`, a `cases` array, and a bounded
`creates` map of hashed request receipts. It does not change existing encrypted
formats. The memory-key preservation guard now recognizes case stores, including
when they are the only remaining encrypted payload. Missing keys, unreadable
stores and failed writes do not silently create an empty replacement.

Only sources owned by the authenticated account may be newly linked. The existing
`local`/`bundled-ai` conversation compatibility rule is retained. A removed
computer's previously saved snapshot and unchanged historical links can survive
unrelated edits. Changing the selected computer or an evidence pointer requires
validation again. With the access PIN off, browser visitors share the `local`
account; this feature creates no new account isolation promise.

Initial limits: 200 retained problems, 1,000 creation receipts, 30 steps and 32
evidence links per problem, and 16 MiB for the decrypted store. No automatic
record deletion or receipt eviction occurs when a limit is reached. Title and
symptom limits are 120 and 4,000 characters; step text/outcome limits are 1,000 and
2,000, and resolution text is limited to 2,000 characters.

## API contract

All routes require the existing session authentication and return `Cache-Control:
no-store`. Successful JSON responses include `ok: true`, `protocol:
"tli-cases-v1"`, `checked_at` and `actions_performed: false`.

| Route | Meaning |
|---|---|
| `GET /api/intelligence/cases?status=open&q=…&limit=50` | Bounded account list. Status may be open, resolved or archived. |
| `GET /api/intelligence/cases/{id}` | Current saved problem, revision and evidence availability. |
| `POST /api/intelligence/cases` | Create with a nonempty `request_id` (maximum 128 characters). |
| `PUT /api/intelligence/cases/{id}` | Replace reviewed editable fields using `expected_revision`. |
| `DELETE /api/intelligence/cases/{id}?expected_revision=…` | Remove this problem only. |
| `POST /api/intelligence/cases/evidence/review` | Review `{kind,id,message_index?}` for an owned source, without saving a case. |
| `GET /api/intelligence/cases/capabilities` | Explicit protocol and supported backup format. |
| `GET /api/intelligence/cases/health` | Readability of this additional store; existing three-area data-health responses remain unchanged. |

Editable fields are `title`, `symptom`, `computer_id`, `status`, `archived`,
`steps`, `evidence` and `resolution`. A step has `id`, `text`, `status`
(`planned`, `tried`, `skipped`) and `outcome`. A submitted evidence pointer has
`kind` (`note`, `report`, `chat`), `id`, `revision` and, for chat, `message_index`.
The server supplies evidence labels and timestamps. Unknown fields and wrong
types are rejected. Response-only fields must not be submitted back as edits.

## Backups and separate-copy recovery

The new **Saved work** choice sends `format: "saved-work-v2"` to the existing
backup creation route. V2 has its own authenticated magic/version, protocol
`tli-saved-work-backup-v2`, strict manifest, scope `owner-saved-work`, and a
`cases.json` member alongside the original four members. Its source-format and
count metadata explicitly include `cases`. The envelope and manifest versions,
exact member set, checksums, counts, ownership and supported case structure must
all agree. There is no partial success for an unreadable case store.

Existing creation requests without that field still produce **v1** with the
original protocol, magic, entry list, source-format fields and three counts.
The earlier-format UI option explicitly excludes Troubleshooting. V1 archives
remain verifiable and recoverable; the UI says they do not contain problems.
Unknown archive versions or extra members fail closed.

Reviewed separate-copy recovery supports either format. For v2 it stages the
additional case store using fresh protected keys and `cases:local` associated
data, preserving IDs, dates, status, steps, outcomes, creation receipts and
evidence revisions. Archived ownership is explicitly mapped to the new `local`
owner, with original account metadata retained in the existing encrypted origin
store. Current readers reopen the staged case store in the bounded fresh-process
verification before the copy can be published. A v1 copy has the original six
encrypted payload/key files; v2 has seven. The exact layout is version-checked.

All existing destination, no-overwrite, reparse/race, token, disk-space and
readback checks remain in place. No source credentials, PIN, TLS identity, models,
application executable, Vault data or external files are copied. No copy is
activated, and source data is never merged. Frozen/native recovery remains
unsupported for this checkpoint; Windows browser/source checks do not establish
physical-phone acceptance or power-loss durability.

Performance observations and guided-check receipts use additive fields in the
existing diagnostic report store. Both v1 and v2 saved-work archives preserve
these fields. Current-application recovery checks cover the report IDs, partial
scope, zero readings and unavailable measurements while proving the original
encrypted files remain byte-for-byte unchanged.

## Verification

The latest guided-check, Performance, evidence and Companion verification is
recorded in [the dependable-troubleshooting checkpoint](TLI_DEPENDABLE_TROUBLESHOOTING.md).
The coverage below also remains useful historical evidence for the original
workspace and its preserved data format.

Isolated regression coverage includes concurrent duplicate creation, update and
delete conflicts, ownership, stale/deleted sources, removed computer snapshots,
missing keys, corrupt data, failed writes, authentication, archive format
negotiation, v1 preservation, v2 tampering and actual fresh-process v2 recovery.
Browser-controller tests exercise explicit reads/linking/saving, stale results,
draft retention, locking and late responses. The real SPA fixture checks Emerald
Light and Midnight at 1440, 1024, 390 and 320 pixels, including doubled text, and
records screenshots under `build_work/anniversary-continuity/troubleshooting-browser`.
All host responses and writes in browser verification are synthetic and
intercepted. No household data, live model or running TLI was used.
