"""Hidden, read-only scan child. This module never imports TLI application state."""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import shutil
from pathlib import Path
import sys
import threading
import time

MAX_REQUEST = 16 * 1024
MAX_RESULT = 32 * 1024 * 1024
MAX_MEMORY = 512 * 1024 * 1024
MAX_INVENTORY_FRAME = 512 * 1024
PROFILES = {"quick": {"max_seconds": 15, "max_entries": 50_000, "max_depth": 18},
            "deep": {"max_seconds": 300, "max_entries": 500_000, "max_depth": 30}}


class Cancelled(BaseException):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def validate_request(value):
    if not isinstance(value, dict) or set(value) - {"operation", "path", "profile", "include_excluded", "min_mb", "limit", "limits", "inventory_version"}:
        raise ValueError("Unsupported scan request")
    if value.get("operation") not in {"scan", "large_files", "duplicates", "common_folders", "drives", "paths", "path_exists"}:
        raise ValueError("Unsupported scan operation")
    if "inventory_version" in value and (type(value["inventory_version"]) is not int or value["inventory_version"] != 1 or value["operation"] != "scan"):
        raise ValueError("Unsupported inventory protocol")
    if value.get("profile") not in PROFILES or type(value.get("include_excluded", False)) is not bool or value.get("include_excluded") and value["profile"] != "deep":
        raise ValueError("Unsupported scan profile or exclusions")
    path = value.get("path")
    if path is not None and (not isinstance(path, str) or not 0 < len(path) <= 4096 or "\x00" in path):
        raise ValueError("Invalid scan path")
    if value["operation"] in {"scan", "large_files", "duplicates", "path_exists"} and not path:
        raise ValueError("Choose a folder")
    limits = value.get("limits", PROFILES[value["profile"]])
    if not isinstance(limits, dict) or set(limits) != set(PROFILES["quick"]):
        raise ValueError("Invalid scan limits")
    for key, maximum in PROFILES["deep"].items():
        if type(limits[key]) is not int or not 1 <= limits[key] <= maximum:
            raise ValueError("Invalid scan limit")
    if type(value.get("limit", 200)) is not int or not 10 <= value.get("limit", 200) <= 2000:
        raise ValueError("Invalid result limit")
    minimum = value.get("min_mb", 100)
    if type(minimum) not in (int, float) or not 1 <= minimum <= 50_000:
        raise ValueError("Invalid file-size threshold")
    return {**value, "limits": limits}


def read_only_limits():
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY, MAX_MEMORY))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Windows memory/parent-death limits are established by the parent Job Object
    # before the request is sent. No application/configuration imports occur here.
    sys.dont_write_bytecode = True
    def audit(event, args):
        if event.startswith(("socket.", "subprocess.", "os.exec", "os.spawn")) or event in {"os.system", "os.fork", "os.posix_spawn"}:
            raise PermissionError("Scan workers cannot start programs or network connections")
        if event in {"os.remove", "os.rmdir", "os.mkdir", "os.rename", "os.link", "os.symlink", "os.chmod", "os.chown", "os.truncate", "os.utime", "os.setxattr", "os.removexattr"}:
            raise PermissionError("Scan workers cannot change files")
        if event == "open":
            mode, flags = args[1], args[2]
            if isinstance(mode, str) and any(c in mode for c in "wax+") or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                raise PermissionError("Scan workers cannot write files")
    sys.addaudithook(audit)


def drive_identity(root):
    unknown = {"status": "unknown", "fingerprint": None, "detail": "Drive or folder identity could not be confirmed."}
    try:
        info = root.stat()
        if not info.st_ino or not info.st_dev:
            return unknown
        if os.name == "nt":
            mount = ctypes.create_unicode_buffer(32768)
            serial = ctypes.c_ulong()
            kernel = ctypes.windll.kernel32
            if not kernel.GetVolumePathNameW(str(root), mount, len(mount)) or not kernel.GetVolumeInformationW(mount.value, None, 0, ctypes.byref(serial), None, None, None, 0) or not serial.value:
                return unknown
            identity = ["windows-volume", serial.value, info.st_ino]
        else:
            identity = ["filesystem", info.st_dev, info.st_ino]
        return {"status": "known", "fingerprint": hashlib.sha256(json.dumps(identity).encode()).hexdigest(),
                "detail": "Volume and folder identity recorded during this scan."}
    except Exception:
        return unknown


def capacity(root):
    """One volume-level sample inside the killable reader; never infer tree size."""
    try:
        sample = shutil.disk_usage(root)
        return {"status": "known", "total": int(sample.total), "used": int(sample.used),
                "free": int(sample.free), "root_is_volume": os.path.ismount(root),
                "scope": "containing_volume", "sampled_at": time.time()}
    except OSError:
        return {"status": "unknown", "total": None, "used": None, "free": None,
                "root_is_volume": False, "scope": "containing_volume"}


def perform(request, control, inventory=None):
    import storage_scan_algorithms as algorithms
    algorithms.CONTROL = control
    operation, limits = request["operation"], request["limits"]
    noisy = set() if request.get("include_excluded") else None
    control(phase="checking_path")
    if operation == "drives":
        drives = algorithms._enumerate_drives()
        return {"os": algorithms.platform.system(), "drives": drives,
                "meta": {"partial": any(not row.get("available") or row.get("scope") == "home_fallback" for row in drives),
                         "scope": "host_drive_capacity"}}, None
    if operation == "paths":
        return algorithms.common_paths(), None
    if operation == "common_folders":
        targets = algorithms.get_cleanup_targets()
        return {"os": algorithms.platform.system(), "targets": targets,
                "protected_prefixes": algorithms._protected_prefixes(),
                "meta": {"partial": any(row.get("size_partial") for row in targets), "scope": "host_common_folders"}}, None
    root = algorithms._expand_user_path(request["path"])
    if operation == "path_exists":
        return {"ok": True, "path": request["path"], "exists": root.exists()}, None
    if not root.exists():
        raise algorithms.ScanError(404, "The selected folder was not found.")
    if not root.is_dir():
        raise algorithms.ScanError(400, "Choose a directory to scan.")
    if operation == "scan":
        from storage_engines import select_engine
        before = drive_identity(root)
        capacity_before = capacity(root)
        batch, batch_bytes = [], 0
        def flush():
            nonlocal batch, batch_bytes
            if batch:
                inventory({"type": "inventory_rows", "rows": batch})
                batch, batch_bytes = [], 0
        def collect(row):
            nonlocal batch_bytes
            size = len(canonical(row)) + 1
            if size > MAX_INVENTORY_FRAME // 2:
                raise ValueError("Inventory row exceeds its byte limit")
            if batch and (len(batch) >= 128 or batch_bytes + size > MAX_INVENTORY_FRAME // 2):
                flush()
            batch.append(row)
            batch_bytes += size
        if inventory is not None:
            inventory({"type": "inventory_start", "root": str(root)})
        engine = select_engine(root)
        options = {"inventory_sink": collect} if inventory is not None else {}
        tree, largest, meta = engine.scan(root, noisy_names=noisy, **limits, **options)
        if inventory is not None:
            flush()
        after = drive_identity(root)
        capacity_after = capacity(root)
        meta.update(capacity=capacity_after, capacity_before=capacity_before, capacity_after=capacity_after)
        return {"tree": tree, "largest": largest, "meta": meta}, {"before": before, "after": after}
    if operation == "large_files":
        files, meta = algorithms._collect_large_files(root, min_bytes=int(request.get("min_mb", 100) * 1024**2), limit=request.get("limit", 200), noisy_names=noisy, **limits)
        return {"files": files, "meta": meta}, None
    groups, meta = algorithms._find_duplicates(root, noisy_names=noisy, **limits)
    return {"groups": groups, "meta": meta}, None


def main():
    """One bounded request and optional cancellation, using private inherited pipes."""
    cancelled = threading.Event()
    done = threading.Event()
    output_lock = threading.Lock()
    def emit(frame):
        raw = canonical(frame)
        if len(raw) > MAX_RESULT:
            raise ValueError("Scan result exceeds the supported result-byte limit")
        with output_lock:
            sys.stdout.buffer.write(raw + b"\n")
            sys.stdout.buffer.flush()
    try:
        # Read before importing the algorithms; parent establishes its Job Object
        # before sending any filesystem path or releasing this input gate.
        raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST or not raw.endswith(b"\n"):
            raise ValueError("Invalid bounded scan request")
        request = validate_request(json.loads(raw))
        read_only_limits()
        def commands():
            while not done.is_set():
                line = sys.stdin.buffer.readline(128)
                if not line:
                    cancelled.set()
                    # Parent crash/pipe close must not leave a blocked reader.
                    if not done.wait(2):
                        os._exit(2)
                    return
                if line == b"cancel\n":
                    cancelled.set()
                else:
                    cancelled.set()
                    return
        threading.Thread(target=commands, name="storage-worker-control", daemon=True).start()
        last = [0.0]
        def control(**progress):
            if cancelled.is_set():
                from storage_scan_algorithms import ScanCancelled
                raise ScanCancelled()
            now = time.monotonic()
            if now - last[0] >= .5:
                emit({"type": "progress", "progress": progress})
                last[0] = now
        result, identity = perform(request, control, emit if request.get("inventory_version") == 1 else None)
        if cancelled.is_set():
            result.setdefault("meta", {}).update(partial=True, cancelled=True)
        emit({"type": "result", "result": result, "identity": identity})
    except Cancelled:
        emit({"type": "cancelled"})
    except (MemoryError, RecursionError):
        emit({"type": "error", "error": {"code": "resource_limit", "status_code": 422, "message": "The scan exceeded its memory or structure limit. No files were changed."}})
    except BaseException as error:
        try:
            from storage_scan_algorithms import ScanError, ScanCancelled
            if isinstance(error, ScanCancelled):
                emit({"type": "cancelled"})
                done.set(); sys.stdout.buffer.flush(); os._exit(0)
            safe = isinstance(error, ScanError)
        except Exception:
            safe = False
        emit({"type": "error", "error": {"code": "scan_unavailable", "status_code": error.status_code if safe else 422,
              "message": error.detail if safe else "The isolated scan stopped or returned unsupported data. No files were changed."}})
    finally:
        done.set()
    # Avoid interpreter shutdown waiting on a blocked control-pipe read.
    sys.stdout.buffer.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
