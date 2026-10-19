"""Explicit local Bluetooth discovery and enrollment; no radio work on startup."""
from __future__ import annotations

from contextlib import contextmanager
import re
import unicodedata
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from browser_authority import browser_control_access
from license_gate import gate
import bluetooth_support
import bluetooth_profiles

# Compatibility constants for the first profile; selection uses the catalog.
VENDOR = "govee_ble"
PROFILE = "govee_h6125_v1"
CAPABILITIES = ["switch.on", "switch.off"]


class _BluetoothRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                raise HTTPException(422, "Bluetooth request is invalid.", headers={"Cache-Control": "no-store"}) from None
            except HTTPException as error:
                error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
                raise
            response.headers["Cache-Control"] = "no-store"
            return response
        return private


bluetooth_router = APIRouter(prefix="/bluetooth", tags=["bluetooth"], route_class=_BluetoothRoute)


def _address(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", value):
        raise ValueError("Invalid Bluetooth address")
    return value.upper()


class EnrollRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    address: str = Field(max_length=17)
    name: str = Field(min_length=1, max_length=64)
    room: str | None = Field(default=None, max_length=64)
    model: str = Field(min_length=1, max_length=128)
    profile: str | None = Field(default=None, min_length=1, max_length=128)
    confirm_model: Literal[True]

    @field_validator("confirm_model", mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit confirmation required")
        return value

    @field_validator("address")
    @classmethod
    def address_format(cls, value):
        return _address(value)

    @field_validator("name", "room")
    @classmethod
    def safe_text(cls, value, info):
        if value is None:
            return value
        if any(unicodedata.category(c).startswith("C") for c in value):
            raise ValueError("Invalid label")
        value = value.strip()
        if not value and info.field_name == "name":
            raise ValueError("Missing name")
        return value or None


def _selection(payload):
    if payload.profile is not None:
        profile = bluetooth_profiles.get_profile(payload.profile)
        if profile is None or profile["model"] != payload.model:
            raise HTTPException(422, "Bluetooth request is invalid.")
        return profile
    matches = bluetooth_profiles.model_profiles(payload.model)
    if len(matches) != 1:
        raise HTTPException(422, "Bluetooth request is invalid.")
    return matches[0]


def _record(payload, profile=None):
    profile = profile if profile is not None else _selection(payload)
    address = payload.address
    return {"device_id": profile["id_prefix"] + address.replace(":", "").lower(),
            "name": payload.name, "vendor": profile["vendor"], "ip": "ble://" + address, "relay": 0,
            "extra": {"transport": "bluetooth", "model": profile["model"], "address": address, "profile": profile["id"]},
            "capabilities": list(profile["capabilities"]), "room": payload.room, "tags": []}


def _binding(row):
    extra = row.get("extra") or {}
    return (row.get("vendor"), row.get("ip"), row.get("relay", 0),
            *(extra.get(key) for key in ("transport", "model", "address", "profile")),
            tuple(row.get("capabilities", [])))


def validate_generic_save(row, devices, changes):
    """Metadata edits cannot introduce or rebind a Bluetooth target."""
    previous = next((d for d in devices if d.get("device_id") == row.get("device_id")), None)
    if not bluetooth_profiles.is_bluetooth_record(row) and not bluetooth_profiles.is_bluetooth_record(previous):
        return
    candidate = {**previous, **changes} if previous is not None else row
    if previous is not None and "extra" in changes:
        candidate["extra"] = {**previous.get("extra", {}), **changes["extra"]}
    if (previous is None or bluetooth_profiles.record_profile(candidate) is None
            or bluetooth_profiles.record_profile(previous) is None or _binding(candidate) != _binding(previous)):
        raise HTTPException(409, "Use explicit Bluetooth enrollment to add a target. An enrolled Bluetooth binding cannot be changed here.")


def _ensure_new(devices, device):
    for row in devices:
        extra = row.get("extra") or {}
        if (row.get("device_id") == device["device_id"] or
                str(row.get("ip") or "").lower() == device["ip"].lower() or
                bluetooth_profiles.is_bluetooth_record(row) and
                str(extra.get("address") or "").upper() == device["extra"]["address"]):
            raise HTTPException(409, "This Bluetooth target is already saved. Review the existing device; no connection was retried.")


@contextmanager
def _operation(check):
    from routers.home_power import _capture
    access = _capture(check)
    access()
    try:
        yield access
    except HTTPException:
        access()
        raise
    except Exception:
        access()
        raise HTTPException(503, "Bluetooth operation is unavailable. No automatic retry was made.") from None
    access()


@bluetooth_router.get("/status")
def support_status(check=Depends(browser_control_access)):
    with _operation(check) as access:
        status = bluetooth_support.support_status(check=access)
        access()
        return JSONResponse({**status, "profiles": bluetooth_profiles.list_profiles()})


@bluetooth_router.post("/discover")
def discover(check=Depends(browser_control_access)):
    with _operation(check) as access:
        return JSONResponse({"devices": bluetooth_support.discover(check=access)})


@bluetooth_router.post("/enroll")
def enroll(payload: EnrollRequest, check=Depends(browser_control_access), _license=Depends(gate("home_automation"))):
    from routers import home_power as hp
    with _operation(check) as access:
        profile = _selection(payload)
        access()
        runtime = hp._checked(access, hp.get_runtime)
        device = _record(payload, profile)
        # Strict preflight avoids connecting when saved state is already damaged
        # or the selected target is already enrolled. Recheck under the same
        # runtime lock after the explicit read-only GATT validation.
        with runtime._lock:
            access()
            _ensure_new(hp._checked(access, runtime.load_devices), device)
        driver = runtime._driver_registry.get(profile["vendor"])
        hp._require_bluetooth_driver(driver)
        probe = hp._checked(access, lambda: driver.probe_checked(device, check=access))
        if isinstance(probe, dict) and probe.get("ok") is not True and probe.get("error") not in (None, "profile_mismatch", "invalid_device"):
            raise HTTPException(503, "The Bluetooth connection could not be checked. Nothing was saved; no automatic retry was made.")
        if not isinstance(probe, dict) or probe.get("ok") is not True or probe.get("profile") != profile["id"] or probe.get("model") != profile["model"]:
            raise HTTPException(422, "The selected device did not expose the supported Bluetooth profile. Nothing was saved.")
        with runtime._lock:
            access()
            devices = hp._checked(access, runtime.load_devices)
            _ensure_new(devices, device)
            runtime.save_devices([*devices, device], check=access)
        runtime.receipt("device_saved", device["name"], device_id=device["device_id"], check=access)
        access()
        return JSONResponse({"ok": True, "device": device})
