"""
node_identity.py — Cryptographic identity for TLI nodes.

Each TLI node generates a persistent Ed25519 keypair on first run.
The public key is the node's permanent identity fingerprint — shareable,
verifiable, requires no central authority.

The private key is stored DPAPI-protected on Windows (OS-user-bound).
On non-Windows it is stored as a plain binary in the identity file.

Usage:
    import node_identity
    node_identity.init(S.DATA_DIR)          # call once at startup

    node_identity.fingerprint()             # "a3f9:b2c1:7e4d:9a01:..."
    node_identity.public_key_hex()          # full 64-char hex public key
    node_identity.sign(b"hello")            # hex signature string
    node_identity.verify(b"hello", sig_hex, pub_hex)  # True / False
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding, NoEncryption, PrivateFormat, PublicFormat,
)

import data_protection as _dp
import security_state as _security

# Module-level cached identity (loaded once at startup)
_ident: Optional[dict] = None
_data_dir: str = "."
_LOCK = threading.RLock()


# ── Internal helpers ──────────────────────────────────────────────

def _identity_path() -> Path:
    return Path(_data_dir) / "node_identity.json"


def _fmt_fingerprint(pub_bytes: bytes) -> str:
    """
    SHA-256 of the 32-byte Ed25519 public key, formatted as
    8 groups of 4 hex chars separated by colons.
    Example: a3f9:b2c1:7e4d:9a01:3bc5:f802:d6e7:4f12
    """
    digest = hashlib.sha256(pub_bytes).hexdigest()[:32]
    return ":".join(digest[i:i + 4] for i in range(0, 32, 4))


def _protect(raw: bytes) -> bytes:
    if _dp.is_windows():
        try:
            return _dp.dpapi_protect(raw)
        except Exception as exc:
            raise _security.SecurityStateUnavailable("node identity") from exc
    return raw


def _unprotect(blob: bytes, is_protected: bool) -> bytes:
    if is_protected:
        if not _dp.is_windows():
            raise _security.SecurityStateUnavailable("node identity")
        try:
            return _dp.dpapi_unprotect(blob)
        except Exception as exc:
            raise _security.SecurityStateUnavailable("node identity") from exc
    return blob


# ── Public API ────────────────────────────────────────────────────

def init(data_dir: str) -> None:
    """Load or generate this node's identity. Call once at startup."""
    global _ident, _data_dir
    with _LOCK:
        _data_dir = data_dir
        _ident = None
        _ident = _load_or_create()


def read_existing(data_dir) -> Optional[dict]:
    """Validate persisted identity, including its keypair, without any writes."""
    path = Path(data_dir) / "node_identity.json"
    try:
        record = _security.read_json(path, "node identity", 65536)
    except FileNotFoundError:
        if _security.node_dependencies(data_dir):
            raise _security.SecurityStateUnavailable("node identity")
        try:
            cfg = _security.read_json(Path(data_dir) / "mesh" / "node_config.json", "node configuration", 65536)
        except FileNotFoundError:
            cfg = {}
        if not isinstance(cfg, dict) or (cfg and (not isinstance(cfg.get("node_id"), str) or not cfg["node_id"].strip())):
            raise _security.SecurityStateUnavailable("node configuration")
        if cfg.get("role") == "member" or cfg.get("host_device_id") or cfg.get("mesh_status") in ("pending", "approved", "blocked", "removed"):
            raise _security.SecurityStateUnavailable("node identity")
        return None
    try:
        if not isinstance(record, dict) or type(record.get("version", 1)) is not int or record.get("version", 1) != 1 or type(record.get("dpapi", False)) is not bool:
            raise ValueError("Invalid identity record")
        pub_bytes = bytes.fromhex(record["public_key"])
        if len(pub_bytes) != 32:
            raise ValueError("Invalid public key")
        priv_blob = base64.b64decode(record["private_key_enc"], validate=True)
        priv_key = Ed25519PrivateKey.from_private_bytes(_unprotect(priv_blob, record.get("dpapi", False)))
        if priv_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw) != pub_bytes:
            raise ValueError("Mismatched keypair")
        identity_id = "tli_" + pub_bytes.hex()[:12]
        if record.get("node_id", identity_id) != identity_id or not isinstance(record.get("created_at", ""), str):
            raise ValueError("Invalid identity metadata")
        return {"private_key": priv_key, "public_key_bytes": pub_bytes,
                "public_key_hex": pub_bytes.hex(), "fingerprint": _fmt_fingerprint(pub_bytes),
                "node_id": identity_id, "created_at": record.get("created_at", "")}
    except _security.SecurityStateUnavailable:
        raise
    except Exception as exc:
        raise _security.SecurityStateUnavailable("node identity") from exc


def _load_or_create() -> dict:
    path = _identity_path()
    existing = read_existing(_data_dir)
    if existing is not None:
        return existing

    # Generate a brand-new Ed25519 keypair
    priv_key   = Ed25519PrivateKey.generate()
    pub_key    = priv_key.public_key()
    priv_bytes = priv_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    pub_bytes  = pub_key.public_bytes(Encoding.Raw, PublicFormat.Raw)

    dpapi_flag = _dp.is_windows()
    priv_blob  = _protect(priv_bytes)
    now        = datetime.utcnow().isoformat() + "Z"
    node_id    = "tli_" + pub_bytes.hex()[:12]

    record = {
        "version":         1,
        "node_id":         node_id,
        "public_key":      pub_bytes.hex(),
        "private_key_enc": base64.b64encode(priv_blob).decode("ascii"),
        "dpapi":           dpapi_flag,
        "created_at":      now,
    }
    _security.write_json(path, record, "node identity", new=True)

    return {
        "private_key":      priv_key,
        "public_key_bytes": pub_bytes,
        "public_key_hex":   pub_bytes.hex(),
        "fingerprint":      _fmt_fingerprint(pub_bytes),
        "node_id":          node_id,
        "created_at":       now,
    }


def _ensure() -> dict:
    global _ident
    with _LOCK:
        if _ident is None:
            _ident = _load_or_create()
        return _ident


def fingerprint() -> str:
    """Return the human-readable identity fingerprint (8×4 hex groups)."""
    return _ensure()["fingerprint"]


def public_key_hex() -> str:
    """Return the full 64-char hex Ed25519 public key."""
    return _ensure()["public_key_hex"]


def node_id() -> str:
    """Return the short node identity ID (e.g. 'tli_a3f9b2c1...')."""
    return _ensure()["node_id"]


def created_at() -> str:
    return _ensure()["created_at"]


def sign(data: bytes) -> str:
    """Sign *data* with this node's private key. Returns a hex signature."""
    priv: Ed25519PrivateKey = _ensure()["private_key"]
    return priv.sign(data).hex()


def verify(data: bytes, signature_hex: str, pub_key_hex: str) -> bool:
    """
    Verify that *signature_hex* is a valid Ed25519 signature of *data*
    produced by the holder of *pub_key_hex*.
    Returns True on success, False on any failure.
    """
    try:
        pub  = Ed25519PublicKey.from_public_bytes(bytes.fromhex(pub_key_hex))
        sig  = bytes.fromhex(signature_hex)
        pub.verify(sig, data)   # raises InvalidSignature if bad
        return True
    except Exception:
        return False


def identity_card() -> dict:
    """Return a safe (no private key) summary dict for API responses."""
    ident = _ensure()
    return {
        "node_id":    ident["node_id"],
        "public_key": ident["public_key_hex"],
        "fingerprint": ident["fingerprint"],
        "created_at": ident["created_at"],
    }
