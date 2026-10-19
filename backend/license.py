# backend/license.py
# TLI License key system — offline HMAC-SHA256 validation.
#
# Key format:  TLI1-{b64url_payload}.{b64url_sig}
#
# Payload is a JSON object (base64url-encoded):
#   {
#     "tier":       "pro" | "trial" | "free",
#     "licensee":   "Display Name",
#     "issued_at":  "2024-01-01T00:00:00Z",
#     "expires_at": "2025-01-01T00:00:00Z" | null,
#     "node_id":    "<uuid>" | null          # machine-bound if set
#   }
#
# Signature is HMAC-SHA256(secret, payload_bytes), base64url-encoded.
# The secret is set via env TLI_LICENSE_SECRET (fall back to FALLBACK_SECRET
# for development — change it before shipping a production build).

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

# ============================================
#  Secret
# ============================================

def _get_secret() -> bytes:
    """
    Load the license signing secret from the environment or a local secrets file.
    Never falls back to a hardcoded string — BETA_MODE bypasses license checks entirely
    so the secret is only needed when BETA_MODE is False.
    """
    raw = os.environ.get("TLI_LICENSE_SECRET", "").strip()
    if not raw:
        # Try local secrets file (never committed to source control)
        import tli_state as _S
        secrets_path = os.path.join(_S.DATA_DIR, "license_secret.txt")
        if os.path.exists(secrets_path):
            with open(secrets_path, "r", encoding="utf-8") as f:
                raw = f.read().strip()
    if not raw:
        raise RuntimeError(
            "TLI_LICENSE_SECRET is not set. "
            "Set the environment variable or write the secret to data/license_secret.txt. "
            "This is only required when BETA_MODE is False."
        )
    return raw.encode("utf-8")


# ============================================
#  Beta mode — unlocks all features, no key required
#  Set to False when license enforcement is enabled for commercial release.
# ============================================

BETA_MODE = True

# ============================================
#  Tiers & features
# ============================================

Tier = Literal["free", "trial", "pro"]

# Features available per tier (inclusive: each tier includes everything below)
_TIER_RANK: Dict[str, int] = {"free": 0, "trial": 1, "pro": 2}

_FEATURE_MINIMUM_TIER: Dict[str, str] = {
    "mesh":             "pro",    # multi-node mesh networking
    "vault":            "pro",    # encrypted vault
    "home_automation":  "trial",  # Shelly / home power
    "advanced_ai":      "trial",  # model config, system profiles
    "peer_nodes":       "pro",    # become_host / join mesh
    "multi_shelly":     "trial",  # more than 1 Shelly device
    "debug_panel":      "pro",    # debug log viewer
}


def has_feature(tier: str, feature: str) -> bool:
    """Return True if *tier* unlocks *feature*. Always True in BETA_MODE."""
    if BETA_MODE:
        return True
    min_rank = _TIER_RANK.get(_FEATURE_MINIMUM_TIER.get(feature, "free"), 0)
    user_rank = _TIER_RANK.get(tier, 0)
    return user_rank >= min_rank


# ============================================
#  Encoding helpers
# ============================================

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    # Re-pad
    pad = 4 - len(s) % 4
    if pad != 4:
        s += "=" * pad
    return base64.urlsafe_b64decode(s)


# ============================================
#  Core sign / validate
# ============================================

def _sign(payload_bytes: bytes) -> str:
    sig = hmac.new(_get_secret(), payload_bytes, hashlib.sha256).digest()
    return _b64url_encode(sig)


def generate_key(
    tier: Tier,
    licensee: str,
    expires_at: Optional[str] = None,
    node_id: Optional[str] = None,
) -> str:
    """
    Generate a signed license key.  Called by tools/keygen.py — never called
    by the running app (only *validate_key* runs in production).
    """
    payload: Dict[str, Any] = {
        "tier":       tier,
        "licensee":   licensee,
        "issued_at":  datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expires_at": expires_at,
        "node_id":    node_id,
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64   = _b64url_encode(payload_bytes)
    sig_b64       = _sign(payload_bytes)
    return f"TLI1-{payload_b64}.{sig_b64}"


class LicenseError(Exception):
    """Raised when a key is structurally invalid (not expired — that's separate)."""


def _parse_key(key: str) -> Dict[str, Any]:
    """
    Verify structure + signature.  Returns the payload dict.
    Raises LicenseError on any structural problem.
    Does NOT check expiry or node binding — caller must do that.
    """
    key = key.strip()
    if not key.startswith("TLI1-"):
        raise LicenseError("Not a TLI license key")
    rest = key[5:]  # strip "TLI1-"
    if "." not in rest:
        raise LicenseError("Malformed key (missing separator)")
    payload_b64, sig_b64 = rest.rsplit(".", 1)
    try:
        payload_bytes = _b64url_decode(payload_b64)
    except Exception:
        raise LicenseError("Malformed key (payload decode failed)")
    # Verify signature
    expected_sig = _sign(payload_bytes)
    if not hmac.compare_digest(expected_sig, sig_b64):
        raise LicenseError("Invalid license key (signature mismatch)")
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        raise LicenseError("Malformed key (payload JSON invalid)")
    return payload


def validate_key(
    key: str,
    current_node_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Full validation: structure, signature, expiry, node binding.

    Returns a result dict:
      {
        "valid":     True | False,
        "tier":      "pro" | "trial" | "free",
        "licensee":  str,
        "issued_at": str,
        "expires_at": str | None,
        "node_bound": bool,
        "error":     str | None,
      }
    """
    base: Dict[str, Any] = {
        "valid":      False,
        "tier":       "free",
        "licensee":   "",
        "issued_at":  "",
        "expires_at": None,
        "node_bound": False,
        "error":      None,
    }
    try:
        payload = _parse_key(key)
    except LicenseError as e:
        base["error"] = str(e)
        return base

    tier      = payload.get("tier", "free")
    licensee  = payload.get("licensee", "")
    issued_at = payload.get("issued_at", "")
    expires   = payload.get("expires_at")
    bound_nid = payload.get("node_id")

    # Expiry check
    if expires:
        try:
            exp_ts = datetime.strptime(expires, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > exp_ts:
                base["error"] = "License key has expired"
                base["tier"] = "free"
                return base
        except Exception:
            base["error"] = "Invalid expiry date in key"
            return base

    # Node binding check
    if bound_nid and current_node_id and bound_nid != current_node_id:
        base["error"] = "License key is bound to a different machine"
        return base

    base.update({
        "valid":      True,
        "tier":       tier if tier in _TIER_RANK else "free",
        "licensee":   licensee,
        "issued_at":  issued_at,
        "expires_at": expires,
        "node_bound": bool(bound_nid),
        "error":      None,
    })
    return base


# ============================================
#  Runtime cache (populated by main.py)
# ============================================

_cached_result: Optional[Dict[str, Any]] = None
_cache_unavailable = False


def mark_cache_unavailable() -> None:
    """An unreadable store or uncertain commit cannot retain licensed grants."""
    global _cache_unavailable
    _cache_unavailable = True


def _require_cache_available() -> None:
    if _cache_unavailable:
        from license_store import unavailable
        raise unavailable()


def publish_validation(result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Publish already validated committed state without a second slow check."""
    global _cached_result, _cache_unavailable
    _cached_result = None if BETA_MODE or result is None else dict(result)
    _cache_unavailable = False
    return get_status()


def get_active_tier() -> str:
    """Return the currently active tier ('free', 'trial', 'pro'). Always 'pro' in BETA_MODE."""
    if BETA_MODE:
        return "pro"
    _require_cache_available()
    if _cached_result and _cached_result.get("valid"):
        return _cached_result.get("tier", "free")
    return "free"


def get_status() -> Dict[str, Any]:
    """Return the full cached validation result, or a default free state."""
    _require_cache_available()
    if _cached_result:
        return dict(_cached_result)
    return {
        "valid":      False,
        "tier":       "free",
        "licensee":   "",
        "issued_at":  "",
        "expires_at": None,
        "node_bound": False,
        "error":      None,
    }


def refresh_cache(stored_key: Optional[str], node_id: Optional[str]) -> Dict[str, Any]:
    """Re-validate stored_key and update the in-memory cache. Called at startup."""
    if BETA_MODE:
        # Skip signature validation entirely — secret not required in beta
        return publish_validation(None)
    if not stored_key:
        return publish_validation(None)
    result = validate_key(stored_key, current_node_id=node_id)
    return publish_validation(result)


def bootstrap_cache(load_saved, node_id: Optional[str]) -> Dict[str, Any]:
    """Optional license damage does not prevent startup or silently grant access."""
    try:
        return refresh_cache(load_saved().get("key"), node_id)
    except Exception:
        mark_cache_unavailable()
        return {"available": False, "valid": False}
