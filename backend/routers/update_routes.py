# backend/routers/update_routes.py
# TLI Update API
#
# GET  /update/status   — current version, update state, progress
# POST /update/check    — trigger a fresh manifest check
# POST /update/apply    — prepare a verified update folder
# POST /update/open     — reveal the prepared folder in the local file manager
# POST /update/settings — set update URL + auto_check flag

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from typing import Optional
from urllib.parse import urlsplit

import auto_update as _upd
import hashlib
import host_control as H
import host_lifecycle as lifecycle
from private_client_authority import private_client_access, checked_call, checked_json
from routers.system_routes import require_session

router = APIRouter(tags=["update"])


class UpdateSettingsRequest(BaseModel):
    update_url: str
    auto_check: bool = True


@router.get("/update/status")
def update_status(request: Request, response: Response):
    """Return current version, update state, and progress."""
    _, check = private_client_access(request, response)
    result = checked_call(check, _upd.get_status)
    result.update(can_install=False, install_operation=None,
                  install_reason="Open TLI through its desktop launcher on this computer to install and restart.")
    try:
        principal, local_check = _local_update_browser(request, response, mutation=False)
        local_check()
    except HTTPException as error:
        check()
        if error.status_code != 403:
            raise
        return checked_json(check, result)
    def details():
        capabilities = lifecycle.capabilities(_upd.S.BASE_DIR)
        check()
        available = capabilities['available'] and _upd._platform_name() in {'windows', 'macos'}
        result.update(can_install=bool(result['can_open'] and available),
                      install_reason=capabilities['reason'] if not available else
                      'Review the verified package, then explicitly install and restart.' if result['can_open'] else 'Prepare an update first.',
                      install_operation=lifecycle.latest_install(_upd.S.BASE_DIR, principal, check=check) if capabilities.get('managed') else None)
        if result['install_operation'] is not None:
            result['install_operation'].update(_install_metadata())
        return result
    return checked_json(check, _service(check, details))


@router.post("/update/check")
def update_check(update_url: Optional[str] = None, _session: str = Depends(require_session)):
    """
    Trigger a manifest check against the configured (or provided) URL.
    Runs synchronously — returns result immediately.
    """
    return _upd.check(update_url)


@router.post("/update/apply")
def update_apply(request: Request, response: Response):
    """
    Stage a verified package; installation happens locally after TLI is closed.
    Poll GET /update/status for progress.
    """
    _, check = _local_update_browser(request, response)
    from auto_update import UpdateState
    status = _upd.get_status()
    if status["state"] != UpdateState.AVAILABLE:
        raise HTTPException(
            status_code=400,
            detail=f"No update ready to apply (state: {status['state']}). "
                   "Run /update/check first.",
        )
    if not status["can_prepare"]:
        raise HTTPException(status_code=409, detail=status["message"] or "Use the download page for this release.")
    started = checked_call(check, lambda: _upd.apply(check=check))
    if not started:
        raise HTTPException(status_code=409, detail="Update already in progress.")
    return checked_json(check, {"ok": True, "message": "Downloading and verifying the update. Review Install and restart when preparation finishes."})


def _local_update_browser(request: Request, response: Response, *, mutation=True):
    from routers.host_control_routes import _lifecycle_origin, _INSTANCE_ID
    try:
        _lifecycle_origin(request, mutation=mutation)
    except HTTPException as error:
        error.headers = {**(error.headers or {}), 'Cache-Control': 'no-store'}
        raise
    owner, check = private_client_access(request, response)
    if owner != 'local':
        raise HTTPException(403, 'Only the local desktop owner can install updates.', headers={'Cache-Control': 'no-store'})
    credential = request.cookies.get('tli_session') or 'open-local'
    principal = hashlib.sha256((owner + '\0' + credential + '\0' + _INSTANCE_ID).encode()).hexdigest()
    check()
    return principal, check


def _service(check, operation):
    def invoke():
        try:
            return operation()
        except H.HostControlError as error:
            raise HTTPException(error.status, error.detail) from None
        except ValueError as error:
            raise HTTPException(409, str(error)) from None
    return checked_call(check, invoke)


def _install_metadata():
    from routers.host_control_routes import _lifecycle_metadata
    return _lifecycle_metadata()


class InstallPreview(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


@router.post('/update/install/preview')
def install_preview(body: InstallPreview, request: Request, response: Response):
    from routers.host_control_routes import _lifecycle_not_installing
    principal, check = _local_update_browser(request, response)
    def prepare():
        _lifecycle_not_installing()
        package = _upd.prepared_for_install(check=check)
        result = lifecycle.preview(_upd.S.BASE_DIR, principal, 'install', package=package, check=check)
        return {**result, **_install_metadata()}
    return checked_json(check, _service(check, prepare))


def _dispatch_install(principal, request_id, check):
    from routers.host_control_routes import _lifecycle_not_installing
    try:
        check()
        _lifecycle_not_installing()
        lifecycle.dispatch(_upd.S.BASE_DIR, principal, request_id, check=check)
    except Exception:
        lifecycle.fail_dispatch(_upd.S.BASE_DIR, principal, request_id,
                                'The original desktop authority or installation state changed. No automatic retry was scheduled.')


from routers.host_control_routes import LifecycleConfirm


@router.post('/update/install/confirm', status_code=202)
def install_confirm(body: LifecycleConfirm, request: Request, response: Response, tasks: BackgroundTasks):
    from routers.host_control_routes import _lifecycle_not_installing
    principal, check = _local_update_browser(request, response)
    try:
        def confirm():
            _lifecycle_not_installing()
            result = lifecycle.confirm(_upd.S.BASE_DIR, principal, body.preview_id, body.request_id, check=check, expected_action='install')
            if result['action'] != 'install':
                raise HTTPException(409, 'Review an update installation before confirming it.')
            return {**result, **_install_metadata()}
        receipt = _service(check, confirm)
        result = checked_json(check, receipt, status_code=202)
        if receipt.get('status') == 'accepted':
            current, next_address = urlsplit(str(request.base_url)), urlsplit(receipt.get('next_url', ''))
            def origin(address):
                return address.scheme, address.hostname, address.port or (443 if address.scheme == 'https' else 80)
            if next_address.scheme in {'http', 'https'} and origin(current) != origin(next_address):
                result.delete_cookie('tli_session', path='/', httponly=True, samesite='strict', secure=_upd.S.TLS_ENABLED)
        check()
        if receipt.get('duplicate') is not True:
            tasks.add_task(_dispatch_install, principal, body.request_id, check)
            result.background = tasks
        return result
    except Exception:
        lifecycle.cancel_pending(_upd.S.BASE_DIR, principal, body.request_id)
        raise


@router.get('/update/install/receipt/{request_id}')
def install_receipt(request_id: str, request: Request, response: Response):
    principal, check = _local_update_browser(request, response, mutation=False)
    return checked_json(check, _service(check, lambda: {
        **lifecycle.receipt(_upd.S.BASE_DIR, principal, request_id), **_install_metadata()}))


@router.post("/update/open")
def update_open(request: Request, response: Response):
    """Open only the server-selected prepared directory, never execute its files."""
    _, check = _local_update_browser(request, response)
    try:
        checked_call(check, lambda: _upd.open_prepared_folder(check=check))
    except (ValueError, OSError) as error:
        raise HTTPException(409, str(error)) from error
    return checked_json(check, {"ok": True})


@router.post("/update/settings")
def update_settings(req: UpdateSettingsRequest, _session: str = Depends(require_session)):
    """Configure the update manifest URL and auto-check preference."""
    url = req.update_url.strip()
    try:
        _upd.save_settings(update_url=url, auto_check=req.auto_check)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return {"ok": True, "update_url": url, "auto_check": req.auto_check}
