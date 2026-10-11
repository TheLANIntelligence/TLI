"""
identity_routes.py — REST endpoints for TLI Node Identity.

GET  /identity              → identity card (node_id, public_key, fingerprint)
POST /identity/sign         → sign arbitrary payload with this node's private key
POST /identity/verify       → verify a signature from any node
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import node_identity

router = APIRouter(tags=["identity"])


# ── Schemas ──────────────────────────────────────────────────────────

class SignRequest(BaseModel):
    data_hex: str   # hex-encoded bytes to sign


class SignResponse(BaseModel):
    data_hex:      str
    signature_hex: str
    public_key:    str
    node_id:       str


class VerifyRequest(BaseModel):
    data_hex:      str
    signature_hex: str
    public_key_hex: str


class VerifyResponse(BaseModel):
    valid: bool


# ── Endpoints ────────────────────────────────────────────────────────

@router.get("/identity")
def get_identity():
    """Return the public identity card for this node."""
    return node_identity.identity_card()


@router.post("/identity/sign", response_model=SignResponse)
def sign_data(req: SignRequest):
    """
    Sign *data_hex* with this node's Ed25519 private key.
    Useful for proving node ownership or authenticating messages.
    """
    try:
        raw = bytes.fromhex(req.data_hex)
    except ValueError:
        raise HTTPException(status_code=400, detail="data_hex is not valid hex")

    sig_hex = node_identity.sign(raw)
    return SignResponse(
        data_hex=req.data_hex,
        signature_hex=sig_hex,
        public_key=node_identity.public_key_hex(),
        node_id=node_identity.node_id(),
    )


@router.post("/identity/verify", response_model=VerifyResponse)
def verify_signature(req: VerifyRequest):
    """
    Verify that *signature_hex* is a valid Ed25519 signature of *data_hex*
    produced by the holder of *public_key_hex*.
    Works for any node's public key — not just this node.
    """
    try:
        raw = bytes.fromhex(req.data_hex)
    except ValueError:
        raise HTTPException(status_code=400, detail="data_hex is not valid hex")

    valid = node_identity.verify(raw, req.signature_hex, req.public_key_hex)
    return VerifyResponse(valid=valid)
