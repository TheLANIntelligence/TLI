"""Owner-scoped adapters over encrypted user facts and legacy device memories."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import uuid
from fastapi import HTTPException
import tli_state as S
from intelligence.store import LOCK


def legacy_path(device_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", device_id):
        raise HTTPException(422, "Invalid client device identifier.")
    from ai.ai_manager import _ai_base_dir
    return _ai_base_dir() / "memory" / "devices" / f"{device_id}_memory.json"


def legacy_facts(user: str, client_device_id: str | None) -> list:
    # Old device files contain no owner. Never assign those private facts to a
    # signed-in user merely because their request supplies a matching device ID.
    if user != "local" or S.load_pin_config()["enabled"] or not client_device_id:
        return []
    path = legacy_path(client_device_id)
    if not path.exists():
        return []
    items = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(items, list):
        return []
    return [{"id": "device-" + hashlib.sha256(str(text).encode()).hexdigest()[:24], "text": str(text),
             "category": "legacy_device", "device_id": None, "client_device_id": client_device_id,
             "source": "legacy_device", "deleted": False} for text in items if isinstance(text, str)]


def list_facts(user: str, client_device_id: str | None = None) -> list:
    with LOCK:
        facts = [{**f, "source": f.get("source", "user_memory")} for f in S.load_memory(user, strict=True)["facts"] if not f.get("deleted")]
        return [public_fact(f) for f in facts + legacy_facts(user, client_device_id)]


def revision(fact: dict) -> str:
    fields = {k: fact.get(k) for k in ("id", "text", "title", "category", "device_id", "created_at", "updated_at", "source", "report_id", "deleted")}
    fields["source"] = fact.get("source") or "user_memory"
    # Older notes retain their existing revision. A newly recorded chat origin
    # is part of the version the owner reviewed, without copying chat contents.
    if "chat_source" in fact:
        fields["chat_source"] = fact["chat_source"]
    if "note_links" in fact:
        fields["note_links"] = fact["note_links"]
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def public_fact(fact: dict) -> dict:
    return {**fact, "revision": revision(fact)}


def save_fact(user: str, text: str, category="general", device_id=None, report_id=None, title=None) -> dict:
    with LOCK:
        memory = S.load_memory(user, strict=True)
        fact = next((f for f in memory["facts"] if report_id and f.get("report_id") == report_id and not f.get("deleted")), None)
        if fact is None:
            fact = {"id": "f-" + uuid.uuid4().hex, "created_at": S.now_iso()}
            memory["facts"].append(fact)
        fact.update({"text": text.strip(), "category": category, "device_id": device_id, "updated_at": S.now_iso(),
                     "source": "user_confirmation" if report_id else "user", "report_id": report_id, "deleted": False})
        if title is not None:
            fact["title"] = title.strip()
        S.save_memory(user, memory)
        return public_fact(fact)


def change(user: str, fact_id: str, text: str | None, client_device_id: str | None = None, *, expected_revision=None, metadata=None) -> dict:
    with LOCK:
        if fact_id.startswith("device-"):
            facts = legacy_facts(user, client_device_id)
            selected = next((f for f in facts if f["id"] == fact_id), None)
            if selected is None:
                raise HTTPException(404, "Memory not found.")
            check_revision(selected, expected_revision)
            path = legacy_path(client_device_id)
            remaining = [f["text"] for f in facts if f["id"] != fact_id]
            changes = dict(metadata or {})
            category = changes.pop("category", "general")
            replacement = save_fact(user, text, category, **changes) if text is not None else {"id": fact_id, "deleted": True}
            S.save_json_file(path, remaining)
            return replacement
        memory = S.load_memory(user, strict=True)
        fact = next((f for f in memory["facts"] if f["id"] == fact_id and not f.get("deleted")), None)
        if fact is None:
            raise HTTPException(404, "Memory not found.")
        check_revision(fact, expected_revision)
        if text is None:
            # Remove content, not merely its retrieval flag.
            memory["facts"] = [f for f in memory["facts"] if f["id"] != fact_id]
        else:
            fact.update({"text": text.strip(), "updated_at": S.now_iso()})
            fact.update(metadata or {})
        S.save_memory(user, memory)
        return public_fact(fact) if text is not None else {"id": fact_id, "deleted": True}


def check_revision(fact, expected):
    if expected is not None and expected != revision(fact):
        raise HTTPException(409, "This note changed since you opened it. Refresh and review it before trying again.")


_STOP_WORDS = frozenset("""a an and are as at be been being but by can could did do does
for from had has have how i if in into is it its me my of on or our please should
so some than that the their them then there these they this those to us was we
were what when where which who why will with would you your about also tell know
remember saved note notes memory memories help need needs use uses using want
show give get got like just let lets may might more most much now any all something
anything everything say says said thanks thank tli""".split())


def _terms(text: str) -> list[str]:
    """Small, deterministic lexical recall; no inferred synonyms or identities."""
    terms = re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold())
    return [word[:-1] if len(word) > 4 and word.endswith("s") and not word.endswith(("ss", "us", "ous", "ics")) else word
            for word in terms if len(word) > 1 and word not in _STOP_WORDS]


_FOLLOW_UP = re.compile(
    r"(?:and )?(?:"
    r"what (?:fixed|solved|resolved) (?:it|that|this)(?: (?:last time|before|previously))?"
    r"|what (?:worked|helped)(?: (?:last time|before|previously))"
    r"|how did (?:we|i|you) (?:fix|solve|resolve) (?:it|that|this)(?: (?:last time|before|again))?"
    r"|what was (?:the|our) (?:fix|solution)(?: (?:last time|before))?"
    r"|(?:what|how) about (?:it|that|this)"
    r")"
)


def follow_up_query(question: str, history: list) -> str:
    """Use a nearby user-authored topic for a small set of referential questions.

    This selects current owned notes, not facts from old assistant answers. An
    ordinary new topic, an incomplete exchange or an oversized preceding turn
    stops the lookup. No search through older conversations or whole history.
    """
    def refers(text):
        if not isinstance(text, str) or len(text) > 160:
            return False
        normalized = " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold()))
        return _FOLLOW_UP.fullmatch(normalized) is not None

    if not refers(question):
        return question
    recent = list(history or [])[-6:]
    for offset in range(len(recent) - 2, -1, -2):
        user, assistant = recent[offset:offset + 2]
        if not isinstance(user, dict) or not isinstance(assistant, dict) or user.get("role") != "user" or assistant.get("role") != "assistant":
            return ""
        topic = user.get("content")
        if not isinstance(topic, str) or not topic.strip() or len(topic) > 800:
            return ""
        if refers(topic):
            continue
        terms = _terms(topic)
        # Keep the anchor as retrieval terms only. It never replaces the user's
        # final question or promotes a historical assertion to current evidence.
        return " ".join(terms)
    # Generic words such as "fixed" and "last time" are not a topic. With no
    # trustworthy nearby anchor, do not retrieve every similarly worded fix.
    return ""


def relevant(user: str, query: str, target_id: str | None = None, client_device_id: str | None = None, limit=8) -> list:
    """Return relevant current owned notes, never unowned browser-device files.

    A client ID describes the caller, not the subject of their question. Only an
    explicitly selected target can make a device-scoped note eligible.
    """
    query_terms = _terms(query)
    words = set(query_terms)
    if not user or not words:
        return []
    query_phrase = " ".join(query_terms)
    with LOCK:
        facts = [public_fact(f) for f in S.load_memory(user, strict=True)["facts"]
                 if not f.get("deleted") and not f["id"].startswith("device-")]
    ranked = []
    for fact in facts:
        if fact.get("device_id") and fact["device_id"] != target_id:
            continue
        title_terms = _terms(fact.get("title") or "")
        text_terms = _terms(fact["text"])
        title_overlap = words & set(title_terms)
        body_overlap = words & set(text_terms)
        score = 4 * len(title_overlap) + len(body_overlap)
        if not score:
            continue
        # Matching a useful multiword phrase distinguishes, for example,
        # "printer paper" from a note mentioning a printer and unrelated paper.
        title_phrase = " ".join(title_terms)
        if len(title_terms) >= 2 and f" {title_phrase} " in f" {query_phrase} ":
            score += 8
        if len(query_terms) >= 2:
            if f" {query_phrase} " in f" {title_phrase} ":
                score += 8
            if f" {query_phrase} " in f" {' '.join(text_terms)} ":
                score += 3
        if target_id and fact.get("device_id") == target_id:
            score += 2  # scope can rank a relevant note, never create relevance
        if score:
            ranked.append((score, fact))
    ranked.sort(key=lambda item: (-item[0], str(item[1].get("id") or "")))
    return [f for _, f in ranked[:max(0, min(int(limit), 8))]]
