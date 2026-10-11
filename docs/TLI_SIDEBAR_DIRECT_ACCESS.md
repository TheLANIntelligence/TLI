# Direct sidebar access

Follow-up to the simplification release, September 13, 2026 (local date).
The desktop sidebar now directly lists Home, Ask TLI, Files, Free Space,
Game Optimizer, Vault, Computers, Smart devices, Routines, Phone Companion,
Printers & scanners, and USB drives. Help, More and Settings remain below them.

Users no longer need to open Devices to reach its six workspaces. Its overview
remains under More and in search for existing links. Files and Free Space retain
their shared location preparation and workspace links, with independent sidebar
selection. Printer status selects Printers & scanners; LAN Messages selects
Computers. Existing pins for newly promoted entries do not create duplicates.
Mobile keeps Home, Ask TLI, Files and More, with every destination reachable.

Validation: **1,266 frontend tests passed**, plus **505 browser layout checks**
with zero failures and unchanged source hashes. Browser checks cover desktop
and narrow layouts, both interfaces, every palette, direct sidebar clicks at
720-pixel desktop height, pins, saved links, aliases and access restrictions.
The backend and native source match the prior verified candidate; this follow-up
does not repeat their unchanged suites. No production restart or deployment.

- [Frontend test log](../build_work/simplification/sidebar-frontend.log)
- [Browser report](../build_work/simplification/browser-2026-09-14T01-55-55-752Z/report.json)
- [Modern sidebar capture](../build_work/simplification/browser-2026-09-14T01-55-55-752Z/panel-dashboard2-1440-emeraldLight-modern.png)
- [Classic sidebar at 720px height](../build_work/simplification/browser-2026-09-14T01-55-55-752Z/expanded-sidebar-classic-720.png)
- [Source candidate manifest](../build_work/simplification/sidebar-candidate/release-snapshot-pk_870x8/manifest.json)

The candidate contains 821 allowlisted source files and has fingerprint
`2608a61a09979c631fc8025863d4b9d5583cce6a3f470b3cf241c2d4fedc8102`.
Earlier release captures and acceptance records retain their original source
and navigation checkpoint.
