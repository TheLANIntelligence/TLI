"""Legacy satellite presence: browser enrollment, narrowly scoped phone secrets."""
from __future__ import annotations

import base64
import copy
from contextlib import contextmanager
from datetime import datetime, timezone
import io
from pathlib import Path
import secrets
import time
from typing import Optional
import uuid

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from browser_authority import browser_control_access, browser_request_local
import satellite_store as store
import tli_state as S

class _SatelliteRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private_response(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                # Default validation details echo input, including pairing
                # secrets. These routes need neither cached nor echoed input.
                return JSONResponse({"detail": "Provide valid satellite request fields."}, status_code=422,
                                    headers={"Cache-Control": "no-store"})
            response.headers["Cache-Control"] = "no-store"
            return response
        return private_response


router = APIRouter(tags=["satellite"], route_class=_SatelliteRoute)
_join_tokens: dict[str, dict] = {}
_TOKEN_TTL = 600
_TOKEN_LIMIT = 128
_now = time.monotonic


def _reg_path() -> Path:
    return Path(S.DATA_DIR) / "satellite_registry.json"


def _load_reg(*, check=None) -> list:
    return store.read(_reg_path(), check=check)


def _save_reg(reg, *, check=None, expected=store._UNSET, before_commit=None):
    return store.write(_reg_path(), reg, check=check, expected=expected, before_commit=before_commit)


@contextmanager
def _operation(check):
    try:
        check()
        try:
            yield
        finally:
            check()
    except HTTPException as error:
        error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
        raise


def _browser(request, response):
    try:
        return browser_control_access(request, response)
    except HTTPException as error:
        error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
        raise


def _phone(request, response):
    # Explicit token/secret authority, independent of the phone's PIN cookie.
    # Transport errors must not be mistaken for a revoked satellite pairing.
    with _operation(lambda: None):
        browser_request_local(request, response)


def _purge_expired_tokens():
    for token, value in list(_join_tokens.items()):
        if value["expires"] <= _now():
            del _join_tokens[token]


def _invalid_token():
    return HTTPException(403, "Invalid or expired join token. Ask the desktop to generate a new QR code.")


def _issuer_access(record):
    if record["epoch"] is not S.session_revocation_epoch():
        raise HTTPException(401, "TLI protection changed after this invitation was issued. Generate a new join link.")
    record["check"]()
    if record["epoch"] is not S.session_revocation_epoch():
        raise HTTPException(401, "TLI protection changed after this invitation was issued. Generate a new join link.")


def _token_access(token, record):
    if "denial" in record:
        raise record["denial"]
    if _join_tokens.get(token) is not record or record["expires"] <= _now():
        raise _invalid_token()
    try:
        _issuer_access(record)
    except HTTPException as error:
        # Invalid issuing authority cannot be restored by another browser login.
        _join_tokens.pop(token, None)
        record["denial"] = error
        raise


def _credential(reg, node_id, secret):
    for entry in reg:
        if (secrets.compare_digest(entry["node_id"], node_id)
                and secrets.compare_digest(entry["secret"], secret)):
            return entry
    raise HTTPException(403, {"code": "satellite_credential_invalid",
                              "message": "Unknown satellite or invalid secret."})


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


class RegisterRequest(BaseModel):
    token: str = Field(min_length=1, max_length=128, pattern=r"^[0-9a-f]+$")
    name: str = Field(default="Phone", max_length=128)
    platform: str = Field(default="unknown", max_length=32)


class SatelliteCredential(BaseModel):
    node_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    secret: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")


class HeartbeatRequest(SatelliteCredential):
    battery_level: Optional[int] = Field(default=None, ge=0, le=100, strict=True)
    battery_charging: Optional[bool] = Field(default=None, strict=True)
    connection_type: Optional[str] = Field(default=None, max_length=32)
    platform: Optional[str] = Field(default=None, max_length=32)


@router.post("/mesh/satellite/generate-token")
def generate_token(request: Request, response: Response):
    epoch = S.session_revocation_epoch()
    browser_check = _browser(request, response)
    token = secrets.token_hex(32)
    record = {"epoch": epoch, "check": browser_check}
    def check():
        try:
            _issuer_access(record)
        except HTTPException:
            with store.LOCK:
                _join_tokens.pop(token, None)
            raise
    # Fragments do not travel in HTTP request targets or Referer headers.
    url = str(request.base_url).rstrip("/") + "/#join=satellite&token=" + token
    with _operation(check):
        qr = _make_qr_data_uri(url)
        with store.LOCK:
            check()
            _purge_expired_tokens()
            if len(_join_tokens) >= _TOKEN_LIMIT:
                raise HTTPException(429, "Too many active join links. Wait for an existing link to expire.")
            record["expires"] = _now() + _TOKEN_TTL
            _join_tokens[token] = record
            try:
                check()
            except Exception:
                _join_tokens.pop(token, None)
                raise
        return {"ok": True, "token": token, "url": url, "qr": qr, "expires_in": _TOKEN_TTL}


@router.post("/mesh/satellite/register")
def register(req: RegisterRequest, request: Request, response: Response):
    _phone(request, response)
    with _operation(lambda: None), store.LOCK:
        _purge_expired_tokens()
        record = _join_tokens.get(req.token)
        if record is None:
            raise _invalid_token()
        consumed = False
        def authority():
            if consumed:
                _issuer_access(record)
                if record["expires"] <= _now():
                    raise _invalid_token()
            else:
                _token_access(req.token, record)
        with _operation(authority):
            reg = _load_reg(check=authority)
            if len(reg) >= store.MAX_ROWS:
                raise HTTPException(409, "The satellite registry is full. Remove an unused phone before enrolling another.")
            node_id = "sat_" + uuid.uuid4().hex[:10]
            node_secret = secrets.token_hex(20)
            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            entry = {"node_id": node_id, "secret": node_secret, "name": (req.name.strip() or "Phone")[:32],
                     "platform": req.platform, "registered_at": now_iso, "last_seen": now_iso,
                     "online": True, "battery_level": None, "battery_charging": None, "connection_type": None}
            # Consume only once persistence is ready to commit. Any subsequent
            # failure is uncertain and must never enroll another copy on retry.
            def consume():
                nonlocal consumed
                authority()
                del _join_tokens[req.token]
                consumed = True
            # Final disclosure needs issuer authority but cannot re-redeem the
            # deliberately consumed token.
            _save_reg([*reg, entry], check=authority, expected=reg, before_commit=consume)
            return {"ok": True, "node_id": node_id, "secret": node_secret, "name": entry["name"]}


@router.post("/mesh/satellite/heartbeat")
def heartbeat(req: HeartbeatRequest, request: Request, response: Response):
    _phone(request, response)
    with _operation(lambda: None), store.LOCK:
        reg = _load_reg()
        original = copy.deepcopy(reg)
        entry = _credential(reg, req.node_id, req.secret)
        entry["last_seen"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        entry["online"] = True
        for field in ("battery_level", "battery_charging", "connection_type", "platform"):
            value = getattr(req, field)
            if value is not None:
                entry[field] = value
        _save_reg(reg, expected=original)
        return {"ok": True}


@router.post("/mesh/satellite/self-remove")
def self_remove(req: SatelliteCredential, request: Request, response: Response):
    _phone(request, response)
    with _operation(lambda: None), store.LOCK:
        reg = _load_reg()
        entry = _credential(reg, req.node_id, req.secret)
        _save_reg([row for row in reg if row is not entry], expected=reg)
        return {"ok": True, "removed": True}


@router.get("/mesh/satellite/list")
def list_satellites(request: Request, response: Response):
    check = _browser(request, response)
    with _operation(check):
        reg = _load_reg(check=check)
        now = time.time()
        safe = []
        for entry in reg:
            check()
            last = entry.get("last_seen")
            timestamp = datetime.fromisoformat(last.replace("Z", "+00:00")) if last else None
            if timestamp is not None and timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            row = {key: entry[key] for key in ("node_id", "name", "platform", "registered_at", "last_seen",
                                              "battery_level", "battery_charging", "connection_type") if key in entry}
            row["online"] = bool(timestamp is not None and 0 <= now - timestamp.timestamp() < 120)
            safe.append(row)
        return {"satellites": safe}


@router.delete("/mesh/satellite/{node_id}")
def remove_satellite(node_id: str, request: Request, response: Response):
    check = _browser(request, response)
    with _operation(check), store.LOCK:
        check()
        reg = _load_reg(check=check)
        updated = [entry for entry in reg if entry["node_id"] != node_id]
        if len(updated) != len(reg):
            _save_reg(updated, check=check, expected=reg)
        return {"ok": True, "removed": len(reg) - len(updated)}
