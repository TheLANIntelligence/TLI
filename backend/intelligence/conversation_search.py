"""Bounded, read-only search over owned retained conversations. No search index."""
from __future__ import annotations

import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import threading
import time
import unicodedata
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
import tli_state as S

PROTOCOL = "conversation-search-v1"
MAX_STORE_BYTES = 16 * 1024 * 1024
MAX_RECORDS = 10000
MAX_PAGE_CONVERSATIONS = 250
MAX_PAGE_CHARS = 1024 * 1024
MAX_CONVERSATION_CHARS = 128 * 1024
MAX_MESSAGE_CHARS = 16 * 1024
MAX_MESSAGES = 500
CURSOR_SECONDS = 600
_cursors = {}
_cursor_lock = threading.RLock()


def _read():
    try:
        with S.CONVERSATIONS_LOCK:
            try:
                with Path(S.CONVERSATIONS_FILE).open("rb") as handle:
                    raw = handle.read(MAX_STORE_BYTES + 1)
            except FileNotFoundError:
                raw = b"{}"
            if len(raw) > MAX_STORE_BYTES:
                raise HTTPException(413, "Conversation history exceeds the 16 MiB search read limit. Recent history remains available; no saved data was changed.")
            version = hashlib.sha256(raw).hexdigest()
            data = json.loads(raw)
            if isinstance(data, dict) and data.get("_tli_enc"):
                if data.get("_tli_enc") != 1 or not isinstance(data.get("data"), str):
                    raise ValueError("Unsupported encrypted envelope")
                blob = base64.b64decode(data["data"], validate=True)
                data = json.loads(AESGCM(S._store_key("conversations_key.bin")).decrypt(blob[:12], blob[12:], None))
            if not isinstance(data, dict) or any(not isinstance(value, dict) for value in data.values()):
                raise ValueError("Unsupported conversation structure")
            if len(data) > MAX_RECORDS:
                raise HTTPException(413, "Conversation history exceeds the 10,000-record search limit. Recent history remains available; no saved data was changed.")
            return data, version
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, "Saved conversation history could not be read. Existing files were preserved; check Data & Recovery before trying again.") from error


def _normalize(text):
    return unicodedata.normalize("NFKC", text).casefold()


def _date(value):
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
    except ValueError:
        return None


def _snippet(text, query):
    # Original text is retained for display; normalization may change indexes,
    # so bound the excerpt around a case-insensitive match when possible.
    folded = text.casefold()
    index = folded.find(query)
    if index < 0 or len(folded) != len(text):
        text = _normalize(text)
        index = text.find(query)
    start = max(0, index - 60) if index >= 0 else 0
    excerpt = text[start:start + 240]
    return ("…" if start else "") + excerpt + ("…" if start + 240 < len(text) else "")


def _sort_date(value):
    valid = _date(value)
    if not valid:
        return float("-inf")
    parsed = datetime.fromisoformat(valid.replace("Z", "+00:00"))
    try:
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()
    except (ValueError, OverflowError, OSError):
        return float("-inf")


def _match(conversation, query, char_budget=MAX_CONVERSATION_CHARS):
    title = conversation.get("title")
    title = title if isinstance(title, str) else ""
    messages = conversation.get("messages")
    if not isinstance(messages, list):
        messages = []
        malformed = True
    else:
        malformed = False
    info = {"title": title[:120] or "Untitled conversation", "last_updated": _date(conversation.get("last_updated")),
            "message_count": len(messages), "provider": conversation.get("provider") if isinstance(conversation.get("provider"), str) else "unknown",
            "snippet": "", "match": {"source": "none", "at": None}, "truncated": False}
    info["provider"] = info["provider"][:64]
    if not query:
        return info, 0, 0, malformed
    char_budget = min(char_budget, MAX_CONVERSATION_CHARS)
    title_part = title[:min(MAX_MESSAGE_CHARS, char_budget)]
    text_limited = len(title) > len(title_part)
    inspected = len(title_part)
    if query in _normalize(title_part):
        info.update(snippet=_snippet(title_part, query), match={"source": "title", "at": info["last_updated"]}, truncated=text_limited)
        return info, inspected, 0, text_limited or malformed
    inspected_messages = 0
    for message in messages[:MAX_MESSAGES]:
        if inspected >= char_budget:
            text_limited = True
            break
        if not isinstance(message, dict):
            malformed = True
            continue
        if message.get("role") not in ("user", "assistant"):
            continue
        content = message.get("content")
        if not isinstance(content, str):
            malformed = True
            continue
        budget = min(MAX_MESSAGE_CHARS, char_budget - inspected)
        part = content[:budget]
        text_limited |= len(content) > len(part)
        inspected += len(part); inspected_messages += 1
        if query in _normalize(part):
            info.update(snippet=_snippet(part, query), match={"source": message["role"], "at": _date(message.get("ts") or message.get("timestamp"))},
                        truncated=text_limited or malformed)
            return info, inspected, inspected_messages, text_limited or malformed
    text_limited |= len(messages) > MAX_MESSAGES
    return None, inspected, inspected_messages, text_limited or malformed


def search(user, query="", limit=20, cursor=None):
    if not isinstance(query, str) or len(query) > 120 or any(unicodedata.category(c) == "Cc" for c in query):
        raise HTTPException(422, "Use a search query of at most 120 characters without control characters.")
    if type(limit) is not int or not 1 <= limit <= 50:
        raise HTTPException(422, "Choose a page size from 1 to 50.")
    display_query = query.strip()
    normalized = _normalize(display_query)
    conversations, version = _read()
    now = time.time()
    state = {"offset": 0, "scanned": 0, "messages": 0, "chars": 0, "text_limited": False}
    if cursor:
        with _cursor_lock:
            found = _cursors.get(cursor)
            if not found or found["user"] != user or found["expires_at"] <= now:
                raise HTTPException(410, "This history page expired or is unavailable. Start the search again.")
            if found["query"] != normalized or found["limit"] != limit:
                raise HTTPException(409, "The search changed. Start again without the old page cursor.")
            if found["version"] != version:
                raise HTTPException(409, "Saved conversations changed while paging. Start the search again to include the latest history.")
            state = copy.deepcopy(found["state"])
    owners = {user, "bundled-ai"} if user == "local" else {user}
    records = [(ident, row) for ident, row in conversations.items()
               if isinstance(ident, str) and 1 <= len(ident) <= 256 and isinstance(row.get("user_id"), str)
               and row["user_id"] in owners and not row.get("mesh_source_ip")]
    records.sort(key=lambda pair: (_sort_date(pair[1].get("last_updated")), pair[0]), reverse=True)
    items, page_scanned, page_chars = [], 0, 0
    offset = state["offset"]
    while offset < len(records) and len(items) < limit and page_scanned < MAX_PAGE_CONVERSATIONS and page_chars < MAX_PAGE_CHARS:
        ident, record = records[offset]
        item, chars, messages, limited = _match(record, normalized, MAX_PAGE_CHARS - page_chars)
        offset += 1; page_scanned += 1; page_chars += chars
        state["scanned"] += 1; state["messages"] += messages; state["chars"] += chars
        state["text_limited"] |= limited
        if item:
            items.append({"id": ident, **item})
    state["offset"] = offset
    next_cursor = None
    if offset < len(records):
        with _cursor_lock:
            for key, old in list(_cursors.items()):
                if old["expires_at"] <= now:
                    del _cursors[key]
            if len(_cursors) >= 256:
                del _cursors[min(_cursors, key=lambda key: _cursors[key]["expires_at"])]
            next_cursor = uuid.uuid4().hex
            _cursors[next_cursor] = {"user": user, "query": normalized, "limit": limit, "version": version,
                                     "state": copy.deepcopy(state), "expires_at": now + CURSOR_SECONDS}
    return {"ok": True, "protocol": PROTOCOL, "query": display_query, "items": items, "next_cursor": next_cursor,
            "coverage": {"complete": next_cursor is None and not state["text_limited"], "more_to_search": next_cursor is not None,
                         "text_limited": state["text_limited"], "scanned_conversations": state["scanned"],
                         "scanned_messages": state["messages"], "inspected_characters": state["chars"],
                         "owned_conversations": len(records), "page_scanned": page_scanned,
                         "limits": {"store_bytes": MAX_STORE_BYTES, "records": MAX_RECORDS,
                                    "conversations_per_page": MAX_PAGE_CONVERSATIONS, "messages_per_conversation": MAX_MESSAGES,
                                    "characters_per_message": MAX_MESSAGE_CHARS, "characters_per_conversation": MAX_CONVERSATION_CHARS,
                                    "characters_per_page": MAX_PAGE_CHARS}},
            "scope": "Search of this account's retained local conversations only. Nothing was sent to AI."}
