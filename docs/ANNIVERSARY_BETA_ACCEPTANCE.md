# Physical anniversary beta acceptance

**Paused at the user's request.** No phone testing or Apple sign-in is currently
requested. Preserve this procedure for a future explicit decision to resume.

Status: **not run on either phone**. This is the procedure and result sheet,
not a claim that the devices have passed. Candidate identity and automated
evidence are in [ANNIVERSARY_BETA.md](ANNIVERSARY_BETA.md).

## Before testing

1. Install **TLI Companion Beta** alongside the existing Companion. Confirm both
   icons remain. Open the original Companion and confirm its pairing is still
   present. Do not replace or copy that pairing into the beta.
2. Use the explicitly launched synthetic host and its printed HTTPS address and
   sample PIN. The host name begins **SYNTHETIC TLI ACCEPTANCE FIXTURE**. It has
   sample notes, fake devices and simulated answers. Use sample photos only.
3. In the desktop browser, dismiss the fixture's setup wizard with **X**, unlock,
   then open **Settings → TLI Companion · iPhone & Android**. Create a separate
   single-use QR for each beta installation. A pairing QR is a credential: do not
   include it in screenshots or test reports.
4. Record both phone models, OS versions and native build numbers below. A
   simulator or resized desktop browser does not satisfy phone acceptance.

| Device | Model / OS | Native build | Result |
|---|---|---|---|
| Android | Not recorded | Not yet physically installed | Not run |
| iPhone | Not recorded | Signed internal build pending Apple login/provisioning | Not run |

## Journeys

Use **passed**, **failed** or **not run** for each platform. A failure needs its
exact step and observed result. Keep PINs, pairing bundles, certificates' private
keys and personal images out of the record.

| Journey | Expected observation | Android | iPhone |
|---|---|---|---|
| Fresh pairing and app restart | Review the synthetic host, pair, close/reopen the app and reconnect with the same identity. | Not run | Not run |
| Normal host restart | Stop/start the same fixture root on the same port; the beta retains pairing and host identity. A disconnected request is not replayed. | Not run | Not run |
| Replacement and cancellation | Cancel a proposed replacement and retain the working pairing; a completed replacement survives app restart. | Not run | Not run |
| Certificate rejection and revocation | Reject changed/untrusted certificate identity; revoke the beta's access on desktop and confirm it cannot continue anonymously. Use a separate synthetic host/certificate for rejection, preserving the main fixture. | Not run | Not run |
| Wi-Fi loss and backgrounding | Interrupt chat and a fake action, then return. The app describes interruption/unknown outcome and sends no automatic repeat. Compare fixture action counters. | Not run | Not run |
| Shared conversation | Open the same conversation on desktop and phone and follow up using its earlier messages. | Not run | Not run |
| Notebook | Create/edit sample notes across clients. Competing edits reject the stale version without losing the unsaved edit. | Not run | Not run |
| Screenshot recovery | Choose a sample image deliberately; interrupt its send; retain a recoverable draft and require an explicit resend. Fake answers clearly describe their simulated scope. | Not run | Not run |
| Data & Recovery / AI availability | Run saved-data checks explicitly. Disable the simulated provider and keep host connectivity distinct from unavailable AI; stale checks remain labeled after disconnection. | Not run | Not run |
| Permissions and accessibility | Deny/restore camera and LAN permissions; test keyboard, largest text size, portrait safe areas and VoiceOver/TalkBack labels/order. | Not run | Not run |
| Original app preservation | Original Companion remains installed with its original pairing intact after beta testing. | Not run | Not run |

## Fixture controls and interpretation

The fixture's authenticated `GET /__fixture/status` exposes simulated call/action
counters. `POST /__fixture/control` accepts `ai_available` and `delay_seconds`
(0–20); use a delay for deliberate interruption. `POST /__fixture/stop` requests
normal shutdown of that owned host. These developer endpoints exist only in the
explicit rehearsal harness and are excluded from distributed TLI code.

Restart with the same synthetic data directory, address and port. Do not delete
the directory or regenerate its identity between restart checks. The host has a
bounded lifetime; an expired test host is not an application failure.

Ancillary dashboard, model-management, discovery, diagnostics and Vault operations
are intentionally unavailable in this fixture and may display errors. Test only
the scoped journeys above. No real repair, model benchmark, home-device response,
image understanding, production app upgrade or real-data restore is certified by
these results. Rebuild changed candidates before repeating failed checks.
