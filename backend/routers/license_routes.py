# backend/routers/license_routes.py
# License management endpoints.
#
#   GET  /license/status      — return current tier + validity
#   POST /license/activate    — validate + store a key
#   DELETE /license/deactivate — clear stored key, revert to free

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import tli_state as S
import license as L

router = APIRouter(tags=["license"])


class ActivateRequest(BaseModel):
    key: str


# ============================================
#  GET /license/status
# ============================================

@router.get("/license/status")
def license_status():
    """
    Return the currently active license info.
    Always succeeds — tier is 'free' when no valid key is stored.
    """
    status = L.get_status()
    node_id = S.load_node_config().node_id
    tier = L.get_active_tier()  # respects BETA_MODE
    return {
        "tier":       tier,
        "valid":      L.BETA_MODE or status.get("valid", False),
        "beta":       L.BETA_MODE,
        "licensee":   "Beta" if L.BETA_MODE else status.get("licensee", ""),
        "issued_at":  status.get("issued_at", ""),
        "expires_at": status.get("expires_at"),
        "node_bound": status.get("node_bound", False),
        "node_id":    node_id,
        "features":   _feature_map(tier),
    }


# ============================================
#  POST /license/activate
# ============================================

@router.post("/license/activate")
def license_activate(body: ActivateRequest):
    """
    Validate and store a license key.
    Returns the new license status on success, 400 on invalid key.
    """
    key = (body.key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="License key is required")

    node_id = S.load_node_config().node_id
    result = L.validate_key(key, current_node_id=node_id)

    if not result["valid"]:
        raise HTTPException(status_code=400, detail=result.get("error") or "Invalid license key")

    # Persist
    stored = S.load_license()
    stored["key"] = key
    S.save_license(stored)

    # Update cache
    L.refresh_cache(key, node_id)

    S.log_debug("license", "INFO", "License activated",
                tier=result["tier"], licensee=result["licensee"])

    return {
        "tier":       result["tier"],
        "valid":      True,
        "licensee":   result["licensee"],
        "issued_at":  result["issued_at"],
        "expires_at": result.get("expires_at"),
        "node_bound": result.get("node_bound", False),
        "node_id":    node_id,
        "features":   _feature_map(result["tier"]),
    }


# ============================================
#  DELETE /license/deactivate
# ============================================

@router.delete("/license/deactivate")
def license_deactivate():
    """Remove the stored license key. Reverts to free tier."""
    stored = S.load_license()
    stored.pop("key", None)
    S.save_license(stored)
    L.refresh_cache(None, None)

    S.log_debug("license", "INFO", "License deactivated")
    return {"tier": "free", "valid": False, "message": "License removed"}


# ============================================
#  Helper
# ============================================

def _feature_map(tier: str) -> dict:
    features = [
        "mesh", "vault", "home_automation", "advanced_ai",
        "peer_nodes", "multi_shelly", "debug_panel",
    ]
    return {f: L.has_feature(tier, f) for f in features}
