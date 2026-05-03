"""
routers/cleanup_routes.py — TLI v1.4 Safe Cleanup Analyzer

Provides:
  GET  /cleanup/scan           — return cached scan summary (triggers scan if stale)
  GET  /cleanup/candidates     — reviewable file list, filterable by category
  POST /cleanup/clean_safe     — reversible cleanup of auto-cleanable categories
  GET  /cleanup/receipts       — list past cleanup sessions

Design constraints (from spec):
  - Deterministic only: no AI, no inference for file eligibility
  - Never auto-delete: all cleanup is move-to-quarantine
  - Never touch: Documents, Desktop, Pictures, Music, Videos, source code repos,
    user-created folders, or anything requiring inferred intent
  - Only auto-cleanable: user_temp, system_temp, tmp — review-only: installers
  - Background scan: non-blocking, runs 15s after startup then every 2 hours
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

import tli_state as S
from routers.system_routes import require_session
from tli_state import log_debug

router = APIRouter(prefix="/cleanup", tags=["cleanup"])


# ---------------------------------------------------------------------------
# Scan state (module-level, protected by lock)
# ---------------------------------------------------------------------------

_scan_result:  Optional[Dict[str, Any]] = None
_scan_lock     = threading.Lock()
_scan_running  = threading.Event()     # set while a scan thread is active

_SCAN_STARTUP_DELAY_S  = 15.0          # wait after startup before first scan
_SCAN_INTERVAL_S       = 7200.0        # 2 hours between automatic rescans
_RESULT_STALE_AFTER_S  = _SCAN_INTERVAL_S

_timer_handle: Optional[threading.Timer] = None


# ---------------------------------------------------------------------------
# Background scan machinery
# ---------------------------------------------------------------------------

def _do_scan() -> None:
    """
    Execute a blocking scan and cache the result.
    Always runs in a dedicated background thread; never call from a request handler.
    """
    _scan_running.set()
    try:
        from cleanup.scanner import run_scan          # lazy — avoids import-time cost
        result = run_scan()
        with _scan_lock:
            global _scan_result
            _scan_result = result
        log_debug("cleanup", "info",
                  f"Scan complete — total={result['total_gb']:.2f} GB  "
                  f"auto-cleanable={result['auto_cleanable_gb']:.2f} GB  "
                  f"files={len(result.get('_file_index', []))}")
        # Notify Dashboard Presence Layer so it can enqueue a cleanup action
        _notify_dashboard_presence()
    except Exception as exc:
        log_debug("cleanup", "warn", f"Scan error: {exc}")
    finally:
        _scan_running.clear()


def _notify_dashboard_presence() -> None:
    try:
        from routers.dashboard_presence import score_cleanup_action
        score_cleanup_action()
    except Exception as exc:
        log_debug("cleanup", "debug", f"dashboard_presence notify: {exc}")


def _schedule_next() -> None:
    global _timer_handle
    _timer_handle = threading.Timer(_SCAN_INTERVAL_S, _tick)
    _timer_handle.daemon = True
    _timer_handle.start()


def _tick() -> None:
    if not _scan_running.is_set():
        t = threading.Thread(target=_do_scan, name="tli-cleanup-scan", daemon=True)
        t.start()
    _schedule_next()


def start_cleanup_scanner() -> None:
    """Called from main.py on_startup.  Schedules the first scan after a short delay."""
    delay = threading.Timer(_SCAN_STARTUP_DELAY_S, _tick)
    delay.daemon = True
    delay.start()
    log_debug("cleanup", "info", f"Cleanup scanner will start in {_SCAN_STARTUP_DELAY_S}s.")


def stop_cleanup_scanner() -> None:
    global _timer_handle
    if _timer_handle:
        _timer_handle.cancel()


# ---------------------------------------------------------------------------
# Internal helpers exposed to other modules (dashboard_presence, executor)
# ---------------------------------------------------------------------------

def get_scan_summary() -> Optional[Dict[str, Any]]:
    """
    Return latest scan result without the internal file index.
    Returns None if no scan has completed yet.
    """
    with _scan_lock:
        result = _scan_result
    if result is None:
        return None
    return {k: v for k, v in result.items() if k != "_file_index"}


def get_file_index() -> List[Dict[str, Any]]:
    """Return the full flat file list from the most recent scan (internal use)."""
    with _scan_lock:
        result = _scan_result
    return list(result.get("_file_index", [])) if result else []


def invalidate_scan() -> None:
    """Discard the current scan result (called after a clean_safe operation)."""
    with _scan_lock:
        global _scan_result
        _scan_result = None


def trigger_scan_async() -> None:
    """Trigger an immediate background scan (non-blocking)."""
    if not _scan_running.is_set():
        t = threading.Thread(target=_do_scan, name="tli-cleanup-demand", daemon=True)
        t.start()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/scan")
def get_scan(_: Any = Depends(require_session)):
    """
    Return cached scan summary.

    Automatically triggers a background scan when:
    - no scan has been run yet, OR
    - the last scan is older than 2 hours.

    If a scan is already in progress, returns the last known result (or a
    scanning=True stub) immediately — never blocks the request.
    """
    summary = get_scan_summary()
    age_s: Optional[float] = None
    if summary:
        age_s = time.time() - summary.get("generated_at", 0)

    needs_scan = (summary is None) or (age_s is not None and age_s > _RESULT_STALE_AFTER_S)
    if needs_scan and not _scan_running.is_set():
        trigger_scan_async()

    if summary is None:
        return {
            "ok":       False,
            "scanning": True,
            "message":  "Scan starting — check back in a few seconds.",
        }

    return {
        "ok":      True,
        "scanning": _scan_running.is_set(),
        "age_s":   round(age_s, 0) if age_s is not None else None,
        **summary,
    }


@router.get("/candidates")
def get_candidates(
    category: Optional[str] = Query(None, description="Filter by category ID"),
    _: Any = Depends(require_session),
):
    """
    Return the reviewable file list from the last scan.

    Files are sorted by size descending, capped at 5 000 entries per response.
    If category is specified, only files from that category are returned.
    """
    file_index = get_file_index()
    if not file_index:
        return {
            "ok":      False,
            "message": "No scan available. Call GET /cleanup/scan to start one.",
        }

    if category:
        file_index = [f for f in file_index if f.get("category_id") == category]

    file_index = sorted(file_index, key=lambda f: f.get("size_bytes", 0), reverse=True)[:5_000]
    total_bytes = sum(f.get("size_bytes", 0) for f in file_index)

    results = []
    for f in file_index:
        results.append({
            "path":           f["path"],
            "size_bytes":     f.get("size_bytes", 0),
            "size_mb":        round(f.get("size_bytes", 0) / (1024 ** 2), 2),
            "modified_ts":    f.get("modified_ts"),
            "category_id":    f.get("category_id", ""),
            "auto_cleanable": f.get("auto_cleanable", False),
        })

    return {
        "ok":          True,
        "category":    category,
        "total_files": len(results),
        "total_bytes": total_bytes,
        "total_gb":    round(total_bytes / (1024 ** 3), 3),
        "files":       results,
    }


@router.post("/clean_safe")
def post_clean_safe(_: Any = Depends(require_session)):
    """
    Execute reversible cleanup on all auto-cleanable category files.

    Files are moved (not deleted) to a TLI-managed quarantine directory at:
        {DATA_DIR}/cleanup_quarantine/{session}/

    A JSON receipt is written alongside the quarantined files.
    Returns the receipt so the caller can surface it in the narrator.
    """
    file_index = get_file_index()
    if not file_index:
        raise HTTPException(
            status_code=409,
            detail="No scan available. Call GET /cleanup/scan first.",
        )

    auto_files = [f for f in file_index if f.get("auto_cleanable")]
    if not auto_files:
        return {
            "ok":              True,
            "message":         "No auto-cleanable files found.",
            "bytes_reclaimed": 0,
            "receipt":         None,
        }

    from cleanup.executor import execute_clean_safe   # lazy import
    data_dir = Path(S.DATA_DIR)
    receipt  = execute_clean_safe(auto_files, data_dir, auto_cleanable_only=True)

    # Invalidate stale scan and queue a fresh one
    invalidate_scan()
    t = threading.Timer(3.0, _do_scan)
    t.daemon = True
    t.start()

    log_debug(
        "cleanup", "info",
        f"clean_safe complete — "
        f"{receipt['gb_reclaimed']:.3f} GB reclaimed, "
        f"{receipt['files_moved']} moved, "
        f"{receipt['files_failed']} failed",
    )

    return {"ok": True, "receipt": receipt}


@router.get("/receipts")
def get_receipts(_: Any = Depends(require_session)):
    """List past cleanup sessions (most recent first, up to 50 entries)."""
    q_base = Path(S.DATA_DIR) / "cleanup_quarantine"
    if not q_base.exists():
        return {"ok": True, "sessions": []}

    sessions: List[Dict[str, Any]] = []
    try:
        for session_dir in sorted(q_base.iterdir(), reverse=True):
            if not session_dir.is_dir():
                continue
            receipt_path = session_dir / "receipt.json"
            if not receipt_path.exists():
                continue
            try:
                data = json.loads(receipt_path.read_text(encoding="utf-8"))
                sessions.append({
                    "session":       data.get("session"),
                    "timestamp":     data.get("timestamp"),
                    "gb_reclaimed":  data.get("gb_reclaimed"),
                    "files_moved":   data.get("files_moved"),
                    "files_failed":  data.get("files_failed"),
                    "categories":    data.get("categories"),
                })
            except Exception:
                pass
    except Exception:
        pass

    return {"ok": True, "sessions": sessions[:50]}
