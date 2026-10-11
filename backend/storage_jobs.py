"""Owner/session-bound storage jobs with one intensive reader per TLI host."""
from __future__ import annotations
import copy
from datetime import datetime, timezone
import hashlib
import json
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
import tli_state as S
from storage_scan_worker import PROFILES, MAX_MEMORY, MAX_RESULT, canonical
import storage_scan_process as process

PROTOCOL = "storage-jobs-v1"
TTL = 1800
MAX_CACHE = 4
MAX_CACHE_BYTES = 64 * 1024 * 1024
MAX_REQUEST_IDS = 128
TERMINAL = {"completed", "partial", "cancelled", "failed"}
TRANSIENT = {"drives", "paths", "path_exists"}
_lock = threading.RLock()
_jobs = {}
_requests = {}
_active = None


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class StartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["scan", "large_files", "duplicates", "common_folders"]
    path: str | None = Field(default=None, min_length=1, max_length=4096)
    profile: Literal["quick", "deep"] = "quick"
    include_excluded: StrictBool = False
    request_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    min_mb: float = Field(default=100, ge=1, le=50_000, allow_inf_nan=False, strict=True)
    limit: int = Field(default=200, ge=10, le=2000, strict=True)

    @model_validator(mode="after")
    def check_scope(self):
        if self.include_excluded and self.profile != "deep":
            raise ValueError("Including excluded folders requires an explicit Deep scan")
        if self.operation != "common_folders" and (not self.path or not self.path.strip()):
            raise ValueError("Choose a folder")
        if self.path and ("\x00" in self.path or len(self.path.encode("utf-8")) > 12_000):
            raise ValueError("Unsupported scan path")
        return self


@dataclass(frozen=True)
class Access:
    owner: str
    kind: str
    credential: str

    @property
    def key(self):
        return hashlib.sha256(canonical([self.owner, self.kind, self.credential])).hexdigest()

    def valid(self):
        try:
            if self.kind == "browser":
                return S.validate_session_token(self.credential) and S.get_session_user_id(self.credential) == self.owner
            if self.kind == "bearer":
                from companion_auth import credential_owner
                return credential_owner(self.credential) == self.owner
            return self.kind == "local" and not S.load_pin_config()["enabled"]
        except Exception:
            return False


def access(request: Request, owner: str):
    # require_session has already authenticated and rejected malformed Bearer
    # headers. Preserve this credential generation, never put it in a worker.
    authorization = request.headers.get("authorization")
    if authorization is not None:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer" or request.url.scheme != "https":
            raise HTTPException(401, "A valid secure session is required")
        result = Access(owner, "bearer", parts[1])
    else:
        token = request.cookies.get("tli_session")
        result = Access(owner, "browser", token) if token and S.validate_session_token(token) else Access(owner, "local", "")
    if not result.valid():
        raise HTTPException(401, "The scan session is unavailable. Unlock again.")
    return result


def _public(job):
    return {key: copy.deepcopy(job[key]) for key in ("id", "host", "operation", "profile", "include_excluded", "path", "status", "started_at", "updated_at", "finished_at",
            "expires_at", "progress", "limits", "result_available", "error", "worker_stopped")}


def _prune():
    now = time.time()
    for ident, job in list(_jobs.items()):
        if ident != _active and (job["expiry"] <= now or not job["access"].valid()):
            del _jobs[ident]
    for key, row in list(_requests.items()):
        if row["expiry"] <= now:
            del _requests[key]


def _evict(needed=0, *, reserve=0):
    def retained(): return [j for j in _jobs.values() if not j.get("transient")]
    while len(retained()) + reserve > MAX_CACHE or sum(j["bytes"] for j in retained()) + needed > MAX_CACHE_BYTES:
        choices = [j for j in retained() if j["id"] != _active]
        if not choices:
            break
        del _jobs[min(choices, key=lambda j: j["created"])["id"]]


def _get(credential, ident):
    if not credential.valid():
        raise HTTPException(401, "The scan session ended. Unlock again.")
    _prune()
    job = _jobs.get(ident)
    if not job or job["access"].key != credential.key:
        raise HTTPException(404, "This scan is unavailable for this session or has expired.")
    return job


def _validate_result(operation, frame):
    result = frame.get("result")
    if not isinstance(result, dict) or len(canonical(frame)) > MAX_RESULT:
        raise ValueError("Invalid scan result")
    field = {"scan": "tree", "large_files": "files", "duplicates": "groups", "common_folders": "targets", "drives": "drives", "paths": "common", "path_exists": "exists"}[operation]
    expected = dict if field in {"tree", "common"} else bool if field == "exists" else list
    if not isinstance(result.get(field), expected):
        raise ValueError("Invalid operation result")
    if operation in {"scan", "large_files", "duplicates"}:
        meta = result.get("meta")
        if not isinstance(meta, dict) or type(meta.get("partial")) is not bool or not isinstance(meta.get("root"), str):
            raise ValueError("Invalid scan coverage")
    def metadata_row(row):
        for key in ("allocated_size", "allocated_known_bytes", "logical_size", "files", "omitted_allocated_known_bytes"):
            value = row.get(key)
            if value is not None and (type(value) is not int or not 0 <= value < 2**63):
                raise ValueError("Invalid measured storage metadata")
        for key in ("allocated_partial", "hardlink_duplicate", "omitted_allocation_partial"):
            if key in row and type(row[key]) is not bool:
                raise ValueError("Invalid storage metadata coverage")
        for key in ("modified_at", "created_at", "extension", "category", "kind"):
            if row.get(key) is not None and (not isinstance(row[key], str) or len(row[key]) > 80):
                raise ValueError("Invalid storage metadata label")
    if operation == "scan":
        pending, nodes = [result["tree"]], 0
        while pending:
            node = pending.pop(); nodes += 1
            if nodes > 25_000 or not isinstance(node, dict) or not isinstance(node.get("name"), str) or not isinstance(node.get("path"), str) or len(node["path"]) > 4096 or type(node.get("size")) is not int or not 0 <= node["size"] < 2**63:
                raise ValueError("Unsupported tree node")
            metadata_row(node)
            children = node.get("children", [])
            if not isinstance(children, list): raise ValueError("Invalid tree children")
            pending.extend(children)
        if not isinstance(result.get("largest"), list) or len(result["largest"]) > 200:
            raise ValueError("Invalid largest-file summary")
        identity = frame.get("identity")
        if not isinstance(identity, dict) or set(identity) != {"before", "after"}:
            raise ValueError("Missing scan identity")
        for item in identity.values():
            if not isinstance(item, dict) or item.get("status") not in {"known", "unknown"}:
                raise ValueError("Unsupported scan identity")
            if item["status"] == "known" and (not isinstance(item.get("fingerprint"), str) or len(item["fingerprint"]) != 64 or any(c not in "0123456789abcdef" for c in item["fingerprint"])):
                raise ValueError("Invalid scan fingerprint")
        summary = result["meta"].get("file_summary", [])
        if not isinstance(summary, list) or len(summary) > 500:
            raise ValueError("Invalid bounded file summary")
        for row in summary:
            if not isinstance(row, dict):
                raise ValueError("Invalid file summary row")
            relative = row.get("path")
            if not isinstance(relative, str) or not 0 < len(relative) <= 4096 or PureWindowsPath(relative).drive or relative.startswith(("/", "\\")) or ".." in relative.replace("\\", "/").split("/"):
                raise ValueError("Invalid relative file summary path")
            if type(row.get("bytes")) is not int or not 0 <= row["bytes"] < 2**63:
                raise ValueError("Invalid file summary size")
            metadata_row(row)
        if "file_summary_complete" in result["meta"] and type(result["meta"]["file_summary_complete"]) is not bool:
            raise ValueError("Invalid file summary coverage")
    def file_row(row):
        return (isinstance(row, dict) and isinstance(row.get("path"), str) and 0 < len(row["path"]) <= 4096
                and type(row.get("size")) is int and 0 <= row["size"] < 2**63)
    if operation in {"large_files", "scan"}:
        rows = result["files"] if operation == "large_files" else result["largest"]
        if len(rows) > 2000 or any(not file_row(row) for row in rows):
            raise ValueError("Invalid file rows")
        for row in rows:
            metadata_row(row)
    if operation == "duplicates":
        if len(result["groups"]) > 100:
            raise ValueError("Too many duplicate groups")
        for row in result["groups"]:
            if not isinstance(row, dict) or type(row.get("size")) is not int or not 0 < row["size"] < 2**63 or row.get("verified") is not True:
                raise ValueError("Invalid duplicate verification")
            paths = row.get("paths")
            if not isinstance(paths, list) or not 2 <= len(paths) <= 500_000 or len(set(paths)) != len(paths) or any(not isinstance(p, str) or not 0 < len(p) <= 4096 for p in paths):
                raise ValueError("Invalid duplicate paths")
            if type(row.get("count")) is not int or row["count"] != len(paths) or row.get("wasted_bytes") != row["size"] * (len(paths) - 1):
                raise ValueError("Invalid duplicate totals")
    if operation in {"common_folders", "drives"}:
        rows = result[field]
        if len(rows) > 256 or any(not isinstance(row, dict) for row in rows):
            raise ValueError("Invalid bounded locations")
        for row in rows:
            key = "path" if operation == "common_folders" else "mountpoint"
            if not isinstance(row.get(key), str) or not 0 < len(row[key]) <= 4096:
                raise ValueError("Invalid location path")
            if operation == "common_folders" and (type(row.get("size_bytes")) is not int or row["size_bytes"] < 0 or type(row.get("size_partial")) is not bool):
                raise ValueError("Invalid common-folder coverage")
    return result


def _work(job):
    global _active
    stopped = False
    try:
        if job["cancel"].is_set() or not job["access"].valid():
            frame = {"type": "cancelled", "worker_stopped": True}
        else:
            with _lock:
                job.update(status="running", updated_at=now_iso())
            def progress(value):
                with _lock:
                    job["progress"].update(value)
                    job["updated_at"] = now_iso()
                    if value.get("phase") == "stopping": job["status"] = "cancelling"
            frame = process.run(job["request"], job["cancel"], progress, job["access"].valid)
        stopped = frame.get("worker_stopped") is True
        if not stopped:
            raise RuntimeError("Worker termination remains unconfirmed")
        valid = job["access"].valid()
        with _lock:
            if not valid or frame["type"] == "cancelled":
                job["status"] = "cancelled"
            elif frame["type"] == "result":
                result = _validate_result(job["operation"], frame)
                if job["cancel"].is_set():
                    result.setdefault("meta", {}).update(partial=True, cancelled=True)
                if job["operation"] == "scan":
                    from intelligence import storage_history
                    identity = frame["identity"]
                    result["meta"]["saved_scan"] = storage_history.capture(job["access"].owner, Path(result["meta"]["root"]), result["tree"], result["meta"], identity["before"], after=identity["after"])
                # Revocation during final validation/capture never publishes a result.
                if not job["access"].valid():
                    job["status"] = "cancelled"
                else:
                    byte_count = len(canonical(result))
                    if byte_count > MAX_RESULT:
                        raise ValueError("Final scan result exceeds the byte limit")
                    if not job.get("transient"):
                        _evict(byte_count)
                    job["bytes"] = byte_count
                    job.update(result=result, result_available=True,
                               status="cancelled" if job["cancel"].is_set() or result.get("meta", {}).get("cancelled") else "partial" if result.get("meta", {}).get("partial") else "completed")
                    job["path"] = result.get("meta", {}).get("root", job["path"])
            else:
                job.update(status="failed", error=frame.get("error") or {"code": "worker_failed", "message": "The scan did not complete."})
    except Exception:
        with _lock:
            job.update(status="failed" if stopped else "cancelling", error={"code": "scan_failed" if stopped else "stop_unconfirmed",
                       "message": "The scan result could not be confirmed. No files were changed." if stopped else "The worker stop is not confirmed. New scans remain blocked; check the host."})
    finally:
        with _lock:
            job.update(updated_at=now_iso(), worker_stopped=stopped)
            if stopped:
                job["finished_at"] = now_iso()
                job["expiry"] = time.time() + TTL
                job["expires_at"] = datetime.fromtimestamp(job["expiry"], timezone.utc).isoformat().replace("+00:00", "Z")
                if _active == job["id"]: _active = None
            job["done"].set()
        if not job.get("internal"):
            from event_bus import emit_event
            emit_event("system", "info" if job["status"] == "completed" else "warn", "Storage review " + job["status"],
                       "An explicitly requested storage reader finished or stopped. No files were changed.")


def start(credential, values, *, internal=False):
    global _active
    if not credential.valid(): raise HTTPException(401, "Unlock before starting a scan.")
    request = dict(values)
    request_id = request.pop("request_id")
    request.setdefault("limits", PROFILES[request["profile"]].copy())
    if len(canonical(request)) + 1 > 16 * 1024:
        raise HTTPException(413, "The scan request is too large.")
    from storage_scan_worker import validate_request
    try: request = validate_request(request)
    except (ValueError, TypeError): raise HTTPException(422, "Unsupported scan request.") from None
    digest = hashlib.sha256(canonical(request)).hexdigest()
    from intelligence.data_health import _host
    host = _host()
    key = credential.key, request_id
    with _lock:
        _prune()
        old = _requests.get(key)
        if old:
            if old["digest"] != digest: raise HTTPException(409, {"code": "request_id_conflict", "message": "This request ID belongs to different scan options."})
            if old["id"] not in _jobs: raise HTTPException(410, "That scan expired or left the bounded cache. Start a new request deliberately.")
            return {"ok": True, "protocol": PROTOCOL, "job": _public(_get(credential, old["id"]))}
        if _active is not None:
            raise HTTPException(409, {"code": "scan_busy", "message": "A storage reader is already active on this host. Wait or cancel your existing scan."})
        if len(_requests) >= MAX_REQUEST_IDS: raise HTTPException(429, "Too many recent scan requests. Wait before starting another.")
        transient = internal and request["operation"] in TRANSIENT
        if not transient:
            _evict(reserve=1)
        ident, created = secrets.token_hex(16), time.time()
        job = {"id": ident, "host": copy.deepcopy(host), "access": credential, "internal": internal, "transient": transient, "request": request, "operation": request["operation"], "profile": request["profile"],
               "include_excluded": request.get("include_excluded", False),
               "path": request.get("path"), "status": "queued", "started_at": now_iso(), "updated_at": now_iso(), "finished_at": None,
               "expires_at": None, "expiry": created + TTL, "created": created, "progress": {"phase": "queued"},
               "limits": {**request["limits"], "memory_bytes": MAX_MEMORY, "max_tree_nodes": 25_000, "max_result_bytes": MAX_RESULT},
               "result_available": False, "result": None, "bytes": 0, "error": None, "worker_stopped": False,
               "cancel": threading.Event(), "done": threading.Event()}
        _jobs[ident], _active = job, ident
        _requests[key] = {"id": ident, "digest": digest, "expiry": created + TTL}
        try:
            thread = threading.Thread(target=_work, args=(job,), name="storage-job-supervisor", daemon=True)
            thread.start()
        except BaseException:
            del _jobs[ident]; del _requests[key]; _active = None
            raise HTTPException(503, "The scan supervisor could not start.") from None
        return {"ok": True, "protocol": PROTOCOL, "job": _public(job)}


def status(credential, ident):
    with _lock: return {"ok": True, "protocol": PROTOCOL, "job": _public(_get(credential, ident))}


def results(credential, ident):
    with _lock:
        job = _get(credential, ident)
        if not job["result_available"]:
            raise HTTPException(409, {"code": "result_unavailable", "message": "This scan has no available result.", "status": job["status"]})
        return {"ok": True, "protocol": PROTOCOL, "job": _public(job), "result": copy.deepcopy(job["result"])}


def cancel(credential, ident):
    with _lock:
        job = _get(credential, ident)
        if job["status"] not in TERMINAL:
            job["cancel"].set()
            job.update(status="cancelling", updated_at=now_iso())
        return {"ok": True, "protocol": PROTOCOL, "job": _public(job)}


def sync(credential, operation, path=None, **options):
    request = {"operation": operation, "path": path, "profile": "quick", "include_excluded": False,
               "request_id": secrets.token_hex(16), **options}
    envelope = start(credential, request, internal=True)
    ident = envelope["job"]["id"]
    try:
        with _lock: done = _jobs[ident]["done"]
        if not done.wait(request.get("limits", PROFILES["quick"])["max_seconds"] + 12):
            cancel(credential, ident)
            raise HTTPException(503, "The reader is still stopping. New scans remain blocked until its exit is confirmed.")
        current = status(credential, ident)["job"]
        if not current["result_available"]:
            error = current["error"] or {}
            raise HTTPException(error.get("status_code", 503), error.get("message", "The scan was cancelled."))
        return results(credential, ident)["result"]
    finally:
        if operation in TRANSIENT:
            with _lock:
                # Transient capacity/path probes share admission but never evict
                # a recorded scan or consume one of its four retained slots.
                job = _jobs.get(ident)
                if ident != _active and (not job or job["worker_stopped"]):
                    _jobs.pop(ident, None)
                    _requests.pop((credential.key, request["request_id"]), None)


def shutdown():
    with _lock:
        active = _jobs.get(_active)
        if active: active["cancel"].set()
    if active: active["done"].wait(5)


def _revoke(matches):
    """Eager privacy cleanup; the supervisor independently rechecks credentials."""
    with _lock:
        keys = set()
        for ident, job in list(_jobs.items()):
            if not matches(job["access"]): continue
            keys.add(job["access"].key)
            if ident == _active:
                job["cancel"].set()
                job.update(status="cancelling", updated_at=now_iso(), result=None, result_available=False, bytes=0)
            else:
                del _jobs[ident]
        for key in list(_requests):
            if key[0] in keys: del _requests[key]


def revoke_browser_session(token):
    _revoke(lambda credential: credential.kind == "browser" and credential.credential == token)


def revoke_all_sessions():
    _revoke(lambda credential: True)
