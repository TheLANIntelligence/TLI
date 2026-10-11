"""
cleanup/executor.py — Reversible cleanup execution for TLI Safe Cleanup Analyzer.

Strategy: move eligible files into a TLI-managed quarantine directory,
preserving enough path structure to restore them if needed.

Quarantine layout:
    {DATA_DIR}/cleanup_quarantine/
        {session_ts}/
            receipt.json        — JSON receipt (paths, sizes, categories)
            files/
                {flattened_path} — original file, path-encoded to avoid collisions

Nothing is hard-deleted.  The user can restore files manually from quarantine
or the system can be extended with a restore endpoint in a future version.

Files that cannot be moved (locked, permission denied, already gone) are
logged to the "failed" list in the receipt — they do not cause the whole
operation to abort.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

QUARANTINE_DIR_NAME = "cleanup_quarantine"

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _quarantine_base(data_dir: Path) -> Path:
    q = data_dir / QUARANTINE_DIR_NAME
    q.mkdir(parents=True, exist_ok=True)
    return q


def _safe_dest(src: Path, session_dir: Path) -> Path:
    """
    Map an absolute source path to a safe relative destination inside session_dir/files/.

    Absolute path components are joined with '__' and the drive colon is replaced,
    so the destination is always a flat-ish single filename under session_dir/files/.
    This avoids deep directory creation and Windows MAX_PATH issues.

    Example:
        C:\\Users\\foo\\AppData\\Local\\Temp\\abc.tmp
        → session_dir/files/C__Users__foo__AppData__Local__Temp__abc.tmp
    """
    # Build a safe filename from the absolute path string
    raw = str(src)
    # Replace path separators + colon (Windows drive) with double underscores
    safe_name = raw.replace("\\", "__").replace("/", "__").replace(":", "")
    # Truncate to 200 chars to stay well under MAX_PATH
    if len(safe_name) > 200:
        # Keep suffix so the file type is recognisable in quarantine
        suffix = src.suffix
        safe_name = safe_name[:200 - len(suffix)] + suffix
    return session_dir / "files" / safe_name


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def execute_clean_safe(
    file_index:          List[Dict[str, Any]],
    data_dir:            Path,
    auto_cleanable_only: bool = True,
) -> Dict[str, Any]:
    """
    Move eligible files from file_index to a quarantine session directory.

    Parameters
    ----------
    file_index:
        Flat list of file records (output from scanner.run_scan()["_file_index"]).
        Each record must contain: path, size_bytes, category_id, auto_cleanable.
    data_dir:
        Root data directory where the quarantine folder is created.
    auto_cleanable_only:
        When True (default), only files with auto_cleanable=True are moved.
        Pass False to move everything (reserved for future per-category confirm).

    Returns
    -------
    Receipt dict:
        session         str   — timestamp ID for this session
        timestamp       str   — ISO-8601 timestamp
        bytes_reclaimed int
        gb_reclaimed    float
        files_moved     int
        files_failed    int
        categories      list  — unique category IDs that were cleaned
        moved           list  — {original_path, quarantine_path, size_bytes, category_id}
        failed          list  — {path, reason}
        narrator_msg    str   — short human-readable summary for the narrator
    """
    ts_str    = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    q_base    = _quarantine_base(data_dir)
    q_session = q_base / ts_str
    (q_session / "files").mkdir(parents=True, exist_ok=True)

    # Filter
    eligible = [
        f for f in file_index
        if (not auto_cleanable_only) or f.get("auto_cleanable", False)
    ]
    # Largest first — maximises bytes reclaimed if operation is interrupted
    eligible.sort(key=lambda f: f.get("size_bytes", 0), reverse=True)

    moved:          List[Dict[str, Any]] = []
    failed:         List[Dict[str, Any]] = []
    bytes_reclaimed = 0

    for finfo in eligible:
        src = Path(finfo["path"])
        if not src.exists():
            continue   # already cleaned or removed externally

        dest = _safe_dest(src, q_session)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
            moved.append({
                "original_path":   finfo["path"],
                "quarantine_path": str(dest),
                "size_bytes":      finfo.get("size_bytes", 0),
                "category_id":     finfo.get("category_id", ""),
            })
            bytes_reclaimed += finfo.get("size_bytes", 0)
        except (PermissionError, OSError, shutil.Error) as exc:
            failed.append({
                "path":   finfo["path"],
                "reason": str(exc)[:120],
            })

    # Build narrator message
    gb = round(bytes_reclaimed / (1024 ** 3), 2)
    if gb >= 0.1:
        narrator_msg = f"Cleaned {gb:.1f} GB — files are in quarantine and can be restored."
    elif bytes_reclaimed > 0:
        mb = round(bytes_reclaimed / (1024 ** 2), 0)
        narrator_msg = f"Cleaned {int(mb)} MB — files are in quarantine."
    else:
        narrator_msg = "Nothing was moved — files may have been locked or already removed."

    receipt: Dict[str, Any] = {
        "session":         ts_str,
        "timestamp":       datetime.now(timezone.utc).isoformat(),
        "bytes_reclaimed": bytes_reclaimed,
        "gb_reclaimed":    gb,
        "files_moved":     len(moved),
        "files_failed":    len(failed),
        "categories":      sorted({f.get("category_id", "") for f in moved}),
        "moved":           moved,
        "failed":          failed,
        "narrator_msg":    narrator_msg,
    }

    # Persist receipt alongside the quarantined files
    try:
        (q_session / "receipt.json").write_text(
            json.dumps(receipt, indent=2), encoding="utf-8"
        )
    except Exception:
        pass

    # If nothing was moved, remove the empty session directory
    if not moved:
        try:
            shutil.rmtree(q_session, ignore_errors=True)
        except Exception:
            pass

    return receipt
