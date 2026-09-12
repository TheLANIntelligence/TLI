# TLI capabilities and boundaries

Reviewed against current browser, backend and Companion controllers on 2026-09-10. This describes implemented interfaces, not a promise that every host has the hardware, provider, permissions or dependencies required. Acceptance records identify what has actually been tested.

TLI is a private home console for computers, devices, files and local AI. It runs on a host computer; a browser or separately installed Companion app accesses that host. The header identifies the connected host. Each operation has its own target; changing a header selection does not retarget every tool.

## Everyday

| Section | Current workflow | Requirements and result |
|---|---|---|
| Dashboard | Review attention items, Narrator messages, observed health, saved places and activity. | Metrics older than 30 seconds are stale; missing values are unknown. Host access, AI readiness and system health are separate. Reviewing an event does not repair it. |
| AI Chat | Stream answers; resume conversations; choose supported notes, computer/report, document or image context. Specific host-status questions use dated observations without a model. | AI answers require an available provider. Partial interrupted replies stay visibly incomplete, with deliberate review before retry. Context and input-size receipts report supplied facts and estimates, not proof of a correct answer. |
| Notes & fixes | Save setup details, preferences and past fixes; search, edit with revision checks, save an AI reply or ask about selected notes. | Starters create unsaved drafts. A fix starter is not a confirmed historical fix. Drafts stay in memory and clear on lock. |
| Files | Choose a host folder, prepare rename/organize operations, review paths and collisions, execute and inspect results. | Host path access is required. AI advice is separate from a reviewed operation plan. Failed replacement work preserves prior advice/preview. Undo has a recorded, guarded scope. |
| Free Space | Prepare a host location, explicitly run a Quick overview or Deeper scan, explore recorded files/folders with paging, Map and File types, run separate searches, compare eligible saved scans and review individual files for Trash. | One authenticated bounded storage job per host. Failed replacements retain the previous observation; stopped partial results need explicit review. Unknown sizes and incomplete coverage remain visible. Navigation does not scan. Trash receipts do not prove freed capacity; legacy direct cleanup URLs refuse execution. |
| Vault | Set up/unlock a separate passphrase-protected store for files, secrets, saved logins and Vault notes; check, create and verify a portable backup or recover it into a separate new folder. | Portable backup creation requires an unlocked Vault and a separate archive password. Recovery needs that archive password and a new Vault passphrase. The retained legacy encrypted-file ZIP is incomplete and still requires matching metadata and keys. |
| Troubleshooting | Describe a problem, choose its computer, review and explicitly run an eligible check, link the report, and record Planned/Tried/Skipped steps and outcomes. | System/network checks run on the TLI host; device reachability is measured from that host. A separately reviewed trusted-peer option obtains that named computer's CPU/RAM/uptime without host fallback. Opening evidence never runs a check or sends chat. Reports and problem links save separately; conflicts retain drafts. Resolved records the user's conclusion, not measured recovery. |

### Notes, history and sharing

**Use saved notes** keeps its existing default. When enabled, ordinary chat may retrieve relevant Notes & fixes. Turning it off prevents new note retrieval and historical note-revision lookups; it does not remove earlier messages from the current conversation. **Use earlier conversation** separately controls ordinary text history for this question and defaults on. Turning it off excludes prior exchanges and their follow-up topic seed. It resets for the next question after completion; it is not a saved browser preference. Hosts or mesh paths that cannot honor this choice refuse the request instead of silently forwarding its history. New Chat starts a separate conversation.

Completed answers can show **Sources & interpretation**: bounded source handles identify the actual supplied note revisions, historical diagnostic reports, selected document ranges or dated backend observations. Report and computer scope must agree. Notes, AI-authored suggestions, user-confirmed outcomes and measured reports retain distinct provenance; a saved date is not a fresh measurement. Where saved-note use is enabled, eligible historical references can be marked changed or unavailable without reconstructing deleted note bodies or rewriting old answers. Current observations retain the 30-second freshness boundary.

Desktop reports and report-based Chat can show **Recorded facts** before the AI's
interpretation: the recorded host/process, time, completion state, sample
coverage and valid measurements. Missing readings are not zero; finishing an
observation does not prove the application finished its task or a repair worked.
Explicit selected-report summary requests use the backend's recorded facts
without inference. Opening saved report history does not attach it to Chat;
the user chooses **Discuss**. Historical changed/unavailable note labels identify
their earlier exchange and revision without creating current source links.
See [evidence-led troubleshooting](TLI_EVIDENCE_LED_TROUBLESHOOTING.md).

Citation checks validate a supplied source identity and, for documents, an included line range. They do not establish that the answer follows from that source. Invented or out-of-range references remain unverified text; streaming citation-shaped links are not treated as verified navigation. Source controls open the current note or saved report for review without attaching it, sending Chat or running another check. Saved receipts contain document identity and ranges, not document bodies; legacy turns are not given invented evidence.

Opening another conversation clears the prior computer/report selection only after the conversation successfully loads. Lock and session expiry clear private context and invalidate pending reads. Text requests reserve answer space against the owned bundled runtime's configured context when known; estimates are not tokenizer guarantees. LM Studio's effective capacity remains unknown. Explicit documents retain a separate file-validation limit and must also fit the final formatted-text budget. See [grounded answers and verification](TLI_ANSWER_QUALITY.md).

A selected-note question uses up to four revision-checked notes and the current question. It excludes earlier conversation and other context. Remove conflicting images, documents, selected-computer/report or Vault-secret context before sending. Supported bundled/LM Studio paths preserve these restrictions; the request does not silently fall back through mesh or run tools. Selecting or opening a note never sends a question.

User-written notes, saved AI replies and historical fixes confirmed through the diagnostic workflow have different source labels. Notes are not evidence of current device health. IDs, revisions, defaults and encrypted formats remain unchanged.

Chat review can deliberately update an existing owned note after a before/after review. The current revision is required; conflicts do not overwrite or retry. Replacing a confirmed fix with a saved AI suggestion removes its diagnostic-confirmation association. Short follow-ups can reuse a recent user topic with current note versions and matching computer scope; this is bounded word matching, not semantic memory.

**Related notes** is an optional, separately reviewed search using an existing
loopback embedding server. The user selects and reviews the whole source notes
before building a temporary index. Explicit searches return at most eight
similarity candidates, not confidence or factual verdicts. It does not silently
change ordinary Chat retrieval. **Linked notes** stores user-entered related,
correction-reference or different-experience pointers to reviewed note revisions;
changed and deleted targets remain visible as such. Links never follow themselves
into Chat. Both workflows keep Vault content separate. See
[reference and relationship scope](TLI_REFERENCE_LINKS.md).

Rich document review accepts bounded PDF and DOCX text extraction alongside the
existing text formats. Choose **Check PDF & Word support** first; the bounded
reader must be available, and the browser must use HTTPS or localhost. Selecting
a PDF or DOCX uploads that binary to the TLI host for extraction before **Send**.
The extracted text and coverage must then be reviewed before Chat submission.
No OCR, document macro execution, protected-file bypass or
automatic attachment occurs. Binary uploads are discarded; existing source and
excerpt retention rules still apply.

The local voice dialog uses explicit push-to-talk, a reviewed editable transcript
and a separate **Add to draft** action. It never sends or executes a recognized
command automatically. Recognition is offered only when the browser supports and
confirms on-device processing; playback lists only voices reported as local.
Unavailable local speech services do not fall back to a cloud voice. Language
pack installation is explicit and may contact the browser vendor. See
[local voice and unperformed physical checks](TLI_LOCAL_VOICE.md).

Longer supported documents use whole numbered excerpts when required by the input budget. Answer details show original ranges and omitted coverage; missing passages can contain important exceptions. Selected originals are never modified. Response timing measures browser-observed delivery, not model reasoning or guaranteed server cancellation. See [useful answers and verification](TLI_USEFUL_ANSWERS.md).

Access follows the authenticated owner. **With PIN protection disabled, local access shares one owner**; account scope does not mean each browser has a private account. Vault adds a separate passphrase. Conversation history is separate from notes. Deleting a note does not erase existing answers that already used it. Notebook, Saved notes and memory remain search aliases.

### Connected troubleshooting

Recorded-outcome questions can receive deterministic answers from the explicitly
supplied report or confirmed historical fix. Completion of a check, a user's
reported improvement and an AI suggestion remain different facts. Case-to-Chat
review selects exact case revisions, steps and evidence pointers before sending;
it never implicitly includes every linked note or the previous conversation.
The user can also explicitly review and supply the recorded-facts projection
of one linked report. Its case/report revisions and target are rechecked before
sending; raw samples, findings and linked bodies are not silently included.
Omitting that selection retains the previous pointer-only behavior. A deleted,
changed or foreign report cannot be substituted. Historical facts never establish
current health. See [dependable computer workflows](TLI_DEPENDABLE_COMPUTERS.md).
See [recorded outcomes](TLI_RECORDED_OUTCOMES.md) and
[reviewed case context](TLI_CASE_CONTEXT.md).

Saved reports offer a review of the same implemented check and its exact host
scope before a deliberate repeat. Comparisons retain timestamps, coverage,
missing values and workload/target caveats. A successful new check does not prove
that a problem is fixed. These controls do not enable automatic rechecks.

Reusable troubleshooting guides contain editable descriptions and planned steps.
Importing a guide prepares an unsaved draft with new step identifiers; it does
not carry a target, historical success, evidence or executable tool definitions.
Export is an explicitly reviewed unencrypted copy of text, separate from backup.
Reviewed case exports can separately include chosen evidence and redactions.
See [reusable guides](TLI_CASE_GUIDES.md).

## Home & network

| Section | Current workflow | Requirements and result |
|---|---|---|
| Computers | Review TLI peers, stable identities and capabilities; exchange and review bilateral public trust cards before authenticated HTTPS coordination or observations. | Trust binds exact stable identity, certificate and private LAN IPv4 origin. Discovery, names and old addresses grant no permission. Old entries remain but require review. Model files do not confirm installation completeness or running inference. |
| Phone Companion | Owner access → Secure connection → Pair your phone → Manage paired phones. | Installed native app, authenticated owner PIN, HTTPS, LAN access and a certificate-valid address are required. Only Create pairing QR issues an invitation. |
| Printers & USB | Read inventory/queues, open OS printer settings or scanner app, explicitly send a test page. | Host drivers/OS and device reporting determine availability. Submission does not confirm physical printing. Unknown supply or queue information stays unknown. |
| Smart devices | Discover supported devices, inspect registered IDs/relays and explicitly control them. | The discovery flow is for Shelly devices; existing other drivers need their supported configuration. No universal home-protocol bridge is implied. Ambiguous names/addresses do not execute. |
| Automations | Prepare a manual routine from a template, preview every target, save it and explicitly run its current reviewed steps. | Existing trigger fields are preserved, but no trigger executor is active. Saving does not run a routine. Calls missing review cannot execute. Session and targets are rechecked between steps; durable receipts prevent replay and preserve partial/uncertain outcomes. |
| LAN Messages | Choose a reviewed peer, exchange text over authenticated host-to-host HTTPS, or offer a browser-selected file for explicit receiver approval. | Both computers need reviewed trust and the messages permission. Each file also requires receiver consent. Files go to the receiving host's encrypted TLI Inbox; download is a separate action after complete hash verification. Delivery is not a read receipt. Failed/uncertain requests do not automatically replay. Existing historical downloads remain accessible. Optional cross-network configuration is separate and does not establish secure native remote access. |

Rooms and device details use shared, user-entered room/importance/relationship
metadata and stable registry IDs. Their account-scoped diagnostic timeline is
historical. Passive Shelly power history captures only meter data returned by
already-requested status reads, with exact relay identity, observation times and
gaps. It does not start polling or estimate energy between missing samples.

Smart devices also offers a separately reviewed, session-only Home Assistant
connection. It projects bounded reported light/switch states and supports one
explicitly reviewed On/Off service request at a time. No scene, automatic rule,
generic registry import or AI tool is created. See
[connection, targeting and verification](TLI_HOME_ASSISTANT_BRIDGE.md).

### Native app and browser satellite

Phone Companion uses `/api/companion/v1` and certificate-bound native transport. Its QR/manual bundle expires after five minutes and is single-use. Hiding the code removes it from view; it does not revoke an unused invitation. Removing phone access denies subsequent requests with its credential; it does not erase that phone's local content. Failed refreshes preserve the previous list with its observation time.

The updated Companion includes shared conversations, Notes & fixes, separate saved-notes and per-question earlier-conversation choices, source/context receipts, reviewed save/update-note actions, Computers, existing diagnostic reports and Troubleshooting cases. Guided Troubleshooting reviews host/target/scope before an explicit check request. Running saves a report; reviewing its link, adding it to a problem draft and saving that problem remain separate operations. A failed problem save preserves the draft and identifies the already-saved report. Conflicts require deliberate review; backgrounding clears private drafts and invalidates late results. Performance & apps sampling starts in the desktop browser; the phone can review saved performance reports.

Companion source now presents Recorded facts, units, process identity, sample
coverage, partial/stopped outcomes and exact changed/unavailable historical note
references. Case review can explicitly include one linked report's facts and
review a trusted peer observation. The installed native version/build and paired
host release identity are visible. The current build record identifies which
signed Beta contains this source. Source and synthetic browser checks do not
validate an actual phone's update, pairing or interrupted connection.

Stopped or interrupted replies remain identified; reconnecting never resends a message or action automatically. The paired address and connection observation are visible. An image discarded under the existing retention rules is not available later on desktop. Destructive file operations, Vault recovery, Builder administration and unrestricted file browsing remain desktop workflows. The optional remote workflow describes an externally managed private route to the existing trusted LAN address. TLI creates no tunnel, public port, new certificate trust or automatic reconnect; a setup check does not prove that a phone can reach the host away from home. The synthetic Expo web preview does not establish physical iPhone/Android acceptance.

Pairing uses the selected, certificate-checked LAN address. When several addresses
exist, the browser requires a choice unless its current origin is an exact match;
it preserves a still-listed choice on refresh. Certificate coverage does not prove
phone reachability. Choose the Ethernet or Wi-Fi address on the phone's network;
virtual or disconnected adapter addresses may be unreachable. Changing the address
hides the old code; create a fresh invitation for the new address.

Computers → Browser connection → **Browser satellite** uses the older `/mesh/satellite` invitation. That code cannot substitute for native pairing. Settings, Computers, onboarding and search link to the same Phone Companion page. Navigation alone creates no invitation.

Connection setup distinguishes **Running now**, **Saved startup**, and **Effective next startup**, including environment overrides. Saving reviewed choices does not restart TLI or change the current connection. A manual restart is required when indicated. Requested HTTPS does not fall back to HTTP if its certificate cannot be used.

## Tools & creation

| Section | Current workflow | Requirements and result |
|---|---|---|
| Utilities | Choose a diagnostic or installed script, inspect parameters, run and review output; optionally ask AI to explain. | Commands run on the host. Public-address connectivity checks contact the internet. LM Studio's model-list utility does not prove generation. Custom scripts are not an OS security sandbox. |
| Print & Scan | Choose an available host printer/scanner, submit a document or retrieve a scan. | Host OS/device support is required. The previous download remains until a replacement scan is successfully retrieved. |
| Performance & apps | Choose a process on the TLI host, explicitly observe up to 30 seconds, review CPU/memory samples and save a performance report. Gaming settings readers remain available for supported games. | PID and creation time identify the process; it may be only part of a multi-process app. Missing measurements remain unknown; interrupted observations are partial. This does not tune settings, measure FPS or prove a bottleneck. AI interpretation uses an explicit report handoff to Chat. |
| Scripts | Describe a task and shell, generate a draft, inspect/copy/download it. | Generation needs an available provider. It does not execute the script. A backup script is not a completed backup. |
| Builder | Open a project, select a task mode, inspect proposed diffs, approve applicable work and review receipts/snapshots. | Host paths and project permissions matter. Proposed, applied and executed work are distinct. Commands use host access; project permissions are not an OS sandbox. |
| TLI Hub | Inspect package source/type and choose its explicit effect. | Installation, session theme application, prompt selection and script execution are different. Listings are not vetting; Share on this host is not public store publication. |

## Troubleshooting and file handoffs

The selected Troubleshooting review can present **Known**, **Missing** and
**Already tried**, then propose one available observation from implemented
checks. This uses the selected case steps and reviewed report facts without a
model request or an automatic diagnostic. **Review suggested check** shows the
target and scope; **Run** remains explicit and revalidates the case/report
revision and target. Missing outcomes and ambiguous symptoms can require more
information instead of proposing a repeat. Companion uses the same contract.
See [next checks and secure file handoffs](TLI_FINISH_THE_FIX.md).

Secure LAN file handoff is a desktop browser workflow. It accepts one regular
file up to 250 MiB, transfers bounded chunks after consent and verifies the
complete SHA-256 before a download is available. The sender cannot choose a
destination path, overwrite a household file, or open/execute the result.
Consent belongs to the account that reviewed that peer. Lock, expiry and trust
changes stop subsequent steps; cancellation cannot recall content already
received. Local discard and historical byte counts remain distinct from peer
delivery. Inbox/staging files are outside existing saved-work backup scopes.
The retained legacy AI-offload service is a separate contract; the reviewed
file/message/observation boundary is not a claim about every LAN interface.

## AI models and connections

The model library separates installed files, selected configuration and confirmed runtime health. It assesses the computer hosting bundled inference, not the phone/browser. Review hardware estimates, required components and compatibility reasons. Unknown probes do not mean compatible. Downloads/imports install files without changing selection.

Bundled inference, configured LM Studio and existing mesh routing remain. Text/image support depends on the actual provider, runtime and model combination. Vision installation includes its required projector. Unsupported combinations remain unavailable. A bounded startup reply does not establish answer quality for every task.

Model Technical details links artifact-specific real-answer evaluations run in
isolated CPU runtimes with synthetic information. The earlier 23-case Standard
report and subsequent six-preset comparison remain separate historical records.
Preparation assertions, independent agent assessment and physical acceptance are
reported separately. Reference hashes identify tested artifacts; they do not
certify the current installed copy, present runtime health or future answers.
See [current evaluation and acceptance work](TLI_ANNIVERSARY_COMPLETION_PROGRAM.md).

Bundled inference can work offline after installation. Downloads, updates, online search, registries, configured providers, cross-network relays and public-address diagnostics can contact outside services. There is no blanket claim that every TLI action stays on the LAN.

### Local extensions

The optional local MCP server grants a local client temporary access to a
user-selected subset of read-only host metadata. It requires authenticated owner
review, a short-lived dedicated credential and an actual loopback connection.
It exposes no Vault, private notes, arbitrary files, Chat execution or device
commands. External client compatibility was checked separately from TLI's own
browser controls; this is not a blanket certification of third-party clients.
See [MCP bridge scope](TLI_MCP_BRIDGE.md).

The separate manual MCP client lives in **Settings → Security & connections →
Local MCP connections**. An unlocked owner-PIN browser session can explicitly
connect to an existing literal-loopback HTTP(S) MCP endpoint on a different
port, request its tool catalogue, review exact arguments and invoke one tool.
The connection is temporary; tool descriptions and results remain untrusted,
and a listed tool's effects are not independently verified. Tools are never
registered with Chat automatically. No subprocess launcher, public endpoint or
unattended execution is included. See [reviewed MCP client](TLI_MCP_CLIENT.md).

The optional browser Room display shows registered room membership and
explicitly requested saved device observations. It has no automatic refresh,
occupancy inference or device controls, and uses the browser's existing session
rather than creating a restricted kiosk account. See
[Room display and physical-device limits](TLI_ROOM_DISPLAY.md).

## Settings, saved data and access

Settings distinguishes browser preferences, account data and shared host choices. PIN protection is configurable; HTTPS is a reviewed startup choice. Neither is assumed active merely because it exists. Phone Companion requires owner authentication and the secure connection.

Running-application details distinguish code loaded at startup from application
files now on disk. Missing identity is unknown. A source mismatch prompts a
normal manual restart and browser refresh; it never restarts TLI or replays work.
Capability information reflects registered routes, not provider or device health.
Application-code IDs exclude models, dependencies and saved data; the full
candidate source/artifact manifest records those separate verification scopes.

- **Check saved data** reads supported notes/conversation/report stores. It does not make or verify a backup.
- **Create backup** makes a password-protected archive within the displayed Notes & fixes, saved-conversation and diagnostic-history scope. Explicit saved-work **v2** also includes Troubleshooting cases; existing v1 requests and archives retain their original three-store scope. Case health is reported separately from the unchanged saved-data health contract.
- **Verify backup** decrypts/checks a temporary copy. It does not restore or merge into live data.
- **Recover into a separate copy** reviews an uploaded archive, explicitly maps its account to the new copy's local owner and creates encrypted stores in a new folder outside the active installation. Current readers check the copy before success; it is not activated. Existing destinations are never replaced. This checkpoint supports Python/ZIP installations; frozen standalone recovery is unavailable. See [recovery scope and verification](TLI_SEPARATE_RECOVERY.md).
- Vault content, models, device credentials and whole-installation recovery are outside this archive's scope. Legacy browser JSON export is separate and is not encrypted by that archive workflow.

The separate **Vault backup** format includes shared Vault files and Vault notes plus the authenticated account's secrets and saved logins. It excludes other accounts, sessions, machine keys, extension credentials, PIN, identity and Companion credentials. Initial content limits are 250 MiB per file, 4 GiB total and 10,000 entries. Recovery publishes a new folder only after authentication and isolated current-application readback, with fresh encryption metadata, a locked Vault and autofill disabled. It never merges into or activates over live data. See [Vault scope and recovery](TLI_VAULT_BACKUPS.md).

**Classic UI / Modern UI** in the header, also available in **Settings → General → Appearance**, changes navigation and workspace composition. Classic uses the retained early interface as its reference: a compact icon rail, raised card workspaces, chat bubbles with a separate starter/history column and long-form Settings. Current features use the same controllers, drafts, permissions and protections in both interfaces. The modern interface remains the default; the choice saves in this browser under a separate layout preference. Existing color-theme identifiers and selections are preserved. **Classic Mint** is the former `classicTli` palette and works with either layout.

**About → TLI through the years** opens local, inert historical and anniversary exhibits with synthetic content. The live Classic interface is an adaptation of retained `v1.3.5-beta` layouts to current capabilities, not an execution of archived scripts or a rollback of the application or its data. See [the interface checkpoint](TLI_CLASSIC_INTERFACE.md) and [the complete anniversary upgrade inventory](TLI_ANNIVERSARY_UPGRADE_SUMMARY.md).

## Platform and acceptance limits

Windows, macOS and Linux launchers and platform adapters remain. Actual printer/scanner/GPU/key-storage support depends on OS facilities, drivers and runtime artifacts. Browser fixture tests do not establish native macOS/Linux installation.

Section-clarity checks use synthetic intercepted browser responses and isolated temporary backend persistence. They do not restart live TLI, query the user's model, operate household devices, pair a real phone or establish physical iPhone/Android acceptance. Existing native builds do not update when browser source changes. See [section coverage and verification](TLI_SECTION_CLARITY.md).
