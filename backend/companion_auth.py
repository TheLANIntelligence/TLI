"""Owner-mapped companion credentials and shared browser/bearer authentication.

Only hashes of pairing tokens and device credentials reach disk. The single
Uvicorn process serializes each read/modify/replace transaction with LOCK.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Request
from starlette.responses import JSONResponse
import tli_state as S

LOCK = threading.RLock()
PAIRING_TTL = 300


def _path() -> Path:
    return Path(S.DATA_DIR) / "companion" / "credentials.json"


def _read() -> dict:
    path = _path()
    if not path.exists():
        return {"version": 1, "pairings": {}, "devices": {}, "preferences": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if value["version"] != 1 or any(not isinstance(value[k], dict) for k in ("pairings", "devices", "preferences")):
            raise ValueError("Invalid companion store")
        return value
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "The companion credential store could not be read. Restore it before pairing devices.")


def _write(value: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".credentials-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _iso(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def create_pairing(owner: str, origin: str, fingerprint: str) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    now = time.time()
    expires = now + PAIRING_TTL
    with LOCK:
        state = _read()
        state["pairings"] = {k: v for k, v in state["pairings"].items() if v["expires"] > now}
        if sum(v["owner_id"] == owner for v in state["pairings"].values()) >= 10:
            raise HTTPException(429, "Wait for an existing pairing code to expire before generating another.")
        state["pairings"][_hash(token)] = {"owner_id": owner, "origin": origin, "fingerprint": fingerprint, "expires": expires}
        _write(state)
    return token, _iso(expires)


def redeem_pairing(token: str, origin: str, fingerprint: str, name: str, platform: str) -> dict:
    with LOCK:
        state = _read()
        key = _hash(token)
        pairing = state["pairings"].get(key)
        if not pairing or pairing["expires"] <= time.time():
            raise HTTPException(403, "This pairing code is invalid, expired, or already used. Generate a new code on the desktop.")
        if pairing["origin"] != origin or not secrets.compare_digest(pairing["fingerprint"], fingerprint):
            raise HTTPException(403, "The server address or certificate changed. Generate a new pairing code.")
        if sum(v["owner_id"] == pairing["owner_id"] and not v.get("revoked_at") for v in state["devices"].values()) >= 50:
            raise HTTPException(409, "Remove an unused paired device before adding another.")
        device_id = "comp_" + secrets.token_hex(12)
        credential = "tlic_" + secrets.token_urlsafe(32)
        state["devices"][device_id] = {
            "id": device_id, "owner_id": pairing["owner_id"], "credential_hash": _hash(credential),
            "name": name, "platform": platform, "created_at": _iso(time.time()), "revoked_at": None,
        }
        del state["pairings"][key]
        _write(state)
        return {"device_id": device_id, "credential": credential, "owner_id": pairing["owner_id"]}


def credential_owner(credential: str) -> str:
    if not credential.startswith("tlic_") or len(credential) > 256:
        raise HTTPException(401, "Invalid companion credential.")
    candidate = _hash(credential)
    with LOCK:
        for entry in _read()["devices"].values():
            if not entry.get("revoked_at") and secrets.compare_digest(entry["credential_hash"], candidate):
                return entry["owner_id"]
    raise HTTPException(401, "Companion credential expired or revoked. Pair this device again.")


def resolve_user(request=None, tli_session=None, *, allow_anonymous: bool = False) -> str | None:
    """Explicit Authorization always wins and can never fall back to local mode."""
    authorization = request.headers.get("authorization") if request is not None else None
    if authorization is not None:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise HTTPException(401, "Use a valid Bearer companion credential.")
        owner = credential_owner(parts[1])
        if request.url.scheme != "https":
            raise HTTPException(403, "Companion credentials require HTTPS.")
        return owner
    if request is not None:
        tli_session = request.cookies.get("tli_session")
    if isinstance(tli_session, str) and S.validate_session_token(tli_session):
        return S.get_session_user_id(tli_session)
    if not S.load_pin_config()["enabled"]:
        return "local"
    if allow_anonymous:
        return None
    raise HTTPException(401, "TLI session required. Unlock from the browser.")


async def validate_authorization(request: Request, call_next):
    """Fail closed for signed requests even on legacy public read endpoints."""
    if request.url.path == "/api/mcp":
        # The exact optional MCP endpoint uses its own owner/PIN-session-bound
        # temporary Bearer grants and loopback gate. No prefix or sibling bypass.
        from mcp_bridge import credential
        try:
            credential(request)
        except HTTPException as error:
            return JSONResponse({"detail": error.detail}, status_code=error.status_code,
                                headers={"Cache-Control": "no-store"})
        return await call_next(request)
    if request.headers.get("authorization") is not None:
        try:
            if len(request.headers.getlist("authorization")) != 1:
                raise HTTPException(401, "Supply one Authorization header.")
            resolve_user(request)
        except HTTPException as error:
            return JSONResponse({"detail": error.detail}, status_code=error.status_code,
                                headers={"Cache-Control": "no-store"})
    return await call_next(request)


def desktop_owner(request: Request) -> str:
    """Pairing authority must come from an actual PIN-enabled browser session."""
    if request.headers.get("authorization") is not None:
        # Validate first so malformed/revoked credentials consistently return 401.
        resolve_user(request)
        raise HTTPException(403, "Generate pairing codes from the unlocked desktop browser.")
    if not S.load_pin_config()["enabled"]:
        raise HTTPException(409, "Set a desktop PIN before pairing a companion.")
    token = request.cookies.get("tli_session")
    if not token or not S.validate_session_token(token):
        raise HTTPException(401, "Unlock the desktop with its PIN before pairing a companion.")
    origin = request.headers.get("origin")
    expected = str(request.base_url).rstrip("/")
    if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin != expected):
        raise HTTPException(403, "Pair devices from the TLI desktop page.")
    return S.get_session_user_id(token)


def operation_access(request: Request, owner: str):
    """Bind multi-step work to its initially authenticated credential generation."""
    authorization = request.headers.get("authorization")
    token = request.cookies.get("tli_session")
    if authorization is not None:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer" or request.url.scheme != "https":
            raise HTTPException(401, "A valid secure session is required.")
        credential = parts[1]
        def valid():
            return credential_owner(credential) == owner
    elif token is not None and S.validate_session_token(token):
        # A valid credential captured before work stays bound to this operation.
        # Revocation after this point must never fall back to open-local access.
        def valid():
            return (S.validate_session_token(token) and S.get_session_user_id(token) == owner
                    and S.validate_session_token(token))
    else:
        # require_session has already resolved local-owner access. A stale cookie
        # at initial admission is harmless when PIN removal deliberately opened
        # local access; a new explicit request may use it without clearing cookies.
        # Enabling PIN protection invalidates this original open-local authority.
        def valid():
            return owner == "local" and not S.load_pin_config()["enabled"]
    def check():
        try:
            if valid():
                return
        except Exception:
            pass
        raise HTTPException(401, "Execution stopped because the original access expired, was locked or was revoked. Remaining steps were not run.")
    check()
    return check


def paired_devices(owner: str) -> list[dict]:
    with LOCK:
        return [{k: v for k, v in entry.items() if k not in ("owner_id", "credential_hash")}
                for entry in _read()["devices"].values() if entry["owner_id"] == owner]


def revoke_device(owner: str, device_id: str) -> None:
    with LOCK:
        state = _read()
        entry = state["devices"].get(device_id)
        if not entry or entry["owner_id"] != owner:
            raise HTTPException(404, "Paired device not found.")
        entry["revoked_at"] = entry.get("revoked_at") or _iso(time.time())
        _write(state)


def preferences(owner: str, value: dict | None = None) -> dict:
    with LOCK:
        state = _read()
        if value is not None:
            state["preferences"][owner] = value
            _write(state)
        return state["preferences"].get(owner, {"favorite_devices": [], "favorite_scenes": [], "theme": "system"})
