# backend/routers/system_routes.py
from __future__ import annotations

import hashlib
import os as _os
import secrets
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import requests
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

import tli_state as S
from browser_authority import browser_control_access, browser_request_local
import pin_security
from vault_security import get_status as vault_get_status, is_initialized as vault_is_initialized

try:
    import psutil
except Exception:
    psutil = None

_MODEL_OBSERVATION_PATHS = frozenset({
    "/health/llm", "/health/llm/report", "/health/lmstudio/report", "/models/available",
    "/setup/autodetect", "/system/lm_studio/test", "/system/lm_studio/url",
    "/system/profile", "/models/set-default", "/status",
    "/system/probe", "/system/summary", "/api/system/disk",
    "/agent/health", "/agent/info",
    "/system/node/name", "/device/nickname",
    "/system/onboarding/status", "/system/onboarding/start", "/system/onboarding/complete",
    "/status/alerts", "/status/alerts/{alert_id}/dismiss", "/status/alerts/dismiss-all",
})


class _SystemObservationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        if self.path not in _MODEL_OBSERVATION_PATHS:
            return handler
        async def private_response(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                # A malformed URL/body must not echo private endpoint input.
                if self.path in {"/system/node/name", "/device/nickname"}:
                    detail = "Provide a valid bounded computer name."
                elif self.path in {"/system/profile", "/models/set-default"}:
                    detail = "Provide valid bounded model or profile settings."
                else:
                    detail = "Provide valid bounded model endpoint fields."
                return JSONResponse({"detail": detail},
                                    status_code=422, headers={"Cache-Control": "no-store"})
            except HTTPException as error:
                error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
                raise
            response.headers["Cache-Control"] = "no-store"
            return response
        return private_response


router = APIRouter(tags=["system"], route_class=_SystemObservationRoute)


def _observation_access(request: Request, response: Response):
    """Private browser observations retain authority through error disclosure."""
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


@contextmanager
def _private_observation(check):
    try:
        check()
        try:
            yield
        finally:
            check()
    except HTTPException as error:
        error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
        raise
    except Exception:
        raise HTTPException(503, "Private system information is unavailable.",
                            headers={"Cache-Control": "no-store"}) from None


# ── Shared session dependency (defined early so all endpoints can use it) ─────
def require_session(tli_session: Optional[str] = Cookie(default=None), request: Request = None) -> str:
    """Resolve browser sessions and paired-device Bearer credentials to one owner.

    Keep the cookie positional argument for legacy direct callers. A supplied
    Authorization header is always validated, including while PIN is disabled.
    """
    from companion_auth import resolve_user
    return resolve_user(request, tli_session)


@router.get("/system/uninstall")
def uninstall_information(request: Request, response: Response, owner: str = Depends(require_session)):
    """Describe this host's removal entry point without starting any operation."""
    from companion_auth import operation_access
    from uninstall_info import describe
    check = operation_access(request, owner)
    result = describe(S.BASE_DIR)
    check()
    response.headers["Cache-Control"] = "no-store"
    return result


# ============================================
#  Build ID
# ============================================

def _tli_backend_build_id() -> str:
    try:
        p = Path(__file__)
        raw = p.read_bytes()
        return hashlib.sha256(raw).hexdigest()[:12]
    except Exception:
        return "unknown"

BACKEND_BUILD_ID = _tli_backend_build_id()
BUILD_ID = BACKEND_BUILD_ID
BACKEND_BUILD_UTC = datetime.utcnow().isoformat() + "Z"


# ============================================
#  Health
# ============================================

@router.get("/health/llm")
def llm_health_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return llm_health(check=check)


def _model_call(provider, method, check=None):
    if check is None:
        return getattr(provider, method)()
    check()
    try:
        return getattr(provider, method)(check=check)
    finally:
        check()


def llm_health(*, check=None):
    return {"ok": bool(_model_call(S.lm_provider, "health_check", check))}

@router.get("/health/llm/report")
def llm_health_report_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return llm_health_report(check=check)


def llm_health_report(*, check=None):
    return _model_call(S.lm_provider, "health_report", check)

_report_cache: dict = {"result": None, "ts": 0.0, "provider": None}
_REPORT_TTL = 10.0

@router.get("/health/lmstudio/report")
def lmstudio_health_report_legacy_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return lmstudio_health_report_legacy(check=check)


def lmstudio_health_report_legacy(*, check=None):
    global _report_cache
    if check is not None:
        check()
    provider = S.lm_provider
    cached = _report_cache
    now = time.time()
    if (cached.get("provider") is provider and cached["result"] is not None
            and (check is None or cached.get("checked") is True) and now - cached["ts"] < _REPORT_TTL):
        if check is not None:
            check()
        return cached["result"]
    try:
        result = _model_call(provider, "health_report", check)
    except Exception:
        if check is not None:
            raise
        result = {"ok": False, "error": "probe failed"}
    if check is not None:
        check()
    previous = _report_cache
    published = {"result": result, "ts": now, "provider": provider, "checked": check is not None}
    _report_cache = published
    if check is not None:
        try:
            check()
        except Exception:
            if _report_cache is published:
                _report_cache = previous
            raise
    return result

_health_cache: dict = {"result": False, "ts": 0.0, "provider": None}
_HEALTH_TTL = 10.0  # seconds between real LM Studio probes

def lm_studio_health_check_cached(*, check=None) -> bool:
    """Reuse recent LM health; cache misses perform synchronous provider probes."""
    global _health_cache
    if check is not None:
        check()
    provider = S.lm_provider
    cached = _health_cache
    now = time.time()
    if (cached.get("provider") is provider and (check is None or cached.get("checked") is True)
            and now - cached["ts"] < _HEALTH_TTL):
        if check is not None:
            check()
        return cached["result"]
    try:
        result = bool(_model_call(provider, "health_check", check))
    except Exception:
        if check is not None:
            raise
        result = False
    if check is not None:
        check()
    previous = _health_cache
    published = {"result": result, "ts": now, "provider": provider, "checked": check is not None}
    _health_cache = published
    if check is not None:
        try:
            check()
        except Exception:
            if _health_cache is published:
                _health_cache = previous
            raise
    return result


# ============================================
#  Status endpoint
# ============================================

@router.get("/status")
def status_endpoint(request: Request, check=Depends(_observation_access)):
    """Read host status without initializing identity or rewriting registries."""
    with _private_observation(check):
        user_id = require_session(request=request)
        check()
        cfg = S.read_node_config(check=check)
        check()
        model_online = lm_studio_health_check_cached(check=check)
        check()
        raw_status = vault_get_status(user_id, check=check)
        check()
        vault_status = {
            "initialized": raw_status.get("is_initialized", False),
            "locked_until": raw_status.get("locked_until"),
            "failed_attempts": raw_status.get("failed_attempts", 0),
            "unlocked": raw_status.get("is_unlocked_for_user", False),
        }
        return {
            "model_online": model_online,
            "device_id": cfg.node_id if cfg else None,
            "device_nickname": cfg.node_name if cfg else "TLI Node",
            "vault_status": vault_status,
            "node_role": cfg.role if cfg else "standalone",
            "mesh_status": cfg.mesh_status if cfg else "unpaired",
        }


# ============================================
#  System capabilities
# ============================================

@router.get("/system/capabilities")
def system_capabilities(check=Depends(_observation_access)):
    import shelly_store
    with _private_observation(check):
        raw = shelly_store.read(S.SHELLY_REGISTRY_PATH, check=check)
        devices = []
        for d in raw:
            check()
            ip = str(d.get("ip") or d.get("host") or "").strip()
            devices.append({
                "name": str(d.get("name") or d.get("label") or "").strip(), "ip": ip,
                "relay": int(d.get("relay") or 0), "vendor": "shelly",
                "capabilities": ["switch.on", "switch.off"],
            })
        return {"devices": devices}


# ============================================
#  Models API
# ============================================

class SetDefaultModelRequest(BaseModel):
    model_id: str = Field(max_length=1024)
    label: Optional[str] = Field(default=None, max_length=1024)

@router.get("/models/available")
def models_available_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return models_available(check=check)


def models_available(*, check=None):
    if check is not None:
        # Do not probe a provider while its saved selection is unavailable.
        S.read_model_settings(check=check)
    provider = S.lm_provider
    try:
        models = _model_call(provider, "list_models", check)
    except HTTPException:
        raise
    except Exception:
        if check is not None:
            check()
        raise HTTPException(status_code=502, detail="Could not read the local model server's models.") from None
    compat = _model_call(provider, "health_report", check)
    current = (S.read_model_settings(check=check) if check is not None else
               {"default_key": S.DEFAULT_MODEL_KEY, "models": S.MODEL_CONFIG})
    return {
        "server_url": provider.models_url,
        "compat": compat,
        "models": models,
        "current": current,
    }

@router.post("/models/set-default")
def set_default_model(req: SetDefaultModelRequest, check=Depends(_observation_access)):
    with _private_observation(check):
        return S.save_default_model(req.model_id, req.label, check=check)


# ============================================
#  System profile API
# ============================================

class SetSystemProfileRequest(BaseModel):
    profile: str = Field(max_length=32)

@router.get("/system/profile")
def get_system_profile_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return get_system_profile(check=check)


def get_system_profile(*, check=None):
    return S.read_profile_settings(check=check)

@router.post("/system/profile")
def set_system_profile(req: SetSystemProfileRequest, check=Depends(_observation_access)):
    with _private_observation(check):
        return S.save_profile(req.profile, check=check)


# ============================================
#  Hardware probe
# ============================================

class HardwareProbeResponse(BaseModel):
    cpu_cores: int
    cpu_threads: int
    ram_total_gb: float
    ram_available_gb: float
    gpu_vram_gb: Optional[float] = None
    suggested_profile: Literal["lite", "balanced", "power"]

def _suggest_profile(cpu_threads, ram_total_gb, vram_gb):
    if ram_total_gb < 8 or cpu_threads <= 4:
        return "lite"
    if ram_total_gb >= 24 and cpu_threads >= 12:
        if vram_gb is not None and vram_gb >= 8:
            return "power"
        return "balanced"
    return "balanced"


def _hardware_access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            error.hardware_authority_failure = True
            raise


def _hardware_failed(error, check):
    """A failed probe may degrade; failed captured authority must never do so."""
    if getattr(error, "hardware_authority_failure", False):
        raise error
    _hardware_access(check)


def _hardware_call(call, check):
    _hardware_access(check)
    try:
        result = call()
    except Exception as error:
        _hardware_failed(error, check)
        raise
    _hardware_access(check)
    return result

@router.get("/system/probe", response_model=HardwareProbeResponse)
def system_probe_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return system_probe(check=check)


def system_probe(*, check=None):
    _hardware_access(check)
    if not psutil:
        raise HTTPException(status_code=500, detail="psutil not available")
    cpu_threads = _hardware_call(lambda: psutil.cpu_count(logical=True), check) or 1
    cpu_cores = _hardware_call(lambda: psutil.cpu_count(logical=False), check) or cpu_threads
    vm = _hardware_call(psutil.virtual_memory, check)
    ram_total_gb = round(vm.total / (1024 ** 3), 1)
    ram_available_gb = round(vm.available / (1024 ** 3), 1)
    vram_gb = None
    initialized = False
    try:
        _hardware_access(check)
        import pynvml
        _hardware_access(check)
        pynvml.nvmlInit()
        initialized = True
        _hardware_access(check)
        h = _hardware_call(lambda: pynvml.nvmlDeviceGetHandleByIndex(0), check)
        mem = _hardware_call(lambda: pynvml.nvmlDeviceGetMemoryInfo(h), check)
        vram_gb = round(mem.total / (1024 ** 3), 1)
    except Exception as error:
        _hardware_failed(error, check)
    finally:
        if initialized:
            # Releasing this request's NVML reference is cleanup, including
            # when authority ended immediately after initialization.
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass
    _hardware_access(check)
    suggested = _suggest_profile(cpu_threads, ram_total_gb, vram_gb)
    result = HardwareProbeResponse(cpu_cores=cpu_cores, cpu_threads=cpu_threads,
                                   ram_total_gb=ram_total_gb, ram_available_gb=ram_available_gb,
                                   gpu_vram_gb=vram_gb, suggested_profile=suggested)
    _hardware_access(check)
    return result


# ============================================
#  System summary (dxdiag/DXGI/CIM)
# ============================================

def _run_pwsh_json(ps_script, *, check=None):
    _hardware_access(check)
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script]
    p = _hardware_call(lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=18,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0), check)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "PowerShell failed")
    out = (p.stdout or "").strip()
    result = _hardware_call(lambda: json.loads(out), check) if out else None
    _hardware_access(check)
    return result

def _dxdiag_xml_path(*, check=None):
    _hardware_access(check)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".xml")
    try:
        tmp.close()
        _hardware_access(check)
        result = _hardware_call(lambda: subprocess.run(["dxdiag", "/whql:off", "/x", tmp.name], capture_output=True, text=True, timeout=18,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0), check)
        if result.returncode != 0:
            raise RuntimeError("DirectX hardware information could not be read")
        _hardware_access(check)
    except Exception as error:
        try:
            Path(tmp.name).unlink(missing_ok=True)
        except OSError:
            pass
        _hardware_failed(error, check)
        raise
    return tmp.name

def _parse_dxdiag(xml_path, *, check=None):
    tree = _hardware_call(lambda: ET.parse(xml_path), check)
    root = tree.getroot()
    cpu_model = (root.findtext(".//SystemInformation/Processor") or "").strip()
    gpus = []
    for dev in root.findall(".//DisplayDevices/DisplayDevice"):
        _hardware_access(check)
        name = (dev.findtext("CardName") or "").strip() or None
        driver = (dev.findtext("DriverVersion") or "").strip() or None
        mode = (dev.findtext("CurrentMode") or "").strip() or None
        vram_mb = None
        mem_b = (dev.findtext("DedicatedMemoryInBytes") or "").strip()
        mem_txt = (dev.findtext("DedicatedMemory") or "").strip()
        try:
            if mem_b:
                vram_mb = int(int(mem_b) / (1024 * 1024))
            elif mem_txt:
                digits = "".join(c for c in mem_txt if c.isdigit())
                if digits:
                    vram_mb = int(digits)
        except Exception:
            pass
        gpus.append({"model": name, "driver": driver, "vram_mb": vram_mb, "current_mode": mode})
    best = sorted(gpus, key=lambda x: (x["vram_mb"] or 0), reverse=True)[0] if gpus else None
    display = {}
    if best and best.get("current_mode"):
        cm = best["current_mode"]
        dims = re.search(r"^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\b", cm, re.IGNORECASE)
        if dims:
            width, height = (int(value) for value in dims.groups())
            if 0 < width <= 32768 and 0 < height <= 32768:
                display.update(width=width, height=height)
        # Only the number immediately before Hz is a refresh rate. Resolution
        # and colour-depth digits elsewhere in CurrentMode are unrelated.
        refresh = re.search(r"(?<![\w.+-])(\d+(?:\.\d+)?)\s*Hz\b", cm, re.IGNORECASE)
        if refresh:
            hz = float(refresh.group(1))
            if 1 <= hz <= 1000:
                display["hz"] = int(hz) if hz.is_integer() else hz
    gpu = {}
    if best:
        gpu = {"model": best.get("model"), "driver": best.get("driver"),
               "vram_gb": round(best["vram_mb"] / 1024.0, 1) if best.get("vram_mb") else None}
    result = {"cpu": {"model": cpu_model} if cpu_model else {},
              "gpu": gpu, "display": display, "all_gpus": gpus}
    _hardware_access(check)
    return result

# Note: _dxgi_adapters omitted for brevity — it's Windows-only PowerShell/C# interop.
# Include it if you need it; it's unchanged from the original.

_system_summary_cache: dict = {"result": None, "ts": 0.0}
_SYSTEM_SUMMARY_TTL = 120.0  # seconds — dxdiag + PowerShell are expensive; cache for 2 min

@router.get("/system/summary")
def system_summary_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return system_summary(check=check)


def system_summary(*, check=None):
    from copy import deepcopy
    global _system_summary_cache
    _hardware_access(check)
    now = time.time()
    cached = _system_summary_cache
    if (cached["result"] is not None and (check is None or cached.get("checked") is True)
            and (now - cached["ts"]) < _SYSTEM_SUMMARY_TTL):
        return _hardware_call(lambda: deepcopy(cached["result"]), check)
    ts = S.now_iso()
    cpu_model = (_hardware_call(platform.processor, check)
                 or _hardware_call(platform.machine, check))
    cpu_cores = cpu_threads = None
    if psutil:
        try:
            cpu_cores = _hardware_call(lambda: psutil.cpu_count(logical=False), check)
        except Exception as error:
            _hardware_failed(error, check)
        try:
            cpu_threads = _hardware_call(lambda: psutil.cpu_count(logical=True), check)
        except Exception as error:
            _hardware_failed(error, check)
    ram_total_gb = None
    if psutil:
        try:
            ram_total_gb = round(_hardware_call(psutil.virtual_memory, check).total / (1024 ** 3), 1)
        except Exception as error:
            _hardware_failed(error, check)
    gpu_model = gpu_vram_gb = gpu_driver = None
    display = {}
    storage_drives = []
    storage_volumes = []
    board = {"system": _hardware_call(platform.system, check), "release": _hardware_call(platform.release, check),
             "version": _hardware_call(platform.version, check), "machine": _hardware_call(platform.machine, check)}
    confidence = {"gpu": "low", "display": "low", "storage": "low"}
    sources = {"gpu": [], "display": [], "storage": [], "board": []}

    if board["system"] == "Windows":
        # dxdiag
        xmlp = None
        try:
            _hardware_access(check)
            xmlp = _dxdiag_xml_path(check=check) if check is not None else _dxdiag_xml_path()
            _hardware_access(check)
            dx = _parse_dxdiag(xmlp, check=check) if check is not None else _parse_dxdiag(xmlp)
            _hardware_access(check)
            cpu_model = dx.get("cpu", {}).get("model") or cpu_model
            dxdiag_best = dx.get("gpu")
            dxdiag_display = dx.get("display")
            if dxdiag_best:
                gpu_model = dxdiag_best.get("model")
                gpu_driver = dxdiag_best.get("driver")
                gpu_vram_gb = dxdiag_best.get("vram_gb")
                sources["gpu"].append("dxdiag")
            if dxdiag_display:
                display.update(dxdiag_display)
                sources["display"].append("dxdiag")
        except Exception as error:
            _hardware_failed(error, check)
        finally:
            if xmlp:
                try:
                    Path(xmlp).unlink(missing_ok=True)
                except OSError:
                    pass

        if not display.get("width") or not display.get("height"):
            try:
                _hardware_access(check)
                import ctypes
                user32 = ctypes.windll.user32
                width = _hardware_call(lambda: user32.GetSystemMetrics(0), check)
                height = _hardware_call(lambda: user32.GetSystemMetrics(1), check)
                if width > 0 and height > 0:
                    display.update(width=width, height=height)
                    sources["display"].append("win32:GetSystemMetrics")
            except Exception as error:
                _hardware_failed(error, check)

        if gpu_model or gpu_vram_gb is not None:
            confidence["gpu"] = "medium"
        confidence["display"] = "high" if display.get("width") else "low"

        # Storage
        try:
            _hardware_access(check)
            script = r"Get-CimInstance Win32_DiskDrive | Select-Object Model,InterfaceType,MediaType,Size | ConvertTo-Json -Depth 4"
            disks = _run_pwsh_json(script, check=check) if check is not None else _run_pwsh_json(script)
            _hardware_access(check)
            if isinstance(disks, dict):
                disks = [disks]
            for d in (disks or []):
                _hardware_access(check)
                if not isinstance(d, dict):
                    continue
                size_gb = round(float(d["Size"]) / (1024**3), 1) if d.get("Size") else None
                storage_drives.append({"model": d.get("Model"), "interface": d.get("InterfaceType"),
                                       "media_type": d.get("MediaType"), "size_gb": size_gb})
            sources["storage"].append("cim:Win32_DiskDrive")
        except Exception as error:
            _hardware_failed(error, check)
        confidence["storage"] = "high" if storage_drives else "low"

    elif board["system"] == "Darwin":
        # GPU + display via system_profiler
        try:
            import subprocess as _sp, json as _json
            r = _hardware_call(lambda: _sp.run(["system_profiler", "SPDisplaysDataType", "-json"],
                        capture_output=True, text=True, timeout=15), check)
            if r.returncode == 0 and r.stdout.strip():
                data = _hardware_call(lambda: _json.loads(r.stdout), check)
                gpus = data.get("SPDisplaysDataType") or []
                if isinstance(gpus, list) and gpus:
                    g = gpus[0]
                    gpu_model = g.get("sppci_model") or g.get("_name")
                    vram_raw = g.get("spdisplays_vram") or ""
                    if "MB" in vram_raw:
                        try:
                            gpu_vram_gb = round(int(vram_raw.replace("MB", "").strip()) / 1024, 1)
                        except Exception:
                            pass
                    elif "GB" in vram_raw:
                        try:
                            gpu_vram_gb = float(vram_raw.replace("GB", "").strip())
                        except Exception:
                            pass
                    sources["gpu"].append("system_profiler")
                    confidence["gpu"] = "high"
                    # Extract display resolution from nested display entries
                    for gpu_entry in gpus:
                        _hardware_access(check)
                        for disp in (gpu_entry.get("spdisplays_ndrvs") or []):
                            _hardware_access(check)
                            res = (disp.get("_spdisplays_resolution") or
                                   disp.get("spdisplays_resolution") or "")
                            if res:
                                try:
                                    parts = res.replace(" ", "").split("x")
                                    if len(parts) >= 2:
                                        display["width"] = int(parts[0])
                                        display["height"] = int(parts[1].split("(")[0].split("@")[0])
                                        sources["display"].append("system_profiler")
                                except Exception:
                                    pass
                            if display.get("width"):
                                break
                        if display.get("width"):
                            break
                    confidence["display"] = "high" if display.get("width") else "low"
        except Exception as error:
            _hardware_failed(error, check)
        # Storage via diskutil
        try:
            import subprocess as _sp, json as _json, plistlib as _plistlib
            r = _hardware_call(lambda: _sp.run(["diskutil", "list", "-plist"], capture_output=True, timeout=10), check)
            if r.returncode == 0 and r.stdout:
                data = _hardware_call(lambda: _plistlib.loads(r.stdout), check)
                for disk_id in (data.get("WholeDisks") or []):
                    _hardware_access(check)
                    try:
                        r2 = _hardware_call(lambda: _sp.run(["diskutil", "info", "-plist", disk_id],
                                     capture_output=True, timeout=5), check)
                        if r2.returncode == 0 and r2.stdout:
                            info = _hardware_call(lambda: _plistlib.loads(r2.stdout), check)
                            size_bytes = info.get("TotalSize") or 0
                            size_gb = round(size_bytes / (1024 ** 3), 1) if size_bytes else None
                            storage_drives.append({
                                "model": info.get("MediaName") or info.get("IORegistryEntryName") or disk_id,
                                "interface": info.get("BusProtocol") or "unknown",
                                "media_type": "SSD" if info.get("SolidState") else "HDD",
                                "size_gb": size_gb,
                            })
                    except Exception as error:
                        _hardware_failed(error, check)
                        storage_drives.append({"model": disk_id, "interface": "unknown", "media_type": "unknown"})
                sources["storage"].append("diskutil")
                confidence["storage"] = "medium" if storage_drives else "low"
        except Exception as error:
            _hardware_failed(error, check)

    else:
        # Linux — GPU via lspci, storage via lsblk
        try:
            import subprocess as _sp
            r = _hardware_call(lambda: _sp.run(["lspci", "-mm"], capture_output=True, text=True, timeout=10), check)
            if r.returncode == 0:
                for line in r.stdout.splitlines():
                    _hardware_access(check)
                    if any(k in line.lower() for k in ("vga", "3d controller", "display controller")):
                        parts = line.split('"')
                        model = parts[5] if len(parts) > 5 else line
                        gpu_model = model.strip()
                        sources["gpu"].append("lspci")
                        confidence["gpu"] = "medium"
                        break
        except Exception as error:
            _hardware_failed(error, check)
        try:
            import subprocess as _sp, json as _json
            r = _hardware_call(lambda: _sp.run(["lsblk", "--json", "-o", "NAME,SIZE,TYPE,MODEL"],
                        capture_output=True, text=True, timeout=10), check)
            if r.returncode == 0 and r.stdout.strip():
                data = _hardware_call(lambda: _json.loads(r.stdout), check)
                for dev in (data.get("blockdevices") or []):
                    _hardware_access(check)
                    if dev.get("type") == "disk":
                        storage_drives.append({
                            "model": dev.get("model") or dev.get("name"),
                            "size_gb": dev.get("size"),
                            "interface": "unknown",
                            "media_type": "unknown",
                        })
                sources["storage"].append("lsblk")
                confidence["storage"] = "medium" if storage_drives else "low"
        except Exception as error:
            _hardware_failed(error, check)

    _hardware_access(check)
    result = {
        "timestamp": ts,
        "cpu": {"model": cpu_model, "cores": cpu_cores, "threads": cpu_threads},
        "gpu": {"model": gpu_model, "vram_gb": gpu_vram_gb, "driver": gpu_driver},
        "memory": {"total_gb": ram_total_gb}, "display": display,
        "storage": {"drives": storage_drives, "volumes": storage_volumes},
        "board": board, "confidence": confidence, "sources": sources,
    }
    _hardware_access(check)
    retained = _hardware_call(lambda: deepcopy(result), check)
    previous = _system_summary_cache
    published = {"result": retained, "ts": now, "checked": check is not None}
    _system_summary_cache = published
    try:
        _hardware_access(check)
    except Exception:
        if _system_summary_cache is published:
            _system_summary_cache = previous
        raise
    return result


# ============================================
#  Agent simple endpoints
# ============================================

def builtin_sys_snapshot(params=None, *, check=None):
    _hardware_access(check)
    info = {
        "timestamp": S.now_iso(), "hostname": _hardware_call(platform.node, check),
        "os": _hardware_call(platform.platform, check),
        "platform": _hardware_call(platform.system, check), "python_version": sys.version.split()[0],
        "cpu_count": _hardware_call(os.cpu_count, check),
    }
    if psutil:
        try:
            vm = _hardware_call(psutil.virtual_memory, check)
            info["memory"] = {"total_gb": round(vm.total/(1024**3),2), "used_gb": round(vm.used/(1024**3),2),
                              "free_gb": round(vm.available/(1024**3),2), "percent_used": vm.percent}
        except Exception as error:
            _hardware_failed(error, check)
    _hardware_access(check)
    return info

@router.get("/agent/ping")
def agent_ping():
    """Public discovery hints: never initialize identity or observe a model."""
    try:
        cfg = S.read_node_config()
        result = {
            "ok": True,
            "node_id": cfg.node_id if cfg else None,
            "node_name": cfg.node_name if cfg else None,
            "role": cfg.role if cfg else None,
            "identity_state": "existing" if cfg else "uninitialized",
            "hostname": platform.node(),
            "os": platform.system(),
            "ts": S.now_iso(),
            # Discovery is not model readiness or permission to use inference.
            # Keep legacy keys with explicit unknowns instead of probing or
            # inventing a healthy/offline result for an anonymous request.
            "has_ai": None,
            "ai_healthy": None,
            "active_preset": None,
            "model_state": "unobserved",
        }
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except Exception:
        raise HTTPException(503, "Discovery information is unavailable.",
                            headers={"Cache-Control": "no-store"}) from None

@router.get("/agent/health")
def agent_health_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return agent_health(check=check)


def agent_health(*, check=None):
    """
    Private host observation for browser wrappers and explicit internal callers.
    Reads existing identity, CPU/RAM/disk and an already-initialized AI manager.
    """
    _hardware_access(check)
    cfg = _hardware_call(lambda: S.read_node_config(check=check), check)
    hostname = _hardware_call(platform.node, check)

    out: dict = {
        "ok": True,
        "node_id": cfg.node_id if cfg else None,
        "node_name": cfg.node_name if cfg else hostname,
        "hostname": hostname,
        "os": _hardware_call(platform.system, check),
        "ts": S.now_iso(),
        "cpu_percent": None, "ram_total_gb": None, "ram_used_gb": None,
        "ram_percent": None, "disk_total_gb": None, "disk_free_gb": None,
        "disk_percent": None, "uptime_seconds": None,
    }

    # ── System metrics ────────────────────────────────────────
    if psutil:
        try:
            out["cpu_percent"] = _hardware_call(lambda: psutil.cpu_percent(interval=None), check)
        except Exception as error:
            _hardware_failed(error, check)
        try:
            vm = _hardware_call(psutil.virtual_memory, check)
            out["ram_total_gb"] = round(vm.total / (1024 ** 3), 1)
            out["ram_used_gb"]  = round(vm.used  / (1024 ** 3), 1)
            out["ram_percent"]  = vm.percent
        except Exception as error:
            _hardware_failed(error, check)
        try:
            du = _hardware_call(lambda: psutil.disk_usage("/"), check)
            out["disk_total_gb"] = round(du.total / (1024 ** 3), 1)
            out["disk_free_gb"]  = round(du.free  / (1024 ** 3), 1)
            out["disk_percent"]  = du.percent
        except Exception as error:
            _hardware_failed(error, check)
        try:
            out["uptime_seconds"] = int(time.time() - _hardware_call(psutil.boot_time, check))
        except Exception as error:
            _hardware_failed(error, check)

    # ── AI status ─────────────────────────────────────────────
    # Importing this module can initialize Windows process ownership. A read
    # observes only a module/manager already established by normal startup.
    module = sys.modules.get("ai.ai_manager")
    observed = {"status": "unavailable", "model_exists": None, "healthy": None,
                "active_preset": None, "active_model": None}
    _hardware_access(check)
    if module is not None:
        observed = _hardware_call(lambda: module.BundledAIManager.observe_existing(
            check=(lambda: _hardware_access(check)) if check is not None else None), check)
    out.update(ai_status=observed["status"], has_ai=observed["model_exists"],
               ai_healthy=observed["healthy"], active_preset=observed["active_preset"],
               active_model=observed["active_model"])
    _hardware_access(check)
    return out


@router.get("/agent/info")
def agent_info_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return agent_info(check=check)


def agent_info(*, check=None):
    _hardware_access(check)
    cfg = _hardware_call(lambda: S.read_node_config(check=check), check)
    node_info = ({"node_id": cfg.node_id, "node_name": cfg.node_name, "role": cfg.role,
                  "mesh_status": cfg.mesh_status} if cfg else
                 {"node_id": None, "role": "standalone"})
    result = {"ok": True, "node": node_info,
              "system": builtin_sys_snapshot(check=check), "ts": S.now_iso()}
    _hardware_access(check)
    return result


# ============================================
#  Device nickname
# ============================================

class DeviceNicknameRequest(BaseModel):
    nickname: str = Field(max_length=256)

@router.post("/device/nickname")
def set_device_nickname(req: DeviceNicknameRequest, check=Depends(_observation_access)):
    with _private_observation(check):
        saved = S.update_node_settings(name=req.nickname, check=check)
        # Keep the legacy response field while publishing the actual canonical
        # identity separately. Renaming never reads or rewrites devices.json.
        return {"status": "ok", "device_id": "default-device", "node_id": saved["node_id"],
                "nickname": saved["node_name"]}


# ============================================
#  Diagnostics
# ============================================

def _has_route_check(app, path):
    try:
        for r in app.routes:
            if getattr(r, "path", None) == path:
                return True
    except Exception:
        pass
    return False

@router.get("/api/system/disk")
def system_disk_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return system_disk(check=check)


def system_disk(*, check=None):
    """
    Fast psutil disk snapshot — no WMI, no PowerShell.
    Returns per-drive breakdown and explicitly identifies the system (C:) drive.
    """
    _hardware_access(check)
    if not psutil:
        return {"ok": False, "error": "psutil not available"}

    # Determine system drive (C:\ on Windows, / on Linux/Mac)
    windows = _hardware_call(platform.system, check) == "Windows"
    sys_root = _os.environ.get("SystemDrive", "C:") + "\\" if windows else "/"
    sys_root = sys_root.upper()

    gb = 1024 ** 3
    drives = []
    try:
        partitions = _hardware_call(lambda: psutil.disk_partitions(all=False), check)
        for p in partitions:
            _hardware_access(check)
            try:
                u = _hardware_call(lambda: psutil.disk_usage(p.mountpoint), check)
                mp = p.mountpoint.upper().rstrip("\\/") + ("\\" if windows else "/")
                drives.append({
                    "mount":    p.mountpoint,
                    "drive":    p.mountpoint.rstrip("\\/"),
                    "fstype":   p.fstype,
                    "total_gb": round(u.total / gb, 1),
                    "used_gb":  round(u.used  / gb, 1),
                    "free_gb":  round(u.free  / gb, 1),
                    "pct":      round(u.percent, 1),
                    "is_system": mp == sys_root,
                })
            except Exception as error:
                _hardware_failed(error, check)
                continue
    except Exception as e:
        _hardware_failed(e, check)
        return {"ok": False, "error": "Disk information is unavailable." if check is not None else str(e)}

    _hardware_access(check)
    if not drives:
        return {"ok": False, "error": "No drives found"}

    sys_drive = next((d for d in drives if d["is_system"]), drives[0])
    result = {
        "ok":      True,
        "system":  sys_drive,
        "drives":  drives,
        # Flat fields for backward compat (vitals bar uses these)
        "total_gb": sys_drive["total_gb"],
        "used_gb":  sys_drive["used_gb"],
        "free_gb":  sys_drive["free_gb"],
        "pct":      sys_drive["pct"],
    }
    _hardware_access(check)
    return result


@router.get("/api/diagnostics/version")
def diagnostics_version(request: Request):
    from release_identity import public_status
    from fastapi.responses import JSONResponse
    return JSONResponse({"ok": True, "build_id": BUILD_ID, "build_utc": BACKEND_BUILD_UTC,
            "python": sys.version.split()[0], "platform": platform.platform(),
            "release": public_status(request.app.openapi()["paths"])}, headers={"Cache-Control": "no-store"})

@router.get("/api/diagnostics/whoami")
def diagnostics_whoami(check=Depends(_observation_access)):
    with _private_observation(check):
        return {"ok": True, "build_id": BUILD_ID, "main_file": __file__,
                "cwd": os.getcwd(), "python": sys.version.replace("\n", " ")}

@router.get("/api/diagnostics/routes")
def diagnostics_routes():
    # NOTE: app reference not available here directly; caller should inject if needed.
    return {"ok": True, "note": "Use /debug/routes for full route listing."}


# ============================================
#  Debug endpoints
# ============================================

@router.get("/debug/logs")
def get_debug_logs(limit: int = Query(100, ge=1, le=1000),
                   subsystem: Optional[str] = None, level: Optional[str] = None,
                   check=Depends(browser_control_access)):
    check()
    exists = S.DEBUG_LOG_PATH.exists()
    check()
    if not exists:
        return []
    try:
        lines = S.DEBUG_LOG_PATH.read_text(encoding="utf-8").splitlines()
    except Exception as e:
        check()
        raise HTTPException(status_code=500, detail=f"Error reading debug log: {e}")
    check()
    lines = lines[-limit:]
    events = []
    for line in lines:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if subsystem and ev.get("subsystem") != subsystem:
            continue
        if level and ev.get("level") != level:
            continue
        events.append(ev)
    events.reverse()
    check()
    return events


@router.get("/debug/selftest")
def debug_selftest(check=Depends(_observation_access)):
    with _private_observation(check):
        results = {}
        try:
            with requests.Session() as session:
                # Probing the configured model server must not attach unrelated
                # host .netrc credentials or silently use an environment proxy.
                session.trust_env = False
                check()
                r = session.get(S.LM_STUDIO_MODELS_URL, timeout=(S.HTTP_CONNECT_TIMEOUT, 4),
                                allow_redirects=False, stream=True)
                try:
                    check()
                    results["lmstudio"] = {"ok": r.status_code == 200, "status_code": r.status_code}
                finally:
                    r.close()
        except HTTPException:
            raise
        except Exception:
            check()
            results["lmstudio"] = {"ok": False, "error": "Model server probe failed"}
        try:
            check()
            results["vault"] = {"initialized": vault_is_initialized()}
            check()
        except HTTPException:
            raise
        except Exception:
            check()
            results["vault"] = {"ok": False, "error": "Vault status unavailable"}
        return results


# ============================================
#  PIN Lock
# ============================================

_hash_pin = pin_security.hash_pin  # Compatibility for callers preparing test PINs.


class PinSetRequest(BaseModel):
    pin: str = Field(max_length=128)
    current_pin: Optional[str] = Field(default=None, max_length=128)


class PinVerifyRequest(BaseModel):
    pin: str = Field(max_length=128)


@router.get("/system/pin/status")
def pin_status(response: Response):
    response.headers["Cache-Control"] = "no-store"
    cfg = S.load_pin_config()
    return {"enabled": cfg["enabled"]}


@router.post("/system/pin/set")
def pin_set(body: PinSetRequest, request: Request, response: Response):
    local = browser_request_local(request, response)
    pin_security.set_pin(body.pin, body.current_pin or "", local=local)
    _delete_pin_cookie(response)
    S.log_debug("pin", "INFO", "PIN set/changed")
    return {"ok": True, "locked": True}


@router.post("/system/pin/verify")
def pin_verify(body: PinVerifyRequest, request: Request, response: Response):
    local = browser_request_local(request, response)
    token = pin_security.verify(body.pin, local=local)
    if token is None:
        _delete_pin_cookie(response)
        return {"ok": True, "note": "No PIN set — access open."}
    response.set_cookie(
        key="tli_session",
        value=token,
        max_age=S.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        path="/",
        secure=request.url.scheme == "https",
    )
    return {"ok": True}


@router.post("/system/pin/remove")
def pin_remove(body: PinVerifyRequest, request: Request, response: Response):
    local = browser_request_local(request, response)
    pin_security.remove(body.pin, local=local)
    _delete_pin_cookie(response)
    S.log_debug("pin", "INFO", "PIN removed, all sessions revoked")
    return {"ok": True}


def _delete_pin_cookie(response: Response) -> None:
    response.delete_cookie("tli_session", path="/", httponly=True, samesite="strict")
    response.headers["Cache-Control"] = "no-store"


@router.post("/system/pin/lock")
def pin_lock(request: Request, response: Response, _session: str = Depends(require_session)):
    """Lock only this authenticated browser, leaving other clients connected."""
    browser_request_local(request, response)
    with S._PIN_CONFIG_LOCK:
        token = request.cookies.get("tli_session")
        if not token or not S.validate_session_token(token):
            raise HTTPException(401, "A valid browser session is required. Unlock with the PIN.")
        if not S.load_pin_config()["enabled"]:
            raise HTTPException(409, "No PIN is enabled. Set a PIN in Settings before locking TLI.")
        S.revoke_session_token(token)
    _delete_pin_cookie(response)
    return {"ok": True, "locked": True}


@router.post("/system/pin/emergency-reset")
def pin_emergency_reset(response: Response, check=Depends(browser_control_access)):
    """Remove a readable PIN using an existing authenticated session."""
    pin_security.reset(check)
    _delete_pin_cookie(response)
    S.log_debug("pin", "WARN", "Authenticated PIN reset performed")
    return {"ok": True, "note": "PIN cleared. All sessions revoked."}


# ── Onboarding endpoints ──────────────────────────────────────

import onboarding_store as _onboarding_store

_ONBOARDING_COMPLETE_FILE = Path(S.DATA_DIR) / "onboarding_complete.json"
_ONBOARDING_STARTED_FILE = Path(S.DATA_DIR) / "onboarding_started.json"


@router.get("/system/onboarding/status")
def onboarding_status():
    """Public, read-only setup status; started means unfinished setup."""
    return _onboarding_store.state(_ONBOARDING_STARTED_FILE, _ONBOARDING_COMPLETE_FILE)


@router.post("/system/onboarding/start")
def onboarding_start(check=Depends(_observation_access)):
    """Persist progress before creating a PIN; never reset completed setup."""
    with _private_observation(check):
        return _onboarding_store.start(_ONBOARDING_STARTED_FILE, _ONBOARDING_COMPLETE_FILE, check=check)


@router.post("/system/onboarding/complete")
def onboarding_complete(check=Depends(_observation_access)):
    """Acknowledge completion only after an authenticated, durable save."""
    with _private_observation(check):
        return _onboarding_store.complete(_ONBOARDING_STARTED_FILE, _ONBOARDING_COMPLETE_FILE, check=check)


class NodeNameRequest(BaseModel):
    name: str = Field(max_length=256)


@router.post("/system/node/name")
def set_node_name(body: NodeNameRequest, check=Depends(_observation_access)):
    """Update the node's display name (used in mesh and dashboard)."""
    with _private_observation(check):
        saved = S.update_node_settings(name=body.name, check=check)
        return {"ok": True, "node_id": saved["node_id"], "node_name": saved["node_name"]}


class LMStudioTestRequest(BaseModel):
    url: str = Field(max_length=4096)


@router.post("/system/lm_studio/test")
def lm_studio_test(body: LMStudioTestRequest, check=Depends(_observation_access)):
    """Test if an LM Studio endpoint is reachable. Returns models list on success."""
    import lm_studio_config as config
    from model_probe import probe_json, ModelProbeError
    with _private_observation(check):
        try:
            models_url = config.from_url(body.url)["models_url"]
        except config.InvalidEndpoint as error:
            raise HTTPException(400, str(error)) from None
        try:
            result = probe_json(models_url, check=check, timeout=(S.HTTP_CONNECT_TIMEOUT, 4))
            check()
            if result["status_code"] != 200:
                return {"ok": False, "error": f"Server returned {result['status_code']}"}
            data = result["data"]
            if not isinstance(data, dict) or not isinstance(data.get("data"), list) or len(data["data"]) > 1000:
                raise ValueError("Invalid models response")
            models = []
            for row in data["data"]:
                check()
                if not isinstance(row, dict) or not isinstance(row.get("id", ""), str) or len(row.get("id", "")) > 4096:
                    raise ValueError("Invalid model identifier")
                model = row.get("id", "")
                model.encode("utf-8")
                models.append(model)
            check()
            return {"ok": True, "models": models, "count": len(models)}
        except HTTPException:
            raise
        except (ModelProbeError, ValueError, TypeError, KeyError):
            check()
            return {"ok": False, "error": "LM Studio test failed or returned an unavailable response."}


class LMStudioUrlRequest(BaseModel):
    url: str = Field(max_length=4096)


@router.post("/system/lm_studio/url")
def set_lm_studio_url(body: LMStudioUrlRequest, check=Depends(_observation_access)):
    """Persist a new LM Studio URL and update the live provider."""
    import lm_studio_config as config
    with _private_observation(check):
        try:
            saved = S.save_lm_studio_url(body.url, check=check)
        except config.InvalidEndpoint as error:
            raise HTTPException(400, str(error)) from None
        except config.ConfigurationUnavailable as error:
            raise HTTPException(503, str(error)) from None
        check()
        S.log_debug("system", "INFO", "LM Studio endpoint settings saved")
        check()
        return {"ok": True, **saved}


# ── Setup autodetect ─────────────────────────────────────────

_LM_PROBE_PORTS = [
    ("LM Studio",  "http://localhost:1234/v1/models",     "http://localhost:1234/v1/chat/completions"),
    ("Ollama",     "http://localhost:11434/api/tags",      "http://localhost:11434/v1/chat/completions"),
    ("LM Studio",  "http://localhost:8080/v1/models",      "http://localhost:8080/v1/chat/completions"),
    ("LM Studio",  "http://localhost:5000/v1/models",      "http://localhost:5000/v1/chat/completions"),
]


def _probe_lm(probe_url: str, chat_url: str, label: str, *, check=None):
    """Return (chat_url, label, models) if probe_url responds, else None."""
    if check is not None:
        from model_probe import ModelProbeError, probe_json
        from providers.lmstudio import LMStudioProvider
        check()
        try:
            result = probe_json(probe_url, check=check, timeout=(1.2, 2.5))
        except ModelProbeError:
            check()
            return None
        check()
        if result["status_code"] != 200:
            return None
        data = result["data"]
        if not isinstance(data, dict):
            return None
        rows = data.get("data") if "data" in data else data.get("models")
        try:
            models = LMStudioProvider._checked_model_ids(rows, check, allow_name=True)
        except ModelProbeError:
            check()
            return None
        check()
        return {"chat_url": chat_url, "label": label, "models": models}
    try:
        r = requests.get(probe_url, timeout=(1.2, 2.5))
        if r.status_code == 200:
            data = r.json()
            # LM Studio shape: {"data": [...]}   Ollama shape: {"models": [...]}
            models = [m.get("id") or m.get("name", "") for m in
                      (data.get("data") or data.get("models") or [])]
            return {"chat_url": chat_url, "label": label, "models": [m for m in models if m]}
    except Exception:
        pass
    return None


def _get_lan_ip(*, check=None) -> str:
    import socket
    if check is not None:
        check()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            if check is not None:
                check()
            s.connect(("8.8.8.8", 80))
            if check is not None:
                check()
            result = s.getsockname()[0]
    except HTTPException:
        raise
    except Exception:
        if check is not None:
            check()
        result = "127.0.0.1"
    if check is not None:
        check()
    return result


@router.get("/setup/autodetect")
def setup_autodetect_http(check=Depends(_observation_access)):
    with _private_observation(check):
        return setup_autodetect(check=check)


def setup_autodetect(*, check=None):
    """
    First-run autodetect.  Probes common local AI endpoints concurrently and
    counts known Shelly devices. Running probes retain bounded transport and
    captured authority; cancellation cannot recall an already dispatched request.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError
    from threading import Lock

    authority_error = None
    authority_lock = Lock()

    def access():
        nonlocal authority_error
        with authority_lock:
            if authority_error is not None:
                raise authority_error
        if check is not None:
            try:
                check()
            except Exception as error:
                with authority_lock:
                    if authority_error is None:
                        authority_error = error
                    raise authority_error
        with authority_lock:
            if authority_error is not None:
                raise authority_error

    worker_check = access if check is not None else None

    def observe(call, *args, **kwargs):
        access()
        try:
            return call(*args, **kwargs)
        finally:
            access()

    access()
    ai_found = None
    with ThreadPoolExecutor(max_workers=len(_LM_PROBE_PORTS)) as pool:
        futs = []
        try:
            for lbl, probe, chat in _LM_PROBE_PORTS:
                access()
                futs.append(pool.submit(_probe_lm, probe, chat, lbl, check=worker_check))
            for fut in as_completed(futs, timeout=4):
                access()
                result = observe(fut.result)
                if result and not ai_found:
                    ai_found = result
                    break  # first hit wins
        except TimeoutError:
            access()
        finally:
            for fut in futs:
                fut.cancel()
    access()

    if check is not None:
        import shelly_store
        shelly_devices = observe(shelly_store.read, S.SHELLY_REGISTRY_PATH, check=worker_check)
    else:
        shelly_devices = S.load_shelly_registry()
    # Observation must not bootstrap a new identity after a slow provider probe.
    node_cfg = observe(S.read_node_config if check is not None else S.load_node_config)
    lan_ip = observe(_get_lan_ip, check=worker_check)

    return {
        "ai": {
            "found":    bool(ai_found),
            "chat_url": ai_found["chat_url"] if ai_found else S.LM_STUDIO_URL,
            "label":    ai_found["label"]    if ai_found else None,
            "models":   ai_found["models"]   if ai_found else [],
        },
        "shelly": {
            "count":   len(shelly_devices),
            "devices": [d.get("name") or d.get("ip") for d in shelly_devices[:5]],
        },
        "node": {
            "name":    node_cfg.node_name if node_cfg else "TLI Node",
            "node_id": node_cfg.node_id if node_cfg else None,
            "role":    node_cfg.role if node_cfg else "standalone",
        },
        "lan_ip": lan_ip,
    }


# ── TLS cert endpoints ────────────────────────────────────────
@router.get("/system/tls/status")
def tls_status():
    return {
        "tls_enabled": S.TLS_ENABLED,
        "cert_exists": os.path.exists(S.TLS_CERT_PATH),
    }


@router.get("/system/tls/cert")
def download_tls_cert():
    """Download the public TLS certificate so other devices can trust it."""
    if not os.path.exists(S.TLS_CERT_PATH):
        raise HTTPException(status_code=404, detail="No TLS certificate found.")
    from fastapi.responses import FileResponse
    return FileResponse(
        S.TLS_CERT_PATH,
        media_type="application/x-pem-file",
        filename="tli-cert.pem",
    )


# ============================================
#  Ambient alerts
# ============================================

@router.get("/status/alerts")
def get_alerts(check=Depends(_observation_access)):
    """Return all active (non-dismissed) alerts."""
    with _private_observation(check):
        alerts = S.load_alerts(check=check)
        active = [a for a in alerts if not a.get("dismissed")]
        return {"alerts": active, "count": len(active)}


@router.post("/status/alerts/{alert_id}/dismiss")
def dismiss_alert(alert_id: str, check=Depends(_observation_access)):
    with _private_observation(check):
        found = S.dismiss_alert(alert_id, check=check)
        if not found:
            raise HTTPException(status_code=404, detail="Alert not found")
        return {"ok": True, "dismissed": alert_id}


@router.post("/status/alerts/dismiss-all")
def dismiss_all_alerts(check=Depends(_observation_access)):
    with _private_observation(check):
        count = S.dismiss_all_alerts(check=check)
        return {"ok": True, "dismissed": count}


# ============================================
#  Installer download
# ============================================

@router.get("/download/installer")
def download_installer():
    """Serve the TLI installer EXE from the dist directory next to the project root."""
    from fastapi.responses import FileResponse
    candidates = [
        Path(S.BASE_DIR) / "TLI_Installer" / "dist" / "TLI-Setup.exe",
        Path(S.BASE_DIR) / "TLI_Installer" / "TLI-Setup.exe",
        Path(S.BASE_DIR).parent / "TLI_Installer" / "dist" / "TLI-Setup.exe",
    ]
    for path in candidates:
        if path.exists():
            return FileResponse(
                str(path),
                media_type="application/octet-stream",
                filename=path.name,
            )
    raise HTTPException(
        status_code=404,
        detail="Installer not found. Build it with: cd TLI_Installer && npm run make",
    )


@router.get("/changelog")
def get_changelog():
    """Return the TLI changelog (DEVLOG or CHANGELOG.md if it exists)."""
    from fastapi.responses import PlainTextResponse
    candidates = [
        Path(S.BASE_DIR) / "TLI_DEVLOG.md",
        Path(S.BASE_DIR) / "CHANGELOG.md",
        Path(S.BASE_DIR).parent / "TLI_DEVLOG.md",
    ]
    for path in candidates:
        if path.exists():
            return PlainTextResponse(path.read_text(encoding="utf-8"))
    return {"message": "No changelog found."}
