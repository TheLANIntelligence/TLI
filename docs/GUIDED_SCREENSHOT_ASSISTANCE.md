# Guided screenshot assistance

This building checkpoint extends the existing AI Chat image flow. It does not
introduce a desktop agent, capture the screen, run repairs, install software,
or require new models. Home Automation and diagnostic rechecks remain parked.

## Using it

1. In AI Chat, choose **Screenshot help** and select a JPEG or PNG file.
2. Enlarge the preview if needed. Choose **Explain this screen**, **Help with
   an error**, or **Choose the next step**.
3. Choose the computer shown, supply another computer's name, or leave it
   unknown. This choice never comes from the phone/browser identity.
4. Review the image provider and retention setting, describe your goal, and
   press **Send**. If needed, attach the next screen in another request.

The normal attachment button retains **Ask about this image** for photos and
other image questions. The subsequent [Companion checkpoint](COMPANION_SCREENSHOT_CONTINUITY.md)
adds the same reviewed guidance to the already-built native app, and preserves
bounded screenshot receipts when either client reopens a conversation.

## Evidence and sharing

- File selection and enlarged preview are local browser operations. The review
  request contains no image. Sending remains an explicit chat action.
- The configured provider is checked without loading or switching models. A
  bundled vision runtime must be healthy; LM Studio uses the existing explicit
  vision selection and advertises availability, which does not prove loading.
- Sharing details name the provider, model, destination and checked time. A
  review key includes destination and bundled selection; the backend rechecks
  it before sending. A bundled switch racing with generation is rejected too.
  Provider redirects are not followed. Old clients can omit the new fields.
- Guidance uses the screenshot, current message, explicitly chosen computer
  identity and any matching report. It does not silently include memories or
  infer the requesting client's hardware, location or health.
- A report must belong to the authenticated user and measure the chosen host.
  Its scope and recorded time are included. A peer reachability report is not
  that peer's system-health evidence. Mismatched or oversized reports are
  rejected before retaining an image or calling a model.
- The prompt asks for visible evidence, uncertainty, one next step and what to
  look for afterward. Unreadable text requires a closer crop or exact message.
  Screenshot/report text is untrusted reference data. There are no action tools
  or action-intent fallbacks on this path. These safeguards do not guarantee
  that a vision model's interpretation is correct.
- Existing 6 MB / 16 million pixel validation, metadata removal and optional
  encrypted image retention remain. Zero retention is the default. Text stays
  in ordinary chat history; the visible image can remain in the current browser
  page. A provider may have its own retention policy. Retained images can be
  managed in Settings under Memory, model capabilities & images.

## Failure and compatibility

Missing images cannot turn guidance into a text action. Unavailable or changed
providers, bad files and mismatched reports cause explicit errors. Failed
provider calls are not retried and cannot become completed SSE replies. The
attachment and its draft remain available after failure; an older request cannot
clear a replacement attachment or overwrite its draft. Concurrent requests for
one conversation are guarded across all three existing POST endpoints.

Endpoints, ordinary chat context, SSE event types, model defaults, configuration
files and persisted data formats remain compatible. Optional request fields
and response metadata are documented in [SSE_SCHEMA.md](SSE_SCHEMA.md).
No migration or package is needed. Previous code can read the same data; deploy
matching frontend/backend code together when reverting so new browser requests
cannot silently lose their guidance options on an old backend.

## Verification

- Baseline before this checkpoint: 369 backend tests and 69 frontend tests pass;
  520 existing backend warnings, no baseline failures.
- Final checks: 401 backend tests and 80 frontend tests pass, including 32 new
  backend cases and 11 additional frontend cases. Backend warnings total 570;
  no failing tests remain. JavaScript syntax and whitespace checks pass.
- New isolated cases cover scope, matching/foreign reports, unknown computers,
  provider changes and races, no action fallback, invalid images/options,
  duplicate requests, redirects, failures, retention and session authentication.
  Existing Companion tests continue to check private conversation ownership;
  their fake image handler accepts the additive optional arguments.
- Browser workflows checked with a generated setup-error screenshot and a fake
  provider on loopback port 8768. Desktop 1440 × 900 and phone 390 × 844: explicit
  selection, enlarged preview, successful guidance, failure with preserved
  draft/attachment, unknown computer and 44-pixel controls. No horizontal
  overflow at the tested phone size.
- Run `backend/.venv/Scripts/python.exe -m pytest backend/tests/ -q` for the
  backend. In PowerShell, enumerate `frontend/tests/*.test.cjs` into an argument
  array and run `node --test` with that array. The disposable UI fixture is
  `backend/tests/screenshot_preview.py`; its printed PNG path can be chosen
  through the normal file picker. "Simulate failure" in a message makes only
  the fixture provider fail.
- No real model inference, personal screenshot transmission, device actions,
  live TLI restart or release packaging was performed. Real vision accuracy and
  physical phone behavior remain separate checks.
