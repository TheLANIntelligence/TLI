"""Public license bootstrap and private, preserved browser settings."""
from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from browser_authority import browser_control_access
import license as L
import license_store as store
import tli_state as S

class _LicenseRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private_response(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                # Validation's default input echo can disclose the signed key.
                return JSONResponse({"detail": "Provide a valid bounded license key."}, status_code=422,
                                    headers={"Cache-Control": "no-store"})
            response.headers["Cache-Control"] = "no-store"
            return response
        return private_response


router = APIRouter(tags=["license"], route_class=_LicenseRoute)


class ActivateRequest(BaseModel):
    key: str = Field(max_length=store.MAX_KEY_BYTES)


def _browser_access(request: Request, response: Response):
    def private_error(error):
        error.license_authority_failure = True
        error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
        return error
    try:
        captured = browser_control_access(request, response)
    except HTTPException as error:
        raise private_error(error)
    def check():
        try:
            captured()
        except HTTPException as error:
            raise private_error(error)
    return check


@contextmanager
def _operation(check):
    check()
    try:
        yield
    finally:
        check()


def _checked(check, operation):
    check()
    try:
        value = operation()
    except Exception:
        check()
        raise
    check()
    return value


def _license_state(check, operation):
    check()
    try:
        value = operation()
    except Exception:
        # Preserve actual state-failure provenance before an error-path access
        # check can replace the public error with an expired-session denial.
        L.mark_cache_unavailable()
        check()
        raise store.unavailable() from None
    check()
    return value


def _saved(check):
    return _license_state(check, S.load_license)


def _feature_map(tier):
    return {feature: L.has_feature(tier, feature) for feature in (
        "mesh", "vault", "home_automation", "advanced_ai", "peer_nodes", "multi_shelly", "debug_panel")}


def _public_status():
    status = L.get_status()
    tier = L.get_active_tier()
    return {"tier": tier, "valid": bool(L.BETA_MODE or status.get("valid", False)),
            "beta": L.BETA_MODE, "features": _feature_map(tier)}


@router.get("/license/status")
def license_status(response: Response):
    """Minimal bootstrap only: no saved key, licensee or node identity lookup."""
    response.headers["Cache-Control"] = "no-store"
    with store.LOCK:
        return _public_status()


@router.get("/license/details")
def license_details(check=Depends(_browser_access)):
    with _operation(check), store.LOCK:
        check()
        stored = _saved(check)
        node_id = _license_state(check, S.load_node_config).node_id
        result = None if L.BETA_MODE or not stored.get("key") else _license_state(
            check, lambda: L.validate_key(stored["key"], current_node_id=node_id))
        check()
        status = L.publish_validation(result)
        return {**_public_status(), "licensee": "Beta" if L.BETA_MODE else status.get("licensee", ""),
                "issued_at": status.get("issued_at", ""), "expires_at": status.get("expires_at"),
                "node_bound": status.get("node_bound", False), "node_id": node_id}


@router.post("/license/activate")
def license_activate(body: ActivateRequest, check=Depends(_browser_access)):
    with _operation(check), store.LOCK:
        check()
        key = body.key.strip()
        if not key:
            raise HTTPException(400, "License key is required", headers={"Cache-Control": "no-store"})
        stored = _saved(check)
        node_id = _checked(check, S.load_node_config).node_id
        result = _checked(check, lambda: L.validate_key(key, current_node_id=node_id))
        if not result["valid"]:
            raise HTTPException(400, result.get("error") or "Invalid license key", headers={"Cache-Control": "no-store"})
        S.save_license({**stored, "key": key}, check=check, expected=stored,
                       on_commit=lambda: L.publish_validation(result), on_uncertain=L.mark_cache_unavailable)
        check()
        _checked(check, lambda: S.log_debug("license", "INFO", "License activated", tier=result["tier"]))
        return {"tier": result["tier"], "valid": True, "licensee": result["licensee"],
                "issued_at": result["issued_at"], "expires_at": result.get("expires_at"),
                "node_bound": result.get("node_bound", False), "node_id": node_id,
                "features": _feature_map(result["tier"])}


@router.delete("/license/deactivate")
def license_deactivate(check=Depends(_browser_access)):
    with _operation(check), store.LOCK:
        check()
        stored = _saved(check)
        updated = {key: value for key, value in stored.items() if key != "key"}
        S.save_license(updated, check=check, expected=stored,
                       on_commit=lambda: L.publish_validation(None), on_uncertain=L.mark_cache_unavailable)
        check()
        _checked(check, lambda: S.log_debug("license", "INFO", "License deactivated"))
        # This acknowledges stored-key removal; BETA entitlements are unchanged.
        return {"tier": "free", "valid": False, "message": "License removed"}
