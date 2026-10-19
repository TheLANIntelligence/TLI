"""Browser-authorized, bounded direct Sonos operations. No background discovery."""
from __future__ import annotations
import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool

from browser_authority import browser_control_access
import sonos_service as sonos
import tli_state as S

router = APIRouter(prefix="/api/sonos", tags=["Direct Sonos"])


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Enrollment(StrictInput):
    ip: str | None = Field(default=None, min_length=7, max_length=15)
    discovery_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{48}$")
    name: str = Field(default="", max_length=120)
    room: str = Field(default="", max_length=120)
    volume_cap: int = Field(default=35, ge=0, le=100)

    @model_validator(mode="after")
    def exact_enrollment_choice(self):
        if (self.ip is None) == (self.discovery_id is None):
            raise ValueError("Choose exactly one discovered speaker or manual address.")
        if self.discovery_id is not None and self.model_fields_set != {"discovery_id"}:
            raise ValueError("Discovered enrollment preserves existing metadata; supply only discovery_id.")
        return self


class Review(StrictInput):
    action: Literal["play", "pause", "stop", "next", "previous", "volume", "mute", "group_volume", "group_mute", "favorite", "join", "leave"]
    params: dict[str, Any] = Field(default_factory=dict)


class Execution(StrictInput):
    review_id: str = Field(pattern=r"^[a-f0-9]{48}$")
    request_id: str = Field(pattern=r"^[A-Za-z0-9_-]{16,128}$")


def authority(request, response):
    check = browser_control_access(request, response)
    token = request.cookies.get("tli_session")
    owner = S.get_session_user_id(token) if token else "local"
    check()
    return owner, check


async def body(request, model):
    if request.headers.get("content-type", "").split(";")[0].lower() != "application/json":
        raise HTTPException(415, "Use application/json.")
    async def read():
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 8192:
                raise HTTPException(413, "Sonos requests are limited to 8 KiB.")
        return raw
    try:
        raw = await asyncio.wait_for(read(), 5)
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        return model.model_validate(json.loads(raw, object_pairs_hook=pairs))
    except asyncio.TimeoutError:
        raise HTTPException(408, "Sonos request upload timed out.") from None
    except (ValueError, ValidationError, RecursionError):
        raise HTTPException(422, "Supply only the valid fields for this Sonos operation.") from None


@router.get("/devices")
def devices(request: Request, response: Response):
    owner, check = authority(request, response)
    result = sonos.list_devices(owner)
    check()
    return result


@router.post("/discover")
def discover(request: Request, response: Response):
    owner, check = authority(request, response)
    return sonos.discover(owner, check)


@router.get("/now-playing")
def now_playing(request: Request, response: Response):
    owner, check = authority(request, response)
    response.headers["Cache-Control"] = "no-store"
    return sonos.now_playing(owner, check)


@router.post("/devices")
async def enroll(request: Request, response: Response):
    owner, check = authority(request, response)
    payload = await body(request, Enrollment)
    return await run_in_threadpool(sonos.enroll, owner, **payload.model_dump(), check=check)


@router.delete("/devices/{ident}")
def remove(ident: str, request: Request, response: Response):
    owner, check = authority(request, response)
    return sonos.remove(owner, ident, check)


@router.get("/devices/{ident}/status")
def status(ident: str, request: Request, response: Response):
    owner, check = authority(request, response)
    return sonos.status(owner, ident, check)


@router.get("/devices/{ident}/volume-controls")
def volume_controls(ident: str, request: Request, response: Response):
    owner, check = authority(request, response)
    response.headers["Cache-Control"] = "no-store"
    return sonos.volume_controls(owner, ident, check)


@router.get("/devices/{ident}/favorites")
def favorites(ident: str, request: Request, response: Response):
    owner, check = authority(request, response)
    return sonos.favorites(owner, ident, check)


@router.post("/devices/{ident}/review")
async def review(ident: str, request: Request, response: Response):
    owner, check = authority(request, response)
    payload = await body(request, Review)
    return await run_in_threadpool(sonos.prepare, owner, ident, payload.action, payload.params, check)


@router.post("/execute")
async def execute(request: Request, response: Response):
    owner, check = authority(request, response)
    payload = await body(request, Execution)
    return await run_in_threadpool(sonos.execute, owner, payload.review_id, payload.request_id, check)


@router.get("/receipts")
def receipts(request: Request, response: Response):
    owner, check = authority(request, response)
    return sonos.receipts(owner, check)
