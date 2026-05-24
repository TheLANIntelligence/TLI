# backend/routers/shelly_routes.py
from __future__ import annotations

import json
import ipaddress
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

import tli_state as S
from license_gate import gate as _gate

router = APIRouter(tags=["shelly"])

_shelly_info_cache: Dict[str, Dict[str, Any]] = {}


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
    relay: int = 0


# ============================================
#  Endpoints
# ============================================

@router.get("/homeauto/devices")
def homeauto_devices():
    return {"devices": S.load_shelly_registry()}


@router.post("/homeauto/devices")
def homeauto_set_devices(payload: Dict[str, Any], _l=Depends(_gate("home_automation"))):
    raw_devices = payload.get("devices") or []
    devices = []
    for item in raw_devices:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        ip = str(item.get("ip", "")).strip()
        if ip:
            devices.append({"name": name, "ip": ip})
    S.save_shelly_registry(devices)
    return {"ok": True, "count": len(devices)}


@router.get("/shelly/discover")
def shelly_discover(
    subnet: Optional[str] = Query(default=None, description="Optional IPv4 CIDR, e.g. 192.168.1.0/24"),
    _l=Depends(_gate("home_automation")),
):
    """
    Actively scan the local /24 subnet for Shelly Gen2 RPC devices.

    Shelly devices do not all advertise consistently across Windows/macOS/Linux,
    so this uses direct HTTP probing against /rpc/Shelly.GetDeviceInfo.
    """
    t0 = time.time()
    lan_ip = _get_lan_ip()
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

    with ThreadPoolExecutor(max_workers=64) as executor:
        futures = {executor.submit(_probe_shelly_ip, ip): ip for ip in hosts}
        for future in as_completed(futures):
            result = future.result()
            if not result:
                continue
            ip = result.get("ip")
            if ip in seen_ips:
                continue
            seen_ips.add(ip)
            found.append(result)

    found.sort(key=lambda d: tuple(int(p) for p in str(d.get("ip", "0.0.0.0")).split(".") if p.isdigit()))
    S.log_debug("shelly", "INFO", "Shelly discovery complete",
                subnet=str(network), scanned=len(hosts), found=len(found))
    return {
        "ok": True,
        "subnet": str(network),
        "lan_ip": lan_ip,
        "scanned": len(hosts),
        "found": found,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }


@router.get("/shelly/status")
def shelly_status(ip: str = Query(...), relay: int = 0, _l=Depends(_gate("home_automation"))):
    try:
        out = S.shelly_driver.get_status(ip=ip, relay=relay)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Shelly status request failed: {exc!r}")
    device = shelly_device_info_cached(out.get("ip") or ip)
    return {"ok": True, "raw": out["raw"], "summary": out["summary"], "device": device}


@router.post("/shelly/relay")
def shelly_relay(body: ShellyRelayRequest, _l=Depends(_gate("home_automation"))):
    try:
        if body.action == "on":
            out = S.shelly_driver.turn_on(ip=body.ip, relay=body.relay)
        elif body.action == "off":
            out = S.shelly_driver.turn_off(ip=body.ip, relay=body.relay)
        else:
            out = S.shelly_driver.toggle(ip=body.ip, relay=body.relay)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Shelly relay request failed: {exc!r}")
    return {"raw": out["raw"], "summary": out["summary"]}
