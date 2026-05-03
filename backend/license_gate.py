# backend/license_gate.py
# FastAPI dependency factories for license feature gating.
#
# Usage in a router:
#
#   from license_gate import gate
#
#   @router.post("/vault/unlock")
#   def vault_unlock(..., _=Depends(gate("vault"))):
#       ...
#
# Returns HTTP 402 with a structured body when the active tier does not
# include the requested feature.  The frontend intercepts 402 globally
# and shows the upgrade modal.

from __future__ import annotations

from fastapi import Depends, HTTPException

import license as L


def gate(feature: str):
    """
    Return a FastAPI dependency that raises 402 if the active license tier
    does not include *feature*.

    The 402 body is:
        {
            "detail":      "This feature requires a Pro license.",
            "feature":     "vault",
            "active_tier": "free",
            "upgrade":     "/settings#license"
        }
    """
    def _check():
        tier = L.get_active_tier()
        if not L.has_feature(tier, feature):
            raise HTTPException(
                status_code=402,
                detail={
                    "message":     _feature_label(feature),
                    "feature":     feature,
                    "active_tier": tier,
                    "upgrade":     "/settings#license",
                },
            )

    # Give the dependency a unique name per feature so FastAPI doesn't
    # deduplicate them into a single shared callable.
    _check.__name__ = f"_license_gate_{feature}"
    return _check


def _feature_label(feature: str) -> str:
    labels = {
        "vault":            "Encrypted Vault requires a Pro license.",
        "home_automation":  "Home Automation requires a Pro license.",
        "peer_nodes":       "Mesh peer networking requires a Pro license.",
        "mesh":             "Mesh networking requires a Pro license.",
        "multi_shelly":     "Multiple Shelly devices require a Pro license.",
        "advanced_ai":      "Advanced AI settings require a Pro license.",
        "debug_panel":      "Debug panel requires a Pro license.",
    }
    return labels.get(feature, f"Feature '{feature}' requires a Pro license.")
