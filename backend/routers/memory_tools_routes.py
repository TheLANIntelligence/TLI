"""Authenticated, explicit chat-to-Notebook review and save operations."""
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from routers.system_routes import require_session
from intelligence import chat_memory

router = APIRouter(prefix="/api/intelligence/memory", tags=["memory"], dependencies=[Depends(require_session)])


class SourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=256)
    message_index: int = Field(strict=True, ge=0, le=1_000_000)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")


class Preview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_ref: SourceRef


class Save(Preview):
    text: str = Field(min_length=1, max_length=2000)
    title: str = Field(default="", max_length=120)
    category: str = Field(default="general", min_length=1, max_length=64)
    device_id: str | None = Field(default=None, min_length=1, max_length=256)
    reviewed: bool = Field(strict=True)
    request_id: str | None = Field(default=None, min_length=1, max_length=128)
    note_id: str | None = Field(default=None, min_length=1, max_length=256)
    expected_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


@router.get("/capabilities")
def capabilities(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "protocol": chat_memory.PROTOCOL, "use_conversation_history": True, "evidence_context_version": 1}


@router.post("/from-chat/preview")
def preview(req: Preview, response: Response, user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return chat_memory.preview(user, req.source_ref.model_dump())


@router.post("/from-chat/save")
def save(req: Save, response: Response, user: str = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    if req.reviewed is not True:
        raise HTTPException(422, "Review the source and note before saving.")
    return chat_memory.save(user, req.source_ref.model_dump(), text=req.text, title=req.title,
                            category=req.category, device_id=req.device_id,
                            note_id=req.note_id, expected_revision=req.expected_revision)
