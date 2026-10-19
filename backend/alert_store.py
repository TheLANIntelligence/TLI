"""Preserved ambient alerts with serialized producer and dismissal updates.

The existing list format and compatible row metadata are retained. One process
serializes shared helpers; a separate load followed by compatibility save is
still an explicit full-snapshot replacement, not an atomic edit operation.
Uncertain publication or failed owned-stage cleanup blocks every shared helper.
Retained before/after evidence is for stopped-host review, never automatic
recovery. Restart does not inspect it or rebuild process-local latches. These
checks do not guarantee safety against hostile OS writers or power loss.
"""
from __future__ import annotations

import base64
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

MAX_BYTES = 1024 * 1024
MAX_ROWS = 10000
MAX_ID_BYTES = 1024
MAX_RECOVERY_BYTES = 3 * MAX_BYTES
LOCK = RLock()
WINDOWS = os.name == "nt"
_SEEN = set()
_UNCERTAIN = set()


def unavailable():
    return HTTPException(503,
        "Saved alerts are unavailable or an update could not be confirmed. "
        "Existing files and recovery evidence were preserved. Stop TLI and review "
        "the saved alerts before restarting; do not repeat the change.",
        headers={"Cache-Control": "no-store"})


def _invalid(status=400):
    return HTTPException(status, "Provide valid bounded alert data with distinct alert identifiers.",
                         headers={"Cache-Control": "no-store"})


def _access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            error.alert_authority_failure = True
            raise


def _failure(error, check):
    if getattr(error, "alert_authority_failure", False):
        raise error
    _access(check)
    if isinstance(error, HTTPException):
        raise error
    raise unavailable() from None


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate alert field")
        result[key] = value
    return result


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite alert field")
    return number


def _text(value, limit=MAX_BYTES, *, empty=True):
    try:
        return (isinstance(value, str) and (empty or bool(value.strip()))
                and len(value.encode("utf-8")) <= limit)
    except UnicodeError:
        return False


def _encode(value):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    if len(raw) > MAX_BYTES or json.loads(raw) != value:
        raise ValueError("Invalid or oversized alert data")
    return raw


def _validate(rows, *, status=503):
    try:
        if not isinstance(rows, list) or len(rows) > MAX_ROWS:
            raise ValueError()
        ids = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError()
            for field in ("id", "kind"):
                if field in row and not _text(row[field], MAX_ID_BYTES, empty=False):
                    raise ValueError()
            for field in ("message", "detail", "severity", "created_at"):
                if field in row and not _text(row[field]):
                    raise ValueError()
            if "dismissed" in row and type(row["dismissed"]) is not bool:
                raise ValueError()
            if "id" in row:
                if row["id"] in ids:
                    raise ValueError()
                ids.add(row["id"])
        # This also validates compatible metadata without discarding fields.
        _encode(rows)
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError):
        raise unavailable() if status == 503 else _invalid(status) from None
    return rows


def _decode(raw):
    rows = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique, parse_float=_finite,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite alert field")))
    return _validate(rows)


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _version(info):
    return (*_stamp(info), info.st_ctime_ns)


def _regular(info):
    return stat.S_ISREG(info.st_mode) and info.st_ino and not getattr(info, "st_file_attributes", 0) & 0x400


def _plain(info):
    return _regular(info) and info.st_nlink == 1


def _chain(path, check):
    if not path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts[1:]):
        raise unavailable()
    parents, current = [], Path(path.anchor)
    for part in path.parts[1:-1]:
        _access(check)
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError as error:
            if getattr(error, "alert_authority_failure", False):
                raise
            _access(check)
            return parents, False
        if not stat.S_ISDIR(info.st_mode) or not info.st_ino or getattr(info, "st_file_attributes", 0) & 0x400:
            raise unavailable()
        parents.append((current, _identity(info)))
    matches = []
    for count, item in enumerate(path.parent.iterdir()):
        _access(check)
        if count >= 10000:
            raise unavailable()
        if item.name.casefold() == path.name.casefold():
            matches.append(item.name)
    if matches not in ([], [path.name]):
        raise unavailable()
    return parents, True


def _read_file(path, before, check, *, limit=MAX_BYTES):
    if not _plain(before) or before.st_size > limit:
        raise unavailable()
    _access(check)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        # Windows lstat/fstat ctime semantics differ; use ctime only within each.
        if not _plain(opened) or _stamp(opened) != _stamp(before):
            raise unavailable()
        _access(check)
        raw = stream.read(limit + 1)
        _access(check)
        after, current = os.fstat(stream.fileno()), path.lstat()
        if (len(raw) > limit or not _plain(after) or not _plain(current)
                or _version(after) != _version(opened) or _version(current) != _version(before)):
            raise unavailable()
    return raw


def _snapshot(path, check):
    _access(check)
    try:
        if str(path) in _UNCERTAIN:
            raise unavailable()
        parents, exists = _chain(path, check)
        try:
            before = path.lstat() if exists else None
        except FileNotFoundError as error:
            if getattr(error, "alert_authority_failure", False):
                raise
            before = None
        if before is None:
            _access(check)
            if str(path) in _SEEN:
                raise unavailable()
            return [], (None, None), (parents, exists)
        _SEEN.add(str(path))
        raw = _read_file(path, before, check)
        if _chain(path, check) != (parents, True):
            raise unavailable()
        rows = _decode(raw)
        _access(check)
        return rows, (raw, _version(before)), (parents, True)
    except Exception as error:
        _failure(error, check)


def read(path, *, check=None):
    _access(check)
    with LOCK:
        try:
            _access(check)
            rows, _, _ = _snapshot(Path(path), check)
            result = deepcopy(rows)
            _access(check)
            return result
        except Exception as error:
            _failure(error, check)


def _stage(path, raw, suffix, check, records):
    _access(check)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".tli-alerts-", suffix=suffix)
    temporary = Path(name)
    with os.fdopen(descriptor, "wb") as stream:
        identity = _identity(os.fstat(stream.fileno()))
        records.append((temporary, identity))
        _access(check)
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    _access(check)
    before = temporary.lstat()
    limit = MAX_RECOVERY_BYTES if suffix == ".recovery.json" else MAX_BYTES
    if _identity(before) != identity or _read_file(temporary, before, check, limit=limit) != raw:
        raise unavailable()
    return temporary, _version(before)


def _publish(staged, path, *, new=False):
    if not new:
        os.replace(staged, path)
    elif WINDOWS:
        os.rename(staged, path)
    else:
        os.link(staged, path)


def _cleanup(records):
    for temporary, identity in records:
        try:
            info = temporary.lstat()
            if _regular(info) and _identity(info) == identity:
                temporary.unlink()
            else:
                return False
        except FileNotFoundError:
            pass
        except OSError:
            return False
    return True


def _evidence(raw):
    return None if raw is None else {"sha256": hashlib.sha256(raw).hexdigest(),
                                    "base64": base64.b64encode(raw).decode("ascii")}


def update(path, change, *, check=None, force_write=False):
    """Run a single detached-list edit while holding the shared alert lock."""
    path = Path(path)
    _access(check)
    with LOCK:
        records, attempted = [], False
        try:
            _access(check)
            rows, original, parents = _snapshot(path, check)
            previous = deepcopy(rows)
            result = change(rows)
            _access(check)
            _validate(rows, status=400)
            if rows == previous and not force_write:
                result = deepcopy(result)
                _access(check)
                return result
            if not parents[1]:
                raise unavailable()  # Writes never recreate missing data roots.
            raw = _encode(rows)
            staged, version = _stage(path, raw, ".tmp", check, records)
            evidence = json.dumps({"version": 1, "operation": "alerts", "target": path.name,
                                   "before": _evidence(original[0]), "after": _evidence(raw)},
                                  indent=2).encode("utf-8")
            recovery, recovery_version = _stage(path, evidence, ".recovery.json", check, records)
            _, fresh, fresh_parents = _snapshot(path, check)
            if fresh != original or fresh_parents != parents:
                raise HTTPException(409, "Saved alerts changed during this update. Refresh before trying again.",
                                    headers={"Cache-Control": "no-store"})
            for candidate, expected in ((staged, version), (recovery, recovery_version)):
                info = candidate.lstat()
                if not _plain(info) or _version(info) != expected:
                    raise unavailable()
            _access(check)
            attempted = True
            _publish(staged, path, new=original[0] is None)
            attempted = False
            _SEEN.add(str(path))  # Confirmed bookkeeping precedes late denial.
            if not _cleanup(records):
                _UNCERTAIN.add(str(path))
                attempted = True  # Preserve remaining evidence; no cleanup retry.
                raise unavailable()
            result = deepcopy(result)
            _access(check)
            return result
        except Exception as error:
            if attempted:
                _UNCERTAIN.add(str(path))
            _failure(error, check)
        finally:
            if not attempted and not _cleanup(records):
                _UNCERTAIN.add(str(path))


def save(path, rows, *, check=None):
    def replace(current):
        candidate = deepcopy(rows)
        _validate(candidate, status=400)
        current[:] = candidate
    update(path, replace, check=check, force_write=True)


def _identifier(value):
    try:
        if not _text(value, MAX_ID_BYTES, empty=False):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise _invalid() from None


def add(path, kind, message, detail="", severity="warn", *, check=None):
    import tli_state as S
    def append(rows):
        _identifier(kind)
        for value in (message, detail, severity):
            if not _text(value):
                raise _invalid()
        if any(row.get("kind") == kind and not row.get("dismissed") for row in rows):
            return None
        if len(rows) >= MAX_ROWS:
            raise _invalid(409)
        ids = {row.get("id") for row in rows}
        for _ in range(16):
            identifier = f"alert-{S.uuid.uuid4().hex[:10]}"
            if identifier not in ids:
                break
        else:
            raise unavailable()
        row = {"id": identifier, "kind": kind, "message": message, "detail": detail,
               "severity": severity, "created_at": S.now_iso(), "dismissed": False}
        rows.append(row)
        return row
    return update(path, append, check=check)


def dismiss(path, alert_id, *, check=None):
    def change(rows):
        _identifier(alert_id)
        for row in rows:
            if row.get("id") == alert_id:
                row["dismissed"] = True
                return True
        return False
    return update(path, change, check=check)


def resolve(path, kind, *, check=None):
    def change(rows):
        _identifier(kind)
        for row in rows:
            if row.get("kind") == kind and not row.get("dismissed"):
                row["dismissed"] = True
    update(path, change, check=check)


def dismiss_all(path, *, check=None):
    def change(rows):
        count = 0
        for row in rows:
            if not row.get("dismissed"):
                row["dismissed"] = True
                count += 1
        return count
    return update(path, change, check=check)
