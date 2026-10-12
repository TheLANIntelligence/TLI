"""Explicit bilateral computer trust and bounded, read-only peer transport.

Discovery is never authority. Public cards must be compared on the other
computer and reviewed locally. Existing directory entries confer no trust.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import http.client
import ipaddress
import inspect
import json
import math
import re
import secrets
import socket
import ssl
import threading
import time
from functools import wraps
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlencode

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from fastapi import HTTPException, Request
from fastapi.routing import APIRoute

import node_identity
import tli_state as S

LOCK = S.MESH_DIRECTORY_LOCK
PROTOCOL = "tli-peer-trust-v1"
MAX_BODY = 131072
WINDOW = 60
GRANTS = {"observe", "coordinate", "messages", "inference"}
HOST_CAPABILITIES = ["system_observation_v1", "coordination_v1", "messages_v1"]
INFERENCE_CAPABILITIES = ["inference_v1"]
_PREVIEWS = {}
_NONCES = {}


class BoundedPeerRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def bounded(request: Request):
            if any(k.startswith("x-tli-peer-") for k in request.headers) or request.url.path.startswith(("/mesh/trust/", "/mesh/files", "/agent/peer/files/", "/agent/peer/inference", "/api/ai/lan/")):
                raw = bytearray()
                async for part in request.stream():
                    if len(raw) + len(part) > MAX_BODY:
                        fail(413, "peer_body_limit", "The peer request exceeded its bound.")
                    raw.extend(part)
                request._body = bytes(raw)
            return await handler(request)
        return bounded


def directory_locked(function):
    """Whole read/modify/write transaction for synchronous directory handlers."""
    @wraps(function)
    def wrapped(*args, **kwargs):
        with LOCK:
            return function(*args, **kwargs)
    wrapped.__signature__ = inspect.signature(function, eval_str=True)
    return wrapped


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def fail(code, reason, message):
    raise HTTPException(code, {"code": reason, "message": message})


def origin(value):
    """Literal private IPv4 only: no DNS, proxy, credentials or URL suffix."""
    try:
        parsed = urlsplit(value)
        ip = ipaddress.IPv4Address(parsed.hostname)
        if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or not any(ip in ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))):
            raise ValueError()
        port = 443 if parsed.port is None else parsed.port
        if not 1 <= port <= 65535:
            raise ValueError()
        return f"https://{ip}:{port}"
    except (ValueError, TypeError, AttributeError):
        fail(422, "invalid_origin", "Use this computer's exact HTTPS private LAN IPv4 address and port.")


def _fingerprint(key):
    raw = bytes.fromhex(key)
    if len(raw) != 32:
        raise ValueError()
    short = hashlib.sha256(raw).hexdigest()[:32]
    return ":".join(short[i:i + 4] for i in range(0, 32, 4))


def _certificate(card):
    raw = base64.b64decode(card["certificate_der"], validate=True)
    if not 64 <= len(raw) <= 16384 or hashlib.sha256(raw).hexdigest() != card["certificate_sha256"]:
        raise ValueError("Certificate fingerprint mismatch")
    cert = x509.load_der_x509_certificate(raw)
    now = datetime.now(timezone.utc)
    if not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
        raise ValueError("Certificate is not currently valid")
    address = ipaddress.ip_address(urlsplit(card["origin"]).hostname)
    names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    if address not in names.get_values_for_type(x509.IPAddress):
        raise ValueError("Certificate does not cover the reviewed address")
    return cert


def validate_card(value):
    try:
        keys = {"protocol", "node_id", "name", "origin", "public_key", "identity_fingerprint", "certificate_der", "certificate_sha256", "capabilities", "issued_at", "signature"}
        if not isinstance(value, dict) or set(value) != keys or len(canonical(value)) > 24576:
            raise ValueError("Invalid public card shape")
        card = copy.deepcopy(value)
        if card["protocol"] != PROTOCOL or card["origin"] != origin(card["origin"]):
            raise ValueError("Unsupported card")
        if any(not isinstance(card[k], str) or not 1 <= len(card[k]) <= 128 for k in ("node_id", "name", "issued_at")):
            raise ValueError("Invalid node metadata")
        if card["identity_fingerprint"] != _fingerprint(card["public_key"]):
            raise ValueError("Identity fingerprint mismatch")
        if card["capabilities"] not in (HOST_CAPABILITIES, INFERENCE_CAPABILITIES):
            raise ValueError("Unsupported capability contract")
        _certificate(card)
        signature = card.pop("signature")
        if not node_identity.verify(canonical(card), signature, card["public_key"]):
            raise ValueError("Invalid identity signature")
        card["signature"] = signature
        return card
    except HTTPException:
        raise
    except Exception as exc:
        fail(422, "invalid_card", f"The public computer card could not be verified: {exc}")


def local_card(address, *, capabilities=None, existing_only=False):
    from tls_cert import certificate_bundle
    capabilities = HOST_CAPABILITIES if capabilities is None else capabilities
    if capabilities not in (HOST_CAPABILITIES, INFERENCE_CAPABILITIES):
        fail(422, "invalid_capabilities", "Choose a supported full-host or inference-only computer profile.")
    address = origin(address)
    if not S.TLS_ENABLED or urlsplit(address).port != S.server_port():
        fail(409, "https_required", "Enable HTTPS on this computer and use its running listener port before exchanging cards.")
    try:
        bundle = certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, urlsplit(address).hostname)
    except ValueError as exc:
        fail(409, "certificate_unavailable", str(exc))
    if existing_only:
        # Setup is a read: it must not initialize or replace persisted identity.
        try:
            cfg = S.read_node_config()
            identity = node_identity.read_existing(S.DATA_DIR)
        except S._security.SecurityStateUnavailable:
            fail(409, "identity_unavailable", "This computer's saved identity is unavailable. Check TLI's data health before exchanging cards.")
        if cfg is None or identity is None:
            fail(409, "identity_unavailable", "This computer's saved identity is unavailable. Start TLI normally before exchanging cards.")
        public_key, fingerprint = identity["public_key_hex"], identity["fingerprint"]
    else:
        cfg = S.load_node_config()
        public_key, fingerprint = node_identity.public_key_hex(), node_identity.fingerprint()
    card = {"protocol": PROTOCOL, "node_id": cfg.node_id, "name": cfg.node_name,
            "origin": address, "public_key": public_key,
            "identity_fingerprint": fingerprint, "certificate_der": bundle["certificate_der"],
            "certificate_sha256": bundle["fingerprint"], "capabilities": list(capabilities),
            "issued_at": S.now_iso()}
    card["signature"] = (identity["private_key"].sign(canonical(card)).hex() if existing_only
                         else node_identity.sign(canonical(card)))
    return card


def local_setup(request):
    """Describe the running listener and its existing public card, without I/O to peers."""
    from tls_cert import _local_ipv4_addresses, certificate_bundle

    result = {"ok": True, "node": {"id": None, "name": None}, "ready": False,
              "code": "identity_unavailable", "reason": None, "origins": [],
              "selected_origin": None, "card": None}

    def unavailable(code, reason):
        result.update(code=code, reason=reason)
        return result

    try:
        cfg = S.read_node_config()
    except S._security.SecurityStateUnavailable:
        cfg = None
    if cfg is None:
        return unavailable("identity_unavailable", "This computer's saved identity is unavailable. Check TLI's data health before exchanging cards.")
    result["node"] = {"id": cfg.node_id, "name": cfg.node_name}

    setup_help = ("Open Settings > Security & connections > Phone Companion, expand Review host startup & network settings, "
                  "then review and save Secure home-network access. Restart TLI normally to apply it.")
    if not S.TLS_ENABLED:
        return unavailable("https_required", "This TLI server is running without HTTPS. " + setup_help)
    bind = getattr(S, "SERVER_BIND_HOST", None)
    if bind != "0.0.0.0":
        try:
            origin(f"https://{bind}:{S.server_port()}")
        except HTTPException:
            return unavailable("lan_required", "This TLI server is not listening on a supported private LAN address. " + setup_help)

    candidates = set()
    for host in _local_ipv4_addresses():
        if bind != "0.0.0.0" and host != bind:
            continue
        try:
            candidates.add(origin(f"https://{host}:{S.server_port()}"))
        except HTTPException:
            continue
    if not candidates:
        return unavailable("address_unavailable", "No private LAN IPv4 address is available on this TLI listener. Connect this computer to your home network, then check again.")

    certificate_errors = []
    for address in sorted(candidates):
        try:
            certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, urlsplit(address).hostname)
            result["origins"].append(address)
        except (ValueError, OSError) as exc:
            certificate_errors.append(str(exc))
    if not result["origins"]:
        return unavailable("certificate_unavailable", certificate_errors[0])

    selected = result["origins"][0] if len(result["origins"]) == 1 else None
    if selected is None:
        # A browser host can select an already enumerated, certificate-covered
        # address. It can never add a candidate or establish trust.
        selected = next((value for value in result["origins"]
                         if urlsplit(value).hostname == request.url.hostname), None)
    if selected is None:
        return unavailable("choose_address", "More than one private LAN address is available. Choose the address on the same home network as the other computer.")
    result["selected_origin"] = selected
    try:
        result["card"] = local_card(selected, existing_only=True)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        return unavailable(detail.get("code", "certificate_unavailable"), detail.get("message", str(exc.detail)))
    result.update(ready=True, code="ready")
    return result


def _credential(request):
    # Match resolve_user precedence: explicit Companion Authorization wins
    # over a browser cookie. Owner identity alone is not a session binding.
    authorization = request.headers.get("authorization")
    if authorization is not None:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            fail(401, "credential_required", "Use the accepted session credential.")
        return digest(["bearer", parts[1]])
    return digest(["browser", request.cookies.get("tli_session", "local-unlocked")])


def _review_revision(entry):
    # Background presence/discovery hints must not expire a human comparison.
    # Identity, endpoint, status, grants and every other saved field stay bound.
    if entry is None:
        return digest(None)
    value = copy.deepcopy(entry)
    value.pop("last_seen", None)
    value.pop("discovery", None)
    return digest(value)


def preview(card, grants, owner, request):
    card = validate_card(card)
    if card["node_id"] == S.load_node_config().node_id or card["public_key"] == node_identity.public_key_hex():
        fail(422, "same_computer", "Do not import this computer's own card.")
    if not isinstance(grants, list) or not grants or len(grants) != len(set(grants)) or not set(grants) <= GRANTS:
        fail(422, "invalid_grants", "Choose only the displayed observation, coordination, message or inference permissions.")
    if card["capabilities"] == INFERENCE_CAPABILITIES and grants != ["inference"]:
        fail(422, "invalid_grants", "This lightweight Node supports only the inference permission.")
    with LOCK:
        now = time.monotonic()
        for key in list(_PREVIEWS):
            if _PREVIEWS[key]["expires"] <= now:
                del _PREVIEWS[key]
        if len(_PREVIEWS) >= 32:
            fail(429, "review_busy", "Too many pending reviews; finish or wait for a review to expire.")
        current = S.load_mesh_directory().get(card["node_id"])
        token = secrets.token_urlsafe(24)
        _PREVIEWS[token] = {"owner": owner, "credential": _credential(request), "expires": now + 300,
                            "card": card, "grants": sorted(grants), "previous": _review_revision(current)}
    return {"ok": True, "protocol": PROTOCOL, "review_id": token, "expires_in": 300, "card": card,
            "grants": sorted(grants), "replaces_existing": current is not None, "actions_performed": False}


def approve(review_id, fingerprint, certificate_sha256, owner, request):
    with LOCK:
        item = _PREVIEWS.get(review_id)
        if not item or item["expires"] <= time.monotonic() or item["owner"] != owner or item["credential"] != _credential(request):
            fail(409, "review_required", "This trust review expired or belongs to another session. Review the card again.")
        card = validate_card(item["card"])
        if fingerprint != card["identity_fingerprint"] or certificate_sha256 != card["certificate_sha256"]:
            fail(409, "fingerprint_mismatch", "Compare both fingerprints with the other computer before trusting it.")
        directory = S.load_mesh_directory()
        if _review_revision(directory.get(card["node_id"])) != item["previous"]:
            fail(409, "review_changed", "This directory entry changed. Review it again.")
        # Only this exact ID is updated. Neither IP nor name grants identity.
        entry = copy.deepcopy(directory.get(card["node_id"]) or {})
        entry.update({"display_name": card["name"], "ip": urlsplit(card["origin"]).hostname,
                      "tli_port": urlsplit(card["origin"]).port, "status": "allowed", "identity_fingerprint": card["identity_fingerprint"],
                      "peer_trust": {"card": card, "grants": item["grants"], "reviewed_at": S.now_iso(), "reviewed_by": owner}})
        # This marker detects a missing security directory on subsequent starts.
        # Preserve every additive node configuration field and the existing ID.
        if not S.MESH_DIRECTORY_PATH.exists():
            S.save_mesh_directory(directory)
        with S._NODE_CONFIG_LOCK:
            cfg = S._security.read_json(S.NODE_CONFIG_PATH, "node configuration", 65536)
            cfg["peer_trust_established"] = True
            S._security.write_json(S.NODE_CONFIG_PATH, cfg, "node configuration")
        directory[card["node_id"]] = entry
        S.save_mesh_directory(directory)
        del _PREVIEWS[review_id]
    return {"ok": True, "protocol": PROTOCOL, "device_id": card["node_id"], "trust_state": "verified", "actions_performed": False}


def trusted(device_id, grant=None):
    entry = S.load_mesh_directory().get(device_id)
    if not entry:
        fail(404, "peer_missing", "This computer is no longer in the directory.")
    if entry.get("status") != "allowed":
        if entry.get("status") == "blocked":
            fail(403, "peer_not_allowed", "This computer is blocked here. Open Computers to review its public trust card and permissions. No peer request was sent.")
        fail(403, "peer_not_allowed", "This computer is pending review here. Open Computers to review its public trust card and permissions. No peer request was sent.")
    trust = entry.get("peer_trust")
    try:
        if (not isinstance(trust, dict) or not isinstance(trust.get("grants"), list)
                or not trust["grants"] or len(trust["grants"]) != len(set(trust["grants"]))
                or not set(trust["grants"]) <= GRANTS):
            raise ValueError()
        card = validate_card(trust["card"])
        if card["capabilities"] == INFERENCE_CAPABILITIES and trust["grants"] != ["inference"]:
            raise ValueError()
        if (card["node_id"] != device_id or card["origin"] != f"https://{entry.get('ip')}:{entry.get('tli_port')}"
                or card["identity_fingerprint"] != entry.get("identity_fingerprint")):
            raise ValueError()
    except (HTTPException, KeyError, TypeError, ValueError):
        fail(409, "review_required", "This computer's identity, certificate or address needs an explicit trust review.")
    if grant and grant not in trust.get("grants", []):
        fail(403, "capability_required", "This peer permission has not been reviewed on this computer.")
    return copy.deepcopy(entry), card, digest({"status": entry["status"], "trust": trust})


def message_readiness(device_id):
    """Local permission only; discovery and a local review cannot prove delivery."""
    with LOCK:
        try:
            trusted(device_id, "messages")
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            code = detail.get("code", "review_required")
            message = detail.get("message", "This computer needs an explicit trust review before messaging.")
            if code == "peer_not_allowed":
                entry = S.load_mesh_directory().get(device_id, {})
                if entry.get("status") == "blocked":
                    code = "peer_blocked"
                    message = "Blocked on this computer. Open Computers to review its public trust card and Text messages permission."
                else:
                    code = "peer_pending"
                    message = "Trust review needed on this computer. Open Computers, review its public trust card, and enable Text messages."
            elif code == "review_required":
                message = "Its identity, HTTPS certificate, or address needs review here. Open Computers and review its current public trust card with Text messages enabled."
            elif code == "capability_required":
                code = "messages_permission_required"
                message = "Text messages permission has not been reviewed here. Open Computers and review its public trust card with Text messages enabled."
            return {"available": False, "code": code, "message": message}
    return {"available": True, "code": "reviewed_locally",
            "message": "Text messages reviewed on this computer. The other computer must also review this computer and enable Text messages before delivery can succeed."}


def capability(device_id):
    try:
        _, card, revision = trusted(device_id, "observe")
        return {"available": True, "reason": None, "peer": {"id": device_id, "name": card["name"], "origin": card["origin"],
                "identity_fingerprint": card["identity_fingerprint"]}, "revision": revision, "capabilities": ["system_observation_v1"]}
    except HTTPException as exc:
        return {"available": False, "reason": exc.detail, "peer": None, "revision": None, "capabilities": []}


def public_trust(device_id):
    try:
        _, card, revision = trusted(device_id)
        result = {"trust_state": "verified", "trust_revision": revision, "origin": card["origin"],
                  "identity_fingerprint": card["identity_fingerprint"]}
        if card["capabilities"] == INFERENCE_CAPABILITIES:
            result["peer_profile"] = "inference_node"
        return result
    except HTTPException:
        return {"trust_state": "review_required", "trust_revision": None, "origin": None}


def _signed(method, path, body, recipient, stamp, nonce, sender):
    return canonical({"protocol": PROTOCOL, "method": method, "path": path, "body_sha256": hashlib.sha256(body).hexdigest(),
                      "recipient": recipient, "timestamp": stamp, "nonce": nonce, "sender": sender})


async def authenticate(request: Request, grant="coordinate"):
    names = ("x-tli-peer-id", "x-tli-peer-time", "x-tli-peer-nonce", "x-tli-peer-signature")
    if request.url.scheme != "https" or any(len(request.headers.getlist(name)) != 1 for name in names):
        fail(401, "peer_auth_required", "This endpoint requires a signed, reviewed HTTPS peer request.")
    sender, stamp, nonce, signature = [request.headers[name] for name in names]
    if len(sender) > 128 or len(nonce) != 48 or len(signature) != 128:
        fail(401, "invalid_peer_signature", "Malformed peer authentication.")
    try:
        if not stamp.isdecimal() or abs(time.time() - int(stamp)) > WINDOW or len(bytes.fromhex(nonce)) != 24:
            raise ValueError()
    except ValueError:
        fail(401, "peer_clock", "The peer request expired. Check both computer clocks; no operation ran.")
    _, card, revision = trusted(sender, grant)
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY:
            fail(413, "peer_body_limit", "Peer request is too large.")
    request._body = body
    path = request.url.path + ("?" + request.url.query if request.url.query else "")
    recipient = {"node_id": S.load_node_config().node_id, "public_key": node_identity.public_key_hex()}
    if not node_identity.verify(_signed(request.method, path, body, recipient, stamp, nonce, sender), signature, card["public_key"]):
        fail(401, "invalid_peer_signature", "Peer identity signature did not match this request.")
    with LOCK:
        now = time.time()
        for key in list(_NONCES):
            if _NONCES[key] < now - WINDOW * 2:
                del _NONCES[key]
        key = (sender, nonce)
        if key in _NONCES:
            fail(409, "peer_replay", "This peer request was already received; it was not replayed.")
        if len(_NONCES) >= 4096:
            fail(429, "peer_busy", "Peer replay protection is at capacity. Try a new request later.")
        if trusted(sender, grant)[2] != revision:
            fail(409, "peer_changed", "Peer trust changed before this request was admitted.")
        _NONCES[key] = now
    return {"device_id": sender, "revision": revision, "grant": grant}


async def coordinate_access(request: Request):
    return await authenticate(request, "coordinate")


async def observe_access(request: Request):
    return await authenticate(request, "observe")


async def message_access(request: Request):
    return await authenticate(request, "messages")


async def inference_access(request: Request):
    return await authenticate(request, "inference")


async def read_access(request: Request):
    from companion_auth import resolve_user
    # Legacy full system/disk routes are local-console reads. Reviewed peers
    # use the separate bounded observation endpoint and its explicit grant.
    return resolve_user(request)


def revalidate(access):
    if trusted(access["device_id"], access["grant"])[2] != access["revision"]:
        fail(409, "peer_changed", "Peer trust changed during the operation.")


class Response:
    def __init__(self, status, raw):
        self.status_code = status
        self.content = raw
        self.text = raw.decode("utf-8", errors="replace")
        self.ok = 200 <= status < 300

    def json(self):
        return json.loads(self.content)


def _exchange(card, method, path, body, headers, before_send):
    """Private literal address, trusted certificate, exact pin before headers."""
    cert = _certificate(card)
    context = ssl.create_default_context(cadata=cert.public_bytes(serialization.Encoding.PEM).decode("ascii"))
    parsed = urlsplit(card["origin"])
    conn = http.client.HTTPSConnection(parsed.hostname, parsed.port, context=context, timeout=5)
    timer = None
    try:
        conn.connect()
        if hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest() != card["certificate_sha256"]:
            fail(502, "peer_certificate_changed", "The computer's HTTPS certificate changed. Review it again before sending a request.")
        sock = conn.sock
        def expire():
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(8, expire)
        timer.daemon = True
        timer.start()
        before_send()
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        if response.status in (301, 302, 303, 307, 308):
            fail(502, "peer_redirect", "A peer redirect was refused. Review the actual computer address.")
        raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            fail(502, "peer_response_limit", "The peer response exceeded its bound.")
        return Response(response.status, raw)
    except HTTPException:
        raise
    except (TimeoutError, socket.timeout):
        fail(504, "peer_timeout", "The reviewed computer did not respond in time. No retry was sent.")
    except Exception:
        fail(502, "peer_unavailable", "The reviewed HTTPS computer could not be verified or reached. No HTTP fallback or retry was attempted.")
    finally:
        if timer:
            timer.cancel()
        conn.close()


def request(device_id, method, path, *, json_body=None, params=None, grant="coordinate", expected_revision=None, check=None):
    _, card, revision = trusted(device_id, grant)
    if expected_revision is not None and revision != expected_revision:
        fail(409, "peer_changed", "The selected computer changed. Review it again; no request was sent.")
    if not isinstance(path, str) or not path.startswith("/") or "?" in path or "#" in path or len(path) > 512:
        fail(422, "invalid_peer_path", "Invalid peer operation.")
    if params:
        path += "?" + urlencode(params)
    body = canonical(json_body) if json_body is not None else b""
    if len(body) > MAX_BODY:
        fail(413, "peer_body_limit", "Peer request is too large.")
    cfg = S.load_node_config()
    stamp, nonce = str(int(time.time())), secrets.token_hex(24)
    message = _signed(method, path, body, {"node_id": device_id, "public_key": card["public_key"]}, stamp, nonce, cfg.node_id)
    headers = {"Content-Type": "application/json", "Accept": "application/json", "X-TLI-Peer-Id": cfg.node_id,
               "X-TLI-Peer-Time": stamp, "X-TLI-Peer-Nonce": nonce, "X-TLI-Peer-Signature": node_identity.sign(message)}
    if trusted(device_id, grant)[2] != revision:
        fail(409, "peer_changed", "Peer trust changed before sending.")
    def before_send():
        if trusted(device_id, grant)[2] != revision:
            fail(409, "peer_changed", "Peer trust changed while connecting; no request was sent.")
        if check is not None:
            check()
    before_send()
    result = _exchange(card, method, path, body, headers, before_send)
    if check is not None:
        check()
    if trusted(device_id, grant)[2] != revision:
        fail(409, "peer_changed", "Peer trust changed while waiting. The response was not accepted.")
    if result.status_code == 401:
        fail(409, "peer_review_required", "The other computer did not accept this peer identity. Review both public cards there; your local browser session remains unchanged.")
    if grant == "messages" and path == "/mesh/chat/receive" and result.status_code in (403, 404, 409):
        try:
            detail = result.json().get("detail")
        except (ValueError, AttributeError):
            detail = None
        # A 409 capability_required also rejects retired file-message payloads;
        # that does not mean the recipient lacks text-message permission.
        if isinstance(detail, dict) and (detail.get("code") in {"peer_missing", "peer_not_allowed", "review_required"}
                                        or (detail.get("code") == "capability_required" and result.status_code == 403)):
            fail(409, "peer_message_review_required", "The other computer rejected this computer's trust or Text messages permission. Open Computers on the other computer, review this computer's public trust card, and enable Text messages before deliberately retrying.")
    return result


def _stream_exchange(card, method, path, body, headers, before_send):
    """Inference-only TLS stream; exact pin before credentials or prompt bytes.

    This boundary deliberately does not change the short legacy JSON transport.
    A hard socket shutdown bounds slow/drip-fed streams independently of reads.
    """
    cert = _certificate(card)
    context = ssl.create_default_context(cadata=cert.public_bytes(serialization.Encoding.PEM).decode("ascii"))
    parsed = urlsplit(card["origin"])
    conn = http.client.HTTPSConnection(parsed.hostname, parsed.port, context=context, timeout=5)
    timer = None
    expired = threading.Event()
    started = time.monotonic()
    try:
        conn.connect()
        if hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest() != card["certificate_sha256"]:
            fail(502, "peer_certificate_changed", "The computer's HTTPS certificate changed. Review it again before sending a request.")
        sock = conn.sock
        remaining = 120 - (time.monotonic() - started)
        if remaining <= 0:
            fail(504, "peer_timeout", "The peer inference deadline expired. No retry was sent.")
        sock.settimeout(min(90, remaining))
        def expire():
            expired.set()
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(remaining, expire)
        timer.daemon = True
        timer.start()
        before_send()
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        if response.status != 200:
            if response.status == 401:
                fail(409, "peer_review_required", "The other computer did not accept this peer identity. Review inference permission on both computers.")
            if response.status == 404:
                fail(409, "peer_inference_unsupported", "This computer does not support trusted inference. Update TLI there first.")
            code = response.status if response.status in (403, 409, 413, 422, 429, 503, 504) else 502
            fail(code, "peer_inference_rejected", "The selected computer could not accept this inference request. No retry or fallback was sent.")
        if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "text/event-stream":
            fail(502, "invalid_peer_stream", "The peer did not supply an inference event stream.")
        total = 0
        while True:
            before_send()
            raw = response.readline(16385)
            if expired.is_set():
                fail(504, "peer_timeout", "The peer inference deadline expired. No retry was sent.")
            if not raw:
                return
            total += len(raw)
            if len(raw) > 16384 or total > 1024 * 1024:
                fail(502, "peer_response_limit", "The peer stream exceeded its bound.")
            before_send()
            yield raw
    except HTTPException:
        raise
    except (TimeoutError, socket.timeout):
        fail(504, "peer_timeout", "The reviewed computer did not respond in time. No retry was sent.")
    except Exception:
        if expired.is_set():
            fail(504, "peer_timeout", "The peer inference deadline expired. No retry was sent.")
        fail(502, "peer_unavailable", "The reviewed HTTPS inference connection was interrupted. No retry or HTTP fallback was attempted.")
    finally:
        if timer:
            timer.cancel()
        conn.close()


def stream_request(device_id, *, json_body, expected_revision, check=None):
    """Send prepared text only to the exact reviewed inference endpoint."""
    _, card, revision = trusted(device_id, "inference")
    if expected_revision != revision:
        fail(409, "peer_changed", "The selected computer changed. Review it again; no request was sent.")
    path = "/agent/peer/inference/stream"
    body = canonical(json_body)
    if len(body) > MAX_BODY:
        fail(413, "peer_body_limit", "Peer inference input is too large. Nothing was shortened or sent.")
    cfg = S.load_node_config()
    stamp, nonce = str(int(time.time())), secrets.token_hex(24)
    signed = _signed("POST", path, body, {"node_id": device_id, "public_key": card["public_key"]}, stamp, nonce, cfg.node_id)
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream", "X-TLI-Peer-Id": cfg.node_id,
               "X-TLI-Peer-Time": stamp, "X-TLI-Peer-Nonce": nonce, "X-TLI-Peer-Signature": node_identity.sign(signed)}
    def recheck():
        if trusted(device_id, "inference")[2] != revision:
            fail(409, "peer_changed", "Inference permission or peer identity changed. The response was stopped.")
        if check is not None:
            check()
    recheck()
    lines = _stream_exchange(card, "POST", path, body, headers, recheck)
    try:
        for line in lines:
            recheck()
            yield line
        recheck()
    finally:
        close = getattr(lines, "close", None)
        if close:
            close()


def by_address(address):
    target = origin(address if str(address).startswith("https://") else "https://" + str(address))
    matches = []
    for device_id, entry in S.load_mesh_directory().items():
        if entry.get("peer_trust", {}).get("card", {}).get("origin") == target:
            matches.append(device_id)
    if len(matches) != 1:
        fail(409, "review_required", "Import and review this computer's public trust card first. The address must identify exactly one reviewed peer.")
    trusted(matches[0])
    return matches[0]


def health(device_id):
    _, card, _ = trusted(device_id, "coordinate")
    result = request(device_id, "GET", "/agent/peer/health")
    try:
        value = result.json()
        observed = datetime.fromisoformat(value["observed_at"].replace("Z", "+00:00"))
        if (result.status_code != 200 or value.get("ok") is not True or value.get("online") is not True
                or value.get("node_id") != device_id or value.get("node_name") != card["name"]
                or value.get("identity_fingerprint") != card["identity_fingerprint"]
                or observed.tzinfo is None or observed.utcoffset() is None
                or not -5 <= time.time() - observed.timestamp() <= 60
                or value.get("capabilities") != card["capabilities"]):
            raise ValueError()
        return {key: value[key] for key in ("ok", "online", "node_id", "node_name", "identity_fingerprint", "observed_at", "capabilities")}
    except Exception:
        fail(502, "invalid_peer_health", "The status response did not match the reviewed computer and current time.")


def observe(device_id, expected_revision):
    if not isinstance(expected_revision, str) or len(expected_revision) != 64:
        fail(409, "review_required", "Review the selected computer capability before observing it.")
    _, card, revision = trusted(device_id, "observe")
    result = request(device_id, "POST", "/agent/peer/observe", json_body={"kind": "system"}, grant="observe", expected_revision=expected_revision)
    if result.status_code != 200:
        fail(result.status_code if result.status_code in (401, 403, 409, 429, 503) else 502, "peer_observation_failed", "The selected computer did not supply an authorized observation. No host fallback ran.")
    try:
        value = result.json()
        expected = {"cpu_percent", "logical_cpus", "ram_total_bytes", "ram_used_bytes", "ram_available_bytes", "ram_percent", "uptime_seconds"}
        if value["protocol"] != "tli-peer-observation-v1" or value["host"]["id"] != device_id or value["host"]["identity_fingerprint"] != card["identity_fingerprint"]:
            raise ValueError()
        observed = datetime.fromisoformat(value["observed_at"].replace("Z", "+00:00"))
        if observed.tzinfo is None or observed.utcoffset() is None:
            raise ValueError()
        age = time.time() - observed.timestamp()
        if not -5 <= age <= 60 or set(value["facts"]) != expected:
            raise ValueError()
        for key, item in value["facts"].items():
            if item is None:
                continue
            if type(item) not in (int, float) or not math.isfinite(item) or item < 0 or item > 2**60:
                raise ValueError()
            if key.endswith("percent") and item > 100:
                raise ValueError()
        if not isinstance(value["scope"], str) or len(value["scope"]) > 1024 or not isinstance(value["limitations"], list) or len(value["limitations"]) > 8:
            raise ValueError()
        if any(not isinstance(x, str) or len(x) > 512 for x in value["limitations"]):
            raise ValueError()
        if value["host"].get("name") != card["name"]:
            raise ValueError()
        host = {"id": device_id, "name": card["name"], "identity_fingerprint": card["identity_fingerprint"]}
        known = sum(item is not None for item in value["facts"].values())
        return {"protocol": value["protocol"], "host": host, "observed_at": value["observed_at"], "facts": value["facts"],
                "scope": value["scope"], "limitations": value["limitations"], "peer_revision": revision,
                "coverage": {"complete": known == 7, "known_metrics": known, "total_metrics": 7}}
    except Exception:
        fail(502, "invalid_peer_observation", "The response did not match the reviewed computer, time or measurement contract.")


def validate_message_thread(message):
    # The historical store uses lowercase ASCII filenames capped at80 chars.
    # Reject new identifiers that would normalize, truncate, case-fold or
    # embed the pair delimiter into another computer's conversation.
    sender, recipient = message.get("from_id"), message.get("to_id")
    if (any(not isinstance(value, str) or not re.fullmatch(r"[a-z0-9_-]{1,78}", value)
            or "--" in value for value in (sender, recipient)) or sender == recipient):
        fail(409, "invalid_message_thread", "These computer identifiers cannot safely address a saved LAN thread. No message was sent or saved; existing history remains.")
    expected = "--".join(sorted((sender, recipient)))
    if len(expected) > 80 or message.get("thread_id") != expected:
        fail(409, "invalid_message_thread", "The message thread does not match these exact computers. No message was sent or saved.")


def validate_message(message):
    validate_message_thread(message)
    message_id = message.get("message_id")
    stamp = message.get("ts")
    if (not isinstance(message_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", message_id)
            or type(stamp) not in (int, float) or not math.isfinite(stamp)
            or not -300 <= time.time() - stamp / 1000 <= 86400):
        fail(409, "message_review_required", "This message identifier or creation time is missing or expired. Keep the draft and prepare a deliberate new message.")


def record_message_once(message, direction, append):
    """Durable, bounded duplicate protection; uncertain writes never replay."""
    validate_message(message)
    message_id, stamp = message["message_id"], message["ts"]
    projection = {k: message[k] for k in ("message_id", "thread_id", "from_id", "from_name", "to_id", "body", "ts")}
    signature = digest(projection)
    key = digest([direction, message["from_id"], message["to_id"], message_id])
    path = S.MESH_DIRECTORY_PATH.parent / "peer_message_receipts.json"
    with LOCK:
        try:
            ledger = S._security.read_json(path, "peer message receipts", 2 * 1024 * 1024)
        except FileNotFoundError:
            ledger = {}
        if not isinstance(ledger, dict) or len(ledger) > 4096 or any(not isinstance(x, dict) for x in ledger.values()):
            fail(503, "message_receipts_unavailable", "Saved delivery receipts are unavailable. Existing messages were preserved.")
        previous = ledger.get(key)
        if previous:
            if previous.get("signature") != signature:
                fail(409, "message_changed", "This message identifier already belongs to different text or identities.")
            if previous.get("status") != "complete":
                fail(409, "message_uncertain", "A previous message write started but its completion is uncertain. Inspect the thread; it was not repeated.")
            return True
        cutoff = time.time() - 86400 - 300
        ledger = {k: v for k, v in ledger.items() if not isinstance(v.get("created_at"), (int, float)) or v["created_at"] >= cutoff}
        if len(ledger) >= 4096:
            fail(429, "message_receipts_full", "The bounded message receipt store is full. No message was written.")
        ledger[key] = {"signature": signature, "status": "started", "created_at": stamp / 1000}
        S._security.write_json(path, ledger, "peer message receipts")
        append()
        ledger[key]["status"] = "complete"
        S._security.write_json(path, ledger, "peer message receipts")
        return False
