"""Revision-checked AI choice shared by clients of the same conversation."""
from fastapi import HTTPException
import tli_state as S
from conversation_guard import assert_idle
from workspace_events import publish
from private_client_authority import checked_call

PROTOCOL = "tli-conversation-settings-v1"


def owned(conversations, ident, owner):
    conv = conversations.get(ident)
    allowed = {owner, "bundled-ai"} if owner == "local" else {owner}
    if not conv or conv.get("user_id") not in allowed:
        raise HTTPException(404, "Conversation not found.")
    return conv


def public(conv):
    return {"protocol": PROTOCOL, "conversation_id": conv["id"],
            "compute_selection": conv.get("compute_selection"), "settings_revision": conv.get("settings_revision", 0)}


def get(ident, owner, *, check=None):
    """Optional checked reader; an internal owner alone grants no HTTP access."""
    authorize = check or (lambda: None)
    def read():
        authorize()
        with S.CONVERSATIONS_LOCK:
            authorize()
            conversations = S.load_conversations(check=check) if check is not None else S.load_conversations()
            authorize()
            value = public(owned(conversations, ident, owner))
            authorize()
        return value
    return checked_call(authorize, read) if check is not None else read()


@S.conversation_transaction
def update(ident, owner, selection, expected_revision):
    conversations = S.load_conversations()
    conv = owned(conversations, ident, owner)
    assert_idle([ident])
    if conv.get("settings_revision", 0) != expected_revision:
        raise HTTPException(409, "The AI selection changed on another device. Refresh before choosing again.")
    if selection is not None:
        from lan_inference import selection as validate_selection
        validate_selection(selection)
    conv.update(compute_selection=selection, settings_revision=expected_revision + 1)
    S.save_conversations(conversations)
    publish(owner, "conversation_settings", ident)
    return public(conv)


@S.conversation_transaction
def prepare(ident, owner, payload):
    """Reserve history before dispatch; never infer a replacement for a stale choice."""
    conversations = S.load_conversations()
    if ident in conversations:
        conv = owned(conversations, ident, owner)
        saved = conv.get("compute_selection")
        if "lan_inference" in payload and payload["lan_inference"] != saved:
            raise HTTPException(409, "The conversation's AI selection changed. Refresh its settings before sending.")
        payload["lan_inference"] = saved
    else:
        now = S.now_iso()
        conv = {"id": ident, "user_id": owner, "title": str(payload.get("message", ""))[:80],
                "created_at": now, "last_updated": now, "messages": [], "provider": "bundled",
                "compute_selection": payload.get("lan_inference"), "settings_revision": 0}
        conversations[ident] = conv
    if payload.get("lan_inference") is not None:
        from lan_inference import selection as validate_selection
        validate_selection(payload["lan_inference"])
    S.save_conversations(conversations)
    return public(conv)
