from __future__ import annotations

import math
import time
import os
import tempfile
import json
from collections import deque
from typing import List, Optional, Dict, Any

import psutil
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

import tli_state as S
from routers.system_routes import require_session

router = APIRouter()

NODE_START_TIME = time.time()

# Cache for /agent/system_summary — psutil.cpu_percent(interval=0.3) blocks the
# uvicorn worker for 300 ms; caching prevents that from stacking up under rapid polls.
_summary_cache: dict = {"result": None, "ts": 0.0}
_SUMMARY_TTL = 30.0  # seconds

# Use the canonical data directory from tli_state (respects TLI_ROOT env var)
DATA_DIR = S.DATA_DIR
os.makedirs(DATA_DIR, exist_ok=True)

# Shared debug log file used by the backend
DEBUG_LOG_PATH = os.path.join(DATA_DIR, "debug_log.jsonl")

# TLI-specific cache folder (safe to clean)
TLI_CACHE_DIR = os.path.join(DATA_DIR, "cache")
os.makedirs(TLI_CACHE_DIR, exist_ok=True)


def _bytes_to_human(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    if n <= 0:
        return "0 B"
    idx = min(int(math.log(n, 1024)), len(units) - 1)
    return f"{n / (1024 ** idx):.1f} {units[idx]}"


# ---------- MODELS ----------

class DiskPartitionUsage(BaseModel):
    device: str
    mountpoint: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    percent_used: float
    total_human: str
    used_human: str
    free_human: str


class DiskUsageResponse(BaseModel):
    overall_percent_used: float
    partitions: List[DiskPartitionUsage]


class CPUUsageResponse(BaseModel):
    percent: float
    per_core: Optional[List[float]] = None


class RAMUsageResponse(BaseModel):
    total_bytes: int
    used_bytes: int
    available_bytes: int
    percent_used: float
    total_human: str
    used_human: str
    available_human: str


class UptimeResponse(BaseModel):
    seconds: int
    human_readable: str


class AgentTaskRunRequest(BaseModel):
    """
    Request body for /agent/tasks/run.

    Only whitelisted task_id values are allowed:
      - 'refresh_status'
      - 'clean_temp'
      - 'rotate_logs'
    """
    task_id: str


# ---------- INTERNAL HELPERS (V0.3) ----------

def _safe_clean_dir(path: str, allow_subdirs: bool = False, max_files: int = 5000) -> Dict[str, Any]:
    """
    Safely clean a directory:

    - Deletes regular files directly under `path`.
    - Optionally removes empty subdirectories when allow_subdirs=True.
    - Does NOT recursively descend into nested directories (no deep nukes).
    - Enforces a max_files limit per directory.
    """
    summary: Dict[str, Any] = {
        "path": path,
        "files_deleted": 0,
        "bytes_reclaimed": 0,
        "errors": [],
    }

    if not os.path.isdir(path):
        # Nothing to clean; this is not an error for maintenance purposes.
        return summary

    try:
        entries = list(os.scandir(path))
    except Exception as e:
        summary["errors"].append(f"Failed to list directory: {e!r}")
        return summary

    count = 0
    for entry in entries:
        if count >= max_files:
            summary["errors"].append("Max file limit reached; stopped early.")
            break

        try:
            if entry.is_file(follow_symlinks=False):
                try:
                    size = entry.stat().st_size
                except Exception:
                    size = 0
                os.remove(entry.path)
                summary["files_deleted"] += 1
                summary["bytes_reclaimed"] += size
                count += 1

            elif entry.is_dir(follow_symlinks=False) and allow_subdirs:
                # Only attempt to remove if empty; no recursive deletion.
                try:
                    os.rmdir(entry.path)
                except OSError:
                    # Non-empty or in use; skip silently.
                    continue

        except Exception as e:
            summary["errors"].append(f"{entry.path}: {e!r}")

    return summary


def _clean_temp_internal() -> Dict[str, Any]:
    """
    Perform a safe temp cleanup on this node.

    - System temp directory (tempfile.gettempdir()) — files only.
    - TLI cache directory (TLI_CACHE_DIR) — files + empty subdirs only.

    No recursion, no user home folders, no arbitrary paths.
    """
    system_temp = tempfile.gettempdir()

    sys_report = _safe_clean_dir(system_temp, allow_subdirs=False, max_files=5000)
    cache_report = _safe_clean_dir(TLI_CACHE_DIR, allow_subdirs=True, max_files=5000)

    total_files = sys_report["files_deleted"] + cache_report["files_deleted"]
    total_bytes = sys_report["bytes_reclaimed"] + cache_report["bytes_reclaimed"]

    errors: List[str] = []
    errors.extend(sys_report.get("errors", []))
    errors.extend(cache_report.get("errors", []))

    return {
        "ok": True,
        "summary": {
            "total_files_deleted": total_files,
            "total_bytes_reclaimed": total_bytes,
            "total_bytes_reclaimed_human": _bytes_to_human(total_bytes),
            "directories": [sys_report, cache_report],
            "errors": errors,
        },
    }


def _tail_file(path: str, limit: int) -> List[str]:
    """
    Return the last `limit` lines (without trailing newlines) of `path`.

    If the file does not exist, returns [].
    """
    if limit <= 0:
        return []

    if not os.path.exists(path):
        return []

    dq: deque[str] = deque(maxlen=limit)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                dq.append(line.rstrip("\n"))
    except Exception:
        return []

    return list(dq)


def _task_refresh_status() -> Dict[str, Any]:
    """
    Whitelisted maintenance task: refresh system summary.
    """
    snapshot = get_system_summary()
    return {
        "snapshot": snapshot,
    }


def _task_clean_temp() -> Dict[str, Any]:
    """
    Whitelisted maintenance task: clean safe temp locations.
    """
    return _clean_temp_internal()


def _task_rotate_logs() -> Dict[str, Any]:
    """
    Whitelisted maintenance task: rotate debug_log.jsonl if it exceeds a threshold.

    - If file doesn't exist, this is a no-op.
    - If file is below threshold, no rotation is performed.
    """
    threshold_bytes = 5 * 1024 * 1024  # 5 MB
    path = DEBUG_LOG_PATH

    if not os.path.exists(path):
        return {
            "rotated": False,
            "reason": "log file does not exist",
        }

    try:
        size = os.path.getsize(path)
    except Exception as e:
        return {
            "rotated": False,
            "reason": f"could not get file size: {e!r}",
        }

    if size <= threshold_bytes:
        return {
            "rotated": False,
            "reason": "size below threshold",
            "size_bytes": size,
            "threshold_bytes": threshold_bytes,
        }

    backup_path = path + ".1"
    try:
        # Best-effort overwrite of previous backup
        if os.path.exists(backup_path):
            os.remove(backup_path)

        os.replace(path, backup_path)

        # Create a fresh empty log file
        with open(path, "w", encoding="utf-8") as f:
            f.write("")

        return {
            "rotated": True,
            "previous_size_bytes": size,
            "backup_path": backup_path,
            "threshold_bytes": threshold_bytes,
        }
    except Exception as e:
        return {
            "rotated": False,
            "reason": f"error during rotation: {e!r}",
        }


# Whitelisted task map for /agent/tasks/run
TASK_HANDLERS: Dict[str, Any] = {
    "refresh_status": _task_refresh_status,
    "clean_temp": _task_clean_temp,
    "rotate_logs": _task_rotate_logs,
}


# ---------- ENDPOINTS V0.2 ----------

@router.get("/agent/disk", response_model=DiskUsageResponse)
def get_disk_usage() -> DiskUsageResponse:
    partitions_data: List[DiskPartitionUsage] = []
    percents: List[float] = []
    for p in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(p.mountpoint)
        except PermissionError:
            continue
        part = DiskPartitionUsage(
            device=p.device,
            mountpoint=p.mountpoint,
            total_bytes=usage.total,
            used_bytes=usage.used,
            free_bytes=usage.free,
            percent_used=usage.percent,
            total_human=_bytes_to_human(usage.total),
            used_human=_bytes_to_human(usage.used),
            free_human=_bytes_to_human(usage.free),
        )
        partitions_data.append(part)
        percents.append(usage.percent)
    overall = sum(percents) / len(percents) if percents else 0.0
    return DiskUsageResponse(overall_percent_used=overall, partitions=partitions_data)


@router.get("/agent/cpu", response_model=CPUUsageResponse)
def get_cpu_usage(per_core: bool = Query(default=False)) -> CPUUsageResponse:
    if per_core:
        per = psutil.cpu_percent(interval=0.3, percpu=True)
        overall = sum(per) / len(per)
        return CPUUsageResponse(percent=overall, per_core=per)
    else:
        overall = psutil.cpu_percent(interval=0.3)
        return CPUUsageResponse(percent=overall)


@router.get("/agent/ram", response_model=RAMUsageResponse)
def get_ram_usage() -> RAMUsageResponse:
    v = psutil.virtual_memory()
    return RAMUsageResponse(
        total_bytes=v.total,
        used_bytes=v.used,
        available_bytes=v.available,
        percent_used=v.percent,
        total_human=_bytes_to_human(v.total),
        used_human=_bytes_to_human(v.used),
        available_human=_bytes_to_human(v.available),
    )


@router.get("/agent/uptime", response_model=UptimeResponse)
def get_uptime() -> UptimeResponse:
    seconds = int(time.time() - NODE_START_TIME)
    mins, s = divmod(seconds, 60)
    hours, m = divmod(mins, 60)
    days, h = divmod(hours, 24)
    parts = []
    if days:
        parts.append(f"{days}d")
    if h:
        parts.append(f"{h}h")
    if m:
        parts.append(f"{m}m")
    parts.append(f"{s}s")
    return UptimeResponse(seconds=seconds, human_readable=" ".join(parts))


@router.get("/agent/system_summary")
def get_system_summary() -> Dict[str, Any]:
    """Convenience endpoint for the Mesh panel."""
    now = time.time()
    if _summary_cache["result"] is not None and (now - _summary_cache["ts"]) < _SUMMARY_TTL:
        return _summary_cache["result"]
    result = {
        "disk": get_disk_usage(),
        "cpu": get_cpu_usage(),
        "ram": get_ram_usage(),
        "uptime": get_uptime(),
    }
    _summary_cache["result"] = result
    _summary_cache["ts"] = now
    return result


# ---------- ENDPOINTS V0.3 (Maintenance & Logs) ----------

@router.post("/agent/maintenance/refresh")
def agent_maintenance_refresh() -> Dict[str, Any]:
    """
    Force a fresh system summary snapshot on THIS node.

    Returns:
      {
        "ok": true,
        "snapshot": { "disk": ..., "cpu": ..., "ram": ..., "uptime": ... }
      }
    """
    snapshot = get_system_summary()
    return {
        "ok": True,
        "snapshot": snapshot,
    }


@router.post("/agent/maintenance/clean_temp")
def agent_maintenance_clean_temp(_session=Depends(require_session)) -> Dict[str, Any]:
    """
    Clean only OS-safe temp locations on THIS node:

    - System temp directory (tempfile.gettempdir())
    - TLI cache folder (DATA_DIR/cache)

    No recursion, no home directories, no arbitrary paths.
    """
    return _clean_temp_internal()


@router.get("/agent/logs/recent")
def agent_logs_recent(
    limit: int = Query(100, ge=1, le=1000),
) -> Dict[str, Any]:
    """
    Return recent backend / Node Agent logs from THIS node.

    Reads from debug_log.jsonl (line-delimited JSON) and attempts to parse.
    If parsing fails for a line, it is returned under {"raw": "..."}.
    """
    raw_lines = _tail_file(DEBUG_LOG_PATH, limit)
    entries: List[Dict[str, Any]] = []

    for line in raw_lines:
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                entries.append(obj)
            else:
                entries.append({"raw": line})
        except Exception:
            entries.append({"raw": line})

    return {
        "ok": True,
        "source": DEBUG_LOG_PATH,
        "limit": limit,
        "count": len(entries),
        "entries": entries,
    }


@router.post("/agent/tasks/run")
def agent_tasks_run(body: AgentTaskRunRequest, _session=Depends(require_session)) -> Dict[str, Any]:
    """
    Run a whitelisted maintenance task on THIS node.

    Allowed task_id values:
      - "refresh_status"  -> system summary snapshot
      - "clean_temp"      -> safe temp cleanup
      - "rotate_logs"     -> conditional log rotation

    Returns:
      {
        "ok": true/false,
        "task_id": "...",
        "result": {...} | null,
        "error": "..." | null
      }
    """
    task_id = (body.task_id or "").strip()

    if task_id not in TASK_HANDLERS:
        return {
            "ok": False,
            "task_id": task_id,
            "result": None,
            "error": f"Unsupported task_id: {task_id!r}",
        }

    handler = TASK_HANDLERS[task_id]
    try:
        result = handler() or {}
        return {
            "ok": True,
            "task_id": task_id,
            "result": result,
            "error": None,
        }
    except Exception as e:
        return {
            "ok": False,
            "task_id": task_id,
            "result": None,
            "error": f"Task execution error: {e!r}",
        }
