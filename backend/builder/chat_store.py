"""Preserve the legacy Builder chat list during serialized local updates.

The 200-message retention policy and compatible row metadata are unchanged.
Damaged or disappearing history is unavailable, never a fresh empty history.
Uncertain publication or failed owned-stage cleanup blocks this path until a
stopped-host review and restart. Before/after evidence is retained for that
review; restart does not automatically reconcile it or reconstruct the latch.
This is a persistence boundary, not a new Builder authorization contract, and
does not guarantee safety against hostile OS writers or power loss.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import tempfile
from threading import RLock

from fastapi import HTTPException

MAX_BYTES = 16 * 1024 * 1024
MAX_ROWS = 200
MAX_RECOVERY_BYTES = 3 * MAX_BYTES
LOCK_TIMEOUT = 5.0
LOCK = RLock()
_SEEN: set[str] = set()
_UNCERTAIN: set[str] = set()


def unavailable():
    return HTTPException(503,
        "Saved Builder chat history is unavailable or an update could not be confirmed. "
        "Existing files and recovery evidence were preserved. Stop TLI and review "
        "the saved history before restarting; do not repeat the change.",
        headers={"Cache-Control": "no-store"})


def _key(path):
    return os.path.normcase(str(path))


@contextmanager
def _locked():
    if not LOCK.acquire(timeout=LOCK_TIMEOUT):
        raise HTTPException(503, "Builder chat history is busy. Wait for the current operation.",
                            headers={"Cache-Control": "no-store"})
    try:
        yield
    finally:
        LOCK.release()


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate history field")
        result[key] = value
    return result


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite history field")
    return number


def _encode(rows):
    raw = json.dumps(rows, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    if len(raw) > MAX_BYTES or json.loads(raw, object_pairs_hook=_unique) != rows:
        raise ValueError("Invalid or oversized history")
    return raw


def _validate(rows):
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise ValueError("Invalid history list")
    identifiers = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid history row")
        for field in ("id", "kind", "created_at", "updated_at", "status", "task",
                      "project", "backend", "response", "thread_id", "parent_id"):
            if field in row and not isinstance(row[field], str):
                raise ValueError("Invalid history field")
        if "id" in row:
            if not row["id"] or row["id"] in identifiers:
                raise ValueError("Invalid history identifier")
            identifiers.add(row["id"])
        if "attachments" in row and (not isinstance(row["attachments"], list)
                or any(not isinstance(item, dict) for item in row["attachments"])):
            raise ValueError("Invalid history attachments")
    # Validate unknown compatible metadata without discarding it.
    return _encode(rows)


def _decode(raw):
    rows = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique, parse_float=_finite,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite history field")))
    _validate(rows)
    return rows


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _version(info):
    return (*_stamp(info), info.st_ctime_ns)


def _regular(info):
    return (stat.S_ISREG(info.st_mode) and info.st_ino
            and not getattr(info, "st_file_attributes", 0) & 0x400)


def _plain(info):
    return _regular(info) and info.st_nlink == 1


def _parents(path):
    if not path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts[1:]):
        raise unavailable()
    signature, current = [], Path(path.anchor)
    for part in path.parts[1:-1]:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return signature, False
        if (not stat.S_ISDIR(info.st_mode) or not info.st_ino
                or getattr(info, "st_file_attributes", 0) & 0x400):
            raise unavailable()
        signature.append((current, _identity(info)))
    return signature, True


def _read_file(path, before, *, limit=None):
    limit = MAX_BYTES if limit is None else limit
    if not _plain(before) or before.st_size > limit:
        raise unavailable()
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        # Windows lstat/fstat ctime semantics differ; compare each to its own kind.
        if not _plain(opened) or _stamp(opened) != _stamp(before):
            raise unavailable()
        raw = stream.read(limit + 1)
        after, current = os.fstat(stream.fileno()), path.lstat()
        if (len(raw) > limit or not _plain(after) or not _plain(current)
                or _version(after) != _version(opened) or _version(current) != _version(before)):
            raise unavailable()
    return raw


def _snapshot(path):
    if _key(path) in _UNCERTAIN:
        raise unavailable()
    parents = _parents(path)
    try:
        before = path.lstat() if parents[1] else None
    except FileNotFoundError:
        before = None
    if before is None:
        if _key(path) in _SEEN:
            raise unavailable()
        return [], (None, None), parents
    _SEEN.add(_key(path))
    raw = _read_file(path, before)
    if _parents(path) != parents:
        raise unavailable()
    return _decode(raw), (raw, _version(before)), parents


def read(path):
    with _locked():
        try:
            rows, _, _ = _snapshot(Path(path))
            return deepcopy(rows)
        except Exception:
            raise unavailable() from None


def _stage(path, raw, suffix, records):
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".tli-builder-chat-", suffix=suffix)
    temporary = Path(name)
    # Record creation before any descriptor inspection/wrapping can fail. An
    # unknown identity cannot authorize cleanup and must retain the stage/latch.
    position = len(records)
    records.append((temporary, None))
    try:
        identity = _identity(os.fstat(descriptor))
        records[position] = (temporary, identity)
        stream = os.fdopen(descriptor, "wb")
        descriptor = None  # The successfully created stream now owns the fd.
        with stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                # Never retry an uncertain close or discard its retained stage.
                records[position] = (temporary, None)
                _UNCERTAIN.add(_key(path))
                raise unavailable() from None
    before = temporary.lstat()
    limit = MAX_RECOVERY_BYTES if suffix == ".recovery.json" else MAX_BYTES
    if _identity(before) != identity or _read_file(temporary, before, limit=limit) != raw:
        raise unavailable()
    return temporary, _version(before)


def _publish(staged, path, *, new):
    if not new:
        os.replace(staged, path)
    elif os.name == "nt":
        os.rename(staged, path)  # Windows rename refuses an existing destination.
    else:
        os.link(staged, path)  # Exclusive first publication; cleanup removes stage.


def _cleanup(records):
    for temporary, identity in records:
        if identity is None:
            return False
        try:
            info = temporary.lstat()
            if not _regular(info) or _identity(info) != identity:
                return False
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            return False
    return True


def _evidence(raw):
    return None if raw is None else {"sha256": hashlib.sha256(raw).hexdigest(),
                                    "base64": base64.b64encode(raw).decode("ascii")}


def append(path, item):
    """Validate and append under one lock, retaining the existing latest-200 policy."""
    path = Path(path)
    with _locked():
        records, attempted = [], False
        try:
            rows, original, parents = _snapshot(path)
            result = deepcopy(item)
            rows.append(result)
            rows = rows[-MAX_ROWS:]
            raw = _validate(rows)
            if not parents[1]:
                # Only a genuinely absent history can reach this branch.
                if _parents(path) != parents:
                    raise unavailable()
                path.parent.mkdir(parents=True, exist_ok=True)
                created_parents = _parents(path)
                if created_parents[0][:len(parents[0])] != parents[0]:
                    raise unavailable()
                parents = created_parents
            staged, version = _stage(path, raw, ".tmp", records)
            evidence = json.dumps({"version": 1, "operation": "builder_chat", "target": path.name,
                                   "before": _evidence(original[0]), "after": _evidence(raw)},
                                  indent=2).encode("utf-8")
            recovery, recovery_version = _stage(path, evidence, ".recovery.json", records)
            _, fresh, fresh_parents = _snapshot(path)
            if fresh != original or fresh_parents != parents:
                raise unavailable()
            for candidate, expected in ((staged, version), (recovery, recovery_version)):
                info = candidate.lstat()
                if not _plain(info) or _version(info) != expected:
                    raise unavailable()
            attempted = True
            _publish(staged, path, new=original[0] is None)
            _SEEN.add(_key(path))
            # Failure here must retain remaining evidence, not retry cleanup.
            if not _cleanup(records):
                raise unavailable()
            return result
        except Exception:
            if attempted or not _cleanup(records):
                _UNCERTAIN.add(_key(path))
            raise unavailable() from None
