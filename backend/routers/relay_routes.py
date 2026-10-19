"""Private status and explicit cleanup for the retired legacy relay."""
from __future__ import annotations

from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException

from browser_authority import browser_control_access
import relay_server as _relay
import tli_state as S

router = APIRouter(tags=["relay"])


def _settings_path() -> Path:
    return Path(S.DATA_DIR) / "relay_settings.json"


def _load_settings() -> dict:
    try:
        value = _relay.read_saved_settings(_settings_path(), {"enabled": False, "port": 9000})
        if ("enabled" in value and type(value["enabled"]) is not bool
                or "port" in value and (type(value["port"]) is not int or not 1 <= value["port"] <= 65535)):
            raise ValueError()
        return value
    except (OSError, ValueError, TypeError, RecursionError):
        raise HTTPException(503, "Saved relay settings could not be read. They have been preserved.",
                            headers={"Cache-Control": "no-store"}) from None


def autostart() -> None:
    """Legacy startup hook intentionally does not read settings or open sockets."""
    return None


@router.get("/relay/status")
def relay_status(check=Depends(browser_control_access)):
    check()
    try:
        running = _relay.is_running()
        check()
        cfg = _load_settings()
        check()
        result = {
            "available": False, "retired": True, "reason": _relay.RETIRED_REASON,
            "running": running, "enabled": False,
            "saved_enabled": cfg.get("enabled", False),
            "port": _relay.relay_port() if running else cfg.get("port", 9000),
            "rooms": _relay.room_count() if running else 0,
            "peers": _relay.peer_count() if running else 0,
            "ws_url": None,
        }
    except Exception as error:
        check()
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(503, "Relay status could not be read. Check status before any cleanup.",
                            headers={"Cache-Control": "no-store"}) from None
    check()
    return result


@router.post("/relay/start")
def relay_start(check=Depends(browser_control_access)):
    check()
    raise HTTPException(410, _relay.RETIRED_REASON, headers={"Cache-Control": "no-store"})


@router.post("/relay/stop")
def relay_stop(check=Depends(browser_control_access)):
    check()
    try:
        _relay.stop()
        check()
        if _relay.is_running():
            raise RuntimeError("Listener is still running")
    except HTTPException:
        check()
        raise
    except Exception:
        check()
        raise HTTPException(503, "Relay shutdown could not be confirmed. Check status before retrying.",
                            headers={"Cache-Control": "no-store"}) from None
    check()
    return {"ok": True, "running": False, "available": False}
