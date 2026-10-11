"""Read-only compatibility for legacy cleanup metadata and quarantine receipts.

Automatic scanning and direct cleanup are disabled. Current file-only Trash
operations require the separate /visualizer/cleanup review protocol.
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
    """Legacy entry point retained without filesystem scanning."""


def _notify_dashboard_presence() -> None:
    """Old automatic cleanup proposals are no longer produced."""


def _schedule_next() -> None:
    """Legacy automatic scheduling is disabled."""


def _tick() -> None:
    """A previously queued callback cannot start another scan."""


def start_cleanup_scanner() -> None:
    """Compatibility startup hook. Free Space scans require an explicit request."""
    stop_cleanup_scanner()


def stop_cleanup_scanner() -> None:
    global _timer_handle
    with _scan_lock:
        timer, _timer_handle = _timer_handle, None
    if timer is not None:
        timer.cancel()


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
    """Legacy callers cannot initiate scans; use the reviewed Free Space flow."""


@router.get("/scan")
def get_scan(_: Any = Depends(require_session)):
    """Read legacy cached metadata only; never scan on GET or navigation."""
    summary = get_scan_summary()
    return {**(summary or {}), "ok": summary is not None, "scanning": False,
            "legacy": True, "verified": False, "review_required": True,
            "message": "Legacy scan metadata is unverified. Open Free Space and explicitly start a new scan."}


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
            "message": "No legacy scan is available. Open Free Space to explicitly start a scan.",
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
            "auto_cleanable": False,
            "legacy_auto_cleanable": f.get("auto_cleanable", False),
            "verified": False,
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
    """Retained URL, with no quarantine, deletion, scan or timer side effects."""
    raise HTTPException(409, detail={
        "code": "review_required", "review_required": True,
        "navigate_to": "panel-visualizer",
        "message": "Open Free Space and review explicitly selected files. This legacy shortcut does not move or delete anything.",
    })


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
                    "legacy": True, "verified": False, "freed_bytes": None,
                    "space_note": "Historical quarantine receipt; recorded reclaimed space was not verified. Original receipt and quarantined files are preserved.",
                })
            except Exception:
                pass
    except Exception:
        pass

    return {"ok": True, "sessions": sessions[:50]}
