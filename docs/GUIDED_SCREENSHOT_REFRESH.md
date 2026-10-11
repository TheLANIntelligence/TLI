# Guided screenshot assistance — September 12 refresh

This improves the existing browser Chat feature. The image provider, screenshot
request fields, endpoints, saved receipts and native Companion contract remain.
It introduces no screen capture, remote control, model download or model change.

## A visible workflow

- **Screenshot help** is available at the Chat composer. Choosing a file or
  pasting an image into the message box prepares a local preview; Send remains
  explicit. Normal text paste keeps its browser behavior.
- Choose Explain this screen, Help with an error, or Choose the next step.
  Describe the goal in the message. Review the destination, image retention and
  any selected computer/report before sending.
- Guidance uses the screenshot and current question, with an explicitly attached
  matching report if selected. Earlier conversation and saved notes are excluded
  from this path, even when their ordinary Chat controls are enabled.
- A completed guided reply offers **Share the next screen**. This opens the
  existing file picker without sending a message, reconstructing an old image,
  replacing the question or claiming TLI can watch subsequent changes.
- Missing image support has an actionable explanation. Model-library navigation
  does not switch or download a model. A text-only question remains available
  after the user removes the attachment and types the visible error.
- Search aliases for screenshot and screen help lead to AI Chat. Search and
  navigation never select a file or send an image.

## Preservation and session boundaries

Attachments replace previous images only after successful local reading and
decoding. Invalid type, a file above 6 MiB, a corrupt image, more than 16 million
decoded pixels, or a local preparation timeout leaves the existing image and
question unchanged. A local read stops waiting after 15 seconds. The backend
independently validates and sanitizes every image.

Lock and page exit clear attachment state and invalidate pending reads and
sharing reviews. Late responses cannot restore the cleared preview. Ordinary
panel navigation does not send or imply cancellation of an existing request.

Backend image operations retain the request's original credential and recheck
access at preparation, dispatch and completion boundaries. Revocation stops
subsequent protected work; it cannot recall an image already sent to a provider.
A bounded synchronous provider call may finish before a post-call check rejects
its response. Existing optional retained images follow their configured policy.

Screenshot questions that exceed the existing 12,000-character input allowance
are rejected explicitly instead of silently dropping the end of the question.
This character limit is not an exact model-token fit or an accuracy guarantee.

## Verification and limits

The source baseline is preserved under
`build_work/screenshot-guidance-refresh/baseline/`. It includes the uncommitted
anniversary work and excludes runtime data and model weights.

Final counts, before/after browser views, source hashes and any unperformed gates
are linked from `build_work/screenshot-guidance-refresh/RESULTS.md`. The combined
Chat verification manifest is `build_work/chat-visual-polish/manifest.json`. Tests use synthetic screenshots, isolated persistence and intercepted
providers. Fixture replies are not evidence of real vision-model accuracy.

The live TLI process, active model, household records, published preview and
installed Companion remain unchanged. No Android/iPhone native rebuild or
physical-device acceptance is part of this browser refresh. A matching source
deployment and normal host restart are needed for backend fixes to reach a
currently running installation.
