from __future__ import annotations

# backend/routers/federation_routes.py
# Federated TLI-to-TLI chat — cross-network messaging via WebSocket relay.
#
# Endpoints:
#   GET  /federation/status         — connection state, peer info, relay URL
#   POST /federation/settings       — set relay URL
#   POST /federation/pair/create    — generate pairing code, connect to relay
#   POST /federation/pair/join      — join with a peer's pairing code
#   DELETE /federation/pair         — disconnect and clear pairing
#   POST /federation/message        — send message to federated peer
#   GET  /federation/messages       — message history (last 100, in-memory)
#   GET  /federation/events         — SSE stream for real-time updates to frontend

import asyncio
import json
import random
import string
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import tli_state as S
from routers.system_routes import require_session

router = APIRouter(tags=["federation"])

# ── Constants ────────────────────────────────────────────────────
_DEFAULT_RELAY = "ws://localhost:9000"
_MAX_MESSAGES  = 100
_RECONNECT_DELAY = 5      # seconds between reconnect attempts
_PING_INTERVAL   = 25     # seconds

# ── State ─────────────────────────────────────────────────────────
_state = {
    "connected":    False,
    "connecting":   False,
    "room":         None,     # pairing code (room ID)
    "node_name":    None,
    "peers":        [],       # list of peer names currently online
    "relay_url":    _DEFAULT_RELAY,
    "error":        None,
}
_messages: deque = deque(maxlen=_MAX_MESSAGES)
_ws_client = None             # active websockets.ClientConnection
_ws_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()
_sse_queues: list = []        # list of asyncio.Queue for SSE subscribers
_lock = threading.Lock()


# ── Helpers ───────────────────────────────────────────────────────
def _settings_path() -> Path:
    return Path(S.DATA_DIR) / "federation_settings.json"


def _load_settings() -> dict:
    try:
        p = _settings_path()
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {"relay_url": _DEFAULT_RELAY}


def _save_settings(s: dict):
    p = _settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
    tmp.replace(p)


def _gen_room_code() -> str:
    """Generate a human-readable 6-character pairing code."""
    chars = string.ascii_uppercase + string.digits
    # Remove ambiguous characters
    chars = chars.replace("0", "").replace("O", "").replace("1", "").replace("I", "")
    return "".join(random.choices(chars, k=6))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _node_name() -> str:
    try:
        name = S.get_node_name() if hasattr(S, "get_node_name") else None
        if name:
            return name
    except Exception:
        pass
    return "TLI Node"


def _push_event(payload: dict):
    """Push an event to all SSE subscribers."""
    for q in list(_sse_queues):
        try:
            q.put_nowait(payload)
        except Exception:
            pass


def _add_message(sender: str, text: str, own: bool = False):
    msg = {
        "id":   f"{time.time():.3f}",
        "from": sender,
        "text": text,
        "ts":   _now_iso(),
        "own":  own,
    }
    _messages.append(msg)
    _push_event({"type": "message", **msg})
    return msg


# ── WebSocket client loop (runs in background thread) ─────────────
def _ws_loop(relay_url: str, room: str, node_name: str):
    """Background thread: connects to relay, maintains connection, relays messages."""
    import websockets.sync.client as wsc   # sync API — no event loop needed in thread

    global _ws_client

    while not _stop_event.is_set():
        with _lock:
            _state["connecting"] = True
            _state["error"]      = None

        _push_event({"type": "status", "connecting": True})

        try:
            S.log_debug("federation", "INFO", "Connecting to relay", url=relay_url, room=room)
            with wsc.connect(relay_url, open_timeout=10) as ws:
                with _lock:
                    _ws_client = ws

                # Join room
                ws.send(json.dumps({"type": "join", "room": room, "name": node_name}))

                # Ping loop in background
                ping_t = time.time()

                while not _stop_event.is_set():
                    try:
                        ws.socket.settimeout(5)
                        raw = ws.recv()
                    except TimeoutError:
                        # Send ping
                        if time.time() - ping_t > _PING_INTERVAL:
                            try:
                                ws.send(json.dumps({"type": "ping"}))
                                ping_t = time.time()
                            except Exception:
                                break
                        continue
                    except Exception:
                        break

                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    mtype = msg.get("type")

                    if mtype == "joined":
                        peers = msg.get("peers", [])
                        with _lock:
                            _state["connected"]  = True
                            _state["connecting"] = False
                            _state["peers"]      = peers
                        S.log_debug("federation", "INFO", "Joined relay room", room=room, peers=peers)
                        _push_event({"type": "status", "connected": True, "peers": peers})

                    elif mtype == "peer_joined":
                        name = msg.get("name", "Unknown")
                        with _lock:
                            if name not in _state["peers"]:
                                _state["peers"].append(name)
                        _add_message("system", f"{name} joined the room")
                        _push_event({"type": "peer_joined", "name": name, "peers": list(_state["peers"])})

                    elif mtype == "peer_left":
                        name = msg.get("name", "Unknown")
                        with _lock:
                            _state["peers"] = [p for p in _state["peers"] if p != name]
                        _add_message("system", f"{name} left the room")
                        _push_event({"type": "peer_left", "name": name, "peers": list(_state["peers"])})

                    elif mtype == "message":
                        _add_message(msg.get("from", "Unknown"), msg.get("text", ""), own=False)

                    elif mtype == "pong":
                        ping_t = time.time()

                    elif mtype == "error":
                        err = msg.get("detail", "Relay error")
                        with _lock:
                            _state["error"] = err
                        _push_event({"type": "error", "detail": err})

        except Exception as e:
            err = str(e)
            S.log_debug("federation", "WARN", "Relay disconnected", error=err)
        finally:
            with _lock:
                _ws_client   = None
                _state["connected"]  = False
                _state["connecting"] = False
                _state["peers"]      = []
            _push_event({"type": "status", "connected": False, "peers": []})

        if _stop_event.is_set():
            break
        _stop_event.wait(_RECONNECT_DELAY)

    S.log_debug("federation", "INFO", "WS loop exited")


def _start_ws(relay_url: str, room: str, node_name: str):
    global _ws_thread
    _stop_event.clear()
    _ws_thread = threading.Thread(
        target=_ws_loop,
        args=(relay_url, room, node_name),
        daemon=True,
        name="fed-ws",
    )
    _ws_thread.start()


def _stop_ws():
    global _ws_client
    _stop_event.set()
    with _lock:
        if _ws_client:
            try:
                _ws_client.close()
            except Exception:
                pass
            _ws_client = None
    _state["connected"]  = False
    _state["connecting"] = False
    _state["peers"]      = []
    _state["room"]       = None


# ── Pydantic models ───────────────────────────────────────────────
class FedSettingsRequest(BaseModel):
    relay_url: str


class JoinRequest(BaseModel):
    code: str


class MessageRequest(BaseModel):
    text: str


# ── Routes ────────────────────────────────────────────────────────

@router.get("/federation/status")
def fed_status():
    cfg = _load_settings()
    with _lock:
        return {
            "connected":  _state["connected"],
            "connecting": _state["connecting"],
            "room":       _state["room"],
            "node_name":  _state["node_name"],
            "peers":      list(_state["peers"]),
            "relay_url":  cfg.get("relay_url", _DEFAULT_RELAY),
            "error":      _state["error"],
        }


@router.post("/federation/settings")
def fed_settings(req: FedSettingsRequest, _session: str = Depends(require_session)):
    s = _load_settings()
    s["relay_url"] = req.relay_url.strip()
    _save_settings(s)
    _state["relay_url"] = s["relay_url"]
    return {"ok": True, "relay_url": s["relay_url"]}


@router.post("/federation/pair/create")
def fed_pair_create(_session: str = Depends(require_session)):
    """Generate a pairing code and connect to the relay."""
    if _state["connected"] or _state["connecting"]:
        _stop_ws()
        time.sleep(0.3)

    room      = _gen_room_code()
    cfg       = _load_settings()
    relay_url = cfg.get("relay_url", _DEFAULT_RELAY)
    name      = _node_name()

    with _lock:
        _state["room"]      = room
        _state["node_name"] = name
        _state["error"]     = None

    _messages.clear()
    _start_ws(relay_url, room, name)

    S.log_debug("federation", "INFO", "Pairing code created", room=room)
    return {"ok": True, "code": room, "relay_url": relay_url, "node_name": name}


@router.post("/federation/pair/join")
def fed_pair_join(req: JoinRequest, _session: str = Depends(require_session)):
    """Join a peer's pairing room."""
    code = req.code.strip().upper()[:12]
    if not code:
        raise HTTPException(status_code=400, detail="Code is required")

    if _state["connected"] or _state["connecting"]:
        _stop_ws()
        time.sleep(0.3)

    cfg       = _load_settings()
    relay_url = cfg.get("relay_url", _DEFAULT_RELAY)
    name      = _node_name()

    with _lock:
        _state["room"]      = code
        _state["node_name"] = name
        _state["error"]     = None

    _messages.clear()
    _start_ws(relay_url, code, name)

    S.log_debug("federation", "INFO", "Joining peer room", room=code)
    return {"ok": True, "code": code, "relay_url": relay_url, "node_name": name}


@router.delete("/federation/pair")
def fed_disconnect(_session: str = Depends(require_session)):
    _stop_ws()
    _messages.clear()
    S.log_debug("federation", "INFO", "Disconnected from relay")
    return {"ok": True}


@router.post("/federation/message")
def fed_send(req: MessageRequest, _session: str = Depends(require_session)):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    if not _state["connected"]:
        raise HTTPException(status_code=503, detail="Not connected to relay")

    with _lock:
        ws = _ws_client

    if not ws:
        raise HTTPException(status_code=503, detail="WebSocket not ready")

    try:
        ws.send(json.dumps({"type": "message", "room": _state["room"], "text": text}))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Send failed: {e}")

    msg = _add_message(_state["node_name"] or "Me", text, own=True)
    return {"ok": True, "message": msg}


@router.get("/federation/messages")
def fed_messages():
    return {"messages": list(_messages)}


@router.get("/federation/events")
async def fed_events(request: Request):
    """SSE stream — pushes status changes and new messages to the frontend."""
    q: asyncio.Queue = asyncio.Queue()
    _sse_queues.append(q)

    async def _stream():
        try:
            # Send current status immediately on connect
            with _lock:
                snap = {
                    "type":       "status",
                    "connected":  _state["connected"],
                    "connecting": _state["connecting"],
                    "peers":      list(_state["peers"]),
                    "room":       _state["room"],
                }
            yield f"data: {json.dumps(snap)}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            try:
                _sse_queues.remove(q)
            except ValueError:
                pass

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
