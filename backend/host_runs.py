"""Bounded owner-scoped execution; client disconnect is not a second submission.

Only request hashes, state and saved-resource pointers are persisted here. Prompts,
attachments, credentials and token buffers remain in memory; completed content uses
the existing owned conversation/Builder stores. A process restart never replays work.
"""
from __future__ import annotations

import asyncio
from collections import deque
from contextlib import suppress
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import uuid

from fastapi import HTTPException, Request
from starlette.responses import StreamingResponse
import tli_state as S
from companion_auth import operation_access
import run_context
from workspace_events import publish

PROTOCOL = "tli-runs-v1"
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
MAX_ACTIVE = 4
MAX_RECORDS = 5000
MAX_OUTPUT = 2 * 1024 * 1024
MAX_SECONDS = 600
_lock = threading.RLock()
_runs = {}
_loaded_path = None
_records = {}
_stopping = False


def _path():
    return Path(S.DATA_DIR) / "workspace" / "runs.json"


def _write():
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".runs-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "runs": _records}, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        with suppress(FileNotFoundError):
            os.unlink(temporary)


def _load():
    global _loaded_path, _records, _runs, _stopping
    path = _path().resolve()
    if _loaded_path == path:
        return
    try:
        value = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"version": 1, "runs": {}}
        if value.get("version") != 1 or not isinstance(value.get("runs"), dict):
            raise ValueError("Invalid run store")
        for ident, entry in value["runs"].items():
            if not isinstance(entry, dict) or entry.get("id") != ident or not all(isinstance(entry.get(k), str) for k in ("owner", "request_id", "digest", "kind", "status")):
                raise ValueError("Invalid run record")
    except (ValueError, OSError, TypeError) as exc:
        raise HTTPException(503, "The workspace run journal cannot be read. Restore it before starting work.") from exc
    _loaded_path, _records, _runs, _stopping = path, value["runs"], {}, False
    changed = False
    for entry in _records.values():
        if entry["status"] not in TERMINAL:
            entry.update(status="interrupted", error="The host restarted before completion was recorded. Review saved work before retrying.")
            changed = True
    if changed:
        _write()


class Run:
    def __init__(self, entry, request):
        self.entry = entry
        self.ident = entry["id"]
        self.owner = entry["owner"]
        self.authorize = operation_access(request, self.owner)
        self.stop = threading.Event()
        self.started = time.monotonic()
        self.events = deque(maxlen=512)
        self.cursor = 0
        self.text = ""
        self.metadata = {}
        self.result = None
        self.thread = None

    def bind_app(self, ident):
        """Retain the recovery project even if generation is later cancelled."""
        with _lock:
            self.entry["app_id"] = ident
            _write()

    def check(self):
        self.authorize()
        if self.stop.is_set() or _stopping:
            raise HTTPException(409, "Stop requested. Already completed actions are not undone; check their recorded result.")
        if time.monotonic() - self.started > MAX_SECONDS:
            raise HTTPException(408, "This run reached its time limit. It was not retried.")

    def emit(self, event):
        if not isinstance(event, dict) or event.get("type") not in {"meta", "delta", "done", "error"}:
            return
        with _lock:
            if event["type"] == "delta":
                delta = event.get("text", "")
                if not isinstance(delta, str) or len((self.text + delta).encode("utf-8")) > MAX_OUTPUT:
                    raise HTTPException(413, "The answer exceeded the replay buffer. Review saved conversation history.")
                self.text += delta
            elif event["type"] == "meta":
                self.metadata.update({key: value for key, value in event.items() if key != "type"})
            self.cursor += 1
            self.events.append({"id": self.cursor, "event": event})


def _owned(ident, owner):
    _load()
    entry = _records.get(ident)
    if entry is None:
        entry = next((item for item in _records.values() if item["owner"] == owner and item["request_id"] == ident), None)
    if not entry or entry["owner"] != owner:
        raise HTTPException(404, "Run not found.")
    return entry


def _saved_result(entry):
    if entry["status"] != "completed":
        return None
    if entry["kind"] == "chat":
        from workspace_settings import owned
        conv = owned(S.load_conversations(), entry["conversation_id"], entry["owner"])
        from ai.ai_routes import _public_conversation_turn
        from intelligence.chat_memory import source_ref
        turns = conv.get("messages", [])
        match = next(((index, message) for index, message in reversed(list(enumerate(turns)))
                      if message.get("run_id") == entry["id"] and message.get("role") == "assistant"), None)
        if match is None:
            return None
        index, reply = match
        public = _public_conversation_turn(reply, conv["id"], index)
        result = {"conversation_id": conv["id"], "reply": public.pop("content"), **{key: value for key, value in public.items() if key != "role"}}
        if index and turns[index - 1].get("run_id") == entry["id"] and turns[index - 1].get("role") == "user":
            result["user_source_ref"] = source_ref(conv["id"], index - 1, turns[index - 1])
        return result
    if entry.get("app_id"):
        from builder.web_apps import get_app
        project = get_app(entry["app_id"], owner=entry["owner"])
        project["revisions"] = project["revisions"][:entry.get("result_revision", 0)]
        if project["revisions"]:
            project.update(name=project["revisions"][-1]["name"], status="ready_for_preview")
        return {"project": project}
    return None


def get(ident, owner, after=0):
    with _lock:
        entry = dict(_owned(ident, owner))
        run = _runs.get(entry["id"])
        result = run.result if run else None
        value = {key: entry.get(key) for key in ("id", "request_id", "kind", "status", "conversation_id", "app_id", "created_at", "updated_at", "error")}
        value.update(protocol=PROTOCOL, cursor=run.cursor if run else entry.get("cursor", 0),
                     events=[dict(item) for item in run.events if item["id"] > after] if run else [],
                     text=run.text if run else "", metadata=dict(run.metadata) if run else {}, result=result,
                     replay_reset=bool(run and run.events and after < run.events[0]["id"] - 1))
    if entry["status"] in TERMINAL:
        try:
            # Replay buffers must not outlive access to the saved resource.
            # Keep the admission identity, but withhold all cached content after
            # deletion or an ownership change, including SSE delta events.
            if entry["kind"] == "chat":
                from workspace_settings import owned
                owned(S.load_conversations(), entry.get("conversation_id"), owner)
            elif entry.get("app_id"):
                from builder.web_apps import get_app
                get_app(entry["app_id"], owner=owner)
        except (HTTPException, ValueError, OSError):
            value.update(result=None, text="", metadata={}, events=[],
                         result_unavailable=True, replay_reset=False)
            return value
    if result is None and entry["status"] == "completed":
        try:
            value["result"] = _saved_result(entry)
            if entry["kind"] == "chat" and value["result"]:
                value["text"] = value["result"]["reply"]
                value["metadata"] = {key: item for key, item in value["result"].items() if key != "reply"}
        except (HTTPException, ValueError, OSError):
            value["result_unavailable"] = True
    return value


def listing(owner, conversation_id=None):
    with _lock:
        _load()
        values = [entry for entry in _records.values() if entry["owner"] == owner and (conversation_id is None or entry.get("conversation_id") == conversation_id)]
        # A list is a directory, not fifty duplicate answer/attachment buffers.
        fields = ("id", "request_id", "kind", "status", "conversation_id", "app_id", "created_at", "updated_at", "error")
        entries = [{key: entry.get(key) for key in fields} for entry in sorted(values, key=lambda item: item["created_at"], reverse=True)[:50]]
    return {"protocol": PROTOCOL, "runs": entries}


def _finish(run, status, error=None):
    with _lock:
        run.entry.update(status=status, updated_at=S.now_iso(), cursor=run.cursor)
        if error:
            run.entry["error"] = str(error)[:700]
        if run.result and run.entry["kind"] != "chat":
            project = run.result.get("project", {})
            run.entry.update(app_id=project.get("id"), result_revision=len(project.get("revisions", [])))
        _write()
        finished = [value for value in _runs.values() if value.entry["status"] in TERMINAL and value is not run]
        for old in sorted(finished, key=lambda value: value.entry["created_at"])[:-15]:
            _runs.pop(old.ident, None)
    publish(run.owner, "run", run.ident)
    publish(run.owner, "conversation" if run.entry["kind"] == "chat" else "builder", run.entry.get("conversation_id") or run.entry.get("app_id") or "")


async def _consume(run, response):
    buffer = ""
    complete = False
    try:
        async for chunk in response.body_iterator:
            run.check()
            buffer += chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
            if len(buffer) > MAX_OUTPUT:
                raise HTTPException(413, "The stream frame is too large.")
            buffer = buffer.replace("\r\n", "\n")
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                lines = [line[5:].lstrip() for line in frame.splitlines() if line.startswith("data:")]
                if not lines:
                    continue
                event = json.loads("\n".join(lines))
                run.emit(event)
                if event.get("type") == "error":
                    raise HTTPException(502, event.get("detail") or event.get("error") or "The answer could not finish.")
                complete |= event.get("type") == "done"
        if not complete:
            raise HTTPException(502, "The answer ended without a completion event. It was not retried.")
    finally:
        close = getattr(response.body_iterator, "aclose", None)
        if close:
            await close()
        if response.background:
            await response.background()


def _execute(run, request, payload, chat_path):
    token = run_context.current.set(run)
    try:
        run.check()
        with _lock:
            run.entry.update(status="running", updated_at=S.now_iso())
            _write()
        if run.entry["kind"] == "chat":
            if chat_path == "/chat" and payload.get("lan_inference") is None:
                from routers.chat_routes import chat_endpoint, ChatRequest
                response = chat_endpoint(req=ChatRequest.model_validate(payload), request=request, session_user=run.owner)
                result = response.model_dump()
                run.metadata.update({k: v for k, v in result.items() if k != "reply"})
                run.metadata.update(provider=result.get("brain_used"), model=result.get("model_used"))
                # The historical JSON response omits the executing host, but
                # its persisted turn records it. Use that actual receipt.
                from workspace_settings import owned
                conversation = owned(S.load_conversations(), run.entry["conversation_id"], run.owner)
                reply = next((m for m in reversed(conversation.get("messages", [])) if m.get("run_id") == run.ident and m.get("role") == "assistant"), {})
                for field in ("host", "inference_host"):
                    if reply.get(field):
                        run.metadata[field] = reply[field]
                run.emit({"type": "meta", **run.metadata})
                run.emit({"type": "delta", "text": result["reply"]})
                run.emit({"type": "done"})
            else:
                from ai.ai_routes import ai_chat_stream_post, ChatRequest
                response = ai_chat_stream_post(request=request, req=ChatRequest.model_validate(payload))
                asyncio.run(_consume(run, response))
            run.result = {"conversation_id": run.entry["conversation_id"], "reply": run.text, **run.metadata}
        else:
            from routers.builder import _generate_web_app, BuildWebAppRequest, RepairWebAppRequest
            if run.entry["kind"] == "builder_create":
                req = BuildWebAppRequest.model_validate(payload)
                run.result = _generate_web_app(brief=req.brief, owner=run.owner, request=request, lan_inference=req.lan_inference)
            else:
                req = RepairWebAppRequest.model_validate(payload)
                run.result = _generate_web_app(app_id=run.entry["app_id"], feedback=req.feedback, expected_revision=req.expected_revision, owner=run.owner, request=request, lan_inference=req.lan_inference)
            if run.result["project"].get("status") != "ready_for_preview":
                raise HTTPException(422, run.result["project"].get("last_error") or "Builder did not produce a completed revision.")
            run.emit({"type": "done"})
        _finish(run, "completed")
    except Exception as exc:
        status = "cancelled" if run.stop.is_set() else "interrupted" if _stopping else "failed"
        error = exc.detail if isinstance(exc, HTTPException) else "The run could not finish. Review saved work before retrying."
        run.emit({"type": "error", "detail": str(error)[:700]})
        with suppress(OSError):
            _finish(run, status, error)
    finally:
        if run.entry.get("conversation_id"):
            from conversation_guard import release_run
            release_run(run.entry["conversation_id"], run.ident)
        run_context.current.reset(token)
        # Release request bodies and credentials even while keeping replay state.
        run.authorize = lambda: None


def submit(owner, request, *, request_id, kind, payload, app_id=None, chat_path=None):
    payload = dict(payload)
    try:
        raw = json.dumps({"kind": kind, "payload": payload, "app_id": app_id, "chat_path": chat_path}, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, "The run payload must contain finite JSON values.") from exc
    if len(raw.encode("utf-8")) > 16 * 1024 * 1024:
        raise HTTPException(413, "This request is too large.")
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    operation_access(request, owner)()
    with _lock:
        _load()
        previous = next((entry for entry in _records.values() if entry["owner"] == owner and entry["request_id"] == request_id), None)
        if previous:
            if previous["digest"] != digest:
                raise HTTPException(409, "This request ID already belongs to different work. The previous work was not repeated.")
            return get(previous["id"], owner), False
        if _stopping or sum(entry["status"] not in TERMINAL for entry in _records.values()) >= MAX_ACTIVE:
            raise HTTPException(429, "The host is busy. Wait for current work to finish before submitting.")
        if len(_records) >= MAX_RECORDS:
            raise HTTPException(507, "The workspace run journal is full. Existing work is retained; no work was submitted.")
        ident = "run_" + uuid.uuid4().hex
        conversation_id = None
        # Capture and validate authority before reserving a conversation lease.
        now = S.now_iso()
        entry = {"id": ident, "owner": owner, "request_id": request_id, "digest": digest, "kind": kind,
                 "status": "accepted", "conversation_id": None, "app_id": app_id, "created_at": now, "updated_at": now, "cursor": 0}
        run = Run(entry, request)
        if kind == "chat":
            from ai.ai_routes import ChatRequest
            from workspace_settings import owned, prepare
            conversation_id = payload.get("conversation_id") or payload.get("session_id") or "conv-" + uuid.uuid4().hex
            if not isinstance(conversation_id, str) or not 1 <= len(conversation_id) <= 128:
                raise HTTPException(422, "Invalid conversation ID.")
            ChatRequest.model_validate(payload)
            from conversation_guard import assert_idle, reserve_run
            with S.CONVERSATIONS_LOCK:
                conversations = S.load_conversations()
                if conversation_id in conversations:
                    owned(conversations, conversation_id, owner)
                if any(entry.get("conversation_id") == conversation_id and entry["status"] not in TERMINAL for entry in _records.values()):
                    raise HTTPException(409, "This conversation already has a response in progress.")
                assert_idle([conversation_id])
                prepare(conversation_id, owner, payload)
                reserve_run(conversation_id, ident)
            payload["conversation_id"] = conversation_id
        elif kind == "builder_create":
            from routers.builder import BuildWebAppRequest
            BuildWebAppRequest.model_validate(payload)
        elif kind == "builder_revise":
            from routers.builder import RepairWebAppRequest
            from builder.web_apps import get_app
            RepairWebAppRequest.model_validate(payload)
            try:
                get_app(app_id, owner=owner)
            except ValueError as exc:
                raise HTTPException(404, "App not found.") from exc
        else:
            raise HTTPException(422, "Unsupported run kind.")
        entry["conversation_id"] = conversation_id
        _records[ident] = entry
        try:
            _write()  # Durable identity precedes every effect.
        except OSError:
            del _records[ident]
            if conversation_id:
                from conversation_guard import release_run
                release_run(conversation_id, ident)
            raise HTTPException(503, "The run could not be recorded. No execution started.") from None
        _runs[ident] = run
        # A detached scope carries only the original authentication context. No
        # loopback request and no browser receive channel is used by the worker.
        scope = dict(request.scope)
        scope["state"] = dict(scope.get("state", {}))
        scope["state"]["tli_run_check"] = run.check
        detached = Request(scope)
        run.thread = threading.Thread(target=_execute, args=(run, detached, payload, chat_path), name="tli-run", daemon=True)
        try:
            run.thread.start()
        except RuntimeError:
            # Keep the durable request identity: a duplicate must return this
            # failed admission instead of starting work later without review.
            try:
                _finish(run, "failed", "The host could not start this run. No execution started.")
            finally:
                run.authorize = lambda: None
                if conversation_id:
                    from conversation_guard import release_run
                    release_run(conversation_id, ident)
    publish(owner, "run", ident)
    return get(ident, owner), True


def cancel(ident, owner):
    with _lock:
        entry = _owned(ident, owner)
        if entry["status"] not in TERMINAL:
            run = _runs.get(entry["id"])
            if run:
                run.stop.set()
    return get(ident, owner)


def shutdown():
    global _stopping
    with _lock:
        _stopping = True
        for run in _runs.values():
            if run.entry["status"] not in TERMINAL:
                run.stop.set()
