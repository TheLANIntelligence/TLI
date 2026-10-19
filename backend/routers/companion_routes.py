"""Versioned phone API; existing satellite presence routes remain separate."""
from __future__ import annotations

import base64
import io
import ipaddress
import json
import os
import time
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

import companion_auth as auth
import tli_state as S
import tls_cert
import startup_config
from intelligence import devices, models
from routers.system_routes import require_session
from browser_authority import direct_request_address

router = APIRouter(prefix="/api/companion/v1", tags=["companion"])
_NETWORKS = [ipaddress.ip_network(s) for s in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16")]
_ROUTABLE_PRIVATE_NETWORKS = _NETWORKS[:3]
AI_ADVERTISEMENT_TTL = 120
PAIRING_LINK_PATH = "/api/companion/v1/pair"
PAIRING_LINK_LIMIT = 18000


def _pairing_link(bundle: dict) -> str:
    # DER is already base64: use its URL-safe alphabet, not a second encoding.
    certificate = bundle["certificate_der"].replace("+", "-").replace("/", "_").rstrip("=")
    expires = int(datetime.fromisoformat(bundle["expires_at"].replace("Z", "+00:00")).timestamp())
    fragment = urlencode({"v": str(bundle["version"]), "c": certificate, "t": bundle["token"], "e": str(expires),
                          "i": bundle["node_id"], "n": bundle["node_name"],
                          **({"k": bundle["public_key"]} if bundle.get("public_key") else {})})
    return bundle["origin"] + PAIRING_LINK_PATH + "#" + fragment


@router.get("/pair", response_class=HTMLResponse)
def pairing_landing(request: Request):
    # This fixed public page cannot read invitations or redeem a credential.
    # Browsers never send URL fragments to this route. The local script removes
    # the fragment from history before presenting the explicit native opener.
    address = direct_request_address(request)
    if address.scheme != "https" or not _supported_host(address.hostname):
        raise HTTPException(403, "Open the private HTTPS pairing link shown on your TLI desktop.")
    request.state.tli_companion_pair_landing = True
    policy = ("default-src 'none'; script-src 'self'; style-src 'self'; "
              "img-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; "
              "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    return HTMLResponse('''<!doctype html><html lang="en" data-theme="emeraldLight"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Pair TLI Companion</title>
<link rel="stylesheet" href="/themes.css"><link rel="stylesheet" href="/native-companion.css"><link rel="stylesheet" href="/companion-pair-link.css">
<script src="/api/companion/v1/pair.js"></script></head><body class="companion-pair-landing">
<main class="companion-pair-card"><div class="companion-pair-mark" aria-label="The LAN Intelligence">TLI</div>
<h1>Bring your TLI closer.</h1><p id="pair-link-status" role="status">Reading this invitation…</p><p id="pair-link-host"></p>
<button id="pair-open-beta" disabled>Open TLI Companion Beta</button><button id="pair-open-app" class="secondary" disabled>Open TLI Companion</button>
<p id="pair-link-fallback">Use the current installed app on this phone. If it does not open, open TLI Companion and choose Scan pairing code, or paste the desktop's complete pairing bundle. Older builds may need an update for camera links.</p>
<small>Stay on the same Wi-Fi as TLI. Your phone browser may warn about the host's local HTTPS certificate. The in-app scanner avoids that browser step and checks the supplied certificate itself. Confirm the host in the app before connecting; opening this page does not pair your phone.</small>
<noscript>Open TLI Companion and scan the code inside the app. This handoff page needs JavaScript.</noscript></main></body></html>''', headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": policy})


@router.get("/pair.js")
def pairing_landing_script():
    path = os.path.join(S.FRONTEND_DIR, "js", "companion-pair-link.js")
    with open(path, encoding="utf-8") as source:
        return Response(source.read(), media_type="application/javascript", headers={"Cache-Control": "no-store"})


def _node() -> dict:
    info = devices.node()
    return {"id": info["id"], "name": info["name"]}


def _local_ip(host: str) -> bool:
    try:
        ip = ipaddress.IPv4Address(host)
        return any(ip in network for network in _NETWORKS)
    except ipaddress.AddressValueError:
        return False


def _supported_host(host: str) -> bool:
    if _local_ip(host):
        return True
    # Only this machine's configured SAN-covered name, never arbitrary DNS or
    # user-controlled Host/Forwarded data, may name a pairing listener.
    if not host.endswith('.local'):
        return False
    port = int(getattr(S, "SERVER_BIND_PORT", None) or os.environ.get("TLI_PORT") or 443)
    return any(urlsplit(origin).hostname == host for origin in tls_cert.stable_lan_origins(port))


def _pairing_origin(request):
    origin = str(request.base_url).rstrip('/')
    if (request.url.hostname or '').endswith('.local'):
        # Stable-name identity/card signatures use an explicit port, including
        # 443. HTTP libraries may omit the default port from the Host header.
        return f"https://{request.url.hostname}:{request.url.port or 443}"
    return origin


def _certificate(host: str) -> dict:
    try:
        return tls_cert.certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, host)
    except (ValueError, OSError) as error:
        raise HTTPException(409, str(error))


def _remote_readiness(setup: dict) -> dict:
    """Describe existing HTTPS destinations; never probe or configure a VPN.

    A certificate-valid local address is not evidence of a working remote route.
    Keep ordinary LAN origins unchanged, including existing link-local pairings.
    """
    origins = [origin for origin in setup["origins"]
               if _local_ip(urlsplit(origin).hostname) and any(ipaddress.IPv4Address(urlsplit(origin).hostname) in network
                      for network in _ROUTABLE_PRIVATE_NETWORKS)]
    ready = bool(setup["pairing_ready"] and origins)
    reason = ("This host's existing HTTPS setup can be used through an externally managed private-network route. The route has not been tested."
              if ready else setup["reason"] or
              "No certificate-covered private LAN address is available for routing. Link-local (169.254) addresses are unsuitable for this remote workflow.")
    return {"schema_version": 1, "mode": "routed_lan", "host_ready": ready,
            "checked_at": datetime.now(timezone.utc).isoformat(), "eligible_origins": origins,
            "route_status": "not_tested", "tunnel_status": "unknown", "reason": reason}


def _setup(request: Request) -> dict:
    bind = getattr(S, "SERVER_BIND_HOST", None) or os.environ.get("TLI_HOST") or ("0.0.0.0" if os.environ.get("TLI_LAN_MODE") == "1" else "127.0.0.1")
    port = int(getattr(S, "SERVER_BIND_PORT", None) or os.environ.get("TLI_PORT") or request.url.port or 443)
    lan_enabled = bind == "0.0.0.0" or _local_ip(bind)
    origins, errors = [], []
    for host in sorted(set(tls_cert._local_ipv4_addresses())) if lan_enabled else []:
        if not _local_ip(host) or (bind != "0.0.0.0" and host != bind):
            continue
        try:
            _certificate(host)
            origins.append(f"https://{host}" + (f":{port}" if port != 443 else ""))
        except HTTPException as error:
            errors.append(str(error.detail))
    pin_enabled = bool(S.load_pin_config()["enabled"])
    stable_origins = tls_cert.stable_lan_origins(port) if lan_enabled and S.TLS_ENABLED else []
    origins = stable_origins + [origin for origin in origins if origin not in stable_origins]
    reason = None
    if not S.TLS_ENABLED:
        reason = "Enable HTTPS and restart TLI before pairing a companion."
    elif not lan_enabled:
        reason = "Enable LAN access with TLI_LAN_MODE=1 and restart TLI before pairing a companion."
    elif not origins:
        reason = errors[0] if errors else "No supported local IPv4 address was found. Connect the host to your LAN."
    elif not pin_enabled:
        reason = "Set a desktop PIN before pairing a companion."
    result = {"tls_enabled": bool(S.TLS_ENABLED), "lan_enabled": lan_enabled, "origins": origins, "certificate_ready": bool(origins),
            "pin_enabled": pin_enabled, "pairing_ready": bool(S.TLS_ENABLED and origins and pin_enabled),
            "reason": reason, "node": _node()}
    result["remote_access"] = _remote_readiness(result)
    from routers.host_control_routes import metadata as host_control_metadata
    result["host_control"] = host_control_metadata(request)
    return result


class PairingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: str = Field(min_length=1, max_length=256)


class RedeemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=20, max_length=256)
    name: str = Field(min_length=1, max_length=80)
    platform: Literal["ios", "android"]

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 for c in value):
            raise ValueError("Use a device name without control characters.")
        return value


class StartupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    host: Literal["127.0.0.1", "localhost", "::1", "0.0.0.0"]
    port: int = Field(ge=1, le=65535)
    https: bool


def _startup_snapshot(request):
    state = startup_config.resolve(S.BASE_DIR)
    running = {"host": getattr(S, "SERVER_BIND_HOST", None),
               "port": getattr(S, "SERVER_BIND_PORT", None) or request.url.port or (443 if request.url.scheme == "https" else 80),
               "https": bool(S.TLS_ENABLED)}
    return {"ok": True, **state, "running": running,
            "restart_required": running != state["effective_next"] if running["host"] else None}


@router.get("/startup")
def startup_settings(request: Request, response: Response, owner: str = Depends(auth.desktop_owner)):
    response.headers["Cache-Control"] = "no-store"
    try:
        with startup_config.LOCK:
            return _startup_snapshot(request)
    except startup_config.StartupConfigurationError as error:
        raise HTTPException(503, str(error)) from error


@router.put("/startup")
def save_startup_settings(req: StartupRequest, request: Request, response: Response, owner: str = Depends(auth.desktop_owner)):
    response.headers["Cache-Control"] = "no-store"
    try:
        with startup_config.LOCK:
            candidate = startup_config.resolve(S.BASE_DIR, candidate=req.model_dump())
            if not startup_config.local_only(candidate["effective_next"]["host"]) and not S.load_pin_config()["enabled"]:
                raise HTTPException(409, "Set a desktop PIN before saving secure LAN startup.")
            startup_config.write(req.model_dump(), S.BASE_DIR)
            return _startup_snapshot(request)
    except startup_config.StartupConfigurationError as error:
        raise HTTPException(409, str(error)) from error
    except OSError as error:
        raise HTTPException(503, "Startup settings could not be saved. The previous saved settings remain in place; no restart was requested.") from error


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    favorite_devices: list[str] = Field(default_factory=list, max_length=100)
    favorite_scenes: list[str] = Field(default_factory=list, max_length=100)
    theme: Literal["system", "light", "dark"] = "system"

    @field_validator("favorite_devices", "favorite_scenes")
    @classmethod
    def valid_ids(cls, values):
        if any(not value.strip() or len(value) > 256 or any(ord(c) < 32 for c in value) for value in values):
            raise ValueError("Favorite IDs must contain 1–256 characters without control characters.")
        return list(dict.fromkeys(values))


@router.get("/setup")
def setup(request: Request, response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return _setup(request)


@router.post("/pairings")
def create_pairing(req: PairingRequest, request: Request, response: Response, owner: str = Depends(auth.desktop_owner)):
    ready = _setup(request)
    if not ready["pairing_ready"] or request.url.scheme != "https":
        raise HTTPException(409, ready["reason"] or "Open the desktop over HTTPS before pairing.")
    if req.origin not in ready["origins"]:
        raise HTTPException(422, "Select one of the available local HTTPS addresses.")
    certificate = _certificate(urlsplit(req.origin).hostname)
    if len(certificate["certificate_der"]) > 12000:
        raise HTTPException(409, "This host certificate exceeds the Companion pairing limit. The existing certificate was kept; no invitation was created.")
    node = _node()
    stable = urlsplit(req.origin).hostname.endswith(".local")
    identity = None
    if stable:
        import node_identity
        identity = node_identity.read_existing(S.DATA_DIR)
        if not identity:
            raise HTTPException(409, "The host identity is unavailable. Repair it on this computer before pairing.")
    token, expires = auth.create_pairing(owner, req.origin, certificate["fingerprint"])
    payload = {"version": 2 if stable else 1, "origin": req.origin, "certificate_der": certificate["certificate_der"],
               "token": token, "expires_at": expires, "node_id": node["id"], "node_name": node["name"]}
    if stable:
        payload["public_key"] = identity["public_key_hex"]
    bundle = json.dumps(payload, separators=(",", ":"))
    pairing_url = _pairing_link(payload)
    if len(pairing_url) > PAIRING_LINK_LIMIT:
        pairing_url = None
    qr = None
    try:
        import qrcode
        import qrcode.image.svg
        output = io.BytesIO()
        if not pairing_url:
            raise ValueError("The invitation exceeds the pairing-link bound")
        qrcode.make(pairing_url, image_factory=qrcode.image.svg.SvgPathImage, border=4).save(output)
        qr = "data:image/svg+xml;base64," + base64.b64encode(output.getvalue()).decode("ascii")
    except Exception:
        # Supported certificates can still exceed QR capacity. Keep the manual
        # bundle available without changing the host's certificate or identity.
        pass
    response.headers["Cache-Control"] = "no-store"
    return {"bundle": bundle, "pairing_url": pairing_url, "qr_format": "https_fragment_v2" if stable else "https_fragment_v1", "qr": qr, "expires_at": expires}


@router.post("/pairings/redeem")
def redeem(req: RedeemRequest, request: Request, response: Response):
    address = direct_request_address(request)
    # A malformed Authorization must not get a special anonymous pairing bypass.
    if request.headers.get("authorization") is not None:
        auth.resolve_user(request)
    if address.scheme != "https" or not S.TLS_ENABLED:
        raise HTTPException(403, "Redeem pairing codes over HTTPS only.")
    if not _supported_host(address.hostname):
        raise HTTPException(403, "Use the reviewed LAN address in the pairing code.")
    certificate = _certificate(address.hostname)
    origin = _pairing_origin(request)
    result = auth.redeem_pairing(req.token, origin, certificate["fingerprint"], req.name, req.platform)
    response.headers["Cache-Control"] = "no-store"
    return {**result, "node": _node()}


class UpgradeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=20, max_length=256)
    device_id: str = Field(min_length=1, max_length=128)


@router.post("/pairings/upgrade")
def upgrade_pairing(req: UpgradeRequest, request: Request, response: Response, owner: str = Depends(require_session)):
    address = direct_request_address(request)
    if address.scheme != "https" or not S.TLS_ENABLED or not _supported_host(address.hostname):
        raise HTTPException(403, "Use the reviewed secure LAN address.")
    authorization = request.headers.get("authorization", "").split()
    if len(authorization) != 2 or authorization[0].lower() != "bearer":
        raise HTTPException(403, "Upgrade from the phone's existing paired credential.")
    certificate = _certificate(address.hostname)
    auth.upgrade_pairing(req.token, authorization[1], req.device_id, owner, _pairing_origin(request), certificate["fingerprint"])
    response.headers["Cache-Control"] = "no-store"
    return {"device_id": req.device_id, "owner_id": owner, "node": _node(), "credential_retained": True}


@router.get("/paired-devices")
def paired_devices(response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return {"devices": auth.paired_devices(owner)}


@router.delete("/paired-devices/{device_id}")
def remove_device(device_id: str, owner: str = Depends(require_session)):
    auth.revoke_device(owner, device_id)
    return {"ok": True}


@router.get("/bootstrap")
def bootstrap(response: Response, owner: str = Depends(require_session), request: Request = None):
    from ai.ai_manager import BundledAIManager
    manager = BundledAIManager.get()
    healthy = bool(not getattr(manager, "_transition", False) and manager.is_healthy())
    # Advertisements cannot select a transport or authorize a model. An installed
    # local runtime is a configured destination, not evidence that it is running.
    streaming = bool(manager.cfg.model_path.exists() or healthy)
    ai = _ai_readiness(manager, healthy, False, streaming)
    try:
        models.image_provider()
        vision = True
    except HTTPException:
        vision = False
    response.headers["Cache-Control"] = "no-store"
    from routers.host_control_routes import metadata as host_control_metadata
    return {"api_version": 1, "node": _node(), "host_control": host_control_metadata(request), "capabilities": {
        "vision": vision, "chat": ai["status"] == "available", "home_control": True, "preferences": True,
        "host_runs": True, "conversation_settings": True, "workspace_events": True,
        "documents": True, "builder": True, "lan_inference": True,
        "connection_snapshots": True,
    }, "protocols": {"runs": "tli-runs-v1", "workspace": "tli-workspace-v1", "conversation_settings": "tli-conversation-settings-v1",
                     "connections": "tli-connections-v1", "connection_invitation": "tli-connection-invitation-v1"},
        "chat": {"path": "/api/ai/chat/stream" if streaming else "/chat", "streaming": streaming}, "ai": ai}


def _ai_readiness(manager, healthy, mesh_observed, streaming):
    """Report existing health facts without starting a model or chat probe."""
    checked = S.now_iso()
    if healthy:
        return {"status": "available", "provider": "bundled", "model": manager.active_preset_id,
                "detail": "The bundled AI runtime responded to its health check. TLI is connected.", "checked_at": checked}
    if mesh_observed:
        return {"status": "unknown", "provider": "mesh", "detail": "A LAN peer recently advertised AI. Its current availability will be checked when you send; your TLI host is connected.", "checked_at": checked}
    if streaming:
        return {"status": "unavailable", "provider": "bundled", "detail": "Your computer is connected, but its AI model is not confirmed running. On your computer, open Settings → AI & chat to start or choose a model, then refresh this phone connection.", "checked_at": checked}
    # health_report() can generate text; only inspect its existing short-lived cache.
    cache = getattr(S.lm_provider, "_report_cache", {})
    try:
        recent = 0 <= time.time() - float(cache.get("ts", 0)) <= 30
        report = cache.get("report") or {}
        if recent and isinstance(report, dict):
            available = report.get("chat_ok") is True and report.get("ok") is True
            return {"status": "available" if available else "unavailable", "provider": "lmstudio",
                    "detail": "LM Studio recently passed a chat check; TLI is connected." if available else "Your computer is connected, but the latest LM Studio check did not confirm working AI. On your computer, open Settings → AI & chat to check LM Studio or choose another model, then refresh this phone connection.",
                    "checked_at": report.get("checked_at") or checked}
    except (TypeError, ValueError):
        pass
    return {"status": "unknown", "provider": "lmstudio", "detail": "Your computer is connected. AI readiness is unconfirmed because there is no recent LM Studio chat check. You can try a question; if it cannot reply, open Settings → AI & chat on your computer to check the model.", "checked_at": checked}


def _recent_mesh_ai() -> bool:
    """Use existing observations; readiness must not probe every LAN peer.

    Chat still performs the canonical current-peer discovery when it is sent.
    The cache and discovery observations only select the transport for the UI.
    """
    from ai.ai_routes import _MESH_CACHE, _MESH_CACHE_TTL
    now = time.time()
    if _MESH_CACHE.get("peers") and 0 <= now - _MESH_CACHE.get("ts", 0) < _MESH_CACHE_TTL:
        return True
    for entry in S.load_mesh_directory().values():
        if not isinstance(entry, dict) or entry.get("status") == "blocked" or not entry.get("ip"):
            continue
        if entry.get("ai_healthy") is not True:
            continue
        try:
            observed = datetime.fromisoformat(entry["ai_observed_at"].replace("Z", "+00:00")).timestamp()
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if 0 <= now - observed <= AI_ADVERTISEMENT_TTL:
            return True
    return False


@router.get("/preferences")
def get_preferences(response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return auth.preferences(owner)


@router.put("/preferences")
def put_preferences(req: Preferences, response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return auth.preferences(owner, req.model_dump())
