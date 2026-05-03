# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Backend setup (run once)
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt

# Run backend dev server
python main.py                  # serves http://localhost:8000

# Run all tests
cd backend && pytest tests/

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

**`frontend/index.html`** (162 KB) is the single HTML shell. All UI panels live inside it as hidden `<div>` sections activated by JavaScript.

**`frontend/app.js`** (205 KB) bootstraps the SPA: detects server OS, initializes panels, handles routing, manages global state via `CustomEvent` dispatch.

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
pwsh build_windows.ps1          # Windows
```

The build excludes `data/`, `__pycache__`, model `.gguf` files, and test suites. Frontend is served as FastAPI static files — no separate build step.

### SSE Streaming Protocol

Chat responses stream via Server-Sent Events. The contract is documented in `docs/SSE_SCHEMA.md`. The frontend (`tli-chat.js`) and backend (`ai/ai_routes.py`) must stay in sync on event field names.

### Mesh / Federation

Peer nodes advertise capabilities via `/agent/ping` (`node_routes.py`). The AI router transparently forwards requests to capable peers when the local model is unavailable. Peer state is held in `tli_state.py` mesh fields and refreshed by `mesh_routes.py`.
