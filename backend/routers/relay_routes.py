"""
relay_routes.py — Manage the built-in TLI WebSocket relay.

GET  /relay/status          — is relay running, port, active rooms/peers
POST /relay/start           — start relay (optionally on a custom port)
POST /relay/stop            — stop relay
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import relay_server as _relay
import tli_state as S

router = APIRouter(tags=["relay"])

_SETTINGS_PATH = None


def _settings_path() -> Path:
    return Path(S.DATA_DIR) / "relay_settings.json"


def _load_settings() -> dict:
    try:
        p = _settings_path()
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {"enabled": False, "port": 9000}


def _save_settings(s: dict) -> None:
    p = _settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
    tmp.replace(p)


def autostart() -> None:
    """Called at TLI startup — starts relay if it was previously enabled."""
    cfg = _load_settings()
    if cfg.get("enabled"):
        port = int(cfg.get("port", 9000))
        started = _relay.start(port=port)
        S.log_debug("relay", "INFO" if started else "WARN",
                    "Relay autostart", port=port, started=started)


# ── Pydantic ──────────────────────────────────────────────────────

class RelayStartRequest(BaseModel):
    port: int = 9000


# ── Routes ────────────────────────────────────────────────────────

@router.get("/relay/status")
def relay_status():
    running = _relay.is_running()
    cfg = _load_settings()
    return {
        "running":    running,
        "enabled":    cfg.get("enabled", False),
        "port":       _relay.relay_port() if running else cfg.get("port", 9000),
        "rooms":      _relay.room_count()  if running else 0,
        "peers":      _relay.peer_count()  if running else 0,
        "ws_url":     _relay.local_ws_url() if running else None,
    }


@router.post("/relay/start")
def relay_start(req: RelayStartRequest):
    if _relay.is_running():
        return {"ok": True, "already_running": True,
                "ws_url": _relay.local_ws_url()}

    port = max(1024, min(65535, req.port))
    started = _relay.start(port=port)
    if not started:
        raise HTTPException(status_code=409,
                            detail=f"Could not start relay on port {port}. "
                                   "Port may already be in use.")

    cfg = _load_settings()
    cfg["enabled"] = True
    cfg["port"] = port
    _save_settings(cfg)

    ws_url = _relay.local_ws_url(port)
    S.log_debug("relay", "INFO", "Relay started", port=port, ws_url=ws_url)
    return {"ok": True, "port": port, "ws_url": ws_url}


@router.post("/relay/stop")
def relay_stop():
    _relay.stop()
    cfg = _load_settings()
    cfg["enabled"] = False
    _save_settings(cfg)
    S.log_debug("relay", "INFO", "Relay stopped")
    return {"ok": True}
