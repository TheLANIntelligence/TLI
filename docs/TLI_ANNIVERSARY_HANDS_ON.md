# Anniversary hands-on checks

Use this guide to test the desktop, **Android Companion Beta8**, and optionally a
second TLI computer on the home LAN. Software tests and signed builds are already
recorded separately. **Every hands-on scenario below starts as `not_run`: no
physical phone, household device or configured-service result is claimed here.**

Start with the desktop and phone sequence. Optional rows can stay `not_run` when
the required hardware or service is absent. A clear unsupported state is useful
evidence of correct handling; it is not a successful microphone or device test.

## 1. Record the starting point

- Record the date, desktop OS/browser, TLI running source identity, Android model
  and OS, and installed Companion build. Keep source identity separate from the
  public version number and from AI model readiness.
- Use the existing trusted host address, including its port. Check that the host
  shown in the browser and phone is the intended computer. If TLI says its files
  changed or a restart is required, record that state before testing an update.
- Use a clearly named test conversation, note and problem, plus small disposable
  files. Keep household notes, pairing, credentials and existing records intact.
  Do not restore over live data or delete old backups to complete this checklist.

For each scenario, record `passed`, `failed`, or `not_run`, the exact observation,
and a screenshot or record ID where useful. Stop on a wrong target, unexpected
action, missing draft or uncertain outcome; record it before deliberately retrying.

## 2. Desktop: ordinary work before optional features

1. **Navigation and layout.** Open Chat, Troubleshooting, Performance & apps,
   Free Space and Settings. Try Modern and Classic, one light and one dark
   palette, a narrow window and enlarged text. The chosen interface should
   change without losing a draft or running a check. Confirm controls remain
   reachable by keyboard. Classic is a whole-interface choice; its palette is
   a separate setting.
2. **Conversation and sources.** Ask an ordinary question, then a follow-up.
   Open History and return to the same conversation. Turn off earlier
   conversation for one question and check the resulting receipt. Test saved
   notes separately. A selected old report remains historical evidence; missing
   measurements remain unknown. Save the exact question, answer and supplied
   sources when judging answer usefulness. Passing UI tests does not establish
   that an AI answer is factually correct or that a repair happened.
3. **One test problem.** In Troubleshooting, enter a symptom and explicitly
   choose the computer. Save and request next-check guidance. Inspect Known,
   Missing and Already tried. Review the single proposed check before choosing
   Run. Opening, editing or reviewing must not run it. The result should identify
   its actual host, target, time and coverage. Linking the completed report to
   the problem is a separate save; a failed link must not rerun the check.
4. **Performance & apps.** Open it on the TLI host, deliberately load the process
   list, and select a harmless application. Review its identity and explicitly
   start an observation. Stop it once and inspect the recorded duration, sample
   coverage and unknown values. A stopped or partial observation must not imply
   a complete run or a proven fault. This workflow observes the host computer.
5. **Free Space without cleanup.** Choose a small test folder, then explicitly
   Scan. Confirm its host, exact path, observation time, exclusions and limits.
   Compare map and list selections. Choosing a location or opening a result
   must not start another scan or move a file. Cleanup is a separate optional
   test below.

Scope references: [workspace flow](TLI_WORKSPACE_COHESION.md),
[reviewed next checks](TLI_FINISH_THE_FIX.md),
[Performance & apps](TLI_PERFORMANCE_APPS.md), and
[Free Space](TLI_FREE_SPACE_REBUILD.md).

## 3. Update and test Android Beta8

Get the APK from **[Current Companion delivery](TLI_COMPANION_CURRENT.md)**. That
page identifies the verified Beta8 package, build, signer and download. Install
it **over the existing Beta as an update, without uninstalling or clearing app
data**. Do not replace the separately identified production app. If Android
refuses the update, record the error and old/new build identities; do not remove
the installed app as a workaround. Signing compatibility has been verified, but
successful installation and retained pairing still require this physical test.

1. Open the updated app. Confirm native build **8** in its version information,
   the original host/pairing, and Chat as the opening screen. Use **Check host
   release identity** to record the actual host version separately.
2. Before scrolling, confirm the message field and Send are fully visible.
   Type with the actual Android keyboard open; test a multiline draft, larger
   Android text and the phone's usual navigation mode. Check Send/Stop and the
   bottom tabs for clipped text. Browser height simulations do not replace this.
3. Open **Add context**, scroll its optional choices, then close it. Inspect
   Connection details and History; visit Today and Home, then return to Chat.
   Keep the unsent draft unchanged. Opening these surfaces must not send it.
   On a short screen, New chat and History may move into the context sheet.
4. Send one ordinary question to the intended host. Confirm one user message,
   its reply and source/host labels. During another reply, press Stop. Preserve
   partial text and the draft where supported; Stop ends the phone's wait and
   does not prove that server work was cancelled. Nothing should resend itself.
5. With a test draft present, briefly background the app and return. Separately
   interrupt Wi-Fi during a test reply, then reconnect. Record the interrupted
   state and the exact draft/history behavior; reconnection must not replay a
   message, diagnostic or action. If AI is unavailable, distinguish that from
   an unreachable host rather than changing the pairing.
6. Open the same conversation on desktop and continue it once. Open the same
   test problem and saved report on both screens. Compare IDs, computer, report
   time and selected facts. For a conflict test, keep an unsaved test edit on one
   screen, save a change on the other, then attempt the first save: a conflict
   must retain the draft rather than silently overwrite the newer record.
7. Close and reopen the app. During a separately chosen maintenance moment,
   restart TLI normally and confirm the same host identity and original pairing
   still work. Record these two restarts separately from merely changing tabs.

See [Chat-first behavior and its limits](TLI_COMPANION_CHAT_FIRST.md).

## 4. Optional second computer

Use two explicitly chosen TLI computers with recorded running source identities.
Review their presented identities and permissions on both sides before allowing
access. A discovered name or address alone is not trusted identity.

1. Exchange a short LAN message and inspect sender, receiver and conversation.
2. Select the second computer in a test problem. Review its supported resource
   check and run it once. The saved report must identify that peer, its actual
   observation time and partial/unknown coverage. Unavailable or untrusted peers
   must not silently produce a report from the first host instead.
3. Offer a small disposable text file. On the receiver, review the exact sender,
   filename and size, then explicitly accept. Check the final byte/hash receipt
   and open the received copy. Preserve the original. Test Decline on a separate
   offer; test interruption only with another disposable transfer. An uncertain
   receipt requires checking status before deciding whether to send again.

These are physical LAN tests, distinct from the owned-loopback TLS rehearsal in
the [file-handoff acceptance record](TLI_FINISH_THE_FIX_ACCEPTANCE.md).

## 5. Optional services and preservation checks

Perform only the rows for services or hardware already available and deliberately
selected. All rows currently remain **`not_run`** for hands-on acceptance.

| Area | Small useful test | Evidence to keep |
| --- | --- | --- |
| Room display | Rooms & devices → Open room display; choose a room, explicitly read one saved observation, close/reopen rapidly, then lock. Try fullscreen on the actual display. | Exact device ID/time; no inferred occupancy or live health; reopened contents survive the earlier close; lock clears private contents. It uses the current browser's authority, not a restricted kiosk account. |
| Local dictation/playback | In desktop Chat, check local support; install a language pack only by explicit choice if needed. Dictate a harmless sentence, review it, add it to a draft, then separately send. Test a reported local playback voice and Stop. | Browser/version/language, support result, actual transcript and audible playback. No unsupported recognition or voice fallback; Add to draft does not send. |
| Related notes | With an existing host-loopback embedding service, explicitly review a few synthetic notes, build a temporary index and search. Edit a selected note and confirm the old index needs rebuilding. | Selected IDs/revisions, configured model/endpoint, useful and irrelevant matches. Similarity is not a confidence score or proof of truth. |
| Local MCP server | On the host, grant only selected read-only scopes, explicitly connect the inspector, review one read, then revoke. | Scope/result/expiry; no private note or Vault body; access rejected after revocation. |
| Manual MCP client | With a known local server already running, review its literal-loopback endpoint, list tools, inspect one harmless tool's definition and exact JSON arguments, prepare and invoke once. | Exact definition/result and whether anything actually changed. Tool annotations are server claims; an uncertain result must not cause automatic retry. |
| Home Assistant | With an existing installation, review the origin and explicitly connect/read. Choose one harmless light/switch by exact ID; separately review and run one desired On/Off request. | Reported state/time and independently observed physical state. A service acknowledgement alone does not prove the light switched. Disconnect afterward. |
| Documents and reviewed export | Use a small synthetic text/PDF/DOCX document with known contents. Review extracted scope/omissions before asking. Export the test problem with only selected evidence and inspect the whole redaction preview. | Correct selected ranges; no unselected source bodies. Export is an unencrypted historical copy, not a backup or proof of repair. |
| Cleanup and recovery | If desired, review Trash-only cleanup of disposable files and inspect its receipt. Test backup readability/recovery only into a separate disposable location using the documented workflow. | Original/selected paths and actual outcome; unknown freed bytes stay unknown. Preserve uncertain receipts and original backup/store files. |
| Physical peripherals/routines | If present, use one explicit reviewed test print or a harmless manual routine with exact targets. | Actual printed page/device effect, distinct from submission acknowledgement. Saved triggers do not imply an active unattended executor. |

Detailed boundaries: [rooms](TLI_ROOM_DISPLAY.md), [local voice](TLI_LOCAL_VOICE.md),
[related notes](TLI_REFERENCE_LINKS.md), [MCP server](TLI_MCP_BRIDGE.md),
[MCP client](TLI_MCP_CLIENT.md), [Home Assistant](TLI_HOME_ASSISTANT_BRIDGE.md),
[documents](TLI_RICH_DOCUMENTS.md), [exports](TLI_CASE_EXPORTS.md),
[reviewed cleanup](REVIEWED_STORAGE_CLEANUP.md), [data recovery](DATA_RECOVERY.md),
and [manual routines](TLI_ROUTINE_REVIEW.md).

## Record the outcome

| Scenario | Status | Device/browser and app/host identities | Actual result and evidence |
| --- | --- | --- | --- |
| Desktop ordinary workflows | not_run | — | — |
| Beta8 update and retained pairing | not_run | — | — |
| Native keyboard, large text and accessibility | not_run | — | — |
| Live Chat, Stop and interruption | not_run | — | — |
| Desktop/phone continuation and conflict | not_run | — | — |
| App/host restart continuity | not_run | — | — |
| Second-computer observation/message/file handoff | not_run | — | — |
| Each chosen optional-service test | not_run | — | — |

Keep failed attempts and unavailable setups visible. A build, screenshot or
protocol test cannot fill a physical row, and a successful physical workflow does
not clear the separately recorded AI-quality limitations or establish a validated
model winner.
