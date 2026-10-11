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
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import requests
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel

import tli_state as S
from vault_security import get_status as vault_get_status, is_initialized as vault_is_initialized

try:
    import psutil
except Exception:
    psutil = None

router = APIRouter(tags=["system"])


# ── Shared session dependency (defined early so all endpoints can use it) ─────
def require_session(tli_session: Optional[str] = Cookie(default=None), request: Request = None) -> str:
    """Resolve browser sessions and paired-device Bearer credentials to one owner.

    Keep the cookie positional argument for legacy direct callers. A supplied
    Authorization header is always validated, including while PIN is disabled.
    """
    from companion_auth import resolve_user
    return resolve_user(request, tli_session)


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
def llm_health():
    return {"ok": bool(S.lm_provider.health_check())}

@router.get("/health/llm/report")
def llm_health_report():
    return S.lm_provider.health_report()

_report_cache: dict = {"result": None, "ts": 0.0}
_REPORT_TTL = 10.0

@router.get("/health/lmstudio/report")
def lmstudio_health_report_legacy():
    now = time.time()
    if _report_cache["result"] is not None and now - _report_cache["ts"] < _REPORT_TTL:
        return _report_cache["result"]
    try:
        result = S.lm_provider.health_report()
    except Exception:
        result = {"ok": False, "error": "probe failed"}
    _report_cache["result"] = result
    _report_cache["ts"] = now
    return result

_health_cache: dict = {"result": False, "ts": 0.0}
_HEALTH_TTL = 10.0  # seconds between real LM Studio probes

def lm_studio_health_check_cached() -> bool:
    """Return cached LM health so /status never blocks the worker thread."""
    now = time.time()
    if now - _health_cache["ts"] < _HEALTH_TTL:
        return _health_cache["result"]
    try:
        result = bool(S.lm_provider.health_check())
    except Exception:
        result = False
    _health_cache["result"] = result
    _health_cache["ts"] = now
    return result


# ============================================
#  Status endpoint
# ============================================

@router.get("/status")
def status_endpoint(user_id: str = Depends(require_session)):
    model_online = lm_studio_health_check_cached()
    try:
        cfg = S.load_node_config()
        device_id = cfg.node_id
        nickname = cfg.node_name or "TLI Node"
        node_role = cfg.role
        mesh_status = cfg.mesh_status
    except Exception:
        device_id = "default-device"
        nickname = "TLI Node"
        node_role = "standalone"
        mesh_status = "unpaired"
    devices = S.load_devices()
    dev_entry = devices.get(device_id, {})
    if "ai_name" not in dev_entry:
        dev_entry["ai_name"] = nickname
    if "created_at" not in dev_entry:
        dev_entry["created_at"] = S.now_iso()
    devices[device_id] = dev_entry
    S.save_devices(devices)
    raw_status = vault_get_status(user_id)
    vault_status = {
        "initialized": raw_status.get("is_initialized", False),
        "locked_until": raw_status.get("locked_until"),
        "failed_attempts": raw_status.get("failed_attempts", 0),
        "unlocked": raw_status.get("is_unlocked_for_user", False),
    }
    return {
        "model_online": model_online, "device_id": device_id, "device_nickname": nickname,
        "vault_status": vault_status, "node_role": node_role, "mesh_status": mesh_status,
    }


# ============================================
#  System capabilities
# ============================================

@router.get("/system/capabilities")
def system_capabilities():
    try:
        p = S.SHELLY_REGISTRY_PATH
        if not p.exists():
            return {"devices": []}
        raw = json.loads(p.read_text(encoding="utf-8") or "[]")
        if not isinstance(raw, list):
            return {"devices": []}
        devices = []
        for d in raw:
            if not isinstance(d, dict):
                continue
            ip = str(d.get("ip") or d.get("host") or "").strip()
            if not ip:
                continue
            devices.append({
                "name": str(d.get("name") or d.get("label") or "").strip(), "ip": ip,
                "relay": int(d.get("relay") or 0), "vendor": "shelly",
                "capabilities": ["switch.on", "switch.off"],
            })
        return {"devices": devices}
    except Exception as e:
        S.log_debug("system", "WARN", "system_capabilities failed", error=str(e))
        return {"devices": []}


# ============================================
#  Models API
# ============================================

class SetDefaultModelRequest(BaseModel):
    model_id: str
    label: Optional[str] = None

@router.get("/models/available")
def models_available():
    try:
        models = S.lm_provider.list_models()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach local model server: {e}")
    return {
        "server_url": S.LM_STUDIO_MODELS_URL,
        "compat": S.lm_provider.health_report(),
        "models": models,
        "current": {"default_key": S.DEFAULT_MODEL_KEY, "models": S.MODEL_CONFIG},
    }

@router.post("/models/set-default")
def set_default_model(req: SetDefaultModelRequest, _session: str = Depends(require_session)):
    model_id = req.model_id.strip()
    if not model_id:
        raise HTTPException(status_code=400, detail="model_id is required")
    label = (req.label or model_id).strip()
    S.MODEL_CONFIG.clear()
    S.MODEL_CONFIG["deepseek"] = {"id": model_id, "label": label}
    S.DEFAULT_MODEL_KEY = "deepseek"
    S.save_model_config_to_disk()
    return {"ok": True, "default_key": S.DEFAULT_MODEL_KEY, "model": S.MODEL_CONFIG[S.DEFAULT_MODEL_KEY]}


# ============================================
#  System profile API
# ============================================

class SetSystemProfileRequest(BaseModel):
    profile: str

@router.get("/system/profile")
def get_system_profile():
    return {
        "current": S.CURRENT_SYSTEM_PROFILE, "profiles": S.SYSTEM_PROFILES,
        "ui_defaults": S.SYSTEM_PROFILES.get(S.CURRENT_SYSTEM_PROFILE, {}).get("ui_defaults", {}),
        "limits": S.get_active_system_limits(),
    }

@router.post("/system/profile")
def set_system_profile(req: SetSystemProfileRequest, _session: str = Depends(require_session)):
    prof = (req.profile or "").strip().lower()
    if prof not in S.SYSTEM_PROFILES:
        raise HTTPException(status_code=400, detail="Invalid profile")
    S.CURRENT_SYSTEM_PROFILE = prof
    S.save_system_profile_to_disk()
    return {"ok": True, "current": S.CURRENT_SYSTEM_PROFILE}


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

@router.get("/system/probe", response_model=HardwareProbeResponse)
def system_probe():
    if not psutil:
        raise HTTPException(status_code=500, detail="psutil not available")
    cpu_threads = psutil.cpu_count(logical=True) or 1
    cpu_cores = psutil.cpu_count(logical=False) or cpu_threads
    vm = psutil.virtual_memory()
    ram_total_gb = round(vm.total / (1024 ** 3), 1)
    ram_available_gb = round(vm.available / (1024 ** 3), 1)
    vram_gb = None
    try:
        import pynvml
        pynvml.nvmlInit()
        h = pynvml.nvmlDeviceGetHandleByIndex(0)
        mem = pynvml.nvmlDeviceGetMemoryInfo(h)
        vram_gb = round(mem.total / (1024 ** 3), 1)
    except Exception:
        pass
    suggested = _suggest_profile(cpu_threads, ram_total_gb, vram_gb)
    return HardwareProbeResponse(cpu_cores=cpu_cores, cpu_threads=cpu_threads,
                                  ram_total_gb=ram_total_gb, ram_available_gb=ram_available_gb,
                                  gpu_vram_gb=vram_gb, suggested_profile=suggested)


# ============================================
#  System summary (dxdiag/DXGI/CIM)
# ============================================

def _run_pwsh_json(ps_script):
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=18,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "PowerShell failed")
    out = (p.stdout or "").strip()
    return json.loads(out) if out else None

def _dxdiag_xml_path():
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".xml")
    tmp.close()
    try:
        result = subprocess.run(["dxdiag", "/whql:off", "/x", tmp.name], capture_output=True, text=True, timeout=18,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
        if result.returncode != 0:
            raise RuntimeError("DirectX hardware information could not be read")
    except Exception:
        try:
            Path(tmp.name).unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return tmp.name

def _parse_dxdiag(xml_path):
    tree = ET.parse(xml_path)
    root = tree.getroot()
    cpu_model = (root.findtext(".//SystemInformation/Processor") or "").strip()
    gpus = []
    for dev in root.findall(".//DisplayDevices/DisplayDevice"):
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
    return {"cpu": {"model": cpu_model} if cpu_model else {},
            "gpu": gpu, "display": display, "all_gpus": gpus}

# Note: _dxgi_adapters omitted for brevity — it's Windows-only PowerShell/C# interop.
# Include it if you need it; it's unchanged from the original.

_system_summary_cache: dict = {"result": None, "ts": 0.0}
_SYSTEM_SUMMARY_TTL = 120.0  # seconds — dxdiag + PowerShell are expensive; cache for 2 min

@router.get("/system/summary")
def system_summary():
    now = time.time()
    if _system_summary_cache["result"] is not None and (now - _system_summary_cache["ts"]) < _SYSTEM_SUMMARY_TTL:
        return _system_summary_cache["result"]
    ts = S.now_iso()
    cpu_model = platform.processor() or platform.machine()
    cpu_cores = cpu_threads = None
    if psutil:
        try:
            cpu_cores = psutil.cpu_count(logical=False)
        except Exception:
            pass
        try:
            cpu_threads = psutil.cpu_count(logical=True)
        except Exception:
            pass
    ram_total_gb = None
    if psutil:
        try:
            ram_total_gb = round(psutil.virtual_memory().total / (1024 ** 3), 1)
        except Exception:
            pass
    gpu_model = gpu_vram_gb = gpu_driver = None
    display = {}
    storage_drives = []
    storage_volumes = []
    board = {"system": platform.system(), "release": platform.release(),
             "version": platform.version(), "machine": platform.machine()}
    confidence = {"gpu": "low", "display": "low", "storage": "low"}
    sources = {"gpu": [], "display": [], "storage": [], "board": []}

    if platform.system() == "Windows":
        # dxdiag
        xmlp = None
        try:
            xmlp = _dxdiag_xml_path()
            dx = _parse_dxdiag(xmlp)
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
        except Exception:
            pass
        finally:
            if xmlp:
                try:
                    Path(xmlp).unlink(missing_ok=True)
                except OSError:
                    pass

        if not display.get("width") or not display.get("height"):
            try:
                import ctypes
                user32 = ctypes.windll.user32
                width, height = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
                if width > 0 and height > 0:
                    display.update(width=width, height=height)
                    sources["display"].append("win32:GetSystemMetrics")
            except Exception:
                pass

        if gpu_model or gpu_vram_gb is not None:
            confidence["gpu"] = "medium"
        confidence["display"] = "high" if display.get("width") else "low"

        # Storage
        try:
            disks = _run_pwsh_json(
                r"Get-CimInstance Win32_DiskDrive | Select-Object Model,InterfaceType,MediaType,Size | ConvertTo-Json -Depth 4")
            if isinstance(disks, dict):
                disks = [disks]
            for d in (disks or []):
                if not isinstance(d, dict):
                    continue
                size_gb = round(float(d["Size"]) / (1024**3), 1) if d.get("Size") else None
                storage_drives.append({"model": d.get("Model"), "interface": d.get("InterfaceType"),
                                       "media_type": d.get("MediaType"), "size_gb": size_gb})
            sources["storage"].append("cim:Win32_DiskDrive")
        except Exception:
            pass
        confidence["storage"] = "high" if storage_drives else "low"

    elif platform.system() == "Darwin":
        # GPU + display via system_profiler
        try:
            import subprocess as _sp, json as _json
            r = _sp.run(["system_profiler", "SPDisplaysDataType", "-json"],
                        capture_output=True, text=True, timeout=15)
            if r.returncode == 0 and r.stdout.strip():
                data = _json.loads(r.stdout)
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
                        for disp in (gpu_entry.get("spdisplays_ndrvs") or []):
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
        except Exception:
            pass
        # Storage via diskutil
        try:
            import subprocess as _sp, json as _json, plistlib as _plistlib
            r = _sp.run(["diskutil", "list", "-plist"], capture_output=True, timeout=10)
            if r.returncode == 0 and r.stdout:
                data = _plistlib.loads(r.stdout)
                for disk_id in (data.get("WholeDisks") or []):
                    try:
                        r2 = _sp.run(["diskutil", "info", "-plist", disk_id],
                                     capture_output=True, timeout=5)
                        if r2.returncode == 0 and r2.stdout:
                            info = _plistlib.loads(r2.stdout)
                            size_bytes = info.get("TotalSize") or 0
                            size_gb = round(size_bytes / (1024 ** 3), 1) if size_bytes else None
                            storage_drives.append({
                                "model": info.get("MediaName") or info.get("IORegistryEntryName") or disk_id,
                                "interface": info.get("BusProtocol") or "unknown",
                                "media_type": "SSD" if info.get("SolidState") else "HDD",
                                "size_gb": size_gb,
                            })
                    except Exception:
                        storage_drives.append({"model": disk_id, "interface": "unknown", "media_type": "unknown"})
                sources["storage"].append("diskutil")
                confidence["storage"] = "medium" if storage_drives else "low"
        except Exception:
            pass

    else:
        # Linux — GPU via lspci, storage via lsblk
        try:
            import subprocess as _sp
            r = _sp.run(["lspci", "-mm"], capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                for line in r.stdout.splitlines():
                    if any(k in line.lower() for k in ("vga", "3d controller", "display controller")):
                        parts = line.split('"')
                        model = parts[5] if len(parts) > 5 else line
                        gpu_model = model.strip()
                        sources["gpu"].append("lspci")
                        confidence["gpu"] = "medium"
                        break
        except Exception:
            pass
        try:
            import subprocess as _sp, json as _json
            r = _sp.run(["lsblk", "--json", "-o", "NAME,SIZE,TYPE,MODEL"],
                        capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                data = _json.loads(r.stdout)
                for dev in (data.get("blockdevices") or []):
                    if dev.get("type") == "disk":
                        storage_drives.append({
                            "model": dev.get("model") or dev.get("name"),
                            "size_gb": dev.get("size"),
                            "interface": "unknown",
                            "media_type": "unknown",
                        })
                sources["storage"].append("lsblk")
                confidence["storage"] = "medium" if storage_drives else "low"
        except Exception:
            pass

    result = {
        "timestamp": ts,
        "cpu": {"model": cpu_model, "cores": cpu_cores, "threads": cpu_threads},
        "gpu": {"model": gpu_model, "vram_gb": gpu_vram_gb, "driver": gpu_driver},
        "memory": {"total_gb": ram_total_gb}, "display": display,
        "storage": {"drives": storage_drives, "volumes": storage_volumes},
        "board": board, "confidence": confidence, "sources": sources,
    }
    _system_summary_cache["result"] = result
    _system_summary_cache["ts"] = now
    return result


# ============================================
#  Agent simple endpoints
# ============================================

def builtin_sys_snapshot(params=None):
    info = {
        "timestamp": S.now_iso(), "hostname": platform.node(), "os": platform.platform(),
        "platform": platform.system(), "python_version": sys.version.split()[0], "cpu_count": os.cpu_count(),
    }
    if psutil:
        try:
            vm = psutil.virtual_memory()
            info["memory"] = {"total_gb": round(vm.total/(1024**3),2), "used_gb": round(vm.used/(1024**3),2),
                              "free_gb": round(vm.available/(1024**3),2), "percent_used": vm.percent}
        except Exception:
            pass
    return info

@router.get("/agent/ping")
def agent_ping():
    try:
        cfg = S.load_node_config()
        # Advertise AI capability so mesh peers can route to us
        has_ai = False
        ai_healthy = False
        active_preset = None
        try:
            from ai.ai_manager import BundledAIManager
            mgr = BundledAIManager.get()
            st = mgr.status()
            has_ai = bool(st.get("model_exists", False))
            ai_healthy = bool(st.get("healthy", False))
            active_preset = st.get("active_preset")
        except Exception:
            pass
        return {
            "ok": True,
            "node_id": cfg.node_id,
            "node_name": cfg.node_name,
            "role": cfg.role,
            "hostname": platform.node(),
            "os": platform.system(),
            "ts": S.now_iso(),
            "has_ai": has_ai,
            "ai_healthy": ai_healthy,
            "active_preset": active_preset,
        }
    except Exception:
        return {"ok": True, "node_id": "unknown", "ts": S.now_iso()}

@router.get("/agent/health")
def agent_health():
    """
    Rich live stats for this node — called by peers when building the collective dashboard.
    Returns CPU %, RAM, disk, uptime, AI status in one round-trip.
    """
    try:
        cfg = S.load_node_config()
    except Exception:
        cfg = None

    out: dict = {
        "ok": True,
        "node_id": cfg.node_id if cfg else "unknown",
        "node_name": cfg.node_name if cfg else platform.node(),
        "hostname": platform.node(),
        "os": platform.system(),
        "ts": S.now_iso(),
    }

    # ── System metrics ────────────────────────────────────────
    if psutil:
        try:
            out["cpu_percent"] = psutil.cpu_percent(interval=None)
        except Exception:
            out["cpu_percent"] = None
        try:
            vm = psutil.virtual_memory()
            out["ram_total_gb"] = round(vm.total / (1024 ** 3), 1)
            out["ram_used_gb"]  = round(vm.used  / (1024 ** 3), 1)
            out["ram_percent"]  = vm.percent
        except Exception:
            pass
        try:
            du = psutil.disk_usage("/")
            out["disk_total_gb"] = round(du.total / (1024 ** 3), 1)
            out["disk_free_gb"]  = round(du.free  / (1024 ** 3), 1)
            out["disk_percent"]  = du.percent
        except Exception:
            pass
        try:
            out["uptime_seconds"] = int(time.time() - psutil.boot_time())
        except Exception:
            out["uptime_seconds"] = None

    # ── AI status ─────────────────────────────────────────────
    try:
        from ai.ai_manager import BundledAIManager, MODEL_PRESETS
        mgr = BundledAIManager.get()
        st  = mgr.status()
        preset = MODEL_PRESETS.get(mgr.active_preset_id, {})
        out["has_ai"]       = bool(st.get("model_exists", False))
        out["ai_healthy"]   = bool(st.get("healthy", False))
        out["active_preset"] = mgr.active_preset_id
        out["active_model"]  = preset.get("name", mgr.active_preset_id)
    except Exception:
        out["has_ai"] = False
        out["ai_healthy"] = False

    return out


@router.get("/agent/info")
def agent_info():
    try:
        cfg = S.load_node_config()
        node_info = {"node_id": cfg.node_id, "node_name": cfg.node_name, "role": cfg.role,
                     "mesh_status": cfg.mesh_status}
    except Exception:
        node_info = {"node_id": None, "role": "standalone"}
    return {"ok": True, "node": node_info, "system": builtin_sys_snapshot(), "ts": S.now_iso()}


# ============================================
#  Device nickname
# ============================================

class DeviceNicknameRequest(BaseModel):
    nickname: str

@router.post("/device/nickname")
def set_device_nickname(req: DeviceNicknameRequest, _session: str = Depends(require_session)):
    devices = S.load_devices()
    device_id = "default-device"
    devices[device_id] = {"ai_name": req.nickname.strip() or "Device", "created_at": datetime.utcnow().isoformat()}
    S.save_devices(devices)
    return {"status": "ok", "device_id": device_id, "nickname": devices[device_id]["ai_name"]}


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
def system_disk():
    """
    Fast psutil disk snapshot — no WMI, no PowerShell.
    Returns per-drive breakdown and explicitly identifies the system (C:) drive.
    """
    if not psutil:
        return {"ok": False, "error": "psutil not available"}

    # Determine system drive (C:\ on Windows, / on Linux/Mac)
    sys_root = _os.environ.get("SystemDrive", "C:") + "\\" if platform.system() == "Windows" else "/"
    sys_root = sys_root.upper()

    gb = 1024 ** 3
    drives = []
    try:
        for p in psutil.disk_partitions(all=False):
            try:
                u = psutil.disk_usage(p.mountpoint)
                mp = p.mountpoint.upper().rstrip("\\/") + ("\\" if platform.system() == "Windows" else "/")
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
            except Exception:
                continue
    except Exception as e:
        return {"ok": False, "error": str(e)}

    if not drives:
        return {"ok": False, "error": "No drives found"}

    sys_drive = next((d for d in drives if d["is_system"]), drives[0])
    return {
        "ok":      True,
        "system":  sys_drive,
        "drives":  drives,
        # Flat fields for backward compat (vitals bar uses these)
        "total_gb": sys_drive["total_gb"],
        "used_gb":  sys_drive["used_gb"],
        "free_gb":  sys_drive["free_gb"],
        "pct":      sys_drive["pct"],
    }


@router.get("/api/diagnostics/version")
def diagnostics_version(request: Request):
    from release_identity import public_status
    from fastapi.responses import JSONResponse
    return JSONResponse({"ok": True, "build_id": BUILD_ID, "build_utc": BACKEND_BUILD_UTC,
            "python": sys.version.split()[0], "platform": platform.platform(),
            "release": public_status(request.app.routes)}, headers={"Cache-Control": "no-store"})

@router.get("/api/diagnostics/whoami")
def diagnostics_whoami():
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
                   subsystem: Optional[str] = None, level: Optional[str] = None):
    if not S.DEBUG_LOG_PATH.exists():
        return []
    try:
        lines = S.DEBUG_LOG_PATH.read_text(encoding="utf-8").splitlines()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading debug log: {e}")
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
    return events


@router.get("/debug/selftest")
def debug_selftest():
    results = {}
    try:
        r = requests.get(S.LM_STUDIO_MODELS_URL, timeout=(S.HTTP_CONNECT_TIMEOUT, 4))
        results["lmstudio"] = {"ok": r.status_code == 200, "status_code": r.status_code}
    except Exception as e:
        results["lmstudio"] = {"ok": False, "error": str(e)}
    try:
        results["vault"] = {"initialized": vault_is_initialized()}
    except Exception as e:
        results["vault"] = {"ok": False, "error": str(e)}
    return results


# ============================================
#  PIN Lock
# ============================================

def _hash_pin(pin: str, salt: str) -> str:
    """PBKDF2-HMAC-SHA256, 260 000 rounds. Returns hex digest."""
    return hashlib.pbkdf2_hmac(
        "sha256",
        pin.encode("utf-8"),
        salt.encode("utf-8"),
        260_000,
    ).hex()


class PinSetRequest(BaseModel):
    pin: str
    current_pin: Optional[str] = None   # required if a PIN is already set


class PinVerifyRequest(BaseModel):
    pin: str


@router.get("/system/pin/status")
def pin_status():
    cfg = S.load_pin_config()
    return {"enabled": cfg["enabled"]}


@router.post("/system/pin/set")
def pin_set(body: PinSetRequest):
    pin = (body.pin or "").strip()
    if not (4 <= len(pin) <= 32):
        raise HTTPException(status_code=400, detail="PIN must be 4–32 characters.")

    cfg = S.load_pin_config()
    if cfg["enabled"]:
        current = (body.current_pin or "").strip()
        if not current:
            raise HTTPException(status_code=403, detail="Current PIN required to change PIN.")
        if _hash_pin(current, cfg["salt"]) != cfg["hash"]:
            raise HTTPException(status_code=403, detail="Current PIN is incorrect.")

    salt = secrets.token_hex(32)
    pin_hash = _hash_pin(pin, salt)
    S.save_pin_config(pin_hash, salt)
    S.log_debug("pin", "INFO", "PIN set/changed")
    return {"ok": True}


@router.post("/system/pin/verify")
def pin_verify(body: PinVerifyRequest, response: Response):
    cfg = S.load_pin_config()
    if not cfg["enabled"]:
        return {"ok": True, "note": "No PIN set — access open."}
    pin = (body.pin or "").strip()
    if _hash_pin(pin, cfg["salt"]) != cfg["hash"]:
        raise HTTPException(status_code=403, detail="Incorrect PIN.")
    token = S.create_session_token("local")
    response.set_cookie(
        key="tli_session",
        value=token,
        max_age=S.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        path="/",
        secure=S.TLS_ENABLED,
    )
    return {"ok": True}


@router.post("/system/pin/remove")
def pin_remove(body: PinVerifyRequest, response: Response):
    cfg = S.load_pin_config()
    if not cfg["enabled"]:
        return {"ok": True, "note": "No PIN was set."}
    pin = (body.pin or "").strip()
    if _hash_pin(pin, cfg["salt"]) != cfg["hash"]:
        raise HTTPException(status_code=403, detail="Incorrect PIN.")
    S.clear_pin_config()
    S.revoke_all_sessions()
    response.delete_cookie("tli_session", path="/")
    S.log_debug("pin", "INFO", "PIN removed, all sessions revoked")
    return {"ok": True}


@router.post("/system/pin/lock")
def pin_lock(request: Request, response: Response, _session: str = Depends(require_session)):
    """Lock only this authenticated browser, leaving other clients connected."""
    if request.headers.get("authorization") is not None:
        raise HTTPException(403, "Lock the browser from its TLI page; Companion credentials are unchanged.")
    token = request.cookies.get("tli_session")
    if not token or not S.validate_session_token(token):
        raise HTTPException(401, "A valid browser session is required. Unlock with the PIN.")
    if not S.load_pin_config()["enabled"]:
        raise HTTPException(409, "No PIN is enabled. Set a PIN in Settings before locking TLI.")
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin != str(request.base_url).rstrip("/")):
        raise HTTPException(403, "Lock the browser from its TLI page.")
    S.revoke_session_token(token)
    response.delete_cookie("tli_session", path="/", httponly=True, samesite="strict", secure=S.TLS_ENABLED)
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "locked": True}


@router.post("/system/pin/emergency-reset")
def pin_emergency_reset(response: Response, _session: str = Depends(require_session)):
    """Remove a readable PIN using an existing authenticated session."""
    S.load_pin_config()  # Must also fail closed when a dependency is overridden.
    S.clear_pin_config()
    S.revoke_all_sessions()
    response.delete_cookie("tli_session", path="/")
    S.log_debug("pin", "WARN", "Authenticated PIN reset performed")
    return {"ok": True, "note": "PIN cleared. All sessions revoked."}


# ── Onboarding endpoints ──────────────────────────────────────

_ONBOARDING_COMPLETE_FILE = Path(S.DATA_DIR) / "onboarding_complete.json"


@router.get("/system/onboarding/status")
def onboarding_status():
    """Returns complete=true if onboarding has been finished OR a PIN is already set (existing users)."""
    if _ONBOARDING_COMPLETE_FILE.exists():
        return {"complete": True}
    cfg = S.load_pin_config()
    if cfg["enabled"]:
        # Existing user — mark complete silently so they never see the wizard
        _ONBOARDING_COMPLETE_FILE.write_text(json.dumps({"completed_at": S.now_iso()}), encoding="utf-8")
        return {"complete": True}
    return {"complete": False}


@router.post("/system/onboarding/complete")
def onboarding_complete(_session: str = Depends(require_session)):
    """Mark onboarding as finished. No auth required — called at wizard completion."""
    _ONBOARDING_COMPLETE_FILE.write_text(json.dumps({"completed_at": S.now_iso()}), encoding="utf-8")
    return {"ok": True}


class NodeNameRequest(BaseModel):
    name: str


@router.post("/system/node/name")
def set_node_name(body: NodeNameRequest, _session: str = Depends(require_session)):
    """Update the node's display name (used in mesh and dashboard)."""
    name = (body.name or "").strip()[:48] or "TLI Node"
    cfg = S.load_node_config()
    cfg.node_name = name
    cfg.updated_at = S.now_iso()
    S.save_node_config(cfg)
    S.log_debug("system", "INFO", "Node name updated", name=name)
    return {"ok": True, "node_name": name}


class LMStudioTestRequest(BaseModel):
    url: str


@router.post("/system/lm_studio/test")
def lm_studio_test(body: LMStudioTestRequest, _session: str = Depends(require_session)):
    """Test if an LM Studio endpoint is reachable. Returns models list on success."""
    raw_url = (body.url or "").strip().rstrip("/")
    if not raw_url:
        raise HTTPException(status_code=400, detail="URL is required.")
    # Derive models URL: replace /chat/completions suffix if present
    if raw_url.endswith("/chat/completions"):
        models_url = raw_url[: -len("/chat/completions")] + "/models"
    elif raw_url.endswith("/completions"):
        models_url = raw_url[: -len("/completions")] + "/models"
    else:
        models_url = raw_url.rstrip("/") + "/models"
    try:
        r = requests.get(models_url, timeout=(S.HTTP_CONNECT_TIMEOUT, 4))
        if r.status_code == 200:
            data = r.json()
            models = [m.get("id", "") for m in data.get("data", [])]
            return {"ok": True, "models": models, "count": len(models)}
        return {"ok": False, "error": f"Server returned {r.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class LMStudioUrlRequest(BaseModel):
    url: str


@router.post("/system/lm_studio/url")
def set_lm_studio_url(body: LMStudioUrlRequest, _session: str = Depends(require_session)):
    """Persist a new LM Studio URL and update the live provider."""
    raw_url = (body.url or "").strip().rstrip("/")
    if not raw_url:
        raise HTTPException(status_code=400, detail="URL is required.")
    # Normalise to chat endpoint
    if not raw_url.endswith("/chat/completions"):
        if raw_url.endswith("/v1"):
            raw_url = raw_url + "/chat/completions"
        elif "/v1/" not in raw_url:
            raw_url = raw_url.rstrip("/") + "/v1/chat/completions"
    models_url = raw_url[: raw_url.rfind("/chat/completions")] + "/models"
    # Save to disk
    cfg_path = Path(S.DATA_DIR) / "lm_studio_config.json"
    cfg_path.write_text(json.dumps({"chat_url": raw_url, "models_url": models_url}), encoding="utf-8")
    # Update live state
    S.LM_STUDIO_URL = raw_url
    S.LM_STUDIO_MODELS_URL = models_url
    if S.lm_provider is not None:
        S.lm_provider.chat_url = raw_url
        S.lm_provider.models_url = models_url
    S.log_debug("system", "INFO", "LM Studio URL updated", chat_url=raw_url)
    return {"ok": True, "chat_url": raw_url, "models_url": models_url}


# ── Setup autodetect ─────────────────────────────────────────

_LM_PROBE_PORTS = [
    ("LM Studio",  "http://localhost:1234/v1/models",     "http://localhost:1234/v1/chat/completions"),
    ("Ollama",     "http://localhost:11434/api/tags",      "http://localhost:11434/v1/chat/completions"),
    ("LM Studio",  "http://localhost:8080/v1/models",      "http://localhost:8080/v1/chat/completions"),
    ("LM Studio",  "http://localhost:5000/v1/models",      "http://localhost:5000/v1/chat/completions"),
]


def _probe_lm(probe_url: str, chat_url: str, label: str):
    """Return (chat_url, label, models) if probe_url responds, else None."""
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


def _get_lan_ip() -> str:
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


@router.get("/setup/autodetect")
def setup_autodetect():
    """
    First-run autodetect.  Probes common local AI endpoints concurrently and
    counts known Shelly devices.  Fast (<3 s) — all timeouts are short.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    ai_found = None
    with ThreadPoolExecutor(max_workers=len(_LM_PROBE_PORTS)) as pool:
        futs = {pool.submit(_probe_lm, probe, chat, lbl): (probe, chat, lbl)
                for lbl, probe, chat in _LM_PROBE_PORTS}
        for fut in as_completed(futs, timeout=4):
            result = fut.result()
            if result and not ai_found:
                ai_found = result
                break  # first hit wins

    shelly_devices = S.load_shelly_registry()
    node_cfg = S.load_node_config()
    lan_ip = _get_lan_ip()

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
            "name":    node_cfg.node_name,
            "node_id": node_cfg.node_id,
            "role":    node_cfg.role,
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
def get_alerts():
    """Return all active (non-dismissed) alerts."""
    alerts = S.load_alerts()
    active = [a for a in alerts if not a.get("dismissed")]
    return {"alerts": active, "count": len(active)}


@router.post("/status/alerts/{alert_id}/dismiss")
def dismiss_alert(alert_id: str, _session=Depends(require_session)):
    found = S.dismiss_alert(alert_id)
    if not found:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"ok": True, "dismissed": alert_id}


@router.post("/status/alerts/dismiss-all")
def dismiss_all_alerts(_session=Depends(require_session)):
    alerts = S.load_alerts()
    count = 0
    for a in alerts:
        if not a.get("dismissed"):
            a["dismissed"] = True
            count += 1
    S.save_alerts(alerts)
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
