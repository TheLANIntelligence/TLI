# Reusable troubleshooting guides

Guides turn a small set of instructions into an **unsaved Troubleshooting problem**. They do not execute tools, run checks, select a computer, attach evidence or send a Chat request. Saving and every subsequent diagnostic or action remain separate choices.

## Use a guide

In **Troubleshooting**, choose **Start from a guide…**. Five bundled starting points cover a slow app, an unreliable connection, low drive space, printer trouble and revisiting a previous fix. Each describes the relevant host or resource boundary and distinguishes a recorded result from a confirmed cause or repair.

Alternatively, choose a JSON guide file. Reading and validating it happens entirely in the browser. Review the displayed title, symptom and every step, acknowledge the selection, then choose **Prepare problem draft**. The new draft has fresh step identifiers, all steps marked Planned, no selected computer, no evidence, no outcomes and no resolution. Adapt it before saving.

An existing unsaved problem is preserved. Save or explicitly discard that draft before preparing another guide. Preparing a guide also invalidates an older pending problem-load response so it cannot overwrite the new draft. Navigation preserves the workspace's in-memory draft; locking clears it under the normal Troubleshooting session rules.

## Create a reusable guide

Open a saved problem with no unsaved changes and choose **Create reusable guide…**. The preview contains only its title, symptom and whole step text. Account and problem identifiers, selected computer, evidence pointers and bodies, step status/outcome fields, resolution and other metadata are omitted.

**Free text can still contain private information, commands, computer names or historical claims.** Review it explicitly before **Download reviewed guide**. Structured-field omission is not automatic redaction of text. The source problem and its evidence remain unchanged. The resulting JSON is a portable instruction template, not a backup or a verified fix.

One acknowledged review requests one download. Closing and reopening starts a fresh review if another copy is needed. The browser controls download completion; TLI reports only that a download was requested. A guide that exceeds the limits is refused as a whole, without truncating instructions or changing the saved source. This includes saved problems containing more than 12 steps.

## File format and boundaries

```json
{
  "format": "tli-troubleshooting-guide",
  "version": 1,
  "title": "Printer queue stalls",
  "symptom": "Describe the printer, the job and what you observed.",
  "steps": [
    "Review the selected printer and its queue.",
    "Record submission and physical printing as separate observations."
  ]
}
```

- Exactly these five fields are accepted; unknown fields, duplicate root keys (including escaped duplicate spellings), unsupported versions, nested step objects, targets and executable fields are rejected.
- Files are at most 32 KiB of UTF-8, including formatting. Title and symptom are nonblank strings limited to 120 and 4,000 JavaScript string units. There may be zero to 12 nonblank steps, each limited to 1,000 string units. Emoji can occupy two string units.
- All imported text is displayed with text nodes. HTML, Markdown links, command syntax and instructions inside a guide receive no execution privileges and are not automatically supplied to AI.
- File selection is disabled during a pending read. A failed replacement preserves an existing review; an initial failure correctly reports that no guide was prepared. Late file results cannot populate a closed, locked, backgrounded or replacement session.
- Acknowledgements belong to the exact displayed preview and modal session. Detached earlier buttons cannot operate on a newly displayed guide. Native modal focus containment, Escape and safe focus return follow the shared interface behavior.
- Reviews remain in browser memory. Download blob URLs are revoked on close, lock, backgrounding or page exit. The module makes no HTTP requests and stores no guide library, source body, account key or model state.

## Verification

`frontend/tests/case-guides.test.cjs` covers format limits, Unicode, duplicate fields, plain-text rendering, exact-preview acknowledgements, single downloads, source preservation, failed replacement, late files, lock/background and modal lifecycle. The scoped cases in `frontend/tests/troubleshooting.test.cjs` exercise the actual workspace preparation hook, dirty-draft protection and a delayed saved-problem response.

The actual SPA was also exercised with all HTTP intercepted and synthetic guide files. The browser matrix covers desktop, tablet, 390/320-pixel phones, reduced motion, doubled text, all 23 selectable themes, explicit import/export, no unintended requests, and retained drafts. Evidence is retained under `build_work/anniversary-completion/case-guides-browser/`; the ignored runner is `build_work/anniversary-completion/verify-case-guides.cjs`.

These checks do not run a diagnostic, model, device action or native Companion workflow. They establish browser template handling, not the correctness of arbitrary imported instructions or physical acceptance.
