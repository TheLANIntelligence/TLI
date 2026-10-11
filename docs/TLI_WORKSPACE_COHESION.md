# Workspace cohesion: fewer steps, clearer evidence

September 10, 2026. This checkpoint implements the approved review of Dashboard,
Troubleshooting, Free Space and Performance & apps. It refines the current browser
application, preserving the Modern/Classic interface switch and all 23 themes.
The running installation, model selection and household files were not changed
by automated verification.

The final candidate passed **2,769 backend, 1,132 frontend and 178 tooling tests**,
plus the matched browser matrices. The review gallery includes actual before
and after captures, with separate phone and Classic examples.

## Dashboard and shared layout

Modern pages use the available workspace with aligned headings and content.
Dashboard now has a compact heading, Narrator and health cards. Its recorded
suggestion is a separate card with its own target; it does not imply that an
independently selected Narrator observation refers to the same drive. Help and
host information share a compact row and remain expandable. Classic keeps its
card arrangement and navigation.

Host labels now use one validated identity record. Accepted command-center
identity, ordinary status and acknowledged renames update the shared labels;
older responses and lower-authority conflicting names cannot overwrite a newer
identity. Lock clears the identity and invalidates delayed replies. A locked
Dashboard offers one access notice instead of repeated private-data error cards.
Host identity remains separate from a tool's selected target or AI availability.

Storage suggestions are reconciled against the exact host and canonical mount.
A new reading updates the existing drive suggestion; a missing, failed, expired
or below-threshold reading withdraws it. A snoozed drive remains snoozed when
other drives update. The 30-second freshness rule still applies. Suggestion
receipts are checked against the reviewed target before navigation.

## Troubleshooting

The problem's symptom and explicitly selected computer lead the editor. An empty
unsaved draft can be typed immediately. **Save & find next check** explicitly
saves the draft, then prepares guidance from that selection. Opening the page,
preparing a draft or choosing a symptom does not run a check.

Optional evidence is selected inline. A single suggested check shows its host,
target, purpose and scope before its Run button. Long evidence details follow
that useful action. Other available checks remain secondary. Check execution,
saving its report and linking the report to the problem keep their separate
outcomes and duplicate-request guards. A failed link never reruns the check.

Steps, outcomes, resolution and title management are expandable. Unsaved edits
survive failed saves and revision conflicts; closing or locking still follows
the existing draft protections. Finding a check uses the existing deterministic
guidance service; it does not send Chat, start inference or change context-sharing
permissions. Chat's reviewed case-sharing dialog is unchanged.

## Free Space: a map connected to its records

After an explicitly requested scan, **Space map + list** is the primary desktop
explorer. It uses the bundled D3 renderer to show nested folders and file types.
The paginated, sortable list describes the same retained observation. Choosing
a block or list entry selects the same exact path; breadcrumbs and folder zoom
use cached results without silently starting another scan. Phones have explicit
Map and List surfaces. The list is the keyboard alternative to the visualization.

Proportional area represents known inspected bytes, not drive capacity or
recoverable space. Folder totals are counted once. Grouped paths, omitted
representation and small display remainders retain their aggregate bytes and
are nonactionable. Unknown sizes stay outside proportional area. Coverage and
representation limits remain available in the recorded-scope disclosure.

The renderer is bounded by the validated 25,000-node observation and a limited
visible representation. It rejects inconsistent folder totals. A failed
replacement preserves the earlier observation and its selections. Search and
filters are secondary; changing them does not alter recorded totals.

Inspecting a map block does not select cleanup. Review requires an individual,
eligible file and the existing reviewed Trash workflow. Folders, aggregates,
protected files and unknown identities cannot become cleanup selections. The
existing preview expiry, authorization, duplicate keeper, uncertain receipt and
per-file outcome safeguards remain in place. No permanent-delete action was added.

## Performance & apps

Setup fills the workspace while no result exists. Symptom starters prepare a
process filter and request the process list only after an explicit click; the
user still chooses an exact process and starts its observation. A custom draft
is protected before a starter replaces it. Completed or interrupted readings
lead the screen, with the setup condensed and expandable for another observation.

A Troubleshooting handoff only opens the host's Performance view. It does not
collect measurements or imply remote application diagnostics. Prior readings,
their times, Stop behavior, explicit saving and interrupted-output labels remain.

## Verification and preservation

The retained baseline is a 785-file source snapshot with fingerprint
`05f9aa8e95c94d17243b7c5c2b56dfa29c2afbb43f93484d5867353ae27ca071`.
It passed 2,741 backend, 1,093 frontend and 178 tooling tests. Existing Python
deprecation warnings were recorded separately; there were no baseline failures.

The [delivery manifest](../build_work/workspace-cohesion/final-manifest.json)
binds the final source and verification artifacts. The
[review gallery](../build_work/workspace-cohesion/review.html) contains actual
before/after browser captures with synthetic data. The
[coverage record](TLI_WORKSPACE_COHESION_ACCEPTANCE.md) distinguishes automated
software checks from unperformed physical and production checks.

Existing endpoints, SSE names, persisted data formats and backup scope are
preserved. New scan metadata is additive representation information. No model
evaluation, native Companion build, production restart or data migration belongs
to this UI checkpoint. Earlier model-quality failures and physical-device gates
remain open on the anniversary roadmap.
