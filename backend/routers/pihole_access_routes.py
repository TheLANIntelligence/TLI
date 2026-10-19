"""Owner-approved, own-device Pi-hole browser controls on direct private HTTPS."""
import asyncio
import ipaddress
import json
from pathlib import Path
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
from browser_authority import browser_control_access, direct_request_address
from homelab_overview import captured_check
from routers.pihole_routes import _PrivateRoute
import pihole_self_service as service
import tli_state as S

router = APIRouter(route_class=_PrivateRoute, tags=["pihole-device-access"])
COOKIE = "tli_pihole_access"
GUEST_PATH = "/api/pihole-access"
PRIVATE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
MAX_BODY = 8192
BODY_SECONDS = 5.0
NETWORKS = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))


def _address(value):
    if not isinstance(value, str) or "%" in value:
        raise ValueError()
    address = ipaddress.ip_address(value)
    if not any(address.version == network.version and address in network for network in NETWORKS):
        raise ValueError()
    return str(address)


def guest_transport(request):
    """Transport constraints never grant access; the separate device cookie does."""
    def check():
        if request.headers.getlist("authorization") or any(key.startswith("x-tli-peer-") or key == "forwarded" or key.startswith("x-forwarded-") for key in request.headers):
            raise HTTPException(403, "Use the device controls directly on this TLI host over private HTTPS.")
        try:
            parsed = direct_request_address(request)
            if (len(request.headers.getlist("host")) != 1 or parsed.scheme != "https" or parsed.username or parsed.password
                    or parsed.port is not None and not 1 <= parsed.port <= 65535 or not request.client):
                raise ValueError()
            _address(parsed.hostname)
            _address(request.client.host)
        except (ValueError, TypeError):
            raise HTTPException(403, "Open the owner's private HTTPS IP address while connected to the approved network.") from None
        expected = str(request.base_url).rstrip("/")
        origins = request.headers.getlist("origin")
        if (len(origins) > 1 or origins and origins != [expected] or request.method not in ("GET", "HEAD") and origins != [expected]
                or request.headers.get("sec-fetch-site") not in (None, "same-origin", "none")):
            raise HTTPException(403, "Use this device's Pi-hole control page to make the request.")
    result = captured_check(check)
    result()
    return result


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError()
        result[key] = value
    return result


async def _payload(request, check, operation):
    check()
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send this request as application/json.")
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or lengths and (len(lengths[0]) > 10 or not lengths[0].isascii() or not lengths[0].isdigit()):
        raise HTTPException(400, "Invalid request size.")
    if lengths and int(lengths[0]) > MAX_BODY:
        raise HTTPException(413, "This request exceeds its size limit.")
    start, raw = time.monotonic(), bytearray()
    stream = request.stream().__aiter__()
    while True:
        check()
        remaining = BODY_SECONDS - (time.monotonic() - start)
        if remaining <= 0: raise HTTPException(408, "The request body timed out.")
        try:
            chunk = await asyncio.wait_for(anext(stream), remaining)
        except StopAsyncIteration: break
        except asyncio.TimeoutError:
            check()
            raise HTTPException(408, "The request body timed out.") from None
        check()
        if len(raw) + len(chunk) > MAX_BODY: raise HTTPException(413, "This request exceeds its size limit.")
        raw.extend(chunk)
    check()
    fields = {"enable": {"origin", "password", "certificate_sha256"}, "disable": set(), "inventory": set(),
        "approve": {"request_id", "client", "reviewed"}, "revoke": {"grant_id"}, "request": {"name"},
        "filtering": {"enabled", "operation_id"}, "forget": set()}
    try:
        value = json.loads(raw, object_pairs_hook=_unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(value, dict) or set(value) != fields[operation]: raise ValueError()
        for key, item in value.items():
            if key == "enabled":
                if type(item) is not bool: raise ValueError()
            elif key == "reviewed":
                if item is not True: raise ValueError()
            elif not isinstance(item, str) or len(item.encode("utf-8")) > (4096 if key == "password" else 512): raise ValueError()
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        check()
        raise HTTPException(422, "Provide the expected bounded device-control fields.") from None
    check()
    return value


def _response(value, check, *, forget=False):
    value = dict(value)
    final_check = value.pop("_access_check", check)
    credential = value.pop("_credential", None)
    check(); final_check()
    response = JSONResponse(value, headers=PRIVATE)
    if credential is not None:
        response.set_cookie(COOKIE, credential, max_age=365 * 86400, secure=True, httponly=True, samesite="strict", path=GUEST_PATH)
    if forget: response.delete_cookie(COOKIE, path=GUEST_PATH, secure=True, httponly=True, samesite="strict")
    check(); final_check()
    return response


def _portal_origins(check):
    check()
    if not S.TLS_ENABLED: return []
    import tls_cert
    addresses = tls_cert.lan_listener_addresses()
    check()
    result = []
    for address in addresses[:16]:
        check()
        try:
            _address(address)
            tls_cert.certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, address)
        except (ValueError, OSError):
            check()
            continue
        check()
        result.append(f"https://{address}:{S.server_port()}")
    check()
    return result


@router.get("/pihole-access")
@router.get("/pihole-access.html")
def page(request: Request):
    request.state.tli_pihole_access_page = True
    return FileResponse(Path(S.FRONTEND_DIR) / "pihole-access.html", media_type="text/html", headers=PRIVATE)


@router.get("/api/homelab/pihole/self-service/status")
def owner_status(request: Request, check=Depends(browser_control_access)):
    check = captured_check(check)
    try:
        result = service.owner_status(request, check)
        result["portal_origins"] = _portal_origins(check)
        return _response(result, check)
    except Exception:
        check()
        raise


async def _owner(operation, request, check):
    check = captured_check(check)
    try:
        data = await _payload(request, check, operation)
        method = {"enable": service.enable, "disable": service.disable, "inventory": service.owner_inventory,
                  "approve": service.approve, "revoke": service.revoke}[operation]
        result = await run_in_threadpool(method, request, data, check)
        return _response(result, check)
    except Exception:
        check()
        raise


@router.post("/api/homelab/pihole/self-service/enable")
async def enable(request: Request, check=Depends(browser_control_access)):
    return await _owner("enable", request, check)


@router.post("/api/homelab/pihole/self-service/disable")
async def disable(request: Request, check=Depends(browser_control_access)):
    return await _owner("disable", request, check)


@router.post("/api/homelab/pihole/self-service/inventory")
async def inventory(request: Request, check=Depends(browser_control_access)):
    return await _owner("inventory", request, check)


@router.post("/api/homelab/pihole/self-service/approve")
async def approve(request: Request, check=Depends(browser_control_access)):
    return await _owner("approve", request, check)


@router.post("/api/homelab/pihole/self-service/revoke")
async def revoke(request: Request, check=Depends(browser_control_access)):
    return await _owner("revoke", request, check)


@router.get("/api/pihole-access/status")
def guest_status(request: Request):
    check = guest_transport(request)
    try:
        return _response(service.guest_status(request, check), check)
    except Exception:
        check()
        raise


async def _guest(operation, request):
    check = guest_transport(request)
    try:
        data = await _payload(request, check, operation)
        method = {"request": service.request_access, "filtering": service.filtering, "forget": service.forget}[operation]
        result = await run_in_threadpool(method, request, data, check)
        return _response(result, check, forget=operation == "forget")
    except Exception:
        check()
        raise


@router.post("/api/pihole-access/request")
async def request_access(request: Request): return await _guest("request", request)


@router.post("/api/pihole-access/filtering")
async def filtering(request: Request): return await _guest("filtering", request)


@router.post("/api/pihole-access/forget")
async def forget(request: Request): return await _guest("forget", request)
