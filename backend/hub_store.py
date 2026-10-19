"""Bounded Hub storage and recoverable package changes, never code execution.

One process-wide lock serializes Hub readers and writers. A durable journal and
retained staging/backup files make interrupted multi-file changes unavailable,
not silently successful. Recovery of an interrupted change is manual; there is
no automatic retry, rollback, or destructive directory cleanup.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import uuid
from urllib.parse import urlsplit

from fastapi import HTTPException

import tli_state as S

LOCK = threading.RLock()
SETTINGS_LIMIT = 16 * 1024
INDEX_LIMIT = 1024 * 1024
REGISTRY_LIMIT = 4 * 1024 * 1024
SOURCE_LIMIT = 256 * 1024
APP_HTML_LIMIT = 512 * 1024
MANIFEST_LIMIT = 64 * 1024
ROW_LIMIT = 1000
TYPES = {"theme", "ai_preset", "script", "automation", "app"}
_ID = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?\Z")
_RESERVED = {"con", "prn", "aux", "nul", "clock$", "conin$", "conout$",
             *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))}
_MISSING = object()
_REPARSE = 0x400


def noop():
    pass


def error(status=503, detail=None):
    return HTTPException(status, detail or "Saved Hub data is unavailable or unsafe. Existing files were preserved; no empty replacement was substituted.",
                         headers={"Cache-Control": "no-store"})


def safe_id(value, *, status=400):
    if not isinstance(value, str) or not _ID.fullmatch(value) or value.split('.')[0].casefold() in _RESERVED:
        raise error(status, "Use an exact Hub package identifier with letters, numbers, internal dots, underscores or hyphens, without a reserved Windows name.")
    return value


def hub_url(value, *, status=400):
    if value == "":
        return value
    try:
        parsed = urlsplit(value)
        if (not isinstance(value, str) or len(value) > 4096 or any(c.isspace() or ord(c) < 32 for c in value)
                or "\\" in value or parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None or parsed.fragment
                or parsed.port is not None and not 1 <= parsed.port <= 65535):
            raise ValueError()
    except Exception:
        raise error(status, "Use an HTTP or HTTPS Hub registry address without credentials or a fragment.") from None
    return value


def path(name):
    root = Path(S.DATA_DIR)
    if not root.is_absolute():
        raise error()
    result = root / name
    try:
        relative = result.relative_to(root)
        if not relative.parts or any(part in {".", ".."} or ":" in part or "\\" in part for part in relative.parts):
            raise ValueError()
    except Exception:
        raise error() from None
    return result


def _identity(info):
    return info.st_dev, info.st_ino


def _stamp(info):
    return (*_identity(info), info.st_size, info.st_mtime_ns)


def _change(info):
    return (*_stamp(info), info.st_ctime_ns)


def _plain(info):
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not getattr(info, "st_file_attributes", 0) & _REPARSE


def _alias(parent, name):
    # Enforce one spelling on case-insensitive Windows and case-sensitive hosts.
    matches = []
    for count, item in enumerate(parent.iterdir()):
        if count >= 10000:
            raise error()
        if item.name.casefold() == name.casefold():
            matches.append(item.name)
    if matches and matches != [name]:
        raise error()


def _parents(target):
    """Validate every existing parent without resolving links; return identities."""
    if not target.is_absolute() or ".." in target.parts:
        raise error()
    root = Path(S.DATA_DIR)
    current = Path(target.anchor)
    parents = []
    for part in target.parts[1:-1]:
        if current == root or root in current.parents:
            _alias(current, part)
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return parents, False
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & _REPARSE:
            raise error()
        parents.append((current, _identity(info)))
    if target.parent.exists():
        _alias(target.parent, target.name)
    return parents, True


@dataclass(frozen=True)
class Snapshot:
    raw: bytes | None
    stamp: tuple | None
    value: object = None


def read_artifact(target, check=noop, limit=SOURCE_LIMIT, *, missing=False):
    """Return a bounded, unchanged regular file snapshot; do not create paths."""
    target = Path(target)
    try:
        target.relative_to(Path(S.DATA_DIR))
    except ValueError:
        raise error() from None
    check()
    try:
        parents, exists = _parents(target)
        if not exists:
            check()
            if missing:
                return Snapshot(None, None)
            raise error()
        try:
            before = target.lstat()
        except FileNotFoundError:
            check()
            if missing:
                return Snapshot(None, None)
            raise error()
        if not _plain(before) or before.st_size > limit:
            raise error()
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(target, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not _plain(opened) or _stamp(opened) != _stamp(before) or _parents(target) != (parents, True):
                raise error()
            check()
            raw = stream.read(limit + 1)
            check()
            if (len(raw) > limit or _change(os.fstat(stream.fileno())) != _change(opened)
                    or _change(target.lstat()) != _change(before) or _parents(target) != (parents, True)):
                raise error()
        check()
        return Snapshot(raw, _change(before))
    except HTTPException:
        check()
        raise
    except Exception:
        check()
        raise error() from None


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate key")
        result[key] = value
    return result


def _finite(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Nonfinite number")
    return result


def decode_json(raw, *, status=503):
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique, parse_float=_finite,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite number")))
    except Exception:
        raise error(status) from None


def encode_json(value, limit):
    try:
        raw = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
        if len(raw) > limit:
            raise ValueError()
        return raw
    except Exception:
        raise error(400, "Hub content exceeds the supported size or is not valid JSON.") from None


def _text(value, limit=1024, *, empty=False):
    try:
        return isinstance(value, str) and (empty or bool(value)) and len(value.encode("utf-8")) <= limit
    except UnicodeError:
        return False


def validate_settings(value):
    if not isinstance(value, dict) or type(value.get("enabled")) is not bool or not isinstance(value.get("hub_url"), str):
        raise error()
    hub_url(value["hub_url"], status=503)
    return value


def validate_rows(rows, *, status=503):
    if not isinstance(rows, list) or len(rows) > ROW_LIMIT:
        raise error(status)
    seen = set()
    for row in rows:
        if (not isinstance(row, dict) or not _text(row.get("name"))
                or not isinstance(row.get("type"), str) or row["type"] not in TYPES):
            raise error(status)
        identifier = safe_id(row.get("id"), status=status)
        if identifier.casefold() in seen:
            raise error(status)
        seen.add(identifier.casefold())
    return rows


def validate_package(pkg, *, status=400):
    validate_rows([pkg], status=status)
    for name in ("preview_css", "system_prompt", "code"):
        if name in pkg and not _text(pkg[name], SOURCE_LIMIT, empty=True):
            raise error(status, "Package text exceeds its supported size or has an invalid type.")
    if "inline_html" in pkg and not _text(pkg["inline_html"], APP_HTML_LIMIT, empty=True):
        raise error(status, "App HTML exceeds its supported size or has an invalid type.")
    if "permissions" in pkg and (not isinstance(pkg["permissions"], list) or len(pkg["permissions"]) > 100
            or any(not _text(p, 128) for p in pkg["permissions"])):
        raise error(status)
    if "shell" in pkg and not _text(pkg["shell"], 32):
        raise error(status)
    if "trigger" in pkg and not isinstance(pkg["trigger"], dict):
        raise error(status)
    if "actions" in pkg and (not isinstance(pkg["actions"], list) or len(pkg["actions"]) > 1000
                            or any(not isinstance(a, dict) for a in pkg["actions"])):
        raise error(status)
    return pkg


def validate_registry(value, *, status=503):
    if not isinstance(value, dict):
        raise error(status)
    validate_rows(value.get("packages"), status=status)
    for pkg in value["packages"]:
        validate_package(pkg, status=status)
    return value


_DOCUMENTS = {
    "settings": ("hub_settings.json", SETTINGS_LIMIT, validate_settings, {"enabled": False, "hub_url": ""}),
    "installed": ("hub_installed.json", INDEX_LIMIT, validate_rows, []),
    "registry": ("hub_local_registry.json", REGISTRY_LIMIT, validate_registry, {"version": "1", "hub": "TLI Local Hub", "packages": []}),
}


def document(kind, check=noop):
    name, limit, validate, default = _DOCUMENTS[kind]
    snap = read_artifact(path(name), check, limit, missing=True)
    try:
        value = copy.deepcopy(default) if snap.raw is None else decode_json(snap.raw)
        validate(value)
    except Exception:
        check()
        raise
    check()
    return Snapshot(snap.raw, snap.stamp, value)


def assert_ready(check=noop):
    """Any pending or damaged journal blocks reads and mutations, without repair."""
    check()
    pending = read_artifact(path("hub_pending.json"), check, INDEX_LIMIT, missing=True)
    if pending.raw is not None:
        # Parse strictly even though neither a valid nor damaged journal is
        # automatically trusted to choose filesystem operations.
        try:
            decode_json(pending.raw)
        except Exception:
            check()
            raise
        check()
        raise error(503, "A Hub package change is incomplete or its completion is unconfirmed. Saved package files and recovery copies were retained. Review hub_pending.json and hub_backups before another change.")


def load(kind, check=noop):
    with LOCK:
        assert_ready(check)
        return document(kind, check).value


def _ensure_parent(target, check):
    root = Path(S.DATA_DIR)
    # DATA_DIR itself is managed by TLI; never create a missing arbitrary root.
    parents, exists = _parents(root / "placeholder")
    if not exists:
        raise error()
    current = root
    for part in target.parent.relative_to(root).parts:
        _parents(current / part / "placeholder")
        check()
        try:
            (current / part).mkdir()
        except FileExistsError:
            pass
        current /= part
        _parents(current / "placeholder")
        check()


def _unchanged(target, original, limit, check):
    current = read_artifact(target, check, limit, missing=True)
    if current.raw != original.raw or current.stamp != original.stamp:
        raise error(409, "Hub files changed during this request. Existing files were preserved; review the current package before retrying.")


def atomic_write(target, raw, original, check=noop, *, limit=REGISTRY_LIMIT, before_replace=None):
    """Flush a unique temporary, compare the old snapshot, then replace once."""
    target = Path(target)
    temporary = None
    temporary_identity = None
    attempted = False
    try:
        if len(raw) > limit:
            raise error(400, "Hub content exceeds its supported size.")
        check()
        _ensure_parent(target, check)
        parents = _parents(target)
        descriptor, name = tempfile.mkstemp(prefix=".hub-", suffix=".tmp", dir=target.parent)
        temporary = Path(name)
        with os.fdopen(descriptor, "wb") as stream:
            temporary_identity = _identity(os.fstat(stream.fileno()))
            check()
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        check()
        if _parents(target) != parents:
            raise error()
        staged = read_artifact(temporary, check, limit)
        if staged.raw != raw or staged.stamp[:2] != temporary_identity:
            raise error()
        _unchanged(target, original, limit, check)
        check()
        if before_replace is not None:
            before_replace()
        attempted = True
        os.replace(temporary, target)
        temporary = None
    except HTTPException:
        check()
        raise
    except Exception:
        check()
        detail = "The Hub write was not confirmed. Existing or completed files were retained; review the saved data before retrying." if attempted else "Hub data could not be saved. Existing files were preserved."
        raise error(503, detail) from None
    finally:
        if temporary is not None:
            try:
                info = temporary.lstat()
                if _plain(info) and _identity(info) == temporary_identity:
                    temporary.unlink()
            except OSError:
                pass


def update(kind, mutate, check=noop):
    with LOCK:
        assert_ready(check)
        original = document(kind, check)
        value = mutate(copy.deepcopy(original.value))
        check()
        name, limit, validate, _ = _DOCUMENTS[kind]
        validate(value)
        raw = encode_json(value, limit)
        atomic_write(path(name), raw, original, check, limit=limit)
        check()
        return value


def artifact_paths(identifier, kind):
    safe_id(identifier)
    if kind == "app":
        return [path(f"apps/{identifier}/index.html"), path(f"apps/{identifier}/manifest.json")]
    prefixes = {"theme": ("theme", "css"), "ai_preset": ("preset", "json"),
                "script": ("script", "json"), "automation": ("automation", "json")}
    if kind not in prefixes:
        raise error(400, "Unsupported Hub package type.")
    prefix, suffix = prefixes[kind]
    return [path(f"hub_packages/{prefix}_{identifier}.{suffix}")]


def _manifest(value, identifier):
    if (not isinstance(value, dict) or value.get("id") != identifier or value.get("entry") != "index.html"
            or not _text(value.get("name")) or not isinstance(value.get("permissions", []), list)
            or len(value.get("permissions", [])) > 100 or any(not _text(p, 128) for p in value.get("permissions", []))):
        raise error()
    return value


def _old_artifacts(record, check):
    result = []
    for target in artifact_paths(record["id"], record["type"]):
        limit = (APP_HTML_LIMIT if target.name == "index.html" else MANIFEST_LIMIT if target.name == "manifest.json"
                 else SOURCE_LIMIT if target.suffix == ".css" else INDEX_LIMIT)
        snap = read_artifact(target, check, limit, missing=True)
        if snap.raw is not None:
            try:
                if target.suffix == ".json":
                    value = decode_json(snap.raw)
                    if not isinstance(value, dict) or value.get("id", record["id"]) != record["id"]:
                        raise error()
                    if target.name == "manifest.json":
                        _manifest(value, record["id"])
                    elif record["type"] == "ai_preset" and not _text(value.get("system_prompt"), SOURCE_LIMIT, empty=True):
                        raise error()
                    elif record["type"] == "script" and (not _text(value.get("code"), SOURCE_LIMIT, empty=True)
                            or not _text(value.get("shell", "powershell"), 32)):
                        raise error()
                    elif record["type"] == "automation" and (not isinstance(value.get("trigger"), dict)
                            or not isinstance(value.get("actions"), list)
                            or any(not isinstance(item, dict) for item in value["actions"])):
                        raise error()
                else:
                    snap.raw.decode("utf-8")
            except Exception:
                check()
                raise error() from None
        result.append((target, snap))
    return result


def _payloads(pkg, old):
    identifier, kind = pkg["id"], pkg["type"]
    targets = artifact_paths(identifier, kind)
    def old_json(index):
        return decode_json(old[index][1].raw) if old[index][1].raw is not None else {}
    if kind == "theme":
        return [(targets[0], pkg.get("preview_css", "").encode("utf-8"))]
    if kind == "app":
        html = pkg.get("inline_html")
        if not html:
            raise error(400, "App packages must include their index.html content.")
        manifest = {**old_json(1), "id": identifier, "name": pkg["name"], "version": pkg.get("version", "1.0"),
                    "author": pkg.get("author", "Unknown"), "permissions": pkg.get("permissions", []),
                    "icon": pkg.get("icon", "📦"), "entry": "index.html"}
        return [(targets[0], html.encode("utf-8")), (targets[1], encode_json(manifest, MANIFEST_LIMIT))]
    value = {**old_json(0), "id": identifier, "name": pkg["name"]}
    if kind == "ai_preset":
        value["system_prompt"] = pkg.get("system_prompt", "")
    elif kind == "script":
        value.update(shell=pkg.get("shell", "powershell"), code=pkg.get("code", ""))
    else:
        value.update(trigger=pkg.get("trigger", {}), actions=pkg.get("actions", []))
    return [(targets[0], encode_json(value, INDEX_LIMIT))]


def _move_to_backup(target, original, destination, check, mark):
    _unchanged(target, original, REGISTRY_LIMIT, check)
    if original.raw is None:
        return
    _ensure_parent(destination, check)
    if read_artifact(destination, check, REGISTRY_LIMIT, missing=True).raw is not None:
        raise error()
    check()
    mark()
    try:
        os.replace(target, destination)
    except Exception:
        check()
        raise error(503, "The Hub removal was not confirmed. Package files and recovery copies were retained; review the pending change before retrying.") from None


def _clear_journal(original):
    # Cleanup is internal bookkeeping after completed writes, not a new user
    # effect. Do not strand a known completed commit merely because access ended.
    journal = path("hub_pending.json")
    _unchanged(journal, original, INDEX_LIMIT, noop)
    try:
        journal.unlink()
    except Exception:
        raise error(503, "The Hub change completed but journal cleanup was not confirmed. Review the retained recovery files before retrying.") from None


def change_package(pkg, identifier, check=noop, *, remove=False, installed_at=""):
    """Stage old/new bytes, journal, then make exact changes and commit metadata."""
    safe_id(identifier)
    with LOCK:
        assert_ready(check)
        installed = document("installed", check)
        records = installed.value
        existing = next((row for row in records if row["id"] == identifier), None)
        alias = next((row for row in records if row["id"].casefold() == identifier.casefold()), None)
        if alias is not None and existing is None:
            raise error(409, "A package with a different letter case already uses this identifier.")
        if remove and existing is None:
            raise error(404, "Package not installed.")
        if not remove:
            validate_package(pkg)
            if pkg["id"] != identifier:
                raise error(400, "Package identifier mismatch.")
            if existing and existing["type"] != pkg["type"]:
                raise error(409, "An installed package cannot change type. Review and uninstall its existing copy first.")
        record = existing if remove else {**(existing or {}), "id": identifier, "type": pkg["type"], "name": pkg["name"],
            "author": pkg.get("author", "Unknown"), "version": pkg.get("version", "1.0"), "installed_at": installed_at}
        old = _old_artifacts(record, check)
        if existing is None and any(snap.raw is not None for _, snap in old):
            raise error(409, "Unregistered package files already exist. They were preserved; review them before installing.")
        replacements = [] if remove else _payloads(pkg, old)
        rows = [row for row in records if row["id"] != identifier]
        if not remove:
            rows.append(record)
        validate_rows(rows)
        updated_index = encode_json(rows, INDEX_LIMIT)
        transaction = uuid.uuid4().hex
        backup = path(f"hub_backups/{transaction}")
        plans = [(target, snap, None if remove else dict(replacements)[target]) for target, snap in old]
        plans.append((path("hub_installed.json"), installed, updated_index))
        # All recoverable bytes are durably staged before any destination change.
        for index, (_, snap, raw) in enumerate(plans):
            if snap.raw is not None:
                atomic_write(backup / f"{index}.before", snap.raw, Snapshot(None, None), check)
            if raw is not None:
                atomic_write(backup / f"{index}.after", raw, Snapshot(None, None), check)
        journal = {"schema": 1, "operation": "uninstall" if remove else "install", "package_id": identifier,
                   "backup_id": transaction, "files": [{"path": str(target.relative_to(Path(S.DATA_DIR))).replace("\\", "/"),
                   "before_file": f"{index}.before" if snap.raw is not None else None,
                   "after_file": f"{index}.after" if raw is not None else None,
                   "removed_file": f"{index}.removed" if raw is None and snap.raw is not None else None,
                   "before_sha256": hashlib.sha256(snap.raw).hexdigest() if snap.raw is not None else None,
                   "after_sha256": hashlib.sha256(raw).hexdigest() if raw is not None else None}
                   for index, (target, snap, raw) in enumerate(plans)]}
        journal_path = path("hub_pending.json")
        journal_raw = encode_json(journal, INDEX_LIMIT)
        # Retain the path/hash mapping after the pending marker is cleared.
        # This is review data only, never an automatic recovery instruction.
        atomic_write(backup / "recovery.json", journal_raw, Snapshot(None, None), check, limit=INDEX_LIMIT)
        try:
            atomic_write(journal_path, journal_raw, Snapshot(None, None), check, limit=INDEX_LIMIT)
            saved_journal = read_artifact(journal_path, noop, INDEX_LIMIT)
        except Exception:
            # No destination was attempted. Clear only our exact journal if a
            # late error followed its replace; preserve any foreign/damaged file.
            try:
                current = read_artifact(journal_path, noop, INDEX_LIMIT, missing=True)
                if current.raw == journal_raw:
                    _clear_journal(current)
            except Exception:
                pass
            check()
            raise
        attempted = False
        def mark():
            nonlocal attempted
            attempted = True
        try:
            for target, snap, _ in plans:
                _unchanged(target, snap, REGISTRY_LIMIT, check)
            completed = []
            for index, (target, snap, raw) in enumerate(plans):
                if raw is None:
                    _move_to_backup(target, snap, backup / f"{index}.removed", check, mark)
                else:
                    atomic_write(target, raw, snap, check, before_replace=mark)
                # Finish internal commit accounting even if the final write
                # revoked access. User disclosure still requires the check below.
                written = read_artifact(target, noop, REGISTRY_LIMIT, missing=True)
                if written.raw != raw:
                    raise error(503, "Hub package files changed while confirming the update. Recovery copies were retained for review.")
                completed.append((target, written))
            for target, written in completed:
                _unchanged(target, written, REGISTRY_LIMIT, noop)
            _clear_journal(saved_journal)
        except Exception:
            unchanged = not attempted
            if attempted:
                try:
                    for target, snap, _ in plans:
                        _unchanged(target, snap, REGISTRY_LIMIT, noop)
                    unchanged = True
                except Exception:
                    pass
            if unchanged:
                try:
                    _clear_journal(saved_journal)
                except Exception:
                    check()
                    raise
            check()
            raise
        check()
        return record


def app_snapshot(identifier, check=noop):
    """Read one complete installed app generation; returned HTML is inert data."""
    safe_id(identifier)
    with LOCK:
        assert_ready(check)
        installed = document("installed", check)
        record = next((row for row in installed.value if row["id"] == identifier and row["type"] == "app"), None)
        if record is None:
            check()
            raise error(404, "Installed app not found.")
        html_path, manifest_path = artifact_paths(identifier, "app")
        html = read_artifact(html_path, check, APP_HTML_LIMIT)
        manifest = read_artifact(manifest_path, check, MANIFEST_LIMIT)
        try:
            value = _manifest(decode_json(manifest.raw), identifier)
            html.raw.decode("utf-8")
        except HTTPException:
            check()
            raise
        except Exception:
            check()
            raise error() from None
        _unchanged(path("hub_installed.json"), installed, INDEX_LIMIT, check)
        _unchanged(html_path, html, APP_HTML_LIMIT, check)
        _unchanged(manifest_path, manifest, MANIFEST_LIMIT, check)
        assert_ready(check)
        check()
        return copy.deepcopy(record), value, html.raw
