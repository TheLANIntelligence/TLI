"""Reviewed, exclusive file moves with durable identity-bound undo.

Only ordinary files move. Existing last_file_op.json fields remain readable;
additional evidence is required before this implementation will undo a move.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import time
import uuid

from fastapi import HTTPException
import security_state
import tli_state as S

MAX_FILES = 500
REVIEW_SECONDS = 600
_plans = {}


def _access(check):
    if check is not None:
        try:
            check()
        except Exception as error:
            # PIN/security-state unavailability is also a loss of captured
            # authority. Distinguish it from unrelated operation failures.
            error.file_authority_failure = True
            raise


def _checked(check, operation):
    _access(check)
    try:
        result = operation()
    except Exception:
        _access(check)
        raise
    _access(check)
    return result


def _routes():
    from routers import file_routes
    return file_routes


def _key(path):
    return str(path).casefold()


def _component(value):
    if not isinstance(value, str) or not value or value in {".", ".."} or value != value.strip() or value.endswith("."):
        raise ValueError("Use a nonempty name without parent traversal or trailing dots/spaces.")
    if any(ord(c) < 32 or c in '<>:"/\\|?*' for c in value):
        raise ValueError("Names cannot contain path separators, device syntax or reserved characters.")
    if re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", value):
        raise ValueError("Reserved system names are not supported.")
    return value


def _subfolder(value):
    if not isinstance(value, str) or Path(value).is_absolute() or PureWindowsPath(value).drive:
        raise ValueError("Destination must be a subfolder of the reviewed folder.")
    return Path(*[_component(part) for part in value.replace("\\", "/").split("/")])


def _tree(path, missing=False):
    """Inspect each component without following symlinks, junctions or placeholders."""
    for item in reversed((path, *path.parents)):
        try:
            info = item.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise ValueError("A selected file or folder no longer exists.") from None
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Links, junctions and cloud placeholders require your file manager.")
        if item != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError("A destination parent is not a directory.")


def _protected(path):
    path = path.resolve(strict=False)
    if path == Path(path.anchor) or S.is_protected_system_path(path):
        raise ValueError("Protected system locations cannot be organized or renamed.")
    for root in (Path(S.BASE_DIR), Path(S.DATA_DIR), Path(S.VAULT_DIR)):
        if path == root.resolve() or root.resolve() in path.parents:
            raise ValueError("TLI installation and saved-data files are protected.")
    if path.name.casefold() in _routes()._WINDOWS_ROOT_SYSTEM_FILES:
        raise ValueError("Protected system file.")


def _base(raw):
    path = Path(_routes().expand_base_path(raw))
    _tree(path)
    _protected(path)
    if not path.is_dir() or os.path.ismount(path):
        raise ValueError("Choose an ordinary folder, not a filesystem or drive root.")
    return path.resolve()


def _signature(info):
    return {"device": info.st_dev, "inode": info.st_ino, "size": info.st_size,
            "mtime_ns": info.st_mtime_ns, "ctime_ns": info.st_ctime_ns}


def _inspect(path):
    _tree(path)
    _protected(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not info.st_ino or info.st_nlink != 1:
        raise ValueError("Only regular files with a known, unique identity can be moved.")
    return _signature(info)


def _destination(path):
    _tree(path, missing=True)
    _protected(path)
    if os.path.lexists(path):
        raise ValueError("Destination already exists. TLI will not overwrite it.")


def _load():
    try:
        value = security_state.read_json(S.LAST_FILE_OP_PATH, "file-operation record", 16 * 1024 * 1024)
    except FileNotFoundError:
        return None
    def valid_record(record, nested=False):
        if not isinstance(record, dict):
            return False
        if nested and record.get("previous_operations"):
            return False
        for field, keys in (("moves", ("src", "dst")), ("renames", ("old", "new")),
                            ("results", ("source", "destination")), ("undo_results", ("source", "destination"))):
            rows = record.get(field, [])
            if not isinstance(rows, list) or len(rows) > MAX_FILES:
                return False
            if any(not isinstance(row, dict) or any(not isinstance(row.get(key), str) for key in keys) for row in rows):
                return False
        return all(record.get(field) is None or isinstance(record[field], str)
                   for field in ("id", "type", "status", "undo_status", "user_id", "timestamp"))

    if (not valid_record(value) or not isinstance(value.get("previous_operations", []), list)
            or len(value.get("previous_operations", [])) > 100
            or any(not valid_record(record, nested=True) for record in value.get("previous_operations", []))):
        raise HTTPException(503, "Saved file-operation record is unreadable. It was preserved; restore its matching backup before making more file changes.")
    return value


def _save(value, *, check=None):
    _access(check)
    if len(json.dumps(value).encode("utf-8")) > 16 * 1024 * 1024:
        raise HTTPException(409, "File-operation history is full. Keep the existing record and resolve older undo entries before making more changes.")
    _access(check)
    boundary = (lambda: _access(check)) if check is not None else None
    security_state.write_json(S.LAST_FILE_OP_PATH, value, "file-operation record", before_commit=boundary)
    # The caller must account for this completed reservation before rechecking.
    # Later saves retain known effects internally even after browser access ends.


def _records(saved):
    return [saved, *saved.get("previous_operations", [])] if saved else []


def _owned(record, user):
    return record.get("user_id") in (None, user)


def _find(saved, user, ident=None):
    if not saved:
        return None
    if ident is None or (ident == "legacy" and not saved.get("id")):
        return saved if _owned(saved, user) else None
    return next((record for record in _records(saved) if record.get("id") == ident and _owned(record, user)), None)


def _history(saved, user):
    return [{"id": record.get("id"), "type": record.get("type", "unknown"), "timestamp": record.get("timestamp"),
             "status": record.get("status", "legacy"), "undo_status": record.get("undo_status", "not_requested")}
            for record in _records(saved) if record.get("id") and _owned(record, user)]


def _undo_entries(record):
    entries = []
    for field, source, destination in (("moves", "dst", "src"), ("renames", "new", "old")):
        for item in record.get(field, []):
            if not isinstance(item, dict):
                raise ValueError("The saved undo entries are malformed; the record was preserved.")
            if item.get("undo_status") == "undone":
                continue
            entries.append({"source": item.get(source, ""), "destination": item.get(destination, ""),
                            "expected": item.get("identity"), "entry": item})
    # An interrupted move without a confirmed post-move identity is never inferred.
    for row in record.get("results", []):
        if isinstance(row, dict) and row.get("status") in {"pending", "ready", "unknown"}:
            entries.append({"source": row.get("destination", ""), "destination": row.get("source", ""), "expected": None})
    return entries


def _prepare(kind, payload, user, saved, *, check=None):
    _access(check)
    pairs, plan = [], {}
    if kind == "undo":
        record = _find(saved, user, payload.get("operation_id"))
        if record is None:
            return [], {}, None
        pairs = _undo_entries(record)
        ident = record.get("id") or "legacy"
    else:
        base = _checked(check, lambda: _base(payload["path"]))
        ident = None
        if kind == "organize":
            for folder, names in payload["actions"].items():
                _access(check)
                dest = base / _subfolder(folder)
                for name in names:
                    pairs.append({"source": str(base / _component(name)), "destination": str(dest / name)})
                    if len(pairs) > MAX_FILES:
                        raise ValueError(f"Review at most {MAX_FILES} files at a time.")
                plan[str(dest)] = list(names)
        else:
            prefix = _component(payload["prefix"])
            names = []
            _access(check)
            with os.scandir(base) as scan:
                for scanned, entry in enumerate(scan):
                    _access(check)
                    if scanned >= 10000:
                        raise ValueError("Folder has too many entries for one bounded rename review.")
                    if entry.is_file(follow_symlinks=False) or entry.is_symlink() or getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400:
                        names.append(entry.name)
                    _access(check)
                    if len(names) > MAX_FILES:
                        raise ValueError(f"Review at most {MAX_FILES} files at a time.")
            names.sort()
            width = len(str(len(names)))
            for index, name in enumerate(names, 1):
                target = _component(f"{prefix}_{str(index).zfill(width)}{Path(name).suffix}")
                pairs.append({"source": str(base / name), "destination": str(base / target)})
    if len(pairs) > MAX_FILES:
        raise ValueError(f"Review at most {MAX_FILES} files at a time.")
    rows, sources, destinations = [], set(), set()
    for pair in pairs:
        _access(check)
        row = {"source": pair["source"], "destination": pair["destination"], "status": "ready", "reason": "", "size": None}
        try:
            source, destination = Path(pair["source"]), Path(pair["destination"])
            if not source.is_absolute() or not destination.is_absolute() or ".." in (*source.parts, *destination.parts):
                raise ValueError("Saved paths are invalid; review them in your file manager.")
            if _key(source) in sources or _key(destination) in destinations:
                raise ValueError("A source or destination appears more than once in this plan.")
            sources.add(_key(source)); destinations.add(_key(destination))
            signature = _checked(check, lambda: _inspect(source))
            row.update(size=signature["size"], identity=signature)
            if kind == "undo" and (not pair.get("expected") or signature != pair["expected"]):
                raise ValueError("Undo identity is missing or the file changed. Existing files were preserved; inspect them manually.")
            if source == destination:
                row["status"] = "unchanged"
            elif _key(source) == _key(destination):
                raise ValueError("Case-only renames require your file manager.")
            else:
                _checked(check, lambda: _destination(destination))
        except (OSError, ValueError) as error:
            _access(check)
            row.update(status="blocked", reason=str(error))
        rows.append(row)
    _access(check)
    return rows, plan, ident


def _public_rows(rows):
    return [{key: value for key, value in row.items() if key != "identity"} for row in rows]


def _response(kind, payload, rows, plan, *, preview, **extra):
    complete = sum(row["status"] == ("undone" if kind == "undo" else "moved" if kind == "organize" else "renamed") for row in rows)
    response = {"ok": False, "status": "preview" if preview else "failed", "preview": preview, "items": _public_rows(rows),
                "results": _public_rows(rows), "message": "", "path": payload.get("path", ""), "plan": plan,
                "moved_count": complete if kind == "organize" else 0, "count": complete if kind == "rename" else 0,
                "renamed": [{"old": r["source"], "new": r["destination"]} for r in rows if r["status"] == "renamed"],
                "undone": complete if kind == "undo" else 0, "undo_available": False}
    response.update(extra)
    return response


def _exclusive_move(source, destination, expected, *, check=None):
    """Never use replace/shutil.move: destination creation must be exclusive."""
    if _checked(check, lambda: _inspect(source)) != expected:
        raise ValueError("File changed after preview; it was not moved.")
    _checked(check, lambda: _destination(destination))
    _access(check)
    destination.parent.mkdir(parents=True, exist_ok=True)
    _checked(check, lambda: _tree(destination.parent))
    _checked(check, lambda: _protected(destination.parent))
    _access(check)
    attempted = False
    try:
        if os.name == "nt":
            attempted = True
            os.rename(source, destination)  # MoveFileEx without replacement on Windows.
        else:
            # link() is exclusive on POSIX; rename() would overwrite a raced target.
            attempted = True
            os.link(source, destination, follow_symlinks=False)
            _access(check)
            before_unlink = _checked(check, source.lstat)
            if any(_signature(before_unlink)[key] != expected[key] for key in ("device", "inode", "size", "mtime_ns")) or stat.S_ISLNK(before_unlink.st_mode):
                raise ValueError("File changed during the move. Both paths were preserved for manual review.")
            _access(check)
            os.unlink(source)
    except Exception as error:
        if getattr(error, "file_authority_failure", False):
            error.file_move_attempted = attempted
        raise
    # Completing identity bookkeeping is internal after a dispatched move. A
    # revoked caller must not hide this known result from its recovery receipt.
    after = _inspect(destination)
    if os.path.lexists(source) or any(after[key] != expected[key] for key in ("device", "inode", "size", "mtime_ns")):
        raise ValueError("Move outcome could not be confirmed. Inspect both paths before retrying.")
    return after


def _new_record(kind, user, ident, payload, rows, saved):
    history = []
    for item in _records(saved):
        if item.get("undo_status") == "completed":
            continue
        history.append({key: copy.deepcopy(value) for key, value in item.items() if key != "previous_operations"})
    if len(history) > 100:
        raise HTTPException(409, "Resolve retained undo operations before adding more file-operation history.")
    return {"schema_version": 2, "id": ident, "user_id": user, "type": kind, "path": payload.get("path"),
            "timestamp": S.now_iso(), "status": "running", "moves": [], "renames": [],
            "request_payload": copy.deepcopy(payload),
            "results": [{**_public_rows([row])[0], "status": "unchanged" if row["status"] == "unchanged" else "pending"}
                        for row in rows], "previous_operations": history}


def _execute(kind, payload, user, rows, plan, ident, saved, operation_id, *, check=None):
    _access(check)
    invalid = any(row["status"] == "blocked" for row in rows)
    if invalid or not any(row["status"] == "ready" for row in rows):
        for row in rows:
            if row["status"] == "ready":
                row.update(status="not_attempted", reason="Another file failed preflight. Nothing was changed.")
        return _response(kind, payload, rows, plan, preview=False, ok=not invalid, status="rejected" if invalid else "no_op",
                         message="Nothing was changed. Review the blocked files." if invalid else "No file changes are needed.")
    if kind == "undo":
        record = _find(saved, user, operation_id if operation_id != "legacy" else None)
        entries = _undo_entries(record)
        record["undo_status"] = "running"
        journal = saved
    else:
        record = _new_record(kind, user, ident, payload, rows, saved)
        journal = record
    try:
        _save(journal, check=check)  # Reserve recovery evidence before filesystem changes.
    except Exception as error:
        # A denied pre-commit check made no reservation and leaves the preview
        # usable. Other write errors can be ambiguous; never replay that token.
        if not getattr(error, "file_authority_failure", False):
            error.file_operation_uncertain = True
        raise
    stopped = False
    persistence_error = False
    access_error = None
    for index, row in enumerate(rows):
        if row["status"] == "unchanged":
            continue
        if stopped:
            row.update(status="not_attempted", reason="Stopped after an earlier file needed attention.")
            continue
        source, destination = Path(row["source"]), Path(row["destination"])
        try:
            _access(check)
            signature = _exclusive_move(source, destination, row["identity"], check=check)
            row.update(status="undone" if kind == "undo" else "moved" if kind == "organize" else "renamed", reason="")
            if kind == "undo":
                entries[index]["entry"].update(undo_status="undone", restored_identity=signature)
            elif kind == "organize":
                record["moves"].append({"src": str(source), "dst": str(destination), "identity": signature, "undo_status": "available"})
            else:
                record["renames"].append({"old": str(source), "new": str(destination), "identity": signature, "undo_status": "available"})
        except Exception as error:
            if getattr(error, "file_authority_failure", False):
                access_error = error
                row.update(status="unknown" if getattr(error, "file_move_attempted", False) else "not_attempted",
                           reason="Access changed during this operation. Review the recorded paths before another request.")
                if kind == "undo" and entries[index].get("entry"):
                    entries[index]["entry"].update(undo_status="unresolved", undo_error=row["reason"])
            elif isinstance(error, (OSError, ValueError)):
                try:
                    unchanged = _inspect(source) == row["identity"]
                except (OSError, ValueError):
                    unchanged = False
                row.update(status="failed" if unchanged else "unknown", reason=str(error))
                if kind == "undo" and entries[index].get("entry"):
                    entries[index]["entry"].update(undo_status="unresolved", undo_error=str(error))
            else:
                raise
            stopped = True
        if kind != "undo":
            record["results"] = _public_rows(rows)
        else:
            record["undo_results"] = _public_rows(rows)
        try:
            _save(journal)
        except Exception:
            stopped = persistence_error = True
        try:
            _access(check)
        except Exception as error:
            if not getattr(error, "file_authority_failure", False):
                raise
            access_error = access_error or error
            stopped = True
    statuses = {row["status"] for row in rows}
    succeeded = sum(row["status"] in {"moved", "renamed", "undone"} for row in rows)
    ok = statuses <= {"moved", "renamed", "undone", "unchanged"} and not persistence_error
    status = "completed" if ok else "partial" if succeeded else "failed"
    message = f"{'Restored' if kind == 'undo' else 'Moved' if kind == 'organize' else 'Renamed'} {succeeded} of {len(rows)} files."
    unchanged_count = sum(row["status"] == "unchanged" for row in rows)
    if unchanged_count:
        message += f" {unchanged_count} already had the requested name or location."
    if not ok:
        message += " Review each result before another request; no retry ran automatically."
    if persistence_error:
        message += " The recovery record could not be fully saved. Keep these paths and inspect them manually."
    result = _response(kind, payload, rows, plan, preview=False, ok=ok, status=status, message=message,
                       operation_id=record.get("id"), undo_available=kind != "undo" and bool(succeeded) and not persistence_error)
    if access_error:
        result["access_stopped"] = True
    if kind == "undo":
        record.update(undo_status="completed" if ok else "partial", undo_results=_public_rows(rows), undo_receipt=result)
    else:
        record.update(status=status, results=_public_rows(rows), receipt=result)
    try:
        _save(journal)
    except Exception:
        result.update(ok=False, status="partial" if succeeded else "failed", undo_available=False,
                      message=message + " Recovery evidence was not confirmed saved.")
    try:
        _access(check)
    except Exception as error:
        if not getattr(error, "file_authority_failure", False):
            raise
        access_error = access_error or error
    if access_error:
        # Attach only internally; FastAPI still emits the original denial detail.
        access_error.file_operation_receipt = copy.deepcopy(result)
        raise access_error
    return result


def request(kind, user, payload, *, confirm, preview_id=None, check=None):
    _access(check)
    lock = _routes().FILE_MUTATION_LOCK
    if not lock.acquire(blocking=False):
        _access(check)
        raise HTTPException(409, "Another file operation is running. Wait for its result before retrying.")
    review = None
    try:
        _access(check)
        saved = _checked(check, _load)
        now = time.time()
        if confirm and preview_id:
            review = _plans.get(preview_id)
            if not review or review["user"] != user:
                recorded = _find(saved, user, preview_id)
                if (recorded and recorded.get("receipt") and recorded.get("type") == kind
                        and recorded.get("request_payload") == payload):
                    return _checked(check, lambda: copy.deepcopy(recorded["receipt"]))
                raise HTTPException(410, "This file review is unavailable. Preview again before changing files.")
            if review["kind"] != kind or review["payload"] != payload:
                raise HTTPException(409, "The request differs from its preview. Review it again.")
            if review.get("interrupted"):
                raise HTTPException(409, "This operation's recovery reservation was not confirmed. Inspect the saved record and paths before making a new review; this token will not repeat it.")
            if review.get("receipt"):
                return _checked(check, lambda: copy.deepcopy(review["receipt"]))
            if review["expires_at"] <= now:
                raise HTTPException(410, "This file review expired. Preview again.")
        else:
            review = None
        try:
            rows, plan, operation_id = _prepare(kind, payload, user, saved, check=check)
        except (OSError, ValueError) as error:
            _access(check)
            raise HTTPException(400, str(error)) from None
        if not confirm:
            _access(check)
            for key, old in list(_plans.items()):
                if old["expires_at"] <= now:
                    _plans.pop(key)
            if len(_plans) >= 128:
                raise HTTPException(429, "Too many active file previews. Wait for an older review to expire.")
            ident = uuid.uuid4().hex
            _plans[ident] = {"kind": kind, "user": user, "payload": copy.deepcopy(payload), "rows": copy.deepcopy(rows),
                             "operation_id": operation_id, "expires_at": now + REVIEW_SECONDS}
            can_execute = bool(rows) and all(row["status"] in {"ready", "unchanged"} for row in rows) and any(row["status"] == "ready" for row in rows)
            return _checked(check, lambda: _response(kind, payload, rows, plan, preview=True, ok=True, preview_id=ident,
                             expires_at=now + REVIEW_SECONDS, can_execute=can_execute,
                             operation_id=operation_id, history=_history(saved, user) if kind == "undo" else [],
                             message="Review every source and destination. Nothing has changed." if rows else "No files are available for this operation."))
        ident = preview_id or uuid.uuid4().hex
        if review and (review["rows"] != rows or review["operation_id"] != operation_id):
            for row in rows:
                row.update(status="blocked", reason="The files or operation changed since preview. Nothing was changed; preview again.")
            result = _response(kind, payload, rows, plan, preview=False, status="rejected",
                               message="The files or operation changed since preview. Nothing was changed; preview again.")
            review["receipt"] = copy.deepcopy(result)
            _access(check)
            return result
        result = _execute(kind, payload, user, rows, plan, ident, saved, operation_id, check=check)
        if review:
            review["receipt"] = copy.deepcopy(result)
        _access(check)
        return result
    except Exception as error:
        if review:
            if getattr(error, "file_operation_receipt", None) is not None:
                review["receipt"] = copy.deepcopy(error.file_operation_receipt)
            if getattr(error, "file_operation_uncertain", False):
                review["interrupted"] = True
        _access(check)
        raise
    finally:
        lock.release()
