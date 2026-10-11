# AGENTS.md

Canonical project guidance for any coding agent working in this repo
(Claude Code, OpenAI Codex, Cursor, Aider, etc.). `CLAUDE.md` is a thin
pointer to this file so both tools share one source of truth — edit
this file, not the pointer.

## Development Commands

```bash
# Backend setup (run once)
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
pip install -r requirements-test.txt

# Run backend dev server
python main.py                  # serves http://localhost:8000

# Run all tests
pytest tests/                  # from backend/

# Run a single test
pytest tests/test_vault_routes.py::test_vault_create
pytest -m vault_lifecycle       # isolated vault lifecycle tests
```

## Architecture

**Stack:** FastAPI + Uvicorn backend, vanilla JS SPA frontend. No external DB — all state persists as JSON files under `data/`.

### Backend

**`backend/tli_state.py`** is the shared singleton for the entire backend. It owns all path constants (`DATA_DIR`, `VAULT_DIR`, `FRONTEND_DIR`), JSON persistence helpers, node identity, and the active model/system-profile config. Any new router that needs cross-cutting state imports from here.

**`backend/main.py`** mounts all 30+ routers at startup. Adding a feature means creating a new file under `backend/routers/` and registering it in `main.py` — no other wiring required.

**`backend/routers/`** — one file per domain. Key ones:
- `ai_routes.py` / `backend/ai/ai_routes.py` — SSE streaming chat, model switching, mesh AI routing
- `vault_routes.py` — AES-256 encrypt/decrypt, session management
- `mesh_routes.py` — LAN peer discovery, multi-node topology
- `device_routes.py` / `home_power.py` / `actions_engine.py` — smart home control
- `federation_routes.py` — federated AI chat across peer nodes

**`backend/ai/`** — AI subsystem. `ai_manager.py` controls the bundled llama.cpp server lifecycle; `intent_engine.py` routes natural-language commands to device/system actions; `prompts/system_default.txt` is the production system prompt.

**`backend/drivers/`** — pluggable smart-home device drivers (Shelly, Hue, Kasa, Govee, etc.). All extend `base.py`.

**`backend/providers/`** — pluggable AI backends. `lmstudio.py` wraps the LM Studio HTTP API; `base.py` defines the interface for adding new providers.

**`backend/tests/conftest.py`** — session-scoped `TestClient` fixture with auth override. Tests that mutate state are marked `vault_lifecycle` and run in isolation.

### Frontend

**`frontend/index.html`** is the single HTML shell. All UI panels live inside it as hidden `<div>` sections activated by JavaScript.

**`frontend/app.js`** bootstraps the SPA: detects server OS, initializes panels, handles routing, manages global state via `CustomEvent` dispatch.

**`frontend/js/`** — one module per feature panel (e.g., `tli-chat.js`, `vault.js`, `home-auto.js`, `mesh.js`). Modules communicate via `window.dispatchEvent(new CustomEvent(...))` — there is no shared state object.

**`frontend/assets/d3.v7.min.js`** — bundled D3 used only by the storage visualizer (`visualizer.js`).

### State & Configuration

All runtime state lives under `data/` (excluded from builds):
- `tli_model_config.json` — active AI model preset
- `tli_system_profile.json` — node name, role, mesh config
- `devices.json` — smart device registry
- `conversations.json` — chat history
- `vault/` — AES-256 encrypted blobs
- `mesh/` — LAN topology snapshots
- `node_identity.json` — cryptographic node fingerprint

Version is defined in `backend/tli_state.py` as `TLI_VERSION` and read by `build_dist.py`.

### Build & Distribution

```bash
# Zip-based distribution (all platforms)
python build_dist.py            # produces TLI_dist_<version>.zip

# PyInstaller standalone binary
bash build_mac.sh               # macOS → TLI_Installer/dist/
bash build_linux.sh             # Linux
pwsh build.ps1                  # Windows

# Lightweight inference Node (separate state; no host UI)
python backend/tli_node.py --help
python build_node.py            # allowlisted Node source archive, no models/state
```

The build excludes `data/`, `__pycache__`, model `.gguf` files, and test suites. Frontend is served as FastAPI static files — no separate build step.

### SSE Streaming Protocol

Chat responses stream via Server-Sent Events. The contract is documented in `docs/SSE_SCHEMA.md`. The frontend (`tli-chat.js`) and backend (`ai/ai_routes.py`) must stay in sync on event field names.

### Mesh / Federation

Discovery and `/agent/ping` are hints, never inference authority. Explicit LAN
inference uses reviewed identities and HTTPS certificate pins in `peer_trust.py`,
the separate `inference` grant, and a user-selected resource. Chat never silently
falls back to another LAN peer. The primary host prepares and retains conversation
context; the worker executes bounded text inference only.

`peer_inference_routes.py` supplies the signed catalog/stream endpoints shared by
the full host and lightweight Node. `tli_node.py` is a separate CLI/process with an
explicit dedicated state directory and LM Studio loopback resources only. It must
not import `main`, browser routers, Vault, or the bundled model manager. Node cards
advertise exactly `['inference_v1']`; full-host card compatibility is preserved.
Keep Node package additions explicit in the `build_node.py` allowlist and test the
extracted archive. Setup instructions are in `node/README.md`.

### Everyday workflows

Background Windows commands must use `process_utils.hidden_process_kwargs()`
with subprocess calls (or preserve equivalent existing `CREATE_NO_WINDOW`
flags). Capturing output alone still permits console popups under windowless
hosts. Keep explicitly requested GUI apps visible; hide their shell wrappers.

TLI is a general-purpose AI first. Ask TLI supports ordinary conversation,
questions, writing, learning, planning and coding without a computer problem or
selected device. Connected tools extend that experience. Do not narrow its
identity, default prompt or entry screen to diagnostics or home administration.

`home_conversation.py` handles whole-message named smart-device requests through
authenticated in-process services. Do not restore unauthenticated loopback HTTP
or substring-triggered Shelly actions in chat. Command acknowledgement and a
subsequent verified state are distinct outcomes.

`builder/web_apps.py` owns account-scoped small web apps and immutable revisions;
`builder/lan_compute.py` adapts an explicitly reviewed LAN model without fallback.
The existing repository editor remains separate. Generated code runs only in an
opaque browser preview, never in Python or the primary page. Browser smoke checks
are advisory. Keep owner, revision and source-sharing checks at API boundaries.
The user workflows are documented in `docs/TLI_EVERYDAY_EXPERIENCE.md`.
