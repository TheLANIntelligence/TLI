"""Shared workspace settings, invalidations and recoverable host runs."""
import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.responses import StreamingResponse
from routers.system_routes import require_session
from companion_auth import operation_access
from private_client_authority import private_client_access, checked_call, checked_json
from ai.lan_chat import Selection
import host_runs
import workspace_events
import workspace_settings

router = APIRouter(tags=["Shared workspace"])


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    kind: Literal["chat", "builder_create", "builder_revise", "agent_task"]
    payload: dict
    app_id: str | None = Field(default=None, max_length=128)
    chat_path: Literal["/chat", "/api/ai/chat/stream"] | None = None


class ConversationSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    compute_selection: Selection | None
    expected_settings_revision: int = Field(ge=0, strict=True)


@router.post("/api/runs")
def submit(req: RunRequest, request: Request, response: Response, owner: str = Depends(require_session)):
    try:
        value, created = host_runs.submit(owner, request, **req.model_dump())
    except ValidationError as exc:
        raise HTTPException(422, "The run payload is invalid.") from exc
    response.status_code = 202 if created else 200
    response.headers["Cache-Control"] = "no-store"
    return value


@router.get("/api/runs")
def list_runs(request: Request, response: Response, conversation_id: str | None = Query(default=None, max_length=128), owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    value = host_runs.listing(owner, conversation_id)
    try:
        from browser_authority import browser_control_access
        browser_control_access(request, response)()
    except HTTPException:
        value["runs"] = [entry for entry in value["runs"] if entry["kind"] != "agent_task"]
    return value


@router.get("/api/runs/{ident}")
def get_run(ident: str, request: Request, response: Response, after: int = Query(default=0, ge=0), owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    value = host_runs.get(ident, owner, after)
    if value["kind"] == "agent_task":
        from browser_authority import browser_control_access
        browser_control_access(request, response)()
    return value


@router.post("/api/runs/{ident}/cancel")
def cancel_run(ident: str, request: Request, response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    if host_runs.get(ident, owner)["kind"] == "agent_task":
        from browser_authority import browser_control_access
        browser_control_access(request, response)()
    return host_runs.cancel(ident, owner)


@router.get("/api/runs/{ident}/events")
def stream_run(ident: str, request: Request, after: int = Query(default=0, ge=0), owner: str = Depends(require_session)):
    value = host_runs.get(ident, owner, after)
    check = operation_access(request, owner)
    if value["kind"] == "agent_task":
        from browser_authority import browser_control_access
        check = browser_control_access(request, Response())
    async def events():
        cursor = after
        while True:
            check()
            value = host_runs.get(ident, owner, cursor)
            if value["replay_reset"]:
                check()
                yield f"event: snapshot\ndata: {json.dumps(value)}\n\n"
                cursor = value["cursor"]
            else:
                for item in value["events"]:
                    cursor = item["id"]
                    check()
                    yield f"id: {cursor}\ndata: {json.dumps(item['event'])}\n\n"
            if value["status"] in host_runs.TERMINAL:
                if not value["events"]:
                    check()
                    yield f"event: snapshot\ndata: {json.dumps(value)}\n\n"
                return
            if await request.is_disconnected():
                return
            yield ": keepalive\n\n"
            await asyncio.sleep(1)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/api/ai/conversations/{ident}/settings")
def get_settings(ident: str, request: Request, response: Response):
    owner, check = private_client_access(request, response)
    return checked_json(check, checked_call(check, lambda: workspace_settings.get(ident, owner, check=check)))


@router.patch("/api/ai/conversations/{ident}/settings")
def update_settings(ident: str, req: ConversationSettings, response: Response, owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return workspace_settings.update(ident, owner, req.compute_selection.model_dump() if req.compute_selection else None, req.expected_settings_revision)


@router.get("/api/workspace/events")
def workspace_changes(response: Response, after: int = Query(default=0, ge=0), epoch: str = Query(default="", max_length=64), owner: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return workspace_events.snapshot(owner, after, epoch)
