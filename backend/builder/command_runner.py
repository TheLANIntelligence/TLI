from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

from .safety import classify_command, is_within_root


def run_approved_command(
    project_root: Path,
    command: str,
    cwd: str = "",
    approved: bool = False,
    allow_network: bool = False,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    if not approved:
        raise ValueError("Command execution requires explicit approval.")
    safety = classify_command(command)
    if safety["blocked"]:
        raise ValueError("Dangerous command blocked: " + ", ".join(safety["dangerous_matches"]))
    if safety["requires_network_warning"] and not allow_network:
        raise ValueError("Command may contact the internet. Enable network approval to run it.")

    workdir = (project_root / cwd).resolve() if cwd else project_root.resolve()
    if not workdir.exists() or not workdir.is_dir() or not is_within_root(project_root, workdir):
        raise ValueError("Command working directory must stay inside the selected project root.")

    timeout = max(1, min(int(timeout_seconds), 600))
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=str(workdir),
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        timed_out = False
        stdout = completed.stdout
        stderr = completed.stderr
        exit_code = completed.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        exit_code = 124

    runtime_ms = int((time.monotonic() - started) * 1000)
    return {
        "command": safety["command"],
        "cwd": str(workdir),
        "exit_code": exit_code,
        "stdout": truncate(stdout),
        "stderr": truncate(stderr),
        "runtime_ms": runtime_ms,
        "timed_out": timed_out,
        "requires_network_warning": safety["requires_network_warning"],
        "approved": approved,
    }


def truncate(text: str, max_chars: int = 20000) -> str:
    if text is None:
        return ""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n...[truncated]..."

