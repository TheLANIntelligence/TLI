# Reviewed troubleshooting exports

Open a saved Troubleshooting case and choose its export action. Review the exact
case revision, optional linked evidence, redactions and format before downloading.
The resulting HTML, text or JSON file is an **unencrypted historical account**,
not a backup, a fresh diagnostic or proof that a repair worked.

The default export does not copy every linked record. Evidence content is
separately selected and read only through the authenticated account's current
stores. Missing, changed or inaccessible evidence is identified rather than
reconstructed from deleted content. User reports, AI interpretation and measured
diagnostic results retain their different source labels.

Review is bound to the owner, selection, source revisions and preview hash for
ten minutes. Download revalidates those bindings. Editing the selection or
underlying record requires another review. Up to 32 evidence references and a
512-KiB output are supported. Oversized sources are rejected explicitly.

Identifier redaction and up to 40 user-entered terms help prepare a copy, but
cannot find every secret. Read the whole preview. HTML is escaped and shown in a
sandboxed, inert preview; it does not execute case text or archived scripts.
Source stores remain unchanged. There is no automatic sending or publication.

Failed replacement previews retain the previous view. Duplicate download clicks,
session changes, delayed responses and closing/reopening dialogs have explicit
guards. Lock clears the private view; closing a dialog does not claim to cancel
already submitted server work.

Implementation: `backend/intelligence/case_exports.py`, its router and
`frontend/js/case-exports.js`. Isolated ownership/revision/size/redaction tests
and the actual-SPA browser fixtures are retained under
`build_work/anniversary-completion/case-exports-*`. The integration audit adds
the queued-close and delayed-authentication regressions. Live cases, household
data and physical sharing were not used.
