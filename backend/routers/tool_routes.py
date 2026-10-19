# backend/routers/tool_routes.py
from __future__ import annotations

import json
import os
import platform
import ipaddress
import re
import subprocess
import sys
from collections.abc import Callable
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import tli_state as S
from process_utils import hidden_process_kwargs
from browser_authority import browser_control_access
from script_sources import list_tool_metadata, read_tool_source

try:
    import psutil
except Exception:
    psutil = None

router = APIRouter(tags=["tools"])


# ============================================
#  Legacy saved source is read-only; scripts are never host tools.
# ============================================

def list_tools():
    return list_tool_metadata()


SCRIPT_RETIRED = (
    "Host script execution is unavailable. Saved source files were preserved. "
    "Use Scripts to draft code or view and export saved source; built-in diagnostics remain available."
)


# ============================================
#  Subprocess helper
# ============================================

def _run_subprocess(cmd, timeout=20):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, shell=False,
                              **hidden_process_kwargs())
        return {"ok": proc.returncode == 0, "returncode": proc.returncode,
                "stdout": proc.stdout, "stderr": proc.stderr}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ============================================
#  Built-in tools
# ============================================

def builtin_sys_snapshot(params=None):
    info = {"timestamp": S.now_iso(), "hostname": platform.node(), "os": platform.platform(),
            "python_version": sys.version.split()[0], "cpu_count": os.cpu_count()}
    if psutil:
        try:
            vm = psutil.virtual_memory()
            info["memory"] = {"total_gb": round(vm.total/(1024**3),2), "used_gb": round(vm.used/(1024**3),2),
                              "free_gb": round(vm.available/(1024**3),2), "percent_used": vm.percent}
        except Exception:
            pass
        try:
            disks = []
            for part in psutil.disk_partitions(all=False):
                try:
                    usage = psutil.disk_usage(part.mountpoint)
                except PermissionError:
                    continue
                disks.append({"device": part.device, "mountpoint": part.mountpoint, "fstype": part.fstype,
                              "total_gb": round(usage.total/(1024**3),2), "used_gb": round(usage.used/(1024**3),2),
                              "free_gb": round(usage.free/(1024**3),2), "percent_used": usage.percent})
            info["disks"] = disks
        except Exception:
            pass
    return info

def builtin_sys_top_processes(params=None):
    if not psutil:
        return {"error": "psutil not installed"}
    limit = 10
    if isinstance(params, dict) and "limit" in params:
        try: limit = max(1, int(params["limit"]))
        except Exception: pass
    procs = []
    for p in psutil.process_iter(attrs=["pid", "name", "username", "memory_info"]):
        try:
            mem = p.info.get("memory_info")
            rss = getattr(mem, "rss", 0) if mem else 0
            procs.append({"pid": p.info.get("pid"), "name": p.info.get("name"),
                          "memory_mb": round(rss/(1024**2), 2)})
        except Exception:
            continue
    procs.sort(key=lambda x: x.get("memory_mb", 0), reverse=True)
    return {"timestamp": S.now_iso(), "top_processes": procs[:limit]}

def builtin_disk_overview(params=None):
    info = {"timestamp": S.now_iso(), "disks": []}
    if not psutil:
        info["note"] = "Install psutil for details"
        return info
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except PermissionError:
            continue
        info["disks"].append({"device": part.device, "mountpoint": part.mountpoint,
                              "total_gb": round(usage.total/(1024**3),2), "free_gb": round(usage.free/(1024**3),2),
                              "percent_used": usage.percent})
    return info

def builtin_net_snapshot(params=None):
    result = {"timestamp": S.now_iso(), "platform": platform.system()}
    if psutil:
        try:
            if_addrs = psutil.net_if_addrs()
            if_stats = psutil.net_if_stats()
            iface_info = {}
            for name, addrs in if_addrs.items():
                entry = {"is_up": bool(if_stats.get(name).isup) if name in if_stats else None, "addresses": []}
                for addr in addrs:
                    entry["addresses"].append({"family": str(addr.family), "address": addr.address,
                                               "netmask": addr.netmask, "broadcast": addr.broadcast})
                iface_info[name] = entry
            result["interfaces"] = iface_info
            return result
        except Exception:
            pass
    cmd = ["ipconfig"] if platform.system().lower().startswith("win") else ["ifconfig"]
    res = _run_subprocess(cmd, timeout=15)
    result["raw_output"] = res.get("stdout") or res.get("stderr", "")
    return result

def builtin_net_connectivity_diag(params=None, *, check=None):
    hosts = ["127.0.0.1", "8.8.8.8", "1.1.1.1"]
    if isinstance(params, dict) and isinstance(params.get("hosts"), list):
        hosts = [str(h) for h in params["hosts"]]
    tests = []
    for host in hosts:
        if check is not None:
            check()
        is_win = platform.system().lower().startswith("win")
        cmd = ["ping", "-n" if is_win else "-c", "2", host]
        res = _run_subprocess(cmd, timeout=8)
        tests.append({"host": host, "ok": res.get("ok", False)})
    return {"timestamp": S.now_iso(), "tests": tests}

def builtin_model_health(params=None):
    info = {"timestamp": S.now_iso(), "endpoint": S.LM_STUDIO_URL}
    try:
        r = requests.get(S.LM_STUDIO_MODELS_URL, timeout=(S.HTTP_CONNECT_TIMEOUT, 4))
        info["http_status"] = r.status_code
        if r.status_code == 200:
            info["models"] = r.json().get("data") or []
        else:
            info["error"] = f"HTTP {r.status_code}"
    except Exception as e:
        info["error"] = str(e)
    return info

def builtin_tli_env_check(params=None):
    paths = {"BASE_DIR": S.BASE_DIR, "DATA_DIR": S.DATA_DIR, "FRONTEND_DIR": S.FRONTEND_DIR, "VAULT_DIR": S.VAULT_DIR}
    return {"timestamp": S.now_iso(), "platform": platform.platform(), "python_version": sys.version,
            "paths": {name: {"path": p, "exists": os.path.exists(p)} for name, p in paths.items()},
            "lm_studio_url": S.LM_STUDIO_URL}


BUILTIN_TOOLS = {
    "sys_snapshot":         {"id": "sys_snapshot",         "label": "System Snapshot",      "handler": builtin_sys_snapshot},
    "sys_top_processes":    {"id": "sys_top_processes",    "label": "Top Processes",        "handler": builtin_sys_top_processes},
    "disk_overview":        {"id": "disk_overview",        "label": "Disk Overview",        "handler": builtin_disk_overview},
    "net_snapshot":         {"id": "net_snapshot",         "label": "Network Snapshot",     "handler": builtin_net_snapshot},
    "net_connectivity_diag":{"id": "net_connectivity_diag","label": "Connectivity Check",   "handler": builtin_net_connectivity_diag},
    "model_health":         {"id": "model_health",         "label": "Model Health",         "handler": builtin_model_health},
    "tli_env_check":        {"id": "tli_env_check",        "label": "TLI Environment Check","handler": builtin_tli_env_check},
}


# ============================================
#  Models & Endpoints
# ============================================

class SimpleToolRunRequest(BaseModel):
    tool_id: str = Field(min_length=1, max_length=128)
    params: Optional[Dict[str, Any]] = None


@router.post("/tools/generate_script")
def generate_script_endpoint(check: Callable[[], None] = Depends(browser_control_access)):
    check()
    raise HTTPException(410, "The legacy script-file generator is retired. Use the Scripts drafting panel; existing source and registry files were preserved.", headers={"Cache-Control": "no-store"})

@router.get("/tools/list_scripts")
def list_scripts_endpoint(check: Callable[[], None] = Depends(browser_control_access)):
    check()
    result = list_tools()
    check()
    return {"tools": result}


@router.get("/tools/scripts/{tool_id}/source")
def tool_source_endpoint(tool_id: str, check: Callable[[], None] = Depends(browser_control_access)):
    return read_tool_source(tool_id, check)

@router.delete("/tools/delete_script/{tool_id}")
def delete_script_endpoint(tool_id: str, check: Callable[[], None] = Depends(browser_control_access)):
    check()
    raise HTTPException(410, "Legacy script deletion is retired. Existing source and registry files were preserved; view or export the source instead.", headers={"Cache-Control": "no-store"})

@router.get("/tools/list")
def tools_list_for_ui(check: Callable[[], None] = Depends(browser_control_access)):
    check()
    builtin_ui = [{"id": tid, "label": meta.get("label") or tid, "kind": "builtin", "executable": True} for tid, meta in BUILTIN_TOOLS.items()]
    saved = list_tools()
    if any(t["id"] in BUILTIN_TOOLS for t in saved):
        raise HTTPException(503, "The saved tool registry conflicts with a built-in identifier. It was preserved; review the original file before continuing.")
    script_ui = [{"id": t["id"], "label": t.get("name") or t["id"], "kind": "script", "executable": False, "unavailable_reason": SCRIPT_RETIRED} for t in saved]
    check()
    return {"tools": builtin_ui + script_ui}


def _tool_params(tool_id: str, params: dict | None) -> dict:
    params = params or {}
    allowed = {"limit"} if tool_id == "sys_top_processes" else {"hosts"} if tool_id == "net_connectivity_diag" else set()
    if set(params) - allowed:
        raise HTTPException(422, "This built-in tool received unsupported parameters.")
    if tool_id == "sys_top_processes":
        limit = params.get("limit", 10)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(422, "Choose from 1 to 100 processes.")
        return {"limit": limit}
    if tool_id == "net_connectivity_diag":
        hosts = params.get("hosts", ["127.0.0.1", "8.8.8.8", "1.1.1.1"])
        if not isinstance(hosts, list) or not 1 <= len(hosts) <= 10:
            raise HTTPException(422, "Choose from 1 to 10 hostnames or IP addresses.")
        for host in hosts:
            if not isinstance(host, str) or not 1 <= len(host) <= 253:
                raise HTTPException(422, "Each target must be a hostname or IP address.")
            try:
                ipaddress.ip_address(host)
            except ValueError:
                if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?", host):
                    raise HTTPException(422, "Each target must be a hostname or IP address, without command options or a URL.")
        return {"hosts": list(hosts)}
    return {}


@router.post("/tools/run")
def tools_run_for_ui(req: SimpleToolRunRequest, check: Callable[[], None] = Depends(browser_control_access)):
    return run_builtin_tool(req.tool_id, req.params, check)


def run_builtin_tool(tool_id: str, params: dict | None, check: Callable[[], None]):
    """Shared explicit built-in dispatch; callers must carry captured authority."""
    check()
    if tool_id not in BUILTIN_TOOLS:
        raise HTTPException(410, SCRIPT_RETIRED, headers={"Cache-Control": "no-store"})
    params = _tool_params(tool_id, params)
    handler = BUILTIN_TOOLS[tool_id].get("handler")
    if not callable(handler):
        raise HTTPException(500, "Builtin tool handler not callable")
    check()
    try:
        result = handler(params, check=check) if tool_id == "net_connectivity_diag" else handler(params)
    except HTTPException:
        raise
    except Exception:
        check()
        raise HTTPException(503, "The built-in diagnostic could not complete. No automatic retry was made.") from None
    check()
    output_text = result if isinstance(result, str) else json.dumps(result, indent=2, default=str)
    return {"output": output_text, "exit_code": 0}
