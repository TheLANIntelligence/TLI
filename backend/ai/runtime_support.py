"""Bounded local runtime inspection. Never downloads or replaces a runtime."""
import os
import re
import subprocess
import threading
import time
from functools import lru_cache
from pathlib import Path

_LOCK = threading.Lock()
FLAGS = ("--jinja", "--chat-template-kwargs", "--reasoning-budget", "--reasoning-format")


def runtime_info(path):
    try:
        path = Path(path).resolve()
        stat = path.stat()
        # The minute bucket also permits retry after a repaired DLL/environment.
        with _LOCK:
            return dict(_inspect(str(path), stat.st_mtime_ns, stat.st_size, int(time.monotonic() // 60)))
    except OSError:
        return {"build": None, "flags": None, "reason": "Runtime is missing or unreadable."}


@lru_cache(maxsize=8)
def _inspect(path, mtime, size, minute):
    def run(flag):
        result = subprocess.run([path, flag], cwd=str(Path(path).parent), capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=3,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if result.returncode:
            raise ValueError("Runtime inspection failed")
        return result.stdout + "\n" + result.stderr
    try:
        version = run("--version")
        match = re.search(r"\bversion:\s*b?(\d+)\b", version, re.IGNORECASE)
        help_text = run("--help")
        return {"build": int(match[1]) if match else None,
                "flags": [flag for flag in FLAGS if re.search(re.escape(flag) + r"(?=[\s,])", help_text)],
                "reason": "" if match else "Runtime build could not be identified."}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {"build": None, "flags": None, "reason": "Runtime inspection failed or timed out. Recheck after repairing the runtime."}


def support(preset, runtime):
    if not preset.get("min_runtime_build"):
        return {"state": "not_required", "build": None, "reason": ""}
    info = runtime_info(runtime)
    minimum = preset["min_runtime_build"]
    if info["build"] is not None and info["build"] < minimum:
        return {**info, "state": "unsupported", "reason": f"Needs llama.cpp build {minimum} or newer; this host has build {info['build']}."}
    if info["flags"] is not None and not set(preset["required_runtime_flags"]).issubset(info["flags"]):
        return {**info, "state": "unsupported", "reason": "This runtime lacks the controls TLI needs for Qwen3 non-thinking mode."}
    if info["build"] is None or info["flags"] is None:
        return {**info, "state": "unknown"}
    return {**info, "state": "supported", "reason": f"Runtime build {info['build']} has the required Qwen3 controls."}
