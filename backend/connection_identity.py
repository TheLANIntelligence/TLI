"""Public, nonce-bound identity proof; never accepts or issues credentials."""
from __future__ import annotations

import secrets
import threading
import time
from collections import deque
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

import lan_endpoints
import node_identity
import peer_trust as P
import tli_state as S
import tls_cert

PROTOCOL = "tli-endpoint-v1"
router = APIRouter(tags=["connection identity"], route_class=P.BoundedPeerRoute)
_LOCK = threading.Lock()
_REQUESTS = deque()


class Challenge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nonce: str = Field(pattern=r"^[0-9a-f]{48}$")
    origin: str = Field(min_length=1, max_length=300)
    node_id: str = Field(min_length=1, max_length=128)


def identity_proof(challenge: Challenge):
    address = P.origin(challenge.origin)
    origins = tls_cert.stable_lan_origins(S.server_port())
    origins.extend(f"https://{ip}:{S.server_port()}" for ip in tls_cert.lan_listener_addresses())
    if not S.TLS_ENABLED or address not in origins:
        raise HTTPException(409, "This is not a configured secure LAN identity.")
    bundle = tls_cert.certificate_bundle(S.TLS_CERT_PATH, S.TLS_KEY_PATH, urlsplit(address).hostname)
    cfg = S.read_node_config()
    identity = node_identity.read_existing(S.DATA_DIR)
    if cfg is None or identity is None or not secrets.compare_digest(cfg.node_id, challenge.node_id):
        raise HTTPException(409, "The requested computer identity does not match.")
    now = int(time.time())
    result = {"protocol": PROTOCOL, "node_id": cfg.node_id, "public_key": identity["public_key_hex"],
              "origin": address, "certificate_sha256": bundle["fingerprint"], "nonce": challenge.nonce,
              "issued_at": now, "expires_at": now + 30}
    result["signature"] = identity["private_key"].sign(P.canonical(result)).hex()
    return result


@router.post("/api/connection/v1/identity")
def challenge(body: Challenge, request: Request, response: Response):
    if (request.url.scheme != "https" or not request.client
            or not lan_endpoints.private_ip(request.client.host)
            or request.headers.get("authorization") or request.headers.get("cookie")
            or any(key.startswith("x-tli-peer-") for key in request.headers)):
        raise HTTPException(403, "Identity checks use public material over the local HTTPS connection only.")
    now = time.monotonic()
    with _LOCK:
        while _REQUESTS and _REQUESTS[0] < now - 60:
            _REQUESTS.popleft()
        if len(_REQUESTS) >= 120:
            raise HTTPException(429, "Too many identity checks; try again shortly.")
        _REQUESTS.append(now)
    response.headers["Cache-Control"] = "no-store"
    return identity_proof(body)
