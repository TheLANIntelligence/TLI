"""Explicit owner-scoped troubleshooting journals. No inference or actions."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import stat
from typing import Literal
import uuid

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

import tli_state as S
from intelligence import chat_memory, diagnostics, memory
from intelligence.store import LOCK, private_path, read_private, write_private

PROTOCOL = "tli-cases-v1"
MAX_CASES = 200
MAX_CREATES = 1000
MAX_BYTES = 16 * 1024 * 1024


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EvidenceRef(Strict):
    kind: Literal["note", "report", "chat"]
    id: str = Field(min_length=1, max_length=256)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    message_index: int | None = Field(default=None, ge=0, le=1_000_000)


class Evidence(EvidenceRef):
    label: str = Field(min_length=1, max_length=240)
    linked_at: str = Field(min_length=1, max_length=64)


class Step(Strict):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    text: str = Field(min_length=1, max_length=1000)
    status: Literal["planned", "tried", "skipped"] = "planned"
    outcome: str = Field(default="", max_length=2000)


class Computer(Strict):
    id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=240)
    node_id: str | None = Field(default=None, max_length=256)


class Fields(Strict):
    title: str = Field(min_length=1, max_length=120)
    symptom: str = Field(min_length=1, max_length=4000)
    computer_id: str | None = Field(default=None, min_length=1, max_length=256)
    status: Literal["open", "resolved"] = "open"
    archived: bool = False
    steps: list[Step] = Field(default_factory=list, max_length=30)
    evidence: list[EvidenceRef] = Field(default_factory=list, max_length=32)
    resolution: str = Field(default="", max_length=2000)


class Create(Fields):
    request_id: str = Field(min_length=1, max_length=128)


class Update(Fields):
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    request_id: str | None = Field(default=None, min_length=1, max_length=128)


class Record(Strict):
    id: str = Field(pattern=r"^case-[a-f0-9]{32}$")
    title: str = Field(min_length=1, max_length=120)
    symptom: str = Field(min_length=1, max_length=4000)
    computer: Computer | None
    status: Literal["open", "resolved"]
    archived: bool
    steps: list[Step] = Field(max_length=30)
    evidence: list[Evidence] = Field(max_length=32)
    resolution: str = Field(max_length=2000)
    created_at: str = Field(min_length=1, max_length=64)
    updated_at: str = Field(min_length=1, max_length=64)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def revision(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def _pointer(value):
    result = {key: value[key] for key in ("kind", "id", "revision")}
    if value.get("message_index") is not None:
        result["message_index"] = value["message_index"]
    return result


def _semantic(value):
    if not value["title"].strip() or not value["symptom"].strip():
        raise ValueError("Empty troubleshooting details")
    if value["status"] == "resolved" and not value["resolution"].strip():
        raise ValueError("Describe the improvement you confirmed before resolving this problem")
    if len({step["id"] for step in value["steps"]}) != len(value["steps"]) or any(not step["text"].strip() for step in value["steps"]):
        raise ValueError("Steps need distinct identifiers and text")
    pointers = []
    for item in value["evidence"]:
        if (item["kind"] == "chat") != (item.get("message_index") is not None):
            raise ValueError("Chat links require a message index; other links do not")
        pointers.append((item["kind"], item["id"], item.get("message_index")))
    if len(set(pointers)) != len(pointers):
        raise ValueError("Evidence links must be distinct")
    if len(encoded(value)) > 128 * 1024:
        raise ValueError("This troubleshooting record is too large")


def validate_store(value):
    """Pure format check shared by persistence, archive and isolated recovery."""
    if not isinstance(value, dict) or set(value) != {"version", "cases", "creates"} or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Unsupported troubleshooting store")
    rows, creates = value["cases"], value["creates"]
    if not isinstance(rows, list) or len(rows) > MAX_CASES or not isinstance(creates, dict) or len(creates) > MAX_CREATES or len(encoded(value)) > MAX_BYTES:
        raise ValueError("Troubleshooting store exceeds supported limits")
    ids = set()
    for row in rows:
        Record.model_validate(row)
        _semantic(row)
        if row["id"] in ids:
            raise ValueError("Duplicate troubleshooting identifier")
        ids.add(row["id"])
        for field in ("created_at", "updated_at"):
            datetime.fromisoformat(row[field])
        for item in row["evidence"]:
            datetime.fromisoformat(item["linked_at"])
    import re
    for key, entry in creates.items():
        if (not re.fullmatch(r"[a-f0-9]{64}", key) or not isinstance(entry, dict) or set(entry) != {"id", "fingerprint"}
                or not re.fullmatch(r"case-[a-f0-9]{32}", entry.get("id", "")) or not re.fullmatch(r"[a-f0-9]{64}", entry.get("fingerprint", ""))):
            raise ValueError("Invalid create receipt")
    return len(rows)


def read_all(user):
    path = private_path(user, "cases", create=False)
    try:
        for entry in (path.parent, path):
            if entry.exists() or entry.is_symlink():
                info = entry.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    raise ValueError("Linked troubleshooting store")
        if path.exists() and path.stat().st_size > MAX_BYTES * 4 // 3 + 4096:
            raise ValueError("Unsupported troubleshooting file")
        value = read_private(user, "cases", {"version": 1, "cases": [], "creates": {}})
        validate_store(value)
        return value
    except Exception as exc:
        raise HTTPException(503, "Saved troubleshooting could not be read safely. Existing data and keys were preserved; check saved data before trying again.") from exc


def _write(user, value):
    validate_store(value)
    try:
        # Check the persisted key even when another reader cached it in memory.
        path = private_path(user, "cases", create=False)
        if path.exists():
            S._store_key("memory_key.bin")
        write_private(user, "cases", value)
    except Exception as exc:
        raise HTTPException(503, "Troubleshooting could not be saved safely. Previous saved work was preserved; keep your draft and retry deliberately.") from exc


def review_evidence(user, kind, ident, message_index=None):
    with LOCK, S.CONVERSATIONS_LOCK:
        if kind == "note":
            matches = [item for item in memory.list_facts(user) if item["id"] == ident]
            if not matches:
                raise HTTPException(404, "This note is unavailable to this account.")
            if len(matches) != 1:
                raise HTTPException(409, "This note identifier is ambiguous in the saved store. Preserve it and resolve the duplicate before linking evidence.")
            row = matches[0]
            ref = row["revision"]
            label = row.get("title") or "Saved note"
        elif kind == "report":
            row = diagnostics.get_report(user, ident)
            if sum(item.get("id") == ident for item in diagnostics.history(user)) != 1:
                raise HTTPException(409, "This report identifier is ambiguous in the saved store. No evidence link was selected.")
            ref = revision(row)
            label = f"{row.get('kind', 'Diagnostic')} report · {row.get('created_at', 'time unavailable')}"
        elif kind == "chat" and type(message_index) is int:
            row = chat_memory._owned(ident, user)
            turns = row.get("messages", [])
            if not 0 <= message_index < len(turns):
                raise HTTPException(404, "This chat message is no longer available.")
            source = chat_memory.source_ref(ident, message_index, turns[message_index])
            if source is None or turns[message_index].get("state") in ("streaming", "interrupted"):
                raise HTTPException(422, "Choose a completed saved chat message.")
            ref = source["revision"]
            label = row.get("title") or "Saved conversation"
        else:
            raise HTTPException(422, "Choose a saved note, report or completed chat message.")
        result = {"kind": kind, "id": ident, "revision": ref, "label": str(label)[:240]}
        if kind == "chat":
            result["message_index"] = message_index
        return result


def _public(user, row, *, resolve=True):
    result = {**row, "revision": revision(row)}
    if resolve:
        links = []
        for item in row["evidence"]:
            availability = "unavailable"
            try:
                current = review_evidence(user, item["kind"], item["id"], item.get("message_index"))
                availability = "current" if current["revision"] == item["revision"] else "changed"
            except HTTPException:
                pass
            links.append({**item, "availability": availability})
        result["evidence"] = links
    return result


def get_case(user, ident, *, resolve=True):
    with LOCK, S.CONVERSATIONS_LOCK:
        row = next((row for row in read_all(user)["cases"] if row["id"] == ident), None)
        if row is None:
            raise HTTPException(404, "Troubleshooting record not found.")
        return _public(user, row, resolve=resolve)


def list_cases(user, *, query="", status=None, limit=50):
    with LOCK:
        rows = read_all(user)["cases"]
        rows = [row for row in rows if (not status or (row["archived"] if status == "archived" else not row["archived"] and row["status"] == status))
                and (not query or query.casefold() in (row["title"] + " " + row["symptom"]).casefold())]
        rows.sort(key=lambda row: (row["updated_at"], row["id"]), reverse=True)
        return {"items": [{key: value for key, value in _public(user, row, resolve=False).items() if key not in ("evidence", "steps", "resolution")} for row in rows[:limit]], "total": len(rows)}


def _record(user, values, previous=None):
    _semantic(values)
    now = stamp()
    target = None
    if values["computer_id"]:
        if previous and (previous.get("computer") or {}).get("id") == values["computer_id"]:
            target = previous["computer"]
        else:
            from intelligence.devices import get
            target = get(values["computer_id"])
            if target.get("kind") != "computer":
                raise HTTPException(422, "Choose a computer for this problem. Device reports can be linked as evidence.")
            target = {key: target.get(key) for key in ("id", "name", "node_id")}
    old = {encoded(_pointer(item)): item for item in (previous or {}).get("evidence", [])}
    evidence = []
    for item in values["evidence"]:
        pointer = _pointer(item)
        if encoded(pointer) in old:
            evidence.append(old[encoded(pointer)])
            continue
        checked = review_evidence(user, item["kind"], item["id"], item.get("message_index"))
        if checked["revision"] != item["revision"]:
            raise HTTPException(409, "Linked evidence changed. Review that source again before saving.")
        evidence.append({**checked, "linked_at": now})
    return {"id": previous["id"] if previous else "case-" + uuid.uuid4().hex,
            **{key: values[key] for key in ("title", "symptom", "status", "archived", "steps", "resolution")},
            "computer": target, "evidence": evidence, "created_at": previous["created_at"] if previous else now, "updated_at": now}


def save(user, values, ident=None):
    with LOCK, S.CONVERSATIONS_LOCK:
        data = read_all(user)
        if ident is None:
            key = revision(values["request_id"])
            fingerprint = revision({key: value for key, value in values.items() if key != "request_id"})
            prior = data["creates"].get(key)
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "This create request was already used for different details. Reopen the saved problem before creating another.")
                row = next((row for row in data["cases"] if row["id"] == prior["id"]), None)
                if row is None:
                    raise HTTPException(409, "This creation was already completed and its problem was subsequently removed. It was not recreated.")
                return {"case": _public(user, row), "already_saved": True}
            if len(data["cases"]) >= MAX_CASES or len(data["creates"]) >= MAX_CREATES:
                raise HTTPException(409, "This troubleshooting store reached its supported limit. Existing records were retained; no automatic deletion occurred.")
            row = _record(user, values)
            data["cases"].append(row)
            data["creates"][key] = {"id": row["id"], "fingerprint": fingerprint}
        else:
            previous = next((row for row in data["cases"] if row["id"] == ident), None)
            if not previous:
                raise HTTPException(404, "Troubleshooting record not found.")
            if values["expected_revision"] != revision(previous):
                raise HTTPException(409, "This problem changed in another view. Your draft was not saved; reopen and review the current version.")
            row = _record(user, values, previous)
            data["cases"][data["cases"].index(previous)] = row
        _write(user, data)
        return {"case": _public(user, row), "already_saved": False}


def remove(user, ident, expected):
    with LOCK:
        data = read_all(user)
        row = next((row for row in data["cases"] if row["id"] == ident), None)
        if row is None:
            raise HTTPException(404, "Troubleshooting record not found.")
        if expected != revision(row):
            raise HTTPException(409, "This problem changed. Review its current version before removing it.")
        data["cases"].remove(row)
        _write(user, data)
        return {"id": ident, "deleted": True, "sources_changed": False}


def health(user):
    with LOCK:
        try:
            exists = private_path(user, "cases", create=False).exists()
            count = len(read_all(user)["cases"])
            return {"status": "readable" if exists else "not_created", "count": count, "checked_at": stamp()}
        except HTTPException:
            return {"status": "unavailable", "count": None, "checked_at": stamp()}
