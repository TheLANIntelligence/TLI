"""Strict legacy satellite registry storage; no migration or implicit recovery.

The list-of-dictionaries format is retained. One backend process serializes
read/modify/write through LOCK. Existing damage or uncertain writes never
become an empty success; external restoration requires a stopped host.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import stat
import tempfile
import threading
import re
from datetime import datetime

from fastapi import HTTPException

LOCK = threading.RLock()
MAX_BYTES = 1024 * 1024
MAX_ROWS = 512
_SEEN = set()
_UNSET = object()
_REPARSE = 0x400


def unavailable():
    return HTTPException(503, "Saved satellite registry data is unavailable or a save could not be confirmed. Existing files were retained; no empty registry was substituted. Review the saved file before retrying.", headers={"Cache-Control": "no-store"})


def _access(check):
    if check is not None:
        check()


def _fail(status):
    if status == 503:
        return unavailable()
    return HTTPException(status, "Provide a valid satellite registry with distinct identities and valid pairing credentials.", headers={"Cache-Control": "no-store"})


def _text(value, limit=1024, *, empty=False):
    try:
        return isinstance(value, str) and (empty or bool(value.strip())) and len(value.encode("utf-8")) <= limit
    except UnicodeError:
        return False


def validate(rows, *, status=503):
    try:
        if not isinstance(rows, list) or len(rows) > MAX_ROWS:
            raise ValueError()
        identities = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError()
            node_id, secret = row.get("node_id"), row.get("secret")
            if (not isinstance(node_id, str) or not re.fullmatch(r"sat_[0-9a-f]{10}", node_id)
                    or node_id in identities or not isinstance(secret, str)
                    or not re.fullmatch(r"[0-9a-f]{40}", secret)):
                raise ValueError()
            identities.add(node_id)
            for field in ("name", "platform", "connection_type"):
                if field in row and row[field] is not None and not _text(row[field], 1024, empty=True):
                    raise ValueError()
            for field in ("registered_at", "last_seen"):
                if field in row:
                    if not _text(row[field], 64):
                        raise ValueError()
                    datetime.fromisoformat(row[field].replace("Z", "+00:00"))
            for field in ("online", "battery_charging"):
                if field in row and row[field] is not None and type(row[field]) is not bool:
                    raise ValueError()
            battery = row.get("battery_level")
            if battery is not None and (type(battery) is not int or not 0 <= battery <= 100):
                raise ValueError()
        encoded = json.dumps(rows, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_BYTES or json.loads(encoded, object_pairs_hook=_unique) != rows:
            raise ValueError()
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError):
        raise _fail(status) from None
    return rows


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate field")
        result[key] = value
    return result


def _finite(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Nonfinite number")
    return result


def _decode(raw):
    try:
        value = [] if raw is None else json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
            parse_float=_finite, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        return validate(value)
    except HTTPException:
        raise
    except Exception:
        raise unavailable() from None


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _plain(info):
    return bool(info.st_ino) and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not getattr(info, "st_file_attributes", 0) & _REPARSE


def _chain(path):
    if not path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts[1:]):
        raise unavailable()
    parents = []
    current = Path(path.anchor)
    for component in path.parts[1:-1]:
        current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            return parents, False
        if not info.st_ino or not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & _REPARSE:
            raise unavailable()
        parents.append((current, _identity(info)))
    matches = []
    for count, item in enumerate(path.parent.iterdir()):
        if count >= 10000:
            raise unavailable()
        if item.name.casefold() == path.name.casefold():
            matches.append(item.name)
    if matches and matches != [path.name]:
        raise unavailable()
    return parents, True


def _snapshot(path, check=None):
    _access(check)
    try:
        parents, exists = _chain(path)
        try:
            before = path.lstat() if exists else None
        except FileNotFoundError:
            before = None
        if before is None:
            _access(check)
            if str(path) in _SEEN:
                raise unavailable()
            return None, None
        _SEEN.add(str(path))
        if not _plain(before) or before.st_size > MAX_BYTES:
            raise unavailable()
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not _plain(opened) or _stamp(opened) != _stamp(before) or _chain(path) != (parents, True):
                raise unavailable()
            _access(check)
            raw = stream.read(MAX_BYTES + 1)
            _access(check)
            after = os.fstat(stream.fileno())
            current = path.lstat()
            if (len(raw) > MAX_BYTES or not _plain(after) or not _plain(current)
                    or (*_stamp(after), after.st_ctime_ns) != (*_stamp(opened), opened.st_ctime_ns)
                    or (*_stamp(current), current.st_ctime_ns) != (*_stamp(before), before.st_ctime_ns)
                    or _chain(path) != (parents, True)):
                raise unavailable()
        _decode(raw)
        _access(check)
        return raw, (*_stamp(before), before.st_ctime_ns)
    except HTTPException:
        _access(check)
        raise
    except Exception:
        _access(check)
        raise unavailable() from None


def read(path, *, check=None):
    with LOCK:
        try:
            raw, _ = _snapshot(Path(path), check)
            value = _decode(raw)
            _access(check)
            return value
        except Exception:
            _access(check)
            raise


def _verify_staged(path, identity, raw, check):
    info = path.lstat()
    if not _plain(info) or _identity(info) != identity or info.st_size != len(raw):
        raise unavailable()
    _access(check)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not _plain(opened) or _stamp(opened) != _stamp(info):
            raise unavailable()
        staged = stream.read(MAX_BYTES + 1)
        after, current = os.fstat(stream.fileno()), path.lstat()
        if (staged != raw or not _plain(after) or not _plain(current)
                or (*_stamp(after), after.st_ctime_ns) != (*_stamp(opened), opened.st_ctime_ns)
                or (*_stamp(current), current.st_ctime_ns) != (*_stamp(info), info.st_ctime_ns)):
            raise unavailable()
    _access(check)
    return (*_stamp(current), current.st_ctime_ns)


def write(path, rows, *, check=None, expected=_UNSET, before_commit=None):
    path = Path(path)
    temporary, identity = None, None
    with LOCK:
        try:
            original = _snapshot(path, check)
            if expected is not _UNSET and _decode(original[0]) != expected:
                raise HTTPException(409, "The satellite registry changed during this edit. Refresh the saved list before trying again.", headers={"Cache-Control": "no-store"})
            validate(rows, status=422)
            raw = json.dumps(rows, indent=2, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(raw) > MAX_BYTES:
                raise _fail(422)
            _access(check)
            # Validate each existing ancestor before creating a missing parent.
            _chain(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            parents = _chain(path)
            _access(check)
            descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".tli-satellite-", suffix=".tmp")
            temporary = Path(name)
            with os.fdopen(descriptor, "wb") as stream:
                identity = _identity(os.fstat(stream.fileno()))
                _access(check)
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            _access(check)
            staged_stamp = _verify_staged(temporary, identity, raw, check)
            if _chain(path) != parents or _snapshot(path, check) != original:
                raise HTTPException(409, "The satellite registry changed during this save. Existing files were preserved; refresh before trying again.", headers={"Cache-Control": "no-store"})
            staged_now = temporary.lstat()
            if not _plain(staged_now) or (*_stamp(staged_now), staged_now.st_ctime_ns) != staged_stamp:
                raise unavailable()
            _access(check)
            if before_commit is not None:
                before_commit()
            os.replace(temporary, path)
            temporary = None
            _SEEN.add(str(path))
            _access(check)
        except HTTPException:
            _access(check)
            raise
        except Exception:
            _access(check)
            raise unavailable() from None
        finally:
            if temporary is not None:
                try:
                    info = temporary.lstat()
                    if _plain(info) and _identity(info) == identity:
                        temporary.unlink()
                except OSError:
                    pass
