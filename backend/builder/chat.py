from __future__ import annotations

import uuid
from typing import Any

import tli_state as S

from .receipts import BUILDER_DIR
from . import chat_store


CHAT_PATH = BUILDER_DIR / "chat.json"


def load_chat_messages(limit: int = 50) -> list[dict[str, Any]]:
    items = chat_store.read(CHAT_PATH)
    return list(reversed(items[-limit:]))


def find_chat(chat_id: str) -> dict[str, Any] | None:
    """Locate a chat message by id. Returns None when not found."""
    if not chat_id:
        return None
    items = chat_store.read(CHAT_PATH)
    for item in items:
        if item.get("id") == chat_id:
            return item
    return None


def add_chat_message(
    prompt: str,
    response: str,
    backend: str = "",
    project: str = "",
    attachments: list[dict[str, Any]] | None = None,
    thread_id: str | None = None,
    parent_id: str | None = None,
) -> dict[str, Any]:
    if not thread_id:
        thread_id = "thr_" + uuid.uuid4().hex[:12]
    item = {
        "id": "chat_" + uuid.uuid4().hex[:12],
        "kind": "chat",
        "created_at": S.now_iso(),
        "updated_at": S.now_iso(),
        "status": "completed",
        "task": prompt,
        "project": project,
        "backend": backend,
        "response": response,
        "attachments": attachments or [],
        "thread_id": thread_id,
        "parent_id": parent_id or "",
    }
    return chat_store.append(CHAT_PATH, item)
