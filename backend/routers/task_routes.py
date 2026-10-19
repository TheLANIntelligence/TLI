"""Browser-authorized task grants, receipts, review and deliberate continuation."""
import os
from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field
from task_models import Strict
from browser_authority import browser_control_access
from routers.system_routes import require_session
import task_agent
import task_workspace
import host_runs

router = APIRouter(prefix="/api/tasks", tags=["Task agent"])


class Area(Strict):
    name: str = Field(min_length=1, max_length=100)
    read_roots: list[str] = Field(min_length=1, max_length=16)
    write_roots: list[str] = Field(default_factory=list, max_length=16)
    area_id: str | None = None
    expected_revision: int | None = None


class Review(Strict):
    review_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=1)


class Continue(Strict):
    request_id: str = Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    expected_revision: int = Field(ge=1)
    follow_up: str = Field(default="", max_length=8000)


class Undo(Strict):
    operation_id: str = Field(min_length=1, max_length=128)


@router.get("/capabilities")
def capabilities(request: Request, response: Response, owner: str = Depends(require_session)):
    browser_control_access(request, response)()
    return {"protocol": "tli-task-agent-v1", "openai_configured": bool(os.environ.get("TLI_OPENAI_API_KEY", "").strip()),
            "local_search_configured": bool(os.environ.get("TLI_TASK_SEARXNG_URL", "").strip()),
            "host_execution": "Commands run with the host account's access; approved folders are not a process sandbox."}


@router.get("/areas")
def areas(request: Request, response: Response, owner: str = Depends(require_session)):
    browser_control_access(request, response)()
    return {"areas": task_workspace.list_areas(owner)}


@router.post("/areas")
def save_area(req: Area, request: Request, response: Response, owner: str = Depends(require_session)):
    browser_control_access(request, response)()
    return task_workspace.save_area(owner, **req.model_dump())


@router.delete("/areas/{ident}")
def revoke(ident: str, request: Request, response: Response, owner: str = Depends(require_session)):
    browser_control_access(request, response)()
    return task_workspace.revoke_area(owner, ident)


@router.get("/game-locations")
def games(request: Request, response: Response, owner: str = Depends(require_session)):
    check = browser_control_access(request, response)
    from routers import games as game_routes
    locations = []
    for store, getter in (("Steam", game_routes._steam_library_roots), ("GOG", game_routes._gog_common_roots),
                          ("Epic", game_routes._epic_common_roots), ("Xbox", game_routes._xbox_common_roots),
                          ("Battle.net", game_routes._bnet_common_roots)):
        check()
        locations.extend({"store": store, "path": str(path)} for path in getter() if path.is_dir())
    check()
    return {"locations": locations[:32], "hint": "Locations are suggestions, not grants. Choose the specific game/mod and log folders."}


@router.get("")
def tasks(request: Request, response: Response, owner: str = Depends(require_session)):
    browser_control_access(request, response)()
    return {"tasks": task_agent.listing(owner)}


@router.get("/{ident}")
def get(ident: str, request: Request, response: Response, owner: str = Depends(require_session)):
    browser_control_access(request, response)()
    return task_agent.get(owner, ident)


@router.post("/{ident}/approve")
def approve(ident: str, req: Review, request: Request, response: Response, owner: str = Depends(require_session)):
    check = browser_control_access(request, response)
    return task_agent.approve(owner, ident, req.review_id, req.expected_revision, check)


@router.post("/{ident}/undo")
def undo(ident: str, req: Undo, request: Request, response: Response, owner: str = Depends(require_session)):
    check = browser_control_access(request, response)
    return task_agent.undo(owner, ident, req.operation_id, check)


@router.post("/{ident}/resume")
def resume(ident: str, req: Continue, request: Request, response: Response, owner: str = Depends(require_session)):
    browser_control_access(request, response)()
    task = task_agent.get(owner, ident)
    payload = {key: task[key] for key in ("message", "conversation_id", "area_id", "area_revision", "provider",
                                          "share_context", "allow_web", "use_saved_memory", "use_conversation_history")}
    payload.update(resume_task_id=ident, expected_revision=req.expected_revision, follow_up=req.follow_up)
    value, created = host_runs.submit(owner, request, request_id=req.request_id, kind="agent_task", payload=payload)
    response.status_code = 202 if created else 200
    return value
