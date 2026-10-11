# TLI welcome and setup

New installations open a five-step welcome: an introduction to TLI, computer
name and appearance, optional access PIN, local AI setup, and a first destination.
TLI is introduced as a private, general-purpose AI for conversation, writing,
learning, planning and creating. Connected devices are optional.

The welcome uses the current theme, local fonts and a responsive split layout.
The content scrolls independently from Back and Continue. Keyboard focus stays
in setup, yields to PIN entry when locked, and returns when setup closes.
Reduced motion is respected. No intro audio plays automatically.

Appearance uses the existing Settings persistence owner. The host name is saved
through `/system/node/name` and save failures remain visible in the current step.
Existing PINs are preserved. New PIN verification uses the shared lock controller,
including its protection against a delayed unlock response after an explicit lock.
PIN values are never stored in the onboarding draft.

Local model choices come from the existing model catalog. Downloads require an
explicit choice and respect the catalog's resource checks. Download completion
does not mean AI is ready: the user separately chooses Use this model or Check
and use, using the existing guarded activation endpoints. Failed, cancelled,
installed, downloading and responding states are distinguished. Other providers
and reviewed LAN models remain available in Settings. Continuing setup never
silently switches providers, runs inference or controls a device.

Finish later closes the welcome and offers Continue setup. The current step and
non-secret choices are retained in this browser tab's session storage. Reloading
an unfinished installation resumes that draft; a new browser begins at Welcome.
Existing users can reopen the flow from **Settings → AI → Welcome & setup**
(beside Refresh models). `TLIOnboarding.open()` resumes and
`TLIOnboarding.replay()` returns to Welcome without resetting host data.

The server is authoritative for completion:

- `GET /system/onboarding/status` returns `complete` and `started` without writing.
- `POST /system/onboarding/start` persists `data/onboarding_started.json` before
  the first setup changes. A PIN created after this point cannot skip setup.
- `POST /system/onboarding/complete` atomically saves the completion marker. The
  browser closes and marks completion only after a confirmed successful response.
- Legacy installations with a PIN and no start marker continue to skip onboarding.
  Completed installations stay completed when the welcome is replayed.
- Unreadable saved progress or security state fails visibly and preserves files.

After completion, the user's chosen destination opens. Ask TLI is the initial
choice when local AI is responding; Dashboard is the initial choice otherwise.
Create and Phone Companion are also available. Opening a destination submits no
prompt and creates no pairing invitation.

Validation uses isolated backend fixtures and the real SPA with intercepted,
synthetic services. Run `pytest tests/test_onboarding.py tests/test_system_routes.py
tests/test_browser_lock.py -q` from backend, the focused frontend PIN/access and
overlay tests, and `node scripts/verify_onboarding_browser.cjs` from the project
root. The browser suite exercises failures, reloads, focus, and five steps at
1440, 768, 390 and 320 pixels in light and dark appearances. These checks do not
download a real model or certify a physical installer run.

October 11 validation: 35 backend tests and 79 focused frontend tests passed.
The final browser run passed 32 scenarios and 40 layouts with no source changes
during the run. It also verified PIN focus priority, reload after PIN creation,
failure recovery, completion acknowledgement and explicit AI actions. The
existing Legacy/new-workspace entry smoke test passed without browser errors.
Browser evidence is under
`build_work/onboarding-ui/2026-10-11T22-23-25-024Z/`.
