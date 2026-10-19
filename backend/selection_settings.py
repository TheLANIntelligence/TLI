"""Preserved model presets and performance profiles for one backend process.

These are the two existing JSON formats, not a migration. Uncertain replacement
blocks this path until a stopped-host review and restart; no automatic retry or
repair is attempted. Filesystem checks detect observed changes, not a hostile
writer racing the final path operation or power loss after directory updates.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
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
MAX_MODELS = 128
MAX_TEXT_BYTES = 1024
_SEEN = set()
_UNCERTAIN = set()
_MODEL_DEFAULTS = {"models": {"deepseek": {
    "id": "deepseek-r1-distill-llama-8b", "label": "DeepSeek R1 Distill Llama 8B"}},
    "default_key": "deepseek"}
_PROFILE_DEFAULTS = {"profile": "balanced"}
PROFILE_KEYS = frozenset({"lite", "balanced", "power"})


def unavailable():
    return HTTPException(503, "Saved model or performance-profile settings are unavailable or a change could not be confirmed. Existing files and the last confirmed runtime choice were retained. Review the saved settings with TLI stopped before restarting.", headers={"Cache-Control": "no-store"})


def _invalid(detail="Provide a valid bounded model or performance-profile choice.", status=400):
    return HTTPException(status, detail, headers={"Cache-Control": "no-store"})


def _access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            error.selection_authority_failure = True
            raise


def defaults(kind):
    return deepcopy(_MODEL_DEFAULTS if kind == "models" else _PROFILE_DEFAULTS)


def _text(value, limit=MAX_TEXT_BYTES, *, empty=False):
    return (isinstance(value, str) and (empty or bool(value.strip()))
            and len(value.encode("utf-8")) <= limit
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate field")
        value[key] = item
    return value


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Nonfinite number")
    return number


def _encode(value):
    raw = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    if len(raw) > MAX_BYTES or json.loads(raw, object_pairs_hook=_unique) != value:
        raise ValueError("Invalid metadata")
    return raw


def model_projection(value):
    models = value["models"]
    # Both legacy spellings are supported. Conflicting nonempty aliases are
    # ambiguous and must never silently select a different model.
    keys = [value[key] for key in ("default_key", "default_model_key")
            if key in value and value[key] is not None and value[key] != ""]
    if keys:
        if any(not isinstance(key, str) for key in keys) or len(set(keys)) != 1:
            raise ValueError("Ambiguous default")
        default = keys[0]
    else:
        default = "deepseek"
    if default not in models:
        raise ValueError("Unknown default")
    projected = deepcopy(models)
    for key, row in projected.items():
        if not row.get("label"):
            row["label"] = key
    return {"default_key": default, "models": projected}


def validate(value, kind):
    try:
        if not isinstance(value, dict):
            raise ValueError()
        if kind == "models":
            models = value.get("models")
            if not isinstance(models, dict) or not 1 <= len(models) <= MAX_MODELS:
                raise ValueError()
            for key, row in models.items():
                if not _text(key, 128) or not isinstance(row, dict) or not _text(row.get("id")):
                    raise ValueError()
                if row.get("label") is not None and not _text(row["label"], empty=True):
                    raise ValueError()
            model_projection(value)
        elif kind == "profile":
            profile = value.get("profile")
            if not _text(profile, 32) or profile.strip().lower() not in PROFILE_KEYS:
                raise ValueError()
        else:
            raise ValueError()
        _encode(value)
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError):
        raise unavailable() from None
    return value


def _decode(raw, kind):
    try:
        value = defaults(kind) if raw is None else json.loads(raw.decode("utf-8"),
            object_pairs_hook=_unique, parse_float=_finite,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        return validate(value, kind)
    except HTTPException:
        raise
    except Exception:
        raise unavailable() from None


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _version(info):
    return (*_stamp(info), info.st_ctime_ns)


def _plain(info):
    return (stat.S_ISREG(info.st_mode) and info.st_ino and info.st_nlink == 1
            and not getattr(info, "st_file_attributes", 0) & 0x400)


def _chain(path, check=None):
    if not path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts[1:]):
        raise unavailable()
    parents, current = [], Path(path.anchor)
    for component in path.parts[1:-1]:
        _access(check)
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
        _access(check)
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
    _access(check)
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


def _snapshot(path, kind, check=None):
    _access(check)
    try:
        if str(path) in _UNCERTAIN:
            raise unavailable()
        parents, exists = _chain(path, check)
        try:
            before = path.lstat() if exists else None
        except FileNotFoundError:
            before = None
        if before is None:
            _access(check)
            if str(path) in _SEEN:
                raise unavailable()
            return defaults(kind), (None, None)
        _SEEN.add(str(path))
        raw = _read_file(path, before, check)
        if _chain(path, check) != (parents, True):
            raise unavailable()
        document = _decode(raw, kind)
        _access(check)
        return document, (raw, _version(before))
    except Exception as error:
        _access(check)
        if isinstance(error, HTTPException) or getattr(error, "selection_authority_failure", False):
            raise
        raise unavailable() from None


def read(path, kind, *, check=None):
    _access(check)
    with LOCK:
        _access(check)
        document, _ = _snapshot(Path(path), kind, check)
        _access(check)
        return deepcopy(document)


def update(path, kind, change, *, check=None, on_commit=None):
    """Read/modify/replace under one lock; publish only confirmed completion."""
    path, temporary, identity = Path(path), None, None
    attempted = False
    _access(check)
    with LOCK:
        try:
            _access(check)
            document, original = _snapshot(path, kind, check)
            change(document)
            validate(document, kind)
            raw = _encode(document)
            _access(check)
            _chain(path, check)
            path.parent.mkdir(parents=True, exist_ok=True)
            parents = _chain(path, check)
            _access(check)
            descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".tli-selection-", suffix=".tmp")
            temporary = Path(name)
            with os.fdopen(descriptor, "wb") as stream:
                identity = _identity(os.fstat(stream.fileno()))
                _access(check)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            _access(check)
            staged = temporary.lstat()
            if _identity(staged) != identity or _read_file(temporary, staged, check) != raw:
                raise unavailable()
            _, current = _snapshot(path, kind, check)
            if _chain(path, check) != parents or current != original:
                raise _invalid("Saved settings changed during this save. Existing files were retained; review them before trying again.", 409)
            current = temporary.lstat()
            if not _plain(current) or _version(current) != _version(staged):
                raise unavailable()
            _access(check)
            attempted = True
            os.replace(temporary, path)
            temporary = None
            _SEEN.add(str(path))
            if on_commit is not None:
                on_commit(deepcopy(document))
            attempted = False
            _access(check)
            return deepcopy(document)
        except Exception as error:
            if attempted:
                _UNCERTAIN.add(str(path))
            _access(check)
            if isinstance(error, HTTPException) or getattr(error, "selection_authority_failure", False):
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


def choose_model(document, model_id, label=None):
    try:
        if not _text(model_id) or label is not None and not _text(label, empty=True):
            raise ValueError()
        model_id = model_id.strip()
        label = label.strip() if label is not None else None
    except (ValueError, TypeError, UnicodeError):
        raise _invalid() from None
    models = document["models"]
    current = model_projection(document)["default_key"]
    matches = [key for key, row in models.items() if row["id"] == model_id]
    key = current if current in matches else (matches[0] if matches else None)
    if key is None:
        if len(models) >= MAX_MODELS:
            raise _invalid("The saved model preset limit has been reached. No presets were removed.", 409)
        base = "model-" + hashlib.sha256(model_id.encode("utf-8")).hexdigest()[:12]
        key, suffix = base, 1
        while key in models:
            key, suffix = f"{base}-{suffix}", suffix + 1
        models[key] = {"id": model_id, "label": label or model_id}
    elif label is not None:
        models[key]["label"] = label or model_id
    document["default_key"] = key
    if "default_model_key" in document:
        document["default_model_key"] = key


def choose_profile(document, profile):
    try:
        if not _text(profile, 32) or profile.strip().lower() not in PROFILE_KEYS:
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise _invalid() from None
    document["profile"] = profile.strip().lower()
