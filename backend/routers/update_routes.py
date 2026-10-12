# backend/routers/update_routes.py
# TLI Update API
#
# GET  /update/status   — current version, update state, progress
# POST /update/check    — trigger a fresh manifest check
# POST /update/apply    — prepare a verified update folder
# POST /update/open     — reveal the prepared folder in the local file manager
# POST /update/settings — set update URL + auto_check flag

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from typing import Optional

import auto_update as _upd
from routers.system_routes import require_session

router = APIRouter(tags=["update"])


class UpdateSettingsRequest(BaseModel):
    update_url: str
    auto_check: bool = True


@router.get("/update/status")
def update_status(response: Response):
    """Return current version, update state, and progress."""
    response.headers["Cache-Control"] = "no-store"
    return _upd.get_status()


@router.post("/update/check")
def update_check(update_url: Optional[str] = None, _session: str = Depends(require_session)):
    """
    Trigger a manifest check against the configured (or provided) URL.
    Runs synchronously — returns result immediately.
    """
    return _upd.check(update_url)


@router.post("/update/apply")
def update_apply(request: Request, _session: str = Depends(require_session)):
    """
    Stage a verified package; installation happens locally after TLI is closed.
    Poll GET /update/status for progress.
    """
    _local_update_browser(request, _session)
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
    started = _upd.apply()
    if not started:
        raise HTTPException(status_code=409, detail="Update already in progress.")
    return {"ok": True, "message": "Downloading and verifying the update. Running application files stay in place until you use the local updater."}


def _local_update_browser(request: Request, owner: str):
    from routers.host_control_routes import _lifecycle_browser
    _, check = _lifecycle_browser(request, owner, mutation=True)
    check()


@router.post("/update/open")
def update_open(request: Request, _session: str = Depends(require_session)):
    """Open only the server-selected prepared directory, never execute its files."""
    _local_update_browser(request, _session)
    try:
        _upd.open_prepared_folder()
    except (ValueError, OSError) as error:
        raise HTTPException(409, str(error)) from error
    return {"ok": True}


@router.post("/update/settings")
def update_settings(req: UpdateSettingsRequest, _session: str = Depends(require_session)):
    """Configure the update manifest URL and auto-check preference."""
    url = req.update_url.strip()
    try:
        _upd.save_settings(update_url=url, auto_check=req.auto_check)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return {"ok": True, "update_url": url, "auto_check": req.auto_check}
