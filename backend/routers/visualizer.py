from __future__ import annotations

import ctypes
import hashlib
import heapq
import os
import platform
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from itertools import islice
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

from fastapi import APIRouter, Depends, Query, HTTPException, Response, Request
from pydantic import BaseModel, ConfigDict, Field
from routers.system_routes import require_session

try:
    import psutil as _psutil
except ImportError:
    _psutil = None  # type: ignore

import storage_jobs
# Compatibility names for integrations; filesystem work is executed only by the pure child.
from storage_scan_algorithms import _bytes_human, _cleanup_targets_linux, _cleanup_targets_mac, _cleanup_targets_windows, _collect_large_files, _dir_size, _enumerate_drives, _expand_user_path, _file_signature, _find_duplicates, _hash_duplicate_file, _measure_cleanup, _protected_files, _protected_prefixes, _safe_disk_usage, _scan_tree, _win_drive_type, _win_volume_label, get_cleanup_targets, is_protected

visualizer_router = APIRouter(prefix="/visualizer", tags=["visualizer"])


class CleanupFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=4096)
    keep_path: Optional[str] = Field(default=None, min_length=1, max_length=4096)


class CleanupPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    files: List[CleanupFile] = Field(min_length=1, max_length=100)


class CleanupExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class SaveStorageScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scan_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    version: int = Field(ge=1, le=1)


class CompareStorageScanRequest(SaveStorageScanRequest):
    baseline_id: str = Field(pattern=r"^[a-f0-9]{32}$")


@visualizer_router.get("/history")
def storage_scan_history(response: Response, user: str = Depends(require_session)):
    from intelligence.storage_history import history
    response.headers["Cache-Control"] = "no-store"
    return history(user)


@visualizer_router.post("/history/save")
def save_storage_scan(req: SaveStorageScanRequest, user: str = Depends(require_session)):
    from intelligence.storage_history import save
    return save(user, req.scan_id)


@visualizer_router.post("/history/compare")
def compare_storage_scan(req: CompareStorageScanRequest, user: str = Depends(require_session)):
    from intelligence.storage_history import compare
    return compare(user, req.baseline_id, req.scan_id)


@visualizer_router.delete("/history/{snapshot_id}")
def remove_storage_scan(snapshot_id: str, user: str = Depends(require_session)):
    from intelligence.storage_history import remove
    import re
    if not re.fullmatch(r"[a-f0-9]{32}", snapshot_id):
        raise HTTPException(422, "Invalid saved scan identifier.")
    return remove(user, snapshot_id)


def _cleanup_access(request: Request, user: str):
    """Bind review to its original credential, re-resolving revocation per move."""
    import tli_state as state
    from companion_auth import resolve_user
    token = request.cookies.get("tli_session")
    authorization = request.headers.get("authorization")
    bound_token = token if token and state.validate_session_token(token) else None
    key = hashlib.sha256((authorization or bound_token or "local-no-pin").encode()).hexdigest()
    def check():
        if bound_token and not state.validate_session_token(bound_token):
            raise HTTPException(401, "Cleanup stopped because the reviewed session expired or was locked.")
        if resolve_user(request) != user:
            raise HTTPException(401, "Cleanup stopped because the authenticated owner changed.")
    return check, key


@visualizer_router.post("/cleanup/preview")
def cleanup_preview(req: CleanupPreviewRequest, request: Request, user: str = Depends(require_session)):
    from storage_cleanup import preview
    check, key = _cleanup_access(request, user)
    return preview(user, [item.model_dump() for item in req.files], access_check=check, session_key=key)


@visualizer_router.post("/cleanup/execute")
def cleanup_execute(req: CleanupExecuteRequest, request: Request, user: str = Depends(require_session)):
    from storage_cleanup import execute
    check, key = _cleanup_access(request, user)
    return execute(user, req.preview_id, access_check=check, session_key=key)


@visualizer_router.get("/cleanup/receipt/{preview_id}")
def cleanup_receipt(preview_id: str, user: str = Depends(require_session)):
    from storage_cleanup import receipt
    return receipt(user, preview_id)


@visualizer_router.get("/cleanup/receipts")
def cleanup_receipts(user: str = Depends(require_session)):
    from storage_cleanup import history
    return {"ok": True, "receipts": history(user)}

# ---------- scanning helpers ----------

NOISY_DEFAULT = {"node_modules", ".git", "__pycache__", "AppData", "Library", "Cache", "Caches"}

# ---------- OS-aware protected paths ----------





# ---------- cleanup targets ----------













def _safe_scandir(p: Path):
    try:
        return list(os.scandir(p))
    except Exception:
        return []


# ---------- routes ----------

@contextmanager
def _scan_activity(label):
    # The shared bus contains operation summaries, never requested paths/names.
    from event_bus import emit_event
    outcome = {}
    emit_event("system", "info", f"{label} started", "Inspecting the requested folder. No files will be changed.")
    try:
        yield outcome
    except Exception:
        emit_event("system", "warn", f"{label} failed", "The scan did not finish. Review the error in Free Space; no files were changed.")
        raise
    else:
        partial = outcome.get("partial", False)
        emit_event("system", "warn" if partial else "ok", f"{label} {'partially completed' if partial else 'finished'}",
                   f"{outcome.get('count', 0)} {outcome.get('unit', 'results')} returned. "
                   + ("Coverage is incomplete. " if partial else "")
                   + "Review the scope and results in Free Space; no files were changed.")


@visualizer_router.get("/treemap")
def treemap(request: Request, response: Response, path: str = Query(...),
            width: int = Query(1200, ge=200, le=8000), max_entries: int = Query(50_000, ge=5_000, le=100_000),
            max_depth: int = Query(18, ge=4, le=30), _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    with _scan_activity("Storage scan") as outcome:
        result = storage_jobs.sync(storage_jobs.access(request, _session), "scan", path,
                    limits={"max_seconds": 15, "max_entries": max_entries, "max_depth": max_depth})
        result["meta"]["width_hint"] = width
        outcome.update(partial=result["meta"].get("partial", False), count=result["meta"].get("files", 0), unit="inspected files")
        return result

# Back-compat alias (some builds call this)
@visualizer_router.get("/scan")
def scan_alias(request: Request, response: Response, path: str = Query(...), width: int = Query(1200, ge=200, le=8000),
               max_entries: int = Query(50_000, ge=5_000, le=100_000), max_depth: int = Query(18, ge=4, le=30),
               _session: str = Depends(require_session)):
    return treemap(request, response, path, width, max_entries, max_depth, _session)

# Older frontend alias (some builds call this)
@visualizer_router.get("/scan_directory")
def scan_directory(request: Request, response: Response, path: str = Query(...), _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.sync(storage_jobs.access(request, _session), "scan", path)["tree"]


@visualizer_router.get("/open_in_files")
def open_in_files(request: Request, response: Response, path: str = Query(...), _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.sync(storage_jobs.access(request, _session), "path_exists", path)


def _open_path_handler(path: str) -> dict:
    """
    Open a file or folder with the OS default application.
    Windows: os.startfile  |  macOS: open  |  Linux: xdg-open
    """
    try:
        p = Path(path)
        if not p.exists():
            return {"ok": False, "error": f"Path does not exist: {path}"}
        sys_name = platform.system()
        if sys_name == "Windows":
            os.startfile(str(p))
        elif sys_name == "Darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
        return {"ok": True, "path": path}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _reveal_path_handler(path: str) -> dict:
    """
    Reveal a file/folder in the OS file manager (Explorer/Finder) with it selected.
    Windows: explorer /select,<path>  |  macOS: open -R  |  Linux: open parent folder
    """
    try:
        p = Path(path)
        if not p.exists():
            return {"ok": False, "error": f"Path does not exist: {path}"}
        sys_name = platform.system()
        if sys_name == "Windows":
            # /select, causes Explorer to open the parent folder with the item highlighted
            subprocess.Popen(["explorer", f"/select,{p}"])
        elif sys_name == "Darwin":
            subprocess.Popen(["open", "-R", str(p)])
        else:
            # Linux: open parent folder (no universal "select file" support)
            parent = str(p.parent) if p.is_file() else str(p)
            subprocess.Popen(["xdg-open", parent])
        return {"ok": True, "path": path}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@visualizer_router.get("/cleanup-targets")
def cleanup_targets_endpoint(request: Request, response: Response, _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.sync(storage_jobs.access(request, _session), "common_folders")


# ---------- large-file hunt ----------



@visualizer_router.get("/large-files")
def large_files(request: Request, response: Response, path: str = Query(...),
                min_mb: float = Query(100.0, ge=1.0, le=50_000.0), limit: int = Query(200, ge=10, le=2000),
                _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    with _scan_activity("Large-file search") as outcome:
        result = storage_jobs.sync(storage_jobs.access(request, _session), "large_files", path, min_mb=min_mb, limit=limit,
                                  limits={"max_seconds": 15, "max_entries": 500_000, "max_depth": 30})
        outcome.update(partial=result["meta"].get("partial", False), count=len(result["files"]), unit="file results")
        return result


# ---------- duplicate finder ----------







@visualizer_router.get("/duplicates")
def duplicates(request: Request, response: Response, path: str = Query(...), _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    with _scan_activity("Duplicate search") as outcome:
        result = storage_jobs.sync(storage_jobs.access(request, _session), "duplicates", path,
                                  limits={"max_seconds": 15, "max_entries": 300_000, "max_depth": 30})
        outcome.update(partial=result["meta"].get("partial", False), count=len(result["groups"]), unit="duplicate groups")
        return result


# ---------- drive enumeration ----------











@visualizer_router.get("/drives")
def list_drives(request: Request, response: Response, _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.sync(storage_jobs.access(request, _session), "drives")


@visualizer_router.get("/paths")
def common_paths(request: Request, response: Response, _session: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.sync(storage_jobs.access(request, _session), "paths")


@visualizer_router.post("/jobs")
def start_storage_job(body: storage_jobs.StartRequest, request: Request, response: Response, user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.start(storage_jobs.access(request, user), body.model_dump())


@visualizer_router.get("/jobs/{job_id}")
def storage_job_status(job_id: str, request: Request, response: Response, user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.status(storage_jobs.access(request, user), job_id)


@visualizer_router.get("/jobs/{job_id}/results")
def storage_job_results(job_id: str, request: Request, response: Response, user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.results(storage_jobs.access(request, user), job_id)


@visualizer_router.post("/jobs/{job_id}/cancel")
def cancel_storage_job(job_id: str, request: Request, response: Response, user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return storage_jobs.cancel(storage_jobs.access(request, user), job_id)
