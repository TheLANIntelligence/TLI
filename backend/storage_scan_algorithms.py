"""Pure storage readers. No application, authentication, persistence or action imports.

Every production reader runs inside storage_scan_worker. The callable helpers
remain available for isolated tests and reviewed cleanup's identity hashing.
"""
from __future__ import annotations
import ctypes
import hashlib
import heapq
import json
import ntpath
import os
import platform
import shutil
import stat
import threading
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
try:
    import psutil as _psutil
except ImportError:
    _psutil = None
NOISY_DEFAULT = {"node_modules", ".git", "__pycache__", "AppData", "Library", "Cache", "Caches"}
CONTROL = None
class ScanError(Exception):
    def __init__(self, status_code=400, detail="Scan unavailable"):
        self.status_code, self.detail = status_code, detail
        super().__init__(detail)
class ScanCancelled(BaseException):
    pass
def checkpoint(**progress):
    if CONTROL is not None:
        CONTROL(**progress)


def _is_reparse(info) -> bool:
    return bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _entry_info(entry):
    info = entry.stat(follow_symlinks=False)
    # Windows DirEntry's cached stat omits inode/device/link count. A path stat
    # is necessary for hard-link accounting; never substitute an invented ID.
    if os.name == "nt" and hasattr(info, "st_ino") and not info.st_ino:
        info = os.stat(entry.path, follow_symlinks=False)
    return info


def _timestamp(value):
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z") if value is not None else None
    except (OSError, OverflowError, TypeError, ValueError):
        return None


_CATEGORIES = {
    "documents": {".pdf", ".doc", ".docx", ".odt", ".txt", ".rtf", ".ppt", ".pptx", ".xls", ".xlsx"},
    "images": {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".raw", ".svg", ".tif", ".tiff", ".bmp"},
    "video": {".mp4", ".mkv", ".mov", ".avi", ".webm", ".wmv", ".m4v"},
    "audio": {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".aiff"},
    "archives": {".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".iso"},
    "apps": {".exe", ".msi", ".dll", ".sys", ".dmg", ".app", ".deb", ".rpm"},
    "models": {".gguf", ".ggml", ".safetensors", ".onnx", ".pt", ".pth"},
    "code": {".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".cpp", ".c", ".h", ".rs", ".go", ".java"},
    "data": {".db", ".sqlite", ".sqlite3", ".csv", ".parquet", ".json", ".log", ".vhd", ".vhdx", ".bak"},
}


def _file_metadata(path, info):
    extension = path.suffix.lower()[:80]
    return {"kind": "file", "extension": extension,
            "category": next((name for name, suffixes in _CATEGORIES.items() if extension in suffixes), "other"),
            "modified_at": _timestamp(getattr(info, "st_mtime", None)),
            "created_at": _timestamp(getattr(info, "st_birthtime", None)), "files": 1}


@lru_cache(maxsize=1)
def _windows_allocation_api():
    from ctypes import wintypes
    class StandardInfo(ctypes.Structure):
        _fields_ = [("AllocationSize", ctypes.c_longlong), ("EndOfFile", ctypes.c_longlong),
                    ("NumberOfLinks", wintypes.DWORD), ("DeletePending", ctypes.c_ubyte), ("Directory", ctypes.c_ubyte)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    return kernel, StandardInfo


def _windows_allocated_size(path, info):
    """Read FILE_STANDARD_INFO using a metadata-only, non-following handle.

    Supported Win32 API, no raw volume/MFT access or elevation. Denied/unsupported
    allocation remains unknown. Sparse/compressed allocation is obtained from
    the filesystem, never guessed by rounding logical bytes to cluster size.
    https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info
    """
    kernel, StandardInfo = _windows_allocation_api()
    # FILE_READ_ATTRIBUTES, share read/write/delete, OPEN_EXISTING,
    # FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL.
    handle = kernel.CreateFileW(str(path), 0x80, 7, None, 3, 0x00200000 | 0x00100000, None)
    if handle == ctypes.c_void_p(-1).value:
        return None
    try:
        value = StandardInfo()
        if not kernel.GetFileInformationByHandleEx(handle, 1, ctypes.byref(value), ctypes.sizeof(value)):
            return None
        if value.Directory or value.DeletePending or value.EndOfFile != info.st_size or value.AllocationSize < 0:
            return None
        return int(value.AllocationSize)
    finally:
        kernel.CloseHandle(handle)


def _allocated_size(path, info):
    try:
        if info is None or _is_reparse(info):
            return None
        if os.name == "nt":
            return _windows_allocated_size(path, info)
        blocks = getattr(info, "st_blocks", None)
        return int(blocks) * 512 if blocks is not None and blocks >= 0 else None
    except (OSError, AttributeError, ValueError):
        return None


def _scanner_metadata():
    return {"engine": "scandir", "mft": False,
            "allocation_method": "GetFileInformationByHandleEx/FileStandardInfo" if os.name == "nt" else "stat.st_blocks",
            "limitations": ["Bounded directory enumeration; direct NTFS MFT scanning is not implemented.",
                            "Links and reparse points are excluded. Unreadable entries leave incomplete coverage.",
                            "Allocation excludes filesystem metadata and unenumerated alternate data streams; shared extents may overlap.",
                            "Hard-link bytes belong to the first observed name; folder attribution can change between scans."]}


def _resolve_root(raw: str) -> Path:
    """Expand lexically, then reject linked roots/ancestors before inspection.

    Never call resolve(): doing so would erase the link that must be rejected.
    All metadata probes here run only in the owned read worker in production.
    """
    raw = (raw or "").strip()
    if not raw:
        raise ScanError(400, "Choose a folder")
    expanded = os.path.expandvars(os.path.expanduser(raw.replace("\\", os.sep).replace("/", os.sep)))
    root = Path(os.path.abspath(expanded))
    for part in [*reversed(root.parents), root]:
        checkpoint(phase="checking_path")
        try:
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or _is_reparse(info) or (hasattr(part, "is_junction") and part.is_junction()):
                raise ScanError(422, "Linked folders and junctions are not inspected. Choose their real location explicitly.")
        except FileNotFoundError:
            # A missing lexical ancestor makes the remaining path unavailable;
            # no later component can be inspected without following it.
            break
        except OSError:
            raise ScanError(422, "The selected path could not be inspected safely.") from None
    return root


def _protected_prefixes() -> List[str]:
    """
    Paths that must never be offered for deletion.
    Returned as lowercase normalised strings (forward slashes).
    """
    sys = platform.system()
    if sys == "Windows":
        defaults = [
            "c:/windows",
            "c:/program files",
            "c:/program files (x86)",
            "c:/programdata",
            "c:/system volume information",
            "c:/$recycle.bin",
            "c:/recovery",
            "c:/boot",
        ]
        for key in ("SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
            value = os.environ.get(key)
            if value:
                normalized = value.replace("\\", "/").lower().rstrip("/")
                if normalized not in defaults:
                    defaults.append(normalized)
        return defaults
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
    if platform.system() == "Windows":
        drive, tail = ntpath.splitdrive(lower)
        # System locations on secondary/external Windows volumes deserve the
        # same protection as C:. This classifies only; inspection remains legal.
        if drive and tail.startswith("/"):
            first = tail.lstrip("/").split("/", 1)[0]
            if first in {"windows", "program files", "program files (x86)", "programdata", "system volume information",
                         "$recycle.bin", "recovery", "boot", "efi", "hiberfil.sys", "pagefile.sys", "swapfile.sys", "bootmgr"}:
                return True
    if lower in _protected_files():
        return True
    for p in _protected_prefixes():
        if lower == p or lower.startswith(p + "/"):
            return True
    return False

def _measure_cleanup(p: Path, *, deadline: float, max_entries: int = 10000,
                     max_bytes: int = 20 * 1024**3) -> tuple[int, dict]:
    """Bounded, read-only estimate. Limits and unreadable entries stay visible.

    The deadline is cooperative; an individual filesystem call may still block.
    """
    total = 0
    meta = {"partial": False, "denied": 0, "skipped": 0,
            "entry_limited": False, "time_limited": False, "byte_limited": False, "hardlinks_skipped": 0}
    identities = set()
    pending = [p]
    entries = 0
    try:
        p = _resolve_root(str(p))
        if p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()):
            meta.update(partial=True, skipped=1)
            return 0, meta
    except (OSError, ScanError):
        meta.update(partial=True, denied=1)
        return 0, meta
    while pending:
        checkpoint(phase="common_folders", entries_seen=entries)
        if time.monotonic() >= deadline:
            meta["time_limited"] = True
            break
        current = pending.pop()
        try:
            with os.scandir(current) as iterator:
                for entry in iterator:
                    checkpoint(phase="common_folders", entries_seen=entries)
                    if time.monotonic() >= deadline:
                        meta["time_limited"] = True
                        break
                    if entries >= max_entries:
                        meta["entry_limited"] = True
                        break
                    if total >= max_bytes:
                        meta["byte_limited"] = True
                        break
                    entries += 1
                    try:
                        child = Path(entry.path)
                        info = _entry_info(entry)
                        if entry.is_symlink() or _is_reparse(info) or (hasattr(child, "is_junction") and child.is_junction()):
                            meta["skipped"] += 1
                        elif entry.is_dir(follow_symlinks=False):
                            pending.append(child)
                        elif entry.is_file(follow_symlinks=False):
                            identity = (getattr(info, "st_dev", 0), getattr(info, "st_ino", 0))
                            if identity[1] and identity in identities:
                                meta["hardlinks_skipped"] += 1
                            else:
                                if identity[1]:
                                    identities.add(identity)
                                total += info.st_size
                    except OSError:
                        meta["denied"] += 1
        except OSError:
            meta["denied"] += 1
        if any(meta[key] for key in ("time_limited", "entry_limited", "byte_limited")):
            break
    meta["partial"] = any(meta[key] for key in ("denied", "skipped", "entry_limited", "time_limited", "byte_limited"))
    return total, meta

def _dir_size(p: Path, max_bytes: int = 20 * 1024**3) -> int:
    # Retain the internal numeric helper for existing callers.
    return _measure_cleanup(p, deadline=time.monotonic() + 1, max_bytes=max_bytes)[0]

def _cleanup_targets_windows() -> List[Dict[str, Any]]:
    home = Path.home()
    username = home.name
    local_app = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
    win_temp  = Path(os.environ.get("TEMP", local_app / "Temp"))
    sys_temp  = Path("C:/Windows/Temp")

    candidates = [
        {
            "path": str(win_temp), "label": "User Temp folder",
            "tip": "Temporary files created by apps and Windows. Some may still be in use.",
            "safety": "auto", "how": "Review Temporary files in Windows Storage settings or Disk Cleanup; select only categories you understand.",
        },
        {
            "path": str(sys_temp), "label": "Windows Temp folder",
            "tip": "System temporary files. Let Windows identify eligible cleanup items.",
            "safety": "auto", "how": "Review system files through Windows Disk Cleanup.",
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
            "safety": "auto", "how": "Review temporary internet files through Windows Disk Cleanup.",
        },
        {
            "path": str(Path("C:/Windows/SoftwareDistribution/Download")),
            "label": "Windows Update cache",
            "tip": "Downloaded update packages. Windows decides which update files can be removed.",
            "safety": "manual", "how": "Use Windows Storage settings or Disk Cleanup to review eligible update cleanup.",
        },
        {
            "path": str(local_app / "Google" / "Chrome" / "User Data" / "Default" / "Cache"),
            "label": "Chrome cache",
            "tip": "Google Chrome browser cache. Chrome will rebuild it.",
            "safety": "auto", "how": "Clear from Chrome Settings â†’ Privacy â†’ Clear browsing data",
        },
    ]
    return candidates

def _cleanup_targets_mac() -> List[Dict[str, Any]]:
    home = Path.home()
    return [
        {
            "path": str(home / "Library" / "Caches"), "label": "User app caches",
            "tip": "Per-app cache files in ~/Library/Caches. Most apps rebuild these.",
            "safety": "auto", "how": "Use the owning appâ€™s cache controls; close the app first and keep data needed offline.",
        },
        {
            "path": str(home / "Library" / "Logs"), "label": "User log files",
            "tip": "Application logs written by macOS apps.",
            "safety": "auto", "how": "Delete .log files you don't need",
        },
        {
            "path": str(home / ".Trash"), "label": "Trash",
            "tip": "Files you've already moved to Trash.",
            "safety": "manual", "how": "Review Trash in Finder before emptying it. Emptying permanently removes those files.",
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
            "safety": "manual", "how": "Review derived data through Xcode after closing active builds.",
        },
        {
            "path": "/private/var/folders", "label": "System caches (/private/var/folders)",
            "tip": "Temporary system caches. Cleared on reboot. Informational only.",
            "safety": "caution", "how": "Let macOS manage these system files.",
        },
    ]

def _cleanup_targets_linux() -> List[Dict[str, Any]]:
    home = Path.home()
    return [
        {
            "path": str(home / ".cache"), "label": "User cache (~/.cache)",
            "tip": "Per-app cache files. Applications rebuild these as needed.",
            "safety": "auto", "how": "Use the owning appâ€™s cache controls; close the app first and keep data needed offline.",
        },
        {
            "path": "/tmp", "label": "System temp (/tmp)",
            "tip": "Temporary files cleared on reboot. Safe to review.",
            "safety": "auto", "how": "Let the operating system manage temporary files; active apps may still need them.",
        },
        {
            "path": "/var/cache/apt", "label": "APT package cache",
            "tip": "Cached .deb packages from apt. Safe to clear after upgrades.",
            "safety": "auto", "how": "sudo apt clean",
        },
        {
            "path": str(home / ".local" / "share" / "Trash"), "label": "Trash",
            "tip": "Files moved to trash by file manager.",
            "safety": "manual", "how": "Review Trash in your file manager before emptying it. Emptying permanently removes those files.",
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
    deadline = time.monotonic() + 5
    for c in candidates:
        p = Path(c["path"])
        try:
            checkpoint(phase="common_folders")
            p = _resolve_root(str(p))
            p.stat()
            exists = True
            size_bytes, meta = _measure_cleanup(p, deadline=min(deadline, time.monotonic() + 1))
        except ScanCancelled:
            break
        except FileNotFoundError:
            exists, size_bytes, meta = False, 0, {"partial": False}
        except (OSError, ScanError):
            # Existence is unknown; retain the candidate with explicit unavailable coverage.
            exists, size_bytes, meta = None, 0, {"partial": True, "denied": 1}
        results.append({
            **c,
            "exists": exists,
            "size_bytes": size_bytes,
            "size_mb": round(size_bytes / (1024 ** 2), 1),
            "size_partial": meta["partial"],
            "size_meta": meta,
        })

    # Sort: largest first, non-existent last
    results.sort(key=lambda x: (-x["size_bytes"], not x["exists"]))
    return results

def _expand_user_path(raw: str) -> Path:
    return _resolve_root(raw)

def _scan_tree(root: Path, max_entries: int = 120_000, max_depth: int = 18, noisy_names: Optional[set] = None,
               max_seconds: float = 15, max_nodes: int = 25_000) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Dict[str, Any]]:
    """
    Returns (tree, largest_items, meta)
    Tree format matches app.js expectations: {name, path, size, children:[...]}
    """
    noisy_names = set(NOISY_DEFAULT) if noisy_names is None else noisy_names
    started = time.time()
    deadline = time.monotonic() + max_seconds
    entries_seen = 0
    denied = 0
    files_count = 0
    dirs_count = 0
    skipped = 0
    depth_limited = 0
    entry_limited = False
    time_limited = False
    folder_summary = []
    direct_file_bytes = 0
    summary_limited = False
    nodes_retained = 1
    representation_limited = False
    cancelled = False
    identities = set()
    hardlinks_skipped = 0
    identity_unknown = 0
    allocation_unknown = 0
    categories = {}
    file_summary = []

    # Track largest files across scan
    largest: List[Dict[str, Any]] = []

    def push_largest(item: Dict[str, Any]):
        largest.append(item)
        largest.sort(key=lambda x: x.get("size", 0), reverse=True)
        # Keep top 200 to keep payload sane
        if len(largest) > 200:
            del largest[200:]

    def walk_dir(p: Path, depth: int, retain_children: bool = True) -> Dict[str, Any]:
        nonlocal entries_seen, denied, files_count, dirs_count
        nonlocal skipped, depth_limited, entry_limited, time_limited
        nonlocal direct_file_bytes, summary_limited
        nonlocal nodes_retained, representation_limited
        nonlocal cancelled
        nonlocal hardlinks_skipped, identity_unknown, allocation_unknown

        node: Dict[str, Any] = {"name": p.name or str(p), "path": str(p), "size": 0, "children": [],
                                "size_known": True, "size_partial": False, "size_reason": None,
                                "kind": "directory", "files": 0, "allocated_size": None,
                                "allocated_known_bytes": 0, "allocated_partial": True,
                                "modified_at": None, "created_at": None}
        # Directory timestamps are metadata only; a missing timestamp alone does
        # not make otherwise successful enumeration an incomplete byte count.
        try:
            directory_info = p.lstat()
            if _is_reparse(directory_info) or stat.S_ISLNK(directory_info.st_mode) or (hasattr(p, "is_junction") and p.is_junction()):
                skipped += 1
                node.update(size_known=False, size_partial=True, size_reason="linked")
                return node
            node.update(modified_at=_timestamp(directory_info.st_mtime),
                        created_at=_timestamp(getattr(directory_info, "st_birthtime", None)))
        except OSError:
            pass
        coverage_before = (denied, skipped, depth_limited, entry_limited, time_limited, cancelled, identity_unknown)
        checkpoint(phase="enumerating", entries_seen=entries_seen, files=files_count)

        if depth > max_depth:
            depth_limited += 1
            node.update(size_known=False, size_partial=True, size_reason="depth_limit")
            return node

        if time.monotonic() >= deadline:
            time_limited = True
            node.update(size_known=False, size_partial=True, size_reason="time_limit")
            return node

        try:
            # Do not swallow permission failures or allocate an unbounded directory listing.
            scandir_items = os.scandir(p)
        except Exception:
            denied += 1
            node.update(size_known=False, size_partial=True, size_reason="unreadable")
            return node

        # Stop if we hit a hard limit
        if entries_seen >= max_entries:
            scandir_items.close()
            entry_limited = True
            node.update(size_known=False, size_partial=True, size_reason="entry_limit")
            return node

        children: List[Dict[str, Any]] = []
        total = 0
        allocated_total = 0
        allocation_partial = False
        recursive_files = 0

        try:
          for entry in scandir_items:
            checkpoint(phase="enumerating", entries_seen=entries_seen, files=files_count)
            if entries_seen >= max_entries:
                entry_limited = True
                break
            if time.monotonic() >= deadline:
                time_limited = True
                break
            entries_seen += 1

            try:
                name = entry.name
                full = Path(entry.path)
                if entry.is_symlink() or (hasattr(full, "is_junction") and full.is_junction()):
                    skipped += 1
                    continue
                info = None
                try:
                    info = _entry_info(entry)
                except OSError:
                    pass
                if _is_reparse(info):
                    skipped += 1
                    continue
                # Skip obvious noisy dirs
                if entry.is_dir(follow_symlinks=False) and name in noisy_names:
                    skipped += 1
                    continue

                full = Path(entry.path)

                if entry.is_dir(follow_symlinks=False):
                    dirs_count += 1
                    # Reserve the parent before its descendants consume the node
                    # budget. Otherwise a full child tree can lose its only path
                    # back to the root when there is no slot left for this folder.
                    retain_child = retain_children and nodes_retained < max_nodes
                    if retain_child:
                        nodes_retained += 1
                    child = walk_dir(full, depth + 1, retain_children=retain_child)
                    if depth == 0:
                        if len(folder_summary) < 200:
                            folder_summary.append({"name": name, "bytes": int(child.get("size", 0) or 0),
                                                   "size_known": child["size_known"], "size_partial": child["size_partial"]})
                        else:
                            summary_limited = True
                    if is_protected(str(full)):
                        child["protected"] = True
                    total += int(child.get("size", 0) or 0)
                    allocated_total += child["allocated_known_bytes"]
                    allocation_partial |= child["allocated_partial"]
                    recursive_files += child["files"]
                    if child.get("size", 0) > 0 or child.get("children") or child.get("size_partial"):
                        if retain_child:
                            children.append(child)
                        else:
                            representation_limited = True
                            node["omitted_bytes"] = node.get("omitted_bytes", 0) + int(child.get("size", 0) or 0)
                            node["omitted_entries"] = node.get("omitted_entries", 0) + 1
                            node["omitted_allocated_known_bytes"] = node.get("omitted_allocated_known_bytes", 0) + child["allocated_known_bytes"]
                            node["omitted_allocation_partial"] = node.get("omitted_allocation_partial", False) or child["allocated_partial"]
                    elif retain_child:
                        # An empty, fully inspected directory has never been a
                        # map entry. Return its reservation for later siblings.
                        nodes_retained -= 1
                else:
                    # file
                    files_count += 1
                    recursive_files += 1
                    size_known = True
                    try:
                        if info is None:
                            raise OSError("File metadata unavailable")
                        sz = info.st_size
                    except Exception:
                        denied += 1
                        sz = 0
                        size_known = False

                    logical_size = int(sz)
                    identity = (getattr(info, "st_dev", 0), getattr(info, "st_ino", 0))
                    hardlink_duplicate = bool(identity[1] and identity in identities)
                    if hardlink_duplicate:
                        hardlinks_skipped += 1
                        sz = 0
                    elif identity[1]:
                        identities.add(identity)
                    elif size_known:
                        identity_unknown += 1
                    # Without identity, per-name allocation could describe the
                    # same physical file more than once. Do not call it known.
                    allocated = 0 if hardlink_duplicate else _allocated_size(full, info) if identity[1] else None
                    allocated_total += allocated or 0
                    allocation_partial |= allocated is None
                    allocation_unknown += int(allocated is None)

                    file_node = {"name": name, "path": str(full), "size": int(sz), "size_known": size_known,
                                 "size_partial": not size_known, "size_reason": None if size_known else "unreadable",
                                 "logical_size": logical_size, "hardlink_duplicate": hardlink_duplicate,
                                 "allocated_size": allocated, "allocated_known_bytes": allocated or 0,
                                 "allocated_partial": allocated is None, **_file_metadata(full, info)}
                    category = categories.setdefault(file_node["category"], {"category": file_node["category"], "bytes": 0,
                                                      "allocated_known_bytes": 0, "files": 0})
                    category["bytes"] += int(sz)
                    category["allocated_known_bytes"] += allocated or 0
                    category["files"] += 1
                    summary = {"path": str(full.relative_to(root)), "bytes": int(sz), "logical_size": logical_size,
                               "hardlink_duplicate": hardlink_duplicate,
                               "allocated_size": allocated, "modified_at": file_node["modified_at"],
                               "created_at": file_node["created_at"], "extension": file_node["extension"],
                               "category": file_node["category"], "size_known": size_known}
                    candidate = (int(sz), str(full), summary)
                    if len(file_summary) < 500:
                        heapq.heappush(file_summary, candidate)
                    elif candidate[:2] > file_summary[0][:2]:
                        heapq.heapreplace(file_summary, candidate)
                    if is_protected(str(full)):
                        file_node["protected"] = True
                    if retain_children and nodes_retained < max_nodes:
                        children.append(file_node)
                        nodes_retained += 1
                    else:
                        representation_limited = True
                        node["omitted_bytes"] = node.get("omitted_bytes", 0) + int(sz)
                        node["omitted_entries"] = node.get("omitted_entries", 0) + 1
                        node["omitted_allocated_known_bytes"] = node.get("omitted_allocated_known_bytes", 0) + (allocated or 0)
                        node["omitted_allocation_partial"] = node.get("omitted_allocation_partial", False) or allocated is None
                    total += int(sz)
                    if depth == 0:
                        direct_file_bytes += int(sz)

                    if sz and not file_node.get("protected"):
                        push_largest(dict(file_node))

            except Exception:
                denied += 1
                continue
        except ScanCancelled:
            cancelled = True
        finally:
            scandir_items.close()

        # Sort children by size desc and cap per directory to keep payload manageable
        children.sort(key=lambda x: x.get("size", 0), reverse=True)
        if len(children) > 2500:
            # collapse the rest into a synthetic bucket so treemap remains usable
            representation_limited = True
            rest = children[2499:]
            rest_size = sum(int(c.get("size", 0) or 0) for c in rest)
            retained_paths = {os.path.normcase(c["path"]) for c in children}
            bucket_path = str(p / "__MORE__")
            suffix = 1
            while os.path.normcase(bucket_path) in retained_paths:
                suffix += 1
                bucket_path = str(p / f"__MORE__{suffix}")
            children = children[:2499]
            partial_bucket = any(c.get("size_partial") for c in rest)
            children.append({"name": f"(+{len(rest)} more)", "path": bucket_path, "size": int(rest_size),
                             "kind": "aggregate", "files": sum(c.get("files", 0) for c in rest),
                             "allocated_known_bytes": sum(c.get("allocated_known_bytes", 0) for c in rest),
                             "allocated_size": None if any(c.get("allocated_partial", True) for c in rest) else sum(c.get("allocated_size", 0) for c in rest),
                             "allocated_partial": any(c.get("allocated_partial", True) for c in rest),
                             "synthetic": True, "protected": True, "size_known": any(c.get("size_known", True) for c in rest),
                             "collapsed_entries": len(rest), "representation": "collapsed_children",
                             "unknown_entries": sum(not c.get("size_known", True) for c in rest),
                             "size_partial": partial_bucket, "size_reason": "incomplete_coverage" if partial_bucket else None})

        node["children"] = children
        node["size"] = int(total)
        node["files"] = recursive_files
        if coverage_before != (denied, skipped, depth_limited, entry_limited, time_limited, cancelled, identity_unknown):
            node.update(size_partial=True, size_reason="incomplete_coverage")
            if not total and not children:
                node["size_known"] = False
        node["allocated_partial"] = bool(allocation_partial or node["size_partial"])
        node["allocated_known_bytes"] = allocated_total
        node["allocated_size"] = None if node["allocated_partial"] else allocated_total
        return node

    try:
        tree = walk_dir(root, 0)
    except ScanCancelled:
        cancelled = True
        tree = {"name": root.name or str(root), "path": str(root), "size": 0, "children": [],
                "size_known": False, "size_partial": True, "size_reason": "cancelled", "kind": "directory", "files": 0,
                "allocated_size": None, "allocated_known_bytes": 0, "allocated_partial": True}
    meta = {
        "root": str(root),
        "seconds": round(time.time() - started, 3),
        "entries_seen": entries_seen,
        "files": files_count,
        "dirs": dirs_count,
        "denied": denied,
        "max_entries": max_entries,
        "max_depth": max_depth,
        "skipped": skipped,
        "depth_limited": depth_limited,
        "entry_limited": entry_limited,
        "time_limited": time_limited,
        "partial": bool(denied or skipped or depth_limited or entry_limited or time_limited or cancelled or identity_unknown),
        "cancelled": cancelled,
        "folder_summary": folder_summary,
        "direct_file_bytes": direct_file_bytes,
        "summary_limited": summary_limited,
        "representation_limited": representation_limited,
        "max_tree_nodes": max_nodes,
        "scanner": _scanner_metadata(),
        "hardlinks_skipped": hardlinks_skipped,
        "identity_unknown": identity_unknown,
        "allocation_unknown": allocation_unknown,
        "allocated_size": tree["allocated_size"],
        "allocated_known_bytes": tree["allocated_known_bytes"],
        "categories": sorted(categories.values(), key=lambda row: row["bytes"], reverse=True),
        "file_summary": [row for _, _, row in sorted(file_summary, key=lambda item: item[:2], reverse=True)],
        "file_summary_complete": files_count <= 500 and not (denied or skipped or depth_limited or entry_limited or time_limited or cancelled or identity_unknown),
        "scan_filters": {"excluded_names": sorted(noisy_names), "follow_links": False,
                         "hardlink_accounting": "first_observed_identity_v1",
                         "max_depth": max_depth, "max_entries": max_entries, "max_seconds": int(max_seconds)},
    }
    return tree, largest[:50], meta

def _collect_large_files(
    root: Path,
    min_bytes: int,
    limit: int,
    max_entries: int = 500_000,
    max_seconds: float = 15.0,
    max_depth: int = 30,
    noisy_names: Optional[set] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Read-only bounded search. Keep only the largest requested results in memory."""
    started = time.monotonic()
    noisy_names = NOISY_DEFAULT if noisy_names is None else noisy_names
    deadline = started + max_seconds
    meta = {"root": str(root), "entries_seen": 0, "denied": 0, "skipped": 0,
            "time_limited": False, "entry_limited": False, "partial": False,
            "min_bytes": min_bytes, "found": 0, "hardlinks_skipped": 0, "scanner": _scanner_metadata()}
    largest = []
    identities = set()
    pending = [(root, 0)]
    meta["depth_limited"] = 0
    try:
        while pending:
            checkpoint(phase="enumerating", entries_seen=meta["entries_seen"], found=meta["found"])
            if time.monotonic() >= deadline:
                meta["time_limited"] = True
                break
            current, depth = pending.pop()
            try:
                if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()) or is_protected(str(current)):
                    meta["skipped"] += 1
                    continue
                with os.scandir(current) as iterator:
                    for entry in iterator:
                        checkpoint(phase="enumerating", entries_seen=meta["entries_seen"], found=meta["found"])
                        if time.monotonic() >= deadline:
                            meta["time_limited"] = True
                            break
                        if meta["entries_seen"] >= max_entries:
                            meta["entry_limited"] = True
                            break
                        meta["entries_seen"] += 1
                        try:
                            child = Path(entry.path)
                            if entry.is_symlink() or (hasattr(child, "is_junction") and child.is_junction()) or is_protected(entry.path):
                                meta["skipped"] += 1
                                continue
                            info = _entry_info(entry)
                            if _is_reparse(info):
                                meta["skipped"] += 1
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                if entry.name in noisy_names:
                                    meta["skipped"] += 1
                                else:
                                    if depth >= max_depth:
                                        meta["depth_limited"] += 1
                                    else:
                                        pending.append((child, depth + 1))
                            elif entry.is_file(follow_symlinks=False):
                                size = info.st_size
                                identity = (getattr(info, "st_dev", 0), getattr(info, "st_ino", 0))
                                if identity[1] and identity in identities:
                                    meta["hardlinks_skipped"] += 1
                                    continue
                                if identity[1]:
                                    identities.add(identity)
                                if size >= min_bytes:
                                    meta["found"] += 1
                                    item = (size, entry.path, entry.name, info)
                                    if len(largest) < limit:
                                        heapq.heappush(largest, item)
                                    elif limit and item > largest[0]:
                                        heapq.heapreplace(largest, item)
                        except OSError:
                            meta["denied"] += 1
            except OSError:
                meta["denied"] += 1
            if meta["time_limited"] or meta["entry_limited"]:
                break
    except ScanCancelled:
        meta["cancelled"] = True

    top = []
    for size, path, name, info in sorted(largest, key=lambda item: item[:3], reverse=True):
        allocated = None
        if not meta.get("cancelled") and not meta["time_limited"]:
            try:
                checkpoint(phase="metadata", found=meta["found"])
                if time.monotonic() >= deadline:
                    meta["time_limited"] = True
                else:
                    allocated = _allocated_size(Path(path), info)
            except ScanCancelled:
                meta["cancelled"] = True
        top.append({"size": size, "logical_size": size, "path": path, "name": name,
                    "allocated_size": allocated, "allocated_known_bytes": allocated or 0,
                    "allocated_partial": allocated is None, **_file_metadata(Path(path), info)})
    total = sum(item["size"] for item in top)
    meta.update(seconds=round(time.monotonic() - started, 3), returned=len(top),
                results_limited=meta["found"] > len(top), total_bytes=total,
                total_mb=round(total / (1024 ** 2), 1))
    meta["partial"] = any(meta.get(key) for key in ("denied", "skipped", "entry_limited", "time_limited", "depth_limited", "cancelled"))
    meta["scan_filters"] = {**{"max_depth": max_depth, "max_entries": max_entries, "max_seconds": int(max_seconds)}, "excluded_names": sorted(noisy_names), "follow_links": False}
    return top, meta

def _file_signature(info) -> tuple:
    # Windows path stat and fstat can expose different ctime semantics. Identity,
    # size and modification time are comparable across both; retain ctime on POSIX.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns if os.name != "nt" else 0)

def _hash_duplicate_file(p: Path, expected: tuple, deadline: float) -> str:
    """Hash the whole file; discard files replaced or changed during inspection."""
    h = hashlib.sha256()
    with p.open("rb") as stream:
        if _file_signature(os.fstat(stream.fileno())) != expected:
            raise ValueError("File changed before verification")
        read_bytes = 0
        while True:
            checkpoint(phase="hashing")
            if time.monotonic() >= deadline:
                raise TimeoutError("Duplicate verification time limit")
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            read_bytes += len(chunk)
            if read_bytes > expected[2]:
                raise ValueError("File grew during verification")
            h.update(chunk)
        if read_bytes != expected[2] or _file_signature(os.fstat(stream.fileno())) != expected:
            raise ValueError("File changed during verification")
    if p.is_symlink() or _file_signature(p.stat(follow_symlinks=False)) != expected:
        raise ValueError("File replaced during verification")
    return h.hexdigest()


def _partial_hash_duplicate_file(p: Path, expected: tuple, deadline: float) -> str:
    """Candidate filter only: sample first/last 64 KiB, never prove equality."""
    digest = hashlib.sha256()
    with p.open("rb") as stream:
        if _file_signature(os.fstat(stream.fileno())) != expected:
            raise ValueError("File changed before candidate sampling")
        for offset in sorted({0, max(0, expected[2] - 65536)}):
            checkpoint(phase="partial_hashing")
            if time.monotonic() >= deadline:
                raise TimeoutError("Duplicate sampling time limit")
            stream.seek(offset)
            chunk = stream.read(min(65536, expected[2] - offset))
            if len(chunk) != min(65536, expected[2] - offset):
                raise ValueError("File changed during candidate sampling")
            digest.update(chunk)
        if _file_signature(os.fstat(stream.fileno())) != expected:
            raise ValueError("File changed during candidate sampling")
    info = p.stat(follow_symlinks=False)
    if p.is_symlink() or _is_reparse(info) or _file_signature(info) != expected:
        raise ValueError("File replaced during candidate sampling")
    return digest.hexdigest()

def _find_duplicates(
    root: Path,
    max_entries: int = 300_000,
    max_seconds: float = 15.0,
    max_depth: int = 30,
    noisy_names: Optional[set] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Bounded size -> sampled hash -> full SHA256 verification. Never deletes."""
    started = time.monotonic()
    noisy_names = NOISY_DEFAULT if noisy_names is None else noisy_names
    deadline = started + max_seconds
    meta = {"root": str(root), "entries_seen": 0, "denied": 0, "skipped": 0,
            "changed": 0, "files_hashed": 0, "min_bytes": 4096,
            "time_limited": False, "entry_limited": False, "partial": False,
            "verification": "full_sha256", "hardlinks_skipped": 0,
            "files_sampled": 0, "candidate_reduction": "size_then_partial_sha256", "scanner": _scanner_metadata()}
    by_size: dict[int, list[tuple[Path, tuple]]] = {}
    identities = set()
    pending = [(root, 0)]
    meta["depth_limited"] = 0
    try:
        while pending:
            checkpoint(phase="enumerating", entries_seen=meta["entries_seen"])
            if time.monotonic() >= deadline:
                meta["time_limited"] = True
                break
            current, depth = pending.pop()
            try:
                if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()) or is_protected(str(current)):
                    meta["skipped"] += 1
                    continue
                with os.scandir(current) as iterator:
                    for entry in iterator:
                        checkpoint(phase="enumerating", entries_seen=meta["entries_seen"])
                        if time.monotonic() >= deadline:
                            meta["time_limited"] = True
                            break
                        if meta["entries_seen"] >= max_entries:
                            meta["entry_limited"] = True
                            break
                        meta["entries_seen"] += 1
                        try:
                            child = Path(entry.path)
                            if entry.is_symlink() or (hasattr(child, "is_junction") and child.is_junction()) or is_protected(entry.path):
                                meta["skipped"] += 1
                                continue
                            if _is_reparse(entry.stat(follow_symlinks=False)):
                                meta["skipped"] += 1
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                if entry.name in noisy_names:
                                    meta["skipped"] += 1
                                else:
                                    if depth >= max_depth:
                                        meta["depth_limited"] += 1
                                    else:
                                        pending.append((child, depth + 1))
                            elif entry.is_file(follow_symlinks=False):
                                # Windows DirEntry metadata can omit device/inode identity.
                                # Use a path stat so comparison with the opened handle is valid.
                                info = child.stat(follow_symlinks=False)
                                if info.st_size < meta["min_bytes"]:
                                    continue
                                identity = (info.st_dev, info.st_ino)
                                if info.st_ino and identity in identities:
                                    meta["hardlinks_skipped"] += 1
                                    continue
                                identities.add(identity)
                                by_size.setdefault(info.st_size, []).append((child, _file_signature(info)))
                        except OSError:
                            meta["denied"] += 1
            except OSError:
                meta["denied"] += 1
            if meta["time_limited"] or meta["entry_limited"]:
                break

    except ScanCancelled:
        meta["cancelled"] = True

    by_partial: dict[tuple, list[tuple[Path, tuple]]] = {}
    for size, candidates in by_size.items():
        if meta.get("cancelled"):
            break
        try:
            checkpoint(phase="partial_hashing", files_sampled=meta["files_sampled"])
        except ScanCancelled:
            meta["cancelled"] = True
            break
        if len(candidates) < 2:
            continue
        for path, signature in candidates:
            try:
                digest = _partial_hash_duplicate_file(path, signature, deadline)
                by_partial.setdefault((size, digest), []).append((path, signature))
                meta["files_sampled"] += 1
            except TimeoutError:
                meta["time_limited"] = True
                break
            except ScanCancelled:
                meta["cancelled"] = True
                break
            except ValueError:
                meta["changed"] += 1
            except OSError:
                meta["denied"] += 1
        if meta["time_limited"] or meta.get("cancelled"):
            break

    by_hash: dict[tuple, list[tuple[Path, tuple]]] = {}
    for (size, _), candidates in by_partial.items():
        if meta.get("cancelled"):
            break
        if len(candidates) < 2:
            continue
        for path, signature in candidates:
            try:
                digest = _hash_duplicate_file(path, signature, deadline)
                by_hash.setdefault((size, digest), []).append((path, signature))
                meta["files_hashed"] += 1
            except TimeoutError:
                meta["time_limited"] = True
                break
            except ScanCancelled:
                meta["cancelled"] = True
                break
            except ValueError:
                meta["changed"] += 1
            except OSError:
                meta["denied"] += 1
        if meta["time_limited"] or meta.get("cancelled"):
            break

    groups = []
    for (size, _), candidates in by_hash.items():
        if time.monotonic() >= deadline:
            meta["time_limited"] = True
            break
        if len(candidates) < 2:
            continue
        paths = []
        for path, signature in candidates:
            if time.monotonic() >= deadline:
                meta["time_limited"] = True
                break
            # Earlier files can change while later files are being hashed.
            try:
                if path.is_symlink() or _file_signature(path.stat(follow_symlinks=False)) != signature:
                    meta["changed"] += 1
                else:
                    paths.append(str(path))
            except OSError:
                meta["denied"] += 1
        if len(paths) > 1:
            groups.append({"size": size, "count": len(paths),
                           "wasted_bytes": size * (len(paths) - 1), "paths": paths,
                           "verified": True})
    groups.sort(key=lambda group: group["wasted_bytes"], reverse=True)
    total = sum(group["wasted_bytes"] for group in groups)
    meta.update(seconds=round(time.monotonic() - started, 3), groups_found=len(groups),
                groups_returned=min(100, len(groups)), results_limited=len(groups) > 100,
                total_wasted_bytes=total, total_wasted_mb=round(total / (1024 ** 2), 1))
    meta["partial"] = any(meta.get(key) for key in ("denied", "skipped", "changed", "time_limited", "entry_limited", "depth_limited", "cancelled"))
    meta["scan_filters"] = {"max_depth": max_depth, "max_entries": max_entries, "max_seconds": int(max_seconds), "excluded_names": sorted(noisy_names), "follow_links": False}
    return groups[:100], meta

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

    def unavailable(mountpoint, device="", fstype="", *, scope="enumerated_partition"):
        return {"mountpoint": mountpoint, "device": device, "label": "", "drive_type": "unknown", "fstype": fstype,
                "available": False, "availability": "unavailable", "scope": scope,
                "availability_reason": "Capacity could not be read within this observation's limits.",
                "total_bytes": None, "used_bytes": None, "free_bytes": None, "percent_used": None,
                "total_human": "Unavailable", "used_human": "Unavailable", "free_human": "Unavailable"}

    # â”€â”€ Collect partition list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    partitions = []
    if _psutil:
        try:
            partitions = _psutil.disk_partitions(all=False)
        except Exception:
            pass

    if not partitions:
        # Fallback: just report the home-directory drive
        try:
            home = _resolve_root(str(Path.home()))
            u = shutil.disk_usage(home)
            results.append({
                "mountpoint": str(Path.home()), "device": "",
                "label": "", "drive_type": "fixed", "fstype": "",
                "total_bytes": u.total, "used_bytes": u.used, "free_bytes": u.free,
                "percent_used": round(u.used / max(u.total, 1) * 100, 1),
                "total_human": _bytes_human(u.total),
                "used_human":  _bytes_human(u.used),
                "free_human":  _bytes_human(u.free),
                "available": True, "availability": "available", "scope": "home_fallback",
                "availability_reason": "Only the home location was observed; the drive list was unavailable.",
            })
        except Exception:
            results.append(unavailable(str(Path.home()), scope="home_fallback"))
        return results

    _PSEUDO_FS = frozenset({
        "tmpfs", "devtmpfs", "sysfs", "proc", "cgroup", "cgroup2",
        "securityfs", "pstore", "efivarfs", "bpf", "debugfs", "tracefs",
        "hugetlbfs", "mqueue", "fusectl", "squashfs", "overlay", "devpts",
    })

    seen: set = set()
    for part in partitions:
        checkpoint(phase="drives")
        mp = part.mountpoint
        if not mp or mp in seen:
            continue
        seen.add(mp)

        # Skip pseudo filesystems on Linux/macOS
        if sys_name != "Windows" and (part.fstype or "") in _PSEUDO_FS:
            continue

        # Get usage with timeout â€” skips slow/offline network mounts
        try:
            _resolve_root(mp)
        except ScanError:
            row = unavailable(mp, part.device or mp, part.fstype or "")
            row["availability_reason"] = "The location could not be inspected without following a link or unavailable ancestor."
            results.append(row)
            continue
        u = _safe_disk_usage(mp, timeout_s=2.0)
        if u is None or u.total <= 0:
            results.append(unavailable(mp, part.device or mp, part.fstype or ""))
            continue

        # â”€â”€ Drive label and type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            "available": True, "availability": "available", "scope": "enumerated_partition", "availability_reason": None,
        })

    _order = {"fixed": 0, "removable": 1, "network": 2, "cdrom": 3, "unknown": 4, "ram": 5}
    results.sort(key=lambda d: (_order.get(d["drive_type"], 9), d["mountpoint"]))
    return results

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
            p = _resolve_root(str(Path(*parts)))
            return str(p) if p.is_dir() else None
        except Exception:
            return None

    # Common folders â€” present on all OSes (under home)
    common = {
        "home":      _p(home),
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
        system_drive = os.environ.get("SystemDrive", "C:")
        common.update({
            "windows": _p(os.environ.get("SystemRoot") or os.environ.get("WINDIR") or system_drive + "/Windows"),
            "users": _p(system_drive + "/Users"),
            "appdata": _p(os.environ.get("APPDATA") or str(home / "AppData" / "Roaming")),
            "localappdata": _p(os.environ.get("LOCALAPPDATA") or str(home / "AppData" / "Local")),
            "programdata": _p(os.environ.get("ProgramData") or system_drive + "/ProgramData"),
        })
        for label, path in [
            ("OneDrive", str(home / "OneDrive")),
            ("iCloudDrive", str(home / "iCloudDrive")),
            ("Google Drive", str(home / "Google Drive")),
            ("Dropbox", str(home / "Dropbox")),
        ]:
            if _p(path):
                extras.append({"label": label, "path": path})
    elif sys_name == "Darwin":
        for label, path in [
            ("iCloud Drive", str(home / "Library/Mobile Documents/com~apple~CloudDocs")),
            ("Dropbox", str(home / "Dropbox")),
            ("Google Drive", str(home / "Google Drive")),
        ]:
            if _p(path):
                extras.append({"label": label, "path": path})
    else:
        for label, path in [
            ("Dropbox",      str(home / "Dropbox")),
            ("Google Drive", str(home / "GoogleDrive")),
            ("Google Drive", str(home / "gdrive")),
            ("Google Drive", str(home / "Google Drive")),
        ]:
            if _p(path) and not any(e["path"] == path for e in extras):
                extras.append({"label": label, "path": path})

    return {
        "os":     sys_name,
        "home":   str(home),
        "common": {k: v for k, v in common.items() if v},
        "extras": extras,
    }
