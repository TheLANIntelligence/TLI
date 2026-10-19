"""Checked changes to existing node metadata, with no identity initialization.

One backend process uses the existing node lock. An uncertain replacement blocks
shared node helpers and trust/transfer marker writers until process restart. Its
retained recovery envelope records both byte versions; it is never executed or
automatically restored. Review it with the host stopped before restarting. Other
direct readers and legacy stale-snapshot writers remain separate obligations.
Path checks detect observed changes, not hostile OS races or power loss after a
directory update; a restart does not scan envelopes or reconstruct the latch.
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
import unicodedata

from fastapi import HTTPException

MAX_BYTES = 64 * 1024
MAX_RECOVERY_BYTES = 256 * 1024
MAX_NAME_CHARS = 64
MAX_NAME_BYTES = 256
_UNCERTAIN = set()


def unavailable():
    return HTTPException(503,
        "Saved node settings are unavailable or a change could not be confirmed. "
        "Existing files were preserved. Stop TLI and review the node settings and "
        "any retained recovery files before restarting; do not repeat the save.",
        headers={"Cache-Control": "no-store"})


def _invalid(detail="Provide a nonempty name of at most 64 characters or a supported node role.", status=400):
    return HTTPException(status, detail, headers={"Cache-Control": "no-store"})


def assert_available(path):
    """Shared readers call this inside their existing node-configuration lock."""
    if str(Path(path)) in _UNCERTAIN:
        raise unavailable()


def _access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            error.node_settings_authority_failure = True
            raise


def _failure(error, check):
    if getattr(error, "node_settings_authority_failure", False):
        raise error
    _access(check)
    if isinstance(error, HTTPException):
        raise error
    raise unavailable() from None


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate node setting")
        result[key] = value
    return result


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite node setting")
    return number


def _encode(value):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise unavailable()
    return raw


def _validate(value):
    import tli_state as S
    if not isinstance(value, dict):
        raise unavailable()
    cfg = S.NodeConfig.model_validate(value, strict=True)
    if not cfg.node_id.strip() or not cfg.node_name.strip() or not cfg.created_at or not cfg.updated_at:
        raise unavailable()
    # Existing valid long names remain untouched for role-only changes.
    _encode(value)
    return value


def _decode(raw):
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique, parse_float=_finite,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite node setting")))
    return _validate(value)


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _version(info):
    return (*_stamp(info), info.st_ctime_ns)


def _plain(info):
    return (stat.S_ISREG(info.st_mode) and info.st_ino and info.st_nlink == 1
            and not getattr(info, "st_file_attributes", 0) & 0x400)


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
    if matches != [path.name]:
        raise unavailable()
    return parents


def _read_file(path, before, check, *, limit=MAX_BYTES):
    if not _plain(before) or before.st_size > limit:
        raise unavailable()
    _access(check)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
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
        assert_available(path)
        parents = _chain(path, check)
        before = path.lstat()
        raw = _read_file(path, before, check)
        if _chain(path, check) != parents:
            raise unavailable()
        document = _decode(raw)
        _access(check)
        return document, (raw, _version(before)), parents
    except Exception as error:
        _failure(error, check)


def _projection(document):
    return {"node_id": document["node_id"], "node_name": document["node_name"],
            "role": document.get("role", "standalone")}


def read_node_settings(*, check=None):
    import tli_state as S
    _access(check)
    with S._NODE_CONFIG_LOCK:
        _access(check)
        document, _, _ = _snapshot(Path(S.NODE_CONFIG_PATH), check)
        result = _projection(document)
        _access(check)
        return result


def _inputs(name, role):
    try:
        if name is not None:
            if (not isinstance(name, str) or len(name) > 256 or
                    any(unicodedata.category(c) == "Cc" for c in name)):
                raise ValueError()
            name = name.strip()
            if not name or len(name) > MAX_NAME_CHARS or len(name.encode("utf-8")) > MAX_NAME_BYTES:
                raise ValueError()
        if role is not None:
            if not isinstance(role, str) or len(role) > 32:
                raise ValueError()
            role = role.strip().lower()
            if role not in {"standalone", "host", "member"}:
                raise ValueError()
    except (ValueError, UnicodeError):
        raise _invalid() from None
    return name, role


def _staged(path, raw, suffix, check, records):
    _access(check)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".tli-node-settings-", suffix=suffix)
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


def update_node_settings(*, name=None, role=None, check=None):
    """Change only supplied display fields in one existing-node transaction."""
    import tli_state as S
    _access(check)
    try:
        name, role = _inputs(name, role)
    except Exception as error:
        _failure(error, check)
    path, records, attempted = Path(S.NODE_CONFIG_PATH), [], False
    with S._NODE_CONFIG_LOCK:
        try:
            _access(check)
            document, original, parents = _snapshot(path, check)
            changed = (name is not None and name != document["node_name"] or
                       role is not None and role != document.get("role", "standalone"))
            if not changed:
                result = _projection(document)
                _access(check)
                return result
            updated = deepcopy(document)
            if name is not None:
                updated["node_name"] = name
            if role is not None:
                updated["role"] = role
            updated["updated_at"] = S.now_iso()
            _validate(updated)
            raw = _encode(updated)
            staged, stage_version = _staged(path, raw, ".tmp", check, records)
            recovery_raw = json.dumps({
                "version": 1, "target": path.name, "operation": "node_settings",
                "before": {"sha256": hashlib.sha256(original[0]).hexdigest(),
                           "base64": base64.b64encode(original[0]).decode("ascii")},
                "after": {"sha256": hashlib.sha256(raw).hexdigest(),
                          "base64": base64.b64encode(raw).decode("ascii")},
            }, indent=2).encode("utf-8")
            recovery, recovery_version = _staged(path, recovery_raw, ".recovery.json", check, records)
            _, current, current_parents = _snapshot(path, check)
            if current != original or current_parents != parents:
                raise _invalid("Node settings changed during this save. Existing files were retained; refresh before trying again.", 409)
            for candidate, version in ((staged, stage_version), (recovery, recovery_version)):
                info = candidate.lstat()
                if not _plain(info) or _version(info) != version:
                    raise unavailable()
            _access(check)
            attempted = True
            os.replace(staged, path)
            attempted = False  # Confirmed completion, even when disclosure is denied.
            result = _projection(updated)
            _access(check)
            return result
        except Exception as error:
            if attempted:
                _UNCERTAIN.add(str(path))
            _failure(error, check)
        finally:
            if not attempted:
                for temporary, identity in records:
                    try:
                        info = temporary.lstat()
                        if _plain(info) and _identity(info) == identity:
                            temporary.unlink()
                    except OSError:
                        pass
