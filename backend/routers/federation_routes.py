"""Private historical reads and cleanup for the retired room-based federation.

This protocol is independent of trusted LAN messaging, inference and Companion.
Neither old settings nor old internal entry points can initiate a connection.
"""
from __future__ import annotations

import threading
from collections import deque
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

import tli_state as S
from browser_authority import browser_control_access
from relay_server import RETIRED_REASON, read_saved_settings

router = APIRouter(tags=["federation"])
_DEFAULT_RELAY = "ws://localhost:9000"
_MAX_MESSAGES = 100
_state = {
    "connected": False, "connecting": False, "room": None, "node_name": None,
    "peers": [], "relay_url": _DEFAULT_RELAY, "error": None,
}
_messages: deque = deque(maxlen=_MAX_MESSAGES)
_ws_client = None
_ws_thread = None
_stop_event = threading.Event()
_lock = threading.Lock()


def _settings_path() -> Path:
    return Path(S.DATA_DIR) / "federation_settings.json"


def _load_settings() -> dict:
    try:
        value = read_saved_settings(_settings_path(), {"relay_url": _DEFAULT_RELAY})
        if "relay_url" in value and (not isinstance(value["relay_url"], str) or len(value["relay_url"]) > 4096):
            raise ValueError()
        return value
    except (OSError, ValueError, TypeError, RecursionError):
        raise HTTPException(503, "Saved federation settings could not be read. They have been preserved.",
                            headers={"Cache-Control": "no-store"}) from None


def _ws_loop(relay_url: str, room: str, node_name: str):
    """Compatibility entry point: no connection, reconnect, send or log."""
    return False


def _start_ws(relay_url: str, room: str, node_name: str):
    """Compatibility entry point: never create a transport worker."""
    return False


def _stop_ws():
    """Request and confirm closure without discarding retained messages."""
    global _ws_client
    _stop_event.set()
    with _lock:
        client = _ws_client
    if client is not None:
        client.close()
    thread = _ws_thread
    if thread is not None and thread.is_alive():
        thread.join(timeout=1)
        if thread.is_alive():
            raise RuntimeError("Federation shutdown could not be confirmed")
    with _lock:
        _ws_client = None
        _state["connected"] = False
        _state["connecting"] = False
        _state["peers"] = []
        # Keep the historical room/node and history for the private read-only view.


@router.get("/federation/status")
def fed_status(check=Depends(browser_control_access)):
    check()
    try:
        cfg = _load_settings()
        check()
        with _lock:
            result = {
                "available": False, "retired": True, "reason": RETIRED_REASON,
                "connected": _state["connected"], "connecting": _state["connecting"],
                "room": _state["room"], "node_name": _state["node_name"],
                "peers": list(_state["peers"]),
                "relay_url": cfg.get("relay_url", _DEFAULT_RELAY),
                "error": _state["error"],
            }
    except Exception as error:
        check()
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(503, "Saved federation information could not be read.",
                            headers={"Cache-Control": "no-store"}) from None
    check()
    return result


@router.post("/federation/settings")
@router.post("/federation/pair/create")
@router.post("/federation/pair/join")
@router.post("/federation/message")
@router.get("/federation/events")
def federation_retired(check=Depends(browser_control_access)):
    check()
    raise HTTPException(410, RETIRED_REASON, headers={"Cache-Control": "no-store"})


@router.delete("/federation/pair")
def fed_disconnect(check=Depends(browser_control_access)):
    check()
    try:
        _stop_ws()
    except Exception:
        check()
        raise HTTPException(503, "Federation shutdown could not be confirmed. Check status before retrying.",
                            headers={"Cache-Control": "no-store"}) from None
    check()
    return {"ok": True, "connected": False, "available": False}


@router.get("/federation/messages")
def fed_messages(check=Depends(browser_control_access)):
    check()
    try:
        with _lock:
            result = {"messages": list(_messages)}
    except Exception as error:
        check()
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(503, "Saved federation information could not be read.",
                            headers={"Cache-Control": "no-store"}) from None
    check()
    return result
