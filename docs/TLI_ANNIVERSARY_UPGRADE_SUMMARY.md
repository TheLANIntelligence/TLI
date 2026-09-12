# TLI anniversary upgrade summary

TLI's anniversary work develops the original private home console into a more
consistent place to manage computers, keep useful information, investigate
problems and review actions. It includes interface work, new workflows,
preservation fixes, a rebuilt Android Beta and real model evaluations.

This is an inventory of the work across the anniversary checkpoints, rather
than a claim that every idea on the roadmap has passed every acceptance test.
Existing features that were reorganized or made more dependable are identified
alongside new capabilities. Earlier checkpoint records remain unchanged.

**Current completion checkpoint:** The [final delivery record](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANNIVERSARY_FINAL.md)
binds the accepted desktop package, Chat-first Android Beta8, complete software
checks and browser review. Unfinished remote additions are preserved in a separate
archive and excluded from this delivery. A room-display reopen race is fixed.
All 77 mobile upload inputs match the already signed Beta8, so another phone build
is unnecessary. The [hands-on guide](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANNIVERSARY_HANDS_ON.md) records what still
needs testing on actual devices.

The accepted 796-file source passed all 27 software stages: **2,769 backend,
2,757 extracted-package backend, 1,133 desktop, 178 tooling and 191 Companion
tests**, plus strict TypeScript, three clean exports, HTTPS restart and synthetic
recovery. Source and artifact identity are recorded in the
[final manifest - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md).

A prospective Standard-model comparison rejected the experimental case-answer
preparation: it regressed on retained questions and introduced new zero-score
answers. The prior preparation, active model and default remain. Neither version
meets the full AI quality bar; the [model report](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANNIVERSARY_FINAL_MODEL_CHECK.md)
keeps actual answer failures separate from passing software checks. This inventory
describes implemented features, not a claim of dependable answers in every case.

**Latest phone correction:** [Companion Chat first](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_COMPANION_CHAT_FIRST.md) puts
the ordinary conversation at the centre of the phone app: Chat opens first, the
message box stays visible, and optional context moves into its own sheet. The
signed [Beta8 Android update](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_COMPANION_CURRENT.md) preserves Beta7's package,
signer, public version and pairing keys. It passed 191 mobile tests, 169 browser
workflow checks, TypeScript, three clean exports and 14 native transport tests.
Physical phone and keyboard acceptance remain separate and not run. Remote access is
explicitly deferred, and the desktop installation is unchanged.

**Previous browser checkpoint implemented:** [Workspace cohesion](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_WORKSPACE_COHESION.md)
aligns page layouts, condenses Dashboard, fixes inconsistent host labels and
stale drive suggestions, puts symptom entry and one reviewed check together,
restores a prominent hierarchical Free Space map beside its records, and makes
Performance & apps lead with useful setup or retained results. Both complete
interfaces and all 23 themes remain. See the
[review gallery - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md) and
[coverage record](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_WORKSPACE_COHESION_ACCEPTANCE.md). This is browser/source
work; previous model-quality failures and physical acceptance are still separate.
The final candidate passed **2,769 backend, 1,132 frontend and 178 tooling tests**
and its matched browser matrices.

**Previous checkpoint implemented:** [Finish the fix](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_FINISH_THE_FIX.md)
adds evidence-based next-check guidance, narrow factual answers from selected
case records, reviewed encrypted file handoffs and the same next-check flow in
Companion. Its frozen 785-file candidate passed all 27 software stages: **2,741
backend, 2,729 extracted-package backend, 178 tooling, 1,093 frontend and 183
Companion tests**, plus TypeScript, mobile exports, HTTPS restart and synthetic
recovery. The signed **Android Beta7** matches Beta6's package and signer.

The [review gallery - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md) shows the workflows;
the [manifest - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md) binds their source
and artifacts. The [acceptance record](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_FINISH_THE_FIX_ACCEPTANCE.md) keeps
physical two-computer and Android results **not run**. The
[Standard answer review](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_FINISH_THE_FIX_MODEL_CHECK.md) records an improvement
from 5/20 to 8/20 complete passes due to factual routing. Five deterministic
replies pass; only three of fifteen model replies do. Model explanations remain
unreliable in some cases, so no validated winner or model recommendation change
is claimed. The preceding verified candidate and artifacts are retained below.

**Previous checkpoint:** [Dependable across your computers](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_DEPENDABLE_COMPUTERS.md)
adds running-code identity, explicit bilateral computer trust, bounded peer
observations, guarded routine execution, reviewed case/report facts and matching
Companion evidence/build details. Its delivery record separates software checks,
actual model answers and physical acceptance. That checkpoint left new LAN file
transfers unavailable while text used the reviewed HTTPS transport; the current
batch supplies the separate transfer protocol and receiving workflow.

Its final 765-file candidate passed all 27 software stages: **2,633 backend,
2,621 extracted-package backend, 169 tooling, 1,048 frontend and 170 Companion
tests**, plus TypeScript, mobile exports, HTTPS restart and synthetic recovery.
The signed Android **Beta6** matches Beta5's package and signer; all uploaded
mobile source files match this host candidate. See the
[acceptance record](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_DEPENDABLE_COMPUTERS_ACCEPTANCE.md) for the physical gates
that remain not run. The [actual Standard answers](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_DEPENDABLE_COMPUTERS_MODEL_CHECK.md)
still misinterpret some historical facts and past steps despite the correct
deterministic summary. Software verification does not clear those quality
failures; the strict comparison still has no validated winner.

The preceding [Free Space rebuild](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_FREE_SPACE_REBUILD.md) passed 2,508 backend,
1,026 frontend, 168 tooling and 197 synthetic browser checks for its frozen
candidate. The whole-interface **Classic / Modern** switch and all themes remain.
Current physical-device and model-quality limitations are not cleared by these
interface or workflow upgrades.

## What the status labels mean

| Status | Meaning in this summary |
|---|---|
| Implemented | The application has a working controller and backend behavior where required, rather than only a mockup or help page. |
| Software verified | Relevant isolated tests, browser fixtures or package checks are recorded for a specific source snapshot. It does not mean the live installation was updated. |
| Physically verified | Requires an actual phone, host platform, device or configured service. Software tests and screenshots cannot supply this result. |
| Not run | The required physical or external setup has not been exercised. This remains visible even where its software is implemented. |
| Deferred or outside scope | The capability is not implemented in this checkpoint, or its narrower supported scope is stated. |
| Rejected / rolled back | A change was tested and did not satisfy its acceptance rule. Its evidence is retained; it is not presented as an upgrade. |

For the current detailed capability reference, see
[TLI capabilities and boundaries](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CAPABILITIES.md). For the order of earlier
work and still-open ideas, see the [anniversary roadmap](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANNIVERSARY_ROADMAP.md).

## 1. The browser interface, navigation and identity

The browser now uses coordinated page headers, local outline icons, labeled
fields, buttons, status messages, empty states, dialogs and responsive layouts.
Relevant host, computer, path or resource information is kept close to the work
it describes. Technical details can be expanded without dominating everyday use.

Desktop navigation has grouped destinations that reveal the active page.
Phone-width browser navigation provides Dashboard, AI Chat, Files and a grouped
More menu. Settings, search and Activity stay accessible. The same names are used
across navigation, page guidance and search; earlier names remain aliases:
**Computers** retains Mesh, **Free Space** replaces inconsistent Visualizer
wording, **Notes & fixes** opens the existing Notebook, and **Performance & apps**
includes the retained game-settings readers.

Search and navigation open the existing workflow. They do not silently send a
question, add private context, execute a cleanup, create a pairing invitation or
start a model. Actions exposed through search use their existing review and
result handling. Keyboard focus, narrow screens, enlarged text and reduced motion
are part of the recorded browser checks.

The sidebar logo was revised to the requested lowercase **tli** mark, with local
assets and colors coordinated with the selected theme. System fonts and bundled
assets keep the interface independent of an external design service.

### Classic or Modern: choose the interface, then its colors

Use the header's **View → Modern UI / Classic UI** dropdown, or the two interface
cards in **Settings → General → Appearance**. Modern remains the default. This
choice is saved locally for this browser, independently of the color theme; it
does not change another browser or phone's settings. If browser storage is
unavailable, the choice applies to the current page with a visible warning.

**Classic UI** reconstructs the arrangement of the earliest retained TLI source
(`ff6c4e51`) and adapts it to today's capabilities. It restores the circular
**TLI** badge and uses a compact 104-pixel, always-open navigation rail, a different
workspace layout and card treatment, classic Chat bubbles with a right-hand
quick-start area, and a longer Settings page with its
sections together. **Modern UI** uses the anniversary navigation groups and
current focused layouts. Classic is a usable presentation of current TLI, not
just an old screenshot or a palette change; it is not an exact old binary.

Switching reuses the existing page controls and feature owners. It does not
reload, change the active destination, submit an action, start AI or rewrite
saved records. Input drafts, selection and useful scroll position are preserved
by the presentation controller. Both modes retain today's authentication,
review, encryption and truthful-result protections.

**Verified scope:** the matched run passes 36 browser checks and 664 layout
observations across both interfaces, all 23 palettes and 93 screenshots. Its
161 computed contrast scopes have no failures or unresolved review items.
The complete frontend suite passes 986/986 tests. These are browser/software
results, not physical-phone or accessibility certification.

This review also corrected two demonstrated older navigation gaps in both modes:
Troubleshooting is now created as a visible sidebar destination when missing from
the original markup, and the 320-pixel More drawer scrolls to its lower entries.
Dragging its handle can close the drawer; ordinary menu scrolling no longer
triggers dismissal. The obsolete hidden selector that changed only the landing
panel was removed. Startup still opens Dashboard unless an explicit deep link
applies, and older browser preferences are not erased.

All sixteen earlier themes received complete anniversary palettes. Six new
choices—**Porcelain, Pacific, Copper, Rose Quartz, Arctic and Graphite**—were
added, followed by **Classic TLI**, bringing the established library to 23.
Appearance includes palette previews and Light/Dark/New filters. Existing theme
selections are preserved; browsing previews does not save a new choice, and failed
saves restore the prior selection. Shared tokens cover surfaces, text, controls,
feedback and the manual.

The earlier palette is now labeled **Classic Mint** to distinguish it from
Classic UI. Its internal `classicTli` identifier is preserved, so an existing
selection still opens. Any supported palette can be used with either interface;
choosing Classic UI does not overwrite the saved theme. No historical scripts,
backend, credentials or data are rolled back to obtain the earlier layout.

**About → TLI through the years** already provides local historical and anniversary
exhibits. They use synthetic content and inert historical views, rather than
running old application code against current data.

Sources: [interface refinement](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_INTERFACE_REFINEMENT.md),
[theme refresh](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_THEME_REFRESH_ACCEPTANCE.md),
[whole-interface Classic/Modern behavior and checks](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CLASSIC_INTERFACE.md),
[section clarity](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_SECTION_CLARITY.md), and
[historical provenance](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CONTINUITY_PROGRAM.md#historical-provenance).

## 2. Dashboard, Activity and Narrator

The Dashboard brings together attention items, the actual next reviewed action,
host/storage/device/AI information, recent activity and a useful Saved places
preview. Favorites open their existing review dialog. Secondary shortcuts remain
available without repeating the same primary action in several cards.

Shared observations align the header and Dashboard. CPU, memory, storage,
connection status and AI readiness retain their different meanings. Old values
are marked stale; missing values stay unknown. Failed refreshes preserve an
earlier observation with its time, rather than presenting it as new. Drive warnings
identify the actual resource instead of assuming `C:\`.

Activity became a bounded, restart-surviving catch-up record with grouped events,
expandable details, explicit review markers and visible observation/retention
gaps. Reviewing an event does not repair its cause. Narrator gained Quiet,
Balanced and Detailed preferences, clearer warning explanations and steadier
spacing/deduplication while preserving critical alerts and deterministic timing.

Sources: [Dashboard rebuild](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_DASHBOARD_REBUILD.md),
[Dashboard browser evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_DASHBOARD_BROWSER_ACCEPTANCE.md),
[awareness](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/ANNIVERSARY_AWARENESS.md), and
[everyday saved tools](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/ANNIVERSARY_EVERYDAY_TOOLS.md).

## 3. AI Chat: clearer context, dependable continuity and honest evidence

Chat's composer, conversation list, working indicators and answer controls were
refined together. Failed or interrupted requests retain useful drafts and visibly
incomplete replies. Deliberate retry remains separate; reconnecting does not
silently resend a question. Opening Builder or another page no longer implies an
AI warm-up or generation request. Teaching remains an explanation preference,
not background training; reading an answer aloud uses the local playback controls
described below.

Two controls explain different sources of context:

- **Use saved notes** keeps its existing default. Turning it off prevents new
  ordinary-Chat note retrieval and historical note-revision lookups. It does not
  erase messages already present in a conversation.
- **Use earlier conversation** is a separate per-question choice, defaulting on.
  Turning it off excludes prior exchanges and their follow-up topic seed. It is
  not a saved preference, and a path unable to honor it refuses the request.

Short follow-ups can reuse a recent user topic with current note revisions and
matching computer scope. An assistant's earlier assertion is not promoted into a
fact. Invalid or empty history positions remain barriers, so they cannot join an
unanswered question to an unrelated answer. Historical changed or unavailable
note references identify the earlier exchange and old revision without
reconstructing deleted bodies or changing old answers.

**Sources & interpretation** distinguishes current backend observations, saved
historical reports, user-written notes, AI suggestions and confirmed historical
outcomes. Source receipts describe what was actually supplied. Computer/report
scope must agree. Current observations use a 30-second freshness boundary;
historical dates are not treated as a current health reading.

Citation checks establish that a source identity or document line range was
supplied. They do **not** prove that the answer's conclusion follows from it.
Invalid references remain unverified text, and citation-shaped streaming output
is not given premature verified navigation. Opening a source is read-only until
the user explicitly chooses another action.

Text preparation accounts for the owned bundled runtime's configured input
capacity when known, reserves response space and preserves the established
12,000-character ceiling. Estimates are conservative heuristics, not exact
tokenizer guarantees. Optional notes/history are trimmed as whole units; oversized
mandatory context is rejected before inference. Model/endpoint identity is checked
again before transport. Unknown provider capacity remains unknown.

Sources: [Chat refinement](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/AI_CHAT_REFINEMENT.md),
[answer/context contracts](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANSWER_QUALITY.md),
[useful answers](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_USEFUL_ANSWERS.md),
[answer reliability](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANSWER_RELIABILITY.md), and
[evidence-led troubleshooting](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_EVIDENCE_LED_TROUBLESHOOTING.md).

### Documents, screenshots and voice

**Selected documents:** text and Markdown gained an explicit review-and-question
workflow. Longer supported documents can supply whole numbered excerpts, with
included ranges and omitted coverage visible. Missing passages may contain an
important exception. Original files are not modified or silently indexed.

**PDF and DOCX:** choose **Check PDF & Word support**, select a file, review its
extracted text and coverage, then accept it before Send. Selecting a binary
uploads it to the TLI host for bounded extraction; it does not call a model.
Parsing has file/page/expanded-ZIP/text/time limits, uses bounded workers and
does not run macros or document programs. Image-only pages need OCR that this
workflow does not provide. Password protection is not bypassed. Binary inputs are
discarded, and saved Chat receipts retain identity/ranges rather than full
document bodies. Extraction success does not guarantee every excerpt fits the
selected model.

**Screenshot guidance:** explicitly chosen images can be reviewed with an
explanation, error or next-step question and a separately selected computer/report.
Provider and image support remain explicit. This is not background screen
watching, remote control or an autonomous action tool.

**Local voice:** the Chat microphone opens a dialog for support checking, explicit
push-to-talk, an editable completed transcript and a separate **Add to draft**.
It never presses Send or executes a recognized command. Recognition requires
browser-enforced on-device processing; playback permits only voices reported as
local. Missing local support does not fall back to cloud speech. A user-requested
language-pack download may contact the browser vendor. Real microphone, voice
quality and platform acceptance remain not run.

Sources: [document workflow](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/DEPENDABLE_DESKTOP_WORKFLOWS.md),
[PDF/DOCX scope](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_RICH_DOCUMENTS.md),
[screenshot assistance](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/GUIDED_SCREENSHOT_ASSISTANCE.md), and
[local voice](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_LOCAL_VOICE.md).

## 4. Notes & fixes and useful reference

The existing Notebook now says what it is for: **“Keep setup details, preferences
and past fixes so you can refer to them later.”** Setup detail, Preference and
Fix to remember starters create unsaved drafts for both new and returning users.
A starter is not a verified fix. Revision checks protect edits/deletions, and
Back, Close or opening another note preserves a draft or requires deliberate
discard. Private drafts remain in memory and clear on lock.

Saving an AI answer or updating an existing note is a separate reviewed action.
A before/after update requires the current revision; conflicts do not overwrite
or retry. Replacing a confirmed fix with an AI suggestion removes its prior
diagnostic-confirmation association. User-written information, saved AI text and
confirmed historical outcomes retain distinct origins.

A question about **up to four selected notes** uses those revision-checked notes
and the current question as a standalone request. Earlier conversation is
excluded in that mode; incompatible computer/report, document, image or
Vault-secret selections must be removed before sending. Selecting or opening a
note never sends it to AI.

Optional **Related notes** lets the user review up to 64 whole notes and an
existing loopback embedding service before building a temporary index. Searching
returns similarity candidates, not factual confidence. It does not alter ordinary
Chat memory or install/switch a model. **Linked notes** records explicitly reviewed
relationships and revision pointers; changed or deleted targets remain visible,
and links do not follow themselves into Chat. Live embedding quality is unverified.

With PIN protection disabled, local access shares one owner. “Account-scoped”
does not promise a separate private account for each browser. Vault notes remain
a different store behind their own passphrase.

Sources: [Notebook foundations](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/HOUSEHOLD_NOTEBOOK.md),
[Notes & fixes clarification](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_SECTION_CLARITY.md), and
[related notes and links](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_REFERENCE_LINKS.md).

## 5. Files, Free Space and Saved places

**Files** separates AI advice from an executable file plan. Rename/organize work
reviews exact host paths and collisions before execution. Per-file outcomes show
success, failure or partial completion. Guarded undo checks identity and retains
unresolved records. Failed replacement advice or previews preserve earlier useful
work; merely opening Files does not operate on household files.

**Free Space** now prepares a location before an explicit Scan. A searchable,
sortable location navigator replaces the drive wall in Modern; Classic retains
a card arrangement using the same controller. The chosen host/path, limits and
exclusions are visible before Quick (15 seconds) or Deep (up to five minutes).
Read-only owned workers provide authenticated jobs, real phases, counts and
confirmed cancellation. One intensive storage reader runs per host; bounded
memory, tree representation, transport and result retention constrain its work.

The explorer has sortable files and folder totals, breadcrumbs, exact paths,
paging and explicit counts. Map and File types share the observation. Large-file,
duplicate and common-folder searches and saved comparisons are separate explicit
tools. Failed replacements preserve previous observations and duplicate keeper
choices; interrupted usable results need an explicit View partial results action.
Unknown sizes and incomplete coverage cannot masquerade as empty successful scans.

Selections lead to reviewed Trash, including a phone drawer. Protected paths,
duplicate keepers, preview expiry and identity checks remain. Uncertain receipts
survive Clear and Remove; no request replays automatically. Revocation stops
subsequent moves. Legacy direct-cleanup URLs refuse execution, and the retired
automatic cleanup scanner cannot move files. Drive capacity, inspected sizes and
selected sizes are distinct; a Trash receipt does not prove freed space.

Files and Chat handoffs are reviewed and protect existing drafts. Navigation does
not scan, send chat or prepare file operations. Storage-history key protection is
extended without changing saved formats or backup scope.

**Saved places** provides encrypted owner-scoped favorites for existing folders,
drives, notes and panels. Targets are reviewed and unavailable destinations are
reported. The Dashboard shows useful previews rather than only an Open button.

Sources: [dependable file workflows](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/DEPENDABLE_DESKTOP_WORKFLOWS.md),
[reviewed cleanup](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/REVIEWED_STORAGE_CLEANUP.md), and
[saved scans and favorites](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/ANNIVERSARY_EVERYDAY_TOOLS.md), and the
[complete Free Space rebuild](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_FREE_SPACE_REBUILD.md).

## 6. Vault: a rebuilt workspace and complete portable backup

Vault, one of TLI's earliest features, received a dedicated access screen and a
compact searchable workspace for encrypted files, secrets and private Vault notes.
It explains the separate passphrase and existing 30-minute account access period.
Files have an explicit encrypt/upload step; secrets reveal or copy only on request.
Note drafts are protected, matching destinations require review, and changing a
title is clearly a separate-note save rather than a silent rename.

Locking clears readable private content and rejects late responses. Failed
operations retain useful prior lists/drafts where appropriate. Damaged encrypted
stores report unavailable rather than becoming an empty replacement; encrypted
writes are atomic, and a failed durable lock revocation is reported honestly.

The newer **portable Vault backup** adds four deliberate operations:

1. **Check Vault** authenticates the current accessible contents and reports
   counts/time without making an archive.
2. **Create portable backup** requires an unlocked Vault and a separate archive
   password. A prepared download can be found again without creating another copy.
3. **Verify backup** checks a chosen archive/password without restoring it.
4. **Recover to a separate folder** reviews an exact new destination, then creates
   a separate encrypted copy with a fresh Vault passphrase and current-reader
   verification. It is locked, with autofill disabled, and is not activated.

The archive covers shared Vault files/notes and the authenticated account's
accessible secrets/saved logins. It excludes other private accounts, PIN/TLS,
Companion credentials, sessions and machine keys. Limits are 250 MiB per file,
4 GiB total and 10,000 entries. Existing normalized names and accessible legacy
ownership rules are preserved, not guessed or silently reassigned.

The older encrypted-file ZIP remains distinct and incomplete; it still needs
its matching installation metadata/keys. Portable recovery never merges into or
replaces the live Vault. Current separate-copy recovery supports Python/source
installations; frozen standalone recovery and physical recovery acceptance remain
outside the verified scope.

Sources: [Vault rebuild/preservation](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_VAULT_PRESERVATION.md),
[Vault browser review](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_VAULT_BROWSER_ACCEPTANCE.md), and
[portable backup contract](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_VAULT_BACKUPS.md).

## 7. Saved data and recovery beyond Vault

**Settings → Saved data & backups** distinguishes checking current data,
creating an archive, verifying an archive and recovering a separate copy.
Unreadable keys or stores are preserved and reported; backup status is not
invented from the existence of a file.

Password-protected saved-work archives cover Notes & fixes, owned conversations
and diagnostic history. Explicit **v2** also includes Troubleshooting cases;
existing v1 callers and archives retain their original three-store scope.
This archive is separate from Vault backup and from whole-installation backup.

Separate-copy recovery reviews the archive, exact new host folder and account
mapping before a single-use create action. It writes fresh encrypted stores,
preserves record IDs/revisions/dates/provenance and verifies them with current
readers before success. Recovered data maps to the new copy's `local` owner while
retaining original ownership metadata. It creates neither access credentials nor
an automatically running installation. Existing destinations are never replaced.

Sources: [saved-data preservation](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/DATA_RECOVERY.md),
[separate recovery](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_SEPARATE_RECOVERY.md), and
[case/archive continuity](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CONTINUITY_PROGRAM.md).

## 8. Troubleshooting, diagnostics and Performance & apps

**Troubleshooting** is now a persistent, encrypted, account-scoped problem
workspace. A case records a symptom, an explicit computer, Planned/Tried/Skipped
steps, outcome notes and selected evidence links. Resolving a case records the
user's conclusion; it is not proof that a device recovered.

Guided checks review the implemented check, executing host, target and scope
before an explicit Run. System/network checks execute on the TLI host; device
reachability is measured from that host. There is no new universal remote
execution facility. Running saves a report, linking it to a problem draft and
saving that problem remain separate operations. Failed saves and revision
conflicts retain drafts and identify an already-saved report.

Saved reports can be reviewed, compared or deliberately repeated. Comparisons
retain recording times, targets, missing values and workload caveats. They do not
enable background rechecks. **Discuss** explicitly hands a chosen report to Chat;
opening report history alone does not attach or send it.

**Recorded facts** separates measured report content from AI interpretation.
The host/process, interval, completion state, coverage and valid units are shown
before conclusions. Performance aggregates are calculated from saved samples;
missing/invalid readings stay unknown. Completing sampling does not establish a
successful application task, cause, repair or current health. Explicit selected-
report summary questions can receive deterministic backend answers without AI.

**Performance & apps** provides an explicit desktop observation of a selected
host process for up to 30 seconds. PID plus creation time avoids confusing a
reused process ID. Host CPU/memory and selected-process measurements remain
separate; interrupted observations are partial. It does not tune the computer,
kill processes, measure FPS, prove a bottleneck or represent an entire
multi-process application automatically. Existing supported-game settings
readers remain available.

Reusable **guides** contain editable descriptions and planned steps. Import
creates an unsaved draft with new step IDs, not inherited success, targets or
executable commands. Reviewed **case-to-Chat** context selects exact revisions,
steps and evidence; it does not include all linked notes or prior conversation
implicitly. Reviewed **case exports** offer inert HTML, text or JSON with selected
evidence and redactions. They are unencrypted support summaries, not backups.
Redaction cannot discover every secret, so the complete preview requires review.
Report exports identify their summary scope and exclude raw samples/attachments.

Sources: [Troubleshooting](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_TROUBLESHOOTING.md),
[guided workflow](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_DEPENDABLE_TROUBLESHOOTING.md),
[Performance & apps](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_PERFORMANCE_APPS.md),
[recorded outcomes](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_RECORDED_OUTCOMES.md),
[case context](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CASE_CONTEXT.md), [guides](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CASE_GUIDES.md),
[exports](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CASE_EXPORTS.md), and
[latest report evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_EVIDENCE_LED_TROUBLESHOOTING.md).

## 9. Computers, Phone Companion and connections

**Computers** keeps Mesh functionality but makes stable identities, connection
observations, reported capabilities and the selected target clearer. Duplicate
display names remain different computers. Installed model files, selected
configuration and confirmed running AI are separate states. Browser satellite
access remains an explicitly named older workflow, not native phone pairing.

**Phone Companion** has one discoverable desktop setup page, reachable through
navigation, Settings, Computers, onboarding and search. Owner access, secure
connection, creating a pairing QR and managing paired phones are separate stages.
Opening the page creates no invitation. LAN address selection is certificate-
checked; a virtual adapter or covered certificate name does not prove phone
reachability. Running-now settings, saved startup choices and effective next
startup are distinguished; saving them does not restart TLI.

The native app work extends shared conversations, Notes & fixes, context/source
receipts, reviewed note saves/updates, Computers, diagnostic history and
Troubleshooting. Guided checks review scope before Run, and case saves remain
separate from report creation. Stopped/interrupted replies remain identified;
backgrounding clears private drafts and prevents late results from repopulating
them. Reconnection does not replay messages or actions automatically. Existing
Today, Ask, Home, photos and favorites remain part of Companion.

**Android Beta 0.1.0 (5) was actually built.** Its package remains
`com.thelegatointelligence.companion.beta`, its verified signer matches retained
Beta 4, and its 70-file mobile source/build binding is recorded. Fourteen cloud
native checks passed. APK SHA-256:
`05ba3ea8e8ef2985338e225da91dc3bdbb851107f430b6f91ac7f7a5754d6424`.
This does not mean the phone was updated. Physical update-without-uninstall,
retained pairing, interruptions, restarts and away-from-home use are **not run**.

The optional remote guidance uses an externally managed private route to the
existing trusted LAN origin. TLI creates no tunnel, public port or new certificate
trust. A setup check is not proof of real away-from-home access. Destructive file
work, Vault recovery, Builder administration and new performance sampling remain
desktop workflows. The subsequent Beta6 added matched report facts, peer scope
and evidence presentation; the current **Beta7** adds reviewed next-check guidance.
Its source, signature and software checks are verified, while native physical
report review, installation and retained pairing remain **not run**. The
[current Companion delivery](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_COMPANION_CURRENT.md) supersedes the historical
Beta5 artifact above without removing it.

Sources: [Companion](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_COMPANION.md),
[pairing addresses](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_COMPANION_ADDRESS_FIX.md),
[private-route scope](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_COMPANION_REMOTE.md),
[physical acceptance checklist](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_TROUBLESHOOTING_PHONE_ACCEPTANCE.md), and
[Beta 5 package/source verification - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md).

## 10. Devices, rooms, routines and optional integrations

**Smart devices** uses stable registry IDs, addresses and relay numbers, with
clarification for ambiguous names. Shared room, importance and relationship
metadata is user-entered, not inferred physical location or measured severity.
Device details and account-scoped diagnostic timelines preserve recording times.
Shelly discovery is labeled by its actual supported scope.

Passive **power history** captures meter values returned by already-requested
Shelly status reads, with exact relay identity and gaps. It adds no polling and
does not invent energy consumption between samples. **Rooms & devices → Room
display** offers an explicit room choice and saved-observation reads, not an
occupancy sensor, automatic controller or restricted kiosk account.

**Automations** now provides reviewed **manual routines**: templates, editable
steps, target previews, save, then a separate explicit run of the current reviewed
revision. Durable receipts and request IDs guard duplicates. Partial or uncertain
results remain visible. Legacy presence, power and daily trigger definitions are
preserved, but their missing trigger executor is not activated by this upgrade.
Portable troubleshooting guides are descriptions, not executable routines.

Three optional integrations have concrete, deliberately narrow implementations:

| Where | What it adds | Boundary |
|---|---|---|
| Settings → Security & connections → Local MCP connections: TLI server | Temporary selected read-only access to registered devices, already reported host health and recorded rooms, plus a local inspector. | Owner-PIN review, dedicated short-lived grant and actual loopback client. No Vault, notes, files, Chat or device commands. |
| Same Settings section: manual MCP client | Explicitly connect to an existing local server, list tools, inspect exact schemas/arguments and invoke one reviewed tool. | Literal loopback endpoint on another port; temporary session. Server metadata/effects are untrusted. No stdio launch, remote/public server, automatic retry or Chat tool registration. |
| Smart devices → Optional Home Assistant connection | Review an existing private origin, connect temporarily, explicitly read light/switch states and review one On/Off service request. | No scenes, automatic rules, broad service execution or registry import. An API acknowledgement is not physical confirmation. |

Both MCP directions passed isolated official SDK interoperability in addition to
controller/transport tests. Home Assistant passed synthetic transport/controller/
browser checks. These are working optional integrations, but real third-party
deployment, household credentials and physical light/switch acceptance remain
not run. Temporary credentials are not added to persistent configuration or
backups. Closing a view clears displayed private information; it is not a promise
to cancel work already submitted or revoke an external token.

Sources: [dependable device control](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/DEPENDABLE_HOME_CONTROLS.md),
[Room display](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ROOM_DISPLAY.md), [manual routines](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ROUTINE_REVIEW.md),
[MCP server](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_MCP_BRIDGE.md), [MCP client](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_MCP_CLIENT.md), and
[Home Assistant](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_HOME_ASSISTANT_BRIDGE.md).

## 11. Printers, utilities and creation tools

| Section | Anniversary change or preserved workflow |
|---|---|
| Printers & USB | Clear inventory/queue states, explicit host OS/printer actions and dependable duplicate/result handling. A submitted test page does not confirm physical printing; unavailable supplies remain unknown. |
| Print & Scan | Await the selected device and actual result. Keep the previous scan preview/download until replacement content succeeds. Driver/OS/device support remains a prerequisite. |
| LAN Messages | Clear recipient, connection and transfer workflow; preserve failed work and deliberate retry. Optional cross-network relay access remains separate from LAN-only operation. |
| Utilities | Review a diagnostic or installed script, target and parameters before Run; show actual output and optional AI explanation separately. Some public-address checks contact the internet. |
| Scripts | Generate a draft, inspect it, copy/download it, then choose execution separately. Generating a backup script is not making a backup. |
| Builder | Per-project in-memory drafts; consume only the submitted text/attachments after success; guard competing requests and project switches; require fresh project approval; preserve the prior diff preview on failure. Proposed, applied and executed work stay distinct. |
| TLI Hub | Show source, package type, installed state and the exact effect: install, apply a theme, select a prompt or execute a script. Listing is not vetting, and sharing on this host is not public store publication. |

These workflows retain their existing feature controllers and platform
requirements. Host/project permissions are not an operating-system sandbox.
See [section-by-section implementation and checks](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_SECTION_CLARITY.md) and
[the current capability reference](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CAPABILITIES.md).

## 12. Model library and what the real evaluations established

The model library now distinguishes downloaded components, selected configuration
and confirmed runtime readiness. Host resource estimates, required projectors,
compatibility reasons, staged/checksummed downloads and explicit activation are
visible. A successful installation does not silently change selection. Unknown
compatibility is not shown as ready. Onboarding names the actual chosen download
and disables downloads when usable choices have not loaded.

Existing Qwen options were retained and optional Qwen3 1.7B, 4B and 8B text
artifacts received pinned requirements. Technical details links real evaluation
records, rather than calling a model “best” without supporting results. Bundled
inference can work offline after installation; downloads, configured providers,
search, relays and some diagnostics may contact outside services.

Real evaluations used owned isolated runtimes and synthetic information; they
did not query household data or change the user's active model. The later
six-preset study recorded 330 scored positions, 328 received answers and two
timeouts, plus separate timing repeats. **No preset passed its required quality
gate.** That study's raw provider questions are not evidence that production
Chat's deterministic handlers were exercised.

Subsequent studies captured/replayed actual Chat preparation and routes. In the
latest evidence-led study, candidate Standard's application grounding fell from
41 to 39 points and context from 43 to 40 across 36 positions. The prospective
retention rule therefore failed. The candidate prompt/table/reference-JSON
changes were **rolled back**, while report receipts, deterministic summaries,
history barriers and the tested device-status fix were retained. Qwen3 8B also
failed the strict gate and had one missing application answer. There is no
validated winner or new default/recommendation.

The final rollback's offline proof checks 91 exact common model requests and
Standard launch arguments against baseline, with two explicit routing exceptions.
It is input restoration, not a new answer-quality score. Original studies, failed
checks, assessments, adjudications and source identities remain available.
The latest review was only partially blinded because of recorded metadata
exposure and recognizable context; consumed holdouts are not reused as unseen
tuning evidence. Timing is reported within its measured scope, not a guarantee
of future speed or correctness.

Sources: [model options](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/QWEN_MODEL_OPTIONS.md),
[six-model report](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/frontend/model-comparison-anniversary.html),
[answer reliability decision](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANSWER_RELIABILITY.md), and
[latest results, rollback and independent audits](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_EVIDENCE_LED_TROUBLESHOOTING.md).

## 13. Settings, security, API compatibility and preservation

Settings is organized around browser preferences, host configuration, access,
connections and saved data. Search, onboarding, About and the manual use the same
purpose and prerequisite descriptions. PIN and HTTPS are reviewed choices, not
assumed active simply because controls exist. Saving startup choices does not
restart the running host; an unusable requested certificate does not quietly
fall back to HTTP.

The preservation work follows these practical boundaries:

- Existing valid records, ownership, IDs, revisions, timestamps, theme selections
  and model defaults remain authoritative. New receipts are additive; legacy
  turns do not receive invented provenance. Old record bodies are not rewritten
  to match newer UI wording.
- Existing encrypted stores and missing-key failure behavior are preserved.
  Unreadable data is not treated as an empty writable store. New replacement
  writes/recovery publication use guarded, verified paths.
- Existing Chat/SSE and Companion endpoints remain; optional request/receipt
  fields preserve old defaults. Unsupported sharing modes fail explicitly.
  Saved-work v1 remains readable and available to old callers; v2 and portable
  Vault backup are explicit formats with separately stated scope.
- Navigation is separate from execution. Confirmation, revision checks,
  one-use reviews, duplicate guards and truthful partial/uncertain receipts are
  used where each workflow requires them. View close does not assert server-side
  cancellation. Deliberate retry does not become automatic replay.
- Lock, expiry, navigation and stale-response guards clear private views and
  prevent old requests from overwriting a newer session. Source credentials are
  not silently reused for optional integrations.
- Source snapshots preserve the uncommitted working tree. Older archives,
  releases, reports and failed candidates are retained; a changed source requires
  its own verification rather than relabeling an earlier pass.

These are implemented and tested boundaries, not a claim of a comprehensive
independent security certification, every historical release's compatibility,
or a complete audit of the live user's data. See
[SSE contracts](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/SSE_SCHEMA.md), [startup recovery](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/SAFE_STARTUP_COMPANION_RECOVERY.md),
[saved-data rules](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/DATA_RECOVERY.md), and
[release/rollback scope](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/ANNIVERSARY_INSTALL_ROLLBACK.md).

## 14. Verification, delivery and remaining work

The anniversary checkpoints include full backend/frontend/tooling suites,
synthetic browser coverage of the shell and feature flows, all-theme checks,
before/after screenshots, tablet and 390/320-pixel layouts, keyboard navigation,
enlarged text and reduced motion. Failed requests, partial results, duplicate
submissions, stale data, session locks and late responses are exercised where
relevant. Browser fixtures intercept requests and use synthetic files/devices;
they are not household acceptance runs.

The earlier evidence-led source before the Classic/Modern interface-mode work,
fingerprint `59a4735c0217cd652aec591e0dbb981d30a7819be3680cbcf0243990fe556875`,
passed 27 release gates: 2,431 source backend, 2,419 extracted backend, 168 tooling,
973 isolated frontend and 149 Companion tests, plus TypeScript, exports and
packaging/startup checks. These counts belong to that source. Counts from
overlapping checkpoints are not added together as unique coverage.

The earlier Classic/Modern checkpoint source has 723 files and fingerprint
`6e158d670e10d9ecefaf5c4dea7e313fe037a0e97a14369e06bda0a1999daf6f`.
It passes 986/986 frontend tests and the matched 36-check, 664-layout browser
matrix across 23 palettes, with 93 screenshots. The 161 contrast scopes have
zero failures or unresolved items; the run records no browser errors, unexpected
actions or source drift. Backend and native Companion source are byte-for-byte
unchanged from baseline `59a4735c…`; their suites were **not rerun** for this
browser-only change. The earlier 27-gate release proof keeps its original source
identity. No new native build or model benchmark is claimed for the UI switch.

Release checks include fresh runtime-only imports, dependency recording,
source/archive hashes, isolated current-reader recovery, actual owned loopback
HTTPS/PIN stop/restart and the specified synthetic rollback rehearsal. The
compatibility reference predates Companion and is not a promise about every
published release. A verified source ZIP is not a native installer or evidence
that live TLI was restarted.

| Remaining status | Concrete boundary |
|---|---|
| Latest UI mode | Whole-interface Classic/Modern is implemented and verified against its own final source. The earlier Classic palette remains an independent color choice; physical-phone and screen-reader acceptance are not run. |
| Model quality | Failed strict gates; no validated winner. Rejected preparation was rolled back. Further improvement needs prospective tests and a new holdout. |
| Physical Companion | Current Android Beta8 built; package/signer compatibility with Beta7 and exact upload-source binding verified. Actual update, pairing, keyboard, interruptions and iPhone acceptance remain not run. Remote access is explicitly deferred. |
| Native report parity | Beta6/7 implement matched report facts and reviewed next-check guidance using the shared contracts; mobile source, tests and exports pass. Native physical report review and continuation remain not run. |
| Optional services | Real MCP deployment/tool effects, Home Assistant devices, embedding quality and local microphone/playback acceptance not run. Synthetic interoperability is recorded separately. |
| Autonomous behavior | No unrestricted autonomous repair, hidden AI tool registration, background learning, automatic trigger executor, scene expansion or universal remote execution was added. |
| Recovery/platforms | No merging or activation over live data; whole-installation recovery, frozen standalone recovery and unperformed native-platform/device acceptance remain separate. |

The broader roadmap is an inventory of ideas and checkpoints, not an assertion
that everything is physically validated. TLI's purpose remains a private home
console whose user can see the source, target and effect of the next action.

### Review and evidence entry points

- [Classic/Modern implementation and verification](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_CLASSIC_INTERFACE.md)
- [Before, Modern and Classic gallery - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md)
- [Matched Classic/Modern browser report - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md)
- [Earlier full anniversary delivery and gallery](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANNIVERSARY_COMPLETION_PROGRAM.md#final-matched-delivery--september-8-2026)
- [Earlier software/external acceptance separation](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_ANNIVERSARY_COMPLETION_ACCEPTANCE.md)
- [Dependable troubleshooting and Companion checkpoint](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_DEPENDABLE_TROUBLESHOOTING.md)
- [Report/AI rollback delivery](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/TLI_EVIDENCE_LED_TROUBLESHOOTING.md#delivery-record)
- [Report/AI rollback before/after gallery - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md)
- [Report/AI rollback matched source/artifact manifest - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md)
- [Independent model-result arithmetic audit - local evidence](https://github.com/TheLANIntelligence/TLI/blob/anniversary-preview-1/docs/LOCAL_EVIDENCE.md)

Links in this downloadable inventory use the Anniversary Preview 1 tag so they
remain usable outside a repository checkout. Links marked **local evidence**
explain records preserved locally but not uploaded. The linked feature documents
retain the corresponding scope and limitations.
