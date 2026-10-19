# TheLANIntelligence — User Manual
*Private home console · Windows, macOS and Linux host adapters*

For the current anniversary interface, use the bundled
[browser manual](frontend/manual.html) and
[capability reference](docs/TLI_CAPABILITIES.md). The detailed implementation and
acceptance status lives in the
[anniversary completion program](docs/TLI_ANNIVERSARY_COMPLETION_PROGRAM.md).
Optional online services and real-device acceptance are described separately;
host support is not a claim that every feature runs on every platform.

---

## Simplification release

The desktop left sidebar directly lists **Home, Ask TLI, Files, Free Space,
Game Optimizer, Vault, Computers, Smart devices, Routines, Phone Companion,
Printers & scanners and USB drives**. Help holds troubleshooting, saved reports
and app performance checks. More holds Installed apps and Advanced tools.
The Devices overview remains reachable through secondary navigation and older
links. Secondary workspaces can be pinned, and search recognizes earlier names.

- **Files and Free Space:** choose a folder, scan, select exact files and review moves.
  Organize accepts up to 500 selected files. Free Space shares folder context,
  with a separate review of up to 100 files for Trash. Organizing files does not
  establish freed space.
- **Game Optimizer:** choose a game and goal, read and correct the host hardware,
  then request advice from the selected Integrated or LM Studio model. Apply
  the suggested settings yourself. Results are advice, not measured FPS.
- **Routines:** use friendly device names, edit or duplicate saved
  routines, archive/restore, and favorite routines on Home. Review current
  targets before every run. Native Companion scenes remain separate.

See the [complete destination map and workflow guide](docs/TLI_SIMPLIFICATION_RELEASE.md)
and the updated [browser manual](frontend/manual.html). Existing notes, projects,
apps, registries, settings and backups retain their owners and storage formats.

## Smart Hub refinement

Home offers task shortcuts you can edit for this browser, plus a **Back to**
row for recently opened workspaces during the current visit. The latter clears
when TLI locks or the page is left. Home's Ask TLI button keeps your current
conversation draft. Related tools can prepare reviewed checklists and unsent
starters while preserving existing drafts.

On Windows, open **TLI.exe** and add its Desktop and Start menu shortcuts for
everyday access. TLI shows startup progress without a command window; closing
the browser does not stop it. Use the **Device menu → Restart TLI… or Quit TLI…**
for everyday control, also available under **Settings → App & troubleshooting**.
Local Setup manages the optional independent phone host-start helper. The helper requires an awake computer and
the same Windows user signed in. A compatible native Companion client must
explicitly save its separate connection while TLI is online.

See [Smart Hub refinement](docs/TLI_SMART_HUB_REFINEMENT.md),
[host setup](docs/HOST_START.md), and [Companion connection](docs/TLI_HOST_START.md).

## Contents

1. [Getting Started](#getting-started)
2. [Home (Dashboard)](#dashboard)
3. [Ask TLI (AI Chat)](#ai-chat)
4. [Vault](#vault)
5. [Smart devices](#home-automation)
6. [Routines](#automations)
7. [Game Optimizer](#game-optimizer) and [Help → App performance check](#performance--apps)
8. [Free Space](#storage-visualizer)
9. [Files → Organize](#files-panel)
10. [Computers (Mesh)](#mesh--multi-device)
11. [Satellite Phones](#satellite-phones)
12. [Federated Chat](#federated-chat)
13. [Browser Extension](#browser-extension)
14. [TLI Chat (LAN Messaging)](#tli-chat-lan-messaging)
15. [More → Advanced tools → Package management (Hub)](#hub)
16. [Printers & scanners](#print--scan)
17. [More → Advanced tools → Utilities & Scripts](#tools--scripts)
18. [Settings Reference](#settings-reference)
19. [Security Model](#security-model)
20. [Auto-Update](#auto-update)
21. [Keyboard Shortcuts](#keyboard-shortcuts)
22. [Troubleshooting](#troubleshooting)

---

## Getting Started

### First Launch

Open **TLI.exe** (Windows), `TLI_Start.command` (macOS), or `TLI_Start.sh` (Linux).
TLI opens at this installation's configured address. The initial default is
`http://localhost:8000`; saved port and HTTPS settings may change it.

First setup prepares the Python environment and dependencies; duration depends
on the computer and downloads. The Windows TLI app guides setup and checks
installed versions locally on later launches. Add its Desktop and Start menu
shortcuts, then open **TLI** from either place. Local Setup also offers
**Desktop & Start menu app** to recreate these shortcuts. `TLI_Start.bat` remains
a command-line fallback; `TLI_Diagnostics.bat` is the visible diagnostic launcher.
Closing the browser leaves TLI running for connected phones and background work.
On the hosting computer, use **Device menu → Restart TLI… or Quit TLI…**, or
**Settings → App & troubleshooting → Restart & quit TLI**. Review the confirmation:
active chats, scans and other work are interrupted, and connected clients disconnect.
Restart uses the saved startup settings and shows the address to reconnect to;
you may need to unlock with your PIN again. Quit stops TLI without shutting down
the computer. Start it again with the TLI launcher. These controls are unavailable
from remote browsers and phones; unsupported or older unmanaged launches explain
how to stop them from their original launcher or terminal. If a command response
is lost, use **Check connection**; TLI never automatically resends the command.

### Removing an installation

Open **Settings → App & troubleshooting → Uninstall TLI** for its exact folder
and removal steps. Current Windows setup adds **TLI** to **Windows Settings →
Apps → Installed apps** and an **Uninstall TLI** Start menu shortcut. You can
also open **Uninstall_TLI.bat** in that installation folder.

Back up saved work and Vault outside that folder, finish active work, quit TLI
and stop its optional helper first. The removal window offers keeping every
file while removing Windows entries, or deleting the whole reviewed folder,
including its data and models. Full deletion requires typing **DELETE**.
Mac/Linux and source checkouts use manual removal. Shared software and files
outside the folder remain. See [Uninstall TLI](docs/TLI_UNINSTALL.md) for the
complete scope, older installations and browser/phone cleanup.

**macOS first launch:** This package uses an unsigned Terminal launcher. If the
official TLI release you trust shows **“TLI_Start.command” Not Opened** and Apple
says it could not verify the file, click **Done**. Open **System Settings → Privacy
& Security**, scroll to **Security**, and click **Open Anyway** for that launcher.
Confirm **Open** and authenticate if asked. Then continue setup in Terminal.
See [Apple's instructions](https://support.apple.com/en-us/102445). A warning that
the file is damaged or will damage the computer needs separate investigation.
The Windows shortcut/helper setup does not install a macOS startup service.

**macOS / Linux — AI runtime:** The first time you launch, the script will ask if you want to
download the bundled AI runtime (~50 MB). Say **Y**. This downloads the correct `llama-server`
binary for your platform (arm64 or x86_64) and only happens once.

### Recommended Setup

**1. Set a PIN**
Go to **Settings → Security & connections** and find the access PIN controls.

**2. Set up an AI model**
Go to **Settings → AI & chat**. You can:
- Download a **bundled model** directly in TLI (Lite ~1 GB, Standard ~2 GB, Power ~4.5 GB, Vision ~2.6 GB)
- Point TLI at a running **LM Studio** instance (enter its URL)

Installing a model, selecting it and starting its runtime are separate actions.
Check the displayed provider readiness before asking a question. AI-dependent
features need an available provider; host tools have their own requirements.

**3. Access from other devices**
The default startup is local access. Set an owner PIN and review Secure LAN
startup under **Settings → Security & connections**. Save the intended address,
port and HTTPS settings, then restart manually when indicated. Use the
certificate-covered HTTPS address shown in Phone Companion. Reachability also
depends on the network and firewall; an address alone does not prove access.

**4. Install as an app (optional)**
Use your browser's shortcut or Add to Home Screen option when available.
A browser shortcut does not install or pair the native Companion app.

### Navigation

On desktop, open **Files** or **Free Space** directly in the left sidebar.
**Computers, Smart devices, Routines, Phone Companion, Printers & scanners and
USB drives** also have their own sidebar entries. Home, Ask TLI, Game Optimizer,
Vault, Help, More and Settings remain directly available. The Devices overview
is a secondary destination, not a bundled sidebar entry. Secondary workspaces
offer **Pin** to add a shortcut. Press **Ctrl+K** (⌘K on Mac) to search; older names
such as Automations, File Organizer and TLI Hub still resolve.

On mobile, use **Home, Ask TLI, Files and More** in the bottom bar.
More keeps the remaining destinations reachable. Help contains Fix a problem,
App performance check and Saved reports. More contains Installed apps and
Advanced tools. Existing stores and specialist workspaces remain available.
Organize/Free Space and other workflow subnavigation remain available inside
their workspaces; opening a navigation entry alone does not scan or run a device.

USB and network observations require verified browser access. Locking TLI clears
their private output. After unlocking, refresh devices explicitly; old results and
storage choices cannot trigger follow-up work. An unavailable inventory is not
confirmation that no drives are connected. Check the current model-storage
destination before retrying an unconfirmed change.

---

## Dashboard

**Home** is the current name for Dashboard. It combines host observations,
AI readiness, saved routine favorites and recorded activity. Read observation
times and unavailable fields; opening Home does not start a file scan.

- **Vitals strip** — CPU, RAM, disk, AI status, and mesh node count, updated in real time
- **Quick-read strip** — a plain-language summary of what TLI found ("47 GB free on C:", "2 smart devices online")
- **Suggestions** — context-aware one-tap actions based on current state ("Free up space", "Start AI model")
- **Action chips** — common tasks: ask the AI, check performance, map the network, open storage, open vault
- **Narrator** — rotating AI observations about your system's current state
- **Mesh strip** — shows all online nodes at a glance

Click the **disk usage tile** to prepare that drive in Free Space. Choose **Scan** there to inspect it.

---

## AI Chat

Open **Ask TLI** for AI Chat; Saved notes is in the same area.

Review the AI source and context summary before sending. General answers require
an available provider; specific host-status questions can use dated observations.
Opening a panel alone does not provide its files or scan results to the model.

- **Use saved notes** allows relevant Notes & fixes to be included. A short
  follow-up such as “What fixed it last time?” can reuse the recent user topic,
  with the current note version and selected-computer restrictions. Disabling
  saved notes skips new retrieval; it does not erase earlier conversation text.
- **Save to Notes & fixes…** offers a new note or a deliberate update to an existing note.
  Review the before/after text. A changed note requires another review, and saved
  AI advice is not a confirmed fix. Notes are setup details, preferences and past
  fixes, separate from conversation history and passphrase-protected Vault notes.
- **Document questions** accept up to four UTF-8 .txt/.md files, together up to
  64 KiB. Whole numbered excerpts are chosen when full text exceeds the input
  budget. Review supplied line ranges and omitted coverage; citations can be
  wrong, and omitted passages may matter. Files are unchanged. This mode excludes
  previous conversation, other notes, images, device/report and Vault context.
- **Response timing** shows browser-observed waiting and elapsed response time.
  Stop ends receipt in this view without guaranteeing server work was cancelled.
  Interrupted text remains incomplete. Review the question and Send explicitly
  to retry; uncertain requests are not automatically replayed.
- **History** resumes saved conversations. New Chat starts a separate one.

Up to four explicitly selected notes can be questioned on their own through
bundled AI or configured LM Studio. Their current versions and the question are
provided without other context or prior history. Review conflicts before Send.
With PIN protection disabled, local access shares one owner. Unlocking Vault does
not automatically share its contents with AI.

---

## Vault

The Vault stores files, secrets, notes, and login credentials — all encrypted with AES-256-GCM on your device. Nothing is sent to a server.

### Setup
1. Open the **Vault** panel
2. Click **Set Up Vault** and choose a master passphrase (minimum 8 characters)
3. The passphrase is hashed on-device. It cannot be recovered if lost — store it somewhere safe.

### Using the Vault

**Unlock** by entering your master passphrase. The vault stays unlocked for 30 minutes of inactivity, then locks automatically. Vault sessions survive backend restarts.

**What you can store:**
- **Files** — uploaded and encrypted before being written to disk
- **Secrets** — key/value pairs (API keys, passwords). Reference in AI chat as `[vault:key_name]` — the value is injected into AI context but never shown in chat history
- **Notes** — encrypted text notes with title and body
- **Logins** — website credentials used by the browser extension for autofill

### Backup & Reset
- **Export Backup** — downloads a `.zip` of all encrypted `.vault` files (useless without your passphrase)
- **Reset Vault** — permanently destroys all vault data. Requires your passphrase AND typing `RESET VAULT` to confirm. Export a backup first.

---

## Home Automation

Open **Smart devices** for registered devices and their supported
actions. Available controls depend on the driver and device configuration.
Use the local TLI browser, or HTTPS with an unlocked PIN for a remote browser.
Lock clears private device views and pauses polling. After TLI verifies access,
the panel reloads current inventory; discovery and device commands are never
repeated automatically. A command already sent may still have taken effect.

If the saved device list cannot be read, TLI shows it as unavailable and pauses
setup edits. It preserves the saved host file and browser import records. An
uncertain save may already have completed: refresh the saved list before trying
another edit. Do not replace a damaged file with an empty list to dismiss the error.

Ask TLI can check or control one named device from the authorized browser or a
paired HTTPS Phone Companion. It distinguishes command acknowledgement from the
fresh reading afterward. If access ends, later steps and private replies stop;
reconnect and check the device before deliberately sending another command.
Nothing is replayed on unlock. A new chat request is a new command; it does not
carry the durable duplicate protection of a reviewed routine.

### Supported vendors

| Vendor | Notes |
|---|---|
| Shelly | Relays, dimmers, power meters |
| Philips Hue | Lights and switches via Bridge |
| Govee | Lights and strips via LAN API |
| TP-Link Kasa | Smart plugs and switches |
| Sonoff | Smart relays |
| Tuya | Wide range of Tuya-compatible devices |
| WLED | LED controllers |
| Yeelight | Xiaomi Yeelight bulbs |
| Generic HTTP | Any device with a simple HTTP API |

### Adding a device
1. Open **Smart devices** and its setup controls
2. Click **Add Device**, choose the vendor, enter the device IP and a friendly name
3. TLI polls the device for capabilities and registers it

### Scenes and routines
Desktop sequences are reviewed manual routines in **Routines**.
Native Phone Companion keeps its existing scenes separately; desktop routines
do not synchronize into Companion in this release.

---

## Automations

**Routines** (formerly Automations) prepares **manual routines**. Choose a starter or create
up to 20 steps using supported actions, review the exact devices and relays, then
save the routine. Saving changes no device state.

Open a saved routine, review its current targets and acknowledge the complete
plan before **Run reviewed routine**. Every target must resolve before any step
executes. Duplicate requests share the recorded execution; an uncertain response
does not automatically retry. Inspect the per-step result and saved receipt for
successful, failed and partially completed work.
If access ends during a run, later steps stop and the locked request cannot show
the private result. Unlock, inspect recorded results and check the devices before
deliberately preparing another run. Returning to an uncertain run never repeats it.

**Edit** updates the saved routine after checking its revision; **Duplicate**
prepares a separate editable draft. **Archive** hides a routine from the active
list and blocks runs; use **Show archived → Restore** to bring it back.
**Favorite** adds a shortcut on Home in this browser. Opening that shortcut
prepares a current-target review, not a run. Resolve conflicting edits and
review changed targets again. A running routine cannot be edited.

Legacy trigger, enabled and cooldown fields are retained in existing records.
This manual-routine engine has no active presence, power or scheduled-trigger executor;
those fields do not make a routine run automatically. See
[reviewed routines](docs/TLI_ROUTINE_REVIEW.md).

---

<a id="game-optimizer"></a>
## Game Optimizer

Choose a game and goal, then **Analyze this PC** to read the TLI host's hardware
and supported game settings. Check the computer name: a browser on your phone
still inspects the host PC. Review and correct CPU, GPU, RAM, playing resolution
and target FPS before requesting a settings plan.

Current config readers cover **Cyberpunk 2077** (`UserSettings.json`),
**The Witcher 3** (`user.settings`) and **Red Dead Redemption 2** (`system.xml`).
Review the current quality values, correct known values, and leave unavailable
ones **Unknown**. For another game, enter named quality settings from its menu
and the values you know. Those user-named controls and their options are unverified.

**Get settings plan** uses the selected available Integrated or LM Studio model
to choose up to three bounded setting trials. Each shows its current value and
source, proposed value, scope, reason and tradeoff. Unknown values stay unknown;
the plan can ask for more context when there is no useful supported trial.
General guidance shown without AI is labeled separately.

Ask a follow-up about the same game and explain what you tried or measured.
Choose whether to include its previous completed advice and whether to try other
settings. Changing games does not reuse the earlier game's settings. Failed or
interrupted requests retain prior completed advice; retry deliberately after
reviewing the selected provider and current inputs.

Apply one suggestion yourself in the game, compare the same scene, and restore
the previous value if it is worse. TLI does not write game settings or stop
processes. Target FPS is a goal; achievable FPS, a performance improvement and
the cause of a problem remain unmeasured by this advice workflow.

<a id="performance--apps"></a>
## Help → App performance check

This separate host observation tool measures CPU and memory for Troubleshooting.
It does not tune settings or prove the cause of a problem.

### How it works

1. Open **Help → App performance check** and choose a running process on the TLI host.
2. Describe the symptom and explicitly start a **30-second observation**.
3. Review its duration, sample coverage and missing readings. Stop leaves a partial result.
4. Save a useful result explicitly into diagnostic history.
5. Review a Chat handoff or add the saved report's link to a Troubleshooting draft.

PID and creation time identify one process launch. It may be only part of an app;
process exit or PID reuse never silently retargets the observation. Earlier results
remain when replacement work fails. Comparisons identify host/workload caveats;
application differences require matching host and a known executable identity.
GPU metadata is separate from these measurements. FPS, dropped frames, thermal
throttling and causal bottlenecks are not measured by this tool.

<a id="supported-config-reading"></a>
Supported game config reading now belongs to **Game Optimizer**, described above.

### Guided Troubleshooting

Open **Help → Fix a problem** to describe a problem and explicitly choose its computer.
Review an available check's executing host, target, scope and internet contact
before Run. System/network checks measure the TLI host; device checks measure
reachability from that host and are not remote application tests.

A completed check saves a report. Review its link, add it to the problem draft,
then save the problem separately. If that save fails, the report and draft remain;
the check is not rerun. Marking Resolved records your conclusion, not measured
recovery. Confirming a historical fix remains a separate reviewed action.

---

<a id="storage-visualizer"></a>
## Free Space

Open **Free Space** to inspect the computer hosting TLI.
Choose a location, understand the
recorded results, review selected files and check the outcome.

- Choose a drive or quick folder, or enter an exact path. Navigation prepares
  the location; **Scan** starts work.
- Start with **Quick overview** (up to 15 seconds), then explicitly request a
  **Deeper scan** (up to five minutes) if needed. Entry/depth limits, exclusions
  and permission failures remain visible; neither mode guarantees full coverage.
- Inspect largest files, folder totals, File types or Map. Use breadcrumbs and
  keyboard-accessible lists to explore the recorded observation.
- **Stop scan** requests cancellation. Leaving the page does not cancel work.
  A failed replacement preserves previous results and their observation time.
- Run Large-file search, Duplicate search or Common folders explicitly. Save
  comparable scan summaries only when wanted; a saved comparison is historical.
- Select up to 100 individual files for a host-side exact-path review. Choose a
  duplicate copy to keep before selecting others. Protected paths remain blocked.
- **Move reviewed files to Trash** is separate from scanning and review. There is
  no permanent-delete control. Trash may still use storage, so moved bytes do not
  prove freed space. Check an uncertain receipt instead of repeating the move.
- **Prepare a question about this scan** reviews the information to share without
  sending Chat automatically or replacing an existing draft.

See [the complete Free Space workflow](docs/TLI_FREE_SPACE_REBUILD.md) for scope,
limits, preservation and verification.

---

## Files Panel

Open **Files → Organize**. Choose an accessible folder on the TLI host,
then **Scan folder**. A new folder listing starts with nothing selected. A
successful rescan of the same folder retains surviving selections. Search or
filter by file type, select exact files, and edit their destination subfolders.
Recipes add only the types they name. **Leave here** removes files from the plan.

Organize accepts at most **500 selected files**. Narrow larger selections;
there are no automatic batches or silently omitted files. **Review moves** shows
exact source and destination paths and blockers before confirmation. **Leave
blocked files here** removes blocked items and requires a fresh review. Changing
selection or destinations also requires another review.

Saved places and Free Space can prepare a folder and suggested files without
scanning. A different incoming folder offers **Keep current draft** or **Use
this folder**. Failed replacement scans retain the previous listing and draft.
Suggested files must match the successfully listed immediate folder contents;
review missing candidates and explicitly add matches to the plan.

**Rename** remains a separate reviewed operation. Inspect partial or uncertain
results before retrying. **Undo** covers only its recorded operation and checks
for later changes; it is not a general folder restore. Free Space's Trash review
is separate, with a 100-file cap and operating-system Trash recovery.

File controls require the TLI browser: with the PIN off, use localhost directly
on the host; remote access requires HTTPS and an unlocked PIN session. **Open**
uses the host's application association and can launch a program. **Show in
folder** opens the file manager to the selected item. Trash protects TLI's
installation, saved data and Vault even when relocated, along with folders
containing them; linked paths require inspection in your file manager.

If access ends or security settings become unreadable during a move or undo,
TLI stops subsequent files and records known results using its existing recovery
record. If that record cannot be saved, recovery remains uncertain and requires
manual inspection; the temporary preview cache is not a backup across restart.
Completed changes remain in place. The private review disappears from the locked
page, and unlocking does not repeat the action. Inspect the actual paths before
requesting a new review or Undo; an interrupted confirmation cannot resume its
remaining files. A host app or Trash operation already dispatched may complete
even when its response is withheld. Do not resubmit an uncertain action blindly.

AI suggestions remain written advice and do not create or approve moves.
Opening Free Space prepares the folder; choose **Scan** there to inspect it.
Moving files between subfolders does not establish freed disk space.
The deeper Free Space scan projections and cleanup workflow have separate access
contracts and remain under review. This file-control change was checked with
temporary files and mocked host adapters; real OS launch/Trash, installed restart,
interrupted recovery and extracted-package acceptance remain outstanding gates.

---

## Mesh & Multi-Device

Open **Computers** for the existing mesh workspace and connection controls.

TLI can run on multiple machines and form a LAN mesh. Each device is a full peer.

### Setting up a mesh

**Become Host:**
1. Go to **Mesh** on the machine that will coordinate the mesh
2. Click **Become Host**

**Join the mesh:**
1. Install and run TLI on a second machine
2. Go to **Mesh → Join**
3. Enter the host's IP and port (e.g. `192.168.1.100:8000`)

### What you can do across nodes
- View live CPU, RAM, disk, and uptime for every node from the Mesh panel
- Clean temp files on remote nodes
- Run maintenance tasks remotely
- Chat via TLI Chat
- Share files between nodes
- Jump to any peer's TLI via the Node Switcher in the header

---

## Satellite Phones

The legacy browser phone flow opens a companion shell and reports battery and
connection status in Mesh. Its satellite credential authorizes presence updates
and removal of that same phone only. Private chat, devices and Vault have their
own access requirements; satellite registration does not unlock them or create
a reviewed native Companion or inference Node identity.

### Adding a phone
1. Open TLI in an authorized browser, then **Mesh → Add Phone** — a QR code appears (valid for 10 minutes while the issuing session remains valid)
2. Scan the QR code or paste the URL into your phone's browser
3. Enter a name and tap **Join Mesh**
4. The phone redirects to the TLI companion shell and registers as a satellite

Use a direct HTTPS host address reachable from the phone. Plain HTTP is accepted
only on direct localhost, which does not provide a phone-to-computer connection.
New join links keep the token in a URL fragment. Keep the issuing browser unlocked
until enrollment completes; a PIN change or revoked issuing session invalidates
the invitation. A failed or unconfirmed enrollment never retries automatically.
Inspect the desktop phone list before generating a replacement invitation.

Locking clears desktop phone cards and invitation details. Verified access can
resume reads, but never generates a new invitation or repeats removal. Leaving
from the phone authenticates with that phone's secret. Transport or storage
failures preserve its saved credentials; only confirmed removal or an explicit
invalid-credential response clears them. Damaged host registry data blocks changes
and is preserved for recovery. Real phone, restart and recovery trials remain open.

### Companion shell tabs
- **Chat** — AI chat with quick-prompt chips
- **Devices** — toggle all registered home automation devices
- **Scenes** — 2-column grid of scenes; tap to activate
- **Vault** — unlock, view secrets, copy passwords
- **Status** — battery, connection type, host AI status

### Platform notes
- **Android Chrome** — browser capabilities determine PWA installation, battery and connection reporting; verify the intended device during acceptance.
- **iOS Safari** — the browser shell can be added to the Home Screen; battery reporting is not provided by this flow. End-to-end private feature access requires separate acceptance.

---

## Federated Chat

The old room-code relay is retired. Starting, pairing, sending and automatic
reconnection are unavailable. Its name-only room protocol did not provide the
identity and encrypted-transport protections required for private communication.

After unlocking, the legacy panel can show retained process-memory history and
status. Explicit disconnect/stop is available for cleanup; an unconfirmed stop
remains visible for review. Saved settings are preserved. This history is not a
durable archive. Reviewed LAN messaging and inference use separate connections.
See the [audit](docs/TLI_AUDIT.md) for the retirement evidence and remaining work.

---

## Browser Extension

The TLI Vault extension fills saved logins on any website — no cloud sync, no third-party servers.

### Install
1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select the `tli-vault-extension` folder

### Connect to your vault
1. Unlock the Vault in TLI
2. Go to **Vault → Extension Settings → Generate API Key**
3. Copy the key
4. Click the TLI toolbar icon → Settings, paste your TLI URL and API key
5. Click **Test Connection**

### Autofilling
When you visit a login form, a small key icon appears in the password field. Click it to see matching logins and fill instantly. Or press **Ctrl+Shift+L** from anywhere on the page.

### Save prompt
After submitting a login form with new credentials, a **Save this login?** banner slides up. Click **Save to Vault** to store it.

---

## TLI Chat (LAN Messaging)

Open **Computers**, then the relevant computer's messages and files.

Send messages and files between TLI nodes on your LAN. No internet, no account.

- **Buddy list** — all discovered TLI nodes with online/offline state
- **Thread messaging** — persistent threads, survive page refreshes and backend restarts
- **Read receipts** — single tick = delivered, double tick (green) = read
- **Typing indicator** — three-dot animation when the other node is composing
- **File sharing** — share files directly; recipient gets Accept/Decline
- **Ask AI in chat** — type `@ai <question>` in any thread to get an AI response inline

TLI Chat is pull-based — each node polls the other directly. No central relay, no port forwarding needed for same-LAN use. Messages appear within 2–3 seconds.

---

## Hub

Open **More → Advanced tools → Package management** for the existing Hub.
Browse its bundled sample catalogue or configured host registry. Read the source
and effect before installing; a listing does not mean a package is reviewed or verified.

| Type | What it does |
|---|---|
| Theme | Install stores the package; Apply for this session changes appearance |
| AI Preset | Install stores the preset; Use prompt preset changes the configured prompt |
| Script | Install stores code; view/copy saved source after unlocking. Host execution is unavailable |
| App | Install stores a single-file app; Open runs its local HTML/JavaScript in an isolated view |

**Share on this host** adds a package to this host's registry; it does not
publish to a public store. Registry connections use their configured addresses.
This release adds no public marketplace or automatic routine scheduling.

**More → Installed apps** opens already installed single-file packages. App code
cannot access the TLI page, its cookies or its browser storage. Host-connected
features and external assets are unavailable; package permissions are declarations,
not grants. The old bridge storage API is unavailable, while its saved browser
data and original package files remain preserved. Apps needing that bridge may
not function until a separately reviewed capability service exists. Pin a
secondary workspace if used often.

Hub validates exact package paths and refuses damaged metadata. Install/update
and uninstall retain recovery copies under `data/hub_backups/`, with a
`recovery.json` mapping of original paths, copy names and hashes. Uninstall removes
the registration and moves known artifacts there, preserving extra app files.
An interrupted or uncertain change leaves `data/hub_pending.json` and pauses Hub
access. Do not delete this marker or retry blindly: it does not prove the change
failed. The retained mapping describes the planned change, not its completion.
Review the journal, current files and before/after copies with the host
stopped before an explicit repair. Automatic reconciliation and a recovery UI
are not implemented; physical interruption/restore acceptance remains open.

---

## Print & Scan

Open **Printers & scanners**. Supported operations depend on the
TLI host's operating-system facilities, installed drivers and device.

**Printer list:** TLI reads all printers registered with your operating system.
- Windows: via WMI/PowerShell (includes WSD/network printers)
- macOS / Linux: via CUPS (`lpstat`) — includes Bonjour/Avahi auto-discovered network printers

**Test print:** sends a TLI test page to the default printer using `Out-Printer` (Windows) or `lp` (Mac/Linux).

**Open scanner app:**
- Windows: opens Windows Scan
- macOS: opens Image Capture (falls back to Preview)
- Linux: opens simple-scan, xsane, or gscan2pdf (whichever is installed)

**Add printer:**
- Windows: opens Windows Settings → Printers & Scanners
- macOS: opens System Preferences → Printers & Scanners
- Linux: opens system-config-printer or GNOME Control Center

**Ink / toner levels:** available for network printers that expose the Printer-MIB via SNMP.
Works on all platforms — pure network query, no platform-specific API required.

---

## Tools & Scripts

Open **More → Advanced tools** for Utilities, Scripts and Builder. Saved
diagnostic reports are under **Help → Saved reports**.

### Built-in diagnostics

These fixed diagnostics require an authorized browser session, including when
requested in chat. Inputs are checked, and loss of access stops further results.

| Tool | What it does |
|---|---|
| System Snapshot | CPU, RAM, disk, Python version, hostname |
| Top Processes | Top 10 processes by memory |
| Disk Overview | All mounted drives with usage |
| Network Snapshot | All network interfaces and addresses |
| Connectivity Check | Ping local and DNS servers |
| Model Health | Check LM Studio reachability and loaded models |
| TLI Environment Check | Verify all TLI paths exist |

### AI-generated scripts
Type a task description and choose a target shell to prepare a script draft.
Review and copy it. TLI does not execute these scripts on the host. Previously
saved source remains available for private plaintext review/copy. The old script
file-generation and deletion endpoints are also retired, preserving saved files.
Draft warnings are advisory and do not establish that code is safe to run elsewhere.

---

## Settings Reference

Settings uses **General**, **AI & chat**, **Security & connections**,
**Saved data & backups**, and **App & troubleshooting**. Search for the setting
name when using an older guide. Review its displayed scope and save action;
browser appearance, account data and shared host settings have different owners.

| Setting | Location | What it does |
|---|---|---|
| Node Name and Role | Security & connections | Host identity and mesh role; connection controls also live under Computers |
| Fingerprint | Security & connections | Host cryptographic identity |
| PIN | Security & connections | Set, change, or remove access PIN |
| LM Studio and selected model | AI & chat | Configure the provider and review actual readiness |
| System Prompt | AI & chat | Configured AI instructions |
| AI Source Policy | AI & chat | Existing local and connected-computer routing choices |
| TLS | Security & connections | Host HTTPS configuration and certificate controls |
| Interface | General → Appearance or header View | Modern (default) or Classic, using current features |
| Color theme | General → Appearance | Browser palette, independent of interface choice |
| Updates | App & troubleshooting | Review update configuration and available actions |

License controls in Settings require verified browser access. Locking TLI clears
private license details; unlocking refreshes them without repeating activation or
removal. If a change is not confirmed, refresh the details before deciding what to
do next. An unavailable saved license is not treated as an empty license or silently
replaced. Existing BETA access remains separate from a saved license key.

Online search uses the SearXNG endpoint selected in Settings. Use its final
HTTP(S) address, including any base path; redirects, credentials embedded in URLs
and implicit host proxy credentials are unsupported. Search requires verified
browser access. If retrieval fails, explicitly choose **Answer Offline** or retry
the search; TLI does not automatically submit the question after that failure.
Locking clears visible search receipts without deleting their saved browser data.

### Classic or Modern interface

To return to the early TLI layout, choose **View → Classic UI** in the header or
**Settings → General → Appearance → Classic TLI**. Switch back to Modern at any
time. Classic uses compact navigation, raised cards, chat bubbles and long-form
Settings, with current functionality and data protections. The choice saves in
this browser separately from its color theme. **Classic Mint** is the retained
mint-and-teal palette; choosing it alone does not change the interface layout.
Neither interface rolls back TLI or its data.

### Saved data & backups

**Check saved data**, **Create backup** and **Verify backup** have separate effects:
checking current readability, downloading a password-protected notes/chats/reports
archive, and validating an uploaded archive in a temporary copy.

**Recover into a separate copy** reviews an archive and writes it to a new folder
on the TLI host. The review shows source ownership, counts and exact destination;
creation maps records to the copy's local owner and verifies them with current
readers. The folder must not already exist. The current installation stays in use,
and its data is never merged or replaced. The copy contains data and a receipt,
not the application, PIN, identity, Vault, Companion credentials, models or
attachments. This checkpoint supports Python/ZIP installations; frozen standalone
recovery is unavailable. See [scope and verification](docs/TLI_SEPARATE_RECOVERY.md).

---

## Security Model

TLI is designed for trusted LAN use. The table below describes individual
mechanisms; API coverage remains under review in the
[route-authority inventory](docs/TLI_ROUTE_AUTHORITY_INVENTORY.md).

| Layer | What it does |
|---|---|
| PIN lock | Locks the UI and participates in protected API admission; route coverage is not yet complete. PBKDF2-HMAC-SHA256, 260k rounds. |
| Session cookie | Issued on PIN verify. HttpOnly, SameSite=Strict, 24-hour TTL. |
| HTTPS | Optional self-signed TLS (`TLI_ENABLE_TLS=1`). Encrypts all traffic. |
| Vault encryption | AES-256-GCM. Keys derived from vault password via PBKDF2, never written to disk. |
| AI conversation encryption | Chat history encrypted at rest with AES-256-GCM + DPAPI-protected machine key. |
| Node identity | Ed25519 keypair per node. Private key stored DPAPI-protected, never leaves the machine. |
| Extension API key | 40-character hex key scoped to vault login access only. Revocable at any time. |
| Satellite join tokens | One-time-use, expire after 10 minutes. Only the host can generate them. |
| CSP headers | `Content-Security-Policy: script-src 'self'` on every response. |

**TLI is not designed for exposure to the internet.** Keep it on your LAN and
behind your router firewall. The legacy relay is retired; this release provides
no replacement public relay service.

---

## Auto-Update

Update controls are in **Settings → App & troubleshooting**. Review the
configured update source and available version there.

- Updates are **never applied automatically** — you always approve first
- Non-frontend updates restart the backend automatically after applying
- The update check only fetches a version number and SHA256 — no usage data is sent
- Configure the update URL or auto-check in **Settings → App & troubleshooting**

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+K / Cmd+K | Open / close command palette |
| ↑ / ↓ | Navigate command palette results |
| Enter | Select command palette item |
| Esc | Close command palette or dismiss dialogs |
| Enter (chat) | Send message |
| Ctrl+Shift+L / Cmd+Shift+L | Browser extension: autofill current page |

---

## Troubleshooting

**AI is not responding**
- Make sure LM Studio is running with a model loaded, or a bundled model is installed
- Check the provider and URL in **Settings → AI & chat**
- Use **More → Advanced tools → Utilities** for the LM Studio model-list check;
  a returned model list alone does not prove generation is ready

**Browser says "can't reach this page" after starting**
- Wait a few more seconds — the first run installs dependencies and takes longer
- Make sure Python 3.10+ is installed and added to PATH
- Review the saved startup address, port and HTTPS settings; use
  `TLI_Diagnostics.bat` for a visible Windows diagnostic launch. A conflicting
  listener is left alone. Stop an older TLI instance through its original launch
  method before opening the updated source.

**HTTPS warning on every visit**
- Find HTTPS and certificate controls in **Settings → Security & connections**
- Chrome: Settings → Privacy → Manage Certificates → Trusted Root → Import

**PIN forgotten**
- PINs are one-way hashed and cannot be recovered
- Preserve the existing security files. Deleting them is not a supported PIN
  reset and can prevent recovery. Stop TLI and use a matching verified backup
  with the original operating-system account when recovery is required.

**Vault data inaccessible after restart**
- Vault sessions survive restarts automatically. If it still shows locked, the session expired — enter your passphrase again.

**Mesh node shows offline**
- Confirm TLI is running on that machine
- Check the IP hasn't changed (DHCP reassignment) — update it in the Mesh directory if needed

**Satellite phone not appearing in Mesh**
- Phone and desktop must be on the same WiFi
- Wait up to 30 seconds after joining (heartbeat interval)
- Open TLI on the phone to trigger an immediate heartbeat
- If the QR code expired, generate a new one

**Federated Chat — relay errors**
- The legacy relay is unavailable by design; changing its URL will not re-enable it.
- Unlock to review retained history/status or explicitly stop an older connection.
- An uncertain cleanup result is not confirmation that an older listener closed.

**Browser extension shows "Vault is locked"**
- Unlock the vault in TLI first — the extension cannot read credentials without an active vault session

**Browser extension shows "Invalid API key"**
- The key may have been regenerated. Go to extension Options, regenerate in **Vault → Extension Settings**, paste the new key.

**Home Automation device shows "unavailable"**
- Verify the device IP hasn't changed
- Confirm the device is powered and on your LAN
- Use the device's own app to verify it's online, then refresh TLI

**Routine did not run**
- Saving does not run a routine, and automatic triggers are inactive.
- Open its current target review, check every step and explicitly choose Run.
- If a request was submitted, inspect its existing receipt before deciding on a
  new action. Do not assume a timeout means that nothing happened.

**Hub package won't install**
- Starter Pack installs from built-in data — no internet needed
- For remote registries, verify the Hub URL is reachable and the Hub toggle is on

---

## Data Locations

All TLI data lives in the `data/` subfolder of your TLI installation. Nothing is written outside this folder.

| Path | Contents |
|---|---|
| `data/tli_pin.json` | PIN hash and salt |
| `data/vault/` | Encrypted vault files |
| `data/vault_meta.json` | Vault password hash and salts |
| `data/node_identity.json` | Ed25519 keypair (private key is DPAPI-protected) |
| `data/mesh/` | Node config and mesh directory |
| `data/hub_packages/` | Installed Hub package files |
| `data/scripts/` | AI-generated scripts |
| `data/debug_log.jsonl` | Backend event log |
| `data/homepower_devices.json` | Registered smart home devices |
| `data/homepower_scenes.json` | Saved scenes |
| `data/actions.json` | Automation definitions |
| `data/relay_settings.json` | Built-in relay config |
| `data/tls/` | Self-signed TLS certificate and key |

To move TLI to another machine, copy the entire folder including `data/`. Your vault, mesh config, and settings move with it.

---

*Bug reports: thelanintelligence@gmail.com*
