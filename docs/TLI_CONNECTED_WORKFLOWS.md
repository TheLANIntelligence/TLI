# Connected workspace next steps

Implemented September 17, 2026. This pass adds small, deliberate bridges between
existing workspaces. It does not add an AI agent or a new action engine. The
desktop's twelve direct destinations, compact mobile navigation, palettes,
Modern/Classic choice and underlying feature stores remain unchanged.

## What changed

Sixteen workspaces have a narrow next-step strip, with one or two useful actions.
There is no second card directory. The strip is separate from the workspace's
primary operation and does not repeat Scan, Run, Print, Generate or Save.

- **Files → Folder checklist** carries the entered folder into a reviewed,
  unsaved problem draft. **Plan a backup** previews a script request containing
  that exact source path as quoted data.
- **Free Space → Cleanup checklist** carries the selected location, explicitly
  distinguishing it from any retained scan. **Choose a backup** explains the
  difference between a Vault archive, a saved-work archive and ordinary files.
- **Game Optimizer → Record a settings trial** retains the entered game name
  and prepares steps for comparing one manual change. It does not invent settings,
  copy an unreviewed AI answer, or claim measured improvement.
- **Printers & scanners** carries the selected printer and scanner values into
  a checklist. Smart devices carries the entered address and relay as entered
  context, not verified identity. Other checklists ask the user to name the
  affected item when the workspace has no authoritative individual selection.
- **Scripts** offers read-only inventory and dry-run backup request starters.
  **Builder** offers an inspection question. The complete request is previewed
  in an editable preview before filling an empty editor. A nonempty, disabled or read-only editor is
  preserved. Nothing is submitted, generated or executed by the handoff.
- **Vault** opens its existing Backup & recovery disclosure or the actual
  Saved data & backups settings, depending on what the user wants to protect.
- **Computers and Game Optimizer/Builder** link to the actual host identity or
  AI model settings section. Help/More offers a small task chooser for Utilities,
  a script draft or a project-inspection question. Installed apps links to
  package sources without installing anything.

Checklists show the source context, editable symptom and three plain-text steps
before **Prepare unsaved checklist**. The existing troubleshooting controller
owns the resulting draft and refuses replacement of a dirty or busy draft.
The user chooses the affected computer and saves separately. These bridges
carry no structured device target, execution permission, evidence pointer,
completed outcome or AI message.

## Destination audit

The shared navigation catalogue was reviewed in full. Where a controller already
provides an effective continuation, this pass leaves it in place instead of
adding a competing action. Home and Phone Companion are owned by the parallel
Smart Hub refinements, outside this component.

| Catalogue destination | Useful continuation or gap | Resolution in this pass |
|---|---|---|
| Home | Everyday task launch and attention belong at the entry point. | Parent refinement owns the Home launch surface; no duplicate assistant strip. |
| Ask TLI | Context selection and unsent handoffs already have owners. | Retain existing composer, history, notes and evidence controls; no hidden prompt injection. |
| Files | A path and unfinished organization task were easily separated from follow-up work. | Exact-path folder checklist and previewed backup request; existing selection and Free Space coordinator stay intact. |
| Free Space | A selected location may differ from the retained observation; cleanup needs a keep/backup decision. | Label that distinction in the checklist and offer the backup chooser; no observation is represented as current. |
| Game Optimizer | Comparing a suggested trial benefits from a durable record of what the user measured. | Same-game plain-text comparison checklist and direct AI setup link. |
| Vault | Saved-work archives and Vault archives cover different data. | Scope-based chooser opens the existing correct controls; no backup starts. |
| Computers | Connection failures need a reproducible record and a clear route to host settings. | Connection checklist and actual host identity settings section. No peer is silently selected. |
| Smart devices | Useful transitions are from a single control to a routine, or from failure to a record. | Routines navigation without a run; checklist retains entered address/relay as unverified input. |
| Routines | A partial receipt must be understood before another attempt. | Outcome checklist; the existing receipt, target review, draft and favorite owners remain unchanged. |
| Phone Companion | Native pairing, browser satellite and connection readiness are different workflows. | Parallel Companion owner handles this surface; this component neither invites nor pairs a phone. |
| Printers & scanners | A submission acknowledgement is not a physical result. | Selected printer/scanner checklist; existing Printer status and selection handoffs remain. |
| USB drives | Existing drive-row actions already preserve the exact path. | Keep those actions; add a missing/unreadable-drive checklist without guessing a selected drive. |
| Help | A user may need a measured check, a script or project help. | A single task chooser opens the appropriate existing tool or an unsent starter. |
| More | Tool names alone do not explain which kind of work fits. | Same small task chooser, without duplicating its destination cards. |
| Settings | Existing grouped settings own changes and save scopes. | New links open exact existing groups/sections; no settings written. |
| Saved notes | Existing note editor and reviewed save/update flows already retain work. | No extra strip or automatic note creation. |
| Printer status | Queue state and printed output can diverge. | Printer checklist asks for the device when there is no selected printer in this view. |
| LAN Messages | The recipient and transfer receipt already have an exact-target workflow. | Preserve it; no send or automatic retry. |
| Devices overview | A retained secondary directory is still useful for legacy links. | Preserve it and the direct sidebar entries; no second directory. |
| Fix a problem | Reusable guides already support draft protection and revision-aware saving. | Reuse `TLITroubleshooting.prepareGuide`; failed/conflicting handoffs retain current work. |
| App performance check | Observations already have explicit save and evidence handoffs. | Preserve those controls; do not duplicate or start measurement. |
| Saved reports | Report links already preserve identity, scope and observation time. | Preserve explicit existing report handoffs. |
| Installed apps | An absent app needs a route to package sources, not a misleading empty launcher. | Direct package-source review link; no install or embedded-app execution. |
| Advanced tools | Existing directory already groups the specialist tools. | Keep it; task-oriented assistance is in More. |
| Utilities | A measured result may need to become part of an ongoing problem. | Open the existing problem journal without claiming the current result was attached or saved. |
| Scripts | Existing backup presets lack the new handoff's preview and draft protection. | New reviewed inventory/backup starters preserve nonempty editors. Existing presets remain unchanged. |
| Builder | Starting with an inspection is useful before changing an unfamiliar project. | Preview an unsent read-only question; do not change project, permission, mode or command state. |
| Package management | Bundled Wake-on-LAN Pad posted to missing `/mesh/wol`, promising a nonfunctional action. | Retire only that bundled offer and refuse a new sample install. Existing installed copies and user registries remain byte-for-byte untouched. |

The retired Wake-on-LAN sample may still exist in a user's previously installed
packages. This pass does not migrate or alter that owned copy, and does not add
a Wake-on-LAN endpoint or claim the old copy now works. A user-configured registry
can still contain its own package with the same identifier.

## Integration and boundaries

Assets: `frontend/js/workflow-assistant.js` and `frontend/workflow-assistant.css`.
Load the script after the existing feature controllers and navigation composition.
It mounts once on DOMContentLoaded, uses native dialogs and existing theme tokens,
and introduces no network calls or persistence. Its only public API is
`TLIWorkflowAssistant.init()` / `.close()`.

Navigation uses `switchPanel`; settings use `TLISettingsWorkspace.open`; checklist
preparation uses `TLITroubleshooting.open()` / `.prepareGuide()`. Script and Builder
text is filled only after the user reviews it and only when the existing editor
is empty and available. Normal destination controllers may load existing records
when opened; this module never starts a scan, device action, generation, save,
package install or backup.

Context is bounded and rendered through `textContent`. Paths are not truncated.
A host change invalidates the pending handoff. Closing or locking increments the
review generation so delayed completion cannot repopulate private work. Lock
clears the dialog and hides next-step strips; unlocking restores their controls,
not the private review. Failures leave prior feature drafts with their owners.

## Verification

- 109 focused frontend checks pass across this component, guides, troubleshooting,
  storage handoffs and interface styles. The 12 new checks validate all eight guide shapes through the real guide
  validator, exact quoted paths, input bounds and independent plain-text drafts.
- Three isolated backend regressions verify that both sample catalogue routes
  omit the dead offer, its sample install stops before package writes, and
  installed/local/remote user-registry data remain available and unchanged.
- The real SPA Edge run in
  [the browser report](../build_work/connected-workflows/2026-09-17T05-46-24-907Z/report.json)
  passed 24 behavioral groups, 64 workspace layout observations and 16 dialog
  screenshots at 1440, 390 and 320 pixels. It used Emerald Light/Modern,
  Classic Mint/Classic, Midnight/Modern and Horizon/Classic through the actual
  appearance APIs. New strip and dialog controls fit; no duplicate IDs or page
  JavaScript errors were observed. Owned asset hashes stayed fixed during the run.

The browser checks exercised exact-context preparation, existing-draft refusal,
unsent Script/Builder starters, real backup/settings destinations, changed-host
refusal, cancellation during preparation and lock clearing. All host responses
were synthetic and intercepted. No household files, real devices, native app,
AI generation or production host were exercised. The full release acceptance
belongs to the parent refinement's integrated checks.
