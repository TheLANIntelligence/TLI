"""Read-only identity of the application loaded by this process.

This identifies application code, not user data, model weights or a security
signature. Capture before importing routers so later edits cannot masquerade as
code that is already running. No application/state imports belong here.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import threading
import time
from datetime import datetime, timezone

PROTOCOL = "dependable-computers-v1"
CAPABILITIES = ["storage_jobs_v1", "trusted_peers_v1", "case_report_review_v1", "case_next_check_v1", "trusted_file_transfer_v1"]
REQUIRED_ROUTES = {
    "storage_jobs_v1": {("POST", "/visualizer/jobs"), ("GET", "/visualizer/jobs/{job_id}"),
                        ("GET", "/visualizer/jobs/{job_id}/results"), ("POST", "/visualizer/jobs/{job_id}/cancel")},
    "trusted_peers_v1": {("POST", "/mesh/trust/card"), ("POST", "/mesh/trust/preview"), ("POST", "/mesh/trust/approve")},
    "case_report_review_v1": {("POST", "/api/intelligence/cases/context-review")},
    "case_next_check_v1": {("POST", "/api/intelligence/cases/next-check"),
                           ("GET", "/api/intelligence/diagnostics/options"),
                           ("POST", "/api/intelligence/diagnostics")},
    "trusted_file_transfer_v1": {("GET", "/mesh/files/capabilities"), ("GET", "/mesh/files"),
                                  ("POST", "/mesh/files/outgoing"), ("GET", "/mesh/files/{transfer_id}"),
                                  ("POST", "/mesh/files/{transfer_id}/{operation}"),
                                  ("GET", "/mesh/files/{transfer_id}/download"),
                                  ("GET", "/agent/peer/files/capability"),
                                  ("POST", "/agent/peer/files/offer"), ("POST", "/agent/peer/files/{operation}")},
}
BACKEND_DIRS = {"ai", "builder", "cleanup", "drivers", "game_configs", "intelligence", "providers", "routers"}
FRONTEND_DIRS = {"js", "css", "assets", "history"}
MAX_FILES, MAX_BYTES = 2000, 64 * 1024 * 1024


def _unreadable_directory(error):
    raise error


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _digest(root, kind):
    base = root / kind
    if not base.is_dir() or _linked(base):
        raise ValueError("Application source is unavailable")
    records, total = [], 0
    for directory, dirs, files in os.walk(base, followlinks=False, onerror=_unreadable_directory):
        parent = Path(directory)
        relative = parent.relative_to(base)
        allowed = BACKEND_DIRS if kind == "backend" else FRONTEND_DIRS
        dirs[:] = sorted(name for name in dirs if name not in {"tests", "__pycache__", "runtime", "memory", "models", "data", "node_modules"}
                         and not name.startswith(".") and (relative.parts or name in allowed))
        if any(_linked(parent / name) for name in dirs):
            raise ValueError("Linked application source cannot be identified")
        for name in sorted(files):
            path = parent / name
            suffix = path.suffix.lower()
            include = suffix == ".py" or name == "requirements.txt" or suffix == ".txt" and "prompts" in relative.parts
            if kind == "frontend":
                include = suffix in {".js", ".css", ".html", ".json", ".svg"}
            if not include:
                continue
            if _linked(path):
                raise ValueError("Linked application source cannot be identified")
            before = path.stat()
            if not stat.S_ISREG(before.st_mode) or before.st_size > 8 * 1024 * 1024:
                raise ValueError("Application source exceeds identity limits")
            total += before.st_size
            if total > MAX_BYTES or len(records) >= MAX_FILES:
                raise ValueError("Application source exceeds identity limits")
            with path.open("rb") as handle:
                raw = handle.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("Application source exceeds identity limits")
            after = path.stat()
            if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                raise ValueError("Application source changed during inspection")
            records.append([path.relative_to(root).as_posix(), hashlib.sha256(raw).hexdigest()])
    if not records:
        raise ValueError("Application source is empty")
    return hashlib.sha256(json.dumps(sorted(records), separators=(",", ":")).encode()).hexdigest()


class ReleaseIdentity:
    def __init__(self, root, *, executable=None, frontend_root=None, clock=time.monotonic):
        self.root, self.executable = Path(root), Path(executable) if executable else None
        self.frontend_root = Path(frontend_root) if frontend_root else self.root
        self.clock, self.lock = clock, threading.Lock()
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.loaded = self._inspect()
        self.cached, self.checked = None, float("-inf")

    def _inspect(self):
        try:
            if self.executable:
                before = self.executable.stat()
                if _linked(self.executable) or before.st_size > 512 * 1024 * 1024:
                    raise ValueError("Executable exceeds identity limits")
                digest = hashlib.sha256()
                with self.executable.open("rb") as handle:
                    while block := handle.read(1024 * 1024):
                        digest.update(block)
                after = self.executable.stat()
                if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                    raise ValueError("Executable changed during inspection")
                backend = digest.hexdigest()
            else:
                backend = _digest(self.root, "backend")
            frontend = _digest(self.frontend_root, "frontend")
            return {"backend_id": backend, "frontend_id": frontend,
                    "source_id": hashlib.sha256((backend + ":" + frontend).encode()).hexdigest()}
        except (OSError, ValueError):
            return None

    def status(self):
        with self.lock:
            now = self.clock()
            if self.cached is not None and now - self.checked < 5:
                return json.loads(json.dumps(self.cached))
            current = self._inspect()
            state = "unknown" if not self.loaded or not current else "matched" if current == self.loaded else "restart_required"
            reasons = [] if state == "matched" else (["Application files changed after this host started. Finish active work, then stop and start TLI normally. Refresh this page afterward."]
                      if state == "restart_required" else ["The running application identity could not be confirmed. Check this installation before starting new work."])
            self.cached = {"schema_version": 1, "protocol": PROTOCOL, **(self.loaded or {"source_id": None, "backend_id": None, "frontend_id": None}),
                           "started_at": self.started_at, "checked_at": datetime.now(timezone.utc).isoformat(),
                           "identity_scope": "Application code and browser assets; excludes user data, dependencies and models.",
                           "capabilities": list(CAPABILITIES), "on_disk": current,
                           "compatibility": {"state": state, "reasons": reasons}}
            self.checked = now
            return json.loads(json.dumps(self.cached))


_runtime = None


def capture():
    global _runtime
    if _runtime is None:
        frozen = getattr(sys, "frozen", False)
        root = Path(sys.executable).resolve().parent if frozen else Path(__file__).resolve().parent.parent
        override = os.environ.get("TLI_ROOT")
        frontend_root = Path(override) if override and os.path.isdir(override) else root
        _runtime = ReleaseIdentity(root, executable=sys.executable if frozen else None, frontend_root=frontend_root)


def public_status(routes=None):
    # A router imported without the real application bootstrap must not claim a
    # source identity was captured before its other code loaded.
    if _runtime is None:
        return {"schema_version": 1, "protocol": PROTOCOL, "source_id": None,
                "capabilities": [], "compatibility": {"state": "unknown", "reasons": ["Host startup identity was not captured."]}}
    value = _runtime.status()
    if routes is not None:
        actual = {(method, getattr(route, "path", None)) for route in routes for method in getattr(route, "methods", ()) or ()}
        value["capabilities"] = [name for name in CAPABILITIES if REQUIRED_ROUTES[name] <= actual]
    return value
