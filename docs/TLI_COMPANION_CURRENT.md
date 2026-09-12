# Current Companion beta delivery

The current signed Android candidate is **TLI Companion Beta 0.1.0 (8)**.
It makes ordinary AI conversation the opening experience: Chat first, a visible
message box, persistent Send/Stop, immediate History/New chat and optional context
in a separate sheet. Today, Home and existing shared work remain accessible.

## Get the update

- [EAS Beta8 build](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/edb93ea1-97ae-44ad-b244-7aa9a97841d1).
- [Download the verified Beta8 APK](https://github.com/TheLANIntelligence/TLI/releases/download/anniversary-preview-1/TLI-Companion-Beta-0.1.0-8.apk).
- Package: `com.thelegatointelligence.companion.beta`; public version stays `0.1.0`.
- Native build8 is higher than the retained, freshly verified Beta7. Both packages
  have a valid Android v2 signature and the same signer:
  `bb85fe308fb491a6e0335385edb4c56153b3296ab7cbe6cd3a672154d6ad6b60`.
- APK SHA-256: `bacc0c4063f48527f54ab0196c9c58cd642e482548b310eaaf177390e377b5ff`; 122,106,515 bytes.

Install as an **update over the existing Beta**. Keep it installed and do not
clear its app data. Signing compatibility supports the update; retained pairing
and the real phone keyboard still require physical acceptance.

## Verified

| Gate | Result |
| --- | --- |
| Mobile suite | 191 passed |
| Strict TypeScript | Passed in the frozen mobile-only candidate |
| Web, Android and iOS exports | Passed after a clean Metro rebuild |
| Chat browser workflows | 25 checks; 64 captures; narrow widths, light/dark, enlarged Chat text, reduced height, failure, interruption and drafts |
| Existing report/case/peer workflows | 144 browser checks and 120 captures passed |
| Native build | 14 transport tests and release assembly passed |
| Real APK | Correct Beta package/build, matching signer, new Chat bundle markers and resize keyboard manifest |
| Physical phone | Not run: installation/update, pairing retention, native keyboard, ordinary live AI answer and desktop continuation |

The app's public identity, EAS project, dependencies, pairing keys and native
transport are unchanged. Compared with Beta7, the uploaded source changes only
four screen/entry files and adds the relocated Today screen. No host files,
credentials, household data or prior artifacts were uploaded.

Remote access is explicitly deferred at the user's request. Its unfinished
additions are preserved separately under `build_work/anniversary-final/deferred-remote/`
and excluded from the current source. The final anniversary source matches all
77 Beta8 upload inputs and passes 191 mobile tests and strict TypeScript; this
accepted APK does not need a rebuild. See the [source identity record - local evidence](LOCAL_EVIDENCE.md)
and [anniversary delivery](TLI_ANNIVERSARY_FINAL.md). No production host was restarted.

See [the implementation record](TLI_COMPANION_CHAT_FIRST.md),
[before/after preview - local evidence](LOCAL_EVIDENCE.md),
[matched delivery manifest - local evidence](LOCAL_EVIDENCE.md)
and [APK update verification - local evidence](LOCAL_EVIDENCE.md).
The [Beta7 delivery record](TLI_COMPANION_BETA7_DELIVERY.md) and its APK remain retained.
