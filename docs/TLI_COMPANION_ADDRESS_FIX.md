# Companion pairing: choose the reachable address

## Problem and correction

The host offered certificate-covered addresses from all adapters in sorted order.
The browser selected the first one, including a virtual-machine or link-local
adapter, and replaced a manually chosen address on every refresh. A phone could
read the host name from the QR while being unable to reach its encoded address.
The reported failure used a link-local address on a host with a separate Ethernet
address. Reading a QR alone does not establish network reachability.

The existing Phone Companion controller now:

- Keeps a selected address through refresh while it is still advertised.
- Uses the exact browser origin when it is one of the checked LAN addresses, or
  the only listed address. Otherwise, it requires an explicit choice.
- Keeps the selector usable while Create pairing QR is disabled awaiting a choice.
- Rejects forced generation without a checked choice and prevents address changes
  from retargeting an in-flight request.
- Shows the invitation's destination beside the QR. Changing the address clears
  the displayed code and explains that the old invitation remains valid until
  used or expired. A fresh invitation requires an explicit click.
- Clears the selection and invitation display on close, backgrounding or lock.

Choose the Ethernet or Wi-Fi address reachable from the phone, create a fresh QR,
then scan that code in the app. An existing bundle is bound to its original
address; editing its address is not a repair. No native app update or backend
restart is required for this browser correction; reload the TLI page.

## Preservation and verification

No pairing protocol, backend endpoint, certificate, PIN, phone credential,
configuration file, model selection or encrypted store changed. No new live
pairing was created by the test tools. Host checks were read-only; verified HTTPS
requests used the existing public certificate as trust material, with normal
certificate and hostname validation. No firewall or trust settings were changed.

Before-edit source snapshot:
`build_work/companion-address/release-snapshot-x37ub2m0/source`

Fingerprint:
`00a08203b690171945e3aba6b6616b90d411e11fb90d22b51eddabd09be2bd00`

- Focused baseline: 33 pairing/startup tests passed.
- Seven new address-selection regressions failed against the previous controller
  and passed with the correction; all 40 focused tests passed.
- Independent mobile audit: 37 existing protocol, connection and client tests
  passed; no demonstrated Android certificate-pinning defect was found.
- Full frontend first run: 645 passed, one unrelated recovery timing assertion
  failed. That unchanged recovery test file passed all 50 tests when run alone
  against both the snapshot and current source. Logs are retained in
  `build_work/companion-address`; the intermittent result is not concealed.

- Full frontend rerun: **646 passed, zero failures**. The first-run recovery
  failure and both isolated reruns are retained in the same artifact directory.
- Browser: **42 checks passed**, with 18 after screenshots and two baseline
  screenshots. Emerald Light and Midnight were checked at 1100, 390 and 320
  pixels, including address selection, visible destination, refreshed choices,
  forced duplicate clicks and attempted changes during a pending request.
  All five captured frontend assets stayed unchanged during verification.
- Visual review confirmed the choice prompt and the destination beside the QR
  remain readable on desktop and narrow layouts.
- The live host served the corrected controller after the edit. Only a browser
  refresh is needed to load it; the existing server was not restarted.

Browser report:
`build_work/companion-address/browser-2026-09-08T06-43-44-109Z/report.json`

Baseline views:
`build_work/companion-address/before-2026-09-08T06-43-48-258Z/`

Before/after gallery: `build_work/companion-address/review.html`.

Final source snapshot (505 source files):
`build_work/companion-address/final/release-snapshot-8ypgqwrz/source`

Final fingerprint:
`6ecd791cb248495f12d061ada69bd40b81b7bea54159598a651adcdcfc2f95b3`

Synthetic browser checks do not establish a physical phone connection or the
identity of the installed APK. Final acceptance on the user's phone is pending.
