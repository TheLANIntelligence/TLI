# backend/routers/tool_routes.py
from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from enum import Enum

import tli_state as S
from process_utils import hidden_process_kwargs
from routers.system_routes import require_session

try:
    import psutil
except Exception:
    psutil = None

router = APIRouter(tags=["tools"])


# ============================================
#  Tool registry (disk-backed)
# ============================================

def _load_tools():
    return S.load_json_file(S.TOOLS_INDEX_PATH, {})

def _save_tools(tools):
    S.save_json_file(S.TOOLS_INDEX_PATH, tools)

def register_tool(tool_id, name, language, script_path, task_description):
    tools = _load_tools()
    tools[tool_id] = {"id": tool_id, "name": name, "language": language,
                      "script_path": script_path, "task_description": task_description,
                      "created_at": S.now_iso()}
    _save_tools(tools)

def list_tools():
    return list(_load_tools().values())

def get_tool(tool_id):
    return _load_tools().get(tool_id)

def delete_tool(tool_id):
    tools = _load_tools()
    tool = tools.pop(tool_id, None)
    _save_tools(tools)
    if tool and tool.get("script_path"):
        try:
            Path(tool["script_path"]).unlink(missing_ok=True)
        except Exception:
            pass
    return tool


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

def builtin_net_connectivity_diag(params=None):
    hosts = ["127.0.0.1", "8.8.8.8", "1.1.1.1"]
    if isinstance(params, dict) and isinstance(params.get("hosts"), list):
        hosts = [str(h) for h in params["hosts"]]
    tests = []
    for host in hosts:
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

class ScriptLanguage(str, Enum):
    bat = "bat"; ps1 = "ps1"; py = "py"

class GenerateScriptRequest(BaseModel):
    task_description: str
    language: ScriptLanguage = ScriptLanguage.bat
    script_name: Optional[str] = None

class GenerateScriptResponse(BaseModel):
    id: str; name: str; language: str; path: str; contents: str

class SimpleToolRunRequest(BaseModel):
    tool_id: str
    params: Optional[Dict[str, Any]] = None


def generate_script_with_llm(task_description, language="bat"):
    payload = {
        "model": S.MODEL_CONFIG.get("qwen", S.MODEL_CONFIG[S.DEFAULT_MODEL_KEY])["id"],
        "messages": [
            {"role": "system", "content": f"You generate ONLY valid {language} scripts. Add comments. No prose outside the script."},
            {"role": "user", "content": f'Create a {language} script for: """{task_description}"""'},
        ],
        "temperature": 0.2, "max_tokens": 1200,
    }
    try:
        resp = requests.post(S.LM_STUDIO_URL, json=payload, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT_GEN))
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f":: Script generation failed: {e}\n:: Task: {task_description}\n"


@router.post("/tools/generate_script", response_model=GenerateScriptResponse)
async def generate_script_endpoint(req: GenerateScriptRequest, _session=Depends(require_session)):
    script_id = str(uuid.uuid4())
    language = req.language.value
    ext = {"bat": ".bat", "ps1": ".ps1", "py": ".py"}[language]
    raw_name = req.script_name or f"tool_{language}_{script_id[:8]}"
    name = re.sub(r"[^a-zA-Z0-9_-]", "_", raw_name.strip()) or f"tool_{language}_{script_id[:8]}"
    script_path = S.SCRIPTS_DIR / f"{name}{ext}"
    script_code = generate_script_with_llm(req.task_description, language=language)
    with script_path.open("w", encoding="utf-8") as f:
        f.write(script_code)
    register_tool(script_id, name, language, str(script_path), req.task_description)
    return GenerateScriptResponse(id=script_id, name=name, language=language, path=str(script_path), contents=script_code)

@router.get("/tools/list_scripts")
async def list_scripts_endpoint():
    return {"tools": list_tools()}

@router.delete("/tools/delete_script/{tool_id}")
async def delete_script_endpoint(tool_id: str, _session=Depends(require_session)):
    tool = delete_tool(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    return {"status": "deleted", "tool": tool}

@router.get("/tools/list")
async def tools_list_for_ui():
    builtin_ui = [{"id": tid, "label": meta.get("label") or tid} for tid, meta in BUILTIN_TOOLS.items()]
    script_ui = [{"id": t["id"], "label": t.get("name") or t["id"]} for t in list_tools()]
    return {"tools": builtin_ui + script_ui}


def _powershell_command():
    if platform.system().lower().startswith("win"):
        return ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File"]
    return ["pwsh", "-NoLogo", "-NoProfile", "-File"]


@router.post("/tools/run")
async def tools_run_for_ui(req: SimpleToolRunRequest, _session=Depends(require_session)):
    if req.tool_id in BUILTIN_TOOLS:
        handler = BUILTIN_TOOLS[req.tool_id].get("handler")
        if not callable(handler):
            raise HTTPException(status_code=500, detail="Builtin tool handler not callable")
        try:
            result = handler(req.params or {})
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Builtin tool error: {e}")
        output_text = result if isinstance(result, str) else json.dumps(result, indent=2, default=str)
        return {"output": output_text, "exit_code": 0}

    tool = get_tool(req.tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    script_path = Path(tool["script_path"])
    if not script_path.exists():
        raise HTTPException(status_code=404, detail="Script file missing on disk")
    language = tool["language"]
    if language == "bat":
        if not platform.system().lower().startswith("win"):
            raise HTTPException(status_code=400, detail=".bat not supported on non-Windows")
        cmd = ["cmd.exe", "/c", str(script_path)]
    elif language == "ps1":
        cmd = _powershell_command() + [str(script_path)]
    elif language == "py":
        cmd = [sys.executable or "python", str(script_path)]
    else:
        raise HTTPException(status_code=400, detail="Unsupported script language")
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(S.SCRIPTS_DIR), shell=False,
                          **hidden_process_kwargs())
    output = proc.stdout.strip() or proc.stderr.strip() or f"Exit code {proc.returncode}"
    return {"output": output, "exit_code": proc.returncode}
