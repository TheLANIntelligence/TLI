"""Reviewed shared relationships and account-scoped historical device details.

Registry identity is authoritative. These views never discover, probe, control,
or infer present health from a room, a priority or a saved diagnostic report.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone

from fastapi import HTTPException
import tli_state as S
from intelligence import devices, diagnostics
from intelligence.store import LOCK

PROTOCOL = "tli-device-details-v1"
RELATIONS = {"depends_on", "powered_by", "connected_to"}
PRIORITIES = {"normal", "important", "critical"}


def _relations(entry: dict) -> list[dict]:
    rows = entry.get("relationships", [])
    if not isinstance(rows, list) or len(rows) > 8:
        raise ValueError("Invalid relationship list")
    seen = set()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"target_id", "relationship", "note"} or
                not isinstance(row["target_id"], str) or not 1 <= len(row["target_id"]) <= 256 or
                row["relationship"] not in RELATIONS or not isinstance(row["note"], str) or len(row["note"]) > 240):
            raise ValueError("Invalid relationship")
        key = row["target_id"], row["relationship"]
        if key in seen:
            raise ValueError("Duplicate relationship")
        seen.add(key)
    if entry.get("importance", "normal") not in PRIORITIES:
        raise ValueError("Invalid importance")
    return copy.deepcopy(rows)


def _metadata():
    value = devices.metadata()
    try:
        for entry in value.values():
            _relations(entry)
    except (ValueError, TypeError) as exc:
        raise HTTPException(503, "Saved device relationships are unavailable. Existing data was retained.") from exc
    return value


def _ref(item: dict | None):
    if item is None:
        return None
    return {k: copy.deepcopy(item.get(k)) for k in
            ("id", "name", "kind", "address", "relay", "node_id", "source", "room", "importance")}


def _when(value):
    if not isinstance(value, str):
        return None
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return date.astimezone(timezone.utc) if date.tzinfo else None
    except (ValueError, OverflowError):
        return None


def _observed(device: dict, now: datetime):
    date = _when(device.get("observed_at"))
    age = (now - date).total_seconds() if date else None
    if age is None or age < -5:
        return {"status": "unknown", "observed_at": None, "age_seconds": None,
                "scope": "Registration is known; this view has no usable observation time. No check was run."}
    return {"status": "stale" if age > 30 else "reported", "observed_at": device["observed_at"],
            "age_seconds": max(0, round(age, 1)),
            "scope": "Time of the cached registry report, not confirmation of current health or device function."}


def _counts(report):
    counts = {"pass": 0, "fail": 0, "unavailable": 0, "unknown": 0}
    checks = report.get("checks")
    if not isinstance(checks, list):
        return None
    for row in checks:
        status = row.get("status") if isinstance(row, dict) else None
        counts[status if status in counts else "unknown"] += 1
    return counts


def _report_matches(report: dict, device: dict, host: dict) -> bool:
    measured_host = report.get("host")
    if not isinstance(measured_host, dict) or measured_host.get("id") != host.get("id"):
        return False
    target = report.get("target")
    if device.get("source") == "local_node" and report.get("kind") in {"system", "network", "performance"}:
        # Legacy host-only records sometimes have no target; never include a
        # reachability report of another computer in the host's CPU timeline.
        return target is None or isinstance(target, dict) and target.get("id") in {device["id"], host["id"]}
    return (report.get("kind") == "device" and isinstance(target, dict) and
            target.get("id") == device.get("id"))


def _timeline(user: str, device: dict, host: dict):
    scope = ("Your saved reports for this stable device identity. Addresses and relay targets are historical; "
             "open a report to review its measured scope. Reports do not establish present health.")
    try:
        reports = diagnostics.history(user)
        if (not isinstance(reports, list) or len(reports) > 200 or
                any(not isinstance(row, dict) for row in reports)):
            raise ValueError("Invalid report history")
        from intelligence.report_review import revision
        rows = []
        for report in reports:
            if not _report_matches(report, device, host):
                continue
            if not isinstance(report.get("id"), str) or not report["id"] or not _when(report.get("created_at")):
                raise ValueError("Malformed report identity")
            counts = _counts(report)
            if counts is None:
                raise ValueError("Malformed report checks")
            fix = report.get("verified_fix")
            rows.append({"id": report["id"], "revision": revision(report), "created_at": report["created_at"],
                         "kind": report.get("kind"), "host": _ref(report.get("host")),
                         "target": _ref(report.get("target")), "checks": counts,
                         "scope": report.get("scope") if isinstance(report.get("scope"), str) else "Scope unavailable",
                         "user_confirmed_fix": isinstance(fix, dict) and fix.get("source") == "user_confirmation" and bool(_when(fix.get("confirmed_at")))})
        rows.sort(key=lambda row: _when(row["created_at"]), reverse=True)
        return {"status": "available", "reason": None, "items": rows[:20], "total": len(rows), "scope": scope}
    except (HTTPException, RuntimeError, ValueError, TypeError, KeyError) as exc:
        # Keep the registry usable when the account's encrypted history cannot
        # be read. Do not turn the error into a claim that no reports exist.
        return {"status": "unavailable", "reason": "Saved diagnostic history could not be read. Existing records were retained.",
                "items": [], "total": None, "scope": scope}


def details(user: str, ident: str):
    with LOCK:
        registry = devices.inventory()
        indexed = {d["id"]: d for d in registry["devices"]}
        if ident not in indexed:
            raise HTTPException(404, "Device is no longer registered. No matching name was substituted.")
        device = indexed[ident]
        data = _metadata()
        rows = [{**row, "target": _ref(indexed.get(row["target_id"])),
                 "availability": "registered" if row["target_id"] in indexed else "missing"}
                for row in _relations(data.get(ident, {}))]
        incoming = []
        for source_id, entry in data.items():
            for row in _relations(entry):
                if row["target_id"] == ident:
                    incoming.append({**row, "source_id": source_id, "source": _ref(indexed.get(source_id)),
                                     "availability": "registered" if source_id in indexed else "missing"})
        now = datetime.now(timezone.utc)
        from intelligence.power_history import view as power_view
        return {"ok": True, "protocol": PROTOCOL, "actions_performed": False, "checked_at": now.isoformat(),
                "host": registry["node"], "device": copy.deepcopy(device), "relationships": rows,
                "depended_on_by": incoming[:40], "incoming_total": len(incoming), "observed": _observed(device, now),
                "power_history": power_view(device),
                "timeline": _timeline(user, device, registry["node"]),
                "scope": "Names, rooms, importance and relationships are shared host settings entered by users. They do not change device actions or prove a dependency."}


def rooms():
    registry = devices.inventory()
    _metadata()  # Damaged relationships must not be hidden by another view.
    grouped = {}
    for device in registry["devices"]:
        room = device.get("room") or None
        grouped.setdefault(room, []).append(_ref(device))
    keys = sorted(grouped, key=lambda room: (room is None, (room or "").casefold(), room or ""))
    return {"ok": True, "protocol": PROTOCOL, "actions_performed": False, "checked_at": S.now_iso(),
            "host": registry["node"], "rooms": [{"name": room, "devices": grouped[room]} for room in keys],
            "scope": "Rooms are explicitly entered shared labels. Physical location and room occupancy are not detected."}


def save_relationships(user: str, ident: str, expected_revision: str, importance: str, relationships: list):
    try:
        requested = _relations({"importance": importance, "relationships": relationships})
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, "Choose a valid importance and up to eight distinct device relationships.") from exc
    with LOCK:
        registry = devices.inventory()
        available = {device["id"] for device in registry["devices"]}
        if ident not in available:
            raise HTTPException(404, "The selected device is no longer registered.")
        data = _metadata()
        if devices.context_revision(ident, data) != expected_revision:
            raise HTTPException(409, "Device details changed. Your draft was not saved; review the current details.")
        previous = _relations(data.get(ident, {}))
        for row in requested:
            if row["target_id"] == ident:
                raise HTTPException(422, "A device cannot depend on or connect to itself.")
            if row["target_id"] not in available and row not in previous:
                raise HTTPException(409, "A related device is no longer registered. Keep its existing reference or remove it; no name was substituted.")
        candidate = copy.deepcopy(data)
        candidate.setdefault(ident, {}).update({"importance": importance, "relationships": requested})
        # A new dependency may not reach itself through any retained stable ID.
        # Informational 'connected to' edges have no dependency direction.
        graph = {key: [row["target_id"] for row in _relations(entry) if row["relationship"] != "connected_to"]
                 for key, entry in candidate.items()}
        visited, pending = set(), list(graph.get(ident, []))
        while pending:
            other = pending.pop()
            if other == ident:
                raise HTTPException(422, "This relationship would create a dependency cycle. Review the selected devices.")
            if other not in visited:
                visited.add(other)
                pending.extend(graph.get(other, []))
        devices.update(ident, {"importance": importance, "relationships": requested}, expected_revision)
        return details(user, ident)
