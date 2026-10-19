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

**Stack:** FastAPI + Uvicorn backend, vanilla JS SPA frontend. No external DB — application state persists as JSON files under `data/`. Free Space also uses disposable SQLite scan indexes under `data/storage_indexes/`; these are bounded, session-owned derived evidence, not durable application state.

### Backend

**`backend/tli_state.py`** is the shared singleton for the entire backend. It owns all path constants (`DATA_DIR`, `VAULT_DIR`, `FRONTEND_DIR`), JSON persistence helpers, node identity, and the active model/system-profile config. Any new router that needs cross-cutting state imports from here.

**`backend/main.py`** mounts all 30+ routers at startup. Adding a feature means creating a new file under `backend/routers/` and registering it in `main.py` — no other wiring required.

**`backend/routers/`** — one file per domain. Key ones:
- `ai_routes.py` / `backend/ai/ai_routes.py` — SSE streaming chat, model switching, mesh AI routing
- `vault_routes.py` — AES-256 encrypt/decrypt, session management
- `mesh_routes.py` — LAN peer discovery, multi-node topology
- `device_routes.py` / `home_power.py` / `actions_engine.py` — smart home control
- `federation_routes.py` — retired room-relay boundary, private retained history/status and explicit cleanup

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
# Reviewed ZIP packager (all platforms; does not compile a native backend)
python build_dist.py            # produces TLI_dist_<version>.zip

# Windows desktop launcher only; still uses the prepared Python backend
powershell -File build_launcher.ps1

# Lightweight inference Node (separate state; no host UI)
python backend/tli_node.py --help
python build_node.py            # allowlisted Node source archive, no models/state
```

`build_dist.py` excludes private runtime state, model weights and test suites.
It can include a separately prepared launcher and compatible inference runtime;
a fresh source checkout does not contain those binaries. Review its `--dry-run`
file list before distributing a package. The frontend is served directly by
FastAPI and has no separate build step. See [README.md](README.md) for source setup.

The legacy native backend builders are **not validated release paths**.
`build_mac.sh` and `build_linux.sh` exit with an explanatory error before any
build, download, file removal or service action. Use `build_dist.py` for a source
ZIP instead. The Windows `build.ps1` script is retained as legacy, unvalidated
packaging tooling; it is not a release-ready alternative to the reviewed ZIP
packager. Building the launcher alone does not validate a native backend package.

### SSE Streaming Protocol

Chat responses stream via Server-Sent Events. The contract is documented in `docs/SSE_SCHEMA.md`. The frontend (`tli-chat.js`) and backend (`ai/ai_routes.py`) must stay in sync on event field names.

### Mesh / Federation

Discovery and `/agent/ping` are hints, never inference authority. Explicit LAN
inference uses reviewed identities and HTTPS certificate pins in `peer_trust.py`,
the separate `inference` grant, and a user-selected resource. Chat never silently
falls back to another LAN peer. The primary host prepares and retains conversation
context; the worker executes bounded text inference only.

The older room-name relay is retired, including autostart and internal connect
entry points. Keep its saved settings intact; retained history is process-memory
only. Private reads and explicit disconnect/stop remain available. Do not restore
that unauthenticated listener as a shortcut for reviewed peer communication.

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

Legacy Tools/Hub host-script execution, the script-file generator and legacy
script deletion are retired. Preserve saved files for private plaintext review
through `script_sources.py`; drafting code does not grant execution authority.
Fixed built-in diagnostics use `run_builtin_tool` with captured browser access
and validated parameters, including when invoked by chat.

`hub_store.py` owns strict Hub stores, exact package paths and serialized changes.
Keep its journal and retained before/after copies: an uncertain transaction blocks
Hub access rather than retrying or resetting data. Automatic recovery and cleanup
are not implemented. `installed_apps.py` serves only registered single-file HTML
through an authenticated opaque-origin response sandbox, including direct visits.
Do not restore the raw `/apps` static mount, `allow-same-origin`, or parent bridge
handlers. Package permissions are declarations, not grants; original files and
browser storage remain intact. See S10 in `docs/TLI_AUDIT.md` for acceptance limits.

TLI is a general-purpose AI first. Ask TLI supports ordinary conversation,
questions, writing, learning, planning and coding without a computer problem or
selected device. Connected tools extend that experience. Do not narrow its
identity, default prompt or entry screen to diagnostics or home administration.

`home_conversation.py` handles whole-message named smart-device requests through
authenticated in-process services. Do not restore unauthenticated loopback HTTP
or substring-triggered Shelly actions in chat. Command acknowledgement and a
subsequent verified state are distinct outcomes. Carry the original browser or
native HTTPS Companion check through services and guarded replies into chat
persistence/streaming. An owner string is not authority; host-start and peer
tokens do not grant this home-control path. Never turn access loss into a private
successful answer or a model fallback. Chat invocation IDs retain outcomes in the
existing short-lived command cache, not durable deduplication across user retries.

Actions Engine, HomePower and Shelly HTTP routes require captured browser
authority. Keep explicit HTTP wrappers separate from reusable device services;
an internal owner string is not a replacement for an authorization check.
Recheck before effects, after lock waits and before disclosure. Retain known
completed/partial outcomes privately when access ends; never replay commands
on unlock. `shelly_store.py` owns strict legacy registry reads and serialized,
checked replacements; preserve unknown compatible fields and fail closed on
damaged data. Do not overwrite browser import records on failed host reads/saves.
Remaining route work is in `docs/TLI_ROUTE_AUTHORITY_INVENTORY.md`. Household UI callbacks must retain
their session epoch and wait for verified access before resuming private reads.

Bluetooth is an optional host transport in `bluetooth_support.py`, with the
experimental `govee_ble` H6125 profile separate from the older `govee` LAN driver.
`bluetooth_profiles.py` owns the code-defined brand/model catalog. Keep discovery
hints separate from compatibility evidence. Enrollment and the browser model
list use that catalog; unknown, ambiguous or mismatched profiles cannot fall
back to another driver. New profiles require checked probe/control/status
methods and physical model acceptance; synthetic second-brand tests prove the
shared dispatch contract only. Preserve existing bindings and do not infer BLE
compatibility from a brand's LAN adapter or Home Assistant integration.
Use one lazy persistent Bleak event loop, bounded single-operation admission and
captured checks through scan/connect/GATT/query/write waits. Importing TLI,
opening a panel and unlocking must not start radio work. Explicit enrollment
confirms the printed model and validates the fixed GATT profile; advertisements
are hints, not authenticated identities. Preserve canonical address bindings in
the existing HomePower store; generic saves cannot introduce or rebind Bluetooth
targets. Only on/off is exposed, with a valid fresh power frame required for
reported state. A completed write without response is sent, never device
acknowledgement or physical verification. Keep uncertain outcomes and access
failures sticky, including unavailable security state, and never retry commands
or fall back to another address. Cleanup still disconnects after denial;
unresolved transport cleanup blocks later radio work in that process. BLE
control requires captured authority, including through chat and manual scenes;
background automation has no implicit Bluetooth grant. Windows 11/Bleak setup,
protocol evidence and physical acceptance limits are in `docs/TLI_BLUETOOTH.md`.

Host file open/reveal/Trash and reviewed organize/rename/undo use captured browser
authority, including the private review-capability route. `file_operations.py`
must retain the check through private reads, locks, recovery reservation and each
filesystem effect. Any captured-check failure, including unavailable security
state, stops further work; retain known completed/partial receipts internally
before denying disclosure. Do not consume a preview on a denied pre-commit
reservation or resume an interrupted review after reservation. Never replay file
actions on unlock. Keep Trash-only behavior, relocated BASE_DIR/DATA_DIR/VAULT_DIR
and containing-folder protection, and link/reparse rejection. The four shallow
Files scan/advice routes also need final/error checks. `/scan_directory` and
`/visualizer/treemap` retain separate Free Space contracts pending review; the
legacy `/visualizer/delete` shortcut remains nonexecuting. Real OS dispatch,
restart/recovery and extracted-package acceptance remain required gates.

License mutations and private license details use captured browser authority;
public `/license/status` exposes only tier/valid/beta/features. Preserve offline
validation and BETA behavior. `license_store.py` rejects damaged state instead of
substituting empty settings; publish cache changes after checked reads or confirmed
commits, and mark uncertain licensing state unavailable. Optional license damage must not
prevent the main app from starting or silently grant non-BETA entitlements.

`browser_control_access` captures both the original credential and the process-local
session revocation epoch. Keep the epoch checks even for PIN-off loopback requests;
an off/on/off cycle must not revive in-flight authority. The six legacy USB/ARP
observation routes retain separate checked services and browser HTTP wrappers.
Check before each probe and after completion/error; a running OS probe may finish
but cannot authorize another probe or disclosure. These observations do not grant
cleanup or storage-mutation authority.

`/search/query` is browser-authorized retrieval to an explicit HTTP(S) destination.
Keep bounded streaming, cooperative elapsed checks, redirects disabled, and a fresh
session with `trust_env=False`; never attach host credentials or echo/log private
queries through upstream errors. The GET query protocol is not access-log redaction.
Search/USB/storage-picker callbacks retain session epochs; recovery enables explicit
reads without replay. Failed retrieval must not automatically submit chat.
`/system/capabilities`, `/api/diagnostics/whoami` and `/debug/selftest` are private
browser reads; capabilities use the strict Shelly store. The remaining System
bootstrap/native-client and host-setting boundaries still need separate review.

The three `/health/llm`/`/health/lmstudio` observations, `/models/available`,
`/setup/autodetect` and LM Studio endpoint test/save routes capture browser
authority. Checked provider observations use `model_probe.py`: bounded JSON,
no redirects or implicit host credentials, and checks through catalog and tiny
chat-readiness probes. Keep checked caches separate from unbounded legacy
observations and do not publish a result after access fails. Setup reads an
existing node identity without creating one. Legacy no-check services used by
dashboard and ordinary model completion are not certified by this repair.
Endpoint saves carry the check through the config lock and replacement; publish
runtime/provider state after a confirmed commit even if disclosure is denied.
An uncertain replacement is not a rollback or permission to retry. Preserve the
saved file and last confirmed runtime for explicit recovery. Frontend model
views clear on lock and resume reads after verified access, never replaying saves.

`/status` is a private browser observation: retain captured authority through
node/model/Vault reads and final/error disclosure. Never recreate node identity
or read/write the device registry from this route. Genuine absent identity is
represented by a null device ID; damaged/dependent state remains unavailable.
Its checked Vault status uses one metadata snapshot without removing expired
unlock state. Optional reader checks do not grant authority to legacy no-check
callers. Browser status callbacks clear on lock, discard stale responses and
wait for verified access; denied or malformed status must not start fallback
reads or become healthy/offline success. Hardware/agent and wider Vault paths
remain separate review obligations.

`/system/probe`, `/system/summary` and `/api/system/disk` have browser HTTP
wrappers around reusable services. Carry captured checks through native calls,
optional-probe failures and final/error disclosure; permission loss must not
become a partial successful fallback or authorize the next probe. Keep checked
summary-cache provenance, detached snapshots and original observation times.
Cleanup of this request's temporary dxdiag file or initialized NVML reference
still runs after denial. No-check internal calls, agent/Mesh telemetry and
broader AI-manager lifecycle require separate review. Hardware UI callbacks
clear on lock and wait for verified access; phone presence secrets do not grant
host hardware access. Never replay advice/configuration work on unlock.

`/agent/health`, `/agent/info` and `/api/mesh/health` are private browser
observations. Keep the checked node read noninitializing and retain authority
through metrics, directory/trust reads, cache locks and final/error disclosure.
Unreadable security state is unavailable, not a peer needing review. Cached
peer reachability retains its original times and never triggers network work.
Bundled AI observation uses only an already imported/initialized manager, one
selected-model stat and bounded local health transport; unavailable/busy remains
unknown. Manager snapshot locks are nonblocking and contain no authority checks
or I/O; check immediately after release before proceeding or disclosure. Do not
call manager get/status or create directories from this path. Withhold cached
readiness when its trust revision differs from the final reviewed projection.
Optional checked helpers do not authorize their legacy no-check consumers.
Public discovery, other Mesh routes and the broader AI lifecycle remain separate
review obligations. Browser cards clear on lock and recover only after verified
access; detached cards cannot act for a later session.

The three node-name/settings POST routes use captured browser authority and
`node_settings.py` through `tli_state.update_node_settings`. Rename only an
existing canonical node; never read or rewrite the legacy device registry or
create identity as a naming fallback. Keep checked partial updates under the
shared node-config lock, preserve compatible fields, and retain recovery evidence
when replacement is uncertain. The uncertainty latch also blocks shared node
read/load/save helpers and the two trust/transfer marker writers; recovery
requires stopped-host review, not an automatic retry. Direct readers and legacy
full-snapshot writers are not newly certified. New names are bounded without
silent truncation. Header, onboarding and
Settings callbacks retain their session and operation epochs; confirmed reads
may resolve an uncertain outcome but must never replay a save. Other Mesh node
writers remain separate work; the three read-only projections are covered below.

GET `/mesh/node`, `/mesh/directory` and `/mesh/status` are captured-browser
observations. Keep their HTTP wrappers separate from reusable services, retain
checks through readers, locks, projections and JSON encoding, and never call
initializing node loaders, self-directory maintenance, port refresh or network
probes from these reads. Missing identity is unavailable. Saved addresses and
timestamps remain saved observations; reads cannot freshen them. Compare cached
connection and final reviewed trust revisions before disclosing readiness.
Messaging availability also requires the final verified trust and messages grant;
an intermediate readiness observation cannot outlive those permissions. The
legacy `/api/lan/peers` service also reads existing identity without initializing
it, including for native clients; this is not a new authorization contract.
Browser identity consumers clear on lock/account changes, reject stale callbacks
and wait for verified access; failed identity cannot bootstrap messaging with a
synthetic `local` ID. Native `/api/lan/peers`, other Mesh mutations and broader
stream/backend contracts remain separate review obligations.

`selection_settings.py` preserves the existing model-preset and performance-profile
JSON stores. Use `read_model_settings`/`save_default_model` and
`read_profile_settings`/`save_profile` for their private HTTP paths. New model
selection retains other presets and compatible fields. Reads and saves publish
only validated/confirmed snapshots; uncertain replacement blocks later settings
access in that process. Existing damaged startup choices fail rather than silently
selecting a default; genuine absence uses immutable defaults without writing.
External repair requires a stopped host and review before restart. Keep captured
checks through locks and persistence and never replay a save on unlock. The
legacy compatibility writers are internal helpers, not authorization grants.

`onboarding_store.py` owns the two first-run markers. Public status returns only
complete/started booleans without creating files. Start/complete retain captured
browser authority through the shared lock, strict reads, exclusive publication
and final/error checks. Preserve existing marker bytes and compatible metadata;
damaged, disappearing or uncertain state must not become fresh setup. Uncertain
publication or failed owned staging cleanup blocks the marker pair in that
process. Stop the host and review retained files before restart; no automatic
reconciliation is implemented. Browser callbacks keep their session/operation
epochs and require an explicit saved-state check before another attempt; unlock
never replays setup writes. Public `/agent/ping` reads only existing identity and
coarse discovery hints: no identity initialization, model-manager import, model
probe or health claim. Null AI hints mean unobserved, including in LAN discovery.
These advertisements are not inference permission. Other bootstrap/native-client
protocols and model lifecycle remain separate work.

`alert_store.py` preserves the existing ambient-alert list and compatible row
metadata. Shared add/dismiss/resolve/dismiss-all helpers edit under one lock;
do not restore permissive empty reads or separate producer load/edit/save cycles.
The three `/status/alerts` routes require captured browser authority through
reads, locks, publication and final/error disclosure. Uncertain publication or
unresolved owned staging cleanup retains evidence and blocks all shared alert
helpers until stopped-host review and restart. There is no automatic recovery.
The compatibility full-save helper cannot make a caller's stale snapshot current.
Dashboard alert damage must remain unavailable; chat context must not imply an
empty alert list. Optional internal snapshots and other dashboard probes are not
new authorization grants. Alert views clear on lock, reject stale callbacks and
old action buttons, and resume only reads after verified access. An unconfirmed
dismissal needs a fresh saved-state read before another deliberate action; never
replay dismissal on unlock. Keep the shared shell/feed operation token and the
dashboard observation gate: a pending or uncertain dismissal cannot be bypassed
through another view, and an old session cannot release a newer operation.
Retiring a feed view still settles its exact owned token as unconfirmed once the
request finishes; this UI coordination never grants backend authority.
Physical monitoring and crash/recovery acceptance
remain separate gates.

Legacy satellite enrollment/list/removal are desktop browser controls. Phone
redemption uses a bounded, expiring invitation tied to its issuing authority and
the process-local session revocation epoch, including PIN off/on/off transitions;
heartbeat and self-removal use only that phone's stored secret over the supported
direct HTTPS transport (localhost exception). These secrets do not grant chat,
household control, native Companion or inference authority. `satellite_store.py`
preserves compatible fields and damaged stores. Never log invitation tokens or
render phone metadata as HTML. Retain phone credentials on transport/store errors;
only explicit credential revocation or confirmed removal may clear them. Keep
session epochs around desktop QR, private license and phone-management callbacks.

The seven saved-conversation GET routes (legacy and bundled list/detail, search
and its capabilities, and conversation settings) use `private_client_authority`.
Retain direct browser transport and original session/epoch checks, or the original
single paired HTTPS Companion credential without browser/proxy/peer headers.
An owner is not authority. Carry sticky checks through history and cursor locks,
file reads, key reads, decryption, projections, JSON encoding and error exits.
Unavailable security remains unavailable, and private responses are no-store.
`load_conversations(check=...)` and optional checked service readers do not grant
authority to legacy internal callers or change the history persistence contract.
Browser history/settings callbacks clear on lock/account changes, reject detached
buttons and old failures, and wait for verified access before private reads.
Only explicit unsupported search capabilities may use the bounded legacy list;
denial, malformed responses and transport failures cannot start fallback reads.
Unlock must not reopen a previous conversation or replay a mutation. The native
library deletes via existing `DELETE /conversations/{id}`; deletion/settings
mutations, Notebook, streams and broader recovery remain separate review work.

`builder/web_apps.py` owns account-scoped small web apps and immutable revisions;
`builder/lan_compute.py` adapts an explicitly reviewed LAN model without fallback.
The existing repository editor remains separate. Generated code runs only in an
opaque browser preview, never in Python or the primary page. Browser smoke checks
are advisory. Keep owner, revision and source-sharing checks at API boundaries.
The user workflows are documented in `docs/TLI_EVERYDAY_EXPERIENCE.md`.

`builder/chat_store.py` owns legacy repository-Builder `chat.json` history. Keep
strict bounded reads and serialized append operations; damaged, unreadable or
previously observed missing history must not become an empty conversation.
Preserve compatible row fields and retained before/after recovery evidence.
Uncertain publication or unowned staging cleanup blocks that history in the
process until stopped-host review; there is no automatic reconciliation or
cross-process writer coordination. Register staging ownership before fallible
descriptor inspection or stream creation. The history preflight must precede
model work. This persistence repair does not certify the broader Builder route
authority or real crash/restart recovery.

Free Space readers remain isolated and read-only. Inventory rows stream over
bounded private pipes to the parent index writer; never grant the scanner write
access to its target. `storage_engines.py` keeps raw NTFS acquisition gated until
controlled live acceptance. Indexed paths are recorded evidence, never cleanup
authority. See `docs/FREE_SPACE_INDEXED_INVENTORY.md` for retention, accounting,
benchmark commands and outstanding native acceptance.
