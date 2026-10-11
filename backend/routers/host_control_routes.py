"""Main-backend advertisement and restricted grant; never remote provisioning."""
import ipaddress
import asyncio
import hashlib
import hmac
import os
import signal
import secrets
import time
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

import companion_auth
import host_control as H
import tli_state as S
from routers.system_routes import require_session

router = APIRouter(prefix="/api/host-control/v1", tags=["host-control"])
_shutdown_task = None
_INSTANCE_ID = secrets.token_hex(24)


async def _watch_local_stop():
    import psutil
    created = psutil.Process(os.getpid()).create_time()
    while True:
        await asyncio.sleep(0.5)
        try:
            identity = H.installation(S.BASE_DIR)
            if os.environ.get('TLI_MANAGED_CHILD') != identity['installation_id']:
                return
            if H.local_stop_requested(S.BASE_DIR, os.getpid(), created):
                signal.raise_signal(signal.SIGINT)  # Uvicorn's normal captured shutdown signal
                return
        except FileNotFoundError:
            pass
        except Exception:
            # Unreadable/mismatched requests must never stop the backend.
            pass


@router.on_event('startup')
async def start_local_stop_monitor():
    global _shutdown_task
    if os.environ.get('TLI_MANAGED_CHILD'):
        try:
            identity = H.installation(S.BASE_DIR)
            if os.environ['TLI_MANAGED_CHILD'] == identity['installation_id']:
                _shutdown_task = asyncio.create_task(_watch_local_stop())
        except Exception:
            pass


@router.on_event('shutdown')
async def stop_local_stop_monitor():
    global _shutdown_task
    if _shutdown_task:
        _shutdown_task.cancel()
        _shutdown_task = None
INSTRUCTIONS = [
    "On this Windows computer, run TLI_Setup.ps1 and choose Enable phone host start. Setup verifies your existing desktop PIN, secure LAN settings and certificate.",
    "Choose Start helper, then optionally enable its same-user Start at sign-in shortcut. This is a background helper, not a Windows service before sign-in.",
    "Open Companion while TLI is running, explicitly review this helper and save its restricted access on the phone.",
    "The computer must remain awake and signed in. Wake-on-LAN and internet port forwarding are not provided.",
    "Use TLI_Setup.ps1 Status, StopHelper or DisableHostStart locally. Disabling, changing the PIN/certificate, or revoking the phone removes its startup authority.",
]


def metadata(request):
    return H.descriptor(S.BASE_DIR, (request.url.hostname or "") if request is not None else "")


@router.get("/setup")
def setup(request: Request, response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return {"schema_version": 1, "host_control": metadata(request), "instructions": INSTRUCTIONS, "setup_command": "TLI_Setup.ps1"}


class GrantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    helper_id: str = Field(pattern=r"^[0-9a-f]{32,64}$")
    node_id: str = Field(min_length=1, max_length=128)


@router.post("/grant")
def grant(body: GrantRequest, request: Request, response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    if request.url.scheme != "https" or not S.TLS_ENABLED:
        raise HTTPException(403, "Review helper access over the original paired HTTPS connection.")
    values = request.headers.getlist("authorization")
    if len(values) != 1 or not values[0].startswith("Bearer tlic_"):
        raise HTTPException(401, "Only an existing paired phone can request restricted helper access.")
    try:
        advertised = metadata(request)
        if not advertised["available"]:
            raise HTTPException(409, advertised["reason"])
        credential = H.grant(S.BASE_DIR, values[0][7:], body.helper_id, body.node_id)
        return {"schema_version": 1, "host_control": advertised, "credential": credential}
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error


@router.get("/identity")
def identity(challenge: str, request: Request, response: Response):
    """Loopback challenge proof. It discloses no command, secret, or runtime data."""
    response.headers["Cache-Control"] = "no-store"
    try:
        if not request.client or not ipaddress.ip_address(request.client.host).is_loopback:
            raise HTTPException(403, "Installation proof is local only.")
        record = H.installation(S.BASE_DIR)
        return {"schema_version": 1, "installation_id": record["installation_id"], "proof": H.proof(record, challenge)}
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error
    except ValueError as error:
        raise HTTPException(403, "Installation proof is local only.") from error


def _lifecycle_origin(request: Request, *, mutation=False):
    """Desktop lifecycle is never a LAN/Companion or reverse-proxy command."""
    from mcp_bridge import loopback
    try:
        loopback(request)
    except HTTPException as error:
        raise HTTPException(403, "Open TLI on this computer using its localhost address to restart or quit.") from error
    address = urlsplit(str(request.base_url))
    expected_port = S.SERVER_BIND_PORT
    actual_port = address.port or (443 if address.scheme == "https" else 80)
    if (expected_port is None or actual_port != expected_port
            or address.scheme != ("https" if S.TLS_ENABLED else "http")):
        raise HTTPException(403, "Use the current local TLI address to restart or quit.")
    if request.headers.getlist("authorization"):
        raise HTTPException(403, "Restart and quit require the local desktop browser.")
    if mutation:
        if request.headers.getlist("origin") != [str(request.base_url).rstrip("/")]:
            raise HTTPException(403, "Confirm this action from the local TLI page.")
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise HTTPException(415, "Lifecycle actions require JSON.")


def _lifecycle_browser(request: Request, owner: str, *, mutation=False):
    _lifecycle_origin(request, mutation=mutation)
    if owner != "local":
        raise HTTPException(403, "Only the desktop owner can restart or quit TLI.")
    check = companion_auth.operation_access(request, owner)
    token = request.cookies.get("tli_session")
    # The service stores only a hash of this opaque binding, never a PIN/cookie.
    credential = token if token and S.validate_session_token(token) else "open-local"
    principal = hashlib.sha256((owner + "\0" + credential + "\0" + _INSTANCE_ID).encode()).hexdigest()
    return principal, check


def _lifecycle_metadata():
    return {"schema_version": 1, "instance_id": _INSTANCE_ID,
            "installation_id": H.installation(S.BASE_DIR)["installation_id"]}


def _lifecycle_not_installing():
    from ai.model_downloads import downloads
    if downloads.status().get("in_progress"):
        raise HTTPException(409, "A model installation is still in progress. Wait for it to finish, or cancel it and wait before restarting or quitting TLI.")


@router.get("/lifecycle/ready")
def lifecycle_ready(request: Request, response: Response):
    """Read-only boot identity survives the loss of in-memory PIN sessions."""
    _lifecycle_origin(request)
    response.headers["Cache-Control"] = "no-store"
    try:
        return _lifecycle_metadata()
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error


@router.get("/lifecycle")
def lifecycle_capabilities(request: Request, response: Response, owner: str = Depends(require_session)):
    import host_lifecycle as lifecycle
    _, check = _lifecycle_browser(request, owner)
    response.headers["Cache-Control"] = "no-store"
    try:
        result = lifecycle.capabilities(S.BASE_DIR)
        check()
        return {**result, **_lifecycle_metadata()}
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error


class LifecyclePreview(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["restart", "quit"]


class LifecycleConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    preview_id: str = Field(pattern=r"^[0-9a-f]{32,64}$")
    request_id: str = Field(pattern=r"^[0-9a-f]{32,64}$")


@router.post("/lifecycle/preview")
def lifecycle_preview(body: LifecyclePreview, request: Request, response: Response, owner: str = Depends(require_session)):
    import host_lifecycle as lifecycle
    principal, check = _lifecycle_browser(request, owner, mutation=True)
    response.headers["Cache-Control"] = "no-store"
    _lifecycle_not_installing()
    try:
        result = lifecycle.preview(S.BASE_DIR, principal, body.action)
        check()
        return {**result, **_lifecycle_metadata()}
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error


def _dispatch_lifecycle(principal, request_id, check):
    """Starlette invokes this only after the accepted response has been sent."""
    import host_lifecycle as lifecycle
    try:
        check()
        _lifecycle_not_installing()
        lifecycle.dispatch(S.BASE_DIR, principal, request_id)
    except Exception as error:
        # A rejected background commit remains inspectable; it must not stop TLI.
        lifecycle.fail_dispatch(S.BASE_DIR, principal, request_id,
                                getattr(error, "detail", "TLI could not start this lifecycle action."))


@router.post("/lifecycle/confirm", status_code=202)
def lifecycle_confirm(body: LifecycleConfirm, request: Request, response: Response,
                      tasks: BackgroundTasks, owner: str = Depends(require_session)):
    import host_lifecycle as lifecycle
    principal, check = _lifecycle_browser(request, owner, mutation=True)
    response.headers["Cache-Control"] = "no-store"
    _lifecycle_not_installing()
    try:
        check()
        result = lifecycle.confirm(S.BASE_DIR, principal, body.preview_id, body.request_id)
        tasks.add_task(_dispatch_lifecycle, principal, body.request_id, check)
        return {**result, "schema_version": 1}
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error


@router.get("/lifecycle/receipt/{request_id}")
def lifecycle_receipt(request_id: str, request: Request, response: Response, owner: str = Depends(require_session)):
    import host_lifecycle as lifecycle
    principal, check = _lifecycle_browser(request, owner)
    response.headers["Cache-Control"] = "no-store"
    try:
        result = lifecycle.receipt(S.BASE_DIR, principal, request_id)
        check()
        return {**result, "schema_version": 1}
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error
