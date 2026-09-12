# backend/routers/update_routes.py
# TLI Update API
#
# GET  /update/status   — current version, update state, progress
# POST /update/check    — trigger a fresh manifest check
# POST /update/apply    — start download + extract pipeline
# POST /update/settings — set update URL + auto_check flag

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

import auto_update as _upd
from routers.system_routes import require_session

router = APIRouter(tags=["update"])


class UpdateSettingsRequest(BaseModel):
    update_url: str
    auto_check: bool = True


@router.get("/update/status")
def update_status():
    """Return current version, update state, and progress."""
    return _upd.get_status()


@router.post("/update/check")
def update_check(update_url: Optional[str] = None, _session: str = Depends(require_session)):
    """
    Trigger a manifest check against the configured (or provided) URL.
    Runs synchronously — returns result immediately.
    """
    return _upd.check(update_url)


@router.post("/update/apply")
def update_apply(_session: str = Depends(require_session)):
    """
    Start the download + verify + extract pipeline in a background thread.
    Poll GET /update/status for progress.
    """
    from auto_update import UpdateState
    status = _upd.get_status()
    if status["state"] != UpdateState.AVAILABLE:
        raise HTTPException(
            status_code=400,
            detail=f"No update ready to apply (state: {status['state']}). "
                   "Run /update/check first.",
        )
    started = _upd.apply()
    if not started:
        raise HTTPException(status_code=409, detail="Update already in progress.")
    return {"ok": True, "message": "Update pipeline started. Poll /update/status for progress."}


@router.post("/update/settings")
def update_settings(req: UpdateSettingsRequest, _session: str = Depends(require_session)):
    """Configure the update manifest URL and auto-check preference."""
    url = req.update_url.strip()
    _upd.save_settings(update_url=url, auto_check=req.auto_check)
    return {"ok": True, "update_url": url, "auto_check": req.auto_check}
