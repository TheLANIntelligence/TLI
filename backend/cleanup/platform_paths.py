"""
cleanup/platform_paths.py — Platform-aware cleanup category definitions.

Each category dict describes one cleanup target:
  id              — unique key used for deduplication and API filtering
  label           — human-readable name shown in the UI
  paths           — list of Path objects to scan
  min_age_days    — minimum file age before a file is eligible
  auto_cleanable  — True = included in "Clean Now"; False = review only
  risk            — "low" (only value currently emitted)
  installer_exts  — optional set; when present, only files with these
                    suffixes are collected (used for the installers category)
  max_depth       — optional walk depth cap (default: unlimited)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------

def _win_categories() -> List[Dict[str, Any]]:
    home      = Path.home()
    local_app = Path(os.environ.get("LOCALAPPDATA",
                                    str(home / "AppData" / "Local")))
    # Prefer TEMP env var; fall back to common location
    user_temp = Path(os.environ.get("TEMP",
                     os.environ.get("TMP", str(local_app / "Temp"))))
    sys_temp  = Path("C:/Windows/Temp")

    cats: List[Dict[str, Any]] = [
        {
            "id":            "user_temp",
            "label":         "Temp Files",
            "paths":         [user_temp],
            "min_age_days":  3,
            "auto_cleanable": True,
            "risk":          "low",
        },
        {
            "id":            "system_temp",
            "label":         "Windows Temp",
            "paths":         [sys_temp],
            "min_age_days":  7,
            "auto_cleanable": True,
            "risk":          "low",
        },
        {
            # installer_exts limits scanning to known archive/installer types only.
            # max_depth=1 ensures we never recurse into project subfolders the user
            # may have organised inside Downloads.
            "id":             "installers",
            "label":          "Old Installers",
            "paths":          [home / "Downloads"],
            "min_age_days":   30,
            "auto_cleanable": False,   # review only — never auto-deleted
            "risk":           "low",
            "installer_exts": {".msi", ".exe", ".zip", ".7z", ".rar", ".iso"},
            "max_depth":      1,
        },
    ]
    # Return only categories where at least one path exists on this machine.
    return [c for c in cats if any(p.exists() for p in c["paths"])]


# ---------------------------------------------------------------------------
# macOS
# ---------------------------------------------------------------------------

def _mac_categories() -> List[Dict[str, Any]]:
    home = Path.home()
    cats: List[Dict[str, Any]] = [
        {
            "id":            "user_cache",
            "label":         "App Cache",
            "paths":         [home / "Library" / "Caches"],
            "min_age_days":  7,
            "auto_cleanable": True,
            "risk":          "low",
        },
        {
            "id":             "installers",
            "label":          "Old Installers",
            "paths":          [home / "Downloads"],
            "min_age_days":   30,
            "auto_cleanable": False,
            "risk":           "low",
            "installer_exts": {".dmg", ".pkg", ".zip", ".iso"},
            "max_depth":      1,
        },
    ]
    return [c for c in cats if any(p.exists() for p in c["paths"])]


# ---------------------------------------------------------------------------
# Linux
# ---------------------------------------------------------------------------

def _linux_categories() -> List[Dict[str, Any]]:
    home      = Path.home()
    tmp       = Path("/tmp")
    xdg_cache = Path(os.environ.get("XDG_CACHE_HOME", str(home / ".cache")))
    cats: List[Dict[str, Any]] = [
        {
            "id":            "tmp",
            "label":         "Temp Files",
            "paths":         [tmp],
            "min_age_days":  3,
            "auto_cleanable": True,
            "risk":          "low",
        },
        {
            "id":            "user_cache",
            "label":         "App Cache",
            "paths":         [xdg_cache],
            "min_age_days":  7,
            "auto_cleanable": True,
            "risk":          "low",
        },
        {
            "id":             "installers",
            "label":          "Old Installers",
            "paths":          [home / "Downloads"],
            "min_age_days":   30,
            "auto_cleanable": False,
            "risk":           "low",
            "installer_exts": {".deb", ".rpm", ".zip", ".tar.gz", ".sh"},
            "max_depth":      1,
        },
    ]
    return [c for c in cats if any(p.exists() for p in c["paths"])]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def get_scan_categories() -> List[Dict[str, Any]]:
    """Return cleanup category definitions for the current platform."""
    if sys.platform == "win32":
        return _win_categories()
    elif sys.platform == "darwin":
        return _mac_categories()
    else:
        return _linux_categories()
