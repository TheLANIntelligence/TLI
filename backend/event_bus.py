"""
event_bus.py — TLI Live System Feed
=====================================
Central event emitter for the TLI Live Activity feed.

Usage (from any router):
    from event_bus import emit_event
    try:
        emit_event("ai", "info", "AI routed to mesh", "RAM pressure (91%) — using FOX · Power model", node="Legatz iMac")
    except Exception:
        pass

Design:
  - emit_event() is fully synchronous and never raises — always safe to call
  - Subscribers receive events via SSE at /api/events/stream
  - Keeps last MAX_EVENTS events in memory for late-joining clients
  - Pattern identical to mesh_routes.py presence SSE — no new infrastructure
"""

import asyncio
import json
import threading
import time
import uuid
from collections import deque
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

# ── Constants ──────────────────────────────────────────────────────────────
MAX_EVENTS = 200   # bounded in-memory ring buffer

# ── State ──────────────────────────────────────────────────────────────────
_events: deque = deque(maxlen=MAX_EVENTS)
_subscribers: List[asyncio.Queue] = []
_subs_lock = threading.Lock()
_loop: Optional[asyncio.AbstractEventLoop] = None

# Post-emit hooks: callables invoked after every emit_event() with the full event dict.
# Used by dashboard_presence to classify events and update narrator/action queue.
_post_emit_hooks: List[Any] = []


def register_post_emit_hook(fn) -> None:
    """Register a callable to be called after each emit_event(). Thread-safe."""
    _post_emit_hooks.append(fn)


# ── Loop registration (called from main.py on_startup) ─────────────────────
def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


# ── Public emit API ────────────────────────────────────────────────────────
def emit_event(
    category: str,                         # ai | game | mesh | device | automation | system | vault
    level: str,                            # ok | info | warn | alert
    title: str,
    body: str = "",
    node: str = "",
    actions: Optional[List[Dict]] = None,
) -> None:
    """
    Publish an event to the live feed.
    Completely safe — swallows all exceptions, never blocks.
    """
    try:
        event: Dict[str, Any] = {
            "id": str(uuid.uuid4())[:8],
            "ts": time.time(),
            "ts_fmt": time.strftime("%I:%M %p", time.localtime()).lstrip("0"),
            "category": category,
            "level": level,
            "title": title,
            "body": body,
            "node": node,
            "actions": actions or [],
        }
        _events.append(event)
        _broadcast(event)
        # Fire post-emit hooks (e.g., dashboard_presence classification)
        for _hook in list(_post_emit_hooks):
            try:
                _hook(event)
            except Exception:
                pass
    except Exception:
        pass


def get_recent(n: int = 50) -> List[Dict]:
    """Return the last n events, newest first."""
    try:
        return list(reversed(list(_events)))[:n]
    except Exception:
        return []


def emit_meta(meta_type: str, payload: Dict) -> None:
    """
    Broadcast a meta-event to SSE subscribers without adding it to the event log.
    Meta-events have a 'type' field (new in v1.3) and no 'title', so live-feed.js
    (which guards on `if (ev && ev.title)`) silently ignores them.
    Used by dashboard_presence for state_update / narrator_update / action_update.
    """
    try:
        msg = json.dumps({"type": meta_type, "payload": payload, "ts": time.time()})
        _broadcast_raw(msg)
    except Exception:
        pass


def _broadcast_raw(data: str) -> None:
    """Broadcast a pre-serialised string directly to all SSE subscribers."""
    if not _loop or not _loop.is_running():
        return
    with _subs_lock:
        dead = []
        for q in _subscribers:
            try:
                _loop.call_soon_threadsafe(q.put_nowait, data)
            except Exception:
                dead.append(q)
        for q in dead:
            try:
                _subscribers.remove(q)
            except ValueError:
                pass


# ── Internal broadcast ─────────────────────────────────────────────────────
def _broadcast(event: Dict) -> None:
    if not _loop or not _loop.is_running():
        return
    data = json.dumps(event)
    with _subs_lock:
        dead = []
        for q in _subscribers:
            try:
                _loop.call_soon_threadsafe(q.put_nowait, data)
            except Exception:
                dead.append(q)
        for q in dead:
            try:
                _subscribers.remove(q)
            except ValueError:
                pass


# ── SSE endpoint ───────────────────────────────────────────────────────────
@router.get("/api/events/stream")
async def events_stream(request: Request):
    """
    SSE stream — pushes live TLI events to the Dashboard feed.
    No session required (read-only, LAN-local).
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=128)
    with _subs_lock:
        _subscribers.append(q)

    async def generate():
        try:
            # Replay recent events on connect — capped at 20 items AND 2 hours old.
            # Older events are stale context that shouldn't flood a fresh session.
            cutoff = time.time() - 2 * 3600  # 2 hours ago
            recent = [e for e in get_recent(20) if (e.get("ts") or 0) >= cutoff]
            for ev in reversed(recent):
                yield f"data: {json.dumps(ev)}\n\n"

            # Stream live events
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20.0)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            with _subs_lock:
                try:
                    _subscribers.remove(q)
                except ValueError:
                    pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/events/recent")
async def events_recent(n: int = 50):
    """REST fallback — returns last n events as JSON."""
    return {"events": get_recent(n)}
