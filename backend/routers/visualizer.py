from __future__ import annotations

import ctypes
import hashlib
import os
import platform
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

from fastapi import APIRouter, Depends, Query, HTTPException
from routers.system_routes import require_session

try:
    import psutil as _psutil
except ImportError:
    _psutil = None  # type: ignore

visualizer_router = APIRouter(prefix="/visualizer", tags=["visualizer"])

# ---------- scanning helpers ----------

NOISY_DEFAULT = {"node_modules", ".git", "__pycache__", "AppData", "Library", "Cache", "Caches"}

# ---------- OS-aware protected paths ----------

def _protected_prefixes() -> List[str]:
    """
    Paths that must never be offered for deletion.
    Returned as lowercase normalised strings (forward slashes).
    """
    sys = platform.system()
    if sys == "Windows":
        return [
            "c:/windows",
            "c:/program files",
            "c:/program files (x86)",
            "c:/programdata",
            "c:/system volume information",
            "c:/$recycle.bin",
            "c:/recovery",
            "c:/boot",
        ]
    if sys == "Darwin":
        return [
            "/system", "/usr", "/bin", "/sbin", "/private",
            "/library", "/applications", "/volumes/recovery",
            "/cores", "/dev",
        ]
    # Linux / other POSIX
    return [
        "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32",
        "/lib64", "/proc", "/root", "/run", "/sbin", "/sys",
        "/usr", "/var", "/snap", "/opt",
    ]

def _protected_files() -> List[str]:
    """Exact file paths (lowercase, forward slashes) that must never be deleted."""
    if platform.system() == "Windows":
        return ["c:/hiberfil.sys", "c:/pagefile.sys", "c:/swapfile.sys"]
    return []

def is_protected(path_str: str) -> bool:
    lower = path_str.replace("\\", "/").lower().rstrip("/")
    if lower in _protected_files():
        return True
    for p in _protected_prefixes():
        if lower == p or lower.startswith(p + "/"):
            return True
    return False


# ---------- cleanup targets ----------

def _dir_size(p: Path, max_bytes: int = 20 * 1024**3) -> int:
    """Walk p and sum file sizes. Capped at max_bytes to stay fast."""
    total = 0
    try:
        for entry in os.scandir(p):
            if total >= max_bytes:
                break
            try:
                if entry.is_dir(follow_symlinks=False):
                    total += _dir_size(Path(entry.path), max_bytes - total)
                else:
                    total += entry.stat(follow_symlinks=False).st_size
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError):
        pass
    return total


def _cleanup_targets_windows() -> List[Dict[str, Any]]:
    home = Path.home()
    username = home.name
    local_app = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
    win_temp  = Path(os.environ.get("TEMP", local_app / "Temp"))
    sys_temp  = Path("C:/Windows/Temp")

    candidates = [
        {
            "path": str(win_temp), "label": "User Temp folder",
            "tip": "Temporary files created by apps and Windows. Safe to clear.",
            "safety": "auto", "how": "Select all and delete, or run: cleanmgr",
        },
        {
            "path": str(sys_temp), "label": "Windows Temp folder",
            "tip": "System-wide temp files. Safe to clear (may need admin).",
            "safety": "auto", "how": "Delete contents as Administrator",
        },
        {
            "path": str(home / "Downloads"), "label": "Downloads",
            "tip": "Installers, zip files, and downloads you may no longer need.",
            "safety": "manual", "how": "Review and delete files you no longer need",
        },
        {
            "path": str(local_app / "Microsoft" / "Windows" / "INetCache"),
            "label": "Browser / IE cache",
            "tip": "Internet Explorer and Edge legacy cache.",
            "safety": "auto", "how": "Delete contents, or run: cleanmgr",
        },
        {
            "path": str(Path("C:/Windows/SoftwareDistribution/Download")),
            "label": "Windows Update cache",
            "tip": "Downloaded update packages. Safe to clear after updates complete.",
            "safety": "manual", "how": "Stop Windows Update service, delete contents, restart service",
        },
        {
            "path": str(local_app / "Google" / "Chrome" / "User Data" / "Default" / "Cache"),
            "label": "Chrome cache",
            "tip": "Google Chrome browser cache. Chrome will rebuild it.",
            "safety": "auto", "how": "Clear from Chrome Settings → Privacy → Clear browsing data",
        },
    ]
    return candidates


def _cleanup_targets_mac() -> List[Dict[str, Any]]:
    home = Path.home()
    return [
        {
            "path": str(home / "Library" / "Caches"), "label": "User app caches",
            "tip": "Per-app cache files in ~/Library/Caches. Most apps rebuild these.",
            "safety": "auto", "how": "Delete subdirectory contents individually",
        },
        {
            "path": str(home / "Library" / "Logs"), "label": "User log files",
            "tip": "Application logs written by macOS apps.",
            "safety": "auto", "how": "Delete .log files you don't need",
        },
        {
            "path": str(home / ".Trash"), "label": "Trash",
            "tip": "Files you've already moved to Trash.",
            "safety": "auto", "how": "Empty Trash from Finder",
        },
        {
            "path": str(home / "Downloads"), "label": "Downloads",
            "tip": "Downloaded files and installers.",
            "safety": "manual", "how": "Review and delete what you no longer need",
        },
        {
            "path": str(home / "Library" / "Developer" / "Xcode" / "DerivedData"),
            "label": "Xcode derived data",
            "tip": "Xcode build artifacts. Large and safe to delete if not actively building.",
            "safety": "manual", "how": "Delete from Xcode → Preferences → Locations, or rm -rf",
        },
        {
            "path": "/private/var/folders", "label": "System caches (/private/var/folders)",
            "tip": "Temporary system caches. Cleared on reboot. Informational only.",
            "safety": "caution", "how": "Let the OS manage these — reboot to clear",
        },
    ]


def _cleanup_targets_linux() -> List[Dict[str, Any]]:
    home = Path.home()
    return [
        {
            "path": str(home / ".cache"), "label": "User cache (~/.cache)",
            "tip": "Per-app cache files. Applications rebuild these as needed.",
            "safety": "auto", "how": "rm -rf ~/.cache/*",
        },
        {
            "path": "/tmp", "label": "System temp (/tmp)",
            "tip": "Temporary files cleared on reboot. Safe to review.",
            "safety": "auto", "how": "Files are removed on reboot, or: rm -rf /tmp/*",
        },
        {
            "path": "/var/cache/apt", "label": "APT package cache",
            "tip": "Cached .deb packages from apt. Safe to clear after upgrades.",
            "safety": "auto", "how": "sudo apt clean",
        },
        {
            "path": str(home / ".local" / "share" / "Trash"), "label": "Trash",
            "tip": "Files moved to trash by file manager.",
            "safety": "auto", "how": "Empty trash from file manager, or: rm -rf ~/.local/share/Trash/*",
        },
        {
            "path": str(home / "Downloads"), "label": "Downloads",
            "tip": "Downloaded files and archives.",
            "safety": "manual", "how": "Review and delete what you no longer need",
        },
        {
            "path": "/var/log", "label": "System logs (/var/log)",
            "tip": "System and service log files. Old rotated logs are safe to remove.",
            "safety": "caution", "how": "sudo journalctl --vacuum-size=200M  or remove old *.gz logs",
        },
    ]


def get_cleanup_targets() -> List[Dict[str, Any]]:
    sys = platform.system()
    if sys == "Windows":
        candidates = _cleanup_targets_windows()
    elif sys == "Darwin":
        candidates = _cleanup_targets_mac()
    else:
        candidates = _cleanup_targets_linux()

    results = []
    for c in candidates:
        p = Path(c["path"])
        exists = p.exists()
        size_bytes = _dir_size(p) if exists else 0
        results.append({
            **c,
            "exists": exists,
            "size_bytes": size_bytes,
            "size_mb": round(size_bytes / (1024 ** 2), 1),
        })

    # Sort: largest first, non-existent last
    results.sort(key=lambda x: (-x["size_bytes"], not x["exists"]))
    return results

def _expand_user_path(raw: str) -> Path:
    # Support ~/ on Windows/macOS/Linux
    raw = (raw or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="path is required")
    # Allow forward slashes on Windows
    raw = raw.replace("\\", os.sep).replace("/", os.sep)
    p = Path(os.path.expandvars(os.path.expanduser(raw))).resolve()
    return p

def _safe_scandir(p: Path):
    try:
        return list(os.scandir(p))
    except Exception:
        return []

def _scan_tree(root: Path, max_entries: int = 120_000, max_depth: int = 18, noisy_names: Optional[set] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Dict[str, Any]]:
    """
    Returns (tree, largest_items, meta)
    Tree format matches app.js expectations: {name, path, size, children:[...]}
    """
    noisy_names = noisy_names or set(NOISY_DEFAULT)
    started = time.time()
    entries_seen = 0
    denied = 0
    files_count = 0
    dirs_count = 0

    # Track largest files across scan
    largest: List[Dict[str, Any]] = []

    def push_largest(item: Dict[str, Any]):
        largest.append(item)
        largest.sort(key=lambda x: x.get("size", 0), reverse=True)
        # Keep top 200 to keep payload sane
        if len(largest) > 200:
            del largest[200:]

    def walk_dir(p: Path, depth: int) -> Dict[str, Any]:
        nonlocal entries_seen, denied, files_count, dirs_count

        node: Dict[str, Any] = {"name": p.name or str(p), "path": str(p), "size": 0, "children": []}

        if depth > max_depth:
            return node

        try:
            scandir_items = _safe_scandir(p)
        except Exception:
            denied += 1
            return node

        # Stop if we hit a hard limit
        if entries_seen >= max_entries:
            return node

        children: List[Dict[str, Any]] = []
        total = 0

        for entry in scandir_items:
            if entries_seen >= max_entries:
                break
            entries_seen += 1

            try:
                name = entry.name
                # Skip obvious noisy dirs
                if entry.is_dir(follow_symlinks=False) and name in noisy_names:
                    continue

                full = Path(entry.path)

                if entry.is_dir(follow_symlinks=False):
                    dirs_count += 1
                    child = walk_dir(full, depth + 1)
                    if is_protected(str(full)):
                        child["protected"] = True
                    if child.get("size", 0) > 0 or child.get("children"):
                        children.append(child)
                        total += int(child.get("size", 0) or 0)
                else:
                    # file
                    files_count += 1
                    try:
                        sz = entry.stat(follow_symlinks=False).st_size
                    except Exception:
                        denied += 1
                        sz = 0

                    file_node = {"name": name, "path": str(full), "size": int(sz)}
                    if is_protected(str(full)):
                        file_node["protected"] = True
                    children.append(file_node)
                    total += int(sz)

                    if sz and not file_node.get("protected"):
                        push_largest({"name": name, "path": str(full), "size": int(sz)})

            except Exception:
                denied += 1
                continue

        # Sort children by size desc and cap per directory to keep payload manageable
        children.sort(key=lambda x: x.get("size", 0), reverse=True)
        if len(children) > 2500:
            # collapse the rest into a synthetic bucket so treemap remains usable
            rest = children[2500:]
            rest_size = sum(int(c.get("size", 0) or 0) for c in rest)
            children = children[:2500]
            children.append({"name": f"(+{len(rest)} more)", "path": str(p / "__MORE__"), "size": int(rest_size)})

        node["children"] = children
        node["size"] = int(total)
        return node

    tree = walk_dir(root, 0)
    meta = {
        "root": str(root),
        "seconds": round(time.time() - started, 3),
        "entries_seen": entries_seen,
        "files": files_count,
        "dirs": dirs_count,
        "denied": denied,
        "max_entries": max_entries,
        "max_depth": max_depth,
    }
    return tree, largest[:50], meta

# ---------- routes ----------

@visualizer_router.get("/treemap")
def treemap(
    path: str = Query(..., description="Folder path to scan"),
    width: int = Query(1200, ge=200, le=8000),
    max_entries: int = Query(50_000, ge=5_000, le=100_000),
    max_depth: int = Query(18, ge=4, le=30),
    _session: str = Depends(require_session),
):
    root = _expand_user_path(path)
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {root}")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Path must be a directory")

    tree, largest, meta = _scan_tree(root, max_entries=max_entries, max_depth=max_depth)
    meta["width_hint"] = width
    return {"tree": tree, "largest": largest, "meta": meta}

# Back-compat alias (some builds call this)
@visualizer_router.get("/scan")
def scan_alias(path: str = Query(...), width: int = Query(1200), _session: str = Depends(require_session)):
    return treemap(path=path, width=width, _session=_session)

# Older frontend alias (some builds call this)
@visualizer_router.get("/scan_directory")
def scan_directory(path: str = Query(...), _session: str = Depends(require_session)):
    # Return raw tree directly to match app.js renderTreemap(data)
    root = _expand_user_path(path)
    if not root.exists():
        raise HTTPException(status_code=404, detail="Not Found")
    tree, largest, meta = _scan_tree(root)
    return tree


@visualizer_router.get("/open_in_files")
def open_in_files(path: str = Query(..., description="Path to reveal in the Files panel")):
    """
    Signal the frontend to navigate to the Files panel at the given path.
    The actual panel switch happens client-side; this endpoint just acknowledges
    the request so the frontend can show a success toast.
    """
    # Validate the path exists (best effort — don't 404 if inaccessible)
    try:
        p = _expand_user_path(path)
        exists = p.exists()
    except Exception:
        exists = False
    return {"ok": True, "path": path, "exists": exists}


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
def cleanup_targets_endpoint():
    """
    OS-aware list of safe-to-clean directories with real sizes.
    Used by the frontend Visualizer to populate the Cleanup panel
    without needing a full drive scan first.
    """
    return {
        "os": platform.system(),
        "targets": get_cleanup_targets(),
        "protected_prefixes": _protected_prefixes(),
    }


# ---------- large-file hunt ----------

def _collect_large_files(
    root: Path,
    min_bytes: int,
    limit: int,
    max_entries: int = 500_000,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Walk root and return the largest files above min_bytes, sorted desc."""
    started    = time.time()
    entries    = 0
    denied     = 0
    results: List[Dict[str, Any]] = []
    noisy      = set(NOISY_DEFAULT)

    def _walk(p: Path) -> None:
        nonlocal entries, denied
        if entries >= max_entries:
            return
        try:
            items = list(os.scandir(p))
        except (PermissionError, OSError):
            denied += 1
            return
        for e in items:
            if entries >= max_entries:
                break
            entries += 1
            try:
                name = e.name
                if e.is_dir(follow_symlinks=False):
                    if name in noisy or is_protected(e.path):
                        continue
                    _walk(Path(e.path))
                else:
                    if is_protected(e.path):
                        continue
                    sz = e.stat(follow_symlinks=False).st_size
                    if sz >= min_bytes:
                        results.append({"name": name, "path": e.path, "size": sz})
            except (PermissionError, OSError):
                denied += 1

    _walk(root)
    results.sort(key=lambda x: x["size"], reverse=True)
    top = results[:limit]
    total_bytes = sum(f["size"] for f in top)
    meta = {
        "root": str(root),
        "seconds": round(time.time() - started, 3),
        "entries_seen": entries,
        "denied": denied,
        "min_bytes": min_bytes,
        "found": len(results),
        "returned": len(top),
        "total_bytes": total_bytes,
        "total_mb": round(total_bytes / (1024 ** 2), 1),
    }
    return top, meta


@visualizer_router.get("/large-files")
def large_files(
    path: str = Query(..., description="Root folder to search"),
    min_mb: float = Query(100.0, ge=1.0, le=50_000.0, description="Minimum file size in MB"),
    limit: int = Query(200, ge=10, le=2000),
):
    """Return files above min_mb, sorted largest-first. Excludes protected system paths."""
    root = _expand_user_path(path)
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {root}")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Path must be a directory")
    min_bytes = int(min_mb * 1024 * 1024)
    files, meta = _collect_large_files(root, min_bytes=min_bytes, limit=limit)
    return {"files": files, "meta": meta}


# ---------- duplicate finder ----------

def _fast_hash(p: Path, sample_bytes: int = 65_536) -> Optional[str]:
    """
    Hash first + last sample_bytes of a file for fast near-certain dedup.
    Falls back to full hash for small files.
    """
    try:
        size = p.stat().st_size
        h = hashlib.md5(usedforsecurity=False)
        with p.open("rb") as f:
            if size <= sample_bytes * 2:
                h.update(f.read())
            else:
                h.update(f.read(sample_bytes))
                f.seek(-sample_bytes, 2)
                h.update(f.read(sample_bytes))
        return h.hexdigest()
    except (PermissionError, OSError, ValueError):
        return None


def _find_duplicates(
    root: Path,
    max_entries: int = 300_000,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Two-pass duplicate detection:
    Pass 1 — group by size (no I/O beyond scandir stats)
    Pass 2 — hash only files that share a size
    Returns groups of 2+ identical files sorted by wasted space desc.
    """
    started = time.time()
    entries = 0
    denied  = 0
    noisy   = set(NOISY_DEFAULT)

    # Pass 1: collect all files grouped by size
    by_size: Dict[int, List[str]] = {}

    def _walk(p: Path) -> None:
        nonlocal entries, denied
        if entries >= max_entries:
            return
        try:
            items = list(os.scandir(p))
        except (PermissionError, OSError):
            denied += 1
            return
        for e in items:
            if entries >= max_entries:
                break
            entries += 1
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.name in noisy or is_protected(e.path):
                        continue
                    _walk(Path(e.path))
                else:
                    if is_protected(e.path):
                        continue
                    sz = e.stat(follow_symlinks=False).st_size
                    if sz < 4096:          # skip tiny files — not worth deduping
                        continue
                    by_size.setdefault(sz, []).append(e.path)
            except (PermissionError, OSError):
                denied += 1

    _walk(root)

    # Pass 2: hash candidates (only files with a shared size)
    by_hash: Dict[str, List[str]] = {}
    hashed = 0
    for sz, paths in by_size.items():
        if len(paths) < 2:
            continue
        for fp in paths:
            h = _fast_hash(Path(fp))
            if h:
                by_hash.setdefault(h, []).append(fp)
                hashed += 1

    # Build groups
    groups: List[Dict[str, Any]] = []
    total_wasted = 0
    for paths in by_hash.values():
        if len(paths) < 2:
            continue
        sz = Path(paths[0]).stat().st_size if Path(paths[0]).exists() else 0
        wasted = sz * (len(paths) - 1)
        total_wasted += wasted
        groups.append({
            "size": sz,
            "count": len(paths),
            "wasted_bytes": wasted,
            "paths": paths,
        })

    groups.sort(key=lambda g: g["wasted_bytes"], reverse=True)
    top_groups = groups[:100]

    meta = {
        "root": str(root),
        "seconds": round(time.time() - started, 3),
        "entries_seen": entries,
        "denied": denied,
        "files_hashed": hashed,
        "groups_found": len(groups),
        "total_wasted_bytes": total_wasted,
        "total_wasted_mb": round(total_wasted / (1024 ** 2), 1),
    }
    return top_groups, meta


@visualizer_router.get("/duplicates")
def duplicates(
    path: str = Query(..., description="Root folder to search for duplicates"),
):
    """Find duplicate files by content (size + fast hash). Returns groups of identical files."""
    root = _expand_user_path(path)
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {root}")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Path must be a directory")
    groups, meta = _find_duplicates(root)
    return {"groups": groups, "meta": meta}


# ---------- drive enumeration ----------

def _bytes_human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def _win_volume_label(mountpoint: str) -> str:
    """Return the Windows volume label for a drive letter (e.g. 'C:\\')."""
    if platform.system() != "Windows":
        return ""
    try:
        buf = ctypes.create_unicode_buffer(261)
        ctypes.windll.kernel32.GetVolumeInformationW(  # type: ignore[attr-defined]
            ctypes.c_wchar_p(mountpoint), buf, 261,
            None, None, None, None, 0,
        )
        return buf.value or ""
    except Exception:
        return ""


def _win_drive_type(mountpoint: str) -> str:
    """DRIVE_UNKNOWN=0,NO_ROOT=1,REMOVABLE=2,FIXED=3,REMOTE=4,CDROM=5,RAMDISK=6"""
    if platform.system() != "Windows":
        return "fixed"
    _type_map = {0: "unknown", 1: "unknown", 2: "removable",
                 3: "fixed", 4: "network", 5: "cdrom", 6: "ram"}
    try:
        t = ctypes.windll.kernel32.GetDriveTypeW(ctypes.c_wchar_p(mountpoint))  # type: ignore[attr-defined]
        return _type_map.get(t, "unknown")
    except Exception:
        return "unknown"


def _safe_disk_usage(mountpoint: str, timeout_s: float = 2.0):
    """
    Call shutil.disk_usage() in a thread so we can impose a timeout.
    Network drives that are disconnected can block for 20+ seconds otherwise.
    Returns None on timeout or error.
    """
    result: list = [None]
    exc: list    = [None]

    def _worker():
        try:
            result[0] = shutil.disk_usage(mountpoint)
        except Exception as e:
            exc[0] = e

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        return None          # timed out
    if exc[0] is not None:
        return None          # errored
    return result[0]


def _enumerate_drives() -> List[Dict[str, Any]]:
    """
    Enumerate all connected drives/partitions with labels, types, and usage.
    Uses a per-drive timeout so disconnected network mounts don't stall the response.
    """
    sys_name = platform.system()
    results: List[Dict[str, Any]] = []

    # ── Collect partition list ──────────────────────────────────────────────
    partitions = []
    if _psutil:
        try:
            partitions = _psutil.disk_partitions(all=False)
        except Exception:
            pass

    if not partitions:
        # Fallback: just report the home-directory drive
        try:
            u = shutil.disk_usage(Path.home())
            results.append({
                "mountpoint": str(Path.home()), "device": "",
                "label": "", "drive_type": "fixed", "fstype": "",
                "total_bytes": u.total, "used_bytes": u.used, "free_bytes": u.free,
                "percent_used": round(u.used / max(u.total, 1) * 100, 1),
                "total_human": _bytes_human(u.total),
                "used_human":  _bytes_human(u.used),
                "free_human":  _bytes_human(u.free),
            })
        except Exception:
            pass
        return results

    _PSEUDO_FS = frozenset({
        "tmpfs", "devtmpfs", "sysfs", "proc", "cgroup", "cgroup2",
        "securityfs", "pstore", "efivarfs", "bpf", "debugfs", "tracefs",
        "hugetlbfs", "mqueue", "fusectl", "squashfs", "overlay", "devpts",
    })

    seen: set = set()
    for part in partitions:
        mp = part.mountpoint
        if not mp or mp in seen:
            continue
        seen.add(mp)

        # Skip pseudo filesystems on Linux/macOS
        if sys_name != "Windows" and (part.fstype or "") in _PSEUDO_FS:
            continue

        # Get usage with timeout — skips slow/offline network mounts
        u = _safe_disk_usage(mp, timeout_s=2.0)
        if u is None or u.total == 0:
            continue

        # ── Drive label and type ──────────────────────────────────────────
        if sys_name == "Windows":
            label      = _win_volume_label(mp)
            drive_type = _win_drive_type(mp)
        else:
            fstype = part.fstype or ""
            opts   = (part.opts or "").lower()
            if "network" in fstype or fstype in ("nfs", "cifs", "smb", "smbfs", "afpfs", "sshfs"):
                drive_type = "network"
            elif "fuse" in fstype or "removable" in opts or "usb" in opts:
                drive_type = "removable"
            elif fstype in ("iso9660", "udf"):
                drive_type = "cdrom"
            else:
                drive_type = "fixed"
            label = ""

        pct = round(u.used / max(u.total, 1) * 100, 1)
        results.append({
            "mountpoint":   mp,
            "device":       part.device or mp,
            "label":        label,
            "drive_type":   drive_type,
            "fstype":       part.fstype or "",
            "total_bytes":  u.total,
            "used_bytes":   u.used,
            "free_bytes":   u.free,
            "percent_used": pct,
            "total_human":  _bytes_human(u.total),
            "used_human":   _bytes_human(u.used),
            "free_human":   _bytes_human(u.free),
        })

    _order = {"fixed": 0, "removable": 1, "network": 2, "cdrom": 3, "unknown": 4, "ram": 5}
    results.sort(key=lambda d: (_order.get(d["drive_type"], 9), d["mountpoint"]))
    return results


@visualizer_router.get("/drives")
def list_drives():
    """
    Enumerate all connected drives/partitions with labels, types, and usage.
    Used by the Visualizer 'This PC' landing view.
    Per-drive timeout prevents disconnected network mounts from blocking the response.
    """
    try:
        drives = _enumerate_drives()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Drive enumeration failed: {exc}") from exc
    return {"os": platform.system(), "drives": drives}


@visualizer_router.get("/paths")
def common_paths():
    """
    Returns the real home directory and standard user folders for this machine.
    Used by the frontend to pre-populate path inputs without the user having to
    know or type their own filesystem paths.
    """
    home = Path.home()
    sys_name = platform.system()

    def _p(*parts) -> Optional[str]:
        """Return path string only if the directory exists."""
        try:
            p = Path(*parts)
            return str(p) if p.is_dir() else None
        except Exception:
            return None

    # Common folders — present on all OSes (under home)
    common = {
        "home":      str(home),
        "downloads": _p(home, "Downloads"),
        "desktop":   _p(home, "Desktop"),
        "documents": _p(home, "Documents"),
        "pictures":  _p(home, "Pictures"),
        "videos":    _p(home, "Videos") or _p(home, "Movies"),
        "music":     _p(home, "Music"),
    }

    # OS-specific extras
    extras: List[Dict[str, str]] = []
    if sys_name == "Windows":
        for label, path in [
            ("OneDrive", str(home / "OneDrive")),
            ("iCloudDrive", str(home / "iCloudDrive")),
            ("Google Drive", str(home / "Google Drive")),
            ("Dropbox", str(home / "Dropbox")),
        ]:
            if Path(path).is_dir():
                extras.append({"label": label, "path": path})
    elif sys_name == "Darwin":
        for label, path in [
            ("iCloud Drive", str(home / "Library/Mobile Documents/com~apple~CloudDocs")),
            ("Dropbox", str(home / "Dropbox")),
            ("Google Drive", str(home / "Google Drive")),
        ]:
            if Path(path).is_dir():
                extras.append({"label": label, "path": path})
    else:
        for label, path in [
            ("Dropbox",      str(home / "Dropbox")),
            ("Google Drive", str(home / "GoogleDrive")),
            ("Google Drive", str(home / "gdrive")),
            ("Google Drive", str(home / "Google Drive")),
        ]:
            p = Path(path)
            if p.is_dir() and not any(e["path"] == path for e in extras):
                extras.append({"label": label, "path": path})

    return {
        "os":     sys_name,
        "home":   str(home),
        "common": {k: v for k, v in common.items() if v},
        "extras": extras,
    }
