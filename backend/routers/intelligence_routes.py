"""Existing-console device context, diagnostics, memory and image controls."""
import base64
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Response, Query, Request
from pydantic import BaseModel, Field, ConfigDict
from routers.system_routes import require_session
from intelligence import devices, diagnostics, memory, models, vision, screenshots, report_facts, case_next_check

router = APIRouter(prefix="/api/intelligence", tags=["intelligence"], dependencies=[Depends(require_session)])


@router.get("/data-health")
def data_health(response: Response, user: str = Depends(require_session)):
    from intelligence.data_health import inspect
    response.headers["Cache-Control"] = "no-store"
    return inspect(user)


class DevicePatch(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    room: str | None = Field(default=None, max_length=120)
    expected_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class DeviceRelationship(BaseModel):
    target_id: str = Field(min_length=1, max_length=256)
    relationship: Literal["depends_on", "powered_by", "connected_to"]
    note: str = Field(default="", max_length=240)


class DeviceRelationships(BaseModel):
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    importance: Literal["normal", "important", "critical"]
    relationships: list[DeviceRelationship] = Field(max_length=8)


class CheckRequest(BaseModel):
    kind: Literal["network", "system", "device", "peer_system"]
    target_id: str | None = None
    internet: bool = False
    expected_host_id: str | None = Field(default=None, min_length=1, max_length=256)
    request_id: str | None = Field(default=None, min_length=1, max_length=128)
    expected_scope: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    repeat_of: str | None = Field(default=None, min_length=1, max_length=256)
    expected_report_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    next_check_ref: case_next_check.RunRef | None = None


class Fact(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    title: str | None = Field(default=None, max_length=120)
    category: str = Field(default="general", min_length=1, max_length=64)
    device_id: str | None = Field(default=None, max_length=256)
    expected_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ModelProfile(BaseModel):
    model_id: str = Field(min_length=1, max_length=256)
    vision: bool


class NoteLink(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=256)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    relation: Literal["related", "correction_reference", "different_experience"]


class NoteLinks(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    links: list[NoteLink] = Field(max_length=8)


@router.get("/devices")
def list_devices():
    return devices.inventory()


@router.post("/printers/refresh")
def refresh_printers():
    devices.refresh_printers()
    return devices.inventory()


@router.patch("/devices/{ident}")
def edit_device(ident: str, req: DevicePatch):
    if not req.name.strip() or any(not a.strip() or len(a) > 120 for a in req.aliases):
        raise HTTPException(422, "Names and aliases must contain 1–120 characters.")
    return devices.update(ident, {"name": req.name.strip(), "aliases": list(dict.fromkeys(a.strip() for a in req.aliases)), "room": req.room}, req.expected_revision)


@router.get("/devices/{ident}/details")
def device_details(ident: str, response: Response, user: str = Depends(require_session)):
    from intelligence.device_details import details
    response.headers["Cache-Control"] = "no-store"
    return details(user, ident)


@router.get("/rooms")
def device_rooms(response: Response):
    from intelligence.device_details import rooms
    response.headers["Cache-Control"] = "no-store"
    return rooms()


@router.patch("/devices/{ident}/relationships")
def device_relationships(ident: str, req: DeviceRelationships, response: Response, user: str = Depends(require_session)):
    from intelligence.device_details import save_relationships
    response.headers["Cache-Control"] = "no-store"
    return save_relationships(user, ident, req.expected_revision, req.importance, [r.model_dump() for r in req.relationships])


@router.post("/diagnostics")
def check(req: CheckRequest, request: Request, user: str = Depends(require_session)):
    authorize = None
    request_context = None
    if req.next_check_ref is not None:
        if not all((req.expected_host_id, req.request_id, req.expected_scope)) or req.repeat_of or req.expected_report_revision:
            raise HTTPException(422, "A suggested check needs its reviewed source, host, scope and request identifier; report-repeat mode is separate.")
        from companion_auth import operation_access
        authorize = case_next_check.execution_guard(user, req.next_check_ref, kind=req.kind, target_id=req.target_id,
                        internet=req.internet, expected_host_id=req.expected_host_id, expected_scope=req.expected_scope,
                        authorize=operation_access(request, user))
        request_context = req.next_check_ref.selection_sha256
    if req.kind == "peer_system":
        if not all((req.expected_host_id, req.request_id, req.expected_scope, req.target_id)):
            raise HTTPException(422, "Peer observations require an explicitly reviewed computer, identity, scope and request identifier.")
        from companion_auth import operation_access
        if authorize is None:
            authorize = operation_access(request, user)
    if req.repeat_of is not None or req.expected_report_revision is not None:
        if not all((req.repeat_of, req.expected_report_revision, req.expected_host_id, req.request_id, req.expected_scope)):
            raise HTTPException(422, "A repeated check needs its reviewed source, revision, host, scope and request identifier.")
    if any(value is not None for value in (req.expected_host_id, req.request_id, req.expected_scope)):
        if not req.expected_host_id or not req.request_id:
            raise HTTPException(422, "Reviewed checks need the expected host and request identifier.")
        from intelligence.diagnostic_workflow import run_reviewed
        return report_facts.present(run_reviewed(user, req.kind, req.target_id, req.internet, expected_host_id=req.expected_host_id,
                            request_id=req.request_id, expected_scope=req.expected_scope,
                            repeat_of=req.repeat_of, expected_report_revision=req.expected_report_revision, authorize=authorize,
                            **({"request_context": request_context} if request_context is not None else {})))
    return report_facts.present(diagnostics.run(user, req.kind, req.target_id, req.internet))


@router.get("/diagnostics/options")
def check_options(response: Response, computer_id: str | None = Query(default=None, max_length=256),
                  include_peer_observation: bool = Query(default=False)):
    from intelligence.diagnostic_workflow import options
    response.headers["Cache-Control"] = "no-store"
    return options(computer_id, include_peer_observation=include_peer_observation)


@router.get("/diagnostics")
def reports(user: str = Depends(require_session)):
    return {"reports": [report_facts.present(row) for row in diagnostics.history(user)]}


@router.get("/diagnostics/{ident}")
def report(ident: str, user: str = Depends(require_session)):
    return report_facts.present(diagnostics.get_report(user, ident))


@router.get("/diagnostics/{ident}/repeat-review")
def review_repeat(ident: str, response: Response, user: str = Depends(require_session)):
    from intelligence.report_review import repeat_review
    response.headers["Cache-Control"] = "no-store"
    return repeat_review(user, ident)


@router.get("/diagnostics/{ident}/compare/{other}")
def compare_reports(ident: str, other: str, response: Response, user: str = Depends(require_session)):
    from intelligence.report_review import compare, PROTOCOL
    from intelligence.store import LOCK
    import tli_state as S
    response.headers["Cache-Control"] = "no-store"
    with LOCK:
        result = compare(diagnostics.get_report(user, ident), diagnostics.get_report(user, other))
    return {"ok": True, "protocol": PROTOCOL, "actions_performed": False, "checked_at": S.now_iso(), "comparison": result}


@router.post("/diagnostics/{ident}/fix")
def fix(ident: str, req: Fact, user: str = Depends(require_session)):
    if not req.text.strip():
        raise HTTPException(422, "Describe the fix you verified.")
    return report_facts.present(diagnostics.confirm_fix(user, ident, req.text))


@router.get("/memory")
def facts(client_device_id: str | None = None, user: str = Depends(require_session)):
    return {"facts": memory.list_facts(user, client_device_id), "legacy_note": "Unowned device memories are accessible only while PIN authentication is disabled."}


@router.get("/memory/{ident}/links")
def note_relationships(ident: str, response: Response, after: str = Query(default="", max_length=256),
                       limit: int = Query(default=100, ge=1, le=200), user: str = Depends(require_session)):
    from intelligence.note_links import inspect
    response.headers["Cache-Control"] = "no-store"
    return inspect(user, ident, after, limit)


@router.put("/memory/{ident}/links")
def save_note_relationships(ident: str, req: NoteLinks, response: Response, user: str = Depends(require_session)):
    from intelligence.note_links import save
    response.headers["Cache-Control"] = "no-store"
    return save(user, ident, req.expected_revision, [link.model_dump() for link in req.links])


@router.post("/memory")
def add_fact(req: Fact, user: str = Depends(require_session)):
    if not req.text.strip():
        raise HTTPException(422, "Memory cannot be empty.")
    if req.device_id:
        devices.get(req.device_id)
    return memory.save_fact(user, req.text, req.category, req.device_id, title=req.title)


@router.patch("/memory/{ident}")
def edit_fact(ident: str, req: Fact, client_device_id: str | None = None, user: str = Depends(require_session)):
    if not req.text.strip():
        raise HTTPException(422, "Memory cannot be empty.")
    metadata = req.model_dump(include={"title", "category", "device_id"}, exclude_unset=True)
    if metadata.get("device_id"):
        devices.get(metadata["device_id"])
    if isinstance(metadata.get("title"), str):
        metadata["title"] = metadata["title"].strip()
    return memory.change(user, ident, req.text, client_device_id, expected_revision=req.expected_revision, metadata=metadata)


@router.delete("/memory/{ident}")
def forget_fact(ident: str, client_device_id: str | None = None, expected_revision: str | None = None, user: str = Depends(require_session)):
    return memory.change(user, ident, None, client_device_id, expected_revision=expected_revision)


@router.get("/models")
def list_models():
    return models.catalogue()


@router.get("/screenshots/context")
def screenshot_context(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return screenshots.review_context()


@router.put("/models/vision")
def model_profile(req: ModelProfile):
    return models.configure(req.model_id, req.vision)


@router.get("/images")
def list_images(user: str = Depends(require_session)):
    return {"images": [{k: v for k, v in i.items() if k != "b64"} for i in vision.images(user)]}


@router.get("/images/{ident}")
def get_image(ident: str, user: str = Depends(require_session)):
    item = next((i for i in vision.images(user) if i["id"] == ident), None)
    if not item:
        raise HTTPException(404, "Image not found or expired.")
    return Response(base64.b64decode(item["b64"]), media_type=item["mime"], headers={"Cache-Control": "no-store"})


@router.delete("/images/{ident}")
def delete_image(ident: str, user: str = Depends(require_session)):
    return vision.forget(user, ident)
