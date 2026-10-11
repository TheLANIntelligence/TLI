# Browser-local voice

Local voice is an optional browser feature in **AI Chat → microphone**. It uses the device running that browser, which may be a different computer from the TLI host. Opening the dialog does not start a microphone, contact an AI provider or install a language pack.

## Dictate, review, add

1. Choose a language and **Check local support**. TLI requires a secure browser context (HTTPS or localhost), the browser's local availability API, and an enforceable `processLocally: true` recognition setting. Ordinary or legacy cloud-backed recognition alone is insufficient.
2. If the browser reports a downloadable pack, **Download language pack** is a separate explicit action. The browser manages this download, which can contact its vendor. Closing TLI does not cancel it. Installation success requires another support check before recording; a pending or failed install is never treated as readiness.
3. Choose **Start dictation**. The browser may request microphone permission. Dictation runs for at most 30 seconds; **Stop dictation** requests completion, then aborts if the browser has not finished within three seconds. Permission failures do not trigger retries or a cloud fallback.
4. Review and edit the completed transcript, then choose **Add to draft**. Interim words cannot be added. Add appends to the existing Chat draft and dispatches only its normal input event. It never presses Send, attaches context, interprets a command or calls an AI provider.

The transcript is limited to 8,000 characters. Oversized replacement text retains the previously completed transcript. A draft-length conflict leaves both the existing draft and reviewed transcript available. Once added, the text follows the normal Chat draft and explicit-send workflow.

## Read aloud

Per-reply read buttons and the existing **Options → Read aloud** preference share one controller. A voice must report `localService === true`; remote, missing or unknown voice classifications cannot be fallbacks, even when the browser marks one as its default. The current local voice is explicitly assigned to each utterance. If it disappears or enumeration fails, playback stops.

Automatic playback respects the existing `tli_tts_enabled` preference. `tli_tts_voice` remains compatible with previously stored voice names while new selection uses the browser's voice URI when available. No transcript or audio is stored under either preference. Playback omits fenced code, is limited to 24,000 cleaned characters and runs only while AI Chat is visible and the session is unlocked. Leaving Chat, backgrounding, page exit or locking stops playback. There is no network speech-synthesis fallback.

## Lifecycle and privacy

- The native modal provides keyboard focus containment and Escape. Normal close returns focus; lock or navigation does not return focus behind the new view.
- Close, lock, page exit, backgrounding and leaving Chat abort recording and clear the dialog's private transcript. Once deliberately added, text belongs to the normal Chat draft and follows Chat's existing session rules.
- Support checks have a ten-second deadline and a cancellable local wait. Late checks, recognition callbacks and queued native close events cannot revive or overwrite another dialog session.
- Checked language readiness is bound to that exact language. Duplicate check, install, start and stop handlers are guarded internally, including forced events that bypass disabled buttons.
- TLI does not record, upload or persist audio. Browser-local processing and local playback classification depend on the browser's implementation of these APIs; a successful browser fixture is not evidence that a particular installed browser or language pack supports them.

## Verification

`frontend/tests/local-voice.test.cjs` uses fake recognition, voice lists and timers. It checks local-only enforcement, explicit installation and transcript use, preference compatibility, failures, deadlines, duplicate calls, navigation, lock and late callbacks. Related Chat tests verify that the integration remains compatible with existing draft, context and streaming behavior.

The actual SPA was exercised with speech APIs replaced **before application scripts ran** and every HTTP request intercepted. The fixture covers 1440-, 768-, 390- and 320-pixel layouts in Emerald Light and Midnight, reduced motion, 200% text, native modal keyboard handling and editable transcript insertion. Reports and screenshots are retained under `build_work/anniversary-completion/local-voice-browser/`; the ignored runner is `build_work/anniversary-completion/verify-local-voice.cjs`.

**Not run:** physical microphone capture, actual language-pack installation, transcription quality, OS voice playback or browser/native-platform acceptance. Automated verification performs none of these operations.

Browser API references: [local recognition setting](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally), [local availability](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static), [language-pack installation](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/install_static), and [local playback voice classification](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService).
