"""Explicit file-only Trash reviews. No permanent deletion or automatic retry."""
from __future__ import annotations

import copy
import os
import stat
import threading
import time
import uuid
from pathlib import Path

from fastapi import HTTPException
import tli_state as S
from intelligence.store import LOCK, read_private, write_private
from routers import file_routes as files
from routers.visualizer import _file_signature, _hash_duplicate_file, is_protected

_plans = {}
_plans_lock = threading.RLock()
REVIEW_SECONDS = 600
MAX_PLANS = 128
CHECK_SECONDS = 15


def _still_original(path, expected):
    try:
        current = _inspect(path)
        return (current["path"], current["signature"]) == (expected["path"], expected["signature"])
    except (OSError, ValueError):
        return False


def _inspect(raw: str, *, keeper=False) -> dict:
    path = Path(raw)
    if not path.is_absolute() or ".." in path.parts or "\x00" in raw:
        raise ValueError("Use an absolute file path without parent traversal.")
    if os.name == "nt" and (raw.startswith(("\\\\?", "\\\\.")) or ":" in raw[2:]):
        raise ValueError("Device paths and alternate data streams are not supported.")
    # Reject links, junctions and other reparse points along the entire path.
    for part in reversed((path, *path.parents)):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Links, junctions and cloud placeholders require review in your file manager.")
    path = path.resolve(strict=True)
    if not keeper:
        reason = files._is_protected_path(path)
        if reason or S.is_protected_system_path(path) or is_protected(str(path)):
            raise ValueError(reason or "Protected system file.")
    info = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Only individual files can be selected. Open the folder to review its contents.")
    if not info.st_ino or info.st_nlink != 1:
        raise ValueError("Hard-linked files or files with unknown identity require review in your file manager.")
    return {"path": str(path), "size": info.st_size, "signature": _file_signature(info)}


def _check(entries, expected=None, access_check=lambda: None, blocked=None):
    deadline = time.monotonic() + CHECK_SECONDS
    rows, checked, digests = [], [], {}
    selected = {os.path.normcase(os.path.normpath(e["path"])) for e in entries}
    seen = set()
    def digest(item):
        key = (item["path"], item["signature"])
        if key not in digests:
            digests[key] = _hash_duplicate_file(Path(item["path"]), item["signature"], deadline)
        return digests[key]
    for index, entry in enumerate(entries):
        access_check()
        row = {"path": entry["path"], "keep_path": entry.get("keep_path"), "size": None,
               "eligible": False, "reason": ""}
        item = None
        try:
            if time.monotonic() >= deadline:
                raise ValueError("Review time limit reached. Select fewer or smaller files and review again.")
            item = _inspect(entry["path"])
            row.update(path=item["path"], size=item["size"])
            identity = os.path.normcase(item["path"])
            if identity in (blocked or set()):
                raise ValueError("A previous cleanup outcome for this path is unconfirmed. Inspect its receipt and Trash; this path cannot be submitted again.")
            if identity in seen:
                raise ValueError("The same file appears more than once in this selection.")
            seen.add(identity)
            if expected and (item["path"], item["signature"]) != (expected[index]["path"], expected[index]["signature"]):
                raise ValueError("File changed since review. Review the selection again.")
            if files.send2trash is None:
                raise ValueError("Trash is unavailable on this host. Nothing will be permanently deleted.")
            if entry.get("keep_path"):
                keep = _inspect(entry["keep_path"], keeper=True)
                if os.path.normcase(keep["path"]) in selected:
                    raise ValueError("The copy to keep is also selected for cleanup. Keep at least one unselected copy.")
                if keep["signature"][:2] == item["signature"][:2] or keep["size"] != item["size"] or digest(keep) != digest(item):
                    raise ValueError("The retained file is not a separate, identical copy. No duplicate cleanup is allowed.")
                item.update(keeper=keep, digest=digest(item))
                if expected and (keep != expected[index].get("keeper") or item["digest"] != expected[index].get("digest")):
                    raise ValueError("A duplicate or retained copy changed since review. Review again.")
            row["eligible"] = True
        except (OSError, ValueError, RuntimeError) as exc:
            row["reason"] = str(exc) or "File could not be checked."
        rows.append(row)
        checked.append(item)
    return rows, checked


def _unresolved(receipt):
    return any(row.get("status") in {"unknown", "attempting", "pending"} for row in receipt.get("results", []))


def _blocked_paths(user):
    return {os.path.normcase(os.path.normpath(row["path"]))
            for saved in history(user) for row in saved.get("results", [])
            if row.get("path") and row.get("status") in {"unknown", "attempting", "pending"}}


def preview(user, entries, *, access_check=lambda: None, session_key=None):
    access_check()
    rows, checked = _check(entries, access_check=access_check, blocked=_blocked_paths(user))
    access_check()
    now = time.time()
    plan = {"id": uuid.uuid4().hex, "user": user, "entries": entries, "checked": checked,
            "rows": rows, "expires_at": now + REVIEW_SECONDS, "running": False, "receipt": None,
            "session_key": session_key}
    can_execute = bool(rows) and all(r["eligible"] for r in rows)
    with _plans_lock:
        for key, old in list(_plans.items()):
            if old["expires_at"] <= now and not old["running"]:
                _plans.pop(key)
        if len(_plans) >= MAX_PLANS:
            raise HTTPException(429, "Too many active cleanup reviews. Wait for a review to expire.")
        _plans[plan["id"]] = plan
    return {"ok": True, "preview_id": plan["id"], "expires_at": plan["expires_at"],
            "can_execute": can_execute, "items": rows, "total_bytes": sum(r["size"] or 0 for r in rows),
            "unknown_size_count": sum(r["size"] is None for r in rows),
            "message": "Review every file. All selected files must pass before anything moves.",
            "space_note": "These are file sizes, not promised freed space. Files in Trash may still occupy disk space."}


def _persist(user, receipt):
    with LOCK:
        history = read_private(user, "cleanup-receipts", [])
        previous = [r for r in history if r["id"] != receipt["id"]]
        unresolved = [r for r in previous if _unresolved(r)]
        if len(unresolved) >= 20:
            raise HTTPException(409, "Cleanup receipt storage contains unresolved operations. No new move can be journaled.")
        # Ordinary history is bounded, but must never evict an uncertain attempt.
        remaining = [r for r in previous if not _unresolved(r)]
        write_private(user, "cleanup-receipts", [receipt, *unresolved, *remaining][:20])


def history(user):
    with LOCK:
        saved = read_private(user, "cleanup-receipts", [])
    with _plans_lock:
        for receipt in saved:
            if receipt["status"] == "running" and not _plans.get(receipt["id"], {}).get("running"):
                receipt["status"] = "interrupted"
                receipt["ok"] = False
                receipt["summary"] = "Cleanup was interrupted. Unfinished results are unknown; inspect Trash and the original files before retrying."
                for item in receipt["results"]:
                    if item["status"] in {"pending", "attempting"}:
                        if receipt.get("journal_version") == 2 and item["status"] == "pending":
                            item.update(status="not_attempted", reason="The journal records that dispatch had not started.")
                        else:
                            item.update(status="unknown", reason="Completion could not be confirmed after interruption.")
    return saved


def receipt(user, ident):
    with _plans_lock:
        plan = _plans.get(ident)
        if plan and plan["user"] == user:
            if plan["receipt"]:
                return copy.deepcopy(plan["receipt"])
            return {"ok": False, "id": ident, "status": "running" if plan["running"] else "ready", "results": []}
    result = next((r for r in history(user) if r["id"] == ident), None)
    if result is None:
        raise HTTPException(404, "Cleanup receipt not found. Review again before any new cleanup.")
    return result


def _finish(plan, result):
    moved = sum(r["status"] == "trashed" for r in result["results"])
    unknown = sum(r["status"] == "unknown" for r in result["results"])
    result.update(ok=moved == len(result["results"]) and moved > 0,
                  status="completed" if moved == len(result["results"]) else "partial" if moved else "failed",
                  moved=moved, moved_bytes=sum(r["size"] or 0 for r in result["results"] if r["status"] == "trashed"),
                  finished_at=time.time())
    result["summary"] = f"Moved {moved} of {len(result['results'])} selected files to Trash. " + (
        "Review the per-file results before retrying." if not result["ok"] else "No disk-space recovery was measured.")
    if unknown:
        result["summary"] = f"Confirmed {moved} files moved to Trash; {unknown} file outcome(s) remain unconfirmed. Inspect the original files and Trash before retrying."
    try:
        _persist(plan["user"], result)
    except Exception:
        result["receipt_warning"] = "The receipt could not be saved. Keep these results before leaving this page."
    with _plans_lock:
        plan["receipt"] = copy.deepcopy(result)
    from event_bus import emit_event
    emit_event("system", "ok" if result["ok"] else "warn", "Reviewed cleanup completed" if result["ok"] else "Reviewed cleanup needs attention",
               result["summary"] + " Restore files through your operating system's Trash or Recycle Bin.")
    return result


def execute(user, ident, *, access_check=lambda: None, session_key=None):
    access_check()
    with _plans_lock:
        plan = _plans.get(ident)
        owned = plan is not None and plan["user"] == user
        if owned and plan["receipt"]:
            return copy.deepcopy(plan["receipt"])
        if owned and plan.get("session_key") != session_key:
            raise HTTPException(409, "This review belongs to another session. Review the selection again.")
        if owned and plan["running"]:
            raise HTTPException(409, "This cleanup is already running. Check its result; do not submit it again.")
        if owned and plan["expires_at"] <= time.time():
            raise HTTPException(410, "This cleanup review expired. Review the selection again.")
        if owned:
            plan["running"] = True
    if not owned:
        # Never acquire the persistence lock while holding the plans lock.
        return receipt(user, ident)
    if not files.FILE_MUTATION_LOCK.acquire(blocking=False):
        with _plans_lock:
            plan["running"] = False
        raise HTTPException(409, "Another file operation is running. Retry this reviewed request when it finishes.")
    result = {"id": ident, "ok": False, "status": "running", "journal_version": 2,
              "started_at": time.time(), "freed_bytes": None,
              "restore_note": "Restore moved files through your operating system's Trash or Recycle Bin. TLI's file Undo does not restore Trash.",
              "results": [{"path": r["path"], "keep_path": r["keep_path"], "size": r["size"],
                           "status": "pending", "ok": False, "reason": ""} for r in plan["rows"]]}
    try:
        if not all(row["eligible"] for row in plan["rows"]):
            rows = plan["rows"]
        else:
            rows, _ = _check(plan["entries"], plan["checked"], access_check, _blocked_paths(user))
        if not all(row["eligible"] for row in rows):
            for row, out in zip(rows, result["results"]):
                out.update(status="not_attempted", reason=row["reason"] or "Another selected file failed preflight; nothing was moved.")
            return _finish(plan, result)
        try:
            access_check()
            _persist(user, result)  # A receipt must be writable before the first move.
        except Exception:
            for out in result["results"]:
                out.update(status="not_attempted", reason="Could not save a cleanup receipt. Nothing was moved.")
            return _finish(plan, result)
        from event_bus import emit_event
        emit_event("system", "info", "Reviewed cleanup started", f"Moving {len(rows)} explicitly selected files to Trash.")
        for index, (entry, expected, out) in enumerate(zip(plan["entries"], plan["checked"], result["results"])):
            attempted = False
            try:
                # Revalidate identity and the retained copy immediately before each
                # path-based Trash operation, including changes during prior moves.
                current = _inspect(entry["path"])
                if (current["path"], current["signature"]) != (expected["path"], expected["signature"]):
                    raise ValueError("File changed after preflight. Nothing was moved for this file.")
                if expected.get("keeper") and _inspect(entry["keep_path"], keeper=True) != expected["keeper"]:
                    raise ValueError("The retained copy changed or disappeared. Duplicate cleanup stopped.")
                access_check()
                out.update(status="attempting", attempted_at=time.time())
                _persist(user, result)
                access_check()  # Revocation during journal I/O must stop dispatch too.
                attempted = True
                files.send2trash(current["path"])
                try:
                    Path(current["path"]).lstat()
                except FileNotFoundError:
                    out.update(ok=True, status="trashed")
                else:
                    raise RuntimeError("Trash did not remove the original path. Check the original file and Trash.")
            except Exception as exc:
                out.update(status=("failed" if _still_original(entry["path"], expected) else "unknown") if attempted else "not_attempted",
                           reason=str(getattr(exc, "detail", exc)) or "Trash could not be confirmed.")
                for remaining in result["results"][index + 1:]:
                    remaining.update(status="not_attempted", reason="Stopped after a file failed; no automatic retry.")
                break
            try:
                _persist(user, result)
            except Exception:
                for remaining in result["results"][index + 1:]:
                    remaining.update(status="not_attempted", reason="Stopped because the receipt could not be saved.")
                break
        return _finish(plan, result)
    except Exception as exc:
        for out in result["results"]:
            if out["status"] == "pending":
                out.update(status="not_attempted", reason=str(getattr(exc, "detail", exc)) or "Cleanup stopped before dispatch.")
            elif out["status"] == "attempting":
                out.update(status="unknown", reason="Cleanup stopped unexpectedly. Inspect the original file and Trash before retrying.")
        return _finish(plan, result)
    finally:
        files.FILE_MUTATION_LOCK.release()
        with _plans_lock:
            plan["running"] = False
