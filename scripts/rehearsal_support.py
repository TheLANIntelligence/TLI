"""Developer-only boundaries shared by synthetic release rehearsals."""
from __future__ import annotations

import os
from pathlib import Path

MARKER_TEXT = "synthetic test data only"
STARTUP_ENV = ("TLI_ROOT", "TLI_HOST", "TLI_PORT", "TLI_LAN_MODE", "TLI_ENABLE_TLS", "TLI_OPEN_BROWSER")


def clean_environment(environ=None):
    result = dict(os.environ if environ is None else environ)
    for name in list(result):
        if name.upper().startswith(("TLI_", "UVICORN_")) or name.upper() in ("PYTHONPATH", "PYTHONHOME", "PYTEST_ADDOPTS"):
            result.pop(name, None)
    result.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONOPTIMIZE="0")
    return result


def validate_root(path, *, phone=False):
    raw = Path(path)
    root = raw.resolve()
    marker = root / (".tli-phone-fixture" if phone else ".tli-rehearsal")
    if raw.is_symlink() or (hasattr(raw, "is_junction") and raw.is_junction()):
        raise ValueError("Synthetic root must not be a filesystem link.")
    if not marker.is_file() or marker.read_text(encoding="utf-8").strip() != MARKER_TEXT:
        raise ValueError("The required synthetic-installation marker is missing or invalid.")
    count = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in (*dirs, *files):
            entry = Path(directory) / name
            count += 1
            if count > 10000 or entry.is_symlink() or (hasattr(entry, "is_junction") and entry.is_junction()):
                raise ValueError("Synthetic root contains links or exceeds the bounded rehearsal size.")
    return root


def activate_root(code, root):
    """Must run before importing any application module."""
    import sys
    code = Path(code).resolve()
    if not (code / "backend" / "main.py").is_file():
        raise ValueError("Candidate code directory does not contain the backend.")
    for name in list(os.environ):
        if name.upper().startswith(("TLI_", "UVICORN_")) or name.upper() in ("PYTHONPATH", "PYTHONHOME", "PYTEST_ADDOPTS"):
            os.environ.pop(name, None)
    os.environ["TLI_ROOT"] = str(root)
    os.environ["TLI_OPEN_BROWSER"] = "0"
    os.chdir(root)
    sys.path.insert(0, str(code / "backend"))
    return code
