# TLI - Anniversary Preview 1

A private home console for your computers, useful notes, local AI, storage,
troubleshooting and connected work.

This is the **anniversary preview branch**. Original TLI branches and releases
remain unchanged. The historical **v1.0-beta** release is titled **TLI Beta v1.2.0**
and contains the v1.2.0 ZIP; it is not verified 1.0 source.

- [Preserved v1.0-beta tag / v1.2.0 release](https://github.com/TheLANIntelligence/TLI/releases/tag/v1.0-beta)
- [Previous v1.3.5-beta release](https://github.com/TheLANIntelligence/TLI/releases/tag/v1.3.5-beta)
- [Version preservation](docs/VERSION_PRESERVATION.md)

## Get this separate version

[Anniversary Preview 1](https://github.com/TheLANIntelligence/TLI/releases/tag/anniversary-preview-1) provides the verified desktop
source ZIP, Android Companion Beta8 APK, upgrade inventory and artifact hashes.
Retain your current installation and data; the preview does not replace them
automatically. The previous release remains the default GitHub download.

- [Everything upgraded](docs/TLI_ANNIVERSARY_UPGRADE_SUMMARY.md)
- [Hands-on testing guide](docs/TLI_ANNIVERSARY_HANDS_ON.md)
- [Capabilities and prerequisites](docs/TLI_CAPABILITIES.md)
- [Verification and limitations](release/verification.json)
- [Actual AI quality results](docs/TLI_ANNIVERSARY_FINAL_MODEL_CHECK.md)

## What changed

Modern and full Classic interfaces, refreshed themes, Chat and shared history,
Notes & fixes, guided Troubleshooting, Performance & apps, the rebuilt Free Space
map and reviewed cleanup, Vault backup and separate-copy recovery, computer trust,
LAN messages and reviewed file handoffs. Companion opens Chat with a visible
message field. Existing tools and optional configured services remain available.

## Verification

The accepted application passed all **27 software stages**: 2,769 repository
backend, 2,757 extracted-package backend, 1,133 desktop, 178 tooling and
191 Companion tests, plus TypeScript, clean Android/iOS/web exports,
isolated HTTPS restart and synthetic recovery.

**AI answer quality remains limited.** An experimental preparation change was
rejected after regressions. Neither version passed the strict quality gate.
Physical Android, two-computer, native-installation and real-data recovery
acceptance remain not run. Remote access is deferred.

## Running the source preview

The desktop ZIP includes the verified runtime files and launchers. Read the
included manual and testing guide. Setup dependencies may require network access.
Model weights and personal stores are not included. Visiting this repository
does not download models or change your current selection.

The Git tree retains the accepted application inputs; this README and publication
documentation were prepared separately. The original README remains in
[the historical reference](docs/README_PRE_ANNIVERSARY.md).
See [version identity](docs/VERSION_PRESERVATION.md) for retained in-app/native
labels and original release naming.
