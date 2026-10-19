"""Inventory integration uses only controlled temporary folders and owned workers."""
import io
import json
from pathlib import Path
import threading
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import storage_jobs as jobs
import storage_scan_process as transport
import tli_state as S
from intelligence import storage_diagnosis, storage_history
from storage_inventory import InventoryLimit, InventoryNotFound
from storage_scan_worker import PROFILES, canonical


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "_requests", {})
    monkeypatch.setattr(jobs, "_inventory_stores", {})
    monkeypatch.setattr(jobs, "_active", None)
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(storage_history, "_recent", {})
    token = S.create_session_token("inventory-owner")
    owner = jobs.Access("inventory-owner", "browser", token)
    root = tmp_path / "controlled"
    root.mkdir()
    (root / "empty").mkdir()
    (root / "first.bin").write_bytes(b"fixture" * 200)
    (root / "second.txt").write_bytes(b"text")
    yield owner, root
    jobs.shutdown()


def scan(owner, root, request_id="fixture"):
    started = jobs.start(owner, {"operation": "scan", "path": str(root), "profile": "deep",
                                 "include_excluded": False, "request_id": request_id})
    ident = started["job"]["id"]
    assert jobs._jobs[ident]["done"].wait(20)
    return ident, jobs.results(owner, ident)["result"]


def test_real_worker_index_empty_directory_and_observation_only_explanation(isolated):
    owner, root = isolated
    ident, result = scan(owner, root)
    index = result["meta"]["inventory"]
    assert index["version"] == 1 and index["available"]
    assert index["indexed_count"] == 4 and index["acquisition_complete"]
    assert not index["atomic_snapshot"]
    assert result["meta"]["scanner"]["engine"] == "scandir"
    assert result["meta"]["scanner"]["fallback_reason"]
    page = jobs.inventory_query(owner, ident, sort="name", order="asc", limit=2)
    assert len(page["items"]) == 2 and page["total"] == 3 and page["has_more"]
    assert page["items"][0]["child_count"] == 0 and page["items"][0]["children_complete"]
    assert page["items"][0]["children_state"] == "empty"
    tail = jobs.inventory_query(owner, ident, sort="name", order="asc", offset=2, limit=2)
    assert len(tail["items"]) == 1 and not tail["has_more"]
    # Exercise an indexed selection outside the retained map, after the live
    # path has disappeared. Explanation must use the observation, never stat it.
    jobs._jobs[ident]["result"]["tree"]["children"] = []
    (root / "first.bin").unlink()
    answer = storage_diagnosis.investigate(owner, ident, selected_path=str(root / "first.bin"))
    assert answer["evidence"]["selection"]["source"] == "indexed_inventory_v1"
    assert answer["evidence"]["selection"]["logical_bytes"] == 1400
    assert "indexed observation" in answer["reply"]
    assert (root / "second.txt").read_bytes() == b"text"


def test_index_route_auth_ownership_bounds_and_expiry(isolated, app):
    owner, root = isolated
    ident, _ = scan(owner, root)
    client = TestClient(app)
    route = f"/visualizer/jobs/{ident}/inventory"
    assert client.get(route).status_code in {401, 403}
    client.cookies.set("tli_session", owner.credential)
    response = client.get(route, params={"mode": "extension", "extension": ".txt"})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json()["items"][0]["name"] == "second.txt"
    assert response.json()["job_id"] == ident and response.json()["version"] == 1
    for params in ({"limit": 201}, {"offset": -1}, {"sort": "name;drop"}, {"mode": "delete"}):
        assert client.get(route, params=params).status_code == 422
    outside = client.get(route, params={"mode": "item", "path": str(root.parent / "outside")})
    assert outside.status_code == 422
    other = S.create_session_token("another-owner")
    client.cookies.set("tli_session", other)
    assert client.get(route).status_code == 404
    client.cookies.set("tli_session", owner.credential)
    jobs._jobs[ident]["expiry"] = 0
    assert client.get(route).status_code == 404
    with pytest.raises(InventoryNotFound):
        jobs._inventory_store().query(owner.key, ident)


def test_revocation_deletes_index_and_prevents_new_session_reuse(isolated):
    owner, root = isolated
    ident, _ = scan(owner, root)
    jobs.revoke_browser_session(owner.credential)
    with pytest.raises(HTTPException) as failure:
        jobs.inventory_query(owner, ident)
    assert failure.value.status_code == 404
    assert not list((Path(S.DATA_DIR) / "storage_indexes").rglob("*.sqlite"))


def test_index_disk_failure_keeps_tree_but_never_claims_inventory(isolated, monkeypatch):
    from storage_inventory import InventoryWriter
    owner, root = isolated
    def full(*args, **kwargs):
        raise InventoryLimit("controlled disk quota")
    monkeypatch.setattr(InventoryWriter, "add_rows", full)
    ident, result = scan(owner, root)
    assert result["tree"]["size"] == 1404
    assert result["meta"]["inventory"]["available"] is False
    assert result["meta"]["inventory"]["reason"] == "InventoryLimit"
    assert not list((Path(S.DATA_DIR) / "storage_indexes").rglob("*.building"))
    with pytest.raises(HTTPException):
        jobs.inventory_query(owner, ident)


def test_cancellation_discards_unpublished_index(isolated, monkeypatch):
    owner, root = isolated
    entered = threading.Event()
    def worker(req, cancel, progress, authorized, *, inventory):
        inventory({"type": "inventory_start", "root": str(root)})
        inventory({"type": "inventory_rows", "rows": [{"path": str(root / "seen.bin"), "kind": "file", "size": 3}]})
        entered.set()
        assert cancel.wait(3)
        return {"type": "cancelled", "worker_stopped": True}
    monkeypatch.setattr(transport, "run", worker)
    started = jobs.start(owner, {"operation": "scan", "path": str(root), "profile": "quick", "request_id": "cancel"})
    ident = started["job"]["id"]
    assert entered.wait(3)
    jobs.cancel(owner, ident)
    assert jobs._jobs[ident]["done"].wait(3)
    assert jobs._jobs[ident]["worker_stopped"] and jobs._jobs[ident]["status"] == "cancelled"
    assert not list((Path(S.DATA_DIR) / "storage_indexes").rglob("*.building"))
    assert not list((Path(S.DATA_DIR) / "storage_indexes").rglob("*.sqlite"))


def test_retained_history_matches_filesystem_identity_across_rename():
    row = {"path": "before.txt", "bytes": 4, "logical_size": 4, "file_identity": "volume:42",
           "volume_identity": "volume", "created_at": "2026-01-01"}
    old = {"files": [row], "file_coverage": {"complete": True}}
    new = {"files": [{**row, "path": "after.txt", "bytes": 8, "logical_size": 8}], "file_coverage": {"complete": True}}
    result = storage_history._compare_files(old, new)
    assert len(result["files"]) == 1
    assert result["files"][0]["status"] == "same_identity_different_path"
    assert result["files"][0]["delta_bytes"] == 4
    new["files"][0].update(path="before.txt", file_identity="volume:43")
    assert storage_history._compare_files(old, new)["files"][0]["status"] == "different_identity_at_path"


def test_two_retained_job_indexes_supply_matching_identity_history(isolated):
    owner, root = isolated
    first, before = scan(owner, root, "history-before")
    (root / "second.txt").rename(root / "renamed.txt")
    second, after = scan(owner, root, "history-after")
    result = jobs.inventory_comparison(owner, before["meta"]["saved_scan"]["scan_id"], after["meta"]["saved_scan"]["scan_id"])
    assert result["available"] and not result["complete"]
    assert result["comparison_scope"] == "matched_file_identities"
    assert any(row["path"].endswith("renamed.txt") for row in result["changes"])
    assert not result["folder_deltas_supported"] and not result["added_removed_supported"]
    jobs._jobs[first]["expiry"] = 0
    unavailable = jobs.inventory_comparison(owner, before["meta"]["saved_scan"]["scan_id"], after["meta"]["saved_scan"]["scan_id"])
    assert unavailable["available"] is False


def test_inventory_transport_bounds_and_native_progress(monkeypatch):
    class Child:
        def __init__(self, wire):
            self.stdout, self.stdin = io.BytesIO(wire), io.BytesIO()
            self.returncode, self.polls = None, 0
        def poll(self):
            self.polls += 1
            if self.polls > 1:
                self.returncode = 0
            return self.returncode
        def wait(self): return self.returncode
        def kill(self): self.returncode = -9
    request = {"operation": "scan", "path": "C:/fixture", "profile": "quick", "limits": PROFILES["quick"], "inventory_version": 1}
    frames = [{"type": "inventory_start", "root": "C:/fixture"},
              {"type": "inventory_rows", "rows": [{"path": "C:/fixture", "kind": "directory"}]},
              {"type": "progress", "progress": {"phase": "native", "bytes_read": 10**9, "records_examined": 12345}},
              {"type": "result", "result": {}}]
    def run(values):
        child = Child(b"".join(canonical(frame) + b"\n" for frame in values))
        monkeypatch.setattr(transport, "launch", lambda: (child, None))
        seen, progress = [], []
        result = transport.run(request, threading.Event(), progress.append, lambda: True, inventory=seen.append)
        return result, seen, progress
    result, seen, progress = run(frames)
    assert result["type"] == "result" and len(seen) == 2
    assert progress[0]["bytes_read"] == 10**9 and "entries_seen" not in progress[0]
    for bad in ([frames[1], frames[-1]], [frames[0], frames[0], frames[-1]],
                [frames[0], {"type": "inventory_rows", "rows": [{}] * 129}, frames[-1]]):
        result, _, _ = run(bad)
        assert result["type"] == "error" and result["worker_stopped"]


def test_transport_waits_for_last_index_batch_after_child_exit(monkeypatch):
    wire = b"".join(canonical(frame) + b"\n" for frame in [
        {"type": "inventory_start", "root": "C:/fixture"},
        {"type": "inventory_rows", "rows": [{"path": "C:/fixture", "kind": "directory"}]},
        {"type": "result", "result": {}}])
    class Child:
        stdout, stdin = io.BytesIO(wire), io.BytesIO()
        returncode = 0
        def poll(self): return 0
        def wait(self): return 0
    monkeypatch.setattr(transport, "launch", lambda: (Child(), None))
    persisted = []
    def inventory(frame):
        if frame["type"] == "inventory_rows":
            time.sleep(2.15)  # Exceeds the former unconditional two-second drain.
            persisted.extend(frame["rows"])
    request = {"operation": "scan", "path": "C:/fixture", "profile": "quick", "limits": PROFILES["quick"], "inventory_version": 1}
    result = transport.run(request, threading.Event(), lambda _: None, lambda: True, inventory=inventory)
    assert result["type"] == "result" and result["worker_stopped"] and len(persisted) == 1


def test_unsupported_index_rows_cannot_be_explained_as_files(isolated, monkeypatch):
    owner, root = isolated
    ident, result = scan(owner, root)
    monkeypatch.setattr(jobs, "inventory_query", lambda *args, **kwargs: {
        "items": [{"kind": "link", "path": str(root / "link"), "size_known": False}], "meta": {}})
    with pytest.raises(HTTPException) as failure:
        storage_diagnosis.investigate(owner, ident, selected_path=str(root / "link"))
    assert failure.value.status_code == 422
