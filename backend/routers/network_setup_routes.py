"""Local owner network preparation; no LAN, phone, peer or proxy authority."""
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

import host_control as H
import network_setup as N
import startup_config
import tli_state as S
from routers.host_control_routes import _lifecycle_browser
from routers.system_routes import require_session

router = APIRouter(prefix='/api/network-setup/v1', tags=['network-setup'])


def _browser(request, owner, *, mutation=False, unlocked=False):
    principal, check = _lifecycle_browser(request, owner, mutation=mutation)
    if mutation or unlocked:
        if not S.load_pin_config().get('enabled'):
            raise HTTPException(409, 'Set and unlock the desktop owner PIN before network preparation.')
        if not S.validate_session_token(request.cookies.get('tli_session', '')):
            raise HTTPException(401, 'Unlock this desktop with its owner PIN to continue setup.')
    return principal, check


def _running():
    return {'host': getattr(S, 'SERVER_BIND_HOST', None), 'port': S.SERVER_BIND_PORT, 'https': bool(S.TLS_ENABLED)}


def _call(response, operation):
    response.headers['Cache-Control'] = 'no-store'
    try:
        return operation()
    except H.HostControlError as error:
        raise HTTPException(error.status, error.detail) from error
    except startup_config.StartupConfigurationError as error:
        raise HTTPException(409, str(error)) from error


@router.get('/status')
def status(request: Request, response: Response, owner: str = Depends(require_session)):
    _, check = _browser(request, owner)
    check()
    return _call(response, lambda: N.status(S.BASE_DIR, _running()))


class Preview(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    action: Literal['prepare', 'firewall', 'repair_certificate']
    port: int | None = Field(default=None, ge=1, le=65535)
    migrate_legacy: bool = False


class Confirm(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    preview_id: str = Field(pattern=r'^[0-9a-f]{32,64}$')
    request_id: str = Field(pattern=r'^[0-9a-f]{32,64}$')


@router.post('/preview')
def preview(body: Preview, request: Request, response: Response, owner: str = Depends(require_session)):
    principal, check = _browser(request, owner, mutation=True)
    check()
    return _call(response, lambda: N.preview(S.BASE_DIR, principal, body.action, port=body.port, migrate_legacy=body.migrate_legacy, running=_running()))


@router.post('/confirm', status_code=202)
def confirm(body: Confirm, request: Request, response: Response, tasks: BackgroundTasks, owner: str = Depends(require_session)):
    principal, check = _browser(request, owner, mutation=True)
    check()
    result = _call(response, lambda: N.confirm(S.BASE_DIR, principal, body.preview_id, body.request_id))
    if not result.get('duplicate'):
        tasks.add_task(N.dispatch, S.BASE_DIR, principal, body.request_id, check)
    return result


@router.get('/receipt/{request_id}')
def receipt(request_id: str, request: Request, response: Response, owner: str = Depends(require_session)):
    _, check = _browser(request, owner, unlocked=True)
    check()
    return _call(response, lambda: {**N.receipt(S.BASE_DIR, request_id), 'running': _running()})
