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

## Contents

1. [Getting Started](#getting-started)
2. [Dashboard](#dashboard)
3. [AI Chat](#ai-chat)
4. [Vault](#vault)
5. [Home Automation](#home-automation)
6. [Automations](#automations)
7. [Performance & apps](#performance--apps)
8. [Free Space](#storage-visualizer)
9. [Files Panel](#files-panel)
10. [Mesh & Multi-Device](#mesh--multi-device)
11. [Satellite Phones](#satellite-phones)
12. [Federated Chat](#federated-chat)
13. [Browser Extension](#browser-extension)
14. [TLI Chat (LAN Messaging)](#tli-chat-lan-messaging)
15. [Hub](#hub)
16. [Print & Scan](#print--scan)
17. [Tools & Scripts](#tools--scripts)
18. [Settings Reference](#settings-reference)
19. [Security Model](#security-model)
20. [Auto-Update](#auto-update)
21. [Keyboard Shortcuts](#keyboard-shortcuts)
22. [Troubleshooting](#troubleshooting)

---

## Getting Started

### First Launch

Run `TLI_Start.bat` (Windows), `TLI_Start.command` (macOS), or `TLI_Start.sh` (Linux).
TLI opens in your browser at `http://localhost:8000`.

On first run, Python installs dependencies — this takes about 30 seconds and only happens once.

**macOS note:** If macOS blocks the file, right-click → Open → Open. Or use the one-line installer:
```
curl -fsSL https://thelanintelligence.com/install_mac.sh | bash
```

**macOS / Linux — AI runtime:** The first time you launch, the script will ask if you want to
download the bundled AI runtime (~50 MB). Say **Y**. This downloads the correct `llama-server`
binary for your platform (arm64 or x86_64) and only happens once.

### Recommended Setup

**1. Set a PIN**
Go to **Settings → PIN Lock**. Once set, TLI requires the PIN before showing anything. The PIN is hashed on-device with PBKDF2-HMAC-SHA256 and never leaves your machine.

**2. Set up an AI model**
Go to **Settings → AI Model**. You can:
- Download a **bundled model** directly in TLI (Lite ~1 GB, Standard ~2 GB, Power ~4.5 GB, Vision ~2.6 GB)
- Point TLI at a running **LM Studio** instance (enter its URL)

Without a model, the AI panels show a "model not loaded" message. Everything else works.

**3. Access from other devices**
Once TLI is running, any device on your home network can reach it at:
```
http://<your-machine-ip>:8000
```
Find your IP in **Settings → Node Identity**.

**4. Install as an app (optional)**
On Android Chrome, a banner prompts you to install TLI as a PWA. On iOS Safari, tap Share → **Add to Home Screen**.

### Navigation

On desktop, use the **sidebar** to switch panels. Press **Ctrl+K** to open the **Command Palette** — search for any panel, action, or mesh node by name.

On mobile, use the **bottom tab bar**. Tap **⋯ More** for the full panel list.

---

## Dashboard

The Dashboard shows a live snapshot of your system the moment TLI opens.

- **Vitals strip** — CPU, RAM, disk, AI status, and mesh node count, updated in real time
- **Quick-read strip** — a plain-language summary of what TLI found ("47 GB free on C:", "2 smart devices online")
- **Suggestions** — context-aware one-tap actions based on current state ("Free up space", "Start AI model")
- **Action chips** — common tasks: ask the AI, check performance, map the network, open storage, open vault
- **Narrator** — rotating AI observations about your system's current state
- **Mesh strip** — shows all online nodes at a glance

Click the **disk usage tile** to prepare that drive in Free Space. Choose **Scan** there to inspect it.

---

## AI Chat

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

Control smart devices from any brand, directly over your LAN. No cloud account required.

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
1. Open **Home Automation → Device Library**
2. Click **Add Device**, choose the vendor, enter the device IP and a friendly name
3. TLI polls the device for capabilities and registers it

### Scenes
A Scene is a saved group of device states you can activate with one tap. Create scenes from the Scenes section — each scene can span multiple devices and vendors.

---

## Automations

The Automations section prepares **manual routines**. Choose a starter or create
up to 20 steps using supported actions, review the exact devices and relays, then
save the routine. Saving changes no device state.

Open a saved routine, review its current targets and acknowledge the complete
plan before **Run reviewed routine**. Every target must resolve before any step
executes. Duplicate requests share the recorded execution; an uncertain response
does not automatically retry. Inspect the per-step result and saved receipt for
successful, failed and partially completed work.

Legacy trigger, enabled and cooldown fields are retained in existing records.
This installation has no active presence, power or scheduled-trigger executor;
those fields do not make a routine run automatically. See
[reviewed routines](docs/TLI_ROUTINE_REVIEW.md).

---

<a id="game-optimizer"></a>
## Performance & apps

The former Game Optimizer is now the host observation tool for Troubleshooting.
It measures CPU and memory; it does not tune settings or prove the cause of a problem.

### How it works

1. Open **Performance & apps** and choose a running process on the TLI host.
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

### Supported config reading

TLI currently reads config files directly for:
- **Cyberpunk 2077** — `UserSettings.json`
- **The Witcher 3** — `user.settings`
- **Red Dead Redemption 2** — `system.xml`

These remain in the secondary gaming controls. Read hardware and the selected
game's settings deliberately, then request advice about a goal. Unsupported or
unreadable settings stay unavailable. AI advice is interpretation; a desired FPS
is a goal, not a benchmark. Stop identifies interrupted output and a failed
replacement retains prior advice. No game settings are written or processes stopped.

### Guided Troubleshooting

Open **Troubleshooting** to describe a problem and explicitly choose its computer.
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

Inspect storage on the computer hosting TLI. Choose a location, understand the
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

- **Scan** a folder to see its contents grouped by file type
- **Bulk rename** — add a prefix and auto-number all files in a folder
- **Organise** — move files into subfolders by type (Images, Documents, Videos, etc.)
- **Undo** — revert the last organise or rename operation

---

## Mesh & Multi-Device

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

Add your smartphone to the mesh without running TLI on it. The phone gets a dedicated companion shell, uses the host's AI, and appears in the Mesh panel with live battery and connection status.

### Adding a phone
1. Go to **Mesh → Add Phone** — a QR code appears (valid for 10 minutes)
2. Scan the QR code or paste the URL into your phone's browser
3. Enter a name and tap **Join Mesh**
4. The phone redirects to the TLI companion shell and registers as a satellite

### Companion shell tabs
- **Chat** — AI chat with quick-prompt chips
- **Devices** — toggle all registered home automation devices
- **Scenes** — 2-column grid of scenes; tap to activate
- **Vault** — unlock, view secrets, copy passwords
- **Status** — battery, connection type, host AI status

### Platform notes
- **Android Chrome** — full feature set, PWA install, battery and connection reporting
- **iOS Safari** — full feature set, tap Share → Add to Home Screen; battery reporting not available (iOS limitation)

---

## Federated Chat

Message TLI nodes on **other home networks** — across the internet — without any cloud account. Uses a lightweight WebSocket relay.

```
Your TLI ──► ws://relay:9000 ◄── Friend's TLI
```

### Quick start

**Enable a relay** (one party needs a publicly reachable machine or VPS):
1. Go to **Mesh → Federated Chat → Built-in Relay** and click **Enable**
2. The relay starts on port 9000 — click **Copy URL** and share it with your contact

**Start a conversation:**
1. Both parties enter the relay URL and save it
2. One person clicks **Generate Code** — a 6-character room code appears
3. Share the code, the other person enters it and clicks **Join**
4. Chat opens

The relay sees room codes and display names only — no message content is stored server-side. History is in-memory and cleared when both parties disconnect.

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

The Hub is TLI's package browser — community-built themes, AI presets, scripts, and automations. Nothing downloads until you ask.

| Type | What it does |
|---|---|
| Theme | Changes TLI's colour scheme, applied live |
| AI Preset | A custom system prompt / AI persona |
| Script | A PowerShell or Bash script, runnable with one click |
| Automation | A trigger + action recipe, installs into Automations |

The **Starter Pack** is always available offline. Enable **Connect to Hub** to pull from the community registry (internet required).

To publish your own packages to your local registry, go to **Hub → Publish**. Mesh peers can subscribe to `http://<your-tli-ip>:8000/hub/local-registry` to browse and install your packages.

---

## Print & Scan

A universal print and scan interface — works on Windows, macOS, and Linux.

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

### Built-in diagnostics

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
Type a task description, choose a language (`.bat`, `.ps1`, `.py`), and TLI asks your local AI to write the script. Saved scripts appear in the **Scripts** panel and can be run directly.

---

## Settings Reference

| Setting | Location | What it does |
|---|---|---|
| Node Name | Node Identity | Display name for this machine in the mesh |
| Node Role | Node Identity | Standalone, Host, or Member |
| Fingerprint | Cryptographic Identity | Ed25519 public key fingerprint — copy or share |
| PIN | PIN Lock | Set, change, or remove access PIN |
| AI Model URL | AI Model | LM Studio chat endpoint URL |
| System Prompt | System Profile | Default context sent to the AI |
| AI Source Policy | AI Source | Auto / Local Only / LAN Only / Prefer LAN / Prefer Local |
| TLS | TLS | Enable HTTPS, download cert for other devices |
| Interface | Appearance or header View | Modern (default) or Classic: changes navigation and workspace layouts using current features |
| Color theme | Appearance | Independent palette choice; existing themes work with either interface |
| Update URL | Updates | URL for checking latest version manifest |

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

TLI is designed for trusted LAN use. The table below shows what each layer protects.

| Layer | What it does |
|---|---|
| PIN lock | Blocks all UI and API access until the correct PIN is entered. PBKDF2-HMAC-SHA256, 260k rounds. |
| Session cookie | Issued on PIN verify. HttpOnly, SameSite=Strict, 24-hour TTL. |
| HTTPS | Optional self-signed TLS (`TLI_ENABLE_TLS=1`). Encrypts all traffic. |
| Vault encryption | AES-256-GCM. Keys derived from vault password via PBKDF2, never written to disk. |
| AI conversation encryption | Chat history encrypted at rest with AES-256-GCM + DPAPI-protected machine key. |
| Node identity | Ed25519 keypair per node. Private key stored DPAPI-protected, never leaves the machine. |
| Extension API key | 40-character hex key scoped to vault login access only. Revocable at any time. |
| Satellite join tokens | One-time-use, expire after 10 minutes. Only the host can generate them. |
| CSP headers | `Content-Security-Policy: script-src 'self'` on every response. |

**TLI is not designed for exposure to the internet.** Keep it on your LAN and behind your router firewall. The built-in relay (port 9000) is the only component intended to be internet-facing, and only when you explicitly enable it.

---

## Auto-Update

TLI checks for updates 5 seconds after startup. When a new version is available, a notification appears in **Settings → Updates**.

- Updates are **never applied automatically** — you always approve first
- Non-frontend updates restart the backend automatically after applying
- The update check only fetches a version number and SHA256 — no usage data is sent
- Configure the update URL or disable auto-check in **Settings → Updates**

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
- Check the URL in **Settings → AI Model** (default: `http://localhost:1234/v1/chat/completions`)
- Use **Tools → Model Health** to test the connection

**Browser says "can't reach this page" after starting**
- Wait a few more seconds — the first run installs dependencies and takes longer
- Make sure Python 3.10+ is installed and added to PATH
- Check that nothing else is running on port 8000

**HTTPS warning on every visit**
- Download the cert from **Settings → TLS** and install it in your browser trust store
- Chrome: Settings → Privacy → Manage Certificates → Trusted Root → Import

**PIN forgotten**
- PINs are one-way hashed and cannot be recovered
- Delete `data/tli_pin.json` from the TLI folder to reset (requires access to the server machine)

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
- Verify the relay URL format is `ws://ip:port`
- Confirm the relay node has the Built-in Relay enabled and port 9000 is reachable
- Both parties must point at the same relay URL

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
