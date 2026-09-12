"""Explicit semantic note search; ordinary Chat memory behavior is unchanged."""
import asyncio
import ipaddress
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from intelligence import note_search as service
from routers.system_routes import require_session

router = APIRouter(prefix="/api/intelligence/note-search", tags=["Optional related-note search"])


class Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class Ref(Strict):
    id: str = Field(min_length=1, max_length=256)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")


class Review(Strict):
    notes: list[Ref] = Field(min_length=1, max_length=service.MAX_NOTES)
    port: int = Field(ge=1024, le=65535)
    model: str = Field(min_length=1, max_length=256)
    api_key: str = Field(default="", max_length=2048)

    @field_validator("model", "api_key")
    @classmethod
    def simple_text(cls, value):
        if any(ord(c) < 32 or ord(c) > 126 for c in value):
            raise ValueError("Use a printable model identifier or local API token.")
        return value

    @field_validator("model")
    @classmethod
    def named_model(cls, value):
        if not value.strip():
            raise ValueError("Choose an existing named embedding model.")
        return value


class Build(Strict):
    review_id: str = Field(min_length=20, max_length=64)
    reviewed: Literal[True]


class Search(Strict):
    index_id: str = Field(min_length=20, max_length=64)
    query: str = Field(min_length=1, max_length=1000)
    target_id: str | None = Field(default=None, min_length=1, max_length=256)


def authorize(request, user):
    if request.headers.get("authorization") is not None:
        raise HTTPException(403, "Review optional related-note search in the TLI browser. Companion credentials cannot create or use browser indexes.")
    origin = request.headers.get("origin")
    if (request.headers.get("sec-fetch-site") == "cross-site" or
            origin and origin != str(request.base_url).rstrip("/")):
        raise HTTPException(403, "Open this TLI host to review related-note search.")
    if require_session(request.cookies.get("tli_session"), request) != user:
        raise HTTPException(401, "Your session changed. No note result was attached or sent to Chat.")
    return request.cookies.get("tli_session")


async def parse(request, schema):
    raw = bytearray()
    try:
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                if len(raw) + len(chunk) > 64 * 1024:
                    raise HTTPException(413, "The related-note request exceeded 64 KiB.")
                raw.extend(chunk)
    except TimeoutError:
        raise HTTPException(408, "The request upload timed out. No embedding request started.") from None
    try:
        value = json.loads(raw, object_pairs_hook=service._strict_object)
        if schema is Build and value.get("reviewed") is not True:
            raise ValueError("Explicit review required")
        return schema.model_validate(value)
    except (ValidationError, ValueError, TypeError, AttributeError, RecursionError):
        raise HTTPException(422, "Review the note selection, local embedding-server settings and request fields.") from None


def response(value):
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


@router.get("/capabilities")
def capabilities(user: str = Depends(require_session)):
    return response({"ok": True, "protocol": service.PROTOCOL, "automatic_chat_retrieval": False,
        "embedding_server": "existing-loopback-only", "max_notes": service.MAX_NOTES, "max_text_bytes": service.MAX_TEXT_BYTES,
        "expires_in_seconds": service.TTL, "quality": "not_validated",
        "scope": "Optional explicit similarity search across reviewed notes. Requires an existing embedding model server on the TLI host. TLI does not download or select a model for this feature. Ordinary Chat recall and Use saved notes are unchanged."})


@router.post("/review")
async def review(request: Request, user: str = Depends(require_session)):
    token = authorize(request, user)
    req = await parse(request, Review)
    authorize(request, user)
    if req.api_key and request.url.scheme != "https":
        try:
            loopback = request.client and ipaddress.ip_address(request.client.host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            raise HTTPException(400, "Use HTTPS or open TLI on its host before submitting a local embedding API token.")
    return response(service.review(user, token, [ref.model_dump() for ref in req.notes], req.port, req.model, req.api_key))


@router.post("/build")
async def build(request: Request, user: str = Depends(require_session)):
    token = authorize(request, user)
    req = await parse(request, Build)
    authorize(request, user)
    value = await service.build(user, token, req.review_id)
    authorize(request, user)
    return response(value)


@router.post("/search")
async def search(request: Request, user: str = Depends(require_session)):
    token = authorize(request, user)
    req = await parse(request, Search)
    authorize(request, user)
    value = await service.search(user, token, req.index_id, req.query, req.target_id)
    authorize(request, user)
    return response(value)


@router.delete("/{ident}")
def discard(ident: str, request: Request, user: str = Depends(require_session)):
    token = authorize(request, user)
    return response(service.discard(user, token, ident))
