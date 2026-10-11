# Chat visual refinement

This checkpoint reduces the visual weight of message tools while preserving
TLI's existing reviewed actions and context-sharing rules.

## Conversation first

- Notes & fixes and troubleshooting controls move out of message text into
  **More**. They remain available for messages with a valid saved reference,
  including supported user messages. Opening More does not save or link anything.
- Existing Copy and read-aloud controls remain available where supported.
  Timestamps share the message footer instead of forming another action row.
- **Answer details** groups the existing sources, context, input limits and
  timing receipts. Their contents and uncertainty labels remain unchanged.
  Interrupted output uses **Response details**; it is not a completed answer.
- **Share the next screen** stays visible for guided screenshot replies.
- Modern replies use a bounded reading width. Classic retains its familiar
  bubble arrangement, with the same quieter message tools.

## A smaller composer

The initial message field and surrounding spacing are more compact. Saved notes
and earlier conversation remain separate controls, arranged together when space
permits. Image and voice buttons use local outline icons. Screenshot help remains
visible, and **About AI Chat** is available inside **Options**.

Phone controls retain usable touch areas. Expanded context and screenshot review
use ordinary scrolling rather than clipping content into a fixed composer.

## Behavior preserved

Existing note-save and problem-link handlers still own their review dialogs and
requests. The presentation layer moves their actual controls without copying
listeners or introducing a second streaming controller. Menu dismissal, Escape,
focus return, session lock and panel navigation receive focused coverage.

Endpoint URLs, SSE events, stored messages, memory defaults, model selection and
image retention are unchanged. Navigation and opening menus perform no AI calls,
file operations, saved-note writes or troubleshooting mutations.

## Evidence

The source before this refinement is preserved at
`build_work/chat-visual-polish/baseline/release-snapshot-nkipj5ib/`.
Its fingerprint matches the saved screenshot-guidance candidate. All 1,162
frontend baseline tests pass. The new visual assertions expose the oversized
in-message actions on that baseline; those failures are retained.

Final checks, source hashes and before/after views are recorded in
`build_work/chat-visual-polish/RESULTS.md`, `manifest.json` and `review.html`.
The final browser checks also finish the screenshot refresh verification that
was interrupted by the computer restart. Test replies and screenshots are
synthetic; they do not validate model answer quality or physical phones.
