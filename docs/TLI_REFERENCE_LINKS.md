# Related notes and explicit note relationships

These are two optional ways to find and organize Notes & fixes. Neither changes
the ordinary Chat memory setting or silently follows links into another source.
Vault notes remain separate.

## Related notes

Open Notes & fixes, then **Related notes**. Select up to 64 existing whole notes,
review the exact text and loopback embedding server, build a temporary index and
explicitly submit a search. Opening the screen or reviewing sources does not
contact the embedder. It never installs a model or switches TLI's selected model.

The existing embedding server is configured by its exact model ID and loopback
port on the TLI host. Optional server tokens stay in memory; submitting them
requires HTTPS or opening TLI directly on its host. This browser workflow does not
accept Companion bearer authentication. The server controls any model loading or
onward processing. The OpenAI-compatible request format is documented by
[LM Studio](https://lmstudio.ai/docs/developer/openai-compat/embeddings).

The index holds vectors and source identifiers/revisions, with a maximum of four
host-wide indexes, two embedding operations, 64 KiB of reviewed text and 4096
vector dimensions. It expires after 30 minutes. Explicit deletion, note changes,
session revocation and restart invalidate derived state. Source text and queries
are not persisted by this search. Existing source notes remain in their normal
encrypted store. An external embedding server has its own retention policy.

Model-name and vector-consistency checks detect some provider changes; they do
not identify model weights or certify search quality. Results are at most eight
similarity candidates, never confidence scores. Device-associated notes require
the exact selected device. Opening a candidate uses the current saved-note view,
without attaching it or sending Chat. Ordinary **Use saved notes** remains the
existing deterministic lexical selection and opt-out flow.

Verified with 54 synthetic backend checks and 289 relevant memory/authentication
regressions, plus browser/controller reports under
`build_work/anniversary-completion/note-search-browser`. Real embedding-model
quality and a configured user server are **not run**.

## Linked notes

Saved notes can explicitly reference up to eight other owned notes as a related
detail, correction reference or different experience. A link stores the target ID,
reviewed revision, relationship and time, not a copied body or title. It is a
user-recorded association; it does not prove a correction, suppress another note
or establish present computer health.

Changed targets are marked changed. Deleted or inaccessible targets have no body
or title reconstructed. Existing historical pointers can be retained or removed;
new pointers require the current owned revision. Incoming references are bounded
and displayed separately. Source edits and relationship updates share revision
checks, preventing one editor from overwriting another silently.

Storage adds only optional `note_links` metadata to the existing encrypted note
record. Old records retain their old revision calculation. Current edits preserve
links. Both existing backup versions include the metadata; current recovery
readers verify it in a separate installation without modifying source files.
No new key or source store is introduced.

The 16 relationship checks plus existing backup/readback tests passed together:
87 tests. Browser controls now pass the Notes & fixes regression set and all
23 themes, with explicit source/target revision review, unsaved-edit protection,
conflict retention and session cleanup. The real SPA also uses schemas from the
isolated authenticated backend. The gallery and exact report hashes are in
`build_work/anniversary-completion/notes-review.html` and `notes-coverage.json`.
Whole-release verification is recorded separately in the completion program.
