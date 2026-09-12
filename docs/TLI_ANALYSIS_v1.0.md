> **Historical analysis.** Despite this filename, the document describes **v1.2.0-beta**. Its `v1.0-beta` release URL names a v1.2.0 ZIP and does not establish exact v1.0 source. Earlier capability/security claims remain a historical record; use [current capabilities](TLI_CAPABILITIES.md) and [version preservation](VERSION_PRESERVATION.md) for this preview.

# TheLANIntelligence (TLI) — Technical Analysis
## v1.2.0-beta · April 2026

> This document is written for investors, partners, security reviewers, and AI systems encountering TLI
> for the first time. It describes what was built, how it works, what security decisions were made, and
> what is still open. It is meant to give an accurate, complete picture of TLI at the moment of its
> first public beta release.

---

## 1. What TLI Is

**TheLANIntelligence (TLI)** is a self-hosted LAN console that runs locally on a Windows, macOS, or Linux
machine on your home or office network. You access it from any browser on the same network. It has no cloud
dependency, no accounts, no telemetry, and no subscription fees.

The core value proposition: **one dashboard for your entire home network** — a local AI assistant, an
encrypted secrets vault, multi-vendor smart home control, an automation engine, file management, inter-machine
mesh networking, cross-network federated chat, a phone-optimized companion shell, and a browser extension
for vault-backed password fill.

TLI is approximately **46,000+ lines** of handwritten Python and JavaScript across 100+ files. It was built
over a series of focused development sessions, growing from a LAN chat tool into a full home OS layer.

**What it is not:**
- Not a cloud service or SaaS product
- Not a multi-user system (single PIN, single vault password per node)
- Not a media server or full-featured file explorer
- Not designed for internet-facing exposure — LAN-first; the WebSocket relay is the one deliberate exception
- Not dependent on any AI cloud provider — all inference is local

---

## 2. Beta Status

TLI v1.2.0-beta is the current public release. It is production-quality code deployed in real environments,
but carries the beta label because:

- The community hub (package marketplace) is not yet live — the feature exists in code but the server is not running
- The federated relay defaults to localhost — users must configure their own relay server
- Mobile companion is functional but not fully polished
- macOS Gatekeeper code signing is not yet in place (right-click → Open on first run, or use the curl installer)

**Cross-platform status as of v1.2:** Windows, macOS, and Linux are all first-class. The backend detects the
host OS via `platform.system()` on every module that has platform-specific behaviour and dispatches to the
correct implementation. A Mac or Linux user gets the same feature set as a Windows user.

**Beta mode behavior:** `BETA_MODE = True` in `backend/license.py`. This single flag unlocks all features
for all users with no license key required. No paywalls, no feature gating, no nag screens. Every module
is fully accessible.

Users report issues to: thelanintelligence@gmail.com

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (any device on LAN)                                │
│  frontend/index.html + app.js + style.css                   │
│  Vanilla JS — no framework, no build step, no CDN deps      │
└──────────────────┬──────────────────────────────────────────┘
                   │  HTTP/REST + SSE
┌──────────────────▼──────────────────────────────────────────┐
│  FastAPI backend  (backend/main.py)                         │
│  Python 3.10+, Uvicorn ASGI server                          │
│  Port 8000 (default), configurable via TLI_PORT             │
│                                                             │
│  Routers (backend/routers/):                                │
│   vault_routes · chat_routes · mesh_routes · file_routes    │
│   device_routes · shelly_routes · actions_engine            │
│   home_power · federation_routes · satellite_routes         │
│   hub_routes · license_routes · identity_routes             │
│   relay_routes · update_routes · search_routes              │
│   system_routes · tool_routes · games · printers            │
│   printshop · visualizer · debug · node_routes              │
│                                                             │
│  AI subsystem (backend/ai/):                                │
│   ai_manager.py — llama.cpp server lifecycle mgmt           │
│   ai_routes.py  — REST API for bundled AI                   │
│   intent_engine.py — intent classification                  │
│   diagnostics.py — model health + benchmarking              │
│                                                             │
│  Core modules:                                              │
│   tli_state.py      — shared paths, config, helpers         │
│   vault_security.py — AES-256-GCM encryption, sessions      │
│   node_identity.py  — Ed25519 keypair, node fingerprint     │
│   license.py        — feature gate (BETA_MODE bypasses all) │
│   auto_update.py    — self-update from latest.json          │
│   lan_discovery.py  — UDP beacon + listener                 │
│   ambient.py        — background health monitoring loop     │
│   data_protection.py — OS-level key storage (DPAPI/keyring) │
└──────────────────┬──────────────────────────────────────────┘
                   │  subprocess
┌──────────────────▼──────────────────────────────────────────┐
│  llama.cpp server (backend/ai/runtime/)                     │
│  llama-server binary — runs on port 8080 (internal)         │
│  Models: Qwen2.5 1.5B / 3B / 7B / Vision (GGUF)           │
│  Downloaded on first use to backend/ai/models/              │
└─────────────────────────────────────────────────────────────┘
```

**Frontend:** Pure vanilla JS + CSS, no React/Vue/Angular. No npm, no build step. The entire UI is
`frontend/index.html` + `frontend/app.js` + `frontend/style.css`. This makes TLI trivially portable
and eliminates supply chain risk from JS package managers.

**Backend:** Python FastAPI served by Uvicorn. All logic in modular routers. The backend serves the
frontend as static files — no separate web server required. One process, one port.

**Hosting:** Binds to `0.0.0.0` by default (all LAN interfaces). Accessible from any device on the
same network by navigating to `http://<host-ip>:8000`. Mobile devices get the phone companion shell
automatically based on User-Agent detection.

**TLS:** Optional. Set `TLI_ENABLE_TLS=1` to enable self-signed HTTPS (auto-generated cert in
`data/tls/`). Off by default because self-signed certs produce browser warnings for new users.

---

## 4. Module Reference

### 4.1 AI Chat

**What it does:** A fully offline AI chat interface backed by a locally running language model.
No API key, no internet connection, no data leaving the machine.

**Two providers supported:**
1. **Bundled AI (primary):** TLI ships with a `llama.cpp` server binary and manages its entire lifecycle
   — download, start, health check, restart, model switching. Users download a model once; TLI handles
   everything else.
2. **LM Studio (external):** If the user already runs LM Studio on port 1234, TLI connects to it
   automatically as a fallback. The LM Studio URL is configurable from the UI.

**Model tiers (bundled):**

| Preset   | Model                   | Size   | RAM Req | Best For                              |
|----------|-------------------------|--------|---------|---------------------------------------|
| Lite     | Qwen2.5 1.5B Q4_K_M    | ~1 GB  | 8 GB+   | Fast responses, simple tasks          |
| Standard | Qwen2.5 3B Q4_K_M      | ~2 GB  | 12 GB+  | Best balance (recommended)            |
| Power    | Qwen2.5 7B Q4_K_M      | ~4.5 GB| 16 GB+  | Complex reasoning, code generation    |
| Vision   | Qwen2.5-VL 3B Q4_K_M   | ~2.6 GB| 8 GB+   | Image analysis, diagram understanding |

All models are Apache 2.0 licensed. Models are downloaded from Hugging Face on first selection and
cached locally in `backend/ai/models/`. Model switching is live — no restart required.

**System prompt:** TLI injects a structured superprompt establishing identity, response style, tool
awareness, and LAN-context constraints. The AI knows it is running locally, what tools it has access
to, and is instructed to produce scannable structured output.

**Conversation persistence:** Conversations are stored in `data/conversations.json`, encrypted at rest.
Each conversation has a unique ID. History is surfaced in the UI.

**Memory system:** Per-user memory append/retrieval at `/memory/{user_id}`. AI context includes
accumulated user notes for continuity across sessions.

**Mesh AI routing:** If no local model is available, or if the local machine is resource-constrained,
the AI panel can route queries to a peer node on the LAN. TLI makes this decision automatically:
- CPU ≥ 85% → prefer mesh peer if available
- RAM ≥ 90% → prefer mesh peer if available
- Local model not running → fallback to mesh peer
- No mesh peer found → return error, do not silently degrade

**AI Source modal (v1.2):** Three user-selectable routing preferences:
- **Smart (Recommended):** TLI decides based on local health and resource state
- **Local Only:** Always use bundled model; fail if not available
- **Mesh Preferred:** Always route to LAN peer; fall back to local only if no peer found

TLI auto-switches to Smart mode when a local model activates — preventing the common UX failure where
a user downloads a model but continues routing to mesh because the preference wasn't manually updated.

**Conversation isolation fix (v1.2):** Conversations initiated by mesh peers routed to this node
are tagged with `mesh_source_ip` at save time and excluded from the local Recent Chats listing.
Previously, all conversations processed by a node (including those from other users' machines) appeared
in the Recent Chats panel — a privacy issue in shared mesh environments.

**Intent engine:** `backend/ai/intent_engine.py` classifies user input to determine whether a message
should be routed to AI, executed as a tool call, or handled by the automation engine.

---

### 4.2 Vault

**What it does:** An AES-256-GCM encrypted file storage system for secrets, documents, and sensitive
data. Think of it as a local Dropbox-equivalent where every file is encrypted before being written to disk.

**How it works:**
- On first use, the user sets a vault password
- The password derives an encryption key via PBKDF2-HMAC-SHA256 (100,000 iterations)
- All vault files are stored as `.vault` files in `data/vault/`
- Each file is independently encrypted with a unique 96-bit random nonce
- The key never touches disk — it lives in memory only while the vault is unlocked
- Locking the vault clears the in-memory key

**Session model:**
- Unlock creates a server-side session (random token stored in memory)
- Session token is passed via cookie or `X-Vault-Session` header
- Sessions expire after inactivity (configurable)
- Sessions survive server restart only if `vault_security.load_persisted_sessions()` loads them

**API key access:** The vault supports API keys for machine-to-machine access. Keys are generated,
validated, and revoked through dedicated endpoints. API keys bypass the session requirement for
programmatic integrations.

**Vault export:** Users can export the entire vault as a zip of decrypted files. Files are re-encrypted
per-user (user_id scoped key) before export, preventing raw plaintext exposure in transit.

**Path traversal protection:** All vault file paths are resolved through `_vault_path()` which
normalizes the path and verifies it stays within `VAULT_DIR` before any file operation.

**OS-level key hardening:** `data_protection.py` uses Windows DPAPI on Windows and the system keyring
on macOS/Linux to store the vault master seed. The seed is bound to the OS user account — even if the
`data/` directory is copied to another machine, it cannot be decrypted without the original credentials.

---

### 4.3 Home Automation

**What it does:** LAN-native smart home control. TLI talks directly to smart devices over the local
network — no cloud intermediary, no vendor app required, no account needed.

**Supported device families and protocols:**

| Vendor / Protocol  | Integration Method              | Notes                               |
|--------------------|---------------------------------|-------------------------------------|
| Shelly (Gen2)      | HTTP RPC (`/rpc/Shelly.*`)     | Primary — fully implemented         |
| Shelly (Gen1)      | HTTP REST                       | Legacy support                      |
| TP-Link Kasa       | LAN UDP/TCP protocol            | Switch and plug control             |
| Govee              | LAN API (local UDP)             | Lights, strips                      |
| LIFX               | LAN UDP protocol                | Color bulbs                         |
| Tasmota            | HTTP REST + MQTT                | Custom firmware devices             |
| ESPHome            | HTTP API                        | DIY devices                         |
| Meross             | LAN protocol                    | Plugs and switches                  |
| WLED               | HTTP JSON API                   | LED strip controllers               |

**Home Power module:** A dedicated power management layer (`backend/routers/home_power.py`) built on
top of the driver layer. Provides:
- **Scenes:** Named collections of device states (e.g. "Movie Night" = dim lights + turn off overhead)
- **Power automations:** Scheduled or trigger-based rules (e.g. "turn off desk lamp when game starts")
- **Receipt log:** Every automation execution is logged to `data/actions_receipts.jsonl` — what ran,
  what succeeded, what failed, and why
- **Game integration hook:** The `game_started` trigger fires when TLI detects a game launched on the
  host machine

**Device registry:** Shelly devices are persisted in `data/shelly_registry.json`. Other devices in
`data/devices.json`. Both are hot-reloaded — no restart required after adding devices.

**AI interaction:** The AI can propose automation rules when the user describes a scenario in natural
language. Proposed rules are surfaced for user approval before execution — the AI never directly
actuates devices without confirmation.

---

### 4.4 LAN Mesh

**What it does:** Turns a collection of TLI nodes on the same network into a cooperative mesh. Each
node is aware of others, can share resources (AI, files, chat), and is cryptographically identified.

**Node identity:** Each TLI instance generates an Ed25519 keypair on first run (`backend/node_identity.py`).
The public key hash becomes the node's persistent `node_id`. The fingerprint is displayed in the UI.
Identity survives restarts; a new identity is generated only if `data/mesh/node_identity.json` is deleted.

**LAN discovery:** `backend/lan_discovery.py` broadcasts UDP beacons on startup and listens for peers.
Discovered peers are added to the mesh directory. No central server, no DNS, no registration — purely
peer-to-peer UDP on the local subnet.

**Mesh directory:** `data/mesh/mesh_directory.json` persists known peers. Each entry includes node ID,
name, IP:port, role, last-seen timestamp, and capabilities (AI, vault, etc.).

**Heartbeat and presence:** Nodes send HTTP heartbeats to known peers on a background loop. Nodes not
seen in 90 seconds are marked offline. SSE (`/mesh/presence/stream`) pushes presence updates to the
frontend in real time.

**File transfers:** The mesh supports direct node-to-node file transfers. Files are staged in
`data/mesh/transfers/` before delivery. Progress is tracked and surfaced in the UI.

**AI routing across mesh:** If the local AI is offline or a query would benefit from a more powerful
model on another node, the frontend's AI panel can query peer nodes via `/tli/ai/chat`. Node capabilities
(model, tier, health) are advertised via `/tli/capabilities`.

**Node agent:** `backend/routers/node_routes.py` provides a task execution layer — nodes can receive
task requests from peers, execute them, and return results.

**Roles:** Nodes can be designated as `worker`, `coordinator`, or `satellite`. Role affects how the
mesh routes tasks and what responsibilities the node takes on.

---

### 4.5 Automations

**What it does:** A general-purpose automation engine that can execute actions in response to triggers,
schedules, or AI-proposed rules. Separate from but interoperable with the Home Power module.

**Action types supported:**
- Device control (Shelly on/off/toggle, scene activation)
- File operations (move, organize, rename batches)
- System commands (via tool runner)
- Notifications (in-UI alerts)
- Chained actions (one automation triggers another)

**Trigger types:**
- Manual (button in UI)
- Scheduled (time-based, cron-style)
- Event-based (game started, file detected, mesh event)

**Receipt system:** Every automation execution produces a structured receipt appended to
`data/actions_receipts.jsonl`. Receipts include: automation ID, trigger type, timestamp,
per-step results, and overall success/failure. This log is queryable from the UI.

**AI-proposed rules:** The AI can draft automation rules from plain-English descriptions
(e.g. "every day at 11pm, turn off all lights"). Rules are shown to the user for review before saving.

---

### 4.6 Phone Companion

**What it does:** A mobile-optimized UI for TLI, automatically served to phones and tablets. Users
access the same URL (`http://<host-ip>:8000`) from their phone browser — the backend detects the
mobile User-Agent and serves `frontend/companion.html` instead of the desktop UI.

**PWA support:**
- `frontend/manifest.json` enables "Add to Home Screen" on iOS/Android
- `frontend/service-worker.js` enables offline caching of the companion shell
- `frontend/sw-init.js` registers the service worker on load
- `frontend/tli-icon.svg` provides the home screen icon

**Companion features:**
- Condensed device controls panel
- AI chat access
- Mesh node overview
- Quick-action shortcuts
- Session-aware (shares vault session with desktop)

**Desktop override:** Users can force the full desktop UI on a phone by appending `?desktop=1` to
the URL. This is useful for tablets or when the companion shell is insufficient.

---

### 4.7 Browser Extension

**What it does:** A Chrome/Edge extension (`tli-vault-extension/`) that integrates the TLI vault
directly into the browser. On pages with login forms, TLI injects a green lock icon next to the
password field. Clicking it opens a fill overlay backed by the vault.

**Architecture:**
- `manifest.json` — Manifest V3 (Chrome's current standard)
- `content.js` — runs on every page, scans for password fields, injects icons
- `background.js` — service worker for extension lifecycle
- `popup.html/js` — browser toolbar popup (vault status, quick access)

**Security design:**
- Extension communicates with the TLI backend running on localhost only
- Vault must be unlocked in TLI before fill is available
- No credentials are stored in the extension itself
- Extension passes the vault session token to the backend to retrieve entries

**Visibility guard (`_isVisible()`):** The extension originally injected icons on all `input[type="password"]`
elements including hidden ones (e.g. Google's account management flows use hidden password fields in
DOM before the step is active). This caused ghost icons on non-login pages.

Fixed by adding a strict visibility check: `_isVisible()` walks the DOM tree checking `getComputedStyle`
for `display:none`, `visibility:hidden`, and `opacity:0`, and also checks element dimensions
(< 40px wide or < 12px tall = hidden) and viewport bounds (off-screen = hidden).
Applied in both `setupForms()` (skip injection) and `updateIconPos()` (hide icon when field disappears).

**Platform support:** Chrome and Edge (Chromium-based). Firefox support requires MV2 manifest changes
(not yet implemented).

---

### 4.7b Live System Feed (v1.2)

**What it does:** A real-time event bus that surfaces internal TLI activity as a user-visible feed.

**Architecture:**
- `backend/event_bus.py` — a singleton `deque` of the last 50 events, with per-subscriber `asyncio.Queue` for SSE delivery
- `emit_event(category, level, title, body, node, actions)` — completely synchronous, swallows all exceptions, safe to call from any router or thread
- `/api/events/stream` — SSE endpoint that replays last 20 events on connect, then streams live
- Uses the same `loop.call_soon_threadsafe()` + `asyncio.Queue` pattern as the mesh presence stream

**Event sources:**
- AI manager: model healthy, startup timeout
- AI routes: routing decision (local vs mesh, reason)
- Games router: game detected/cleared (debounced — only fires on name change)
- Mesh routes: peer joined the mesh

**Frontend:**
- `frontend/js/live-feed.js` — `EventSource` with 5s reconnect; renders `.lf-event` cards into `#nd-feed` on the Dashboard
- Notification bell in header with unread badge; badge clears when Dashboard becomes visible (MutationObserver)
- Category → color mapping: ai=accent-green, game=green, mesh=blue, device=purple, automation=amber

**Safety guarantee:** `emit_event` is fully safe to call anywhere — no try/except required at call sites.
Failure modes (event bus not initialized, loop not set, subscriber queue full) are all swallowed internally.

---

### 4.8 AI File Manager

**What it does:** AI-assisted file organization. The user points TLI at a directory; TLI scans and
categorizes the contents; the AI proposes organization rules; the user approves or edits; TLI executes.

**Capabilities:**
- Directory scan with metadata (size, type, last modified, duplicates)
- AI-generated organization rules (group by type, date, project, keyword)
- Bulk rename with prefix patterns and numbering
- Move/copy with rollback (files go to system trash via `send2trash`, not hard-deleted)
- Interactive diff view — proposed changes shown before execution
- Rule save/replay (save a ruleset and apply it to other directories)

**Disk visualizer:** `backend/routers/visualizer.py` implements a treemap generator. Given a root path
and max depth, it produces a nested JSON structure consumable by the frontend's visual treemap. Useful
for identifying what's consuming disk space. Exposed at `/visualizer/treemap` and aliased at
`/scan_directory` for legacy compatibility.

**Path intelligence (v1.2):** `GET /visualizer/paths` returns the real home directory and standard
user folders for the host OS, resolved via `Path.home()`. Returns only paths that actually exist on
disk. Also detects installed cloud drives (OneDrive, iCloud, Dropbox, Google Drive) across all three
platforms. The frontend uses this to pre-populate path inputs and datalist suggestions without the user
needing to know their own filesystem layout. The `~` literal placeholder has been replaced everywhere
with real resolved paths.

**Safety:** File operations use `send2trash` for reversible deletes. Operations produce a receipt.
The AI proposes, the user confirms — no file is moved or renamed without explicit user approval.

---

### 4.9 LAN Chat

**What it does:** Two distinct chat layers — LAN Chat for same-network communication, and Federated
Chat for cross-network communication.

**LAN Chat (mesh layer):**
- Messages routed between nodes via the mesh heartbeat infrastructure
- Stored in `data/mesh/chat/` per conversation
- Real-time delivery via SSE presence stream
- No external server required — everything over local HTTP

**Federated Chat (relay layer):**
- Cross-network chat for nodes that are NOT on the same LAN (e.g. two homes)
- Uses a WebSocket relay server as a rendezvous point
- Pairing model: one node generates a pairing code; the other joins with it
- Messages are end-to-end encrypted before leaving the node
- Default relay is `ws://localhost:9000` — users must configure a relay server URL
- Relay server code is included (`backend/relay_server.py`) for self-hosting
- SSE endpoint (`/federation/events`) pushes incoming messages to the frontend in real time
- Message history: last 100 messages retained in-memory

---

## 5. Security Model

### 5.1 What Is Protected

| Asset               | Protection                                                          |
|---------------------|---------------------------------------------------------------------|
| Vault files         | AES-256-GCM, unique nonce per file, key cleared on lock            |
| Vault key           | Derived from password via PBKDF2-SHA256, never persisted to disk   |
| Vault sessions      | Random token, server-side only, expires on inactivity              |
| Node identity       | Ed25519 keypair in `data/mesh/node_identity.json`                  |
| OS key storage      | DPAPI (Windows) / system keyring (macOS/Linux) via data_protection |
| Conversation history| Encrypted at rest in `data/conversations.json`                     |
| AI memory           | Encrypted per-user in `data/memory/`                               |
| License secret      | Read from env var `TLI_LICENSE_SECRET` or `data/license_secret.txt`|

### 5.2 HTTP Security Headers

Applied to every response via FastAPI middleware:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY (SAMEORIGIN for /apps/* only)
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  connect-src 'self';
  font-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self'
```

`script-src 'self'` with no `'unsafe-inline'` — all event handlers are wired in `app.js`, not inline
HTML attributes. This is a meaningful XSS mitigation.

### 5.3 CORS Configuration

```python
allow_origins=["*"]
allow_credentials=False
allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"]
allow_headers=["Content-Type"]
```

Wildcard `allow_origins` is intentional — TLI is accessed by any device on the LAN and the IP
varies. `allow_credentials=False` is the correct pairing with a wildcard origin
(credentials=True + wildcard is a CSRF vector). Session tokens are passed in headers, not cookies,
which avoids the CSRF vector for the sensitive vault operations.

### 5.4 What Was Fixed (Beta Hardening)

These issues were identified and resolved before the v1.0-beta public release:

1. **Debug route information disclosure:** `/debug/whereami` exposed the process working directory,
   `__file__` path, sys.path entries, and loaded module file paths. `/debug/routes` exposed the
   complete API surface. Both endpoints stripped. Only `/debug/health → {"ok": true}` remains.

2. **Hardcoded license secret:** Source contained `"tli-dev-secret-change-before-ship-2024"` as a
   fallback. Removed. License secret now requires `TLI_LICENSE_SECRET` env var or
   `data/license_secret.txt`. Moot in BETA_MODE but correct for future production builds.

3. **Stale hub URL (registerable domain):** Default hub URL was `https://hub.thelegatointelligence.com`
   — an old domain name that was no longer controlled and could be registered by anyone. Changed to
   empty string with a comment: "Hub not yet live — user must configure manually."

4. **Browser extension ghost icons:** Extension injected vault icons on hidden password fields in
   multi-step SPA flows (Google account management, checkout wizards). Fixed with `_isVisible()`
   helper that checks computed styles and dimensions before injection, and hides existing icons
   when fields become invisible.

5. **macOS launcher:** `start_tli.sh` opened in TextEdit on macOS because Finder doesn't execute
   `.sh` files by default. Added `TLI_Start.command` (macOS double-click → Terminal.app execution)
   and updated `build_dist.py` to set Unix execute permissions (`0o755 << 16`) on `.sh` and
   `.command` files inside the zip.

6. **Bundled AI runtime excluded from dist:** `build_dist.py` was skipping `backend/ai/runtime/`
   entirely — bundled AI never worked for any end user. Fixed by removing `"runtime"` from
   `SKIP_DIR_NAMES` and adding a path-override rule that bypasses the `.exe`/`.dll` extension block
   for files in that directory while still excluding dev-only bench tools via `SKIP_FILENAMES`.

7. **Python 3.9 crash on macOS:** `tli_state.py` used `TypeAlias` (Python 3.10+ only), crashing
   on macOS system Python 3.9. Fixed with a `try/except ImportError` fallback.

8. **"Switch failed" with no explanation:** When the runtime binary was absent, `switch_model()`
   returned a generic error. Now returns a specific message directing the user to LM Studio.

*The following issues were identified during v1.2 real-world testing on macOS and in multi-node mesh deployments:*

9. **Recent Chats leaking across mesh nodes:** When a mesh peer routed its AI requests to a host node, those conversations were saved to the host's `conversations.json` with `user_id = "bundled-ai"` — the same value used for the host's own conversations. `list_conversations()` had no filtering, so all peer-originated chats appeared in the host's Recent Chats panel. Fixed in v1.2 by detecting non-localhost client IPs in the `/api/ai/chat/stream` endpoint, tagging those conversations with `mesh_source_ip`, and excluding them from the listing.

10. **AI health check too strict under load:** `health_timeout_s = 2` caused `is_healthy()` to return `False` while llama-server was busy processing a request — the `/v1/models` endpoint responds slowly under concurrent inference load. This triggered incorrect fallback to LM Studio even when the bundled model was running and healthy. Fixed by increasing `health_timeout_s` to 5 seconds.

11. **No Metal GPU acceleration on Apple Silicon:** llama-server was launched without `--n-gpu-layers`, forcing all inference onto the CPU even on M1/M2/M3 Macs. CPU-only inference on the 3B model produces ~1-3 tokens/sec. Fixed by detecting Apple Silicon at runtime (`uname -m == arm64`) and passing `--n-gpu-layers 99`, offloading all layers to Metal. Expected result: 15-40 tokens/sec on Apple Silicon.

### 5.5 Known Limitations (Accepted for Beta)

- **HTTP only by default:** TLS is opt-in. LAN traffic between browser and TLI is unencrypted unless
  `TLI_ENABLE_TLS=1` is set. Acceptable on a trusted home LAN; not acceptable for internet exposure.
- **No authentication:** TLI uses a PIN (configurable) and vault password, but has no formal
  authentication layer. Any device on the LAN can reach the backend. Suitable for trusted home
  networks; would need hardening for shared/office environments.
- **Peer mesh is unauthenticated:** Mesh peers are discovered and trusted automatically. There is no
  mutual authentication between nodes. A device on the LAN can pose as a TLI node.
- **Federation relay defaults to localhost:** The federated chat relay must be user-configured for
  cross-network use. The bundled relay server is available for self-hosting.
- **CORS wildcard:** Opens cross-origin read access from any browser tab on the LAN. Not a practical
  risk on a trusted home network, but worth knowing for hardened deployments.
- **Gatekeeper (macOS):** Downloaded zip files are quarantined. First run of `TLI_Start.command`
  requires right-click → Open to bypass Gatekeeper. The curl installer (`install_mac.sh`) bypasses
  this automatically. Standard behavior for unsigned macOS apps.
- **Foreground app detection (Linux):** `osascript` is macOS-only. On Linux, the games panel uses
  the process-scan path only — foreground window detection returns empty. Game process scanning via
  psutil works correctly on Linux.
- **Mac bundled AI runtime:** The Windows zip ships with the runtime binary; on Mac/Linux it is
  auto-downloaded from llama.cpp GitHub releases on first run. Requires an internet connection
  for that one-time step.

---

## 6. Distribution and Release Infrastructure

### 6.1 What Ships

The distribution zip (`TLI_Beta_V1.2.0.zip`) is built by `build_dist.py`. It contains:
- `backend/` — FastAPI backend, all routers, AI subsystem, requirements.txt
- `backend/ai/runtime/` — Windows: `llama_server.exe` + all ggml DLLs. Mac/Linux: empty at ship time; auto-downloaded on first run by the launcher
- `frontend/` — index.html, app.js, style.css, companion.html, PWA assets
- `tli-vault-extension/` — Chrome/Edge extension (load unpacked)
- `TLI_Start.bat` — Windows double-click launcher
- `TLI_Start.command` — macOS double-click launcher (Terminal.app); sets `0o755` exec bit in zip
- `TLI_Start.sh` — Linux / macOS terminal launcher
- `Uninstall_TLI.bat` / `Uninstall_TLI.command` / `Uninstall_TLI.sh` — per-platform uninstall scripts

The zip does **not** contain: user data, sessions, vault files, AI models, model configs, device lists,
the `.venv`, debug logs, or any developer-only files. The packager has explicit exclusion rules to
prevent accidental data leakage in distribution builds.

### 6.2 Launchers

| File              | Platform | How to Run                                      |
|-------------------|----------|-------------------------------------------------|
| TLI_Start.bat     | Windows  | Double-click in Explorer                        |
| TLI_Start.command | macOS    | Double-click (right-click → Open on first run)  |
| TLI_Start.sh      | Linux    | `bash TLI_Start.sh` or `./TLI_Start.sh`        |

All launchers:
1. Check for Python 3.x (auto-install attempt via Homebrew on macOS, apt/dnf/pacman/zypper on Linux)
2. Create a virtualenv in `backend/.venv/` if not present
3. Install Python dependencies from `backend/requirements.txt`
4. **Mac/Linux only:** Check for `backend/ai/runtime/llama-server` — if missing, prompt to download the correct llama.cpp binary from GitHub releases (detects arm64 vs x86_64)
5. Free port 8000 if occupied by a previous instance
6. Start the FastAPI backend
7. Open `http://localhost:8000` in the default browser after a 2-second delay

### 6.3 Auto-Update

On startup, TLI checks `https://thelanintelligence.com/latest.json` (served from Cloudflare Pages).
The check runs 5 seconds after launch in a background thread.

`latest.json` format:
```json
{
  "version":      "1.2.0-beta",
  "released":     "2026-04-14",
  "notes":        "v1.2 — Live System Feed, smarter AI routing, storage intelligence.",
  "download_url": "https://github.com/TheLANIntelligence/TLI/releases/download/v1.0-beta/TLI_Beta_V1.2.0.zip",
  "sha256":       "49688938ef8e28292db139dd4cd8939a2243c992cbd45b5bc83640c4aebd0f4b",
  "frontend_only": false
}
```

When an update is available:
- `frontend_only: true` — only `frontend/` files are swapped without a full restart
- `frontend_only: false` — full update: zip is downloaded, SHA256 verified, extracted over current installation, backend restarts
- The SHA256 is the hash of the zip file itself (matches what `build_dist.py` outputs and `auto_update.py` verifies)

### 6.4 Public Infrastructure

| Asset                          | Host                                          |
|--------------------------------|-----------------------------------------------|
| Landing page + latest.json     | thelanintelligence.com (Cloudflare Pages)     |
| Release zips                   | GitHub Releases (TheLANIntelligence/TLI)      |
| Beta waitlist                  | Formspree (ID: xlgarvnq)                      |
| Support / issue email          | thelanintelligence@gmail.com                  |
| Domain registrar               | Cloudflare Registrar                          |

---

## 7. AI Subsystem Detail

The bundled AI is the most architecturally interesting part of TLI. It manages the full lifecycle of
a local LLM without requiring any user knowledge of model management.

**Runtime:** On Windows, TLI ships the `llama-server` binary and all required DLLs in `backend/ai/runtime/`.
On macOS and Linux, the launcher auto-downloads the correct pre-built binary from the official llama.cpp
GitHub releases on first run — detecting the platform architecture (`arm64` or `x86_64`) automatically.
This is the llama.cpp inference server — an OpenAI-compatible HTTP API endpoint backed by CPU/GPU inference.

**Model management flow:**
1. On first launch, the AI manager reads `active_model.json` (or defaults to "standard")
2. If the selected model file isn't present in `backend/ai/models/`, a download is triggered
3. Download progress is streamed to the UI via SSE
4. After download, the llama-server process is started as a subprocess
5. TLI polls the server's `/health` endpoint until it responds
6. The model is now available for chat

**Model switching:**
- User selects a new model in the AI settings panel
- TLI stops the running llama-server, updates `active_model.json`, restarts with the new model
- No backend restart required — the swap is managed entirely by `BundledAIManager`

**Windows Job Object:** On Windows, TLI uses a Win32 Job Object to ensure the llama-server process
is killed when the TLI backend exits — even if TLI crashes or is force-killed from Task Manager.
This prevents orphaned processes holding GPU/RAM after TLI closes.

**Platform-aware launch flags (v1.2):** `BundledAIManager.start()` now selects optimal flags per platform before spawning llama-server:

| Platform | GPU layers (`--n-gpu-layers`) | Thread strategy |
|---|---|---|
| Windows | 0 (CUDA support is a future addition) | `cpu_count - 2` on high-core machines |
| macOS — Apple Silicon (arm64) | 99 — all layers offloaded to Metal GPU | `cpu_count - 1` |
| macOS — Intel (x86_64) | 0 — CPU only | `cpu_count - 1` |
| Linux | 0 | `cpu_count - 2` on high-core machines |

`_gpu_layers_for_platform()` detects Apple Silicon via `uname -m` at runtime. `_optimal_threads()` reserves 1-2 cores on machines with more than 4 cores to avoid starving the OS scheduler — using all available cores for inference often reduces throughput due to memory bandwidth contention.

**Health check robustness (v1.2):** `health_timeout_s` increased from 2 → 5 seconds. On macOS under load (during inference), the llama-server `/v1/models` endpoint can take several seconds to respond. The previous 2s timeout caused intermittent false-negative health checks, making TLI incorrectly fall back to LM Studio even while the bundled model was running.

**Startup timeout (v1.2):** `startup_timeout_s` increased from 30 → 120 seconds. Cold-start model loading on macOS (particularly for the first run where the model is being loaded into memory) can exceed 30 seconds on machines without SSD caching or with slower hardware.

**Vision capability:** The "Vision" preset (Qwen2.5-VL 3B) requires two files: the base model
and a multimodal projector (`mmproj-*.gguf`). Both are downloaded and passed to llama-server. When
active, users can attach images to chat messages for visual analysis.

**Diagnostics:** `backend/ai/diagnostics.py` provides model health checks and benchmarking. Exposes
token generation speed, context window usage, and model metadata through the AI status endpoints.

---

## 8. Code Quality Observations

**Strengths:**
- Consistent modular router pattern — each feature area is isolated in its own file
- `tli_state.py` as a clean shared-state contract prevents circular imports
- Path traversal protection in vault, file manager, and visualizer
- Atomic file writes (write to `.tmp`, then `os.replace()`) throughout data persistence layer
- Structured logging via `log_debug()` to `data/debug_log.jsonl` — every significant event is
  captured with a component tag, level, and extra fields
- Frontend has no CDN dependencies — no external scripts, no supply chain risk
- BETA_MODE as a single flag cleanly separates licensing from feature code

**Technical debt / known rough edges:**
- `backend/routers/chat_routes.py` is marked for deprecation — some endpoints need migration to
  `ai/ai_routes.py` before the legacy `/chat` path can be removed
- CORS is wildcard — intentional for LAN, but would need tightening for any internet-exposed deployment
- Session management is in-memory — sessions are lost on backend restart unless
  `load_persisted_sessions()` successfully re-hydrates them from disk
- No rate limiting on any endpoint — acceptable for single-user LAN, not for internet exposure
- `tools` and `modules` directories are excluded from distribution — content there needs review
  before including in a future release

---

## 9. Open Questions / Future Development

**Shipped in v1.2:**
- Live System Feed — real-time event bus surfacing AI decisions, game detection, mesh joins
- Smart AI routing — CPU/RAM-aware mesh routing with user-selectable policy (Smart/Local/Mesh)
- AI Source modal redesign — cleaner 3-option layout replacing the legacy 5-option modal
- Storage intelligence — `/visualizer/paths` auto-resolves real filesystem paths on all OSes; cloud drive detection
- Conversation isolation — mesh-proxied chats no longer appear in host node's Recent Chats
- Apple Silicon Metal GPU — `--n-gpu-layers 99` passed on arm64 Macs; ~10-20x inference speedup vs CPU-only
- AI health check hardening — `health_timeout_s` raised to 5s; false LM Studio fallbacks eliminated
- macOS startup timeout — raised to 120s for cold-start model loading on Mac hardware
- Optimal thread selection — `_optimal_threads()` reserves 1-2 cores to reduce scheduler starvation

**Near-term (v1.3 candidates):**
- Community hub server launch (hub_routes.py infrastructure is ready, server is not)
- Federated relay hosted service (so users don't need to self-host)
- macOS Gatekeeper code signing (eliminates right-click → Open friction; curl installer is the current workaround)
- Firefox extension (requires MV2 manifest variant)
- HTTPS by default (requires either self-signed UX improvement or code-signed cert)
- Ship Mac/Linux runtime binary bundled in the zip (eliminates one-time internet requirement for AI)
- Live Feed: emit events from automations and device state changes (Phase 2)

**Medium-term:**
- Multi-user support (multiple PINs / vault passwords for shared households)
- Mobile companion enhancements (more features ported from desktop UI)
- Additional smart home drivers (Matter/Thread, Zigbee via hub bridges)
- Windows EXE packaging (PyInstaller onefile — spec file exists, not yet in distribution)
- Plugin/module system (load custom tools from the hub without manual file installation)

**Architecture considerations:**
- The `ambient.py` background loop currently does health monitoring — it could be extended to a
  full event bus for inter-module communication
- Node agent task system (`node_routes.py`) has the foundation for distributed task execution across
  the mesh — not yet exposed in the UI
- The intent engine is nascent — a mature version could route all user inputs to the right subsystem
  automatically without manual UI navigation

---

## 10. Summary for External Audiences

**For investors and partners:**

TLI is a genuine attempt to solve a real problem: the home network is a collection of devices,
accounts, credentials, files, and machines that have never had a coherent management layer. Every
other solution either requires a cloud account, is limited to one vendor's ecosystem, or demands
technical expertise. TLI is local-first, vendor-agnostic, and designed to feel like a premium product
from day one.

The v1.0-beta represents a complete, working system with nine distinct capability areas, a working
security model, and a distribution pipeline. It is not a prototype or a demo — it runs in real
environments today.

The technology choices (Python + vanilla JS, no framework, no CDN) are deliberate optimizations for
reliability, portability, and zero supply-chain exposure. The codebase is approximately 46,000 lines
of focused, modular code.

Revenue model is not yet active. The beta period is for building the user base and refining the
product. Pricing and licensing infrastructure exist in code and can be activated with a single flag
change.

**For security reviewers:**

The most sensitive assets are the vault (AES-256-GCM, PBKDF2-derived key, cleared on lock),
conversation history (encrypted at rest), and node identity (Ed25519 keypair). All three are
protected at rest. In-transit protection is optional (TLS opt-in). The threat model assumes a
trusted home LAN — this is stated explicitly and is the appropriate scope for the current release.

The beta hardening pass identified and resolved five concrete issues: two information-disclosure
routes, one registerable-domain default URL, one browser extension ghost-icon injection bug, and
one launcher UX issue on macOS. No critical vulnerabilities (RCE, auth bypass, data exfiltration)
were identified in the hardening review.

**For troubleshooting:**

If TLI doesn't start: check that Python 3.10+ is installed, `backend/.venv/` was created, and
port 8000 is not occupied by another process. The launcher handles all of this automatically, but
manual verification uses `python --version`, `ls backend/.venv`, and `netstat -an | grep 8000`.

If the AI doesn't respond: check `http://localhost:8080/health` to verify the llama-server is
running. If it's not, check `data/debug_log.jsonl` for `[ai]` entries. Common causes: model file
missing from `backend/ai/models/`, insufficient RAM for selected model tier, or antivirus blocking
the llama-server binary.

If the vault is inaccessible: vault sessions don't survive a hard crash. Navigate to the vault panel
and re-enter the vault password. If the password is lost, the vault cannot be recovered — by design.

---

*Document updated: April 2026. Reflects TheLANIntelligence v1.1.1-beta.*
*Internal contact: thelanintelligence@gmail.com*
