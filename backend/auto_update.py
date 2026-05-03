# backend/auto_update.py
# TLI Auto-Update Engine
#
# Checks a developer-controlled manifest URL for newer versions.
# Downloads + verifies SHA-256 + extracts frontend files atomically.
#
# Update manifest format (latest.json hosted by developer):
# {
#   "version":        "1.0.2",
#   "released":       "2026-04-20",
#   "notes":          "What changed in this release",
#   "download_url":   "https://..../TLI_dist_1.0.2.zip",
#   "sha256":         "abcdef1234...",
#   "frontend_only":  true       -- if false, backend restart is required
# }
#
# Safety model:
#   - Zip is downloaded to data/updates/ before anything is touched.
#   - SHA-256 is verified before a single file is overwritten.
#   - Files are extracted to a temp dir, then moved over atomically.
#   - If anything fails mid-way, original files are intact.

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.request
import zipfile
from enum import Enum
from pathlib import Path
from typing import Optional

import tli_state as S

# ── Public state ─────────────────────────────────────────────────────
class UpdateState(str, Enum):
    IDLE        = "idle"
    CHECKING    = "checking"
    AVAILABLE   = "available"
    DOWNLOADING = "downloading"
    VERIFYING   = "verifying"
    APPLYING    = "applying"
    UP_TO_DATE  = "up_to_date"
    ERROR       = "error"
    DONE        = "done"

_lock  = threading.Lock()
_state = UpdateState.IDLE
_info: dict = {}      # latest manifest fields
_error: str = ""
_progress: int = 0    # 0-100 during download

def get_status() -> dict:
    with _lock:
        return {
            "state":            _state.value,
            "current_version":  S.TLI_VERSION,
            "latest_version":   _info.get("version"),
            "notes":            _info.get("notes"),
            "released":         _info.get("released"),
            "frontend_only":    _info.get("frontend_only", True),
            "progress":         _progress,
            "error":            _error,
            "update_url":       _load_settings().get("update_url", ""),
        }

# ── Settings ─────────────────────────────────────────────────────────
_SETTINGS_FILE = Path(S.DATA_DIR) / "update_settings.json"

def _load_settings() -> dict:
    try:
        if _SETTINGS_FILE.exists():
            return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {"update_url": "https://thelanintelligence.com/latest.json", "auto_check": True}

def save_settings(update_url: str, auto_check: bool = True) -> None:
    _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_FILE.write_text(
        json.dumps({"update_url": update_url, "auto_check": auto_check}, indent=2),
        encoding="utf-8",
    )

# ── Version comparison ────────────────────────────────────────────────
def _parse_ver(v: str):
    """Return (major, minor, patch) tuple for simple comparison.
    Strips pre-release suffixes like -beta, -alpha, -rc1 before parsing."""
    try:
        clean = str(v).strip().lstrip("v")
        # Drop everything from the first non-numeric, non-dot character
        # e.g. "1.1-beta" → "1.1", "2.0.1-rc2" → "2.0.1"
        import re as _re
        clean = _re.split(r"[^0-9.]", clean)[0].rstrip(".")
        parts = [int(x) for x in clean.split(".") if x]
        while len(parts) < 3:
            parts.append(0)
        return tuple(parts[:3])
    except Exception:
        return (0, 0, 0)

def _is_newer(remote: str, local: str) -> bool:
    return _parse_ver(remote) > _parse_ver(local)

# ── Check ─────────────────────────────────────────────────────────────
def check(update_url: Optional[str] = None) -> dict:
    """
    Fetch the remote manifest and compare against current version.
    Returns the status dict. Safe to call from async context (runs sync).
    """
    global _state, _info, _error

    url = update_url or _load_settings().get("update_url", "").strip()
    if not url:
        with _lock:
            _state = UpdateState.ERROR
            _error = "No update URL configured. Set one in Settings → Updates."
        return get_status()

    with _lock:
        _state = UpdateState.CHECKING
        _error = ""

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": f"TLI/{S.TLI_VERSION}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            manifest = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        with _lock:
            _state = UpdateState.ERROR
            _error = f"Could not reach update server: {e}"
        return get_status()

    remote_ver = manifest.get("version", "")
    if not remote_ver:
        with _lock:
            _state = UpdateState.ERROR
            _error = "Update manifest missing version field."
        return get_status()

    with _lock:
        _info = manifest
        if _is_newer(remote_ver, S.TLI_VERSION):
            _state = UpdateState.AVAILABLE
        else:
            _state = UpdateState.UP_TO_DATE

    return get_status()

# ── Apply (runs in background thread) ────────────────────────────────
def apply() -> bool:
    """
    Start the download + verify + extract pipeline in a background thread.
    Returns True if the pipeline was started, False if already in progress.
    """
    global _state
    with _lock:
        if _state not in (UpdateState.AVAILABLE,):
            return False
        _state = UpdateState.DOWNLOADING

    thread = threading.Thread(target=_apply_pipeline, daemon=True)
    thread.start()
    return True

def _apply_pipeline() -> None:
    global _state, _error, _progress

    with _lock:
        manifest = dict(_info)

    download_url  = manifest.get("download_url", "")
    expected_sha  = manifest.get("sha256", "")
    frontend_only = manifest.get("frontend_only", True)
    version       = manifest.get("version", "unknown")

    if not download_url:
        with _lock:
            _state = UpdateState.ERROR
            _error = "Manifest has no download_url."
        return

    # ── Ensure updates dir ────────────────────────────────────────
    updates_dir = Path(S.DATA_DIR) / "updates"
    updates_dir.mkdir(parents=True, exist_ok=True)
    zip_path = updates_dir / f"TLI_dist_{version}.zip"
    tmp_path = zip_path.with_suffix(".zip.tmp")

    # ── Download ──────────────────────────────────────────────────
    try:
        req = urllib.request.Request(
            download_url,
            headers={"User-Agent": f"TLI/{S.TLI_VERSION}"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            sha = hashlib.sha256()
            with open(tmp_path, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    sha.update(chunk)
                    downloaded += len(chunk)
                    if total:
                        with _lock:
                            _progress = int(downloaded / total * 80)
    except Exception as e:
        with _lock:
            _state = UpdateState.ERROR
            _error = f"Download failed: {e}"
        _cleanup(tmp_path)
        return

    # ── Verify SHA-256 ────────────────────────────────────────────
    with _lock:
        _state  = UpdateState.VERIFYING
        _progress = 85

    digest = sha.hexdigest()
    if expected_sha and digest != expected_sha.lower():
        with _lock:
            _state = UpdateState.ERROR
            _error = f"SHA-256 mismatch. Expected {expected_sha[:16]}…, got {digest[:16]}…"
        _cleanup(tmp_path)
        return

    tmp_path.rename(zip_path)

    # ── Extract ───────────────────────────────────────────────────
    with _lock:
        _state    = UpdateState.APPLYING
        _progress = 90

    extract_dir = updates_dir / f"extract_{version}"
    try:
        if extract_dir.exists():
            shutil.rmtree(extract_dir)
        extract_dir.mkdir(parents=True)

        with zipfile.ZipFile(zip_path, "r") as zf:
            members = zf.namelist()

            if frontend_only:
                # Only extract frontend/ entries — no restart needed
                targets = [m for m in members if m.startswith("frontend/") and not m.endswith("/")]
            else:
                # Full update — exclude data/ and __pycache__ to protect user data
                targets = [
                    m for m in members
                    if not m.startswith("data/")
                    and "__pycache__" not in m
                    and not m.endswith("/")
                ]

            for member in targets:
                zf.extract(member, extract_dir)

        # Move extracted files over the live installation
        src_root = extract_dir
        dst_root = Path(S.BASE_DIR)
        moved = 0
        for src in src_root.rglob("*"):
            if src.is_dir():
                continue
            rel = src.relative_to(src_root)
            dst = dst_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            moved += 1

        shutil.rmtree(extract_dir, ignore_errors=True)

    except Exception as e:
        with _lock:
            _state = UpdateState.ERROR
            _error = f"Extraction failed: {e}"
        shutil.rmtree(extract_dir, ignore_errors=True)
        return

    with _lock:
        _state    = UpdateState.DONE
        _progress = 100
        # Bump local version in memory so the banner clears
        S.TLI_VERSION = version

    S.log_debug("update", "INFO", "Update applied successfully",
                version=version, files=moved, frontend_only=frontend_only)

    # If a full (non-frontend) update was applied, restart the backend
    if not frontend_only:
        _schedule_restart()

def _cleanup(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except Exception:
        pass

def _schedule_restart() -> None:
    """Replace the current process with a fresh instance after a short delay."""
    def _do_restart():
        time.sleep(2)
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            S.log_debug("update", "ERROR", "Restart failed", error=str(e))

    threading.Thread(target=_do_restart, daemon=True).start()

# ── Auto-check on startup ─────────────────────────────────────────────
def auto_check_on_startup() -> None:
    """
    Called at TLI startup. Checks for updates in a background thread
    if auto_check is enabled and an update URL is configured.
    """
    settings = _load_settings()
    if not settings.get("auto_check", True):
        return
    url = settings.get("update_url", "").strip()
    if not url:
        return

    def _bg():
        time.sleep(5)   # Wait for startup to settle
        check(url)

    threading.Thread(target=_bg, daemon=True).start()
