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
MAX_FILES = 500
MAX_FILE_SUMMARY_BYTES = 24 * 1024
MAX_SETTINGS_BYTES = 4096
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


def _capacity_valid(value):
    return (isinstance(value, dict) and all(_natural(value.get(key)) for key in ("total", "used", "free"))
            and value["used"] <= value["total"] and value["free"] <= value["total"]
            and type(value.get("root_is_volume")) is bool)


def _file_valid(row):
    if not isinstance(row, dict) or not isinstance(row.get("path"), str):
        return False
    path = row["path"].replace("\\", "/")
    # Summary paths are relative evidence, never fresh filesystem authority.
    if not path or len(path) > 4096 or path.startswith("/") or ":" in path or any(part in ("", ".", "..") for part in path.split("/")):
        return False
    if not _natural(row.get("bytes")) or ("logical_size" in row and not _natural(row["logical_size"])):
        return False
    if row.get("allocated_size") is not None and not _natural(row["allocated_size"]):
        return False
    if "hardlink_duplicate" in row and type(row["hardlink_duplicate"]) is not bool:
        return False
    if any(row.get(key) is not None and (not isinstance(row[key], str) or len(row[key]) > 128) for key in ("extension", "category")):
        return False
    if any(row.get(key) is not None and (not isinstance(row[key], str) or not 0 < len(row[key]) <= 160) for key in ("file_identity", "volume_identity")):
        return False
    return all(row.get(key) is None or isinstance(row[key], (str, int, float)) and not isinstance(row[key], bool)
               for key in ("modified_at", "created_at"))


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
    # Optional fields extend v1 without rewriting or invalidating legacy scans.
    if snapshot.get("capacity") is not None and not _capacity_valid(snapshot["capacity"]):
        return False
    if snapshot.get("allocated_bytes") is not None and not _natural(snapshot["allocated_bytes"]):
        return False
    if "accounting" in snapshot and (not isinstance(snapshot["accounting"], dict)
            or not all(_natural(snapshot["accounting"].get(key)) for key in ("hardlinks_skipped", "identity_unknown"))):
        return False
    if "files" in snapshot:
        files, file_coverage = snapshot["files"], snapshot.get("file_coverage")
        if not isinstance(files, list) or len(files) > MAX_FILES or not all(_file_valid(row) for row in files):
            return False
        if len({os.path.normcase(row["path"].replace("\\", "/")) for row in files}) != len(files):
            return False
        if not isinstance(file_coverage, dict) or type(file_coverage.get("complete")) is not bool or file_coverage.get("stored") != len(files):
            return False
        if file_coverage["complete"] and not coverage["complete"]:
            return False
        if file_coverage["complete"] and sum(row["bytes"] for row in files) != snapshot["total_bytes"]:
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
    return copy.deepcopy({key: value for key, value in snapshot.items() if key not in ("folders", "files") or folders})


def _capture_details(snapshot, tree, meta):
    snapshot["accounting"] = {key: meta.get(key, 0) for key in ("hardlinks_skipped", "identity_unknown")}
    scanner = meta.get("scanner")
    if isinstance(scanner, dict):
        snapshot["acquisition"] = {key: scanner[key] for key in ("engine", "mft", "fallback_reason", "observation_semantics") if key in scanner}
    inventory = meta.get("inventory")
    if isinstance(inventory, dict):
        snapshot["indexed_evidence"] = {key: inventory[key] for key in (
            "version", "available", "indexed_count", "acquisition_complete", "accounting", "expires_at", "atomic_snapshot") if key in inventory}
        snapshot["indexed_evidence"]["retention"] = "Full indexed paths expire with the source session/job; this saved summary does not preserve them."
    capacity = meta.get("capacity")
    if _capacity_valid(capacity):
        snapshot["capacity"] = {key: capacity[key] for key in ("total", "used", "free", "root_is_volume")}
    if _natural(tree.get("allocated_size")):
        snapshot["allocated_bytes"] = tree["allocated_size"]
    source = meta.get("file_summary")
    if not isinstance(source, list):
        return
    # Keep only bounded scanner evidence. Never retain an entire large inventory.
    files, used, invalid = [], 0, False
    for source_row in source[:MAX_FILES]:
        if not _file_valid(source_row) or source_row.get("size_known") is False:
            invalid = True
            continue
        row = {key: source_row[key] for key in ("path", "bytes", "logical_size", "allocated_size", "modified_at", "created_at", "extension", "category", "hardlink_duplicate", "file_identity", "volume_identity") if key in source_row}
        size = len(json.dumps(row, ensure_ascii=False).encode("utf-8"))
        if used + size > MAX_FILE_SUMMARY_BYTES:
            break
        used += size
        files.append(row)
    complete = (meta.get("file_summary_complete") is True and len(files) == len(source)
                and not invalid and snapshot["coverage"]["complete"]
                and sum(row["bytes"] for row in files) == snapshot["total_bytes"])
    snapshot.update(files=files, file_coverage={"complete": complete, "stored": len(files),
        "reason": "All scanned files are represented." if complete else
        "Only a bounded selection of observed files is retained; absence does not establish creation or removal."})


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
                         ("time_limited", "Time limit reached"), ("summary_limited", "Immediate-folder summary limit reached"),
                         ("identity_unknown", "File identities unavailable; hard-link accounting is incomplete")):
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
    _capture_details(snapshot, tree, meta)
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


def _retention(user):
    default = {"max_snapshots": MAX_SNAPSHOTS, "max_age_days": 0, "auto_prune": False}
    path = store.private_path(user, "storage_history_settings", create=False)
    try:
        if path.stat().st_size > MAX_SETTINGS_BYTES:
            raise ValueError("Retention settings exceed their read limit")
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as error:
        raise HTTPException(503, "Storage retention settings are unavailable. Existing history was preserved.") from error
    try:
        settings = store.read_private(user, "storage_history_settings", {})
        if not _valid_retention(settings):
            raise ValueError("Unsupported retention settings")
        return settings
    except Exception as error:
        raise HTTPException(503, "Storage retention settings are unavailable. Existing history was preserved.") from error


def _valid_retention(settings):
    return (isinstance(settings, dict) and set(settings) == {"max_snapshots", "max_age_days", "auto_prune"}
            and type(settings["max_snapshots"]) is int and 1 <= settings["max_snapshots"] <= MAX_SNAPSHOTS
            and type(settings["max_age_days"]) is int and 0 <= settings["max_age_days"] <= 3650
            and type(settings["auto_prune"]) is bool)


def retention(user):
    with store.LOCK:
        return {"ok": True, "protocol": PROTOCOL, **_retention(user), "hard_limit": MAX_SNAPSHOTS,
                "max_store_bytes": MAX_RAW_BYTES}


def configure_retention(user, *, max_snapshots, max_age_days, auto_prune):
    settings = {"max_snapshots": max_snapshots, "max_age_days": max_age_days, "auto_prune": auto_prune}
    if not _valid_retention(settings):
        raise HTTPException(422, "Choose 1–20 snapshots, 0–3650 retention days (0 keeps all ages), and an explicit automatic-maintenance preference.")
    with store.LOCK:
        _retention(user)  # Preserve malformed settings instead of replacing them.
        _load(user)
        store.write_private(user, "storage_history_settings", settings)
        if _retention(user) != settings:
            raise HTTPException(503, "Storage retention settings could not be confirmed.")
        return {**retention(user), "message": "Settings saved. Maintenance removes saved summaries only; observed files are never changed."}


def _pruned(saved, policy):
    ordered = sorted(saved, key=lambda row: datetime.fromisoformat(row["scanned_at"].replace("Z", "+00:00")), reverse=True)
    if policy["max_age_days"]:
        cutoff = time.time() - policy["max_age_days"] * 86400
        ordered = [row for row in ordered if datetime.fromisoformat(row["scanned_at"].replace("Z", "+00:00")).timestamp() >= cutoff]
    return ordered[:policy["max_snapshots"]]


def maintain(user):
    """Explicit bounded maintenance touches only this owner's encrypted summaries."""
    with store.LOCK:
        saved = _load(user)
        remaining = _pruned(saved, _retention(user))
        removed = [row["id"] for row in saved if row["id"] not in {item["id"] for item in remaining}]
        if removed:
            store.write_private(user, "storage_history", remaining)
            if _load(user) != remaining:
                raise HTTPException(503, "Storage history maintenance could not be confirmed. Reload history before trying again.")
        return {"ok": True, "protocol": PROTOCOL, "removed_count": len(removed), "removed_ids": removed,
                "remaining_count": len(remaining), "message": "Only saved scan summaries were removed. No scanned files were changed."}


def save(user, ident):
    with store.LOCK:
        saved = _load(user)
        existing = next((row for row in saved if row["id"] == ident), None)
        if existing:
            return {"ok": True, "protocol": PROTOCOL, "saved": True, "snapshot": _public(existing)}
        snapshot = copy.deepcopy(_current(user, ident))
        policy = _retention(user)
        if len(saved) >= policy["max_snapshots"] and not policy["auto_prune"]:
            raise HTTPException(409, "Saved scan summaries reached the configured retention limit. Remove a summary or explicitly configure automatic maintenance; existing history was not replaced.")
        snapshot["saved_at"] = S.now_iso()
        candidate = [snapshot, *saved]
        if policy["auto_prune"]:
            candidate = _pruned(candidate, policy)
            if snapshot not in candidate:
                raise HTTPException(409, "This observation falls outside the configured retention period. Existing history was preserved.")
        if len(json.dumps(candidate, ensure_ascii=False).encode()) > MAX_RAW_BYTES:
            raise HTTPException(409, "Saved storage history reached its size limit. Existing summaries were preserved.")
        store.write_private(user, "storage_history", candidate)
        confirmed = _load(user)
        if not any(row == snapshot for row in confirmed):
            raise HTTPException(503, "The saved scan could not be confirmed. Reload saved scans before another request.")
        result = {"ok": True, "protocol": PROTOCOL, "saved": True, "snapshot": _public(snapshot)}
        removed = [row["id"] for row in saved if row["id"] not in {item["id"] for item in confirmed}]
        if removed:
            result["removed_ids"] = removed
        return result


def history(user):
    with store.LOCK:
        policy = _retention(user)
        return {"ok": True, "protocol": PROTOCOL, "limit": policy["max_snapshots"], "retention": policy,
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
        saved = _load(user)
        baseline = next((row for row in saved if row["id"] == baseline_id), None)
        if not baseline:
            raise HTTPException(404, "The selected saved scan is unavailable for this account.")
        current = next((row for row in saved if row["id"] == current_id), None)
        if current is None:
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
        capacity_comparable = not reasons
        if not baseline["coverage"]["complete"] or not current["coverage"]["complete"]:
            reasons.append("Coverage is incomplete. Whole-tree growth or shrinkage cannot be established from these scans.")
        result = {"ok": True, "protocol": PROTOCOL, "comparable": not reasons, "reasons": reasons,
                  "baseline": _public(baseline), "current": _public(current), "point_in_time": True,
                  "totals": None, "folders": [], "files": [],
                  "folder_comparison": {"available": False, "reason": "Comparable folder totals are unavailable."},
                  "file_comparison": {"available": False, "complete": False, "reason": "Comparable file evidence is unavailable."},
                  "capacity": _compare_capacity(baseline, current, not reasons, capacity_comparable),
                  "message": "These are saved observations, not a live drive check. No files were changed."}
        if reasons:
            # Full-tree coverage does not erase size observations for paths
            # retained in both scans. No absent-path inference or total follows.
            identity_unknown = any(snapshot.get("accounting", {}).get("identity_unknown")
                                   or any("File identities unavailable" in reason for reason in snapshot["coverage"]["reasons"])
                                   for snapshot in (baseline, current))
            if capacity_comparable and not identity_unknown:
                result.update(_compare_files(baseline, current, partial=True))
                if result["file_comparison"]["available"]:
                    result["message"] += " Retained matching paths can show recorded logical-size changes even though full-tree growth is unconfirmed."
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
        aliases = any(snapshot.get("accounting", {}).get("hardlinks_skipped", 0) for snapshot in (baseline, current))
        if aliases:
            reason = "Hard-linked bytes are assigned to the first observed path. Directory traversal order can move that assignment between folders without changing files; folder and direct-file bucket deltas are withheld."
            result.update(folders=[], folders_limited=False, folder_comparison={"available": False, "reason": reason})
            result["totals"].update(direct_file_delta_bytes=None, direct_file_delta_available=False)
            result["message"] += " " + reason
        else:
            result["folder_comparison"] = {"available": True, "reason": "Immediate-folder observations use matching complete scan policies."}
        result.update(_compare_files(baseline, current))
        return result


def _compare_capacity(baseline, current, comparable, capacity_comparable=True):
    before, after = baseline.get("capacity"), current.get("capacity")
    if not capacity_comparable or not _capacity_valid(before) or not _capacity_valid(after):
        return {"available": False, "explanation": "Comparable volume capacity samples are unavailable; file totals are not a free-space measurement."}
    if before["total"] != after["total"]:
        return {"available": False, "explanation": "Volume capacity changed between scans; free-space and file-growth accounting cannot be reconciled."}
    allocated_before, allocated_after = baseline.get("allocated_bytes"), current.get("allocated_bytes")
    allocated_delta = allocated_after - allocated_before if comparable and _natural(allocated_before) and _natural(allocated_after) else None
    whole_volume = before["root_is_volume"] and after["root_is_volume"]
    reconciled = whole_volume and allocated_delta is not None
    used_delta = after["used"] - before["used"]
    return {"available": True, "before": before, "after": after, "used_delta_bytes": used_delta,
            "free_delta_bytes": after["free"] - before["free"], "free_space_lost_bytes": before["free"] - after["free"],
            "scanned_logical_delta_bytes": current["total_bytes"] - baseline["total_bytes"] if comparable else None,
            "scanned_allocated_delta_bytes": allocated_delta,
            "unexplained_delta_bytes": used_delta - allocated_delta if reconciled else None,
            "basis": "allocated" if reconciled else "unavailable",
            "explanation": ("The remaining difference is unaccounted for by the measured allocated-file change. Filesystem metadata and changes during scanning may contribute; no cause is established."
                            if reconciled else "Logical file sizes and volume capacity use different accounting. An unexplained-byte estimate requires complete whole-volume coverage and known allocated sizes.")}


def _compare_files(baseline, current, *, partial=False):
    if "files" not in baseline or "files" not in current:
        return {"files": [], "file_comparison": {"available": False, "complete": False,
                "reason": "This saved scan predates file tracking; folder totals remain available."}}
    old = {os.path.normcase(row["path"].replace("\\", "/")): row for row in baseline["files"]}
    new = {os.path.normcase(row["path"].replace("\\", "/")): row for row in current["files"]}
    complete = not partial and baseline["file_coverage"]["complete"] and current["file_coverage"]["complete"]
    rows = []
    def identities(paths):
        found = {}
        for path, row in paths.items():
            if row.get("file_identity") and row.get("volume_identity"):
                found.setdefault((row["volume_identity"], row["file_identity"]), []).append(path)
        return found
    old_ids, new_ids = identities(old), identities(new)
    matched = set()
    for identity in old_ids.keys() & new_ids.keys():
        # Multiple aliases in either bounded summary cannot establish which name
        # moved. Never infer a rename from a hash or from same-size contents.
        if len(old_ids[identity]) != 1 or len(new_ids[identity]) != 1:
            continue
        before_path, after_path = old_ids[identity][0], new_ids[identity][0]
        if before_path == after_path or before_path in new or after_path in old:
            continue
        previous, latest = old[before_path], new[after_path]
        if previous.get("created_at") != latest.get("created_at"):
            continue
        before_bytes = previous.get("logical_size", previous["bytes"])
        after_bytes = latest.get("logical_size", latest["bytes"])
        rows.append({"path": latest["path"], "before_path": previous["path"], "after_path": latest["path"],
                     "before_bytes": before_bytes, "after_bytes": after_bytes, "delta_bytes": after_bytes - before_bytes,
                     "status": "same_identity_different_path", "identity_matched": True,
                     "extension": latest.get("extension"), "modified_at": latest.get("modified_at"),
                     "hardlink_duplicate": bool(latest.get("hardlink_duplicate"))})
        matched.update((before_path, after_path))
    paths = old.keys() & new.keys() if partial else old.keys() | new.keys()
    for path in paths:
        if path in matched:
            continue
        old_row, new_row = old.get(path), new.get(path)
        before = old_row.get("logical_size", old_row["bytes"]) if old_row else None
        after = new_row.get("logical_size", new_row["bytes"]) if new_row else None
        delta = after - before if before is not None and after is not None else None
        status = ("added" if complete else "newly_observed") if before is None else ("removed" if complete else "not_observed") if after is None else "grew" if delta > 0 else "shrank" if delta < 0 else "unchanged"
        if old_row and new_row and old_row.get("file_identity") and new_row.get("file_identity") and (
                old_row.get("volume_identity"), old_row["file_identity"]) != (new_row.get("volume_identity"), new_row["file_identity"]):
            status = "different_identity_at_path"
        if status == "unchanged":
            continue
        row = new_row or old_row
        rows.append({"path": row["path"], "before_bytes": before, "after_bytes": after, "delta_bytes": delta,
                     "status": status, "extension": row.get("extension"), "modified_at": row.get("modified_at"),
                     "hardlink_duplicate": bool(row.get("hardlink_duplicate"))})
    rows.sort(key=lambda row: (-(abs(row["delta_bytes"]) if row["delta_bytes"] is not None else row["after_bytes"] or row["before_bytes"] or 0), row["path"]))
    if partial:
        reason = "Matching retained paths can be compared by their recorded logical sizes. Partial coverage prevents complete totals or conclusions about new or removed files; replacement or movement of a file may explain a path change."
    elif complete:
        reason = "Added and removed refer to paths present in one complete observation; a rename or move can look like removal. File deltas are logical sizes and must not be added to folder deltas."
    else:
        reason = "Only retained file paths can be compared. Newly observed or absent paths may have crossed the selection threshold; creation or deletion is not established."
    if old_ids and new_ids:
        reason += " Recorded volume/file identities distinguish a changed name from replacement at a path where possible; identities can be reused, and live observations are not atomic snapshots. Hard-link alias changes do not establish renames."
    return {"files": rows[:MAX_FILES], "files_limited": len(rows) > MAX_FILES,
            "file_comparison": {"available": True, "complete": complete,
                "reason": reason}}
