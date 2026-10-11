from __future__ import annotations

# backend/routers/satellite_routes.py
# Satellite phone onboarding and presence for the TLI mesh.
#
# Endpoints:
#   POST /mesh/satellite/generate-token  — desktop generates a QR-code join link
#   POST /mesh/satellite/register        — phone redeems the token, gets node_id + secret
#   POST /mesh/satellite/heartbeat       — phone pings in with battery / connection data
#   GET  /mesh/satellite/list            — desktop reads satellite node list (no secrets)
#   DELETE /mesh/satellite/{node_id}     — desktop removes a satellite

import base64
import io
import json
import secrets
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import tli_state as S

router = APIRouter(tags=["satellite"])

# ── In-memory join token store ───────────────────────────────────
# { token_hex: { "expires": float } }
_join_tokens: dict[str, dict] = {}
_TOKEN_TTL = 600  # 10 minutes

# ── Helpers ──────────────────────────────────────────────────────

def _reg_path() -> Path:
    return Path(S.DATA_DIR) / "satellite_registry.json"


def _load_reg() -> list:
    p = _reg_path()
    try:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8")) or []
    except Exception:
        pass
    return []


def _save_reg(reg: list) -> None:
    p = _reg_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(reg, indent=2), encoding="utf-8")
    tmp.replace(p)


def _purge_expired_tokens() -> None:
    now = time.time()
    stale = [t for t, v in _join_tokens.items() if v["expires"] < now]
    for t in stale:
        del _join_tokens[t]


def _make_qr_data_uri(url: str) -> Optional[str]:
    """Return a base64 SVG data URI themed in TLI colours (emerald on dark).
    Returns None if the qrcode package is not installed."""
    try:
        import qrcode                   # type: ignore
        import qrcode.image.svg         # type: ignore

        buf = io.BytesIO()
        img = qrcode.make(
            url,
            image_factory=qrcode.image.svg.SvgPathFillImage,
            box_size=8,
            border=3,
        )
        img.save(buf)
        svg = buf.getvalue().decode("utf-8")
        # Replace default black/white with TLI emerald / dark bg
        svg = svg.replace("#000000", "#35c98b").replace("#ffffff", "#07101a")
        return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
    except Exception:
        return None


# ── Pydantic models ───────────────────────────────────────────────

class RegisterRequest(BaseModel):
    token: str
    name: str = "Phone"
    platform: str = "unknown"   # "android" | "ios" | "unknown"


class HeartbeatRequest(BaseModel):
    node_id: str
    secret: str
    battery_level:    Optional[int]  = None   # 0–100
    battery_charging: Optional[bool] = None
    connection_type:  Optional[str]  = None   # "wifi" | "cellular" | "unknown"
    platform:         Optional[str]  = None


# ── Routes ────────────────────────────────────────────────────────

@router.post("/mesh/satellite/generate-token")
def generate_token(request: Request):
    """Desktop calls this to produce a QR-code join link."""
    _purge_expired_tokens()

    token = secrets.token_hex(8)
    _join_tokens[token] = {"expires": time.time() + _TOKEN_TTL}

    host   = request.headers.get("host", "localhost:8000")
    scheme = "https" if S.TLS_ENABLED else "http"
    url    = f"{scheme}://{host}/?join=satellite&token={token}"
    qr     = _make_qr_data_uri(url)

    S.log_debug("satellite", "INFO", "Join token generated", url=url)
    return {
        "ok":         True,
        "token":      token,
        "url":        url,
        "qr":         qr,           # base64 SVG data URI or null
        "expires_in": _TOKEN_TTL,
    }


@router.post("/mesh/satellite/register")
def register(req: RegisterRequest):
    """Phone calls this once to join the mesh."""
    _purge_expired_tokens()

    if req.token not in _join_tokens:
        raise HTTPException(
            status_code=403,
            detail="Invalid or expired join token. Ask the desktop to generate a new QR code.",
        )
    del _join_tokens[req.token]   # one-time use

    reg         = _load_reg()
    node_id     = "sat_" + uuid.uuid4().hex[:10]
    node_secret = secrets.token_hex(20)
    now_iso     = datetime.utcnow().isoformat() + "Z"

    entry: dict = {
        "node_id":          node_id,
        "secret":           node_secret,
        "name":             (req.name or "Phone").strip()[:32],
        "platform":         req.platform,
        "registered_at":    now_iso,
        "last_seen":        now_iso,
        "online":           True,
        "battery_level":    None,
        "battery_charging": None,
        "connection_type":  None,
    }
    reg.append(entry)
    _save_reg(reg)

    S.log_debug("satellite", "INFO", "Satellite registered",
                node_id=node_id, name=entry["name"], platform=req.platform)

    return {
        "ok":      True,
        "node_id": node_id,
        "secret":  node_secret,
        "name":    entry["name"],
    }


@router.post("/mesh/satellite/heartbeat")
def heartbeat(req: HeartbeatRequest):
    """Phone calls this every 30 s to stay "online" and push telemetry."""
    reg = _load_reg()
    for entry in reg:
        if (entry.get("node_id") == req.node_id
                and entry.get("secret") == req.secret):
            entry["last_seen"] = datetime.utcnow().isoformat() + "Z"
            entry["online"]    = True
            if req.battery_level is not None:
                entry["battery_level"]   = max(0, min(100, int(req.battery_level)))
            if req.battery_charging is not None:
                entry["battery_charging"] = bool(req.battery_charging)
            if req.connection_type is not None:
                entry["connection_type"] = str(req.connection_type)[:32]
            if req.platform is not None:
                entry["platform"] = str(req.platform)[:32]
            _save_reg(reg)
            return {"ok": True}

    raise HTTPException(
        status_code=403,
        detail="Unknown satellite or invalid secret.",
    )


@router.get("/mesh/satellite/list")
def list_satellites():
    """Desktop reads this to display satellite cards in the Mesh panel."""
    reg  = _load_reg()
    now  = time.time()
    safe = []
    for entry in reg:
        try:
            last   = datetime.fromisoformat(entry["last_seen"].rstrip("Z"))
            online = (now - last.timestamp()) < 120   # silent > 2 min → offline
        except Exception:
            online = False
        row = {k: v for k, v in entry.items() if k != "secret"}
        row["online"] = online
        safe.append(row)
    return {"satellites": safe}


@router.delete("/mesh/satellite/{node_id}")
def remove_satellite(node_id: str):
    """Desktop removes a satellite from the registry."""
    reg    = _load_reg()
    before = len(reg)
    reg    = [e for e in reg if e.get("node_id") != node_id]
    _save_reg(reg)
    S.log_debug("satellite", "INFO", "Satellite removed", node_id=node_id)
    return {"ok": True, "removed": before - len(reg)}
