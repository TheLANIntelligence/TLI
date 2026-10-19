"""Private browser wrappers for the bounded Pi-hole integration."""
import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool

from browser_authority import browser_control_access
from homelab_overview import captured_check
import pihole_bridge

MAX_BODY_BYTES = 8192
MAX_BODY_SECONDS = 5.0
_now = time.monotonic
_PRIVATE = {"Cache-Control": "no-store"}
_INVALID = "Provide the expected bounded Pi-hole JSON fields."


class _PrivateRoute(APIRoute):
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
                return JSONResponse({"detail": "Pi-hole information is unavailable."}, status_code=503, headers=_PRIVATE)
            response.headers.update(_PRIVATE)
            return response
        return private_response


router = APIRouter(prefix="/api/homelab/pihole", tags=["homelab"], route_class=_PrivateRoute)


def _response(result, check):
    check()
    response = JSONResponse(result, headers=_PRIVATE)
    check()
    return response


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _validate(value, operation):
    fields = {"connect": {"origin", "password", "certificate_sha256"},
        "inventory": {"connection_id"}, "activity": {"connection_id", "client"},
        "review": {"connection_id", "client", "action", "groups", "receipt_id"},
        "execute": {"connection_id", "review_id", "reviewed"}, "disconnect": {"connection_id"}}
    if not isinstance(value, dict) or set(value) != fields[operation]:
        raise ValueError()
    for key, item in value.items():
        if key == "groups":
            if not isinstance(item, list) or len(item) > 256 or any(type(i) is not int or not 0 <= i <= 2**53 - 1 for i in item) or len(set(item)) != len(item):
                raise ValueError()
        elif key == "reviewed":
            if item is not True:
                raise ValueError()
        elif key == "receipt_id" and item is None:
            continue
        elif not isinstance(item, str) or len(item.encode("utf-8")) > (4096 if key == "password" else 512):
            raise ValueError()
    if operation == "review" and value["action"] not in {"groups", "pause", "restore"}:
        raise ValueError()
    return value


async def _payload(request, check, operation):
    check()
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send the Pi-hole request as application/json.")
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or lengths and (len(lengths[0]) > 10 or not lengths[0].isascii() or not lengths[0].isdigit()):
        raise HTTPException(400, _INVALID)
    if lengths and int(lengths[0]) > MAX_BODY_BYTES:
        raise HTTPException(413, "The Pi-hole request exceeds the size limit.")
    started, body = _now(), bytearray()
    stream = request.stream().__aiter__()
    while True:
        check()
        remaining = MAX_BODY_SECONDS - (_now() - started)
        if remaining <= 0:
            raise HTTPException(408, "The Pi-hole request timed out.")
        try:
            chunk = await asyncio.wait_for(anext(stream), timeout=remaining)
        except StopAsyncIteration:
            check()
            break
        except asyncio.TimeoutError:
            check()
            raise HTTPException(408, "The Pi-hole request timed out.") from None
        check()
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, "The Pi-hole request exceeds the size limit.")
        body.extend(chunk)
    check()
    if _now() - started > MAX_BODY_SECONDS:
        raise HTTPException(408, "The Pi-hole request timed out.")
    try:
        value = json.loads(body, object_pairs_hook=_unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        _validate(value, operation)
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        check()
        raise HTTPException(422, _INVALID) from None
    check()
    return value


@router.get("/status")
def status(request: Request, check=Depends(browser_control_access)):
    check = captured_check(check)
    try:
        return _response(pihole_bridge.status(request, check), check)
    except Exception:
        check()
        raise


async def _post(operation, request, check):
    check = captured_check(check)
    try:
        payload = await _payload(request, check, operation)
        check()
        service = {"connect": pihole_bridge.connect, "inventory": pihole_bridge.inventory,
            "activity": pihole_bridge.activity, "review": pihole_bridge.review,
            "execute": pihole_bridge.execute, "disconnect": pihole_bridge.disconnect}[operation]
        result = await run_in_threadpool(service, request, payload, check)
        return _response(result, check)
    except Exception:
        check()
        raise


@router.post("/connect")
async def connect(request: Request, check=Depends(browser_control_access)):
    return await _post("connect", request, check)


@router.post("/inventory")
async def inventory(request: Request, check=Depends(browser_control_access)):
    return await _post("inventory", request, check)


@router.post("/activity")
async def activity(request: Request, check=Depends(browser_control_access)):
    return await _post("activity", request, check)


@router.post("/review")
async def review(request: Request, check=Depends(browser_control_access)):
    return await _post("review", request, check)


@router.post("/execute")
async def execute(request: Request, check=Depends(browser_control_access)):
    return await _post("execute", request, check)


@router.post("/disconnect")
async def disconnect(request: Request, check=Depends(browser_control_access)):
    return await _post("disconnect", request, check)
