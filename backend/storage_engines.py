"""Acquisition selection for the isolated Free Space worker.

The optional raw NTFS implementation is a validation prototype. Production
selection is deliberately closed until controlled live correctness acceptance.
No environment variable or client parameter can override that acceptance gate.
"""
from __future__ import annotations

import ntpath
import os
from pathlib import Path
from typing import Protocol


class Scanner(Protocol):
    name: str

    def scan(self, root: Path, **kwargs): ...

    def metadata(self) -> dict: ...


def native_capability(path, *, platform_name=None):
    """Report eligibility without opening a raw device in the web process."""
    system = os.name if platform_name is None else platform_name
    text = str(path).replace("/", "\\")
    drive, tail = ntpath.splitdrive(text)
    if system != "nt":
        reason = "platform_not_windows"
    elif len(drive) != 2 or drive[1:] != ":" or not drive[0].isascii() or not drive[0].isalpha():
        reason = "not_local_drive_path"
    elif tail != "\\":
        reason = "native_requires_volume_scope"
    else:
        reason = "unvalidated_native_engine"
    return {"available": False, "reason": reason, "engine": "ntfs_prototype",
            "validation": "controlled_file_records_only", "requires_reader_privilege": True,
            "filesystem_probed": False}


class DirectoryScanner:
    name = "scandir"

    def __init__(self, capability, preferred="auto"):
        self.capability = capability
        self.preferred = preferred

    def metadata(self):
        return {"engine": self.name, "mft": False,
                "native_capability": dict(self.capability),
                "fallback_reason": None if self.preferred == "scandir" else self.capability["reason"],
                "observation_semantics": "live_non_atomic"}

    def scan(self, root, **kwargs):
        import storage_scan_algorithms as algorithms
        tree, largest, meta = algorithms._scan_tree(Path(root), **kwargs)
        meta.setdefault("scanner", {}).update(self.metadata())
        return tree, largest, meta


def select_engine(path, preferred="auto") -> Scanner:
    if preferred not in {"auto", "scandir", "ntfs"}:
        raise ValueError("Unsupported scanner preference")
    # Selection occurs before acquisition. No native partial result is merged
    # into a directory traversal, so fallback cannot double-count identities.
    return DirectoryScanner(native_capability(path), preferred)
