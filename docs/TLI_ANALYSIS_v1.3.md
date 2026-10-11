# TheLANIntelligence (TLI) — Technical Analysis
## v1.3.0-beta · April 2026

> This document extends TLI_ANALYSIS_v1.0.md. Sections that are unchanged from v1.2 are noted as
> such. Sections that are new or substantially revised are marked **[v1.3]**.

---

## 1. What TLI Is

**TheLANIntelligence (TLI)** is a self-hosted LAN console that runs locally on a Windows, macOS, or Linux
machine on your home or office network. You access it from any browser on the same network. It has no cloud
dependency, no accounts, no telemetry, and no subscription fees.

The core value proposition: **one dashboard for your entire home network** — a local AI assistant, an
encrypted secrets vault, multi-vendor smart home control, an automation engine, file management, inter-machine
mesh networking, cross-network federated chat, a phone-optimized companion shell, and a browser extension
for vault-backed password fill. Starting in v1.3, the dashboard communicates actively — surfacing live system
state, classified events, and actionable recommendations without requiring the user to navigate anywhere.

TLI is approximately **49,000+ lines** of handwritten Python and JavaScript across 110+ files.

---

## 2. Beta Status

TLI v1.3.0-beta is the current release. It carries the beta label for the same reasons as v1.2:
community hub server not yet live, federated relay defaults to localhost, macOS Gatekeeper signing
not yet in place. All features are fully accessible with no license key required (`BETA_MODE = True`).

**v1.3 scope:** This release is a focused addition — three frontend components, one new backend router,
and targeted changes to the event bus. No existing subsystem was rearchitected. No new panels. No new
AI dependencies beyond the existing Qwen stack.

---

## 3. Architecture Overview **[v1.3 updated]**

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (any device on LAN)                                │
│  frontend/index.html + app.js + style.css                   │
│  Vanilla JS — no framework, no build step, no CDN deps      │
│                                                             │
│  v1.3 additions (global, above all panels):                 │
│   event_interpreter.js  — SSE fan-out, event classification │
│   system-state-bar.js   — SystemStateBar + ActionCard +     │
│                           EventPulse + NarratorCard wiring  │
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
│   dashboard_presence  [NEW v1.3]                            │
│                                                             │
│  v1.3 event bus additions (event_bus.py):                   │
│   emit_meta(type, payload) — meta-events to SSE subscribers │
│   register_post_emit_hook(fn) — post-emit classification    │
│                                                             │
│  AI subsystem (backend/ai/):                                │
│   ai_manager.py · ai_routes.py · intent_engine.py          │
│   diagnostics.py                                            │
│                                                             │
│  Core modules:                                              │
│   tli_state.py · vault_security.py · node_identity.py      │
│   license.py · auto_update.py · lan_discovery.py           │
│   ambient.py · data_protection.py                          │
└──────────────────┬──────────────────────────────────────────┘
                   │  subprocess
┌──────────────────▼──────────────────────────────────────────┐
│  llama.cpp server (backend/ai/runtime/)                     │
│  Models: Qwen2.5 1.5B / 3B / 7B / Vision (GGUF)           │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Module Reference

*Sections 4.1–4.9 are unchanged from v1.2. The Live System Feed (4.7b) is extended in v1.3.*

### 4.7b Live System Feed (updated v1.3) **[v1.3]**

**What changed in v1.3:**

The event bus received two additions that preserve full backward compatibility:

**`emit_meta(meta_type, payload)`** — broadcasts a typed payload to all SSE subscribers without
adding it to the event log ring buffer. Meta-events carry a `type` field but no `title`, so
`live-feed.js` (which guards on `if (ev && ev.title)`) silently ignores them. Used exclusively by
`dashboard_presence.py` to push `state_update`, `narrator_update`, and `action_update` payloads.

**`register_post_emit_hook(fn)`** — registers a callable invoked synchronously after every
`emit_event()`. The hook receives the full event dict. Used by `dashboard_presence.on_event()` to
classify events and update the narrator/action queue without modifying `emit_event()` itself. Hooks
are swallowed internally — a failing hook cannot disrupt the event pipeline.

The existing chat SSE protocol (`{type:"delta"}` / `{type:"done"}`) is entirely unaffected — it
runs on a separate endpoint (`/ai/chat/stream`) that has no connection to the event bus.

---

### 4.10 Dashboard Presence Layer **[NEW v1.3]**

**What it does:** Makes the TLI dashboard actively communicate. Instead of requiring the user to
navigate and poll, the dashboard now maintains a live picture of system state, surfaces a contextual
narrator message driven by real events, and presents actionable recommendations that the user can
confirm or dismiss in one click.

**Four components, one coordinated patch:**

| Component | Layer | Purpose |
|---|---|---|
| SystemStateBar | Frontend (global) | 36px persistent strip above every panel — CPU, RAM, primary disk %, device count, last event time |
| NarratorCard | Frontend (Dashboard) | Event-driven message surface; updates when classified events arrive via SSE |
| ActionCard | Frontend (Dashboard) | Single highest-scored pending action; Confirm / Dismiss |
| EventInterpreter | Frontend (global module) | Subscribes to SSE feed, classifies events, fans out to components |

**Backend: `routers/dashboard_presence.py`**

New router mounted at `/dashboard`. Provides five endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/dashboard/state` | `{cpu_pct, ram_pct, disk_pct_by_drive, device_count, last_event_ts}` — from in-memory cache, < 100ms |
| GET | `/dashboard/narrator/current` | `{type, text, timestamp}` where type ∈ status / alert / action_prompt / confirmation |
| GET | `/dashboard/action/current` | Top-scored non-snoozed action or null |
| POST | `/dashboard/action/confirm` | Executes handler, removes action, returns receipt with navigate_to |
| POST | `/dashboard/action/dismiss` | Snoozes action for N minutes (default 60) |

**Background poller:** A daemon thread (`dp-poller`) wakes every 5 seconds, probes hardware via
psutil, and computes band-rounded change detection (CPU: ±10%, RAM: ±5%, disk: ±5%). Only meaningful
band changes trigger SSE broadcasts — the feed is not flooded at idle. The poller starts in
`on_startup` and is joined cleanly in `on_shutdown`.

**Event classification:** `classify_event(event)` is a pure function — no AI, no network, no side
effects. It maps raw event category and level to `{category, severity, narrator_worthy, action_worthy}`.
The same logic runs in both Python (backend) and JavaScript (EventInterpreter), keeping classification
symmetric.

**Narrator generation — template path (implemented):** Given current state + optional trigger event,
returns a templated string. Priority: disk warnings > CPU spike > RAM pressure > event title > summary.
Examples: `"Drive C:\ is critically full (98%). Immediate attention needed."` / `"All systems normal. 2 devices on the network."`

**Narrator generation — AI path (STUB):** `_build_narrator_ai_path()` exists and returns `None`.
Intended for severity warning/critical or idle >30min "while you were away" summaries. Would use
Qwen Lite/Standard with a 3s hard timeout and template fallback. Not implemented in v1.3.

**Action scoring — deterministic, no AI:**

| Trigger | Score | Handler |
|---|---|---|
| Disk > 95% on any drive | 95 | `open_visualizer:<mount>` |
| Disk > 85% on any drive | 80 | `open_visualizer:<mount>` |
| Automation failure event | 75 | `open_automations` |
| Shelly power spike event | 70 | `open_home_auto` |
| USB device event | 40 | `open_devices` |
| Game detected event | 50 | `run_scene:game_boost` (STUB — scene must exist) |

Actions are deduplicated by handler prefix — a second disk-full event won't create a second
`open_visualizer` action if one is already pending. Dismissed actions snooze for 60 minutes
(configurable per-dismiss via `snooze_minutes`). Confirmed actions execute their handler and are
removed from the queue. The queue is in-memory and resets on process restart; disk actions are
re-scored on the first poller tick.

**Handler dispatch:** `_dispatch_handler(handler)` maps handler strings to results:
- `open_visualizer:<mount>` → `{navigate_to: "panel-visualizer", scan_path: mount}`
- `open_automations` → `{navigate_to: "panel-automations"}`
- `open_devices` → `{navigate_to: "panel-devices"}`
- `open_home_auto` → `{navigate_to: "panel-homeauto"}`
- `run_scene:<id>` → calls `HomePowerRuntime.run_scene()` (STUB if scene doesn't exist)

**Frontend: `EventInterpreter`**

`frontend/js/event_interpreter.js` — pure logic, no DOM access. Subscribes to `/api/events/stream`
with 5s reconnect. Detects meta-events by `type` field and fans them out to typed subscribers.
Classifies regular feed events and dispatches them as `classified_event`. Public API:
`EventInterpreter.init()`, `.on(type, fn)`, `.off(type, fn)`, `.getLastEvent()`.

**Frontend: `SystemStateBar`**

Rendered in `index.html` between the header and `<main>`. Persists on every panel. On first load,
numbers count up from 0 to current values over 800ms. After that, updates from `state_update` SSE
events immediately; falls back to polling `/dashboard/state` every 10 seconds. Disk metric turns
amber at ≥85%, red at ≥95% with a CSS pulse animation.

**Frontend: `NarratorCard`**

The existing `TLIDash2` narrator (timer-based cycling every 9s) is extended with an event-driven
override layer. `TLIDash2.setEventMessage({type, text})` temporarily sets the narrator text with
type-appropriate CSS styling (`data-narrator-type` attribute on `#nd-narrator`). When `_narratorNext()`
runs its next cycle, it resets `data-narrator-type` to `"status"` and the CSS 0.4s transition fades
the color back to white. The `"confirmation"` type additionally auto-resets after 8 seconds.

**Frontend: `ActionCard`**

`#nd-action-card` sits between the narrator and quickread sections in the Dashboard panel. Fetches
`/dashboard/action/current` on mount (800ms delay, so NarratorCard and SystemStateBar load first).
Confirm: disables button, shows "Running…", POSTs to confirm endpoint, navigates if `navigate_to` is
present, then fetches next action. Dismiss: applies `ac-sliding-out` CSS transition (opacity + translate),
POSTs to dismiss endpoint, slides in next action after 350ms. Idle state shows "No actions needed
right now." — the card is never hidden.

**Frontend: `EventPulse`**

A 7px dot (`#ep-dot`) appended to `#tli-feed-bell`. Invisible at rest. Pulses once (1.2s animation,
`ep-pulse` CSS keyframe) when a classified event arrives. Reflow trick (`void el.offsetWidth`) allows
rapid successive events to restart the animation cleanly.

**First-launch behavior:**
- NarratorCard shows "I'm reading your environment." (initial value in `_narrator` dict) until `_refresh()` completes
- SystemStateBar counts up from 0 over 800ms on first `/dashboard/state` response
- ActionCard appears after an 800ms delay

**Return-visit idle detection:**
- `localStorage["tli_last_active_ts"]` updated on every click, keydown, touchstart
- On boot, if idle > 30 minutes: fetches current narrator template (AI path is STUB)

---

### 4.11 File Visualizer — Context Menu Actions **[v1.3]**

The right-click context menu in the File Visualizer treemap now has fully functional "Open" and
"Reveal in Explorer/Finder" actions.

**New endpoints (added to `visualizer.py`, exposed as aliases in `main.py`):**

`POST /open_path {path}` — opens a file or folder with the OS default application:
- Windows: `os.startfile(path)`
- macOS: `subprocess.Popen(["open", path])`
- Linux: `subprocess.Popen(["xdg-open", path])`

`POST /open_reveal {path}` — reveals a file in the file manager with it selected:
- Windows: `subprocess.Popen(["explorer", f"/select,{path}"])`
- macOS: `subprocess.Popen(["open", "-R", path])`
- Linux: opens parent directory via `xdg-open`

Both handlers validate path existence before spawning and return `{ok: false, error: ...}` on
failure. They are safe to call from the frontend — errors surface as toast notifications, not crashes.

---

## 5. Security Model

*Unchanged from v1.2. See TLI_ANALYSIS_v1.0.md § 5.*

**v1.3 additions note:** The new `/dashboard/*` endpoints all require `require_session` (same PIN
session auth as other protected endpoints). `POST /open_path` and `POST /open_reveal` do not require
a session — they are file-manager utility endpoints consistent with the existing `/visualizer/*`
pattern (which is also unauthenticated, read-only local-disk access).

---

## 6. Distribution and Release Infrastructure **[v1.3 updated]**

### 6.1 What Ships **[v1.3]**

The distribution zip (`TLI_dist_1.3.0-beta.zip`) is built by `build_dist.py` reading
`TLI_VERSION` from `backend/tli_state.py`. New files shipped in v1.3:

**Backend:**
- `backend/routers/dashboard_presence.py` — event classification, hardware polling, action queue, 5 endpoints

**Frontend:**
- `frontend/js/event_interpreter.js` — SSE subscriber, classifier, fan-out
- `frontend/js/system-state-bar.js` — SystemStateBar + ActionCard + EventPulse + NarratorCard wiring

**Modified files:**
- `backend/event_bus.py` — `emit_meta()`, `register_post_emit_hook()`, hook invocation
- `backend/main.py` — router registration, startup/shutdown wiring
- `backend/routers/visualizer.py` — `_open_path_handler()`, `_reveal_path_handler()`
- `frontend/index.html` — SystemStateBar div, ActionCard div, new script tags, `style.css?v=r3`
- `frontend/style.css` — SystemStateBar, ActionCard, EventPulse, NarratorCard type styles (~200 lines)
- `frontend/app.js` — `TLIDash2.setEventMessage()`, first-launch placeholder, `data-narrator-type` reset

Everything else is identical to v1.2. The packager exclusion rules are unchanged.

### 6.2–6.4 Launchers, Auto-Update, Public Infrastructure

*Unchanged from v1.2. See TLI_ANALYSIS_v1.0.md § 6.2–6.4.*

`latest.json` updated to version `1.3.0-beta`, `frontend_only: false` (backend changes present).

---

## 7. AI Subsystem Detail

*Unchanged from v1.2. See TLI_ANALYSIS_v1.0.md § 7.*

**v1.3 note:** The narrator AI path (Qwen Lite/Standard, 3s timeout, template fallback) is designed
but not implemented. No Qwen calls are made by the Dashboard Presence Layer in v1.3. All narrator
text is template-driven.

---

## 8. Code Quality — v1.3 Patch Assessment **[v1.3]**

### What was done well

**Classification symmetry.** `classify_event()` (Python) and `_classify()` (JavaScript) implement
identical logic from identical lookup tables. Frontend and backend reach the same conclusions from
the same event data — no subtle divergence in severity labeling.

**Meta-event transparency.** The `emit_meta` / `_broadcast_raw` split means meta-events are never
stored in the ring buffer, never replayed to new subscribers, and never visible to `live-feed.js`.
The existing feed is genuinely untouched.

**Post-emit hook isolation.** Each hook is called inside a `try/except` — a crashing hook cannot
disrupt the event pipeline. The hook list is copied before iteration so hooks registered mid-flight
don't cause iteration errors.

**Band-based change detection.** CPU at ±10%, RAM/disk at ±5% prevents SSE chatter at idle. A
machine running at 23% CPU doesn't broadcast every 5 seconds just because the number varies by 1%.

**Lock discipline.** Three separate locks (`_state_lock`, `_narrator_lock`, `_action_lock`). No
bare dict mutations from the poller thread. All shared state read/written through lock-scoped helpers.

**Clean daemon thread lifecycle.** `start_polling()` / `stop_polling()` called from FastAPI lifecycle
hooks. `_stop_event.wait(timeout)` — no busy spin, OS-yielding sleep. `daemon=True` ensures the
thread doesn't prevent process exit even if `stop_polling()` isn't reached.

**Action deduplication.** `_enqueue_if_new()` deduplicates by handler prefix — a second disk-full
event won't create a second `open_visualizer` action. Snooze state is respected.

**XSS prevention in ActionCard.** `_esc()` HTML-encodes all server-provided strings before
`innerHTML` insertion. Action titles come from the backend which builds them from psutil and event
data — but defense in depth is correct here.

### Known issues and deferred items

**`_navigateTo` selector bug (medium priority).** Uses `[data-panel="${panelId}"]` but nav buttons
use `data-panel-target`. ActionCard confirm navigation falls through to the last resort (direct DOM
show/hide), which bypasses any panel `onOpen()` initialization. Cosmetically functional; structurally
incorrect. Fix: `[data-panel-target="${panelId}"]`.

**`device_count` always 0.** `_state["device_count"]` is never updated by the poller (device list
is a separate subsystem). The SystemStateBar shows "Devices 0" permanently. Requires a data source
decision: poll `/homeauto/devices`, expose count from `/status`, or wire from `TLIDash2._refresh()`.

**Double `get_top_action()` in confirm response.** `post_action_confirm` calls `get_top_action()`
twice with a lock gap between calls. Harmless in practice but technically unsound. Fix: capture
result once before returning.

**Debounce redundant with band detection.** `_broadcast_state_update()` has an internal 5-second
debounce timer independent of the band-change gate. A band change at t=4.9s after a previous
broadcast at t=0 will be silently dropped. Since the band gate already prevents flooding, the debounce
is redundant and occasionally wrong. Fix: remove the debounce; rely on the poller interval.

**EventPulse fires on SSE replay.** On connect, the backend replays the last 20 events. Each is
classified and fires `classified_event`, triggering up to 20 rapid pulse cycles. They stack-cancel
visually but represent spurious work. Fix: add a 1s grace period after connect before firing pulses.

**Second SSE connection.** `EventInterpreter` opens its own `EventSource` to `/api/events/stream`
while `live-feed.js` already holds one. Two concurrent SSE connections per tab. Acceptable for v1.3;
the better architecture is to have `EventInterpreter` subscribe to `live-feed.js`'s parsed events.

**Narrator AI path STUB.** `_build_narrator_ai_path()` returns `None`. The `on_event` hook calls
`_build_narrator_from_state()` directly without checking severity for AI escalation.
Template path handles all cases in v1.3.

**`run_scene:game_boost` STUB.** Game-detected ActionCard confirm will call
`HomePowerRuntime.run_scene("game_boost")` which returns `{ok: false}` unless a scene with that ID
exists. The action appears and can be dismissed; confirming it fails gracefully.

### Recommended follow-up (in priority order)

1. Fix `_navigateTo` attribute (`data-panel` → `data-panel-target`)
2. Fix double `get_top_action()` in confirm
3. Populate `device_count` from a data source
4. Remove redundant debounce from `_broadcast_state_update`
5. Suppress EventPulse during SSE replay (1s grace window)
6. Wire `EventInterpreter` to `live-feed.js` event stream instead of opening second SSE connection

---

## 9. Open Questions / Future Development **[v1.3 updated]**

**Shipped in v1.2:**
- Live System Feed — real-time event bus
- Smart AI routing — CPU/RAM-aware mesh routing
- AI Source modal redesign
- Storage intelligence — auto-resolved filesystem paths
- Conversation isolation — mesh-proxied chats excluded from host Recent Chats
- Apple Silicon Metal GPU — `--n-gpu-layers 99` on arm64 Macs
- AI health check hardening — `health_timeout_s` raised to 5s
- macOS startup timeout — raised to 120s
- Optimal thread selection — `_optimal_threads()`

**Shipped in v1.3:**
- Dashboard Presence Layer — SystemStateBar, NarratorCard (event-driven), ActionCard, EventPulse
- Event classification — pure function, symmetric Python + JS implementation
- Post-emit hook system — non-destructive extension point on the event bus
- `emit_meta()` — typed meta-event broadcast without polluting the feed ring buffer
- File Visualizer context menu — "Open" and "Reveal in Explorer/Finder" now functional on all platforms

**Near-term (v1.4 candidates):**
- Fix the six known v1.3 issues listed in § 8 above
- Narrator AI path implementation (Qwen Lite, 3s timeout, warning/critical threshold)
- `device_count` wiring
- Community hub server launch
- Federated relay hosted service
- macOS Gatekeeper code signing

**Medium-term:**
- Multi-user support
- Mobile companion enhancements
- Additional smart home drivers (Matter/Thread, Zigbee)
- Windows EXE packaging
- Plugin/module system

---

## 10. Summary for External Audiences

*The investor and security reviewer summaries from v1.2 remain accurate.*

**v1.3 addition for technical reviewers:**

The Dashboard Presence Layer is approximately 1,400 lines of new code (600 Python, 550 JS, 200 CSS)
across 5 new files and 5 modified files. It adds no new external dependencies — psutil was already
imported in `system_routes.py`; the rest is standard library plus FastAPI/Pydantic primitives already
in the dependency set.

The patch was designed with surgical precision: no existing panel was modified, no existing SSE
protocol was altered, no existing narrator logic was replaced. The v1.3 components are additive
overlays that degrade gracefully if their endpoints return errors — the base TLI dashboard continues
to function normally if `dashboard_presence.py` fails to start.

---

*Document updated: April 2026. Reflects TheLANIntelligence v1.3.0-beta.*
*Internal contact: thelanintelligence@gmail.com*
