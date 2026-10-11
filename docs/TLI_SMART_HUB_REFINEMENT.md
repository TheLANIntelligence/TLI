# TLI Smart Hub refinement

Implemented September 17, 2026, on top of the verified simplification and direct
sidebar work. This is a source candidate; production restart, deployment,
startup installation and native app distribution remain separate.

## What you will notice

- **Home begins with tasks.** Make room, Put files in order, Get ready to play
  and Set the scene open the existing workspaces. Edit shortcuts chooses up to
  six tasks and saves that preference in this browser. Back to returns to the
  last three workspaces opened in the current visit and clears at lock/page exit.
- **Everyday navigation stays direct.** Free Space and all six device categories
  remain in the left sidebar. The compact mobile browser header keeps View,
  Search, AI, Activity and Lock reachable in one control row. Existing palettes
  and the distinct Modern/Classic styles remain available.
- **Tasks connect.** Sixteen secondary strips offer relevant next steps, with
  editable previews before carrying folder/game/printer context into a problem
  checklist or an empty script/project editor. They preserve existing drafts.
  Search also recognizes task phrases such as “make room” and “low FPS.”
- **Chat starters respect your work.** Dashboard starters cannot overwrite a
  nonempty question, selected context, attached image or active response.
- **Windows has an everyday launch path.** Local Setup creates a desktop
  shortcut, with a hidden backend, verified reuse and a visible diagnostic
  fallback. Optional host-start setup is explicit and off by default.
- **Companion can request host start.** A separate HTTPS helper accepts only
  status/start for this installation using a restricted, reviewed phone token.
  Native code uses separate certificate-pinned requests, never a temporary
  change to the ordinary transport's trust. Accepted and ready remain distinct.
- **Misleading legacy surfaces were corrected.** The bundled Wake-on-LAN sample
  referenced a nonexistent endpoint and is no longer offered. Installed apps
  and user registries are retained. The unsafe port-killing sentinel is retired;
  Windows uninstall now gives a guided removal checklist instead of killing
  unrelated port occupants and silently deleting data through a generated script.
  Startup, network and uninstall guidance now describes the current source.

## Boundaries that matter

The phone helper needs an awake, reachable Windows computer and its user signed
in. It is not a boot-before-login service and does not implement Wake-on-LAN.
It does not change firewall rules, expose an arbitrary command runner, restart
production, or upgrade an already installed native client. Companion scene
execution and desktop routines keep their existing separate stores.

Home/task navigation does not run scans, infer answers, submit print jobs,
generate scripts or execute routines. New drafts require the feature's own
review and Save, Send or Run. Nothing in this pass enables automatic schedules,
automatic game settings, automatic file organization or a public marketplace.

## Preservation and implementation

The allowlisted source snapshot before this pass includes existing uncommitted
work: `build_work/smart-hub/baseline/release-snapshot-735vcwnj/source`, fingerprint
`2608a61a09979c631fc8025863d4b9d5583cce6a3f470b3cf241c2d4fedc8102`.
Public guides and legacy installer inputs were separately captured with hashes.
No Git reset, stash, commit or production restart was performed.

Existing feature panel IDs, lifecycle events, saved notes, files, reports,
projects, apps, palettes and backup formats remain owned by their controllers.
The new Home preference contains task IDs only; visit history stays in memory.
Host-start authority and bounded receipts live separately under
`data/host_control` when a user explicitly sets up or launches the new helper.

See [connected workflow audit](TLI_CONNECTED_WORKFLOWS.md),
[host setup](HOST_START.md), and [native Companion flow](TLI_HOST_START.md).
The final verification record and before/after review are delivered alongside
the frozen candidate, under `build_work/smart-hub` in the development checkout.
They distinguish source checks from future native builds and physical acceptance.
