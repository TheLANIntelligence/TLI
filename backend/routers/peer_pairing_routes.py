"""Full-host browser pairing UI and separate public bootstrap endpoints."""
import asyncio

from fastapi import APIRouter, Depends, Request, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictBool

import peer_pairing as pairing


class PairingRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def bounded(request: Request):
            async def collect():
                raw = bytearray()
                async for part in request.stream():
                    if len(raw) + len(part) > pairing.MAX_BODY:
                        pairing._fail(413, "pairing_body_limit", "The connection request exceeded its limit.")
                    raw.extend(part)
                request._body = bytes(raw)
            try:
                await asyncio.wait_for(collect(), timeout=8)
            except asyncio.TimeoutError:
                pairing._fail(408, "pairing_body_timeout", "The connection request took too long.")
            response = await handler(request)
            response.headers["Cache-Control"] = "no-store"
            return response
        return bounded


router = APIRouter(tags=["computer pairing"], route_class=PairingRoute)


class StartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(min_length=1, max_length=128)
    origin: str | None = Field(default=None, max_length=128)


class ConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=14, max_length=14)
    allow_messages: StrictBool


@router.get("/mesh/pairing/requests")
def list_requests(request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.requests(owner, request)


@router.post("/mesh/pairing/start")
def start(body: StartRequest, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.start(body.device_id, body.origin, owner, request)


@router.post("/mesh/pairing/{request_id}/confirm")
def confirm(request_id: str, body: ConfirmRequest, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.confirm(request_id, body.code, body.allow_messages, owner, request)


@router.post("/mesh/pairing/{request_id}/refresh")
def refresh(request_id: str, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.refresh(request_id, owner, request)


@router.post("/mesh/pairing/{request_id}/cancel")
def cancel(request_id: str, request: Request, owner=Depends(pairing.browser_owner)):
    return pairing.cancel(request_id, owner, request)


@router.post("/agent/pairing/request")
def receive(body: dict, request: Request):
    return pairing.receive(body, request)


@router.post("/agent/pairing/reveal")
def reveal(body: dict, request: Request):
    return pairing.reveal(body, request)


@router.post("/agent/pairing/status")
def status(body: dict, request: Request):
    return pairing.status(body, request)
