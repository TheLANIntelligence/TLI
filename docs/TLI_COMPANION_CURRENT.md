# Current Companion beta delivery

The current signed Android candidate is **TLI Companion Beta 0.1.0 (9)**.
It brings the richer TLI interface to the phone: 23 local colored palettes,
readable Chat, distinctive composer and device cards, clearer action receipts,
and a reviewed pairing handoff from an ordinary camera's QR link. General AI,
Today, Home, and existing shared work remain available.

## Get the update

- [EAS Beta9 build](https://expo.dev/accounts/sergeantseven/projects/tli-companion/builds/a425660c-73b3-4714-861a-dd8a799d6d96).
- [Download the signed Android APK](https://expo.dev/artifacts/eas/WhHyLqQ_wjS2D4_fee1ff6SWmQs2rX_c5Y28Oy_-SlY.apk).
- [Verified local APK](../build_work/companion-atmosphere/candidate-20261002T022044Z/TLI-Companion-Beta-0.1.0-9.apk).
- Package: `com.thelegatointelligence.companion.beta`; public version `0.1.0`.
- Native build 9 is higher than retained Beta8. Both APKs were freshly
  verified with a valid Android v2 signature and the same signer:
  `bb85fe308fb491a6e0335385edb4c56153b3296ab7cbe6cd3a672154d6ad6b60`.
- APK SHA-256: `cb1a5d3ac03ec547f27bbd1946b028c7665ca57b520957a3e53a5975335e0cbb`;
  122,152,179 bytes.

Install as an **update over the existing TLI Companion Beta**. Do not uninstall
it or clear its app data. The package, signer, existing pairing keys and public
app identity are preserved. Signing compatibility supports updating; actual
phone pairing retention has not been physically tested.

For a fresh pairing, create a new QR code on the updated TLI desktop. Scan it
with the phone's normal camera, open the link, choose **Open TLI Companion Beta**,
then review the host in the app. The link stages a review; it does not silently
replace a saved pairing. Expired invitations require a fresh desktop QR code.

## Verified

| Gate | Result |
| --- | --- |
| Frozen mobile suite | 223 passed; strict TypeScript passed |
| Frozen Android export | Clean Metro/Hermes export passed |
| Mobile Chat browser workflows | 25 checks, 64 captures; current context sheet, drafts, interruption and responsive Chat |
| Appearance browser workflows | 25 checks; all 23 palettes, synthetic verified on/off, active stream/draft preservation; final receipt layout reviewed |
| Exact upload contents | 84 mobile-only files, independently matched to frozen and working-source hashes |
| Native Android build | 15 transport tests and release assembly passed |
| Real downloaded APK | Correct Beta package/build, matching Beta8 signer, new appearance/pairing bundle markers and resize keyboard manifest |
| Physical Android phone | Not run: install/update, retained pairing, normal-camera handoff, native keyboard or live AI answer |

The Chat preview predates only the final receipt-layout and singular Today-copy
edits; the final appearance preview includes the receipt layout. Both final copy
and layout are included in the frozen, tested native candidate. The older broad
preview harness stopped at an outdated direct **Use saved notes** selector; that
control now lives in the context sheet. Its historical 144 checks are not claimed
for this update. The current Chat suite covers the current context flow.

Existing EAS remote signing credentials were reused. Dependencies, app identifiers
and EAS build profiles are unchanged from Beta8. No household/runtime data, host
source, local dependencies, signing material or previous artifacts were uploaded.
The public desktop QR helper used by mobile tests is retained separately as a
hash-bound test fixture outside the mobile upload tree.

The existing optional private-network guide is byte-identical to Beta8. Deferred
remote-check work remains excluded; this update does not implement a VPN or prove
off-LAN access. Previously landed host-start integration remains in the exact
current source; no historical Settings substitution was used.

## Evidence and history

- [Current delivery manifest](../build_work/companion-atmosphere/candidate-20261002T022044Z/delivery-manifest.json).
- [Exact source manifest](../build_work/companion-atmosphere/candidate-20261002T022044Z/manifest.json),
  [archive verification](../build_work/companion-atmosphere/candidate-20261002T022044Z/archive-verification.json), and
  [APK update verification](../build_work/companion-atmosphere/candidate-20261002T022044Z/update-verification.json).
- [Current appearance preview](../build_work/companion-atmosphere/appearance-check-final/report.json)
  and [Chat preview](../build_work/companion-atmosphere/chat-check-1/report.json).
- [Preserved Beta8 delivery record](TLI_COMPANION_BETA8_DELIVERY.md),
  [Beta8 signed APK](../build_work/companion-chat-first/candidate-20260911T032455Z/TLI-Companion-Beta-0.1.0-8.apk),
  [Beta8 verification](../build_work/companion-chat-first/candidate-20260911T032455Z/update-verification.json),
  and [Chat-first implementation history](TLI_COMPANION_CHAT_FIRST.md).
- [Beta7 historical delivery](TLI_COMPANION_BETA7_DELIVERY.md).

No iPhone native build or physical iPhone acceptance was performed for this update.
