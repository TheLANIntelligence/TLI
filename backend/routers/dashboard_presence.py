"""
routers/dashboard_presence.py — TLI v1.3 Dashboard Presence Layer

Provides:
  - Event classification (pure function, no AI, no network)
  - /dashboard/state   — aggregated metrics from cached psutil probe
  - /dashboard/narrator/current — current narrator message
  - /dashboard/action/current  — top-scored pending action
  - /dashboard/action/confirm  — execute action
  - /dashboard/action/dismiss  — snooze action

Background thread polls hardware every 5s and emits SSE meta-events
(state_update, narrator_update, action_update) via event_bus.emit_meta().
"""

from __future__ import annotations

import math
import threading
import time
import uuid
from typing import Any

import psutil
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.system_routes import require_session
from tli_state import log_debug

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/dashboard", tags=["dashboard-presence"])

# ---------------------------------------------------------------------------
# Event classification — pure function, no AI, no network
# ---------------------------------------------------------------------------

_CATEGORY_MAP: dict[str, str] = {
    "system":     "system",
    "device":     "device",
    "automation": "automation",
    "file":       "file",
    "vault":      "vault",
    "game":       "game",
    "power":      "device",
    "network":    "system",
    "usb":        "device",
    "mesh":       "system",
    "alert":      "system",
}

_LEVEL_SEVERITY: dict[str, str] = {
    "debug":    "info",
    "info":     "info",
    "notice":   "notice",
    "warn":     "warning",
    "warning":  "warning",
    "error":    "warning",
    "critical": "critical",
    "alert":    "warning",
}

_NARRATOR_WORTHY_CATEGORIES = {"system", "device", "automation", "vault"}
_ACTION_WORTHY_LEVELS = {"warning", "critical"}
_ACTION_WORTHY_TITLES = {
    "disk", "backup", "usb", "game", "automation", "power", "shelly",
}


def classify_event(event: dict) -> dict:
    """
    Pure classification function.  Accepts a raw event dict from event_bus
    and returns:
        {category, severity, narrator_worthy, action_worthy}
    No side effects, no network, no AI.
    """
    raw_cat   = (event.get("category") or "system").lower()
    raw_level = (event.get("level")    or "info").lower()
    title     = (event.get("title")    or "").lower()
    body      = (event.get("body")     or "").lower()

    category = _CATEGORY_MAP.get(raw_cat, "system")
    severity = _LEVEL_SEVERITY.get(raw_level, "info")

    narrator_worthy = (
        category in _NARRATOR_WORTHY_CATEGORIES
        or severity in {"warning", "critical"}
    )

    action_worthy = (
        severity in _ACTION_WORTHY_LEVELS
        or any(kw in title or kw in body for kw in _ACTION_WORTHY_TITLES)
    )

    return {
        "category":       category,
        "severity":       severity,
        "narrator_worthy": narrator_worthy,
        "action_worthy":   action_worthy,
    }


# ---------------------------------------------------------------------------
# Shared state (protected by locks)
# ---------------------------------------------------------------------------

_POLL_INTERVAL_S = 5.0
_DEBOUNCE_S      = 5.0
_CPU_BAND_SIZE   = 10.0
_RAM_BAND_SIZE   = 5.0
_DISK_BAND_SIZE  = 5.0

# Hardware metrics cache
_state: dict[str, Any] = {
    "cpu_pct":            0.0,
    "ram_pct":            0.0,
    "disk_pct_by_drive":  {},   # {mount: pct}
    "device_count":       0,
    "last_event_ts":      None,
    "probed_ts":          0.0,
    # internal: last-broadcast bands for change detection
    "_cpu_band":          -1,
    "_ram_band":          -1,
    "_disk_bands":        {},
}
_state_lock = threading.Lock()

# Narrator cache
_narrator: dict[str, Any] = {
    "type":      "status",
    "text":      "I'm reading your environment.",
    "timestamp": time.time(),
}
_narrator_lock = threading.Lock()

# Action queue
_action_queue: list[dict] = []
_action_lock  = threading.Lock()

# Background thread handle
_poller_thread: threading.Thread | None = None
_stop_event    = threading.Event()


# ---------------------------------------------------------------------------
# Helper: band rounding for change detection
# ---------------------------------------------------------------------------

def _band(val: float, size: float) -> int:
    """Round val down to the nearest multiple of size."""
    return int(math.floor(val / size) * size)


# ---------------------------------------------------------------------------
# Hardware probe
# ---------------------------------------------------------------------------

def _probe_metrics() -> dict:
    """Read hardware metrics via psutil.  May block briefly — only call from poller thread."""
    cpu = psutil.cpu_percent(interval=0.2)
    ram = psutil.virtual_memory().percent

    disk_by_drive: dict[str, float] = {}
    try:
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                disk_by_drive[part.mountpoint] = round(usage.percent, 1)
            except (PermissionError, OSError):
                pass
    except Exception:
        pass

    return {
        "cpu_pct":           round(cpu, 1),
        "ram_pct":           round(ram, 1),
        "disk_pct_by_drive": disk_by_drive,
    }


# ---------------------------------------------------------------------------
# State read/write
# ---------------------------------------------------------------------------

def _read_state() -> dict:
    with _state_lock:
        return dict(_state)


def _write_state(updates: dict) -> None:
    with _state_lock:
        _state.update(updates)


# ---------------------------------------------------------------------------
# Narrator helpers
# ---------------------------------------------------------------------------

def _get_narrator() -> dict:
    with _narrator_lock:
        return dict(_narrator)


def _set_narrator(text: str, msg_type: str = "status") -> None:
    with _narrator_lock:
        _narrator["type"]      = msg_type
        _narrator["text"]      = text
        _narrator["timestamp"] = time.time()


def _build_narrator_from_state(state: dict, trigger_event: dict | None = None) -> tuple[str, str]:
    """
    Template-driven narrator text.  Returns (text, type).
    AI path: STUB — only template path is implemented here.
    The AI path would be invoked for severity warning/critical or idle>30min.
    """
    # Disk warning takes priority
    for mount, pct in (state.get("disk_pct_by_drive") or {}).items():
        if pct >= 95:
            return (
                f"Drive {mount} is critically full ({pct:.0f}%). Immediate attention needed.",
                "alert",
            )
        if pct >= 85:
            return (
                f"Drive {mount} is at {pct:.0f}% capacity.",
                "alert",
            )

    # CPU spike
    cpu = state.get("cpu_pct", 0)
    if cpu >= 90:
        return (f"CPU usage is high at {cpu:.0f}%.", "alert")

    # RAM pressure
    ram = state.get("ram_pct", 0)
    if ram >= 90:
        return (f"RAM usage is high at {ram:.0f}%.", "alert")

    # Event-sourced narrative
    if trigger_event:
        title = trigger_event.get("title", "")
        body  = trigger_event.get("body",  "")
        if title:
            snippet = f"{title}. {body}".strip(". ")[:120]
            return (snippet + ".", "status")

    # Fallback: summary
    device_count = state.get("device_count", 0)
    if device_count:
        return (
            f"All systems normal. {device_count} device{'s' if device_count != 1 else ''} on the network.",
            "status",
        )
    return ("All systems normal.", "status")


# STUB: AI narrator path
# When severity is warning/critical or idle>30min, this would call Qwen Lite/Standard
# with a short system instruction and event context.  Hard timeout: 3s → fallback to template.
# Not implemented in this version.  See Section 4.3 of tli_v1.3_presence_layer_prompt.md.
def _build_narrator_ai_path(state: dict, event_context: list[dict]) -> str | None:  # STUB
    return None


# ---------------------------------------------------------------------------
# Action queue
# ---------------------------------------------------------------------------

def _make_action(
    title:              str,
    context:            str,
    confirm_label:      str,
    handler:            str,
    score:              int,
    trigger_event_id:   str  = "",
    dismiss_label:      str  = "Not now",
    secondary_label:    str  = "",
    secondary_handler:  str  = "",
    breakdown:          list = None,
) -> dict:
    return {
        "id":                str(uuid.uuid4()),
        "title":             title,
        "context":           context,
        "confirm_label":     confirm_label,
        "dismiss_label":     dismiss_label,
        "score":             score,
        "trigger_event_id":  trigger_event_id,
        "handler":           handler,
        "secondary_label":   secondary_label,
        "secondary_handler": secondary_handler,
        "breakdown":         breakdown or [],
        "created_ts":        time.time(),
        "snoozed_until_ts":  None,
    }


def _enqueue_if_new(action: dict) -> None:
    """
    Add action only if no non-snoozed action with the same handler prefix exists.
    Handler prefix is everything before the first ':' (e.g., 'open_visualizer').
    """
    prefix = action["handler"].split(":")[0]
    now    = time.time()
    with _action_lock:
        for existing in _action_queue:
            if existing["handler"].split(":")[0] == prefix:
                snoozed = existing.get("snoozed_until_ts")
                if snoozed is None or snoozed > now:
                    return  # already in queue and active
        _action_queue.append(action)
        log_debug("dashboard_presence", "info", f"Action enqueued: {action['title']} (score={action['score']})")


def get_top_action() -> dict | None:
    """Return highest-scored non-snoozed action, or None."""
    now = time.time()
    with _action_lock:
        eligible = [
            a for a in _action_queue
            if a.get("snoozed_until_ts") is None or a["snoozed_until_ts"] <= now
        ]
    if not eligible:
        return None
    return max(eligible, key=lambda a: a["score"])


def score_cleanup_action() -> None:
    """
    Check the latest cleanup scan summary and enqueue a cleanup action when the
    auto-cleanable total exceeds the minimum threshold (1 GB).

    Called by cleanup_routes after each completed scan.  Uses a lazy import to
    avoid a circular dependency at module load time.

    Scoring thresholds match the spec:
        >= 20 GB → 90    >= 10 GB → 80    >= 5 GB → 65    >= 1 GB → 50
    """
    try:
        from routers.cleanup_routes import get_scan_summary   # lazy
        summary = get_scan_summary()
        if not summary or not summary.get("ok"):
            return

        auto_gb = float(summary.get("auto_cleanable_gb", 0.0))
        if auto_gb < 1.0:
            return

        if auto_gb >= 20:
            score = 90
        elif auto_gb >= 10:
            score = 80
        elif auto_gb >= 5:
            score = 65
        else:
            score = 50

        # Build breakdown from auto-cleanable categories, largest first
        categories = [
            c for c in summary.get("categories", [])
            if c.get("auto_cleanable") and c.get("bytes", 0) > 0
        ]
        categories.sort(key=lambda c: c.get("bytes", 0), reverse=True)
        breakdown = [
            {"label": c["label"], "gb": c["gb"]}
            for c in categories
        ]

        # Human-friendly total label
        if auto_gb >= 1.0:
            total_label = f"{auto_gb:.1f} GB"
        else:
            total_label = f"{int(round(auto_gb * 1024))} MB"

        context_lines = [f"{c['label']}: {c['gb']:.1f} GB" for c in categories[:3]]
        context = "\n".join(context_lines) or "Low-risk regenerable files detected."

        _enqueue_if_new(_make_action(
            title             = f"Cleanup Available — {total_label} of low-risk files",
            context           = context,
            confirm_label     = "Clean Now",
            dismiss_label     = "Not now",
            handler           = "cleanup_clean_safe",
            score             = score,
            secondary_label   = "Review Files",
            secondary_handler = "open_visualizer:cleanup",
            breakdown         = breakdown,
        ))
        _broadcast_action_update()

    except Exception as exc:
        log_debug("dashboard_presence", "warn", f"score_cleanup_action error: {exc}")


def _score_disk_actions(state: dict) -> None:
    """Enqueue disk-related actions based on current state."""
    for mount, pct in (state.get("disk_pct_by_drive") or {}).items():
        if pct >= 95:
            _enqueue_if_new(_make_action(
                title         = f"Drive {mount} critically full ({pct:.0f}%). Open File Visualizer now.",
                context       = "Disk is nearly full. Freeing space is urgent.",
                confirm_label = "Open File Visualizer",
                handler       = f"open_visualizer:{mount}",
                score         = 95,
            ))
        elif pct >= 85:
            _enqueue_if_new(_make_action(
                title         = f"Drive {mount} is at {pct:.0f}%. Open File Visualizer?",
                context       = "Disk usage is elevated. Review large files to free space.",
                confirm_label = "Open File Visualizer",
                handler       = f"open_visualizer:{mount}",
                score         = 80,
            ))


def _score_event_action(event: dict, cls: dict) -> None:
    """Enqueue an action based on a classified event."""
    title = (event.get("title") or "").lower()
    body  = (event.get("body")  or "").lower()
    ev_id = event.get("id", "")

    # Automation failure
    if "automation" in title and ("fail" in title or "fail" in body or "error" in title):
        name = event.get("title", "Unknown automation")
        _enqueue_if_new(_make_action(
            title         = f"Automation '{name}' failed. View error?",
            context       = body[:100] if body else "Check the automations panel for details.",
            confirm_label = "View automations",
            handler       = "open_automations",
            score         = 75,
            trigger_event_id = ev_id,
        ))

    # USB device
    if "usb" in title or "usb" in (event.get("category") or "").lower():
        device_name = event.get("title", "USB device")
        _enqueue_if_new(_make_action(
            title         = f"New USB device: {device_name}. Safely eject or open?",
            context       = "A USB device was connected.",
            confirm_label = "View devices",
            handler       = "open_devices",
            score         = 40,
            trigger_event_id = ev_id,
        ))

    # Game detected
    if "game" in title or "game" in (event.get("category") or "").lower():
        game_name = event.get("title", "Game")
        _enqueue_if_new(_make_action(
            title         = f"{game_name} detected. Apply optimization profile?",
            context       = "A game process was detected running.",
            confirm_label = "Apply profile",
            handler       = "run_scene:game_boost",  # STUB: scene id
            score         = 50,
            trigger_event_id = ev_id,
        ))

    # Shelly power spike
    if "power" in title or "shelly" in title or "spike" in body:
        plug_name = event.get("title", "A device")
        _enqueue_if_new(_make_action(
            title         = f"{plug_name} drawing unusual power. Investigate?",
            context       = body[:100] if body else "Check home automation panel.",
            confirm_label = "View home automation",
            handler       = "open_home_auto",
            score         = 70,
            trigger_event_id = ev_id,
        ))


# ---------------------------------------------------------------------------
# SSE broadcast helpers (imported lazily to avoid circular import at module load)
# ---------------------------------------------------------------------------

def _get_emit_meta():
    """Lazy import to avoid circular import; event_bus imports from main."""
    from event_bus import emit_meta  # noqa: PLC0415
    return emit_meta


_last_broadcast_ts = 0.0


def _broadcast_state_update(state: dict) -> None:
    global _last_broadcast_ts
    now = time.time()
    if now - _last_broadcast_ts < _DEBOUNCE_S:
        return
    _last_broadcast_ts = now
    payload = {k: v for k, v in state.items() if not k.startswith("_")}
    try:
        _get_emit_meta()("state_update", payload)
    except Exception as exc:
        log_debug("dashboard_presence", "warn", f"state_update broadcast failed: {exc}")


def _broadcast_narrator_update() -> None:
    narrator = _get_narrator()
    try:
        _get_emit_meta()("narrator_update", narrator)
    except Exception as exc:
        log_debug("dashboard_presence", "warn", f"narrator_update broadcast failed: {exc}")


def _broadcast_action_update() -> None:
    top = get_top_action()
    payload = {"action_id": top["id"] if top else None}
    try:
        _get_emit_meta()("action_update", payload)
    except Exception as exc:
        log_debug("dashboard_presence", "warn", f"action_update broadcast failed: {exc}")


# ---------------------------------------------------------------------------
# Background polling loop
# ---------------------------------------------------------------------------

def _poller_loop() -> None:
    log_debug("dashboard_presence", "info", "Poller loop started.")
    while not _stop_event.is_set():
        try:
            metrics = _probe_metrics()
            old     = _read_state()

            cpu_band  = _band(metrics["cpu_pct"],  _CPU_BAND_SIZE)
            ram_band  = _band(metrics["ram_pct"],  _RAM_BAND_SIZE)
            old_disk  = old.get("_disk_bands", {})
            new_disk_bands: dict[str, int] = {
                m: _band(p, _DISK_BAND_SIZE)
                for m, p in metrics["disk_pct_by_drive"].items()
            }

            changed = (
                cpu_band != old.get("_cpu_band", -1)
                or ram_band != old.get("_ram_band", -1)
                or new_disk_bands != old_disk
            )

            _write_state({
                "cpu_pct":           metrics["cpu_pct"],
                "ram_pct":           metrics["ram_pct"],
                "disk_pct_by_drive": metrics["disk_pct_by_drive"],
                "probed_ts":         time.time(),
                "_cpu_band":         cpu_band,
                "_ram_band":         ram_band,
                "_disk_bands":       new_disk_bands,
            })

            # Update disk-triggered actions
            _score_disk_actions(metrics)

            if changed:
                state = _read_state()
                narrator_text, narrator_type = _build_narrator_from_state(state)
                _set_narrator(narrator_text, narrator_type)
                _broadcast_state_update(state)
                _broadcast_narrator_update()
                _broadcast_action_update()

        except Exception as exc:
            log_debug("dashboard_presence", "warn", f"Poller error: {exc}")

        _stop_event.wait(timeout=_POLL_INTERVAL_S)

    log_debug("dashboard_presence", "info", "Poller loop stopped.")


def start_polling() -> None:
    global _poller_thread
    _stop_event.clear()
    _poller_thread = threading.Thread(target=_poller_loop, name="dp-poller", daemon=True)
    _poller_thread.start()
    log_debug("dashboard_presence", "info", "Dashboard presence polling started.")


def stop_polling() -> None:
    _stop_event.set()
    if _poller_thread:
        _poller_thread.join(timeout=10)


# ---------------------------------------------------------------------------
# Post-emit hook — registered with event_bus
# ---------------------------------------------------------------------------

def on_event(event: dict) -> None:
    """
    Called by event_bus after every emit_event().
    Classifies the event, updates narrator if narrator_worthy,
    enqueues an action if action_worthy, and broadcasts updates.
    """
    try:
        cls = classify_event(event)

        # Update last_event_ts
        _write_state({"last_event_ts": event.get("ts", time.time())})

        if cls["narrator_worthy"]:
            state = _read_state()
            text, msg_type = _build_narrator_from_state(state, trigger_event=event)
            _set_narrator(text, msg_type)
            _broadcast_narrator_update()

        if cls["action_worthy"]:
            _score_event_action(event, cls)
            _broadcast_action_update()

    except Exception as exc:
        log_debug("dashboard_presence", "warn", f"on_event hook error: {exc}")


# ---------------------------------------------------------------------------
# Handler dispatch
# ---------------------------------------------------------------------------

def _dispatch_handler(handler: str) -> dict:
    """
    Execute a confirmed action's handler.
    Returns a receipt dict with at least {ok, navigate_to?}.
    """
    if ":" in handler:
        verb, arg = handler.split(":", 1)
    else:
        verb, arg = handler, ""

    if verb == "cleanup_clean_safe":
        try:
            from routers.cleanup_routes import get_file_index, invalidate_scan  # lazy
            from cleanup.executor import execute_clean_safe                      # lazy
            from pathlib import Path as _Path
            import tli_state as _S
            file_index = get_file_index()
            if not file_index:
                return {"ok": False, "error": "No scan available — run a scan first."}
            receipt = execute_clean_safe(file_index, _Path(_S.DATA_DIR), auto_cleanable_only=True)
            invalidate_scan()
            # Schedule a background rescan so the action card refreshes
            import threading as _threading
            from routers import cleanup_routes as _cr
            t = _threading.Timer(3.0, _cr._do_scan)
            t.daemon = True
            t.start()
            return {
                "ok":          True,
                "receipt":     receipt,
                "narrator_msg": receipt.get("narrator_msg", "Cleanup complete."),
            }
        except Exception as exc:
            log_debug("dashboard_presence", "warn", f"cleanup_clean_safe dispatch error: {exc}")
            return {"ok": False, "error": str(exc)}

    if verb == "open_visualizer":
        return {"ok": True, "navigate_to": "panel-visualizer", "scan_path": arg}

    if verb == "open_automations":
        return {"ok": True, "navigate_to": "panel-automations"}

    if verb == "open_devices":
        return {"ok": True, "navigate_to": "panel-devices"}

    if verb == "open_home_auto":
        return {"ok": True, "navigate_to": "panel-homeauto"}

    if verb == "run_scene":
        # STUB: scene execution — requires HomePowerRuntime to be imported.
        # Circular import risk deferred; caller should handle navigate_to.
        try:
            from routers.home_power import get_runtime  # noqa: PLC0415
            rt = get_runtime()
            if rt:
                result = rt.run_scene(arg)
                return {"ok": True, "scene_result": result}
        except Exception as exc:
            log_debug("dashboard_presence", "warn", f"run_scene failed: {exc}")
        return {"ok": False, "error": f"Scene '{arg}' could not be run."}

    # Unknown handler — STUB
    log_debug("dashboard_presence", "warn", f"Unknown handler verb: {verb}")  # STUB
    return {"ok": False, "error": f"No handler for '{handler}'"}


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

class ConfirmRequest(BaseModel):
    action_id: str


class DismissRequest(BaseModel):
    action_id: str
    snooze_minutes: int = 60


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/state")
def get_dashboard_state(_=Depends(require_session)):
    """
    Aggregated metrics from cached state.  Does NOT re-probe hardware.
    Returns in < 100ms from in-memory dict.
    """
    state = _read_state()
    return {
        "cpu_pct":           state["cpu_pct"],
        "ram_pct":           state["ram_pct"],
        "disk_pct_by_drive": state["disk_pct_by_drive"],
        "device_count":      state["device_count"],
        "last_event_ts":     state["last_event_ts"],
    }


@router.get("/narrator/current")
def get_narrator_current(_=Depends(require_session)):
    """Returns current narrator message: {type, text, timestamp}."""
    return _get_narrator()


@router.get("/action/current")
def get_action_current(_=Depends(require_session)):
    """Returns top-scored non-snoozed action, or null."""
    top = get_top_action()
    if top is None:
        return None
    # Return a safe subset.  secondary_label / secondary_handler / breakdown are
    # only populated for actions that support a second button (e.g., cleanup).
    # handler is the verb string used by the frontend to contextualise labels.
    return {
        "id":                top["id"],
        "title":             top["title"],
        "context":           top["context"],
        "confirm_label":     top["confirm_label"],
        "dismiss_label":     top["dismiss_label"],
        "score":             top["score"],
        "handler":           top.get("handler", ""),
        "secondary_label":   top.get("secondary_label",   ""),
        "secondary_handler": top.get("secondary_handler", ""),
        "breakdown":         top.get("breakdown",         []),
    }


@router.post("/action/confirm")
def post_action_confirm(req: ConfirmRequest, _=Depends(require_session)):
    """Execute the confirmed action and remove it from the queue."""
    with _action_lock:
        action = next((a for a in _action_queue if a["id"] == req.action_id), None)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found")

    receipt = _dispatch_handler(action["handler"])

    with _action_lock:
        try:
            _action_queue.remove(action)
        except ValueError:
            pass

    # Use a receipt-supplied narrator message when available (e.g., cleanup)
    _narrator_msg = receipt.get("narrator_msg") if isinstance(receipt, dict) else None
    _set_narrator(
        _narrator_msg or f"Done — {action['title'].rstrip('?')}",
        "confirmation",
    )
    _broadcast_narrator_update()
    _broadcast_action_update()

    log_debug("dashboard_presence", "info", f"Action confirmed: {action['title']}")
    return {"ok": True, "receipt": receipt, "next_action": get_top_action() and get_top_action()["id"]}


@router.post("/action/dismiss")
def post_action_dismiss(req: DismissRequest, _=Depends(require_session)):
    """Snooze the dismissed action for snooze_minutes (default 60)."""
    snooze_until = time.time() + req.snooze_minutes * 60
    with _action_lock:
        for action in _action_queue:
            if action["id"] == req.action_id:
                action["snoozed_until_ts"] = snooze_until
                break
        else:
            raise HTTPException(status_code=404, detail="Action not found")

    _broadcast_action_update()
    log_debug("dashboard_presence", "info", f"Action dismissed for {req.snooze_minutes}m: {req.action_id}")
    return {"ok": True, "snoozed_until": snooze_until}


@router.post("/action/secondary")
def post_action_secondary(req: ConfirmRequest, _=Depends(require_session)):
    """
    Execute the secondary action for an action card (e.g., 'Review Files').
    Unlike /action/confirm, this does NOT remove the action from the queue —
    the user is reviewing, not completing.
    """
    with _action_lock:
        action = next((a for a in _action_queue if a["id"] == req.action_id), None)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found")

    secondary_handler = action.get("secondary_handler", "")
    if not secondary_handler:
        raise HTTPException(status_code=400, detail="This action has no secondary handler.")

    receipt = _dispatch_handler(secondary_handler)
    log_debug("dashboard_presence", "info", f"Action secondary: {action['title']}")
    return {"ok": True, "receipt": receipt}
