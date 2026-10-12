"""Ephemeral, human-confirmed LAN message pairing.

The unauthenticated HTTPS bootstrap exchanges signed public material only. A
commit/reveal transcript produces a code which people compare on both screens;
only a local browser confirmation can write the existing peer trust store.
"""
from __future__ import annotations

import copy
import hashlib
import http.client
import ipaddress
import json
import re
import secrets
import socket
import ssl
import threading
import time
from collections import deque
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

import node_identity
import peer_trust as P
import tli_state as S
from companion_auth import operation_access

PROTOCOL = "tli-message-pairing-v1"
GRANTS = ["messages"]
TTL = 300
MAX_BODY = 65536
MAX_REQUESTS = 32
_REQUESTS = {}
_RATES = {}
_GLOBAL_RATE = deque()
_PATHS = {"/agent/pairing/request", "/agent/pairing/reveal", "/agent/pairing/status"}


def _fail(code, reason, message):
    P.fail(code, reason, message)


def browser_owner(request: Request):
    """A peer/Companion credential or anonymous LAN client cannot approve trust."""
    if request.headers.get("authorization") is not None or any(k.startswith("x-tli-peer-") for k in request.headers):
        _fail(403, "pairing_browser_required", "Connect computers from the unlocked TLI browser on this computer.")
    expected = str(request.base_url).rstrip("/")
    if request.headers.get("sec-fetch-site") in ("cross-site", "same-site") or (request.headers.get("origin") and request.headers["origin"] != expected):
        _fail(403, "pairing_same_origin", "Connect computers from this TLI page.")
    token = request.cookies.get("tli_session")
    if token and S.validate_session_token(token):
        return S.get_session_user_id(token)
    try:
        loopback = ipaddress.ip_address(request.client.host).is_loopback
        local_host = request.url.hostname == "localhost" or ipaddress.ip_address(request.url.hostname).is_loopback
    except (ValueError, AttributeError):
        loopback, local_host = False, False
    pin_enabled = S.load_pin_config()["enabled"]
    if loopback and local_host and not pin_enabled:
        return "local"
    _fail(401 if pin_enabled else 403, "pairing_browser_required", "Unlock TLI with its PIN, or open TLI at localhost on this computer, before connecting computers.")


def _clean():
    now = time.monotonic()
    for key, item in list(_REQUESTS.items()):
        if item["expires"] <= now:
            del _REQUESTS[key]
    for key, stamps in list(_RATES.items()):
        while stamps and stamps[0] <= now - 60:
            stamps.popleft()
        if not stamps:
            del _RATES[key]
    while _GLOBAL_RATE and _GLOBAL_RATE[0] <= now - 60:
        _GLOBAL_RATE.popleft()


def _rate(key, limit):
    with P.LOCK:
        _clean()
        if len(_GLOBAL_RATE) >= 120 or (key not in _RATES and len(_RATES) >= 64):
            _fail(429, "pairing_busy", "Too many connection requests. Wait a minute and try again.")
        stamps = _RATES.setdefault(key, deque())
        if len(stamps) >= limit:
            _fail(429, "pairing_busy", "Too many connection requests. Wait a minute and try again.")
        stamps.append(time.monotonic())
        _GLOBAL_RATE.append(time.monotonic())


def _hex(value, size):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{%d}" % size, value) is not None


def _sign(kind, **values):
    result = {"protocol": PROTOCOL, "kind": kind, **values}
    result["signature"] = node_identity.sign(P.canonical(result))
    return result


def _verify(value, kind, keys, card):
    if (not isinstance(value, dict) or set(value) != set(keys) | {"protocol", "kind", "signature"}
            or value.get("protocol") != PROTOCOL or value.get("kind") != kind):
        _fail(422, "pairing_invalid", "This computer sent an unsupported connection request. Update TLI on both computers.")
    unsigned = {key: item for key, item in value.items() if key != "signature"}
    if not node_identity.verify(P.canonical(unsigned), value["signature"], card["public_key"]):
        _fail(403, "pairing_signature", "The connection request signature could not be verified.")


def _card(value):
    card = P.validate_card(value)
    if card["capabilities"] != P.HOST_CAPABILITIES:
        _fail(422, "pairing_messages_only", "This connection flow requires the full TLI app on both computers.")
    if card["node_id"] == S.load_node_config().node_id or card["public_key"] == node_identity.public_key_hex():
        _fail(422, "same_computer", "Choose another TLI computer.")
    return card


def _eligible(device_id):
    entry = S.load_mesh_directory().get(device_id)
    if entry and (entry.get("status") == "blocked" or entry.get("peer_trust")):
        _fail(409, "pairing_manual_review", "This computer is blocked or already has reviewed trust. Use the public card review to change its identity or permissions.")
    return P._review_revision(entry)


def _commit(init, nonce):
    return P.digest({"protocol": PROTOCOL, "request_id": init["request_id"], "target_id": init["target_id"],
                     "target_origin": init["target_origin"], "card": init["card"], "nonce": nonce, "grants": GRANTS})


def _transcript(init, response, nonce):
    return P.digest({"protocol": PROTOCOL, "init": init, "response": response, "nonce": nonce, "grants": GRANTS})


def _code(transcript):
    value = P.digest([PROTOCOL, "screen-comparison", transcript])[:12].upper()
    return "-".join(value[i:i + 4] for i in range(0, 12, 4))


def _item(direction, peer, previous, **values):
    return {"direction": direction, "peer": peer, "previous": previous, "expires": time.monotonic() + TTL,
            "expires_at": datetime.fromtimestamp(time.time() + TTL, timezone.utc).isoformat(),
            "owner": None, "credential": None, "local_confirmed": False, "remote_confirmed": False,
            "cancelled": False, "transcript": None, **values}


def _valid_local_confirmation(item):
    if not item["local_confirmed"]:
        return False
    try:
        _, card, revision = P.trusted(item["peer"]["node_id"], "messages")
        return revision == item.get("confirmed_revision") and card == item["peer"]
    except HTTPException:
        return False


def _view(item):
    local = _valid_local_confirmation(item)
    state = ("cancelled" if item["cancelled"] else "connected" if local and item["remote_confirmed"] else
             "waiting" if local or not item["transcript"] else "comparing")
    return {"request_id": item["init"]["request_id"], "direction": item["direction"],
            "peer": {"id": item["peer"]["node_id"], "name": item["peer"]["name"], "origin": item["peer"]["origin"]},
            "code": _code(item["transcript"]) if item["transcript"] else None, "expires_at": item["expires_at"],
            "state": state, "local_confirmed": local, "remote_confirmed": item["remote_confirmed"], "grants": list(GRANTS)}


def _owned(request_id, owner, request):
    if browser_owner(request) != owner:
        _fail(403, "pairing_session_changed", "Unlock the original browser before continuing this connection request.")
    _clean()
    item = _REQUESTS.get(request_id)
    if not item:
        _fail(404, "pairing_expired", "This connection request expired. Send a new request.")
    if item["owner"] != owner or item["credential"] != P._credential(request):
        _fail(403, "pairing_session_changed", "Continue this connection request in the browser that opened it.")
    item["access"]()
    _local_unchanged(item, request)
    return item


def _local_unchanged(item, request):
    frozen = item["init"]["card"] if item["direction"] == "outgoing" else item["response"]["card"]
    setup = P.local_setup(request)
    if (not setup["ready"] and setup.get("code") != "choose_address") or frozen["origin"] not in setup["origins"]:
        _fail(409, "pairing_local_changed", "This computer's HTTPS connection changed. Send a new connection request.")
    current = P.local_card(frozen["origin"], existing_only=True)
    if any(current[key] != frozen[key] for key in ("node_id", "name", "origin", "public_key", "certificate_sha256", "capabilities")):
        _fail(409, "pairing_local_changed", "This computer's identity changed. Send a new connection request.")


def requests(owner, request):
    with P.LOCK:
        _clean()
        result = []
        for item in _REQUESTS.values():
            if item["owner"] is None:
                item.update(owner=owner, credential=P._credential(request), access=operation_access(request, owner))
            if item["owner"] == owner and item["credential"] == P._credential(request):
                try:
                    item["access"]()
                except HTTPException:
                    continue
                result.append(_view(item))
        return {"ok": True, "supported": True, "requests": result}


def _exchange(address, path, payload, pin=None, *, source_origin):
    """Only public pairing material; literal private HTTPS with exact leaf pins.

    The first response is not authority: its leaf must match its signed card and
    its eventual code must be compared. Subsequent sends pin before any bytes.
    """
    address = P.origin(address)
    if path not in _PATHS:
        _fail(422, "pairing_path", "Unsupported connection operation.")
    body = P.canonical(payload)
    if len(body) > MAX_BODY:
        _fail(413, "pairing_body_limit", "The connection request exceeded its limit.")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    parsed = urlsplit(address)
    source_ip = urlsplit(P.origin(source_origin)).hostname
    conn = http.client.HTTPSConnection(parsed.hostname, parsed.port, context=context, timeout=4, source_address=(source_ip, 0))
    timer = None
    try:
        conn.connect()
        leaf = hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest()
        if pin is not None and not secrets.compare_digest(leaf, pin):
            _fail(409, "pairing_certificate_changed", "The other computer's certificate changed. Cancel and review the computer again.")
        sock = conn.sock
        def expire():
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(6, expire)
        timer.daemon = True
        timer.start()
        conn.request("POST", path, body=body, headers={"Content-Type": "application/json", "Accept": "application/json"})
        response = conn.getresponse()
        raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            _fail(502, "pairing_body_limit", "The other computer sent an oversized connection response.")
        if response.status in (404, 405):
            _fail(409, "pairing_update_required", "This computer does not support connection requests yet. Update TLI on both computers, or use public cards.")
        if response.status != 200:
            _fail(502, "pairing_unavailable", "The other computer could not accept this connection request. Open TLI there and check HTTPS and existing trust.")
        return json.loads(raw), leaf
    except HTTPException:
        raise
    except Exception:
        _fail(502, "pairing_unavailable", "Could not reach this TLI computer securely. Open TLI there and check its HTTPS connection.")
    finally:
        if timer:
            timer.cancel()
        conn.close()


def start(device_id, local_origin, owner, request):
    _rate(("start", owner), 6)
    setup = P.local_setup(request)
    if not setup["ready"] and setup.get("code") != "choose_address":
        _fail(409, setup["code"], setup["reason"])
    local_origin = local_origin or setup["selected_origin"]
    if local_origin not in setup["origins"]:
        raise HTTPException(422, {"code": "pairing_origin_required", "message": "Choose this computer's HTTPS LAN address before sending a connection request.",
                                  "origins": setup["origins"]})
    local = P.local_card(local_origin, existing_only=True)
    with P.LOCK:
        _clean()
        previous = _eligible(device_id)
        directory = S.load_mesh_directory().get(device_id)
        if not directory or device_id == local["node_id"]:
            _fail(404, "pairing_peer_missing", "Choose a discovered TLI computer.")
        address = P.origin(f"https://{directory.get('ip')}:{directory.get('tli_port', 8000)}")
        if len(_REQUESTS) >= MAX_REQUESTS:
            _fail(429, "pairing_busy", "Finish a pending connection request or wait for it to expire.")
        if any(i["peer"]["node_id"] == device_id and not i["cancelled"] for i in _REQUESTS.values()):
            _fail(409, "pairing_exists", "A connection request for this computer is already open. Review it below.")
        request_id, nonce = secrets.token_hex(24), secrets.token_hex(32)
        values = {"request_id": request_id, "target_id": device_id, "target_origin": address, "card": local,
                  "sent_at": int(time.time())}
        values["commitment"] = _commit(values, nonce)
        init = _sign("request", **values)
        item = _item("outgoing", {"node_id": device_id, "name": directory.get("display_name") or device_id, "origin": address},
                     previous, init=init, owner=owner, credential=P._credential(request), access=operation_access(request, owner))
        _REQUESTS[request_id] = item
    try:
        response, leaf = _exchange(address, "/agent/pairing/request", init, source_origin=local_origin)
        card = _card(response.get("card") if isinstance(response, dict) else None)
        _verify(response, "response", {"request_id", "init_digest", "card", "nonce"}, card)
        if (card["node_id"] != device_id or card["origin"] != address or card["certificate_sha256"] != leaf
                or response["request_id"] != request_id or response["init_digest"] != P.digest(init) or not _hex(response["nonce"], 64)):
            _fail(409, "pairing_changed", "The discovered computer did not match its connection response. Review its public card.")
        with P.LOCK:
            _owned(request_id, owner, request)
            if _eligible(device_id) != previous or item["cancelled"]:
                _fail(409, "pairing_changed", "This computer changed during connection setup. Start a fresh review.")
            item.update(peer=card, response=response)
            transcript = _transcript(init, response, nonce)
        poll_nonce = secrets.token_hex(24)
        reveal = _sign("reveal", request_id=request_id, init_digest=P.digest(init), response_digest=P.digest(response), nonce=nonce, poll_nonce=poll_nonce)
        status, _ = _exchange(address, "/agent/pairing/reveal", reveal, card["certificate_sha256"], source_origin=local_origin)
        _accept_status(item, status, transcript, poll_nonce)
        with P.LOCK:
            _owned(request_id, owner, request)
            if item["cancelled"]:
                _fail(409, "pairing_cancelled", "This connection request was cancelled.")
            item["transcript"] = transcript
            return {"ok": True, "request": _view(item)}
    except Exception:
        with P.LOCK:
            item["cancelled"] = True
        raise


def _peer_source(request, card):
    if request.url.scheme != "https" or not S.TLS_ENABLED:
        _fail(403, "https_required", "Connection requests require HTTPS.")
    if request.headers.get("authorization") is not None or request.headers.get("cookie") or any(k.startswith("x-tli-peer-") for k in request.headers):
        _fail(403, "pairing_public_only", "Connection requests carry public handshake material only.")
    if not request.client or request.client.host != urlsplit(card["origin"]).hostname:
        _fail(403, "pairing_address_mismatch", "The connection request did not come from its stated LAN address.")


def receive(init, request):
    _rate(("receive", request.client.host if request.client else "unknown"), 6)
    card = _card(init.get("card") if isinstance(init, dict) else None)
    _peer_source(request, card)
    _verify(init, "request", {"request_id", "target_id", "target_origin", "card", "sent_at", "commitment"}, card)
    if (not _hex(init["request_id"], 48) or not _hex(init["commitment"], 64)
            or type(init["sent_at"]) is not int or abs(time.time() - init["sent_at"]) > 60
            or init["target_id"] != S.load_node_config().node_id):
        _fail(422, "pairing_invalid", "This connection request is invalid or expired.")
    # The target origin must be an actual local adapter/certificate, not Host.
    setup = P.local_setup(request)
    if (not setup["ready"] and setup.get("code") != "choose_address") or init["target_origin"] not in setup["origins"]:
        _fail(409, "pairing_local_address", "The selected HTTPS address is not available on this computer.")
    with P.LOCK:
        _clean()
        previous = _eligible(card["node_id"])
        if init["request_id"] in _REQUESTS or any((i["peer"]["node_id"] == card["node_id"] or
                urlsplit(i["peer"]["origin"]).hostname == request.client.host) and not i["cancelled"] for i in _REQUESTS.values()):
            _fail(409, "pairing_exists", "A connection request for this computer is already open.")
        if len(_REQUESTS) >= MAX_REQUESTS:
            _fail(429, "pairing_busy", "Too many pending connection requests.")
        local = P.local_card(init["target_origin"], existing_only=True)
        response = _sign("response", request_id=init["request_id"], init_digest=P.digest(init), card=local, nonce=secrets.token_hex(32))
        _REQUESTS[init["request_id"]] = _item("incoming", card, previous, init=copy.deepcopy(init), response=response)
        return copy.deepcopy(response)


def _incoming(payload, request, phase):
    _rate(("peer-status", request.client.host if request.client else "unknown"), 40)
    _clean()
    request_id = payload.get("request_id") if isinstance(payload, dict) else None
    item = _REQUESTS.get(request_id) if isinstance(request_id, str) else None
    if not item or item["direction"] != "incoming" or (item["cancelled"] and phase != "poll"):
        _fail(404, "pairing_expired", "This connection request expired or was cancelled.")
    _peer_source(request, item["peer"])
    keys = {"request_id", "init_digest", "response_digest", "nonce", "poll_nonce"} if phase == "reveal" else {"request_id", "transcript", "poll_nonce", "local_confirmed", "cancelled"}
    _verify(payload, phase, keys, item["peer"])
    if not _hex(payload["poll_nonce"], 48):
        _fail(422, "pairing_invalid", "Invalid connection status request.")
    _local_unchanged(item, request)
    seen = item.setdefault("seen_polls", set())
    if payload["poll_nonce"] in seen or len(seen) >= 200:
        _fail(409, "pairing_replayed", "This connection status request was already used.")
    seen.add(payload["poll_nonce"])
    return item


def _status(item, poll_nonce):
    return _sign("status", request_id=item["init"]["request_id"], transcript=item["transcript"], poll_nonce=poll_nonce,
                 local_confirmed=_valid_local_confirmation(item), cancelled=item["cancelled"])


def reveal(payload, request):
    with P.LOCK:
        item = _incoming(payload, request, "reveal")
        if (item["transcript"] or payload["init_digest"] != P.digest(item["init"])
                or payload["response_digest"] != P.digest(item["response"]) or not _hex(payload["nonce"], 64)
                or not secrets.compare_digest(_commit(item["init"], payload["nonce"]), item["init"]["commitment"])):
            _fail(409, "pairing_transcript_changed", "The connection comparison changed. Start a new request.")
        if _eligible(item["peer"]["node_id"]) != item["previous"]:
            _fail(409, "pairing_changed", "This computer changed during connection setup. Start a fresh review.")
        item["transcript"] = _transcript(item["init"], item["response"], payload["nonce"])
        return _status(item, payload["poll_nonce"])


def status(payload, request):
    with P.LOCK:
        item = _incoming(payload, request, "poll")
        if (not item["transcript"] or payload["transcript"] != item["transcript"]
                or type(payload["local_confirmed"]) is not bool or type(payload["cancelled"]) is not bool):
            _fail(409, "pairing_transcript_changed", "This connection comparison is not ready or has changed.")
        item["remote_confirmed"] = payload["local_confirmed"]
        item["cancelled"] = item["cancelled"] or payload["cancelled"]
        return _status(item, payload["poll_nonce"])


def _accept_status(item, status, transcript, poll_nonce):
    _verify(status, "status", {"request_id", "transcript", "poll_nonce", "local_confirmed", "cancelled"}, item["peer"])
    if (status["request_id"] != item["init"]["request_id"] or status["transcript"] != transcript
            or status["poll_nonce"] != poll_nonce or type(status["local_confirmed"]) is not bool or type(status["cancelled"]) is not bool):
        _fail(409, "pairing_transcript_changed", "The connection status did not match this comparison.")
    with P.LOCK:
        item["remote_confirmed"] = status["local_confirmed"]
        item["cancelled"] = item["cancelled"] or status["cancelled"]


def refresh(request_id, owner, request):
    with P.LOCK:
        item = _owned(request_id, owner, request)
        if item["direction"] != "outgoing" or item["cancelled"] or not item["transcript"]:
            return {"ok": True, "request": _view(item)}
        if time.monotonic() - item.get("last_poll", -100) < 2:
            return {"ok": True, "request": _view(item)}
        item["last_poll"] = time.monotonic()
        poll_nonce = secrets.token_hex(24)
        payload = _sign("poll", request_id=request_id, transcript=item["transcript"], poll_nonce=poll_nonce,
                        local_confirmed=_valid_local_confirmation(item), cancelled=False)
    value, _ = _exchange(item["peer"]["origin"], "/agent/pairing/status", payload, item["peer"]["certificate_sha256"], source_origin=item["init"]["card"]["origin"])
    with P.LOCK:
        _owned(request_id, owner, request)
        _accept_status(item, value, item["transcript"], poll_nonce)
        return {"ok": True, "request": _view(item)}


def confirm(request_id, code, allow_messages, owner, request):
    with P.LOCK:
        item = _owned(request_id, owner, request)
        if item["cancelled"] or not item["transcript"] or code != _code(item["transcript"]) or allow_messages is not True:
            _fail(409, "pairing_compare_required", "Compare the code on both computers and explicitly allow LAN messages before connecting.")
        if item["local_confirmed"]:
            if not _valid_local_confirmation(item):
                _fail(409, "pairing_changed", "Trust changed after this confirmation. Use the public card review.")
            return {"ok": True, "request": _view(item)}
        if _eligible(item["peer"]["node_id"]) != item["previous"]:
            _fail(409, "pairing_changed", "This computer changed during your comparison. Start a fresh review.")
        preview = P.preview(item["peer"], list(GRANTS), owner, request)
        card = item["peer"]
        P.approve(preview["review_id"], card["identity_fingerprint"], card["certificate_sha256"], owner, request)
        item["local_confirmed"] = True
        item["confirmed_revision"] = P.trusted(card["node_id"], "messages")[2]
        return {"ok": True, "request": _view(item)}


def cancel(request_id, owner, request):
    with P.LOCK:
        item = _owned(request_id, owner, request)
        item["cancelled"] = True
        if item["direction"] == "outgoing" and item["transcript"]:
            poll_nonce = secrets.token_hex(24)
            payload = _sign("poll", request_id=request_id, transcript=item["transcript"], poll_nonce=poll_nonce,
                            local_confirmed=_valid_local_confirmation(item), cancelled=True)
        else:
            payload = None
    if payload:
        try:
            value, _ = _exchange(item["peer"]["origin"], "/agent/pairing/status", payload, item["peer"]["certificate_sha256"], source_origin=item["init"]["card"]["origin"])
            _accept_status(item, value, item["transcript"], poll_nonce)
        except HTTPException:
            pass  # Local cancellation remains final even if the peer is offline.
    with P.LOCK:
        return {"ok": True, "request": _view(item)}
