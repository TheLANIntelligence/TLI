"""Preserved legacy script sources for plain-text review/export, never execution.

Reads are bounded and reject linked, ambiguous, or damaged files. These checks
contain source reads; they do not turn script contents into a sandboxed program.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import stat
from collections.abc import Callable

from fastapi import HTTPException

import tli_state as S

INDEX_LIMIT = 1024 * 1024
SOURCE_LIMIT = 256 * 1024
ROW_LIMIT = 1000
UNAVAILABLE_REASON = "Host script execution is retired. Saved source is retained for review or export."
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_REPARSE_POINT = 0x400
_MISSING = object()


def _noop() -> None:
    pass


def _unavailable() -> HTTPException:
    return HTTPException(503, "Saved script data is unavailable or unsafe to read. Existing files were preserved; no replacement was created.", headers={"Cache-Control": "no-store"})


def _not_found() -> HTTPException:
    return HTTPException(404, "Registered script or saved source was not found. Existing files were preserved.", headers={"Cache-Control": "no-store"})


def _plain_file(info) -> bool:
    return (stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and not getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _change_stamp(info):
    # Windows stat/fstat can report different meanings for ctime. Compare it
    # only against a later observation made through that same API.
    return (*_stamp(info), info.st_ctime_ns)


def _chain(path: Path):
    """Reject symlinks/junctions before opening any file, including parents."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("An absolute non-traversing path is required")
    current = Path(path.anchor)
    parents = []
    for component in path.parts[1:-1]:
        current /= component
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & _REPARSE_POINT:
            raise ValueError("Linked parent directory")
        parents.append((current, _identity(info)))
    return parents


def _read_raw(path: Path, limit: int, check: Callable[[], None], *, missing=False):
    check()
    observed = False
    try:
        parents = _chain(path)
        before = path.lstat()
        observed = True
        if not _plain_file(before) or before.st_size > limit:
            raise ValueError("Unsafe or oversized source")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            # Windows has no O_NOFOLLOW: validate the opened identity before
            # reading bytes, then recheck the path and every parent as well.
            if not _plain_file(opened) or _stamp(opened) != _stamp(before):
                raise ValueError("Source changed while opening")
            if _chain(path) != parents or _change_stamp(path.lstat()) != _change_stamp(before):
                raise ValueError("Source path changed")
            check()
            raw = stream.read(limit + 1)
            check()
            if (len(raw) > limit or not _plain_file(os.fstat(stream.fileno()))
                    or _change_stamp(os.fstat(stream.fileno())) != _change_stamp(opened)
                    or _chain(path) != parents or _change_stamp(path.lstat()) != _change_stamp(before)):
                raise ValueError("Source changed while reading")
        check()
        return raw
    except FileNotFoundError:
        check()
        if observed:
            raise _unavailable() from None
        if missing:
            return None
        raise _not_found() from None
    except HTTPException:
        raise
    except Exception:
        check()
        raise _unavailable() from None


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate field")
        value[key] = item
    return value


def _finite(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Nonfinite number")
    return result


def _invalid_constant(_value):
    raise ValueError("Nonfinite number")


def _read_json(path, limit, check, *, missing_value=_MISSING):
    raw = _read_raw(Path(path), limit, check, missing=True)
    if raw is None:
        return missing_value
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                           parse_float=_finite, parse_constant=_invalid_constant)
    except Exception:
        check()
        raise _unavailable() from None
    check()
    return value


def _text(value, maximum=1024):
    return isinstance(value, str) and bool(value) and len(value) <= maximum


def _tools(check=_noop):
    value = _read_json(S.TOOLS_INDEX_PATH, INDEX_LIMIT, check, missing_value={})
    if not isinstance(value, dict) or len(value) > ROW_LIMIT:
        raise _unavailable()
    for key, row in value.items():
        if (not _text(key, 256) or not isinstance(row, dict) or row.get("id") != key
                or not _text(row.get("name")) or not _text(row.get("language"), 32)
                or not _text(row.get("script_path"), 32768)):
            raise _unavailable()
    check()
    return value


def list_tool_metadata() -> list[dict]:
    """Missing index means no saved scripts; damaged existing bytes fail closed."""
    return [{**row, "path": row.get("path", row["script_path"]), "kind": "script", "executable": False,
             "unavailable_reason": UNAVAILABLE_REASON} for row in _tools().values()]


def _source_path(raw: str, root: Path) -> Path:
    try:
        path = Path(raw)
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError("Unregistered path")
        # Root remains the configured directory, not a linked substitute.
        _chain(root / "placeholder")
        canonical = root.resolve(strict=True)
        relative = path.relative_to(canonical)
        if not relative.parts or any(":" in part for part in relative.parts):
            raise ValueError("Invalid source path")
        return path
    except FileNotFoundError:
        raise _not_found() from None
    except Exception:
        raise _unavailable() from None


def read_tool_source(tool_id: str, check: Callable[[], None]) -> dict:
    check()
    row = _tools(check).get(tool_id)
    check()
    if row is None:
        raise _not_found()
    try:
        path = _source_path(row["script_path"], Path(S.SCRIPTS_DIR))
        raw = _read_raw(path, SOURCE_LIMIT, check)
        contents = raw.decode("utf-8")
    except HTTPException:
        check()
        raise
    except Exception:
        check()
        raise _unavailable() from None
    check()
    return {"id": row["id"], "name": row["name"], "language": row["language"],
            "contents": contents, "execution_allowed": False}


def read_hub_source(pkg_id: str, check: Callable[[], None]) -> dict:
    # Hub updates span source artifacts and an installed index. Use the same
    # transaction barrier as installation and app serving, never a partial copy.
    import hub_store
    check()
    hub_store.safe_id(pkg_id)
    with hub_store.LOCK:
        hub_store.assert_ready(check)
        result = _read_hub_source(pkg_id, check)
        hub_store.assert_ready(check)
        check()
        return result


def _read_hub_source(pkg_id: str, check: Callable[[], None]) -> dict:
    import hub_store
    check()
    hub_store.safe_id(pkg_id)
    installed = list_hub_metadata(check)
    row = next((item for item in installed if item["id"] == pkg_id), None)
    if row is None:
        raise _not_found()
    if row["type"] != "script":
        raise HTTPException(400, "Only installed script packages have script source.", headers={"Cache-Control": "no-store"})
    path = Path(S.DATA_DIR) / "hub_packages" / f"script_{pkg_id}.json"
    value = _read_json(path, INDEX_LIMIT, check)
    check()
    if value is _MISSING:
        raise _not_found()
    if (not isinstance(value, dict) or value.get("id", pkg_id) != pkg_id
            or not _text(value.get("shell", "powershell"), 32) or not isinstance(value.get("code"), str)):
        raise _unavailable()
    try:
        if len(value["code"].encode("utf-8")) > SOURCE_LIMIT:
            raise ValueError("Oversized source")
    except Exception:
        raise _unavailable() from None
    check()
    return {"id": row["id"], "name": row["name"], "shell": value.get("shell", "powershell"),
            "contents": value["code"], "execution_allowed": False}


def list_hub_metadata(check: Callable[[], None]) -> list[dict]:
    """Read saved package metadata without masking damage or changing fields."""
    import hub_store
    return hub_store.load("installed", check)
