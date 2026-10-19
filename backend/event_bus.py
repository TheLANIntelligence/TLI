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

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from browser_authority import browser_control_access

router = APIRouter()

# ── Constants ──────────────────────────────────────────────────────────────
MAX_EVENTS = 200   # bounded in-memory ring buffer
AUTH_CHECK_SECONDS = 1.0
KEEPALIVE_SECONDS = 20.0

# ── State ──────────────────────────────────────────────────────────────────
_events: deque = deque(maxlen=MAX_EVENTS)
_events_lock = threading.Lock()
_stream_id = uuid.uuid4().hex
_sequence = 0
_started_at = time.time()
_subscribers: List[asyncio.Queue] = []
_subs_lock = threading.Lock()
_loop: Optional[asyncio.AbstractEventLoop] = None
_journal = None

# Post-emit hooks: callables invoked after every emit_event() with the full event dict.
# Used by dashboard_presence to classify events and update narrator/action queue.
_post_emit_hooks: List[Any] = []


def register_post_emit_hook(fn) -> None:
    """Register a callable to be called after each emit_event(). Thread-safe."""
    with _subs_lock:
        if fn not in _post_emit_hooks:
            _post_emit_hooks.append(fn)


def unregister_post_emit_hook(fn) -> None:
    with _subs_lock:
        if fn in _post_emit_hooks:
            _post_emit_hooks.remove(fn)


# ── Loop registration (called from main.py on_startup) ─────────────────────
def set_event_loop(loop: Optional[asyncio.AbstractEventLoop]) -> None:
    global _loop
    _loop = loop


def start_activity_history(directory) -> None:
    """Explicit startup only, after security preflight and before event producers."""
    global _journal
    if _journal is not None:
        return
    from activity_history import Journal
    _journal = Journal(directory).start()
    if not _journal.was_clean:
        emit_event("system", "warn", "No clean shutdown was recorded", history_code="unclean")
    emit_event("system", "info", "TLI activity recording started", history_code="started")


def stop_activity_history() -> bool:
    """Call after producers stop. Drain only the owned journal worker, at most 5s."""
    global _journal
    if _journal is None:
        return True
    emit_event("system", "info", "TLI shutdown recorded", history_code="stopped")
    result = _journal.stop()
    # Keep failed/pending workers owned; never start a competing writer.
    if not _journal.thread or not _journal.thread.is_alive():
        _journal = None
    return result


# ── Public emit API ────────────────────────────────────────────────────────
def emit_event(
    category: str,                         # ai | game | mesh | device | automation | system | vault
    level: str,                            # ok | info | warn | alert
    title: str,
    body: str = "",
    node: str = "",
    actions: Optional[List[Dict]] = None,
    *, history_code: Optional[str] = None,
) -> None:
    """
    Publish an event to the live feed.
    Completely safe — swallows all exceptions, never blocks.
    """
    global _sequence
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
        with _events_lock:
            _sequence += 1
            event.update(stream_id=_stream_id, sequence=_sequence)
            _events.append(event)
            if _journal is not None:
                _journal.record(event, history_code)
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
        with _events_lock:
            return [dict(e) for e in reversed(_events)][:max(0, min(n, MAX_EVENTS))]
    except Exception:
        return []


def activity_snapshot() -> dict:
    """One consistent cursor and retained history; no disk or network probes."""
    with _events_lock:
        snapshot = {"cursor": {"stream_id": _stream_id, "sequence": _sequence},
                "started_at": _started_at, "checked_at": time.time(),
                "events": [dict(e) for e in _events], "capacity": MAX_EVENTS}
        if _journal is not None:
            snapshot["history"] = _journal.snapshot()
        return snapshot


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
                _loop.call_soon_threadsafe(_enqueue, q, data)
            except Exception:
                dead.append(q)
        for q in dead:
            try:
                _subscribers.remove(q)
            except ValueError:
                pass


def _enqueue(q: asyncio.Queue, data: str) -> None:
    """Run on the subscriber loop; late callbacks cannot repopulate a closed queue."""
    with _subs_lock:
        if q not in _subscribers:
            return
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            # A slow consumer cannot grow its private backlog without bound.
            # The retained event ring remains available to an authorized reconnect.
            pass


def _unsubscribe(q: asyncio.Queue) -> None:
    with _subs_lock:
        if q in _subscribers:
            _subscribers.remove(q)
        while True:
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                break


# ── Internal broadcast ─────────────────────────────────────────────────────
def _broadcast(event: Dict) -> None:
    _broadcast_raw(json.dumps(event))


class _EventStreamingResponse(StreamingResponse):
    """Own the async generator even if ASGI send fails while it is suspended."""

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()


# ── SSE endpoint ───────────────────────────────────────────────────────────
@router.get("/api/events/stream")
async def events_stream(request: Request, check=Depends(browser_control_access)):
    """
    Browser-only shared host feed; historical events have no per-person owner.
    The original browser authority is rechecked throughout replay and delivery.
    """
    check()
    q: asyncio.Queue = asyncio.Queue(maxsize=128)

    async def generate():
        try:
            check()
            if await request.is_disconnected():
                return
            check()
            # Register only once iteration starts. An unused response cannot
            # leave a queue retaining private activity in the subscriber list.
            with _subs_lock:
                _subscribers.append(q)
            # Replay recent events on connect — capped at 20 items AND 2 hours old.
            # Older events are stale context that shouldn't flood a fresh session.
            cutoff = time.time() - 2 * 3600  # 2 hours ago
            check()
            recent = [e for e in get_recent(20) if (e.get("ts") or 0) >= cutoff]
            for ev in reversed(recent):
                if await request.is_disconnected():
                    return
                check()
                yield f"data: {json.dumps(ev)}\n\n"

            # Stream live events
            last_delivery = time.monotonic()
            while True:
                check()
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=AUTH_CHECK_SECONDS)
                    check()
                    yield f"data: {msg}\n\n"
                    last_delivery = time.monotonic()
                except asyncio.TimeoutError:
                    check()
                    if time.monotonic() - last_delivery >= KEEPALIVE_SECONDS:
                        yield ": keep-alive\n\n"
                        last_delivery = time.monotonic()
        except HTTPException:
            # No error details or retained activity cross a revoked boundary.
            # Unsubscribe before yielding so the terminal frame cannot suspend
            # this generator with a still-active private queue.
            _unsubscribe(q)
            yield 'data: {"type":"auth_required","code":"session_changed"}\n\n'
        finally:
            _unsubscribe(q)

    return _EventStreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/api/events/recent")
async def events_recent(n: int = 50, check=Depends(browser_control_access)):
    """Authorized browser fallback for the shared host-wide history."""
    check()
    events = get_recent(n)
    check()
    return {"events": events}
