from __future__ import annotations

import math
import time
import os
import tempfile
import json
from collections import deque
from typing import List, Optional, Dict, Any

import psutil
from fastapi import APIRouter, Depends, Query, HTTPException, Request
from pydantic import BaseModel

import tli_state as S
import peer_trust
import node_identity
from routers.system_routes import require_session

router = APIRouter(route_class=peer_trust.BoundedPeerRoute)

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

def _safe_clean_dir(*args, **kwargs):
    raise HTTPException(409, {"code": "review_required", "message": "Review the exact file selection in Free Space. No legacy cleanup ran."})


def _clean_temp_internal(*args, **kwargs):
    raise HTTPException(409, {"code": "review_required", "message": "Review the exact file selection in Free Space. No legacy cleanup ran."})


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


def _task_clean_temp(*args, **kwargs):
    raise HTTPException(409, {"code": "review_required", "message": "Review the exact file selection in Free Space. No legacy cleanup ran."})


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

@router.get("/agent/disk", dependencies=[Depends(peer_trust.read_access)], response_model=DiskUsageResponse)
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


@router.get("/agent/cpu", dependencies=[Depends(peer_trust.read_access)], response_model=CPUUsageResponse)
def get_cpu_usage(per_core: bool = Query(default=False)) -> CPUUsageResponse:
    if per_core:
        per = psutil.cpu_percent(interval=0.3, percpu=True)
        overall = sum(per) / len(per)
        return CPUUsageResponse(percent=overall, per_core=per)
    else:
        overall = psutil.cpu_percent(interval=0.3)
        return CPUUsageResponse(percent=overall)


@router.get("/agent/ram", dependencies=[Depends(peer_trust.read_access)], response_model=RAMUsageResponse)
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


@router.get("/agent/uptime", dependencies=[Depends(peer_trust.read_access)], response_model=UptimeResponse)
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


@router.get("/agent/system_summary", dependencies=[Depends(peer_trust.read_access)])
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

@router.post("/agent/maintenance/refresh", dependencies=[Depends(peer_trust.read_access)])
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
def agent_maintenance_clean_temp(_session=Depends(require_session)):
    return _clean_temp_internal()


@router.get("/agent/logs/recent", dependencies=[Depends(require_session)])
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
def agent_tasks_run(body: AgentTaskRunRequest, _session=Depends(peer_trust.read_access)) -> Dict[str, Any]:
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
    if task_id != "refresh_status":
        raise HTTPException(409, {"code": "review_required", "message": "Only read-only refresh is available here. Review other actions in the computer’s own console."})

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


@router.get("/agent/peer/health")
def peer_health(access=Depends(peer_trust.coordinate_access)):
    peer_trust.revalidate(access)
    cfg = S.load_node_config()
    return {"ok": True, "online": True, "node_id": cfg.node_id, "node_name": cfg.node_name,
            "identity_fingerprint": node_identity.fingerprint(), "observed_at": S.now_iso(),
            "capabilities": ["system_observation_v1", "coordination_v1", "messages_v1"]}

class PeerObservationRequest(BaseModel):
    kind: str

@router.post("/agent/peer/observe")
def peer_observe(body: PeerObservationRequest, access=Depends(peer_trust.observe_access)):
    if body.kind != "system":
        raise HTTPException(422, "Only bounded native system observation is supported.")
    peer_trust.revalidate(access)
    cfg = S.load_node_config()
    facts = dict.fromkeys(["cpu_percent", "logical_cpus", "ram_total_bytes", "ram_used_bytes", "ram_available_bytes", "ram_percent", "uptime_seconds"])
    try:
        ram = psutil.virtual_memory()
        for key, attr in [("ram_total_bytes", "total"), ("ram_used_bytes", "used"), ("ram_available_bytes", "available"), ("ram_percent", "percent")]:
            facts[key] = getattr(ram, attr, None)
    except Exception:
        pass
    for key, read in [("cpu_percent", lambda: psutil.cpu_percent(interval=0.1)), ("logical_cpus", psutil.cpu_count),
                      ("uptime_seconds", lambda: max(0, time.time() - psutil.boot_time()))]:
        try:
            facts[key] = read()
        except Exception:
            pass
    for key, value in facts.items():
        if (type(value) not in (int, float) or not math.isfinite(value) or value < 0 or value > 2**60
                or (key.endswith("percent") and value > 100)):
            facts[key] = None
    known = sum(value is not None for value in facts.values())
    peer_trust.revalidate(access)
    return {"protocol": "tli-peer-observation-v1", "host": {"id": cfg.node_id, "name": cfg.node_name,
             "identity_fingerprint": node_identity.fingerprint()}, "observed_at": S.now_iso(), "facts": facts,
            "coverage": {"complete": known == 7, "known_metrics": known, "total_metrics": 7},
            "scope": "Measurements made on this TLI peer, not the requesting host, phone or browser.",
            "limitations": ["One short CPU/RAM observation is not a diagnosis or proof of a fix.",
                            "No disk scan, network probe, process observation or action was performed."] +
                           (["Some metrics were unavailable and remain unknown."] if known < 7 else [])}
