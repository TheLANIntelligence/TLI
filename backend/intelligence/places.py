"""Owner-scoped favorites. Saving never probes, opens or changes a target."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import uuid

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from typing import Literal
import tli_state as S
from intelligence import memory, store

PANELS = {"panel-dashboard2": "Dashboard", "panel-main": "AI Chat", "panel-files": "Files",
          "panel-visualizer": "Free Space", "panel-settings": "Settings", "panel-devices": "Devices"}
MAX_PLACES = 100
MAX_STORE_BYTES = 512 * 1024
_probe_slots = threading.BoundedSemaphore(2)
CHECK_SECONDS = 1.5


class PlaceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["folder", "panel", "note"]
    target: str = Field(min_length=1, max_length=2048)


class RenameInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=120)
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")


class SavedPlace(PlaceInput):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    created_at: str = Field(min_length=1, max_length=64)
    updated_at: str = Field(min_length=1, max_length=64)


def _name(value):
    value = value.strip()
    if not value or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in value):
        raise HTTPException(422, "Enter a name without control characters.")
    return value


def _target(kind, raw):
    if any(ord(c) < 32 for c in raw):
        raise HTTPException(422, "The saved target contains invalid characters.")
    if kind == "panel":
        if raw not in PANELS:
            raise HTTPException(422, "Choose an available TLI panel.")
        return raw
    if kind == "note":
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,240}", raw) or raw.startswith("device-"):
            raise HTTPException(422, "Choose an owned Notebook note.")
        return raw
    # Do not resolve symlinks or contact a network share while saving a favorite.
    value = os.path.expanduser(raw.strip())
    if value.startswith(("\\\\", "//")) or "\x00" in value:
        raise HTTPException(422, "Use an absolute local path or a mapped drive on this TLI host.")
    if not os.path.isabs(value) or (os.name == "nt" and (not re.match(r"^[A-Za-z]:[\\/]", value) or ":" in value[2:])):
        raise HTTPException(422, "Enter an absolute folder or drive path on this TLI host.")
    return os.path.normpath(value)


def _load(user):
    path = store.private_path(user, "places", create=False)
    try:
        if path.stat().st_size > MAX_STORE_BYTES:
            raise ValueError("Oversized saved places")
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as exc:
        raise HTTPException(503, "Saved places are unavailable. The existing file was preserved.") from exc
    value = store.read_private(user, "places", {"version": 1, "places": []})
    try:
        if value.get("version") != 1 or not isinstance(value.get("places"), list) or len(value["places"]) > MAX_PLACES:
            raise ValueError("Invalid saved places")
        rows = [SavedPlace.model_validate(p).model_dump() for p in value["places"]]
        if len({p["id"] for p in rows}) != len(rows):
            raise ValueError("Duplicate saved identifiers")
        for row in rows:
            _name(row["name"])
            # Paths are host-specific; don't rewrite them after an OS transfer.
            if row["kind"] != "folder":
                _target(row["kind"], row["target"])
        return rows
    except (ValidationError, ValueError, HTTPException) as exc:
        raise HTTPException(503, "Saved places are unreadable or use an unsupported format. The existing file was preserved.") from exc


def _public(row):
    return {**row, "revision": hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False).encode()).hexdigest()}


def listing(user):
    with store.LOCK:
        return {"ok": True, "protocol": "saved-places-v1", "places": [_public(row) for row in _load(user)], "limit": MAX_PLACES}


def _note(user, ident):
    return next((n for n in memory.list_facts(user) if n["id"] == ident), None)


def create(user, req):
    name, target = _name(req.name), _target(req.kind, req.target)
    with store.LOCK:
        rows = _load(user)
        if req.kind == "note" and _note(user, target) is None:
            raise HTTPException(404, "Notebook note not found for this account.")
        key = os.path.normcase(target) if req.kind == "folder" else target
        existing = next((p for p in rows if p["kind"] == req.kind and (os.path.normcase(p["target"]) if p["kind"] == "folder" else p["target"]) == key), None)
        if existing:
            return {"ok": True, "created": False, "place": _public(existing), "message": "This target is already saved."}
        if len(rows) >= MAX_PLACES:
            raise HTTPException(409, "Saved places is full. Remove a favorite before adding another.")
        row = {"id": uuid.uuid4().hex, "name": name, "kind": req.kind, "target": target, "created_at": S.now_iso(), "updated_at": S.now_iso()}
        store.write_private(user, "places", {"version": 1, "places": rows + [row]})
        return {"ok": True, "created": True, "place": _public(row), "message": "Favorite saved. Its target was not opened or scanned."}


def change(user, ident, expected, name=None):
    with store.LOCK:
        rows = _load(user)
        row = next((p for p in rows if p["id"] == ident), None)
        if row is None:
            raise HTTPException(404, "Saved place not found.")
        if _public(row)["revision"] != expected:
            raise HTTPException(409, "This favorite changed. Refresh saved places before editing it.")
        if name is None:
            store.write_private(user, "places", {"version": 1, "places": [p for p in rows if p["id"] != ident]})
            return {"ok": True, "removed": True, "id": ident}
        row.update(name=_name(name), updated_at=S.now_iso())
        store.write_private(user, "places", {"version": 1, "places": rows})
        return {"ok": True, "place": _public(row)}


def _probe(path):
    try:
        info = Path(path).stat()
        return ("available", "The location was reachable at this check.") if stat.S_ISDIR(info.st_mode) else ("unavailable", "This saved location is not a folder or drive.")
    except FileNotFoundError:
        return "unavailable", "The location was not found. Reconnect the drive or review its path. The favorite is retained."
    except PermissionError:
        return "unavailable", "TLI cannot access this location with its current account. The favorite is retained."
    except OSError:
        return "unknown", "TLI could not confirm access to this location. The favorite is retained."


def _bounded_probe(path):
    slots = _probe_slots
    if not slots.acquire(blocking=False):
        return "unknown", "Other location checks are still pending. Try again explicitly later."
    done, result = threading.Event(), []
    def work():
        try:
            result.append(_probe(path))
        except Exception:
            result.append(("unknown", "The location check could not complete. The favorite is retained."))
        finally:
            slots.release(); done.set()
    try:
        threading.Thread(target=work, name="tli-saved-place-check", daemon=True).start()
    except Exception:
        slots.release()
        return "unknown", "The location check could not start."
    if not done.wait(CHECK_SECONDS) or not result:
        return "unknown", "The location check timed out. The drive may be disconnected; the favorite is retained."
    return result[0]


def check(user, ident):
    with store.LOCK:
        row = next((p for p in _load(user) if p["id"] == ident), None)
        if row is None:
            raise HTTPException(404, "Saved place not found.")
        result = {"ok": True, "id": ident, "revision": _public(row)["revision"], "checked_at": S.now_iso(), "status": "available", "detail": "TLI panel is available."}
        if row["kind"] == "note":
            note = _note(user, row["target"])
            if note is None:
                result.update(status="unavailable", detail="This note is no longer available. The favorite is retained.")
            else:
                result.update(detail="Notebook note is available.", note={"id": note["id"], "revision": note["revision"]})
            return result
    if row["kind"] == "folder":
        try:
            path = _target("folder", row["target"])
            result["status"], result["detail"] = _bounded_probe(path)
        except HTTPException:
            result.update(status="unavailable", detail="This path does not match this host's platform. The favorite is retained.")
    return result
