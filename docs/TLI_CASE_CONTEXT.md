# Reviewed troubleshooting context

In Troubleshooting, save the case and choose **Ask about this case…**. Desktop and Companion show the current saved title, symptom, computer, steps, resolution and linked-source availability. Select up to eight whole steps, optionally the user-recorded resolution, and up to eight evidence-link descriptions. Nothing optional is selected by default. Acknowledgement attaches the selection to the composer; it does not send a message or run any step.

Title, symptom, computer identity and saved status are always part of the reviewed selection. Link descriptions contain identity, reviewed revision, label and whether the source is current, changed or unavailable when prepared. They contain no note, report or conversation bodies. A label is not evidence that a fix worked. Earlier chat, automatic saved-note recall, other attachments, Vault context and action modes are excluded from this standalone question. Other selected context must be explicitly removed; it is never silently discarded.

The host checks the authenticated owner, current case revision and every selected pointer before preparation. A changed case returns a conflict; another account's case remains unavailable. Missing encryption keys or unreadable data remain errors and are not replaced. A large selection must fit whole within the existing text budget; TLI asks for fewer selected items instead of truncating a step or outcome. Saved cases and linked stores are unchanged by preparation.

Narrow completion and past-fix questions receive deterministic, dated summaries of the selected user records. Planned and skipped steps are not recorded as tried; a tried step without an outcome cannot establish success. A case marked resolved and its selected resolution describe the user's historical account, not an independently verified repair or present health. Other questions use the explicitly configured local provider with the same selected-only context and input limits. No case text is forwarded through a mesh fallback.

Each completed answer records metadata-only `case_context` and source `C1` in `evidence_context`. The receipt includes the selected case revision, saved time, selected step IDs/statuses, included/omitted counts, resolution inclusion and link availability. It contains no symptom, step bodies, resolution body or linked source bodies. The answer itself may quote supplied details and is retained in the normal encrypted conversation store. Old receipts identify the historical selection; opening the current case does not rewrite them.

Desktop and Companion retain the selected context and composer question after a failed send or revision conflict. A successful receipt must match the exact requested case revision, step order, resolution choice and link pointers before clearing the selection. Cancelling a review cannot attach it through a late response. Lock, pairing changes and background transitions invalidate pending private review results; Companion also clears the selected case. No retry or send occurs automatically when returning to a view.

## Integration contract

`GET /api/intelligence/cases/capabilities` advertises `case_context: "tli-case-context-v1"` alongside the existing `tli-cases-v1` protocol. Clients require this fresh capability before sending; older hosts fail closed.

Bundled JSON/SSE chat and `/chat` accept:

```json
{
  "case_ref": {
    "id": "case-<32 lowercase hexadecimal characters>",
    "revision": "<64 lowercase hexadecimal characters>",
    "step_ids": [],
    "include_resolution": false,
    "evidence_refs": []
  }
}
```

Evidence references retain the existing `{kind,id,revision,message_index?}` contract. The optional message index applies only to chat links. References must already belong to this reviewed case; arbitrary source IDs cannot extend its scope. `handled_by` is `case_outcome` for deterministic recorded conclusions and `case_context` for model interpretation. These responses never add a fresh observation receipt.

## Verification boundaries

Tests use synthetic encrypted stores, fake model providers and the real chat send controllers with intercepted transport. They cover all three routes, ownership/revision conflicts, missing keys/corrupt data, whole-item limits, excluded private bodies/history, exact receipts, cancelled/late reviews, duplicate sends, old-server rejection and failed-send draft retention. Companion's compiled web preview uses explicitly synthetic case responses; it runs no model or diagnostic. Browser layouts and exports do not establish physical Android acceptance or a new model-quality gate. The frozen six-model comparison remains unchanged.
