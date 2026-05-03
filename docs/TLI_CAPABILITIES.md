# TheLegatoIntelligence — What It Can Do
*v1.1.1-beta · Windows · macOS · Linux*

---

## The Short Version

TLI is a self-hosted home OS console. You run it on your own hardware, access it from any browser on your LAN, and it gives you:

- A private AI assistant powered by your local LLM (no API key, no internet)
- Encrypted vault for sensitive files, credentials, and notes
- Smart home control for Shelly devices
- A live dashboard of every machine on your network
- File management, disk visualization, and cleanup tools
- A mesh network connecting all your TLI machines together
- Automation sequences for smart devices and tasks
- Game optimization
- All behind a PIN lock with HTTPS encryption — no cloud, no accounts

---

## AI Assistant

**What it does:**
- Streams chat responses from a local LLM — no API key, no internet
- Two providers: **Bundled AI** (managed by TLI) or **LM Studio** (user-run)
- Bundled AI: TLI downloads and manages the llama.cpp runtime automatically
- Supports multi-turn conversation with persistent history
- Configurable system prompt (set your AI's persona and focus area)
- Multiple model tiers: Lite (~1 GB), Standard (~2 GB), Power (~4.5 GB), Vision (~2.6 GB)
- Generates scripts (batch, PowerShell, Python, bash) from a plain-language description

**What it needs:**
- First run: download a bundled model from Settings → AI Model, or point at a running LM Studio instance
- Mac/Linux: the launcher auto-downloads the llama.cpp runtime binary on first run (~50 MB, one-time)

**What it does not do:**
- No cloud API calls — responses never leave your network

---

## Vault — Encrypted Storage

**What it does:**
- Stores files encrypted with AES-256-GCM — readable only with your vault password
- Key-value secrets store — safe place for API keys, passwords, tokens
- Encrypted notes — private text you can read from any device on your LAN
- Export all encrypted files as a zip backup
- 30-minute unlock sessions — auto-locks on inactivity

**What makes it secure:**
- Vault master password is hashed with PBKDF2-HMAC-SHA256 (200,000 rounds), never stored in plaintext
- AES encryption keys are derived from your password at unlock time and kept only in memory
- Keys are wiped when the session expires or you lock manually
- Vault reset requires both the master password AND a confirmation phrase

**What it does not do:**
- Not a password manager with browser auto-fill
- Vault data is stored on the TLI server machine — physical access to that machine with a compromised OS could expose the encrypted files (though not decrypt them without the password)

---

## Home Automation

**What it does:**
- Discovers Shelly devices on your LAN automatically
- Controls switches, relays, dimmers, and plug sockets
- Shows real-time device state (on/off, power consumption where supported)
- Devices can be named and grouped
- Device actions can be triggered from the Automations panel

**What it needs:**
- Shelly devices on the same LAN segment

**What it does not do:**
- Currently Shelly only (no Zigbee, Z-Wave, or Hue bridge integration yet)
- No remote access outside the LAN

---

## Automations

**What it does:**
- Build named sequences of actions (turn on a device, send a chat, run a tool, call a URL)
- Trigger manually or on a time schedule
- Automations run in the backend — no browser session required
- Chain multiple actions in sequence

**What it does not do:**
- No if/else logic or conditions yet (actions run unconditionally)
- No event-based triggers beyond time and manual

---

## Home Mesh — Multi-Machine Network

**What it does:**
- Connects multiple TLI machines into a named peer network
- One machine is the **Host**; others are **Members**
- From the host, view live stats for every member: CPU, RAM, disk, uptime
- Run maintenance tasks on remote machines (clean temp, rotate logs)
- View recent logs from any node
- Chat between nodes with TLI Chat
- Approve or deny join requests from new machines

**What it needs:**
- TLI running on each machine
- All machines on the same LAN (or reachable LAN segment)

**What it does not do:**
- No WAN/internet mesh — LAN only by design
- No end-to-end encryption between nodes yet (relies on LAN trust + HTTPS)

---

## Files & Disk Management

**What it does:**
- Scan any folder and see files grouped by type (Images, Videos, Documents, etc.)
- Bulk rename all files in a folder with a prefix + sequential numbering
- Organize files into subfolders by type automatically
- Undo the last organize or rename operation
- Disk usage treemap: visual breakdown of what is using space, folder by folder
- Delete items to trash or permanently from the treemap

**What it does not do:**
- Not a full file explorer (no drag-and-drop, no cut/copy/paste)
- Bulk operations are scoped to single folders (not recursive)
- Protected system paths are blocked from deletion

---

## Devices — Printers

**What it does:**
- Discovers printers on the local network — Windows via WMI/WSD, macOS/Linux via CUPS
- Shows printer name, status, IP, and connection type on all platforms
- Test print to the default printer
- Open scan application (Windows Scan, macOS Image Capture, Linux simple-scan)
- Open the system's add-printer UI on any platform
- Ink/toner level queries via SNMP (network printers, all platforms)

**What it needs:**
- macOS / Linux: CUPS installed (standard on both platforms by default)
- SNMP ink levels require the printer to expose the Printer-MIB and `pysnmp` installed

**What it does not do:**
- No full print queue management (job ordering, cancellation)

---

## Tools & Diagnostics

**Built-in diagnostics you can run in one click:**
- Full system snapshot (CPU, RAM, disk, Python, hostname)
- Top 10 memory-consuming processes
- Disk usage across all mounted drives
- Network interface listing with IP addresses
- Connectivity check (pings localhost, 8.8.8.8, 1.1.1.1)
- LM Studio model health check
- TLI path and environment verification

**AI-generated scripts:**
- Describe a task in plain English, choose a language (.bat / .ps1 / .py)
- Your local LLM writes the script
- TLI saves it and lets you run it with one click
- Script registry persists across restarts
- Scripts run in a sandboxed subprocess (no shell injection — arguments are sanitized)

---

## Game Optimizer

**What it does:**
- Detects running games on Windows, macOS, and Linux via process scanning (psutil)
- Recognises games from Steam, GOG Galaxy, Epic Games, Battle.net, and Xbox Game Pass
- Windows: uses foreground window detection for highest confidence
- macOS: uses `osascript` to identify the frontmost application
- AI-generated performance recommendations based on your hardware profile
- Home Power integration — trigger lighting scenes or device actions when a game starts

**Supported store paths per platform:**

| Store | Windows | macOS | Linux |
|---|---|---|---|
| Steam | Registry + default paths | `~/Library/Application Support/Steam` | `~/.local/share/Steam` |
| GOG | Program Files | `~/Library/Application Support/GOG.com` | `~/GOG Games` |
| Epic | Program Files | `~/Library/Application Support/Epic` | — |
| Battle.net | Program Files | `/Applications/Battle.net.app` | — |
| Xbox | XboxGames\ drives | — | — |

**What it does not do:**
- No overclocking or GPU tuning
- Recommendations are advisory — TLI does not bypass system policies
- Linux foreground window detection not available (process scan still works)

---

## Visualizer

**What it does:**
- Renders a **squarified treemap** of any folder's disk usage
- Click to zoom into subdirectories
- Each rectangle is sized proportionally to its disk footprint
- Hover to see size and path
- Right-click (or button) to send to trash or permanently delete
- Blocked from deleting protected system paths (Windows, Program Files, etc.)

---

## Security Summary

| Capability | Mechanism |
|---|---|
| Access control | PIN lock · PBKDF2-HMAC-SHA256 · 260k rounds |
| Session management | HttpOnly cookie · SameSite=Strict · 24h TTL · server-side token store |
| Transport encryption | Self-signed TLS cert generated on first run · served via HTTPS |
| Vault encryption | AES-256-GCM · keys derived from password at unlock · never written to disk |
| API protection | Every destructive endpoint requires a valid session cookie |
| Mesh proxy | Hard-coded allowlist of 9 permitted proxy paths · no arbitrary forwarding |
| File path protection | System directories blocked from deletion at the API level |
| Script safety | File names sanitized · subprocess with `shell=False` · no user-controlled arguments passed to shell |

---

## What TLI Is Not (Honest Limits)

- **Not an internet service.** It is designed for your LAN. Do not expose port 8000 to the internet without a reverse proxy, firewall rules, and a real certificate.
- **Not a multi-user system.** One PIN, one vault password, one session at a time per node.
- **Not a backup solution.** The vault stores encrypted files but TLI itself has no backup scheduler — back up your `data/` folder separately.
- **Not a media server.** No video streaming, music library, or photo gallery.
- **Not plug-and-play for all smart home protocols.** Currently Shelly devices only.

---

## Platform Support Summary

TLI detects your OS at runtime via `platform.system()` and adjusts every subsystem automatically.
You do not need to configure anything — just run the launcher for your platform.

| Capability | Windows | macOS | Linux |
|---|:---:|:---:|:---:|
| AI Chat | ✓ | ✓ | ✓ |
| Bundled AI runtime | ✓ shipped | ✓ auto-downloaded | ✓ auto-downloaded |
| Vault | ✓ | ✓ | ✓ |
| Home Automation | ✓ | ✓ | ✓ |
| Game Detection | ✓ foreground + scan | ✓ frontmost + scan | ✓ scan |
| Printers | ✓ WMI | ✓ CUPS | ✓ CUPS |
| USB / Drives | ✓ PowerShell | ✓ diskutil | ✓ lsusb |
| System Info (GPU) | ✓ dxdiag | ✓ system_profiler | ✓ lspci |
| Open in shell | ✓ Explorer | ✓ Finder | ✓ xdg-open |
| OS-level key storage | ✓ DPAPI | ✓ keyring | ✓ keyring |
| Mesh / LAN | ✓ | ✓ | ✓ |

## Coming Next

- Community hub server launch
- Federated relay hosted service
- macOS Gatekeeper code signing
- Firefox browser extension
- Ship Mac/Linux AI runtime bundled in the zip (no one-time download needed)
