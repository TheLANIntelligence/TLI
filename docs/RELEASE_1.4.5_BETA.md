# TLI 1.4.5-beta — connected workspace testing release

This beta brings the shared phone workspace and the continuous **Connect device** flow to existing desktop installations. It is published for real-device testing; physical LAN recovery and phone update-retention acceptance remain open.

- Prepare secure network access, discover nearby computers, review exact sharing permissions on both computers, compare codes and verify the connection in one flow. New Everyday connections offer messages, basic observations and coordination; existing grants are preserved. AI sharing remains separate and requires an explicit model selection.
- Saved computers appear immediately. One connection coordinator separates discovery, trust, reachability and operation readiness, retains alternate routes and verifies reviewed identities before authenticated work. Recovery never resubmits an action or silently chooses another computer or model.
- Windows networking changes have an explicit owner review and a narrowly scoped elevated firewall helper. The TLI backend remains unelevated. Certificate repairs and changes to existing broad rules require separate review. Setup receipts resume progress after a reviewed restart and unlock.
- Public connection invitations provide a fallback when multicast discovery is unavailable. Inference Nodes retain their dedicated pairing window and inference-only permissions.
- Phones receive the full responsive browser workspace. Companion Android build 13 adds shared conversations and Builder, reviewed documents, saved AI selections, host-managed runs, native discovery and network recovery. The APK is a separate update; the desktop updater does not install it.

## Updating an existing computer

Open **Settings → Software Updates → Check for updates**, then prepare the offered update. You can also download the matching Windows or macOS ZIP directly from this release. Extract the complete ZIP into a separate folder. Back up important saved data, finish active work and stop the original TLI host. Run `TLI_Update.bat` on Windows or `TLI_Update.command` on Mac from the new package, select the original installation and review the destination before confirming. Continue using the original folder and shortcuts afterward.

The guided updater preserves saved data, identity, existing trust, models and configuration. First start can require internet to prepare dependencies, including DNS-SD support. Python, Python dependencies and model weights are not bundled; these packages are not fully self-contained offline installers. Legacy frozen/native backend installations are outside the guided update path. See `docs/TLI_UPDATES.md` in the package.

## Updating Android

Install **TLI Companion Beta 0.1.0 (13)** over the existing Companion Beta. Do not uninstall or clear app data. The actual APK was verified with the same package and signing certificate as the previous beta. Physical update-retention testing remains required. Update the home host first, then use **Connect device → Phone setup** for a new pairing, or reconnect the existing pairing. Existing certificate or identity changes still require review.

## Testing scope

Automated protocol, authorization, browser, native transport and package checks passed before publication. Test two full computers, an inference Node and an Android phone for actual UAC behavior, multiple adapters, nondefault ports, DHCP changes, sleep/resume, blocked multicast, WAN disconnection and the ten-second recovery target. Also test backgrounded Chat/Builder recovery without duplicate work, pairing retention, accessibility, documents, downloads and preview isolation.

The main host retains the workspace and must remain available. Internet routing, replicated workspaces, automatic host failover and a native iPhone release are not included.
