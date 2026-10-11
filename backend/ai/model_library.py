"""Read-only installation and resource evidence for bundled models.

Resource numbers are conservative estimates at the preset's context, not a
benchmark or a promise of speed. No inference or device discovery runs here.
"""
import os
import shutil
import struct
import time
import hashlib
from pathlib import Path

GIB = 1024 ** 3


def verify_checksum(path, expected, timeout=120):
    """Verify imported/manually placed publisher files before stopping inference."""
    deadline = time.monotonic() + timeout
    digest = hashlib.sha256()
    try:
        with Path(path).open("rb") as stream:
            before = os.fstat(stream.fileno())
            while chunk := stream.read(1024 * 1024):
                if time.monotonic() >= deadline:
                    return False
                digest.update(chunk)
            after = os.fstat(stream.fileno())
        current = Path(path).stat()
        signature = lambda st: (st.st_size, st.st_mtime_ns, st.st_ino, st.st_dev)
        return signature(before) == signature(after) == signature(current) and digest.hexdigest() == expected
    except OSError:
        return False


def validate_gguf(path):
    """Cheap structural header screening; activation also tests real inference.

    This is not a checksum or a complete tensor integrity validation.
    """
    try:
        with Path(path).open("rb") as stream:
            header = stream.read(24)
        if len(header) != 24:
            return False
        magic, version, tensors, metadata = struct.unpack("<4sIQQ", header)
        return (magic == b"GGUF" and version in (2, 3) and
                0 < tensors < 1_000_000 and 0 < metadata < 1_000_000 and
                Path(path).stat().st_size >= 1024 * 1024)
    except (OSError, ValueError, struct.error):
        return False


def contained_filename(directory, filename):
    reserved = {"CON", "PRN", "AUX", "NUL"} | {f"{prefix}{i}" for prefix in ("COM", "LPT") for i in range(1, 10)}
    if (not filename or filename in (".", "..") or any(c in filename for c in '/\\:<>"|?*')
            or any(ord(c) < 32 for c in filename) or filename.split(".")[0].upper() in reserved
            or filename != filename.strip() or not filename.lower().endswith(".gguf")):
        raise ValueError("Use a plain .gguf filename without a directory.")
    target = Path(directory) / filename
    if target.is_symlink() or target.resolve().parent != Path(directory).resolve():
        raise ValueError("Model must be stored inside the models folder.")
    return target


def resource_snapshot(directory):
    result = {"total_ram_bytes": None, "available_ram_bytes": None,
              "free_disk_bytes": None, "checked_at": time.time(), "host": "local inference host"}
    try:
        import psutil
        memory = psutil.virtual_memory()
        result.update(total_ram_bytes=memory.total, available_ram_bytes=memory.available)
    except Exception:
        pass
    try:
        parent = Path(directory).resolve()
        while not parent.exists() and parent != parent.parent:
            parent = parent.parent
        result["free_disk_bytes"] = shutil.disk_usage(parent).free
    except OSError:
        pass
    return result


def installation(preset, directory):
    names = [preset["filename"]]
    if preset.get("mmproj_filename"):
        names.append(preset["mmproj_filename"])
    components = []
    for name in names:
        path = Path(directory) / name
        valid = validate_gguf(path)
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        if name == preset["filename"] and preset.get("sha256") and size != preset.get("size_bytes"):
            valid = False
        components.append({"filename": name, "valid": valid, "size_bytes": size})
    return {"complete": all(c["valid"] for c in components), "components": components}


def assess(preset, directory, runtime, execution_mode, resources=None):
    resources = resource_snapshot(directory) if resources is None else resources
    installed = installation(preset, directory)
    weights = sum(c["size_bytes"] for c in installed["components"])
    download = preset.get("size_bytes", 0) + preset.get("mmproj_size_bytes", 0)
    # Leave memory for context, compute buffers and the rest of the application.
    needed = max(weights, download) + 2 * GIB * max(1, preset.get("ctx_size", 4096) / 4096)
    total = resources.get("total_ram_bytes")
    available = resources.get("available_ram_bytes")
    minimum = preset.get("min_ram_gb")
    state, reasons = "compatible", []
    if not Path(runtime).is_file():
        state, reasons = "unsupported", ["Bundled runtime is not installed."]
    elif total is not None and minimum and total < minimum * GIB:
        state, reasons = "insufficient_resources", [f"This preset requires an estimated {minimum} GB total RAM."]
    elif available is not None and available < needed:
        state, reasons = "insufficient_resources", [f"Needs an estimated {needed / GIB:.1f} GB available RAM now. Close other apps and recheck."]
    elif total is None or available is None or not minimum:
        state, reasons = "unknown", ["Memory requirements or current resources could not be verified. An explicit compatibility check is required."]
    else:
        reasons = ["Meets conservative memory estimates; speed and runtime support require a startup check."]
    from .runtime_support import support
    runtime_support = support(preset, runtime)
    if Path(runtime).is_file() and runtime_support["state"] == "unsupported":
        state, reasons = "unsupported", [runtime_support["reason"]]
    elif runtime_support["state"] == "unknown" and state == "compatible":
        state, reasons = "unknown", [runtime_support["reason"]]
    free = resources.get("free_disk_bytes")
    disk_needed = download + GIB  # staged files plus reserve; existing files stay intact
    download_allowed = free is not None and free >= disk_needed
    download_reason = "" if download_allowed else "Insufficient or unknown free space in the model storage folder."
    if preset.get("min_runtime_build") and runtime_support["state"] != "supported":
        download_allowed, download_reason = False, runtime_support["reason"]
    return {"state": state, "reasons": reasons, "checked_at": resources.get("checked_at"),
            "execution_mode": execution_mode, "resources": resources, "estimated": True,
            "required_available_ram_bytes": needed, "required_total_ram_gb": minimum,
            "context_size": preset.get("ctx_size", 4096), "installation": installed,
            "runtime": runtime_support,
            "download_bytes": download, "download_allowed": download_allowed,
            "download_reason": download_reason,
            "selectable": installed["complete"] and state == "compatible"}
