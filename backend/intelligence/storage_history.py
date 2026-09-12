"""Explicit, owner-scoped storage observations; comparisons never scan a path."""
from __future__ import annotations

import copy
import ctypes
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid

from fastapi import HTTPException
from intelligence import store
from intelligence.data_health import _host
import tli_state as S

PROTOCOL = "storage-history-v1"
VERSION = 1
MAX_SNAPSHOTS = 20
MAX_FOLDERS = 200
MAX_STORE_BYTES = 2 * 1024 * 1024
MAX_RAW_BYTES = 1024 * 1024
RECENT_SECONDS = 1800
_recent = {}


def drive_identity(root: Path):
    """Identify the observed volume and root, not its editable display label."""
    unknown = {"status": "unknown", "fingerprint": None,
               "detail": "Drive or folder identity could not be confirmed."}
    try:
        info = root.stat()
        if not info.st_ino or not info.st_dev:
            return unknown
        if os.name == "nt":
            mount = ctypes.create_unicode_buffer(32768)
            serial = ctypes.c_ulong()
            kernel = ctypes.windll.kernel32
            if not kernel.GetVolumePathNameW(str(root), mount, len(mount)):
                return unknown
            if not kernel.GetVolumeInformationW(mount.value, None, 0, ctypes.byref(serial), None, None, None, 0) or not serial.value:
                return unknown
            identity = ["windows-volume", serial.value, info.st_ino]
        else:
            identity = ["filesystem", info.st_dev, info.st_ino]
        return {"status": "known", "fingerprint": hashlib.sha256(json.dumps(identity).encode()).hexdigest(),
                "detail": "Volume and folder identity recorded during this scan."}
    except Exception:
        return unknown


def _natural(value):
    return type(value) is int and 0 <= value <= 2**63 - 1


def _valid(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get("version") != VERSION:
        return False
    if any(not isinstance(snapshot.get(field), str) for field in ("id", "root", "scanned_at")):
        return False
    if not re.fullmatch(r"[a-f0-9]{32}", snapshot["id"]) or not snapshot["root"] or len(snapshot["root"]) > 4096:
        return False
    try:
        if datetime.fromisoformat(snapshot["scanned_at"].replace("Z", "+00:00")).tzinfo is None:
            return False
    except ValueError:
        return False
    if not _natural(snapshot.get("total_bytes")) or not _natural(snapshot.get("direct_file_bytes")):
        return False
    host, drive, coverage, filters = (snapshot.get(field) for field in ("host", "drive", "coverage", "filters"))
    if not isinstance(host, dict) or any(not isinstance(host.get(field), str) for field in ("id", "name")):
        return False
    if not isinstance(drive, dict) or drive.get("status") not in ("known", "unknown", "changed"):
        return False
    if drive["status"] == "known" and (not isinstance(drive.get("fingerprint"), str) or not re.fullmatch(r"[a-f0-9]{64}", drive["fingerprint"])):
        return False
    if not isinstance(coverage, dict) or type(coverage.get("complete")) is not bool or not isinstance(coverage.get("reasons"), list):
        return False
    if any(not isinstance(reason, str) for reason in coverage["reasons"]):
        return False
    if coverage["complete"] != (not coverage["reasons"]):
        return False
    if not isinstance(filters, dict) or any(not _natural(filters.get(field)) for field in ("max_depth", "max_entries", "max_seconds")):
        return False
    if filters.get("follow_links") is not False or not isinstance(filters.get("excluded_names"), list):
        return False
    if any(not isinstance(name, str) for name in filters["excluded_names"]):
        return False
    folders = snapshot.get("folders")
    if not isinstance(folders, list) or len(folders) > MAX_FOLDERS:
        return False
    if any(not isinstance(row, dict) or not isinstance(row.get("name"), str) or not row["name"] or
           len(row["name"]) > 1024 or not _natural(row.get("bytes")) for row in folders):
        return False
    return (len({row["name"] for row in folders}) == len(folders) and
            (not coverage["complete"] or sum(row["bytes"] for row in folders) + snapshot["direct_file_bytes"] == snapshot["total_bytes"]))


def _load(user):
    path = store.private_path(user, "storage_history", create=False)
    try:
        if path.stat().st_size > MAX_STORE_BYTES:
            raise HTTPException(503, "Saved storage history exceeds its read limit. Existing data was preserved.")
    except FileNotFoundError:
        return []
    except OSError as error:
        raise HTTPException(503, "Saved storage history is unavailable. Existing data was preserved.") from error
    try:
        data = store.read_private(user, "storage_history", [])
        if len(data) > MAX_SNAPSHOTS or not all(_valid(row) for row in data):
            raise ValueError("Saved storage history has an unsupported structure.")
        if len({row["id"] for row in data}) != len(data):
            raise ValueError("Duplicate saved scan identities.")
        return data
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(503, "Saved storage history is unavailable. Preserve the original file and check Data & Recovery guidance before saving more scans; storage history is not included in the current backup export.") from error


def _public(snapshot, folders=False):
    return copy.deepcopy({key: value for key, value in snapshot.items() if key != "folders" or folders})


def capture(user, root, tree, meta, before, *, after=None):
    """Capture only the actual scanner's bounded aggregates, never request sizes."""
    # A scan child supplies its own post-scan probe; never repeat that potentially
    # blocking filesystem operation in the application process.
    if after is None:
        after = drive_identity(root)
    drive = after if before == after else {"status": "changed", "fingerprint": None,
        "detail": "Drive or folder identity changed or became unavailable during this scan."}
    reasons = []
    for field, label in (("denied", "Unreadable entries"), ("skipped", "Skipped entries"),
                         ("depth_limited", "Depth limit reached"), ("entry_limited", "Entry limit reached"),
                         ("time_limited", "Time limit reached"), ("summary_limited", "Immediate-folder summary limit reached")):
        if meta.get(field):
            reasons.append(label)
    if meta.get("partial") is not False and not reasons:
        reasons.append("Scan coverage was not confirmed complete")
    if "folder_summary" not in meta or "scan_filters" not in meta:
        reasons.append("Folder coverage metadata is unavailable")
    snapshot = {"id": uuid.uuid4().hex, "version": VERSION, "root": str(root), "scanned_at": S.now_iso(),
                "host": _host(), "drive": drive, "coverage": {"complete": not reasons, "reasons": reasons},
                "filters": meta.get("scan_filters", {}), "total_bytes": tree.get("size"),
                "direct_file_bytes": meta.get("direct_file_bytes", 0), "folders": meta.get("folder_summary", [])}
    if not _valid(snapshot):
        return {"protocol": PROTOCOL, "available": False, "reason": "This scan did not provide a complete summary format."}
    with store.LOCK:
        now = time.time()
        for key, recent in list(_recent.items()):
            if recent["expires_at"] <= now:
                del _recent[key]
        if len(_recent) >= 64:
            oldest = min(_recent, key=lambda key: _recent[key]["expires_at"])
            del _recent[oldest]
        _recent[snapshot["id"]] = {"user": user, "snapshot": copy.deepcopy(snapshot), "expires_at": now + RECENT_SECONDS}
    return {"protocol": PROTOCOL, "available": True, "scan_id": snapshot["id"], "version": VERSION,
            "expires_at": now + RECENT_SECONDS, "summary": _public(snapshot)}


def _current(user, ident):
    recent = _recent.get(ident)
    if not recent or recent["user"] != user or recent["expires_at"] <= time.time():
        raise HTTPException(410, "This scan summary expired or is unavailable. Explicitly scan the folder again before saving or comparing.")
    return recent["snapshot"]


def save(user, ident):
    with store.LOCK:
        saved = _load(user)
        existing = next((row for row in saved if row["id"] == ident), None)
        if existing:
            return {"ok": True, "protocol": PROTOCOL, "saved": True, "snapshot": _public(existing)}
        snapshot = copy.deepcopy(_current(user, ident))
        if len(saved) >= MAX_SNAPSHOTS:
            raise HTTPException(409, "Twenty scan summaries are already saved. Remove a selected saved summary to free a slot; existing history was not replaced.")
        snapshot["saved_at"] = S.now_iso()
        candidate = [snapshot, *saved]
        if len(json.dumps(candidate, ensure_ascii=False).encode()) > MAX_RAW_BYTES:
            raise HTTPException(409, "Saved storage history reached its size limit. Existing summaries were preserved.")
        store.write_private(user, "storage_history", candidate)
        confirmed = _load(user)
        if not any(row == snapshot for row in confirmed):
            raise HTTPException(503, "The saved scan could not be confirmed. Reload saved scans before another request.")
        return {"ok": True, "protocol": PROTOCOL, "saved": True, "snapshot": _public(snapshot)}


def history(user):
    with store.LOCK:
        return {"ok": True, "protocol": PROTOCOL, "limit": MAX_SNAPSHOTS,
                "snapshots": [_public(snapshot) for snapshot in _load(user)]}


def remove(user, ident):
    with store.LOCK:
        saved = _load(user)
        if not any(row["id"] == ident for row in saved):
            raise HTTPException(404, "The selected saved scan is unavailable for this account.")
        remaining = [row for row in saved if row["id"] != ident]
        store.write_private(user, "storage_history", remaining)
        if _load(user) != remaining:
            raise HTTPException(503, "Removal of the saved summary was not confirmed. Reload saved scans before trying again.")
        return {"ok": True, "protocol": PROTOCOL, "deleted": True, "snapshot_id": ident}


def compare(user, baseline_id, current_id):
    with store.LOCK:
        baseline = next((row for row in _load(user) if row["id"] == baseline_id), None)
        if not baseline:
            raise HTTPException(404, "The selected saved scan is unavailable for this account.")
        current = _current(user, current_id)
        reasons = []
        if baseline["id"] == current["id"]:
            reasons.append("Choose an earlier saved scan; these are the same observation.")
        elif datetime.fromisoformat(baseline["scanned_at"].replace("Z", "+00:00")) >= datetime.fromisoformat(current["scanned_at"].replace("Z", "+00:00")):
            reasons.append("The saved baseline is not dated before the current scan. Check the host clock or choose an earlier scan.")
        if os.path.normcase(baseline["root"]) != os.path.normcase(current["root"]):
            reasons.append("The folders differ.")
        if baseline["host"]["id"] == "unknown" or baseline["host"]["id"] != current["host"]["id"]:
            reasons.append("The TLI host identity differs or is unknown.")
        if baseline["filters"] != current["filters"]:
            reasons.append("Scan exclusions or coverage limits differ.")
        if baseline["drive"]["status"] != "known" or current["drive"]["status"] != "known":
            reasons.append("Drive or folder identity is unavailable or changed during a scan.")
        elif baseline["drive"]["fingerprint"] != current["drive"]["fingerprint"]:
            reasons.append("Drive or folder identity changed between scans.")
        if not baseline["coverage"]["complete"] or not current["coverage"]["complete"]:
            reasons.append("Coverage is incomplete. Growth or shrinkage cannot be established from these scans.")
        result = {"ok": True, "protocol": PROTOCOL, "comparable": not reasons, "reasons": reasons,
                  "baseline": _public(baseline), "current": _public(current), "point_in_time": True,
                  "totals": None, "folders": [], "message": "These are saved observations, not a live drive check. No files were changed."}
        if reasons:
            return result
        old = {row["name"]: row["bytes"] for row in baseline["folders"]}
        new = {row["name"]: row["bytes"] for row in current["folders"]}
        rows = []
        for name in old.keys() | new.keys():
            before, after = old.get(name), new.get(name)
            delta = after - before if before is not None and after is not None else None
            status = "newly_observed" if before is None else "not_observed" if after is None else "grew" if delta > 0 else "shrank" if delta < 0 else "unchanged"
            if status != "unchanged":
                rows.append({"name": name, "before_bytes": before, "after_bytes": after, "delta_bytes": delta, "status": status})
        rows.sort(key=lambda row: ({"grew": 0, "newly_observed": 1, "shrank": 2, "not_observed": 3}[row["status"]],
                                  -(abs(row["delta_bytes"]) if row["delta_bytes"] is not None else row["after_bytes"] or row["before_bytes"] or 0), row["name"]))
        result.update(totals={"before_bytes": baseline["total_bytes"], "after_bytes": current["total_bytes"],
                              "delta_bytes": current["total_bytes"] - baseline["total_bytes"],
                              "direct_file_delta_bytes": current["direct_file_bytes"] - baseline["direct_file_bytes"]},
                      folders=rows[:MAX_FOLDERS], folders_limited=len(rows) > MAX_FOLDERS)
        return result
