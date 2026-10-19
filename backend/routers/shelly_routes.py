# backend/routers/shelly_routes.py
from __future__ import annotations

import json
import ipaddress
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any, Dict, List, Optional
from collections.abc import Callable

import requests
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

import tli_state as S
from license_gate import gate as _gate
from routers.system_routes import require_session
from device_commands import run as run_command, target_key
from browser_authority import browser_control_access
import shelly_store

router = APIRouter(tags=["shelly"])

_shelly_info_cache: Dict[str, Dict[str, Any]] = {}
_registry_lock = shelly_store.LOCK


def _browser_access(request: Request, response: Response) -> Callable[[], None]:
    """Keep denial responses private as well as successful device observations."""
    def private_error(error):
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


def _trusted_call():
    """In-process services retain their caller's existing authorization boundary."""


def _checked(check, operation):
    check()
    try:
        result = operation()
    except Exception:
        check()
        raise
    check()
    return result


def _get_lan_ip() -> str:
    """Best-effort LAN-facing IPv4 address for subnet discovery."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def _probe_shelly_ip(ip: str) -> Optional[Dict[str, Any]]:
    """Return Shelly device info when a Gen2 RPC endpoint responds."""
    endpoint = f"http://{ip}/rpc/Shelly.GetDeviceInfo"
    t0 = time.time()
    try:
        r = requests.get(endpoint, timeout=(0.35, 0.9))
        if not r.ok:
            return None
        data = r.json() if r.content else {}
        if not isinstance(data, dict):
            return None
        model = data.get("model")
        app = data.get("app")
        if not model and not app and "gen" not in data:
            return None
        return {
            "ip": ip,
            "name": data.get("name") or data.get("id") or model or f"Shelly {ip}",
            "model": model,
            "app": app,
            "gen": str(data.get("gen") or "2"),
            "fw_id": data.get("fw_id"),
            "ver": data.get("ver"),
            "latency_ms": int((time.time() - t0) * 1000),
        }
    except Exception:
        return None


def shelly_device_info_cached(ip: str, ttl_seconds: int = 20) -> Dict[str, Any]:
    ip = (ip or "").strip()
    now = time.time()
    cached = _shelly_info_cache.get(ip)
    if cached and (now - cached.get("ts", 0) < ttl_seconds):
        return cached.get("report", {})

    report: Dict[str, Any] = {
        "ok": False, "ip": ip, "endpoint": f"http://{ip}/rpc/Shelly.GetDeviceInfo",
        "latency_ms": None, "gen": "unknown", "model": None, "app": None,
        "fw_id": None, "ver": None, "error": None, "checked_at": S.now_iso(),
    }
    t0 = time.time()
    try:
        url = f"http://{ip}/rpc/Shelly.GetDeviceInfo"
        r = requests.get(url, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT))
        report["latency_ms"] = int((time.time() - t0) * 1000)
        if not r.ok:
            report["error"] = f"HTTP {r.status_code}"
        else:
            data = r.json() if r.content else {}
            report["gen"] = str(data.get("gen") or "2")
            report["model"] = data.get("model")
            report["app"] = data.get("app")
            report["fw_id"] = data.get("fw_id")
            report["ver"] = data.get("ver")
            report["ok"] = True
    except Exception as e:
        report["error"] = str(e)

    _shelly_info_cache[ip] = {"ts": now, "report": report}
    return report


def _extract_shelly_summary_gen2(raw: Dict[str, Any], relay_index: int = 0) -> Dict[str, Any]:
    is_on = None; power_w = None; voltage_v = None; current_a = None; temperature_c = None

    if not isinstance(raw, dict):
        return {"is_on": None, "power_w": None, "voltage_v": None, "current_a": None, "temperature_c": None}

    key = f"switch:{relay_index}"
    switch_obj = raw.get(key) or raw.get("switch:0")

    if isinstance(switch_obj, dict):
        if "output" in switch_obj:
            out_val = switch_obj.get("output")
            if isinstance(out_val, bool):
                is_on = out_val
            elif isinstance(out_val, str):
                is_on = out_val.lower() == "on"
        if "apower" in switch_obj:
            try: power_w = float(switch_obj.get("apower") or 0.0)
            except Exception: pass
        if "voltage" in switch_obj:
            try: voltage_v = float(switch_obj.get("voltage") or 0.0)
            except Exception: pass
        if "current" in switch_obj:
            try: current_a = float(switch_obj.get("current") or 0.0)
            except Exception: pass

    temp_obj = raw.get(f"temperature:{relay_index}") or raw.get("temperature:0")
    if isinstance(temp_obj, dict):
        try:
            tc = temp_obj.get("tC")
            if tc is not None:
                temperature_c = float(tc)
        except Exception:
            pass

    return {"is_on": is_on, "power_w": power_w, "voltage_v": voltage_v,
            "current_a": current_a, "temperature_c": temperature_c}


# ============================================
#  Models
# ============================================

class ShellyRelayRequest(BaseModel):
    ip: str
    action: str = Field(pattern="^(on|off|toggle)$")
    relay: Optional[int] = Field(default=None, ge=0, le=255)
    request_id: Optional[str] = Field(default=None, pattern=r"^[a-f0-9-]{32,36}$")


def _target_relay(ip, relay):
    if relay is not None:
        return relay
    from routers.home_power import get_runtime
    try:
        runtime = get_runtime()
    except RuntimeError:
        runtime = None
    home = runtime.load_devices() if runtime and hasattr(runtime, "load_devices") else []
    registered = [*S.load_shelly_registry(), *[d for d in home if d.get("vendor", "shelly") == "shelly"]]
    matches = {int(d.get("relay") or 0) for d in registered
               if target_key(d.get("ip", ""), 0)[0] == target_key(ip, 0)[0]}
    if len(matches) > 1:
        raise HTTPException(409, "This address has multiple registered relays. Choose the relay explicitly.")
    return next(iter(matches), 0)


# ============================================
#  Endpoints
# ============================================

@router.get("/homeauto/devices")
def homeauto_devices(check=Depends(_browser_access)):
    return {"devices": _checked(check, S.load_shelly_registry)}


@router.post("/homeauto/devices")
def homeauto_set_devices(payload: Dict[str, Any], check=Depends(_browser_access), _l=Depends(_gate("home_automation"))):
    check()
    raw_devices = payload.get("devices")
    if not isinstance(raw_devices, list) or len(raw_devices) > 512:
        raise HTTPException(422, "Provide a device list of at most 512 entries.")
    with _registry_lock:
        previous = _checked(check, S.load_shelly_registry)
        devices = list(previous) if payload.get("merge") is True else []
        seen = set()
        for item in raw_devices:
            check()
            if not isinstance(item, dict) or not str(item.get("ip") or "").strip():
                raise HTTPException(422, "Each device needs an address.")
            ip = item["ip"]
            try:
                address = shelly_store.address_key(ip)
            except (TypeError, ValueError):
                raise HTTPException(422, "Each device needs a valid host or IP address.") from None
            relay = item.get("relay")
            if relay is not None and (type(relay) is not int or not 0 <= relay <= 255):
                raise HTTPException(422, "Relay must be an integer from 0 to 255.")
            if relay is None:
                known = {d.get("relay") or 0 for d in previous
                         if shelly_store.address_key(d.get("ip") or d.get("host")) == address}
                if len(known) > 1:
                    raise HTTPException(409, "This address has multiple registered relays. Choose the relay explicitly.")
                relay = next(iter(known)) if known else _checked(check, lambda: _target_relay(ip, relay))
            else:
                relay = _checked(check, lambda: _target_relay(ip, relay))
            check()
            key = (address, relay)
            if key in seen:
                raise HTTPException(409, "The same address and relay appear more than once.")
            seen.add(key)
            old = next((d for d in previous if (shelly_store.address_key(d.get("ip") or d.get("host")), d.get("relay") or 0) == key), {})
            if any(field in old and field in item and old[field] != item[field] for field in ("id", "device_id")):
                raise HTTPException(409, "An existing device identity cannot change during a registry edit.")
            # Keep IDs, aliases and vendor metadata from existing persisted rows.
            device = {**old, **item, "ip": ip, "relay": relay}
            devices = [d for d in devices if (shelly_store.address_key(d.get("ip") or d.get("host")), d.get("relay") or 0) != key]
            devices.append(device)
        _checked(check, lambda: S.save_shelly_registry(devices, check=check, expected=previous))
    check()
    return {"ok": True, "count": len(devices), "devices": devices}


@router.get("/shelly/discover")
def shelly_discover(
    subnet: Optional[str] = Query(default=None, description="Optional IPv4 CIDR, e.g. 192.168.1.0/24"),
    check=Depends(_browser_access),
    _l=Depends(_gate("home_automation")),
):
    """
    Actively scan the local /24 subnet for Shelly Gen2 RPC devices.

    Shelly devices do not all advertise consistently across Windows/macOS/Linux,
    so this uses direct HTTP probing against /rpc/Shelly.GetDeviceInfo.
    """
    t0 = time.time()
    lan_ip = _checked(check, _get_lan_ip)
    if subnet:
        try:
            network = ipaddress.IPv4Network(subnet, strict=False)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid subnet. Use CIDR like 192.168.1.0/24.")
    else:
        try:
            network = ipaddress.IPv4Network(f"{lan_ip}/24", strict=False)
        except Exception:
            raise HTTPException(status_code=500, detail="Could not determine local subnet.")

    if network.prefixlen < 24:
        raise HTTPException(status_code=400, detail="Discovery is limited to /24 or smaller subnets.")

    hosts = [str(h) for h in network.hosts()]
    found: List[Dict[str, Any]] = []
    seen_ips = set()

    check()
    with ThreadPoolExecutor(max_workers=64) as executor:
        futures = {}
        try:
            for ip in hosts:
                check()
                futures[executor.submit(_checked, check, lambda ip=ip: _probe_shelly_ip(ip))] = ip
            for future in as_completed(futures):
                check()
                result = future.result()
                if not result:
                    continue
                ip = result.get("ip")
                if ip in seen_ips:
                    continue
                seen_ips.add(ip)
                found.append(result)
        finally:
            for future in futures:
                future.cancel()

    found.sort(key=lambda d: tuple(int(p) for p in str(d.get("ip", "0.0.0.0")).split(".") if p.isdigit()))
    check()
    S.log_debug("shelly", "INFO", "Shelly discovery complete",
                subnet=str(network), scanned=len(hosts), found=len(found))
    check()
    return {
        "ok": True,
        "subnet": str(network),
        "lan_ip": lan_ip,
        "scanned": len(hosts),
        "found": found,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }


def shelly_status(ip: str, relay: Optional[int] = None, _l=None, _s=None, *, check=_trusted_call):
    relay = _checked(check, lambda: _target_relay(ip, relay))
    try:
        out = _checked(check, lambda: S.shelly_driver.get_status(ip=ip, relay=relay))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Could not read this relay. Check device connectivity and access; its state is unknown.") from exc
    raw = out.get("raw") if isinstance(out, dict) else None
    switch = raw.get(f"switch:{relay}") if isinstance(raw, dict) else None
    valid = isinstance(switch, dict) and isinstance(switch.get("output"), bool) and out.get("ok") is not False and not any(k in raw for k in ("error", "code", "text"))
    device = _checked(check, lambda: shelly_device_info_cached(ip)) if valid else None
    check()
    return {"ok": valid, "raw": raw, "summary": out.get("summary", "") if valid else "The requested relay state is unavailable.",
            "device": device, "ip": ip, "relay": relay, "on": switch["output"] if valid else None, "checked_at": time.time()}


def shelly_relay(body: ShellyRelayRequest, _l=None, user="local", *, check=_trusted_call):
    relay = _checked(check, lambda: _target_relay(body.ip, body.relay))
    def execute():
        check()
        if body.action == "on":
            return S.shelly_driver.turn_on(ip=body.ip, relay=relay)
        elif body.action == "off":
            return S.shelly_driver.turn_off(ip=body.ip, relay=relay)
        return S.shelly_driver.toggle(ip=body.ip, relay=relay)
    result = _checked(check, lambda: run_command(user, ("shelly", *target_key(body.ip, relay)), body.action, body.request_id, execute))
    return {"raw": None, **result, "ip": body.ip, "relay": relay}


@router.get("/shelly/status")
def shelly_status_http(ip: str = Query(...), relay: Optional[int] = Query(default=None, ge=0, le=255),
                      check=Depends(_browser_access), _l=Depends(_gate("home_automation"))):
    return shelly_status(ip, relay, check=check)


@router.post("/shelly/relay")
def shelly_relay_http(body: ShellyRelayRequest, check=Depends(_browser_access),
                     _l=Depends(_gate("home_automation")), user=Depends(require_session)):
    return shelly_relay(body, user=user, check=check)
