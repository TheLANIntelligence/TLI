"""
relay_server.py — TLI built-in WebSocket relay.

Runs in a background thread alongside the FastAPI backend.
Any TLI node can act as a relay by enabling it in federation settings.

Protocol (JSON frames):
  Client → Server:
    {"type": "join",    "room": "<code>", "name": "<display_name>"}
    {"type": "message", "room": "<code>", "text": "<text>"}
    {"type": "ping"}

  Server → Client:
    {"type": "joined",      "room": "<code>", "peers": [...names]}
    {"type": "peer_joined", "name": "<name>", "peers": [...names]}
    {"type": "peer_left",   "name": "<name>", "peers": [...names]}
    {"type": "message",     "from": "<name>", "text": "<text>"}
    {"type": "pong"}
    {"type": "error",       "detail": "<reason>"}
"""
from __future__ import annotations

import asyncio
import json
import logging
import socket
import threading
from collections import defaultdict
from typing import Dict, Optional, Set

log = logging.getLogger("tli.relay")

# ── Shared state (asyncio-native, all access inside the relay event loop) ────
_rooms: Dict[str, Dict[str, object]] = defaultdict(dict)
# _rooms[room_code][ws] = display_name

_relay_loop:   Optional[asyncio.AbstractEventLoop] = None
_relay_thread: Optional[threading.Thread]          = None
_server        = None      # websockets.Server instance
_running       = False
_port          = 9000


# ── Helpers ───────────────────────────────────────────────────────────────────

def _peer_names(room: str) -> list:
    return list(_rooms[room].values())


async def _broadcast(room: str, payload: dict, exclude=None) -> None:
    """Send payload to every connection in the room except exclude."""
    raw = json.dumps(payload)
    dead = []
    for ws, _ in list(_rooms[room].items()):
        if ws is exclude:
            continue
        try:
            await ws.send(raw)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _rooms[room].pop(ws, None)


# ── Per-connection handler ────────────────────────────────────────────────────

async def _handle(ws) -> None:
    room: Optional[str] = None
    name: Optional[str] = None

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue

            mtype = msg.get("type")

            # ── join ──────────────────────────────────────────────
            if mtype == "join":
                room = str(msg.get("room", "")).strip().upper()[:12]
                name = str(msg.get("name", "Unknown"))[:64]
                if not room:
                    await ws.send(json.dumps({"type": "error", "detail": "room required"}))
                    continue

                # Replace existing connection under same name (reconnect)
                stale = [w for w, n in _rooms[room].items() if n == name and w is not ws]
                for w in stale:
                    _rooms[room].pop(w, None)
                    try:
                        await w.close()
                    except Exception:
                        pass

                _rooms[room][ws] = name
                peers = _peer_names(room)

                await ws.send(json.dumps({"type": "joined", "room": room, "peers": peers}))
                await _broadcast(room, {"type": "peer_joined", "name": name, "peers": peers}, exclude=ws)
                log.debug("join room=%s name=%s peers=%d", room, name, len(peers))

            # ── message ───────────────────────────────────────────
            elif mtype == "message":
                if room is None:
                    await ws.send(json.dumps({"type": "error", "detail": "join a room first"}))
                    continue
                text = str(msg.get("text", "")).strip()
                if not text:
                    continue
                await _broadcast(room, {"type": "message", "from": name, "text": text}, exclude=ws)

            # ── ping ──────────────────────────────────────────────
            elif mtype == "ping":
                await ws.send(json.dumps({"type": "pong"}))

    except Exception:
        pass   # connection closed or broken
    finally:
        if room and ws in _rooms[room]:
            _rooms[room].pop(ws, None)
            remaining = _peer_names(room)
            if name:
                await _broadcast(room, {"type": "peer_left", "name": name, "peers": remaining})
            if not _rooms[room]:
                del _rooms[room]
            log.debug("leave room=%s name=%s", room, name)


# ── Server lifecycle ──────────────────────────────────────────────────────────

async def _run_server(host: str, port: int) -> None:
    global _server
    import websockets.asyncio.server as _wss

    async with _wss.serve(_handle, host, port) as srv:
        _server = srv
        log.info("TLI relay listening on %s:%d", host, port)
        await asyncio.get_event_loop().create_future()   # run forever


def _thread_main(host: str, port: int) -> None:
    global _relay_loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _relay_loop = loop
    try:
        loop.run_until_complete(_run_server(host, port))
    except Exception as e:
        log.warning("Relay server stopped: %s", e)
    finally:
        _relay_loop = None


# ── Public API ────────────────────────────────────────────────────────────────

def start(port: int = 9000, host: str = "0.0.0.0") -> bool:
    """
    Start the relay server in a daemon thread.
    Returns True if started, False if already running or port is taken.
    """
    global _relay_thread, _running, _port

    if _running and _relay_thread and _relay_thread.is_alive():
        return False

    # Quick port-availability check
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, port))
        s.close()
    except OSError:
        log.warning("Relay port %d already in use — relay not started", port)
        return False

    _port = port
    _running = True
    _relay_thread = threading.Thread(
        target=_thread_main,
        args=(host, port),
        daemon=True,
        name="tli-relay",
    )
    _relay_thread.start()
    return True


def stop() -> None:
    global _running, _server, _relay_loop
    _running = False
    if _relay_loop and _server:
        try:
            _relay_loop.call_soon_threadsafe(_server.close)
        except Exception:
            pass


def is_running() -> bool:
    return bool(_running and _relay_thread and _relay_thread.is_alive())


def relay_port() -> int:
    return _port


def room_count() -> int:
    return len(_rooms)


def peer_count() -> int:
    return sum(len(v) for v in _rooms.values())


def local_ws_url(port: int | None = None) -> str:
    """Return the ws:// URL peers should use to reach this node's relay."""
    p = port or _port
    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
    except Exception:
        ip = "127.0.0.1"
    return f"ws://{ip}:{p}"
