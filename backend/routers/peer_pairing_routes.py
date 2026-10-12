"""Full-host browser pairing UI and separate public bootstrap endpoints."""
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

import peer_pairing as pairing
from peer_pairing_public import PairingRoute, router as public_router


router = APIRouter(tags=["computer pairing"], route_class=PairingRoute)
router.include_router(public_router)


class InvitationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invitation: str = Field(min_length=1, max_length=60000)


@router.get('/mesh/pairing/invitation')
def export_invitation(origin: str | None = None, owner=Depends(pairing.browser_owner)):
    import connection_invitation
    return connection_invitation.export(origin)


@router.post('/mesh/pairing/invitation/import')
def import_invitation(body: InvitationRequest, owner=Depends(pairing.browser_owner)):
    import connection_invitation
    pairing._rate(('invitation', owner), 12)
    return connection_invitation.import_invitation(body.invitation)


class StartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(min_length=1, max_length=128)
    origin: str | None = Field(default=None, max_length=128)
    version: int = Field(default=1, ge=1, le=2)
    grants: list[str] | None = Field(default=None, max_length=4)
    review_update: StrictBool = False


class ConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=14, max_length=14)
    allow_messages: StrictBool
    grants: list[str] | None = Field(default=None, max_length=4)


@router.get("/mesh/pairing/requests")
def list_requests(request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.requests(owner, request)


@router.post("/mesh/pairing/start")
def start(body: StartRequest, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.start(body.device_id, body.origin, owner, request, version=body.version, grants=body.grants, review_update=body.review_update)


@router.post("/mesh/pairing/{request_id}/confirm")
def confirm(request_id: str, body: ConfirmRequest, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.confirm(request_id, body.code, body.allow_messages, owner, request, grants=body.grants)


@router.post("/mesh/pairing/{request_id}/refresh")
def refresh(request_id: str, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.refresh(request_id, owner, request)


@router.post("/mesh/pairing/{request_id}/cancel")
def cancel(request_id: str, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.cancel(request_id, owner, request)


