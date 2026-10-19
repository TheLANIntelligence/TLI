"""Strict first-run markers; reads never create or repair installation state.

One process serializes these small stores. Existing markers are never rewritten.
Publication is exclusive, not replacement. An uncertain attempt retains the
target and any staging file (whose name identifies its target), and blocks this
pair of markers until restart. Review with the host stopped before restarting;
restart does not scan staging files or reconstruct the uncertainty/seen latches.
Filesystem checks detect observed changes, not hostile OS races or power loss.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import stat
import tempfile
from threading import RLock

from fastapi import HTTPException

MAX_BYTES = 65536
LOCK = RLock()
WINDOWS = os.name == "nt"
_SEEN = set()
_UNCERTAIN = set()


def unavailable():
    return HTTPException(503,
        "Saved onboarding progress is unavailable or its update could not be confirmed. "
        "Existing files were preserved. Stop TLI and review the progress files and "
        "retained staging files before restarting; do not repeat setup.",
        headers={"Cache-Control": "no-store"})


def _access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            error.onboarding_authority_failure = True
            raise


def _failure(error, check):
    if getattr(error, "onboarding_authority_failure", False):
        raise error
    _access(check)
    if isinstance(error, HTTPException):
        raise error
    raise unavailable() from None


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate progress field")
        result[key] = value
    return result


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite progress field")
    return number


def _decode(raw, timestamp):
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique, parse_float=_finite,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite progress field")))
    # Older completion files were presence-only empty objects.
    if (not isinstance(value, dict) or not (timestamp == "completed_at" and value == {}
            or isinstance(value.get(timestamp), str) and value[timestamp].strip())):
        raise unavailable()
    # Reject escaped invalid Unicode in compatible metadata as well.
    json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    return value


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
        info = current.lstat()
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
    return parents


def _read_file(path, before, check):
    if not _plain(before) or before.st_size > MAX_BYTES:
        raise unavailable()
    _access(check)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        # Windows lstat/fstat can report different ctime semantics. Compare
        # ctime only within the same observation API, never across the two.
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


def _snapshot(path, timestamp, check):
    _access(check)
    try:
        parents = _chain(path, check)
        try:
            before = path.lstat()
        except FileNotFoundError as error:
            if getattr(error, "onboarding_authority_failure", False):
                raise
            if str(path) in _SEEN:
                raise unavailable()
            _access(check)
            return None, None, parents
        raw = _read_file(path, before, check)
        if _chain(path, check) != parents:
            raise unavailable()
        value = _decode(raw, timestamp)
        _SEEN.add(str(path))
        _access(check)
        return value, (raw, _version(before)), parents
    except Exception as error:
        _failure(error, check)


def _pair(started, completed):
    return str(Path(started)), str(Path(completed))


def _read(started, completed, check):
    import tli_state as S
    _access(check)
    try:
        if _pair(started, completed) in _UNCERTAIN:
            raise unavailable()
        cfg = S.load_pin_config()
        _access(check)
        complete_snapshot = _snapshot(completed, "completed_at", check)
        started_snapshot = _snapshot(started, "started_at", check)
        complete_value, started_value = complete_snapshot[0], started_snapshot[0]
        result = {"complete": complete_value is not None or started_value is None and bool(cfg["enabled"]),
                  "started": complete_value is None and started_value is not None}
        _access(check)
        return result, (started_snapshot, complete_snapshot)
    except Exception as error:
        _failure(error, check)


def state(started, completed, *, check=None):
    _access(check)
    with LOCK:
        _access(check)
        result, _ = _read(Path(started), Path(completed), check)
        _access(check)
        return result


def _stage(path, raw, check, records):
    _access(check)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f".tli-{path.name}-", suffix=".tmp")
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
    if _identity(before) != identity or _read_file(temporary, before, check) != raw:
        raise unavailable()
    return temporary, _version(before)


def _publish(staged, target):
    # Windows rename refuses an existing destination. POSIX rename replaces it,
    # so publish the already durable inode with an exclusive hard-link instead.
    # Filesystems without this capability fail visibly; never fall back to copy.
    if WINDOWS:
        os.rename(staged, target)
    else:
        os.link(staged, target)


def _cleanup(records):
    clean = True
    for temporary, identity in records:
        try:
            info = temporary.lstat()
            # A confirmed POSIX publication temporarily has two links. Removing
            # this exact owned staging name preserves the published marker.
            if _regular(info) and _identity(info) == identity:
                temporary.unlink()
            else:
                clean = False
        except FileNotFoundError:
            pass
        except OSError:
            clean = False
    return clean


def _change(started, completed, action, check):
    import tli_state as S
    started, completed = Path(started), Path(completed)
    _access(check)
    with LOCK:
        records, attempted = [], False
        try:
            _access(check)
            current, snapshots = _read(started, completed, check)
            needs_create = not (current["complete"] or current["started"]) if action == "start" else snapshots[1][0] is None
            if needs_create:
                target = started if action == "start" else completed
                timestamp = "started_at" if action == "start" else "completed_at"
                raw = json.dumps({timestamp: S.now_iso()}, ensure_ascii=False, allow_nan=False).encode("utf-8")
                _decode(raw, timestamp)
                staged, version = _stage(target, raw, check, records)
                _, fresh = _read(started, completed, check)
                if fresh != snapshots:
                    raise HTTPException(409, "Onboarding progress changed during this request. Refresh before continuing.",
                                        headers={"Cache-Control": "no-store"})
                info = staged.lstat()
                if not _plain(info) or _version(info) != version:
                    raise unavailable()
                _access(check)
                attempted = True
                _publish(staged, target)
                attempted = False  # The completed effect survives late denial.
                _SEEN.add(str(target))
                # Finish only owned staging cleanup before a checked reader can
                # observe the published inode's temporary second hard link.
                if not _cleanup(records):
                    _UNCERTAIN.add(_pair(started, completed))
                    attempted = True  # Keep remaining evidence; no cleanup retry.
                    raise unavailable()
                current = {"complete": action == "complete", "started": action == "start"}
            result = {"ok": True, **current} if action == "start" else {"ok": True}
            _access(check)
            return result
        except Exception as error:
            if attempted:
                _UNCERTAIN.add(_pair(started, completed))
            _failure(error, check)
        finally:
            if not attempted:
                if not _cleanup(records):
                    # Preserve the original denial/error while preventing a new
                    # attempt from accumulating unresolved staging evidence.
                    _UNCERTAIN.add(_pair(started, completed))


def start(started, completed, *, check=None):
    return _change(started, completed, "start", check)


def complete(started, completed, *, check=None):
    return _change(started, completed, "complete", check)
