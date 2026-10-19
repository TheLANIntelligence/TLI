"""
TLI Self-Diagnostic System

run_full_diagnostic(base_url, ...)  → full health report (all subsystems)
run_startup_check(base_url, ...)    → lightweight check (AI runtime + model file only)

Report format:
  {"healthy": bool, "checks": [{"name": str, "ok": bool, "detail": str, "ms": int}]}
"""

from __future__ import annotations

import json
import time
import requests
from fastapi import HTTPException
from pathlib import Path
from typing import Any, Dict, List, Optional


# ==================================================================
#  Internal check runner
# ==================================================================

def _check(name: str, fn, check=None) -> Dict[str, Any]:
    t0 = time.time()
    if check is not None:
        check()
    try:
        ok, detail = fn()
        if check is not None:
            check()
        return {"name": name, "ok": bool(ok), "detail": str(detail), "ms": int((time.time() - t0) * 1000)}
    except HTTPException:
        raise
    except Exception as e:
        if check is not None:
            check()
        return {"name": name, "ok": False, "detail": str(e)[:200], "ms": int((time.time() - t0) * 1000)}


# ==================================================================
#  Full diagnostic
# ==================================================================

def run_full_diagnostic(
    base_url: str,
    shelly_registry: Optional[List[Dict]] = None,
    model_path: Optional[Path] = None,
    conversations_path: Optional[Path] = None,
    check=None,
) -> Dict[str, Any]:
    """
    Run all system health checks and return a structured report.
    """
    base = base_url.rstrip("/") + "/"
    checks: List[Dict[str, Any]] = []

    # 1. AI Runtime (llama.cpp server)
    def _check_ai():
        r = requests.get(base + "api/ai/bundled/status", timeout=3)
        if r.ok:
            data = r.json()
            if data.get("healthy"):
                return True, data.get("active_model") or "running"
            return False, data.get("reason") or "not healthy"
        return False, f"HTTP {r.status_code}"

    checks.append(_check("AI Runtime", _check_ai, check))

    # 2. Model file on disk
    def _check_model():
        if model_path is None:
            return True, "Path not configured"
        if model_path.exists():
            size_mb = model_path.stat().st_size // (1024 * 1024)
            return True, f"Present ({size_mb} MB)"
        return False, "Model file not found"

    checks.append(_check("Model File", _check_model, check))

    # 3. Shelly devices — direct ping (2s timeout)
    for dev in (shelly_registry or []):
        if not isinstance(dev, dict):
            continue
        ip = dev.get("ip", "")
        name = dev.get("name") or ip
        if not ip:
            continue

        def _check_shelly(ip=ip):
            r = requests.get(f"http://{ip}/rpc/Switch.GetStatus?id=0", timeout=2)
            if r.ok:
                return True, "Reachable"
            return False, f"HTTP {r.status_code}"

        checks.append(_check(f"{name} ({ip})", _check_shelly, check))

    # 4. Explicit built-in service with the initiating browser's authority.
    def _check_tools():
        if not callable(check):
            return False, "Run this check from an authorized TLI browser."
        from routers.tool_routes import run_builtin_tool
        run_builtin_tool("sys_snapshot", None, check)
        return True, "Responding"

    checks.append(_check("Tools Endpoint", _check_tools, check))

    # 5. Conversation store
    def _check_conversations():
        if conversations_path is None:
            return True, "Path not configured"
        if not conversations_path.exists():
            return True, "Not yet created"
        text = conversations_path.read_text(encoding="utf-8")
        json.loads(text)
        return True, "Readable"

    checks.append(_check("Conversation Store", _check_conversations, check))

    all_ok = all(c["ok"] for c in checks)
    if check is not None:
        check()
    return {"healthy": all_ok, "checks": checks}


# ==================================================================
#  Lightweight startup check
# ==================================================================

def run_startup_check(
    base_url: str,
    model_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """AI runtime + model file only. Called on startup (non-blocking)."""
    base = base_url.rstrip("/") + "/"
    checks: List[Dict[str, Any]] = []

    def _check_ai():
        r = requests.get(base + "api/ai/bundled/status", timeout=3)
        if r.ok:
            data = r.json()
            if data.get("healthy"):
                return True, data.get("active_model") or "running"
            return False, data.get("reason") or "not healthy"
        return False, f"HTTP {r.status_code}"

    checks.append(_check("AI Runtime", _check_ai))

    def _check_model():
        if model_path is None:
            return True, "Path not configured"
        if model_path.exists():
            return True, "Present"
        return False, "Not found"

    checks.append(_check("Model File", _check_model))

    return {"healthy": all(c["ok"] for c in checks), "checks": checks}
