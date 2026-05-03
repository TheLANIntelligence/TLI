"""
cleanup/scanner.py — File-level scan engine for TLI Safe Cleanup Analyzer.

Walks cleanup category directories and returns individual file candidates
with age filtering.  Deterministic: no AI, no inference, no guessing.

Eligibility rules:
  1. Must be a regular file (no symlinks, no directories).
  2. Must be older than the category's min_age_days threshold.
  3. For installer categories: must match the allowed extension set.
  4. Hidden/system files (Windows FILE_ATTRIBUTE_HIDDEN | SYSTEM) are skipped.
  5. Files that cannot be stat()'d are silently skipped.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from cleanup.platform_paths import get_scan_categories

# Safety ceiling: we stop collecting files in a category once this limit is
# reached so a runaway directory cannot stall the server.
_MAX_FILES_PER_CATEGORY = 50_000


# ---------------------------------------------------------------------------
# File-level helpers
# ---------------------------------------------------------------------------

def _file_age_days(path: Path) -> float:
    """Return file age in days based on mtime.  Returns 0 on error."""
    try:
        return (time.time() - path.stat().st_mtime) / 86_400
    except OSError:
        return 0.0


def _is_hidden_or_system(path: Path) -> bool:
    """
    Return True if the file should be excluded.
    On Windows: checks FILE_ATTRIBUTE_HIDDEN (0x2) and FILE_ATTRIBUTE_SYSTEM (0x4).
    On other platforms: checks for a leading dot in the filename.
    """
    try:
        if os.name == "nt":
            import ctypes
            attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
            if attrs != -1:
                return bool(attrs & 0x2 or attrs & 0x4)
    except Exception:
        pass
    return path.name.startswith(".")


def _is_eligible(
    path: Path,
    min_age_days: float,
    installer_exts: Optional[set] = None,
) -> bool:
    """Return True if this file passes all eligibility checks."""
    # Must be a real, non-symlink file
    if path.is_symlink() or not path.is_file():
        return False
    # Age gate
    if _file_age_days(path) < min_age_days:
        return False
    # Extension gate (installers category only)
    if installer_exts is not None:
        if path.suffix.lower() not in installer_exts:
            return False
    # Skip hidden/system files
    if _is_hidden_or_system(path):
        return False
    return True


# ---------------------------------------------------------------------------
# Category walk
# ---------------------------------------------------------------------------

def _walk_category(cat: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Walk all paths in a category definition and return eligible file records.

    Record schema:
        path            str   — absolute file path
        size_bytes      int   — file size in bytes
        modified_ts     float — Unix mtime
        category_id     str   — category key
        auto_cleanable  bool  — whether this file is eligible for "Clean Now"
    """
    min_age        = float(cat.get("min_age_days", 1))
    installer_exts = cat.get("installer_exts")      # None for non-installer cats
    max_depth      = int(cat.get("max_depth", 999))
    cat_id         = cat["id"]
    auto_clean     = bool(cat.get("auto_cleanable", False))

    files: List[Dict[str, Any]] = []
    seen = 0

    for root_path in cat["paths"]:
        if not root_path.exists():
            continue
        try:
            for dirpath_str, dirnames, filenames in os.walk(
                root_path, topdown=True, onerror=None, followlinks=False
            ):
                dirpath = Path(dirpath_str)
                # Depth guard: prune subdirectories beyond max_depth
                try:
                    rel_depth = len(dirpath.relative_to(root_path).parts)
                except ValueError:
                    rel_depth = 0
                if rel_depth >= max_depth:
                    dirnames.clear()
                    continue

                for fname in filenames:
                    if seen >= _MAX_FILES_PER_CATEGORY:
                        break
                    fpath = dirpath / fname
                    if not _is_eligible(fpath, min_age, installer_exts):
                        continue
                    try:
                        st = fpath.stat()
                        files.append({
                            "path":           str(fpath),
                            "size_bytes":     st.st_size,
                            "modified_ts":    st.st_mtime,
                            "category_id":    cat_id,
                            "auto_cleanable": auto_clean,
                        })
                        seen += 1
                    except OSError:
                        pass

                if seen >= _MAX_FILES_PER_CATEGORY:
                    break

        except (PermissionError, OSError):
            pass

    return files


# ---------------------------------------------------------------------------
# Public scan entry point
# ---------------------------------------------------------------------------

def run_scan() -> Dict[str, Any]:
    """
    Run a full platform scan across all cleanup categories.

    Returns a result dict with:
        ok                   bool
        total_bytes          int
        total_gb             float
        auto_cleanable_bytes int   — subset eligible for "Clean Now"
        auto_cleanable_gb    float
        categories           list  — per-category summary rows
        generated_at         float — Unix timestamp of scan completion
        _file_index          list  — flat file list (internal; stripped before API response)

    Never raises.  On partial failure, returns whatever was collected.
    """
    cats = get_scan_categories()
    generated_at = time.time()

    category_results: List[Dict[str, Any]] = []
    all_files:        List[Dict[str, Any]] = []
    total_bytes           = 0
    auto_cleanable_bytes  = 0

    for cat_def in cats:
        try:
            files = _walk_category(cat_def)
        except Exception:
            files = []

        cat_bytes = sum(f["size_bytes"] for f in files)
        total_bytes += cat_bytes
        if cat_def.get("auto_cleanable"):
            auto_cleanable_bytes += cat_bytes

        all_files.extend(files)

        category_results.append({
            "id":             cat_def["id"],
            "label":          cat_def["label"],
            "bytes":          cat_bytes,
            "gb":             round(cat_bytes / (1024 ** 3), 2),
            "file_count":     len(files),
            "risk":           cat_def.get("risk", "low"),
            "auto_cleanable": cat_def.get("auto_cleanable", False),
        })

    return {
        "ok":                   True,
        "total_bytes":          total_bytes,
        "total_gb":             round(total_bytes / (1024 ** 3), 2),
        "auto_cleanable_bytes": auto_cleanable_bytes,
        "auto_cleanable_gb":    round(auto_cleanable_bytes / (1024 ** 3), 2),
        "categories":           category_results,
        "generated_at":         generated_at,
        "_file_index":          all_files,   # stripped before every API response
    }
