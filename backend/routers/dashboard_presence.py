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

import json
import os
import platform
import math
import copy
import ntpath
import posixpath
import threading
import time
import uuid
from typing import Any

import psutil
from fastapi import APIRouter, Depends, HTTPException, Response
from typing import Literal
from pydantic import BaseModel, Field

from routers.system_routes import require_session
import tli_state as S
from tli_state import log_debug
from narrator_policy import NarratorPolicy, fresh_observation, valid_disks
from action_results import execution_summary

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
_narrator_policy = NarratorPolicy()
_policy_lock = threading.RLock()

# Action queue
_action_queue: list[dict] = []
_action_lock  = threading.Lock()
_inflight_actions: set[str] = set()
_disk_snoozes: dict[tuple[str, str], float] = {}
_disk_last_sample_ts = 0.0
_DISK_OBSERVATION_SECONDS = 30.0

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
    try:
        cpu = round(psutil.cpu_percent(interval=0.2), 1)
    except Exception:
        cpu = None
    try:
        ram = round(psutil.virtual_memory().percent, 1)
    except Exception:
        ram = None

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
        "cpu_pct":           cpu,
        "ram_pct":           ram,
        "disk_pct_by_drive": disk_by_drive,
    }


# ---------------------------------------------------------------------------
# State read/write
# ---------------------------------------------------------------------------

def _read_state() -> dict:
    with _state_lock:
        return dict(_state)


def _safe_action_payload(action: dict | None) -> dict | None:
    """Return only frontend-safe action-card fields."""
    if action is None:
        return None
    return {
        "id":                action["id"],
        "title":             action["title"],
        "context":           action["context"],
        "confirm_label":     action["confirm_label"],
        "dismiss_label":     action["dismiss_label"],
        "score":             action["score"],
        "handler":           action.get("handler", ""),
        "secondary_label":   action.get("secondary_label",   ""),
        "secondary_handler": action.get("secondary_handler", ""),
        "breakdown":         action.get("breakdown",         []),
        "created_at":        action.get("created_ts"),
        "target":            copy.deepcopy(action.get("target")),
        "observation":       copy.deepcopy(action.get("observation")),
        "relationship":      "independent_suggestion",
        "server_time":       time.time(),
        "kind":              action.get("kind"),
    }


def _write_state(updates: dict) -> None:
    with _state_lock:
        _state.update(updates)


# ---------------------------------------------------------------------------
# Narrator helpers
# ---------------------------------------------------------------------------

def _get_narrator() -> dict:
    with _narrator_lock:
        result = dict(_narrator)
    with _policy_lock:
        result.update(mode=_narrator_policy.mode,
                      explanations=_narrator_policy.explanations(_read_state(), time.monotonic(), time.time()))
    return result


def _set_narrator(text: str, msg_type: str = "status") -> bool:
    with _narrator_lock:
        if _narrator["text"] == text and _narrator["type"] == msg_type:
            return False
        _narrator["type"]      = msg_type
        _narrator["text"]      = text
        _narrator["timestamp"] = time.time()
        return True


def _build_narrator_from_state(state: dict, trigger_event: dict | None = None) -> tuple[str, str]:
    with _policy_lock:
        return _narrator_policy.render(state, time.monotonic(), time.time(), trigger_event)


def _refresh_narrator(event: dict | None = None) -> None:
    with _policy_lock:
        text, kind = _build_narrator_from_state(_read_state(), event)
        if _set_narrator(text, kind):
            _broadcast_narrator_update()


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
    """Preserve event deduplication, but never collapse separate drive targets."""
    def key(item):
        handler = item["handler"]
        return handler if handler.startswith("open_visualizer:") else handler.split(":")[0]
    prefix = key(action)
    now    = time.time()
    with _action_lock:
        for existing in _action_queue:
            if key(existing) == prefix:
                snoozed = existing.get("snoozed_until_ts")
                if snoozed is None or snoozed > now:
                    return  # already in queue and active
        _action_queue.append(action)
        log_debug("dashboard_presence", "info", f"Action enqueued: {action['title']} (score={action['score']})")


def get_top_action() -> dict | None:
    """Return highest-scored non-snoozed action, or None."""
    now = time.time()
    with _action_lock:
        _prune_disk_actions(now)
        eligible = [
            a for a in _action_queue
            if a.get("snoozed_until_ts") is None or a["snoozed_until_ts"] <= now
        ]
        if not eligible:
            return None
        return copy.deepcopy(max(eligible, key=lambda a: (a["score"], (a.get("observation") or {}).get("value", 0))))


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


def _host_identity() -> dict | None:
    """Read configured identity only; a fallback display name is not identity."""
    try:
        cfg = S.load_node_config()
        node_id, name = cfg.node_id, cfg.node_name
        if (isinstance(node_id, str) and node_id.strip() and len(node_id) <= 256
                and isinstance(name, str) and name.strip() and len(name) <= 256):
            return {"id": node_id, "name": name}
    except Exception:
        pass
    return None


def _mount_key(mount: str) -> str | None:
    # Lexical comparison only. Never resolve, enumerate, or probe a drive here.
    if not isinstance(mount, str) or not mount or len(mount) > 1024 or "\0" in mount:
        return None
    if ntpath.isabs(mount) and (ntpath.splitdrive(mount)[0] or mount.startswith("\\\\")):
        return ntpath.normcase(ntpath.normpath(mount))
    if posixpath.isabs(mount):
        return posixpath.normpath(mount)
    return None


def _disk_key(action: dict) -> tuple[str, str] | None:
    target = action.get("target") or {}
    if action.get("kind") == "disk_observation" and target.get("host_id") and target.get("id"):
        return target["host_id"], target["id"]
    return None


def _prune_disk_actions(now: float) -> None:
    """Caller holds _action_lock. Expiry is not a claim of recovery."""
    _action_queue[:] = [a for a in _action_queue if not _disk_key(a)
                       or now < a["observation"]["expires_at"]]
    for key, until in list(_disk_snoozes.items()):
        if until <= now:
            del _disk_snoozes[key]


def _score_disk_actions(state: dict) -> None:
    """Reconcile only drive suggestions against one complete, fresh sample."""
    global _disk_last_sample_ts
    now = time.time()
    sampled = state.get("sampled_ts", state.get("probed_ts"))
    host = state.get("host") or {}
    valid = (fresh_observation(state, now) and isinstance(host.get("id"), str) and host["id"]
             and isinstance(host.get("name"), str) and host["name"]
             and isinstance(state.get("observation_id"), str) and state["observation_id"])
    with _action_lock:
        _prune_disk_actions(now)
        if type(sampled) in (int, float) and math.isfinite(sampled):
            if sampled < _disk_last_sample_ts:
                return  # an older sample cannot replace a later reconciliation
            _disk_last_sample_ts = sampled
        previous = {_disk_key(a): a for a in _action_queue if _disk_key(a)}
        retained = [a for a in _action_queue if not _disk_key(a)]
        if valid:
            for mount, pct in valid_disks(state).items():
                canonical = _mount_key(mount)
                if canonical is None or pct < 85:
                    continue
                key = (host["id"], canonical)
                # One canonical target may occur with alternate lexical spelling.
                if any(_disk_key(a) == key for a in retained):
                    continue
                action = _make_action(
                    title=f"Drive {mount} is {'critically full' if pct >= 95 else 'elevated'} ({pct:.0f}%).",
                    context="Recorded storage warning. Review this drive in Free Space; no scan or cleanup has run.",
                    confirm_label="Open Free Space", handler=f"open_visualizer:{mount}",
                    score=95 if pct >= 95 else 80)
                old = previous.get(key)
                if old:
                    action.update({field: old[field] for field in ("id", "created_ts", "snoozed_until_ts")})
                action.update(kind="disk_observation", target={"kind": "drive", "host_id": host["id"],
                    "host_name": host["name"], "id": canonical, "path": mount},
                    observation={"id": state["observation_id"], "observed_at": state["probed_ts"],
                        "expires_at": state["probed_ts"] + _DISK_OBSERVATION_SECONDS,
                        "host_id": host["id"], "target_id": canonical,
                        "scope": "host_drive", "metric": "disk_percent", "value": pct})
                if key in _disk_snoozes:
                    action["snoozed_until_ts"] = _disk_snoozes[key]
                retained.append(action)
        _action_queue[:] = retained


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

def _poll_once() -> None:
    """One sample plus policy tick; temporal warnings do not depend on band changes."""
    try:
        metrics = _probe_metrics()
        old = _read_state()
        cpu_band = _band(metrics["cpu_pct"], _CPU_BAND_SIZE) if metrics["cpu_pct"] is not None else None
        ram_band = _band(metrics["ram_pct"], _RAM_BAND_SIZE) if metrics["ram_pct"] is not None else None
        disk_bands = {m: _band(p, _DISK_BAND_SIZE) for m, p in metrics["disk_pct_by_drive"].items()}
        successful = any(metrics[k] is not None for k in ("cpu_pct", "ram_pct")) or bool(disk_bands)
        sampled = time.time()
        _write_state({**metrics, "probed_ts": sampled if successful else old.get("probed_ts", 0),
                      "sampled_ts": sampled, "observation_id": str(uuid.uuid4()), "host": _host_identity(),
                      "probe_error": None if successful else "No metrics available",
                      "_cpu_band": cpu_band, "_ram_band": ram_band, "_disk_bands": disk_bands})
        _score_disk_actions(_read_state())
        # Same values are still a new observation. Publish time as well as bands.
        _broadcast_state_update(_read_state())
        _broadcast_action_update()
    except Exception as exc:
        _write_state({"probe_error": str(exc), "sampled_ts": time.time()})
        _score_disk_actions(_read_state())
        _broadcast_state_update(_read_state())
        _broadcast_action_update()
        log_debug("dashboard_presence", "warn", f"Poller error: {exc}")
    _refresh_narrator()


def _poller_loop() -> None:
    log_debug("dashboard_presence", "info", "Poller loop started.")
    while not _stop_event.is_set():
        _poll_once()
        _stop_event.wait(timeout=_POLL_INTERVAL_S)
    log_debug("dashboard_presence", "info", "Poller loop stopped.")


def start_polling() -> None:
    global _poller_thread
    if _poller_thread and _poller_thread.is_alive():
        return
    try:
        import narrator_settings
        with _policy_lock:
            _narrator_policy.set_mode(narrator_settings.read()["mode"])
    except HTTPException:
        # A damaged preference file cannot suppress critical monitoring.
        # The settings endpoint explains the failure and refuses replacement.
        pass
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
            _refresh_narrator({**event, "severity": cls["severity"]})

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
        return {"ok": True, "navigate_to": "panel-visualizer", "review_required": True,
                "narrator_msg": "Opened Free Space for file review. Nothing was moved or deleted."}

    if verb == "open_visualizer":
        return {"ok": True, "navigate_to": "panel-visualizer", "scan_path": arg, "narrator_msg": "Opened Free Space for review."}

    if verb == "open_automations":
        return {"ok": True, "navigate_to": "panel-automations", "narrator_msg": "Opened Automations."}

    if verb == "open_devices":
        return {"ok": True, "navigate_to": "panel-devices", "narrator_msg": "Opened Devices."}

    if verb == "open_home_auto":
        return {"ok": True, "navigate_to": "panel-homeauto", "narrator_msg": "Opened Home Automation."}

    if verb == "run_scene":
        # STUB: scene execution — requires HomePowerRuntime to be imported.
        # Circular import risk deferred; caller should handle navigate_to.
        try:
            from routers.home_power import get_runtime  # noqa: PLC0415
            rt = get_runtime()
            if rt:
                result = rt.run_scene(arg)
                ok, summary = execution_summary(result.get("results") or [], "scene")
                return {"ok": ok and result.get("ok") is True, "scene_result": result, "narrator_msg": summary}
        except Exception as exc:
            log_debug("dashboard_presence", "warn", f"run_scene failed: {exc}")
        return {"ok": False, "error": f"Scene '{arg}' could not be run."}

    # Unknown handler — STUB
    log_debug("dashboard_presence", "warn", f"Unknown handler verb: {verb}")  # STUB
    return {"ok": False, "error": f"No handler for '{handler}'"}


# ---------------------------------------------------------------------------
# Command Center snapshot helpers
# ---------------------------------------------------------------------------

def _disk_snapshot() -> dict:
    """
    Fast local disk snapshot with the same shape as /api/system/disk.
    This keeps Dashboard 2.0 from fanning out to another backend route.
    """
    gb = 1024 ** 3
    system_root = (
        os.environ.get("SystemDrive", "C:") + "\\"
        if platform.system() == "Windows"
        else "/"
    )
    system_root = system_root.upper()

    drives = []
    try:
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                mount_norm = part.mountpoint.upper().rstrip("\\/") + (
                    "\\" if platform.system() == "Windows" else "/"
                )
                drives.append({
                    "mount": part.mountpoint,
                    "drive": part.mountpoint.rstrip("\\/") or part.mountpoint,
                    "fstype": part.fstype,
                    "total_gb": round(usage.total / gb, 1),
                    "used_gb": round(usage.used / gb, 1),
                    "free_gb": round(usage.free / gb, 1),
                    "pct": round(usage.percent, 1),
                    "is_system": mount_norm == system_root,
                })
            except Exception:
                continue
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    if not drives:
        return {"ok": False, "error": "No drives found"}

    system_drive = next((d for d in drives if d["is_system"]), drives[0])
    return {
        "ok": True,
        "system": system_drive,
        "drives": drives,
        "total_gb": system_drive["total_gb"],
        "used_gb": system_drive["used_gb"],
        "free_gb": system_drive["free_gb"],
        "pct": system_drive["pct"],
    }


def _node_snapshot() -> dict:
    try:
        cfg = S.load_node_config()
        return {
            "id": cfg.node_id,
            "name": cfg.node_name or None,
            "role": cfg.role,
            "mesh_status": cfg.mesh_status,
        }
    except Exception:
        return {
            "id": None,
            "name": None,
            "role": "standalone",
            "mesh_status": "unpaired",
        }


def _ai_snapshot() -> dict:
    bundled = {
        "ok": False,
        "healthy": False,
        "model_exists": False,
        "active_preset": None,
        "active_model": None,
        "note": "Bundled AI unavailable",
    }
    try:
        from ai.ai_manager import BundledAIManager  # lazy: avoids import cost in tests
        st = BundledAIManager.get().status()
        bundled = {
            "ok": bool(st.get("healthy", False)),
            "healthy": bool(st.get("healthy", False)),
            "model_exists": bool(st.get("model_exists", False)),
            "active_preset": st.get("active_preset"),
            "active_model": st.get("active_model"),
            "note": "Model present" if st.get("model_exists") else "Model missing",
        }
    except Exception as exc:
        bundled["error"] = str(exc)

    lm_online = False
    try:
        from routers.system_routes import lm_studio_health_check_cached  # lazy
        lm_online = bool(lm_studio_health_check_cached())
    except Exception:
        lm_online = False

    return {
        "bundled": bundled,
        "bundled_ok": bool(bundled.get("ok") or bundled.get("healthy")),
        "lmstudio_online": lm_online,
        "ready": bool(bundled.get("ok") or bundled.get("healthy") or lm_online),
    }


def _vault_snapshot(user_id: str) -> dict:
    try:
        from vault_security import get_status as vault_get_status  # lazy
        raw = vault_get_status(user_id)
        return {
            "initialized": bool(raw.get("is_initialized", False)),
            "unlocked": bool(raw.get("is_unlocked_for_user", False)),
            "locked_until": raw.get("locked_until"),
            "failed_attempts": int(raw.get("failed_attempts", 0)),
        }
    except Exception as exc:
        return {
            "initialized": False,
            "unlocked": False,
            "locked_until": None,
            "failed_attempts": 0,
            "error": str(exc),
        }


def _smart_home_snapshot() -> dict:
    devices = []

    try:
        from routers.home_power import get_runtime  # lazy
        rt = get_runtime()
        devices = rt.load_devices()
    except Exception:
        devices = []

    if not devices:
        try:
            devices = S.load_shelly_registry()
        except Exception:
            devices = []

    clean = [d for d in devices if isinstance(d, dict)]
    names = []
    for i, d in enumerate(clean):
        name = (
            d.get("name")
            or d.get("label")
            or d.get("display_name")
            or d.get("device_id")
            or d.get("ip")
            or f"Device {i + 1}"
        )
        names.append(str(name).strip() or f"Device {i + 1}")

    return {"count": len(clean), "names": names, "devices": clean}


def _mesh_snapshot(node: dict) -> dict:
    try:
        directory = S.load_mesh_directory()
    except Exception:
        directory = {}

    node_id = node.get("id")
    peers = []
    for dev_id, info in (directory or {}).items():
        if dev_id == node_id:
            continue
        if isinstance(info, dict):
            peers.append(info)

    online_peers = [
        p for p in peers
        if str(p.get("status") or p.get("mesh_status") or "online").lower() != "offline"
    ]
    return {
        "role": node.get("role", "standalone"),
        "status": node.get("mesh_status", "unpaired"),
        "peer_count": len(peers),
        "online_peer_count": len(online_peers),
    }


def _active_alerts(limit: int = 25) -> list[dict]:
    try:
        alerts = S.load_alerts()
        active = [a for a in alerts if isinstance(a, dict) and not a.get("dismissed")]
        return active[-max(1, min(int(limit), 100)):]
    except Exception:
        return []


def _recent_action_receipts(limit: int = 5) -> list[dict]:
    path = os.path.join(S.DATA_DIR, "actions_receipts.jsonl")
    if not os.path.exists(path):
        return []
    items: list[dict] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                if isinstance(item, dict):
                    items.append(item)
    except Exception:
        return []
    return list(reversed(items[-max(1, min(int(limit), 25)):]))


def _health_snapshot(snapshot: dict) -> dict:
    score = 100
    factors: list[dict] = []

    def add(delta: int, label: str, severity: str, detail: str = "") -> None:
        nonlocal score
        score += delta
        factors.append({
            "label": label,
            "severity": severity,
            "delta": delta,
            "detail": detail,
        })

    storage = snapshot.get("storage") or {}
    system_drive = storage.get("system") or {}
    pct = system_drive.get("pct")
    if isinstance(pct, (int, float)):
        drive = system_drive.get("drive") or "System drive"
        if pct >= 95:
            add(-30, "Storage critical", "critical", f"{drive} is {pct:.0f}% full.")
        elif pct >= 85:
            add(-15, "Storage pressure", "warning", f"{drive} is {pct:.0f}% full.")
        elif pct >= 70:
            add(-5, "Storage watch", "info", f"{drive} is {pct:.0f}% full.")

    ai = snapshot.get("ai") or {}
    bundled = ai.get("bundled") or {}
    if not ai.get("ready"):
        if bundled.get("model_exists") is False:
            add(-20, "AI model missing", "warning", "Bundled model is not available.")
        else:
            add(-15, "AI offline", "warning", "No bundled or LM Studio runtime is ready.")

    vault = snapshot.get("vault") or {}
    if not vault.get("initialized"):
        add(-8, "Vault not initialized", "info", "Encrypted secrets are not set up yet.")
    elif not vault.get("unlocked"):
        add(-3, "Vault locked", "info", "Vault is encrypted and currently locked.")

    alerts = snapshot.get("alerts") or []
    critical_count = sum(
        1 for a in alerts
        if str(a.get("severity") or a.get("level") or "").lower() in {"critical", "alert"}
    )
    warn_count = max(0, len(alerts) - critical_count)
    if critical_count:
        add(-min(30, critical_count * 15), "Critical alerts", "critical", f"{critical_count} critical alert(s) active.")
    if warn_count:
        add(-min(12, warn_count * 2), "Active warnings", "warning", f"{warn_count} warning alert(s) active.")

    smart_home = snapshot.get("smart_home") or {}
    if int(smart_home.get("count") or 0) == 0:
        factors.append({
            "label": "No smart-home devices",
            "severity": "info",
            "delta": 0,
            "detail": "Automation is available after devices are added.",
        })

    score = max(0, min(100, score))
    if score < 50:
        level = "critical"
        summary = "Needs attention"
    elif score < 75:
        level = "warning"
        summary = "Watch closely"
    else:
        level = "good"
        summary = "Operational"

    return {
        "score": score,
        "level": level,
        "summary": summary,
        "factors": factors[:8],
    }


def _nav_suggestion(
    ident: str,
    title: str,
    label: str,
    target: str,
    context: str,
    *,
    severity: str = "info",
    priority: int = 10,
    scan_path: str = "",
    reason: str = "",
) -> dict:
    out = {
        "id": ident,
        "kind": "navigate",
        "title": title,
        "label": label,
        "target": target,
        "context": context,
        "severity": severity,
        "priority": priority,
        "reason": reason or context,
    }
    if scan_path:
        out["scan_path"] = scan_path
    return out


def _chat_suggestion(ident: str, title: str, label: str, prompt: str, priority: int = 5, reason: str = "") -> dict:
    return {
        "id": ident,
        "kind": "chat_seed",
        "title": title,
        "label": label,
        "prompt": prompt,
        "context": prompt,
        "severity": "info",
        "priority": priority,
        "reason": reason or "Ask TLI to turn the current snapshot into a short readout.",
    }


def _build_suggestions(snapshot: dict) -> list[dict]:
    suggestions: list[dict] = []

    critical_alerts = [
        a for a in snapshot.get("alerts", [])
        if str(a.get("severity") or a.get("level") or "").lower() in {"critical", "alert"}
    ]
    if critical_alerts:
        first = critical_alerts[0]
        suggestions.append(_nav_suggestion(
            "alerts_review",
            first.get("message") or first.get("title") or "Critical alert needs review",
            "Review alerts",
            "panel-system",
            "A critical system alert is active.",
            severity="critical",
            priority=95,
        ))

    storage = snapshot.get("storage") or {}
    system_drive = storage.get("system") or {}
    pct = system_drive.get("pct")
    if isinstance(pct, (int, float)) and pct >= 70:
        severity = "critical" if pct >= 95 else "warning" if pct >= 85 else "info"
        suggestions.append(_nav_suggestion(
            "storage_review",
            f"{system_drive.get('drive') or 'System drive'} is {pct:.0f}% full",
            "Review storage",
            "panel-visualizer",
            "Open the storage visualizer at the system drive.",
            severity=severity,
            priority=90 if pct >= 95 else 75 if pct >= 85 else 45,
            scan_path=system_drive.get("mount") or "",
        ))

    ai = snapshot.get("ai") or {}
    bundled = ai.get("bundled") or {}
    if not ai.get("ready"):
        label = "Open AI"
        title = "AI runtime is offline"
        context = "Start the bundled model or connect LM Studio."
        if bundled.get("model_exists") is False:
            title = "Bundled AI model is missing"
            context = "Download or select a local model to enable chat."
        suggestions.append(_nav_suggestion(
            "ai_start",
            title,
            label,
            "panel-main",
            context,
            severity="warning",
            priority=70,
        ))

    vault = snapshot.get("vault") or {}
    if not vault.get("initialized"):
        suggestions.append(_nav_suggestion(
            "vault_setup",
            "Vault is not initialized",
            "Set up Vault",
            "panel-vault",
            "Create the encrypted local vault before storing secrets.",
            severity="info",
            priority=55,
        ))
    elif not vault.get("unlocked"):
        suggestions.append(_nav_suggestion(
            "vault_unlock",
            "Vault is locked",
            "Open Vault",
            "panel-vault",
            "Unlock the vault to use local secrets and notes.",
            severity="info",
            priority=50,
        ))

    smart_home = snapshot.get("smart_home") or {}
    if int(smart_home.get("count") or 0) == 0:
        suggestions.append(_nav_suggestion(
            "home_add_device",
            "No smart-home devices are registered",
            "Add device",
            "panel-homeauto",
            "Add Shelly or Home Power devices for local automation.",
            severity="info",
            priority=35,
        ))

    mesh = snapshot.get("mesh") or {}
    if mesh.get("status") == "unpaired" and int(mesh.get("peer_count") or 0) == 0:
        suggestions.append(_nav_suggestion(
            "mesh_connect_peer",
            "This node is running standalone",
            "Connect peer",
            "panel-mesh",
            "Pair another TLI node when you want LAN collaboration.",
            severity="info",
            priority=25,
        ))

    suggestions.append(_chat_suggestion(
        "ask_health",
        "Ask TLI for a quick health read",
        "Ask TLI",
        "Give me a quick health read of this TLI node.",
        priority=5,
    ))

    suggestions.sort(key=lambda item: int(item.get("priority") or 0), reverse=True)
    return suggestions[:6]


def _build_command_center_snapshot(user_id: str) -> dict:
    state = _read_state()
    node = _node_snapshot()
    ai = _ai_snapshot()
    vault = _vault_snapshot(user_id)
    storage = _disk_snapshot()
    smart_home = _smart_home_snapshot()
    mesh = _mesh_snapshot(node)
    alerts = _active_alerts()
    current_action = _safe_action_payload(get_top_action())

    snapshot = {
        "ok": True,
        "ts": time.time(),
        "state": {
            "cpu_pct": state.get("cpu_pct", 0),
            "ram_pct": state.get("ram_pct", 0),
            "disk_pct_by_drive": state.get("disk_pct_by_drive", {}),
            "device_count": state.get("device_count", 0),
            "last_event_ts": state.get("last_event_ts"),
            "probed_ts": state.get("probed_ts"),
            "probe_error": state.get("probe_error"),
            "host": state.get("host"),
            "observation_id": state.get("observation_id"),
        },
        "node": node,
        "ai": ai,
        "vault": vault,
        "storage": storage,
        "smart_home": smart_home,
        "mesh": mesh,
        "alerts": alerts,
        "narrator": _get_narrator(),
        "current_action": current_action,
        "recent_receipts": _recent_action_receipts(),
    }

    snapshot["health"] = _health_snapshot(snapshot)
    snapshot["suggestions"] = _build_suggestions(snapshot)

    # Compatibility fields consumed by the existing TLIDash2 renderer.
    snapshot.update({
        "aiOk": ai.get("bundled_ok", False),
        "lmOnline": ai.get("lmstudio_online", False),
        "devCount": smart_home.get("count", 0),
        "devNames": smart_home.get("names", []),
        "nickname": node.get("name", "TLI Node"),
        "nodeRole": node.get("role", "standalone"),
        "meshSt": node.get("mesh_status", "unpaired"),
        "diskData": storage,
        "activeAlerts": alerts,
    })
    return snapshot


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
        "probed_ts":         state.get("probed_ts"),
        "probe_error":       state.get("probe_error"),
        "host":              state.get("host"),
        "observation_id":    state.get("observation_id"),
    }


@router.get("/narrator/current")
def get_narrator_current(_=Depends(require_session)):
    """Returns current narrator message: {type, text, timestamp}."""
    _refresh_narrator()
    return _get_narrator()


class ActivityCursor(BaseModel):
    stream_id: str = Field(min_length=32, max_length=32, pattern=r"^[a-f0-9]+$")
    sequence: int = Field(ge=0, strict=True)


class ActivityReview(ActivityCursor):
    history_cursor: ActivityCursor | None = None


class NarratorSettingsRequest(BaseModel):
    mode: Literal["quiet", "balanced", "detailed"]


@router.get("/narrator/settings")
def get_narrator_settings(response: Response, _=Depends(require_session)):
    import narrator_settings
    response.headers["Cache-Control"] = "no-store"
    with _policy_lock:
        settings = narrator_settings.read()
        _narrator_policy.set_mode(settings["mode"])
    _refresh_narrator()
    return {"ok": True, "scope": "host", **settings, "narrator": _get_narrator()}


@router.put("/narrator/settings")
def put_narrator_settings(req: NarratorSettingsRequest, response: Response, _=Depends(require_session)):
    import narrator_settings
    response.headers["Cache-Control"] = "no-store"
    with _policy_lock:
        settings = narrator_settings.save(req.mode)
        _narrator_policy.set_mode(settings["mode"])
        _refresh_narrator()
    return {"ok": True, "scope": "host", **settings, "narrator": _get_narrator()}


@router.get("/activity-summary")
def get_activity_summary(user: str = Depends(require_session)):
    from activity_summary import get_summary
    return get_summary(user)


@router.post("/activity-summary/review")
def review_activity(cursor: ActivityReview, user: str = Depends(require_session)):
    from activity_summary import mark_reviewed
    return mark_reviewed(user, cursor.model_dump(exclude_none=True))


@router.get("/action/current")
def get_action_current(_=Depends(require_session)):
    """Returns top-scored non-snoozed action, or null."""
    return _safe_action_payload(get_top_action())


@router.get("/command-center")
def get_command_center(user_id: str = Depends(require_session)):
    _refresh_narrator()
    """Single Dashboard 2.0 snapshot for daily-use Command Center rendering."""
    return _build_command_center_snapshot(user_id)


def _execute_dashboard_action(action_id: str, secondary: bool = False) -> dict:
    with _action_lock:
        _prune_disk_actions(time.time())
        action = next((a for a in _action_queue if a["id"] == action_id), None)
        if action is None:
            raise HTTPException(status_code=404, detail="Action not found")
        if action_id in _inflight_actions:
            raise HTTPException(status_code=409, detail="This action is already running.")
        handler = action.get("secondary_handler" if secondary else "handler")
        if not handler:
            raise HTTPException(status_code=400, detail="This action has no handler.")
        _inflight_actions.add(action_id)
    try:
        try:
            receipt = _dispatch_handler(handler)
            if not isinstance(receipt, dict):
                receipt = {"ok": False, "error": "Handler returned no result."}
        except Exception as exc:
            receipt = {"ok": False, "error": str(exc)}
        ok = receipt.get("ok") is True
        message = receipt.get("narrator_msg") or (
            f"Completed: {action['title'].rstrip('?')}" if ok else
            f"Action failed: {receipt.get('error') or action['title']}. Review the result before retrying.")
        if not ok and not any(word in message.lower() for word in ("fail", "partial")):
            message = f"Action failed: {message}"
        receipt = {**receipt, "ok": ok, "narrator_msg": message}
        if _disk_key(action):
            receipt.update(target=copy.deepcopy(action["target"]), observation=copy.deepcopy(action["observation"]))
        with _action_lock:
            if ok and not secondary:
                # A poll can refresh this exact target while navigation returns.
                # Remove its identity, never another drive or unrelated action.
                _action_queue[:] = [queued for queued in _action_queue if queued["id"] != action_id]
        with _policy_lock:
            if ok:
                _narrator_policy.confirm(message, time.monotonic())
                _refresh_narrator()
            else:
                _narrator_policy.confirmation = None
                # Failure is an immediate action result, not a repeated awareness event.
                _narrator_policy.event = (message, "alert", time.monotonic() + 30)
                if _set_narrator(message, "alert"):
                    _broadcast_narrator_update()
        from routers.actions_engine import _append_receipt
        _append_receipt({"ts": S.now_iso(), "kind": "dashboard_action", "action_id": action_id,
                         "ok": ok, "summary": message, "receipt": receipt})
        _broadcast_action_update()
        next_action = get_top_action()
        return {"ok": ok, "receipt": receipt, "next_action": next_action["id"] if next_action else None}
    finally:
        with _action_lock:
            _inflight_actions.discard(action_id)


@router.post("/action/confirm")
def post_action_confirm(req: ConfirmRequest, _=Depends(require_session)):
    return _execute_dashboard_action(req.action_id)


@router.post("/action/dismiss")
def post_action_dismiss(req: DismissRequest, _=Depends(require_session)):
    """Snooze the dismissed action for snooze_minutes (default 60)."""
    snooze_until = time.time() + req.snooze_minutes * 60
    with _action_lock:
        _prune_disk_actions(time.time())
        for action in _action_queue:
            if action["id"] == req.action_id:
                key = _disk_key(action)
                if key:
                    if key not in _disk_snoozes and len(_disk_snoozes) >= 256:
                        raise HTTPException(status_code=409, detail="Too many snoozed drives. Try again after a snooze expires.")
                    _disk_snoozes[key] = snooze_until
                action["snoozed_until_ts"] = snooze_until
                break
        else:
            raise HTTPException(status_code=404, detail="Action not found")

    _broadcast_action_update()
    log_debug("dashboard_presence", "info", f"Action dismissed for {req.snooze_minutes}m: {req.action_id}")
    return {"ok": True, "snoozed_until": snooze_until}


@router.post("/action/secondary")
def post_action_secondary(req: ConfirmRequest, _=Depends(require_session)):
    return _execute_dashboard_action(req.action_id, secondary=True)
