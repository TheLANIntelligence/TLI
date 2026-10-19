"""Private HomeLab inventory and explicit read-only Proxmox inspection."""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool

from browser_authority import browser_control_access
import homelab_overview
import homelab_proxmox

MAX_BODY_BYTES = 8192
MAX_BODY_SECONDS = 5.0
_now = time.monotonic
_PRIVATE = {"Cache-Control": "no-store"}
_INVALID = "Provide the Proxmox origin, token ID, token secret and certificate fingerprint as JSON text fields."


class _HomeLabRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_response(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                return JSONResponse({"detail": _INVALID}, status_code=422, headers=_PRIVATE)
            except HTTPException as error:
                error.headers = {**(error.headers or {}), **_PRIVATE}
                raise
            except Exception:
                # Dependency/serialization errors must never disclose credential input.
                return JSONResponse({"detail": "HomeLab information is unavailable."},
                                    status_code=503, headers=_PRIVATE)
            response.headers.update(_PRIVATE)
            return response
        return private_response


router = APIRouter(prefix="/api/homelab", tags=["homelab"], route_class=_HomeLabRoute)


def _response(result, check):
    check()
    response = JSONResponse(result, headers=_PRIVATE)
    check()
    return response


def _unique(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Duplicate field")
        result[key] = value
    return result


async def _payload(request, check):
    check()
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send the Proxmox inspection request as application/json.")
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or lengths and (len(lengths[0]) > 10 or not lengths[0].isascii() or not lengths[0].isdigit()):
        raise HTTPException(400, _INVALID)
    if lengths and int(lengths[0]) > MAX_BODY_BYTES:
        raise HTTPException(413, "The Proxmox inspection request exceeds the size limit.")
    started, body = _now(), bytearray()
    stream = request.stream().__aiter__()
    while True:
        check()
        remaining = MAX_BODY_SECONDS - (_now() - started)
        if remaining <= 0:
            raise HTTPException(408, "The Proxmox inspection request timed out.")
        try:
            chunk = await asyncio.wait_for(anext(stream), timeout=remaining)
        except StopAsyncIteration:
            check()
            break
        except asyncio.TimeoutError:
            check()
            raise HTTPException(408, "The Proxmox inspection request timed out.") from None
        check()
        if _now() - started > MAX_BODY_SECONDS:
            raise HTTPException(408, "The Proxmox inspection request timed out.")
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, "The Proxmox inspection request exceeds the size limit.")
        body.extend(chunk)
    check()
    if _now() - started > MAX_BODY_SECONDS:
        raise HTTPException(408, "The Proxmox inspection request timed out.")
    try:
        value = json.loads(body, object_pairs_hook=_unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if (not isinstance(value, dict) or set(value) != {"origin", "token_id", "token_secret", "certificate_sha256"}
                or any(not isinstance(item, str) for item in value.values())):
            raise ValueError()
        for item in value.values():
            item.encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        check()
        raise HTTPException(422, _INVALID) from None
    check()
    return value


@router.get("/overview")
def get_overview(check=Depends(browser_control_access)):
    check = homelab_overview.captured_check(check)
    try:
        return _response(homelab_overview.overview(check), check)
    except Exception:
        check()
        raise


@router.post("/proxmox/inspect")
async def inspect_proxmox(request: Request, check=Depends(browser_control_access)):
    check = homelab_overview.captured_check(check)
    try:
        payload = await _payload(request, check)
        check()
        result = await run_in_threadpool(homelab_proxmox.inspect, payload, check)
        return _response(result, check)
    except Exception:
        check()
        raise
