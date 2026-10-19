"""Retired legacy room relay: no new listener or room admission.

The unauthenticated room/name protocol is unavailable. These small lifecycle
helpers retain explicit cleanup for a listener from an already-running process;
no settings are changed and no replacement transport is selected.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import stat
import threading
from collections import defaultdict
from typing import Optional

RETIRED_REASON = (
    "Legacy cross-network relay is unavailable because its room protocol does not "
    "verify peers or protect messages. Trusted LAN messaging and inference are separate."
)

_rooms = defaultdict(dict)
_relay_loop: Optional[asyncio.AbstractEventLoop] = None
_relay_thread: Optional[threading.Thread] = None
_server = None
_running = False
_port = 9000


MAX_SETTINGS_BYTES = 64 * 1024


def read_saved_settings(path, defaults: dict) -> dict:
    """Bounded historical metadata only; never rewrite or follow a linked file."""
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate settings key")
            result[key] = value
        return result

    def finite(raw):
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError("Non-finite settings value")
        return value

    def invalid_constant(raw):
        raise ValueError("Non-finite settings value")

    try:
        before = path.lstat()
    except FileNotFoundError:
        return dict(defaults)
    if (not stat.S_ISREG(before.st_mode)
            or getattr(before, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            or before.st_size > MAX_SETTINGS_BYTES):
        raise ValueError("Unavailable historical settings")
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        if (not stat.S_ISREG(opened.st_mode)
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
            raise ValueError("Historical settings changed during read")
        raw = stream.read(MAX_SETTINGS_BYTES + 1)
    if len(raw) > MAX_SETTINGS_BYTES:
        raise ValueError("Oversized historical settings")
    value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique,
                       parse_constant=invalid_constant, parse_float=finite)
    if not isinstance(value, dict):
        raise ValueError("Invalid historical settings")
    return value


async def _handle(ws) -> None:
    """Refuse even a direct call to the former room admission handler."""
    await ws.close(code=1008, reason="Legacy relay retired")


def start(port: int = 9000, host: str = "0.0.0.0") -> bool:
    """Compatibility entry point: never bind a socket or start a worker."""
    return False


def stop() -> None:
    """Close an existing relay on its owning loop; never start a replacement."""
    global _running, _server
    server, loop = _server, _relay_loop
    if server is None:
        if _relay_thread and _relay_thread.is_alive():
            raise RuntimeError("Existing relay shutdown could not be confirmed.")
        _running = False
        return
    if loop is None or not loop.is_running():
        raise RuntimeError("Existing relay shutdown could not be confirmed.")

    async def close_existing():
        server.close()
        await asyncio.wait_for(server.wait_closed(), timeout=2)

    # This synchronous API is called by a FastAPI worker, never its relay loop.
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None
    if current_loop is loop:
        raise RuntimeError("Relay cleanup must run outside its event loop.")
    pending = asyncio.run_coroutine_threadsafe(close_existing(), loop)
    try:
        pending.result(timeout=3)
    except Exception:
        pending.cancel()
        raise RuntimeError("Existing relay shutdown could not be confirmed.") from None
    _server = None
    _running = False
    _rooms.clear()
    # The retired worker's old run-forever future otherwise keeps its thread alive.
    loop.call_soon_threadsafe(loop.stop)
    if _relay_thread and _relay_thread.is_alive():
        _relay_thread.join(timeout=1)


def is_running() -> bool:
    # A closed listening socket may still have active WebSocket handlers. Only
    # completed wait_closed() clears the handle and confirms cleanup.
    if _server is not None:
        return True
    return bool(_relay_thread and _relay_thread.is_alive())


def relay_port() -> int:
    return _port


def room_count() -> int:
    return len(_rooms)


def peer_count() -> int:
    return sum(len(peers) for peers in _rooms.values())


def local_ws_url(port: int | None = None) -> None:
    """Do not advertise an actionable URL for the retired protocol."""
    return None
