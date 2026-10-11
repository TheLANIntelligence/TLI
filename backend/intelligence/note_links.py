"""Reviewed relationships between current owned notes; no inferred knowledge graph."""
from fastapi import HTTPException
import tli_state as S
from intelligence import memory
from intelligence.store import LOCK

PROTOCOL = "tli-note-links-v1"


def _owned(user):
    value = S.load_memory(user, strict=True)
    notes = {f["id"]: f for f in value["facts"] if not f.get("deleted") and not f["id"].startswith("device-")}
    return value, notes


def _get(notes, ident):
    note = notes.get(ident)
    if note is None:
        raise HTTPException(404, "This note is no longer available to the current account.")
    return note


def _meta(note):
    return {"id": note["id"], "revision": memory.revision(note), "title": note.get("title") or "Untitled note",
            "source": note.get("source") or "user_memory", "updated_at": note.get("updated_at"), "device_id": note.get("device_id")}


def inspect(user, ident, after="", limit=100):
    with LOCK:
        _, notes = _owned(user)
        note = _get(notes, ident)
        links = []
        for edge in note.get("note_links", {}).get("links", []):
            target = notes.get(edge["id"])
            links.append({**edge, "availability": "unavailable" if target is None else "current" if memory.revision(target) == edge["revision"] else "changed",
                          "target": _meta(target) if target is not None else None})
        incoming = []
        for source in notes.values():
            for edge in source.get("note_links", {}).get("links", []):
                if edge["id"] == ident:
                    incoming.append({"source": _meta(source), "relation": edge["relation"], "linked_at": edge["linked_at"],
                                     "availability": "current" if edge["revision"] == memory.revision(note) else "changed"})
        candidates = sorted((n for n in notes.values() if n["id"] != ident and n["id"] > after), key=lambda n: n["id"])
        shown = candidates[:limit]
        return {"ok": True, "protocol": PROTOCOL, "actions_performed": False, "checked_at": S.now_iso(), "note": _meta(note),
                "links": links, "incoming": incoming[:20], "incoming_total": len(incoming), "candidates": [_meta(n) for n in shown],
                "next_after": shown[-1]["id"] if len(candidates) > limit else None,
                "scope": "These are relationships you recorded between saved notes, not verified facts. Linking does not copy note bodies, change Chat recall or establish current health. Deleted content is never recreated."}


def save(user, ident, expected_revision, links):
    with LOCK:
        value, notes = _owned(user)
        note = _get(notes, ident)
        memory.check_revision(note, expected_revision)
        existing = {(edge["id"], edge["revision"], edge["relation"]): edge for edge in note.get("note_links", {}).get("links", [])}
        seen, reviewed = set(), []
        for edge in links:
            target_id = edge["id"]
            if target_id == ident or target_id in seen:
                raise HTTPException(422, "Choose each other note once. A note cannot link to itself.")
            seen.add(target_id)
            key = target_id, edge["revision"], edge["relation"]
            if key in existing:
                reviewed.append(dict(existing[key]))
                continue  # unchanged historical pointers can be kept or removed
            target = _get(notes, target_id)
            if memory.revision(target) != edge["revision"]:
                raise HTTPException(409, "A linked note changed. Review its current version before saving the relationship.")
            reviewed.append({**edge, "linked_at": S.now_iso()})
        if reviewed == note.get("note_links", {}).get("links", []):
            return inspect(user, ident)
        note["note_links"] = {"schema_version": 1, "links": reviewed}
        note["updated_at"] = S.now_iso()
        S.save_memory(user, value)
        return inspect(user, ident)
