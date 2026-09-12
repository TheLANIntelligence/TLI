> **Historical development log.** The v1.0.0 entry records the name `TLI_dist_1.0.0.zip`; that exact archive has not been located or verified. These entries describe past work and plans, not current acceptance. See [version preservation](VERSION_PRESERVATION.md) and [current capabilities](TLI_CAPABILITIES.md).

# TheLegatoIntelligence — Development Log
**Version:** v1.2.0-beta
**Date:** 2026-04-14
**Status:** v1.2.0-beta — Live Feed, smarter AI routing, storage intelligence

---

## Session: v0.9.9.8 → v1.0.0 (2026-04-11)

### Official v1.0 Release

TLI reaches its first major version milestone. All core systems are complete and stable.

**What shipped in v1.0:**
- Offline AI Chat with persistent cross-session history
- Encrypted Vault (files, secrets, notes, logins)
- Browser Extension — inline autofill, save-on-submit, popup with search/peek/copy
- Home Automation — Shelly device control, scenes, automations
- LAN Mesh Network — auto-discovery, heartbeat, remote diagnostics
- Satellite Phones — QR join flow, battery/connection telemetry on desktop mesh panel
- File Manager + Disk Visualizer (treemap)
- Game Optimizer — AI-generated performance presets
- TLI Chat — real-time LAN messaging between nodes
- Tools & Scripts — AI script generation with danger scanner
- First-run onboarding wizard — 4-step, PIN setup, AI download, autodetect summary
- Command Palette (Ctrl+K)
- Mobile PWA with bottom nav
- Full User Manual (manual.html) and Landing Page

**Version updated in:** `app.js`, `index.html`, `manual.html`, `landing/index.html`, `TLI_MANUAL.md`, `TLI_DEVLOG.md`

**Dist:** `TLI_dist_1.0.0.zip`

---

## Roadmap — Post v1.0

### Phase 7: TLI Hub (Community Ecosystem)
A community layer that preserves TLI's local-first, no-cloud promise.

**Phase 7a — Hub Browser (read-only)**
- Optional opt-in registry; nothing phones home by default
- Browse and install: themes, AI presets, scripts, automation recipes
- All installs are pull-only — TLI fetches, never pushes user data
- Signed packages with community ratings

**Phase 7b — Custom Panels**
- Sandboxed panel runtime (iframe + Content Security Policy)
- Panel manifest: declares permissions, version, author signature
- Users see exactly what a panel can access before installing
- TLI-to-TLI panel sharing via Hub

**Phase 7c — Federated TLI Chat**
- Cross-network messaging between TLI nodes on different home networks
- Lightweight open-source relay for NAT traversal (self-hostable)
- WebRTC peer negotiation — relay only brokers handshake, not content
- End-to-end encrypted, relay sees nothing

### Phase 8: Phone Companion App
- Dedicated mobile-first UI shell for registered satellite phones
- Served when TLI detects a satellite device opening the URL
- Large touch targets, gesture nav, bottom sheets
- Quick actions: AI chat, device toggles, vault access, send-to-desktop
- Real PWA with offline capability and home screen install

---

## Session: v1.1.0 → v1.1.1-beta (2026-04-13 – 2026-04-14)

### Full Cross-Platform Support — Windows · macOS · Linux

TLI now runs as intended on all three platforms. The backend auto-detects the host OS via
`platform.system()` on every module that has platform-specific behaviour and dispatches to the
correct implementation. A Mac or Linux user gets the same feature set as a Windows user.

---

#### Phase 1 — Core system fixes

**`backend/routers/device_routes.py`**
- Mac removable drives now report `size_bytes` via `os.statvfs()` — no extra subprocess.
- USB snapshot was already platform-conditional; confirmed clean.

**`backend/routers/file_routes.py`**
- Audited — already correct for Mac/Linux (`open`, `open -R`, `xdg-open`). No changes required.

**`backend/routers/games.py`**
- Added `_mac_foreground_process()` — uses `osascript` to get the frontmost application, then
  matches it to a psutil PID. Linux returns gracefully empty (no universal equivalent exists).
- `_gog_common_roots()` — added Mac (`~/Library/Application Support/GOG.com/Games`) and Linux paths.
- `_epic_common_roots()` — added Mac (`~/Library/Application Support/Epic/EpicGamesLauncher`) path.
- `_bnet_common_roots()` — added Mac (`/Applications/Battle.net.app`) path.
- `_xbox_common_roots()` — returns `[]` immediately on non-Windows.
- `_path_is_under()` — fixed to accept `/` as path separator (was `\` only).
- `_match_store_by_string()` — added forward-slash heuristics for Mac/Linux Steam, GOG, Epic, Battle.net.
- `games_detect_filtered` and `games_detect_best` — removed Windows-only early return; both now
  run full process scan on Mac and Linux.

**`backend/routers/system_routes.py`**
- Darwin `system_summary()`: extracted display resolution from `spdisplays_ndrvs` in the same
  `system_profiler SPDisplaysDataType` call already made for GPU.
- Darwin storage: upgraded from listing raw disk IDs to calling `diskutil info -plist <disk>` per
  disk — now reports model name, interface (USB/Thunderbolt/NVMe), SSD/HDD, and `size_gb`.

---

#### Phase 2 — Bundled AI runtime on Mac/Linux

**`TLI_Start.command` + `TLI_Start.sh`**
- Added `_setup_llama_runtime()` function to both launchers.
- Runs once after pip install, before the server starts.
- Checks if `backend/ai/runtime/llama-server` already exists — skips silently if yes.
- Detects OS + architecture: `Darwin/arm64` → `macos-arm64`, `Darwin/x86_64` → `macos-x64`,
  `Linux/aarch64` → `ubuntu-arm64`, `Linux/x86_64` → `ubuntu-x64`.
- Fetches latest llama.cpp release from GitHub API, finds the correct asset, downloads it,
  extracts `llama-server`, places it in `backend/ai/runtime/`, sets `chmod +x`.
- User is prompted; can skip to use LM Studio instead.

**`build_dist.py`**
- Added `llama-server` (no extension, in `backend/ai/runtime/`) to the Unix exec-permissions rule
  so a future Mac/Linux build with the binary present marks it `0o755` in the zip.

---

#### Phase 3 — Printers (CUPS) — macOS / Linux

**`backend/routers/printers.py`**
- All 6 previously Windows-gated endpoints now work on Mac and Linux via CUPS.
- New helpers: `_cups_list_printers()`, `_cups_job_counts()`, `_print_text_cups()`,
  `_open_scan_posix()`, `_open_add_printer_posix()`, `_extract_ip_from_uri()`.
- `GET /api/printers` — enumerates via `lpstat -p`, `lpstat -v`, `lpstat -d`.
- `GET /api/printers/context` — uses `_cups_job_counts()` on Mac/Linux.
- `GET /api/printers/open_scan` — Mac: Image Capture → Preview fallback. Linux: simple-scan → xsane.
- `GET /api/printers/open_add` — Mac: System Preferences Printers & Scanners pane. Linux: system-config-printer.
- `GET /api/printers/discover` — CUPS auto-discovers via Bonjour/Avahi; returns current list.
- `GET /api/printers/test_print` — sends test page via `lp` command.
- `GET /api/printers/supplies` — Windows gate removed; SNMP is pure network, works everywhere now
  that `get_printers()` returns data on all platforms.
- `_ping()` — fixed from hardcoded `-n 1` (Windows) to `-c 1` on Mac/Linux.

---

#### Stability fixes carried from prior sessions (v1.1.0)

- Onboarding wizard: audio fade-in fix, AI activation polling, stale localStorage cleared on reinstall.
- Python 3.9 `TypeAlias` crash fixed in `tli_state.py` — macOS system Python compatibility.
- `TLI_Start.command` / `.sh` banners updated to v1.1.1-beta.
- `build_dist.py`: runtime folder included in dist (was excluded — bundled AI never worked for users).
- `ai_manager.py`: clear "runtime not installed" error message instead of generic "Switch failed".
- macOS install section added to landing page with curl installer + 3-step guide.
- `README_MAC.md` created — macOS-only install, run, uninstall guide.
- Uninstall scripts added: `Uninstall_TLI.bat`, `Uninstall_TLI.command`, `Uninstall_TLI.sh`.

---

**Dist:** `TLI_dist_1.1.1-beta.zip`
**SHA256:** `57f4ab8951bc9c544f9315f98cb9b20f34163958b20509f08c3a26ae971de65d`

---

## Session: v1.1.1-beta → v1.2.0-beta (2026-04-14)

### v1.2 — Live Feed · AI Routing · Storage Intelligence

---

#### Live System Feed (Narrator v2)

**`backend/event_bus.py`** *(new)*
- `emit_event(category, level, title, body, node, actions)` — completely safe, swallows all exceptions, never blocks. Safe to call from any router or thread.
- SSE endpoint `/api/events/stream` — replays last 20 events on connect, then streams live.
- Uses same `asyncio.Queue` per subscriber pattern as `mesh_routes.py` presence stream.
- `set_event_loop(loop)` called from `main.py` `on_startup`.

**`backend/main.py`**
- Registers `event_bus.router`, calls `_event_bus.set_event_loop(loop)` on startup.

**`backend/ai/ai_manager.py`**
- `startup_timeout_s` increased `30 → 120` seconds for cold-start on macOS.
- `is_healthy()` now uses `self.cfg.health_timeout_s` instead of hardcoded `2`.
- Emits `emit_event("ai", "ok", ...)` when model becomes healthy.
- Emits `emit_event("ai", "warn", ...)` on startup timeout.

**`backend/ai/ai_routes.py`**
- Added RAM check to `_should_prefer_mesh()`: routes to mesh if `ram.percent >= 90`.
- Emits feed events when routing to mesh (CPU% or RAM% reason).

**`backend/routers/games.py`**
- `_emit_game_event()` — emits only when game name changes (debounced).
- `_emit_game_cleared()` — emits when previously active game disappears.

**`backend/routers/mesh_routes.py`**
- Emits `emit_event("mesh", "info", ...)` when a peer joins the mesh.

**`frontend/js/live-feed.js`** *(new)*
- `EventSource("/api/events/stream")` with 5s auto-reconnect.
- `_renderEvent()` — renders `.lf-event` cards into `#nd-feed`.
- Category → accent color mapping: ai, game, mesh, device, automation, system, vault.
- Bell badge: increments when Dashboard is not active, clears on Dashboard open.
- `MutationObserver` watches `panel-dashboard2` `hidden` attribute for auto-clear.

**`frontend/index.html`**
- Notification bell + badge added to header (`#tli-feed-bell`, `#tli-feed-badge`).
- `live-feed.js` script tag added.

---

#### AI Source Modal Redesign

**`frontend/index.html`**
- Replaced 5-option modal (with LAN host dropdown, route preview, Test Route button) with clean 3-option layout: **Smart (Recommended)** / **Local Only** / **Mesh Preferred**.
- Added `.ai-rec-badge` on Smart option, `.ai-privacy-footer` at bottom.
- Added `#ai-detected-local` and `#ai-detected-lan` availability rows (IDs preserved for JS).

**`frontend/app.js`**
- `openAISourceModal()` — shows live model name/status in availability rows, remaps legacy policies to new 3-option set.
- `wireAISourceModal()` — simplified save, removed test route and host selector handlers.
- `policyLabel()` — updated labels for new 3-option set.

**`frontend/settings_enhanced.js`**
- AI preset activate: auto-switches policy from `PREFER_LAN_ALLOW_LOCAL` / `LAN_ONLY` → `AUTO` when local model activates.

---

#### Storage Intelligence

**`backend/routers/visualizer.py`**
- New endpoint `GET /visualizer/paths` — returns real `Path.home()` and common folder paths (Downloads, Desktop, Documents, Pictures, Videos/Movies, Music) only if they exist on disk.
- Auto-detects installed cloud drives: OneDrive, iCloud Drive, Dropbox, Google Drive (Windows/macOS/Linux variants).
- Linux Google Drive covers 3 common mount conventions (`~/GoogleDrive`, `~/gdrive`, `~/Google Drive`).

**`frontend/app.js`**
- `window.TLI_PATHS` — populated at bootstrap from `/visualizer/paths`.
- `_tliHomePath()` — now returns real path instead of literal `"~"`.
- `_tliPathPreset(kind)` — uses real server paths when available, falls back to `~/folder` construction.
- `_tliLoadCommonPaths()` — fetches paths at startup, populates datalist, dispatches `tli:paths-loaded` event.
- `_tliApplyPathSuggestions()` — fills `#visualizerPathSuggestions` datalist and updates placeholders.
- `_tliApplyServerOS()` — simplified; real placeholders now come from `_tliLoadCommonPaths`.

**`frontend/index.html`**
- Visualizer: replaced "Custom folder" section with **Quick folders** chip strip (Downloads, Desktop, Documents, Pictures, Videos, Home) above path input.
- File Organizer: added Videos tile alongside existing Downloads/Desktop/Documents/Pictures/Home.
- File Organizer path input: placeholder updated.

**`frontend/js/visualizer.js`**
- `_wireVisQuickFolders()` — wires `data-vis-preset` buttons to set path input and trigger scan.
- Re-wires on `tli:paths-loaded` event in case real paths arrive after DOM ready.

---

**Dist:** `TLI_dist_1.2.0-beta.zip`
**SHA256:** `49688938ef8e28292db139dd4cd8939a2243c992cbd45b5bc83640c4aebd0f4b`

---

## Session: v0.9.9.7 → v0.9.9.8 (2026-04-10)

### Browser Extension — Full Upgrade (Better Than 1Password)

Rewrote all five extension files to close the feature gap with commercial password managers.

**content.js (full rewrite)**
- Field icon injection: a small emerald key icon appears inside every detected password field (and its associated username field), flush to the right edge. Uses absolute positioning keyed to `getBoundingClientRect()` + scroll offset; repositions on resize and scroll via passive listeners.
- Click the icon → a styled dropdown appears below the field, listing all vault logins for the current domain with keyboard navigation (↑ ↓ Enter Esc). Dropdown flips above the field if viewport overflow is detected.
- `Ctrl+Shift+L` (Cmd+Shift+L) keyboard shortcut: fills immediately if 1 match, opens dropdown if multiple. Uses capture-phase listener with `stopImmediatePropagation` to take priority over page handlers.
- Login cache: `getDomainLogins()` fetches on first access and caches for the page lifetime; pre-warmed in the background on `init()` so the dropdown is always instant.
- Form submit watcher: listens for `submit` events on forms containing a password field. If the submitted username isn't already in the vault, shows a **Save this login?** banner at the bottom of the page (slides up, auto-dismisses after 12s).
- Save banner POSTs to the new `POST /vault/ext/logins` backend endpoint via `TLI_SAVE_LOGIN` message.
- React-compatible fill via native `HTMLInputElement.prototype.value` setter + synthetic `input`/`change` events.
- MutationObserver with 400ms debounce re-runs `setupForms()` for SPA navigation.

**popup.html / popup.css / popup.js**
- Added search bar (icon + `<input type="search">`) between header and login list. Filters by name, username, or domain as the user types. Auto-focuses when ≥5 logins.
- Popup width increased to 340px, max-height to 520px.
- Per-item action buttons: on hover, three icon buttons appear at the right of each login row: copy username, copy password, peek password (shows the raw password in a monospace overlay for 3.5s). All use closures over the login object — no passwords in data attributes.
- Login items still click-to-autofill (ignoring clicks on action buttons via `e.target.closest(".login-actions")`).
- Better error rendering: errors show in both status bar and list area for clarity.

**background.js**
- Added `saveLogin(data)` function: `POST /vault/ext/logins` with API key auth and 5s timeout.
- Added `TLI_SAVE_LOGIN` message handler wired to `saveLogin`.

**vault_routes.py — new endpoint**
- `POST /vault/ext/logins` — extension-authenticated (API key, no session cookie), accepts `VaultLoginCreateRequest` body, writes an encrypted login entry to the vault. Reuses existing `load_vault_logins` / `save_vault_logins` storage layer.

**TLI_MANUAL.md — updated to v0.9.8**
- New section: **Browser Extension (Vault Autofill)** — installation, setup, inline icon, keyboard shortcut, popup features table, save-login prompt, requirements.
- Vault "What you can store" updated to list Logins.
- Security Model table: added Extension API key row.
- Keyboard Shortcuts table: added Ctrl+Shift+L.
- Troubleshooting: added 3 extension-specific entries (vault locked, invalid API key, icon not appearing).

---

## Session: v0.9.5 → v0.9.7 (2026-04-10)

### AI Panel Awareness
The bundled AI now knows which TLI panel the user is currently viewing and uses that context naturally in responses.

- `active_panel: Optional[str]` added to `ChatRequest` in `ai/ai_routes.py`
- `_build_system_prompt()` injects a "Active panel: The user is currently viewing the **X** panel" line when the panel ID is known
- `_PANEL_LABELS` dict maps all panel IDs to human-readable labels
- Both streaming and non-streaming chat paths pass `active_panel` through
- `app.js`: `_currentPanelId` tracks the active panel (set in `switchPanel()`); passed in every `tliBundledChatStream()` call
- `system_default.txt` rewritten to include a `== TLI PANELS ==` section listing all panels with descriptions and example conversations

### Mesh Chat Completeness
Five missing features added to TLI Chat (LAN messaging):

1. **Off-panel notifications** — new messages show a toast and bottom-nav badge even when the user is in a different panel; `startBgPoll()` + `startPresenceStream()` remain alive when chat UI is closed
2. **Read receipts** — `POST /mesh/chat/read` stores `up_to_ts` per reader; `GET /mesh/chat/read_status` lets senders poll; single tick (✓) = delivered, double tick (✓✓ green) = read
3. **Typing indicator** — `POST /mesh/chat/typing` volatile in-memory state (5s TTL); SSE broadcast + direct peer HTTP push; three-dot bounce animation in chat thread
4. **`peer` undefined bug fix** — `createOutgoingFileOffer()` was using undefined `peer` instead of `remoteNode` for the `to_ip` field; file offers never reached the receiver until now
5. **File card CSS** — `.tli-file-card`, `.tli-file-btn` styles added; transfer cards now render correctly

### Phase 7: Mobile Responsive Pass
Full mobile layout pass across all panels:

- Dead automations CSS removed (`.auto-trigger-extras`, `.auto-switch`, `.auto-day-check` — leftover from reverted feature)
- **≤480px** — AI "Manage" button hidden (access via Settings), AI pill compressed, node-switcher label text hidden
- **≤520px** — `.page-header` wraps vertically (action button drops to full width); Print & Scan `.ps-field-row` stacks label above field; vault inline inputs go full-width; unlock row wraps
- **≤560px** — Devices `card-header-actions` 4-button row wraps and distributes evenly
- **≤768px** — Toast notifications repositioned above the bottom nav bar

### Satellite Phone System (Phase 7 extension)
Smartphones can now join the TLI mesh as lightweight satellite nodes without running a backend.

**Backend — `routers/satellite_routes.py` (new file):**
- `POST /mesh/satellite/generate-token` — 10-minute one-time join token + TLI-themed QR SVG (emerald on dark)
- `POST /mesh/satellite/register` — redeems token, writes entry to `data/satellite_registry.json`, returns `node_id` + `secret`
- `POST /mesh/satellite/heartbeat` — phone pings every 30s with battery %, charging state, connection type (wifi/cellular)
- `GET /mesh/satellite/list` — desktop reads satellite cards (secrets stripped, online=false after 2 min silence)
- `DELETE /mesh/satellite/{node_id}` — desktop removes a satellite
- `qrcode>=7.4.2` added to `requirements.txt`

**Frontend — `TLISatellite` IIFE in `app.js`:**
- Phone path: detects `?join=satellite&token=xxx` → shows join screen → POSTs register → stores `node_id`+`secret` in localStorage → redirects to `/`
- Heartbeat: gathers battery (Battery Status API) + connection type (Network Information API) + platform → POSTs every 30s
- 403 on heartbeat clears localStorage automatically (satellite was removed)
- Desktop path: "📱 Add Phone" button → QR modal with live countdown; satellite cards rendered below the node grid

**Frontend — `index.html`:**
- Satellite join screen overlay (`#tli-sat-join`) — full-page, shown on phone when join URL detected
- QR code modal (`#tli-sat-qr-modal`) — QR image, copyable URL, 10-min countdown
- "📱 Add Phone" button in Mesh panel header
- Satellite phones section (`#mcd-satellites-section`) below the node grid, hidden until at least one satellite is registered

**Frontend — `style.css`:**
- Join screen: full-page dark overlay, centered card
- QR modal: 196×196 QR image well, URL strip with copy button
- Satellite node cards: indigo-accent border, phone emoji avatar, battery bar, "AI via Host" indicator
- "Add Phone" button: emerald accent variant matching the mesh header style

### Docs
- `TLI_MANUAL.md` updated to v0.9.7 — rewrote First Launch (HTTP default, HTTPS opt-in), added TLI Chat section, Print & Scan Studio section, Satellite Phones section, Mobile Usage section; updated Navigation table, Security Model, Data Locations, Automations (honest about current scope)
- `TLI_DEVLOG.md` updated to v0.9.7

---

---

## What TLI Is

TheLegatoIntelligence (TLI) is a self-hosted, offline-first Home OS and LAN console.
It runs on your own hardware, serves your own network, and never touches the cloud.

The core identity: **a premium terminal-aesthetic command center for your home network** — where you can control smart devices, run AI, manage files, monitor systems, chat with other devices on your LAN, and keep secrets in an encrypted vault. All local. All yours.

---

## Where It Started

TLI began as a local AI chat interface — a wrapper around LM Studio with a clean UI.
Single machine. Single user. Single purpose.

From that seed, it grew into something much larger:
- A multi-panel SPA with its own routing
- A FastAPI backend with dedicated routers per domain
- A live mesh network connecting multiple devices on the LAN
- A vault with real AES-256-GCM encryption
- Home automation via Shelly smart devices
- A system that can run on any device on your network

The project is roughly 33,000+ lines of intentional code across Python and JavaScript.

---

## Architecture

### Backend
```
backend/
├── main.py              # Orchestrator — mounts all routers, startup hooks
├── tli_state.py         # Shared state, paths, JSON persistence, node config
├── vault_security.py    # PBKDF2 password KDF, AES key derivation, lockout logic
├── routers/
│   ├── node_routes.py       # Local node stats (disk/CPU/RAM/uptime), logs, maintenance
│   ├── mesh_routes.py       # Mesh directory, presence SSE, heartbeat, chat, proxy
│   ├── vault_routes.py      # File/secret/note encryption, export, reset
│   ├── chat_routes.py       # AI chat, multi-model routing, superprompt
│   ├── shelly_routes.py     # Shelly smart device control
│   ├── home_power.py        # Home power monitoring
│   ├── actions_engine.py    # Suggested actions + receipt log
│   ├── system_routes.py     # System summary, PowerShell bridge
│   ├── system_summary.py    # Agent-side telemetry (CPU/RAM/Disk/Uptime)
│   ├── file_routes.py       # File organization, AI bucket suggestions
│   ├── visualizer.py        # Storage visualization
│   ├── games.py             # Games optimizer
│   ├── tool_routes.py       # Tools and scripts runner
│   ├── device_routes.py     # USB/printer/device discovery
│   ├── printers.py          # Printer management, WIA devices
│   ├── ai_model_routes.py   # AI model listing and management
│   ├── debug.py             # Debug console
│   └── whereami.py          # Node self-identification
```

**Key patterns:**
- `tli_state.py` is the single source of truth for paths and JSON persistence
- All routes are stateless — shared state lives in JSON files read/written by `tli_state.py`
- Background threads (heartbeat, presence watcher, task worker) run alongside the async FastAPI event loop
- SSE uses `asyncio.Queue` + `loop.call_soon_threadsafe()` to bridge sync threads → async streams
- Server binds to `0.0.0.0:8000` by default (LAN-accessible), configurable via `TLI_HOST` / `TLI_PORT`

### Frontend
```
frontend/
├── index.html              # Single-page app shell, all panel HTML (~2,236 lines)
├── app.js                  # Core SPA logic, all panels, IIFEs (~14,315 lines)
├── style.css               # All styling, dark/light/emerald themes (~9,174 lines)
├── chat_enhanced.js        # Drop-in patch for TLI Chat improvements
├── chat_enhanced.css       # Chat-specific style overrides
├── settings_enhanced.js    # Drop-in patch for Settings panel
├── settings_enhanced.css   # Settings-specific style overrides
├── panel_cleanup.js        # Drop-in cleanup for panel rendering bugs
└── model_manager.js        # AI model management UI
```

**Key patterns:**
- Vanilla JS only — no framework, no build step
- Enhancement files are drop-ins that patch app.js behavior at runtime via function overrides
- IIFEs for each major panel (TLIDash2, TLIChat, TLISystem, TLIGames, etc.) exposed on `window`
- Panel routing via `switchPanel(id)` which shows/hides `.panel-container` sections
- `data-state` attribute CSS pattern for state-driven styling (e.g. vault pill)
- All themes implemented as `body.theme-*` class toggles on the root

---

## What's Working — Feature by Feature

### Dashboard (Primary Homepage)
- **Status:** Working. Default landing panel.
- Live strip: CPU %, RAM %, Disk %, Uptime, Mesh node count, AI source
- Network Nodes widget: shows all mesh peers as pills — green dot when online, grey when stale, clickable links to peer TLI instances
- What Changed feed: pulls from actions receipt log + localStorage
- Suggested Actions: Home Automation, Scan Storage, Check Devices (wired to backends)
- Quick Actions grid: navigation shortcuts to every panel
- System Health, AI Status, Network, Storage cards
- Polls every 3 seconds when open, stops when panel closes

### AI Chat (Main Chat / TLI Brain)
- **Status:** Working.
- Local LLM via bundled phi-3.5-mini (BundledAIManager, runs as subprocess)
- LM Studio fallback (configurable URL, connect timeout, read timeout)
- Multi-model auto-routing: code → Qwen, reasoning → DeepSeek, short → Llama, default → configured model
- Streaming responses via SSE (`/chat/stream`)
- AI source picker modal — policy options: Auto, Local Only, LAN Only, Prefer LAN, Prefer Local
- AI source pill in header (live status indicator)
- Chat history draft saved to localStorage per session
- Teaching mode toggle (adds context about TLI to prompt)
- Superprompt defines TLI's identity and response style

### TLI Chat (LAN Messenger)
- **Status:** Working — requires second device to test end-to-end.
- Node discovery via `/mesh/directory` + SSE presence stream
- Buddy list with online/offline state, search
- Thread-based messaging: `POST /mesh/chat/send` → fires to remote node's `/mesh/chat/receive`
- Message polling per thread (`/mesh/chat/messages?thread_id=...&since=...`)
- File share UI (frontend structure in place)
- Live presence pill in header

### Mesh / Presence System
- **Status:** Working. Recently overhauled.
- Every device that runs TLI is a peer — federated, not centralized
- `POST /mesh/join` — peer registers with host (real IP captured from `request.client.host`)
- `POST /mesh/agent_heartbeat` — periodic keep-alive with `tli_port` included
- `GET /mesh/presence/stream` — SSE stream; sends snapshot on connect, then live `node_online`/`node_offline` events
- `_presence_timeout_watcher` — background thread, polls every 15s, broadcasts `node_offline` after 90s silence
- Ghost entry pruning on startup (`_prune_ghost_entries`)
- `tli_port` stored per node — proxy calls (`/ping`, `/info`, `/diagnostics`) use the stored port
- Mesh directory served via `GET /mesh/directory` — filters null-IP ghost entries

### Node Switcher
- **Status:** Working (UI wired; needs second live node to validate navigation).
- Pill-button in the header: shows current node name + green dot
- Dropdown on click: lists all mesh peers with TLI URLs (`http://ip:port`)
- "Here" badge on self node, greyed out for offline/no-IP entries
- Peer entries are `<a>` links that open the peer's TLI in a new tab
- Refreshes from `/mesh/directory` on each open

### Vault
- **Status:** Working.
- Password: PBKDF2-HMAC-SHA256, 200,000 iterations, 16-byte random salt
- Encryption key: derived from password + separate encryption salt — never stored on disk, in-memory only
- File encryption: AES-256-GCM, nonce prepended to ciphertext, stored as `.vault` files
- Secrets: key-value pairs, each value encrypted individually
- Notes: encrypted text notes, stored as `__note_{id}.vault` files
- Tabs: Files | Secrets | Notes
- Lockout: 5 wrong attempts → 10-minute lockout (stored in `vault_meta.json`)
- Session: unlocked for 30 minutes per user, then auto-locks
- Export: `GET /vault/export_backup` → ZIP of all `.vault` files (downloadable before reset)
- Reset: typed "RESET VAULT" confirmation → deletes all `.vault` files + `vault_meta.json` + wipes in-memory keys
- Vault status pill: `data-state` CSS system (locked/unlocked/setup) — theme-aware, always readable

### Home Automation (Shelly)
- **Status:** Working. Quality benchmark panel.
- Shelly device registry (discovery, control, status)
- Scene management
- Offline control (works without cloud)
- Home power monitoring
- Actions engine: suggested automations with receipt logging
- Status pill in header (health indicator)

### System Summary
- **Status:** Working.
- Live telemetry from `/agent/system_summary`: CPU %, RAM %, Disk %, Uptime, hostname
- Fallback to `/system/summary` if agent unavailable
- System profile (hardware description, saved to disk)
- PowerShell bridge for Windows-native operations

### Storage Visualizer
- **Status:** Working.
- Folder/file size tree visualization
- Scan results cached, breadcrumb navigation

### File Organizer
- **Status:** Working.
- Scan a folder, get AI-suggested organization buckets
- Preview organize (plan only) or Run organize (executes moves)
- Custom rules via natural language prompt
- Undo-safe: preview before committing

### Games Optimizer
- **Status:** Working.
- Offline game detection and optimization recommendations
- No cloud required

### Tools & Scripts
- **Status:** Working.
- Run PowerShell and bash scripts from the UI
- Script management, output display

### Settings
- **Status:** Working.
- AI source policy (Auto/Local/LAN/etc.)
- Preferred LAN host selector
- Brain selector (model key)
- Response mode (Default/Concise/Step/Developer)
- Temperature and max-token controls
- Theme selector (midnight/emerald/light)
- Teaching mode

### Printers & Devices
- **Status:** Working.
- Printer discovery, WIA device listing
- OS-native printer screen shortcut
- USB/connection device listing

---

## What Was Built in Recent Sessions

### Session: Mesh Realignment (10 Objectives)
The mesh went from decorative to functional:
1. Real IP capture on join (from `request.client.host`)
2. Ghost entry pruning on startup
3. Heartbeat gate fixed (was blocked on "approved" status that was never set)
4. SSE presence stream (`/mesh/presence/stream`) replacing 3.5s polling
5. `node_online`/`node_offline` events broadcast in real-time
6. `_presence_timeout_watcher` background thread (90s timeout)
7. `mapMeshDirectoryToNodes` fixed (`device_id` → `d.device_id`, `display_name` → `d.display_name`)
8. Thread-safe SSE broadcast via `loop.call_soon_threadsafe`
9. Zero regression on working features

### Session: Vault Redesign
The vault went from a single password field to a full encrypted personal data store:
- Three-tab layout: Files | Secrets | Notes
- Full backend CRUD for encrypted notes (`__note_` prefix pattern)
- Vault reset with typed confirmation (removed unreliable `window.confirm()`)
- Export backup endpoint (ZIP download before reset)
- Vault status pill redesigned with `data-state` CSS (visible on all themes)
- Lockout display with attempt counter and time remaining

### Session: Dashboard Graduation + LAN Bind
- Dashboard promoted from "Preview" to primary homepage (default landing)
- `0.0.0.0` default bind — TLI is now LAN-accessible by default
- Network Nodes live widget added to dashboard
- Subnet-aware node pills (online/offline state, 3s refresh)

### Session: Federated Peer Architecture
- `tli_port` added to every directory entry, model, heartbeat, and SSE event
- Node pills on dashboard become clickable `<a>` links to peer TLI instances
- Node Switcher added to header — dropdown showing all LAN peers with navigation links
- All proxy endpoints (`/ping`, `/info`, `/diagnostics`, `_proxy_post`, `_proxy_get`) now use stored `tli_port` instead of hardcoded 8000
- Architectural shift: every device runs full TLI (not lightweight agent) — self-contained, peer-to-peer

---

## Current Development Position

```
[Phase 1 — Complete]  Local AI Chat Wrapper
[Phase 2 — Complete]  Multi-Panel SPA (Chat, Settings, Files, Visualizer, Games)
[Phase 3 — Complete]  Home Automation (Shelly, scenes, power monitoring)
[Phase 4 — Complete]  Vault (AES-256-GCM, files/secrets/notes, lockout, reset)
[Phase 5 — Complete]  Mesh Networking (real presence, SSE, peer discovery)
[Phase 6 — Active]    Federated Peer Model (each device = full TLI, node switcher)
[Phase 7 — Planned]   Mobile Experience (responsive-first, touch UX, installable PWA)
[Phase 8 — Planned]   Cross-device AI Routing (LAN AI, distributed inference)
[Phase 9 — Planned]   Sync & Shared State (selective cross-device data sharing)
```

### What's Solid
- The backend architecture is clean and extensible (router-per-domain pattern)
- The vault security model is sound (key never on disk, proper KDF, constant-time compare)
- The SSE presence system is production-grade (thread-safe, keepalive, cleanup)
- The Home Automation panel is the quality bar for everything else
- The federated model is architecturally correct for a "Home OS"

### What Needs Validation
- Node Switcher navigation (needs a real second device running TLI)
- End-to-end LAN Chat (same — needs two live nodes)
- Mobile browser experience (declared as separate workstream)
- `routers/node_routes.py` — moved from root to routers/, actively used by the mesh panel and dashboard

### Known Technical Debt
- `setupScriptsPanel()` and `setupSettingsPanel()` are called twice in the DOMContentLoaded block
- Enhancement files (`chat_enhanced.js`, `settings_enhanced.js`) may drift from main `app.js` changes
- Some proxy endpoints still assume the host is a "host" role node — needs rethinking under the federated model where all nodes are equal
- The `become_host` flow is legacy thinking; in the federated model, every TLI is its own host

---

## File Sizes (as of 2026-03-30)

| File | Lines |
|------|-------|
| `frontend/app.js` | 14,315 |
| `frontend/style.css` | 9,174 |
| `frontend/index.html` | 2,236 |
| `backend/routers/mesh_routes.py` | 974 |
| `backend/routers/home_power.py` | 602 |
| `backend/routers/file_routes.py` | 586 |
| `backend/routers/games.py` | 560 |
| `backend/routers/vault_routes.py` | 456 |
| `backend/routers/system_routes.py` | 516 |
| `backend/tli_state.py` | 663 |
| `backend/vault_security.py` | 269 |
| **Total (approx)** | **~33,000** |

---

## Philosophy Notes

- **Offline-first, always.** No feature should require the internet to function.
- **LAN-native.** TLI is built for the local network, not around it.
- **One vault, one identity per device.** Each TLI instance is the authoritative record for its own machine.
- **Emerald identity.** The aesthetic is deliberate — premium, terminal, trustworthy.
- **No guessing.** Read before writing. Surgical patches over broad rewrites.
- **Home Automation is the quality standard** for every other panel.
