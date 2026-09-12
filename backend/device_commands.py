"""In-process protection for explicit commands from the home control panels."""
import copy
import threading
import time
from fastapi import HTTPException
from action_results import driver_succeeded

_lock = threading.RLock()
_running = set()
_requests = {}
RETENTION_SECONDS = 300


def target_key(ip, relay):
    return (str(ip).strip().lower().removeprefix("http://").removeprefix("https://").rstrip("/"), int(relay))


def run(user, target, action, request_id, operation):
    token = (user, request_id) if request_id else None
    fingerprint = (target, action)
    with _lock:
        now = time.monotonic()
        for key, value in list(_requests.items()):
            if value["result"] is not None and now - value["at"] > RETENTION_SECONDS:
                del _requests[key]
        if token in _requests:
            old = _requests[token]
            if old["fingerprint"] != fingerprint:
                raise HTTPException(409, "This request ID belongs to a different device command.")
            if old["result"] is None:
                raise HTTPException(409, "This command is still running. No second command was sent.")
            return copy.deepcopy(old["result"])
        if target in _running:
            raise HTTPException(409, "Another command for this target is running. No second command was sent.")
        if token and len(_requests) >= 512:
            raise HTTPException(429, "Recent device command storage is full. Try again later.")
        _running.add(target)
        if token:
            _requests[token] = {"fingerprint": fingerprint, "at": now, "result": None}
    try:
        try:
            output = operation()
            ok = driver_succeeded(output)
            result = dict(output) if isinstance(output, dict) else {}
            result.update(ok=ok, request_id=request_id,
                          outcome="accepted" if ok else "failed",
                          summary="Device acknowledged the command. Current state requires a status reading." if ok else
                          "The device did not confirm the command. " + str(result.get("summary") or ""))
        except Exception:
            result = {"ok": False, "request_id": request_id, "outcome": "unknown",
                      "summary": "Command outcome is unconfirmed. Check device status before trying again; nothing will retry automatically."}
        with _lock:
            if token:
                _requests[token].update(result=copy.deepcopy(result), at=time.monotonic())
        return result
    finally:
        with _lock:
            _running.discard(target)
