# Companion: Chat comes first

The user paused remote-connectivity work because Companion did not make its most
important interaction obvious: typing a normal question to TLI. This is a focused
mobile correction. It does not deploy desktop changes or resume VPN work.

## What changed

- A paired app opens **Chat**. The tabs are Chat, Today and Home. The existing
  `/ask` route still owns the single Chat controller; `/` redirects to it.
- First-time successful pairing opens Chat. A reviewed replacement returns to
  connection Settings only after verification succeeds. Failed pairing stays in
  review and rapid duplicate presses cannot create competing requests.
- The message box and Send/Stop sit outside the conversation scroll. A long
  answer, loading history or unavailable AI cannot push them below the messages.
- **Add context** opens optional photos, devices, selected notes, case context and
  sharing controls. A compact summary remains beside the composer; incompatible
  selections disable Send and require review. Closing the sheet keeps the draft.
- New chat and History are immediately accessible. When little height remains,
  secondary navigation moves into the context sheet to preserve typing space.
- The header identifies the paired host and separates host connection from AI
  readiness. Full connection details are available explicitly; unknown stays
  unknown. An unavailable host allows drafting but disables sending.
- Message evidence remains available. Save-to-note and Troubleshooting links sit
  under **Message options** instead of dominating every reply.
- Tab labels have a full line box and room for native text scaling and safe areas.
  Tabs hide with the native keyboard. iOS sheet-to-picker transitions wait for
  sheet dismissal rather than using arbitrary timeouts.
- Pairing instructions now point to **Home & network → Phone Companion**.

The send controller, secure transport, authentication, pairing-storage keys,
endpoint URLs, conversation records and retention rules remain unchanged. Sending
is explicit. Stop preserves partial text and the draft without claiming server
actions were cancelled. Reconnection does not replay the question. Existing
Today, Home, notes, reports and cases remain accessible.

## Verification

The final mobile candidate passes **191 tests**, strict TypeScript, and clean
Web/Android/iOS exports. The compiled Chat preview passes **25 workflow checks**
and **64 view captures**, including 320/390 widths, light/dark, 200% Chat text,
long history, unavailable AI, offline state, same-turn duplicate Send, stopped
responses, draft preservation and available-height simulations at 420/360 pixels.
An additional 16-view geometry gate verifies the composer and navigation glyphs.
The retained report, case and peer workflows also passed 144 browser checks.
Android Beta8 completed release assembly and all 14 native transport tests; its
real APK signature, package, higher build number, new Chat bundle markers and
keyboard resize setting were verified against the retained Beta7.

These are actual React Native screens compiled for web, using an inert synthetic
home. They do not test an Android keyboard, pair the user's phone, contact a live
model or operate household devices. Android native signing, assembly and physical
acceptance are recorded separately in the delivery manifest.

The baseline had 190 passing mobile tests and four TypeScript errors in the
unfinished remote-check tests. Paused remote work remains preserved in the
working tree. The mobile-only candidate omits that unfinished feature and retains
the previously accepted Settings screen; every input and exception is recorded
in its manifest. The current desktop installation is untouched.

An initial isolated test attempt lacked the parent repository EAS-policy fixture;
the fixture was supplied and the entire candidate suite rerun. A cached Metro
export also retained older layout transforms. It was rejected, clean exports
were generated with `--clear`, and actual bundle content and browser behavior
were checked again. Failed attempts remain available as engineering evidence.

## Delivery and physical checks

See the [current Companion delivery](TLI_COMPANION_CURRENT.md) for the latest
verified APK and exact native build. The [review gallery - local evidence](LOCAL_EVIDENCE.md)
and [delivery manifest - local evidence](LOCAL_EVIDENCE.md)
bind the accepted source, build and verification evidence.

Physical acceptance remains **not run**: update without uninstalling, retained
pairing, opening Chat, keyboard-open typing/Send/Stop, real AI conversation, and
continuing the same conversation on desktop. Device model, OS and installed build
must be recorded when these checks are performed. A verified signing match allows
an update; it does not prove the user's phone has already accepted it.
