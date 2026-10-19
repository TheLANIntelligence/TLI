"""Bounded legacy license metadata with preserved, checked replacements.

One backend process serializes access. Existing damage is never an empty license;
external repair requires preserving the file and reviewing it explicitly.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import stat
import tempfile
import threading

from fastapi import HTTPException

LOCK = threading.RLock()
MAX_BYTES = 256 * 1024
MAX_KEY_BYTES = 16 * 1024
_SEEN = set()
_UNSET = object()


def unavailable():
    return HTTPException(503, "Saved license settings are unavailable or a change could not be confirmed. Existing data was preserved; review license settings before trying again.", headers={"Cache-Control": "no-store"})


def _access(check):
    if check is not None:
        check()


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError()
    return number


def validate(value, *, status=503):
    try:
        if not isinstance(value, dict):
            raise ValueError()
        key = value.get("key")
        if key is not None and (not isinstance(key, str) or len(key.encode("utf-8")) > MAX_KEY_BYTES):
            raise ValueError()
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(raw) > MAX_BYTES or json.loads(raw, object_pairs_hook=_unique) != value:
            raise ValueError()
    except (ValueError, TypeError, OverflowError, RecursionError, UnicodeError):
        if status == 503:
            raise unavailable() from None
        raise HTTPException(status, "License settings must contain bounded, valid JSON metadata.", headers={"Cache-Control": "no-store"}) from None
    return value


def _decode(raw):
    try:
        value = {} if raw is None else json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
            parse_float=_finite, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        return validate(value)
    except HTTPException:
        raise
    except Exception:
        raise unavailable() from None


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    # Windows path stat and descriptor stat may report different ctime
    # semantics. Compare ctime only between observations through the same API.
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _version(info):
    return (*_stamp(info), info.st_ctime_ns)


def _plain(info):
    return stat.S_ISREG(info.st_mode) and info.st_ino and info.st_nlink == 1 and not getattr(info, "st_file_attributes", 0) & 0x400


def _chain(path):
    if not path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts[1:]):
        raise unavailable()
    parents, current = [], Path(path.anchor)
    for component in path.parts[1:-1]:
        current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            return parents, False
        if not stat.S_ISDIR(info.st_mode) or not info.st_ino or getattr(info, "st_file_attributes", 0) & 0x400:
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


def _read_file(path, before, check):
    if not _plain(before) or before.st_size > MAX_BYTES:
        raise unavailable()
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not _plain(opened) or _stamp(opened) != _stamp(before):
            raise unavailable()
        _access(check)
        raw = stream.read(MAX_BYTES + 1)
        _access(check)
        after, current = os.fstat(stream.fileno()), path.lstat()
        if (len(raw) > MAX_BYTES or not _plain(after) or not _plain(current)
                or _version(after) != _version(opened) or _version(current) != _version(before)):
            raise unavailable()
    return raw


def _snapshot(path, check=None, on_invalid=None):
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
        raw = _read_file(path, before, check)
        if _chain(path) != (parents, True):
            raise unavailable()
        _decode(raw)
        _access(check)
        return raw, _version(before)
    except HTTPException as error:
        if not getattr(error, "license_authority_failure", False) and on_invalid is not None:
            on_invalid()
        _access(check)
        raise
    except Exception:
        if on_invalid is not None:
            on_invalid()
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


def write(path, value, *, check=None, expected=_UNSET, on_commit=None, on_uncertain=None):
    """Publish a prevalidated cache only after replacement; never retry a write."""
    path, temporary, identity = Path(path), None, None
    attempted = False
    def original_snapshot():
        # Notify while storage-failure provenance is still known, before an
        # expired-session error is allowed to replace its private public error.
        return _snapshot(path, check, on_invalid=on_uncertain)

    def conflict(detail):
        if on_uncertain is not None:
            on_uncertain()
        raise HTTPException(409, detail, headers={"Cache-Control": "no-store"})

    with LOCK:
        try:
            original = original_snapshot()
            if expected is not _UNSET and _decode(original[0]) != expected:
                conflict("License settings changed during this edit. Refresh before trying again.")
            validate(value, status=422)
            raw = json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(raw) > MAX_BYTES:
                raise HTTPException(422, "License settings exceed the saved metadata limit.", headers={"Cache-Control": "no-store"})
            _access(check); _chain(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            parents = _chain(path)
            _access(check)
            descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".tli-license-", suffix=".tmp")
            temporary = Path(name)
            with os.fdopen(descriptor, "wb") as stream:
                identity = _identity(os.fstat(stream.fileno()))
                _access(check)
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            _access(check)
            staged = temporary.lstat()
            if _identity(staged) != identity or _read_file(temporary, staged, check) != raw:
                raise unavailable()
            current_original = original_snapshot()
            if _chain(path) != parents or current_original != original:
                conflict("License settings changed during this save. Existing files were preserved; refresh before trying again.")
            current = temporary.lstat()
            if not _plain(current) or _version(current) != _version(staged):
                raise unavailable()
            _access(check)
            attempted = True
            os.replace(temporary, path)
            temporary = None
            _SEEN.add(str(path))
            if on_commit is not None:
                on_commit()  # Internal bookkeeping even if authority ended during replacement.
            attempted = False
            _access(check)
        except Exception as error:
            if attempted and on_uncertain is not None:
                on_uncertain()
            _access(check)
            if isinstance(error, HTTPException):
                raise
            raise unavailable() from None
        finally:
            if temporary is not None:
                try:
                    info = temporary.lstat()
                    if _plain(info) and _identity(info) == identity:
                        temporary.unlink()
                except OSError:
                    pass
