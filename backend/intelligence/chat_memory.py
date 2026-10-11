"""Explicit, reviewed copies of owned persisted chat messages into the Notebook."""
from __future__ import annotations

import hashlib
import json
from fastapi import HTTPException
import tli_state as S
from intelligence import devices, memory
from intelligence.store import LOCK

PROTOCOL = "tli-memory-continuity-v1"
MAX_SOURCE_CHARS = 32000


def source_ref(conversation_id: str, message_index: int, turn: dict) -> dict | None:
    """Body-free pointer; receipts added later do not change the source revision."""
    if (not isinstance(conversation_id, str) or not 0 < len(conversation_id) <= 256
            or type(message_index) is not int or not 0 <= message_index <= 1_000_000
            or not isinstance(turn, dict) or turn.get("role") not in ("user", "assistant")
            or not isinstance(turn.get("content"), str) or not turn["content"].strip()
            or len(turn["content"]) > MAX_SOURCE_CHARS):
        return None
    fields = {key: turn.get(key) for key in ("role", "content", "ts", "provider", "model")}
    encoded = json.dumps([conversation_id, message_index, fields], sort_keys=True, ensure_ascii=False).encode("utf-8")
    return {"conversation_id": conversation_id, "message_index": message_index,
            "revision": hashlib.sha256(encoded).hexdigest()}


def _owned(conversation_id, user):
    conv = S.load_conversations().get(conversation_id)
    allowed = {user, "bundled-ai"} if user == "local" else {user}
    if not isinstance(conv, dict) or (user is not None and conv.get("user_id") not in allowed):
        raise HTTPException(404, "Saved chat message is no longer available to this account.")
    return conv


def source_refs(conversation_id, user=None) -> dict:
    """Internal helper for the latest completed persisted pair; never looks up by text."""
    if not conversation_id:
        return {}
    with S.CONVERSATIONS_LOCK:
        conv = _owned(conversation_id, user)
        turns = conv.get("messages")
        if not isinstance(turns, list) or len(turns) < 2:
            return {}
        result = {}
        for index in range(max(0, len(turns) - 2), len(turns)):
            ref = source_ref(conversation_id, index, turns[index])
            if ref:
                result["user_source_ref" if turns[index]["role"] == "user" else "source_ref"] = ref
        return result


def _read(user: str, ref: dict) -> tuple[dict, str]:
    conv = _owned(ref["conversation_id"], user)
    turns = conv.get("messages")
    index = ref["message_index"]
    if not isinstance(turns, list) or index >= len(turns):
        raise HTTPException(404, "Saved chat message is no longer available to this account.")
    turn = turns[index]
    current = source_ref(ref["conversation_id"], index, turn)
    if current is None:
        raise HTTPException(422, "This saved message cannot be reviewed here. Choose a shorter text message.")
    if current != ref:
        raise HTTPException(409, "This saved message changed. Reopen the conversation and review it again.")
    origin = {**current, "role": turn["role"]}
    for field, original, limit in (("created_at", "ts", 64), ("provider", "provider", 120), ("model", "model", 256)):
        value = turn.get(original)
        if isinstance(value, str) and 0 < len(value) <= limit:
            origin[field] = value
    return origin, turn["content"]


def preview(user, ref):
    with S.CONVERSATIONS_LOCK:
        origin, text = _read(user, ref)
    return {"source": origin, "source_kind": "user_statement" if origin["role"] == "user" else "ai_suggestion",
            "text": text, "suggested_text": text if len(text) <= 2000 else "",
            "suggested_title": "Saved user statement" if origin["role"] == "user" else "Saved TLI suggestion",
            "requires_excerpt": len(text) > 2000}


def save(user, ref, *, text, title="", category="general", device_id=None,
         note_id=None, expected_revision=None):
    text, title = text.strip(), title.strip()
    if not text or len(text) > 2000 or len(title) > 120 or not isinstance(category, str) or not 1 <= len(category) <= 64:
        raise HTTPException(422, "Review a note of 1–2000 characters and a title of up to 120 characters.")
    if note_id is None and category not in ("general", "preference", "device"):
        raise HTTPException(422, "Choose a general, preference or device category for this new note.")
    if note_id is not None and not expected_revision:
        raise HTTPException(409, "Open and review the existing note before updating it.")
    if note_id is None and expected_revision is not None:
        raise HTTPException(422, "Choose the existing note that this revision belongs to.")
    # Match the existing backup/store lock order. Source deletion/edit and note
    # creation cannot interleave; no provider, tool, or action is called here.
    with LOCK, S.CONVERSATIONS_LOCK:
        origin, _ = _read(user, ref)
        if note_id is not None:
            saved = S.load_memory(user, strict=True)
            existing = next((f for f in saved["facts"] if f.get("id") == note_id and not f.get("deleted")), None)
            if existing is None or note_id.startswith("device-"):
                raise HTTPException(404, "The selected note is no longer available to this account.")
            # A repeated request must not overwrite a newer edit, even when its
            # proposed text looks the same. The owner must review that revision.
            memory.check_revision(existing, expected_revision)
            if category not in ("general", "preference", "device") and (category != existing.get("category") or category == "verified_fix"):
                raise HTTPException(422, "Keep the existing category or choose general, preference or device. A chat update cannot confirm a fix.")
            # Historical associations can outlive the device registry. Preserve
            # a reviewed unchanged association; new assignments still validate.
            if device_id and device_id != existing.get("device_id"):
                devices.get(device_id)
            existing.update({"text": text, "title": title, "category": category,
                             "device_id": device_id, "updated_at": S.now_iso(),
                             "source": "chat_user" if origin["role"] == "user" else "chat_ai",
                             "chat_source": origin})
            # Replacing a historical fix with reviewed chat text does not
            # confirm that the replacement solved the original diagnostic.
            existing.pop("report_id", None)
            S.save_memory(user, saved)
            return {"ok": True, "note": memory.public_fact(existing),
                    "already_saved": False, "updated_existing": True}
        payload = [user, ref, text, title, category, device_id]
        ident = "f-chat-" + hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        saved = S.load_memory(user, strict=True)
        existing = next((f for f in saved["facts"] if f.get("id") == ident and not f.get("deleted")), None)
        if existing:
            return {"ok": True, "note": memory.public_fact(existing), "already_saved": True}
        if device_id:
            devices.get(device_id)
        now = S.now_iso()
        fact = {"id": ident, "text": text, "title": title, "category": category, "device_id": device_id,
                "created_at": now, "updated_at": now, "deleted": False,
                "source": "chat_user" if origin["role"] == "user" else "chat_ai", "chat_source": origin}
        saved["facts"].append(fact)
        S.save_memory(user, saved)
        return {"ok": True, "note": memory.public_fact(fact), "already_saved": False}
