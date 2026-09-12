# Companion screenshot guidance and send recovery

This checkpoint extends the already-built native TLI Companion. It uses the
existing chat endpoints, native pinned transport, vision provider and screenshot
review endpoint. Home Automation and diagnostic rechecks remain parked.

## Behavior

- Camera/library selection opens an enlarged local review. Ordinary photo
  questions remain available, alongside Explain this screen, Understand an error
  and Find the next step. The review shows the model, provider, destination and
  checked time. It sends no image until the user presses Send.
- Screenshot computer identity is selected separately from the phone and normal
  device context. Unknown and labelled other computers are supported. Registered
  IDs identify computers with duplicate names. Only explicitly attached reports
  are forwarded; the backend rejects mismatched report ownership or scope.
- Every Companion photo request carries the reviewed provider key. Missing or
  unavailable review blocks uploads. Recheck can refresh the destination after
  a provider change; it never resubmits the question. Backend checks remain
  authoritative and do not start or change models during review.
- Sending resolves successfully only after a completed, nonempty answer.
  Provider errors, incomplete streams, Stop, background cancellation and
  superseded sessions reject. Draft/photo remain available for an explicit
  retry. No request is automatically replayed or switched to another transport.
- Duplicate sends are locked synchronously. Cancellation holds the lock until
  transport settles. Late callbacks cannot complete another pairing's request
  or clear a newer composer. Changing or revoking a pairing clears the old
  private composer; failed requests do not persist drafts across app shutdown.
- Successful guided replies retain bounded task/computer/report receipt metadata
  with the assistant message. Desktop reopen, desktop page restore and Companion
  shared history render it. The receipt identifies a user-shared snapshot and
  says no actions were performed. It contains no image or provider review key.
- Image retention remains zero in Companion. Temporary files stay only while
  attached, including after interruption, and are disposed on removal, successful
  completion, pairing change or screen unmount. Providers may have their own
  retention settings. No capture, watching, clicking or repair tools were added.

## Compatibility and deployment

Existing conversations, endpoints, authentication and SSE event names are
unchanged. Optional receipt fields require no data migration; old code can ignore
them. Old messages load without a receipt. New native photo review requires the
matching backend screenshot endpoint; failure to review prevents an upload.

These are source changes, with local iOS/Android JavaScript export validation.
The previously built APK/simulator artifacts do not acquire these changes
automatically. A future matching app build and normal backend restart are needed
to use them in the installed app. This checkpoint did not sign, upload or publish
a build, restart live TLI, download models, or send personal images to inference.

## Verification — 2026-09-06

- Baseline carried from the preceding checkpoint: 401 backend and 80 desktop
  tests passed. Native baseline was run before this batch: strict typecheck and
  15 tests passed. No baseline test failures.
- Final isolated checks: 410 backend tests, 83 desktop tests and 35 Companion
  tests passed; native strict typecheck passed. The backend still emits existing
  deprecation warnings (597 in this run); they are not new test failures.
- Added backend/desktop coverage checks bounded metadata, all three image POST
  endpoints, cross-client ownership, old conversations and both desktop history
  restoration paths. Native coverage checks reviewed scopes, missing/changing
  providers, failed/empty/partial responses, cancellation, duplicates, late
  callbacks, pairing/conversation changes and receipt rendering.
- Local iOS and Android Hermes exports succeeded using Node 24, without cloud
  compilation or signing. Generated artifacts are under the ignored `.expo`
  directory. This validates JavaScript bundling, not physical hardware behavior.
- The sample Companion preview on loopback port 8771 was checked at 390 × 844:
  enlarged review, explicit computer selection, failure and Stop preserving the
  draft/photo, changed provider requiring Recheck, successful explicit retry,
  and receipt restoration. The tested phone viewport has no horizontal overflow;
  choice controls exceed 48 pixels. The wider preview was checked at 1440 × 900.
- Preview inspection exposed a pre-existing empty-string child in DeviceCard
  that produced a React Native rendering error. Its error conditional now uses
  a boolean guard; no Home behavior was expanded.

Physical iPhone/Android acceptance remains separate: picker permissions, native
keyboard/safe areas, large text and screen readers, Wi-Fi loss/backgrounding,
paired certificate validation, and real vision quality. The existing
[Companion validation record](TLI_COMPANION_VALIDATION.md) retains the earlier
native compilation results and physical acceptance requirements.
