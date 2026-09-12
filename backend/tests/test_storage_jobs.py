"""Synthetic job/transport checks. Real readers touch only pytest temporary files."""
import copy
import io
import json
import os
from pathlib import Path
import threading

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import storage_jobs as jobs
import storage_scan_algorithms as algorithms
import storage_scan_process as transport
from storage_scan_worker import PROFILES, canonical, validate_request


def request(**changes):
    return {"operation": "large_files", "path": "C:/synthetic", "profile": "quick", "include_excluded": False,
            "request_id": "explicit-request", "min_mb": 100, "limit": 200, **changes}


def result(**changes):
    return {"type": "result", "result": {"files": [], "meta": {"root": "C:/synthetic", "partial": False, **changes}}, "worker_stopped": True}


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "_requests", {})
    monkeypatch.setattr(jobs, "_active", None)
    monkeypatch.setattr(algorithms, "CONTROL", None)
    monkeypatch.setattr(jobs.Access, "valid", lambda self: True)
    yield
    jobs.shutdown()


def settled(owner, body=None):
    reply = jobs.start(owner, body or request())
    ident = reply["job"]["id"]
    assert jobs._jobs[ident]["done"].wait(3)
    return ident, jobs.status(owner, ident)["job"]


@pytest.mark.parametrize("change", [
    {"include_excluded": True}, {"include_excluded": 1}, {"profile": "unbounded"},
    {"path": "x\x00y"}, {"path": "x" * 4097}, {"request_id": "bad id"},
    {"limit": True}, {"limit": 2001}, {"min_mb": float("nan")}, {"operation": "delete"}, {"extra": "ignored"},
])
def test_request_rejects_outside_bounds(change):
    with pytest.raises(ValidationError): jobs.StartRequest(**request(**change))


def test_deep_include_excluded_is_explicit_and_limits_are_fixed():
    body = jobs.StartRequest(**request(profile="deep", include_excluded=True)).model_dump()
    body.pop("request_id")
    validated = validate_request(body)
    assert validated["limits"] == {"max_seconds": 300, "max_entries": 500000, "max_depth": 30}
    assert validated["include_excluded"] is True


def test_idempotency_ownership_conflict_and_generic_host_admission(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def worker(*args):
        calls.append(args[0]); entered.set(); assert release.wait(3); return result()
    monkeypatch.setattr(transport, "run", worker)
    owner, other = jobs.Access("one", "browser", "token1"), jobs.Access("two", "browser", "token2")
    first = jobs.start(owner, request()); assert entered.wait(3)
    try:
        assert jobs.start(owner, request())["job"]["id"] == first["job"]["id"]
        with pytest.raises(HTTPException) as collision: jobs.start(owner, request(limit=201))
        assert collision.value.status_code == 409
        with pytest.raises(HTTPException) as busy: jobs.start(other, request())
        assert busy.value.status_code == 409 and "token1" not in str(busy.value.detail)
        with pytest.raises(HTTPException) as hidden: jobs.status(other, first["job"]["id"])
        assert hidden.value.status_code == 404
        assert len(calls) == 1
    finally:
        release.set(); assert jobs._jobs[first["job"]["id"]]["done"].wait(3)


def test_cancelled_partial_is_available_only_as_explicit_result(monkeypatch):
    entered = threading.Event()
    def worker(req, cancel, progress, auth):
        entered.set(); assert cancel.wait(3); return result(partial=True, cancelled=True)
    monkeypatch.setattr(transport, "run", worker)
    owner = jobs.Access("one", "browser", "one")
    first = jobs.start(owner, request()); ident = first["job"]["id"]; assert entered.wait(3)
    assert "result" not in jobs.status(owner, ident)
    jobs.cancel(owner, ident); assert jobs._jobs[ident]["done"].wait(3)
    status = jobs.status(owner, ident)
    assert status["job"]["status"] == "cancelled" and status["job"]["result_available"]
    assert "result" not in status
    assert jobs.results(owner, ident)["result"]["meta"]["partial"]
    assert jobs._active is None


def test_revoked_session_discards_result_and_new_session_cannot_recover(monkeypatch):
    alive = [True]
    monkeypatch.setattr(jobs.Access, "valid", lambda self: alive[0] or self.credential == "new")
    def worker(*args): alive[0] = False; return result()
    monkeypatch.setattr(transport, "run", worker)
    owner = jobs.Access("same-owner", "browser", "old")
    initial = jobs.start(owner, request()); ident = initial["job"]["id"]
    assert jobs._jobs[ident]["done"].wait(3)
    assert jobs._jobs[ident]["status"] == "cancelled" and jobs._jobs[ident]["result"] is None
    with pytest.raises(HTTPException) as ended: jobs.results(owner, ident)
    assert ended.value.status_code == 401
    with pytest.raises(HTTPException) as hidden: jobs.results(jobs.Access("same-owner", "browser", "new"), ident)
    assert hidden.value.status_code == 404


def test_unconfirmed_stop_never_releases_slot(monkeypatch):
    monkeypatch.setattr(transport, "run", lambda *args: {**result(), "worker_stopped": False})
    owner = jobs.Access("one", "browser", "one")
    ident, state = settled(owner)
    assert state["status"] == "cancelling" and state["error"]["code"] == "stop_unconfirmed"
    assert jobs._active == ident
    with pytest.raises(HTTPException) as busy: jobs.start(owner, request(request_id="second"))
    assert busy.value.status_code == 409


def test_cache_four_results_ttl_and_request_tombstone(monkeypatch):
    monkeypatch.setattr(transport, "run", lambda *args: result())
    owner = jobs.Access("one", "browser", "one")
    ids = [settled(owner, request(request_id=str(i)))[0] for i in range(5)]
    assert len(jobs._jobs) == 4 and ids[0] not in jobs._jobs
    with pytest.raises(HTTPException) as expired: jobs.start(owner, request(request_id="0"))
    assert expired.value.status_code == 410
    jobs._jobs[ids[-1]]["expiry"] = 0
    with pytest.raises(HTTPException) as missing: jobs.status(owner, ids[-1])
    assert missing.value.status_code == 404


def test_metadata_probes_do_not_consume_or_evict_observation_cache(monkeypatch):
    def worker(req, *args):
        return {"type": "result", "worker_stopped": True, "result": {"common": {"home": "C:/synthetic"}}} if req["operation"] == "paths" else result()
    monkeypatch.setattr(transport, "run", worker)
    owner = jobs.Access("one", "browser", "one")
    ids = {settled(owner, request(request_id=str(i)))[0] for i in range(4)}
    assert jobs.sync(owner, "paths") == {"common": {"home": "C:/synthetic"}}
    assert set(jobs._jobs) == ids and len(jobs._requests) == 4


@pytest.mark.parametrize("bad", [
    {"files": [None], "meta": {"partial": False, "root": "x"}},
    {"files": [{"path": "x", "size": -1}], "meta": {"partial": False, "root": "x"}},
    {"files": [], "meta": {"partial": "false", "root": "x"}},
])
def test_invalid_worker_data_cannot_publish(monkeypatch, bad):
    monkeypatch.setattr(transport, "run", lambda *args: {"type": "result", "result": bad, "worker_stopped": True})
    _, state = settled(jobs.Access("one", "browser", "one"))
    assert state["status"] == "failed" and not state["result_available"] and jobs._active is None


class Child:
    def __init__(self, wire, *, blocked=False, code=0):
        self.stdout, self.stdin = io.BytesIO(wire), io.BytesIO()
        self.returncode = None; self.code = code; self.blocked = blocked
        self.polls = 0; self.waits = 0; self.kills = 0
    def poll(self):
        self.polls += 1
        if self.returncode is None and not self.blocked and self.polls > 1: self.returncode = self.code
        return self.returncode
    def kill(self): self.kills += 1; self.returncode = -9
    def wait(self): self.waits += 1; return self.returncode


def run_child(monkeypatch, child, *, cancel=False, auth=True):
    monkeypatch.setattr(transport, "launch", lambda: (child, None))
    stop = threading.Event()
    if cancel: stop.set()
    body = request(); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    return transport.run(body, stop, lambda _: None, lambda: auth, grace=0)


def test_transport_keeps_owned_child_until_killed_and_reaped(monkeypatch):
    child = Child(b"", blocked=True)
    response = run_child(monkeypatch, child, cancel=True)
    assert response["type"] == "cancelled" and response["worker_stopped"]
    assert child.kills == 1 and child.waits >= 1


@pytest.mark.parametrize("wire", [b"not json\n", b'{"type":"result"}',
    b'{"type":"unknown"}\n', canonical(result()) + b"\n" + canonical(result()) + b"\n"])
def test_transport_rejects_malformed_truncated_duplicate_frames(monkeypatch, wire):
    child = Child(wire)
    response = run_child(monkeypatch, child)
    assert response["type"] == "error" and response["worker_stopped"]
    assert child.waits >= 1


def test_transport_resource_exit_is_not_empty_success(monkeypatch):
    response = run_child(monkeypatch, Child(b"", code=0xc0000017))
    assert response["type"] == "error" and response["error"]["code"] == "resource_limit"


def test_transport_discards_final_result_after_revocation(monkeypatch):
    response = run_child(monkeypatch, Child(canonical(result()) + b"\n"), auth=False)
    assert response["type"] == "cancelled" and "result" not in response


def test_cooperative_transport_result_retains_partial_without_killing(monkeypatch):
    child = Child(canonical(result()) + b"\n")
    monkeypatch.setattr(transport, "launch", lambda: (child, None))
    stop = threading.Event(); stop.set()
    body = request(); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    response = transport.run(body, stop, lambda _: None, lambda: True, grace=2)
    assert response["type"] == "result" and response["result"]["meta"]["cancelled"]
    assert response["result"]["meta"]["partial"] and child.kills == 0 and child.waits >= 1


def test_supervisor_thread_failure_reaps_owned_child(monkeypatch):
    child = Child(b"", blocked=True)
    monkeypatch.setattr(transport, "launch", lambda: (child, None))
    def fail(_): raise RuntimeError("synthetic thread failure")
    monkeypatch.setattr(transport.threading.Thread, "start", fail)
    body = request(); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    response = transport.run(body, threading.Event(), lambda _: None, lambda: True)
    assert response["worker_stopped"] and response["type"] == "error" and child.kills == 1 and child.waits >= 1


def test_resource_notification_cannot_publish_final_result(monkeypatch):
    child = Child(canonical(result()) + b"\n")
    class Job:
        def resource_limited(self): return True
        def kill(self): child.kill()
        def confirm_exit(self): assert child.poll() is not None
        def close(self): pass
    monkeypatch.setattr(transport, "launch", lambda: (child, Job()))
    body = request(); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    response = transport.run(body, threading.Event(), lambda _: None, lambda: True, grace=0)
    assert response["type"] == "error" and response["error"]["code"] == "resource_limit" and "result" not in response


def test_transport_byte_cap_rejects_oversized_frame(monkeypatch):
    monkeypatch.setattr(transport, "MAX_RESULT", 100)
    response = run_child(monkeypatch, Child(b"x" * 101 + b"\n"))
    assert response["type"] == "error" and response["worker_stopped"]


def test_job_confirmation_kills_only_remaining_private_descendants():
    job = object.__new__(transport.WindowsJob)
    counts = iter([1, 1, 0]); calls = []
    job.active_count = lambda: next(counts)
    job.kill = lambda: calls.append("private-job")
    job.confirm_exit()
    assert calls == ["private-job"]


def test_unconfirmed_descendant_exit_cannot_return_worker_stopped(monkeypatch):
    child = Child(canonical(result()) + b"\n")
    closed = []
    class Job:
        def resource_limited(self): return False
        def confirm_exit(self): raise RuntimeError("synthetic unconfirmed descendant")
        def close(self): closed.append(True)
    monkeypatch.setattr(transport, "launch", lambda: (child, Job()))
    body = request(); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    with pytest.raises(RuntimeError, match="unconfirmed descendant"):
        transport.run(body, threading.Event(), lambda _: None, lambda: True)
    assert closed == [True]


@pytest.mark.skipif(os.name != "nt", reason="Windows private Job lifecycle")
def test_actual_private_job_kills_gated_worker_and_confirms_zero():
    # No request/path is sent: the source worker remains at its input gate.
    child, job = transport.launch()
    try:
        job.kill(); child.wait(timeout=5); job.confirm_exit()
        assert job.active_count() == 0
    finally:
        job.close()
        if child.poll() is None: child.kill(); child.wait(timeout=5)
        child.stdin.close(); child.stdout.close()


def test_confirmed_launch_failure_reports_no_surviving_worker(monkeypatch):
    def failed(): raise transport.LaunchStopped("synthetic")
    monkeypatch.setattr(transport, "launch", failed)
    body = request(); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    response = transport.run(body, threading.Event(), lambda _: None, lambda: True)
    assert response["worker_stopped"] and response["error"]["code"] == "worker_start_failed"


def test_actual_source_worker_reads_only_temporary_fixture_and_preserves_bytes(tmp_path):
    sample = tmp_path / "sample.bin"; sample.write_bytes(b"known fixture\x00")
    before = sample.stat()
    body = request(operation="scan", path=str(tmp_path)); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    response = transport.run(body, threading.Event(), lambda _: None, lambda: True)
    assert response["type"] == "result" and response["worker_stopped"]
    assert response["result"]["tree"]["size"] == len(sample.read_bytes()) == 14
    assert sample.stat().st_mtime_ns == before.st_mtime_ns and sample.read_bytes() == b"known fixture\x00"
    assert {p.name for p in tmp_path.iterdir()} == {"sample.bin"}


def test_cancel_algorithms_retains_only_observed_files(tmp_path, monkeypatch):
    for i in range(5): (tmp_path / str(i)).write_bytes(b"123")
    def stop(**progress):
        if progress.get("entries_seen", 0) >= 2: raise algorithms.ScanCancelled()
    monkeypatch.setattr(algorithms, "CONTROL", stop)
    tree, _, meta = algorithms._scan_tree(tmp_path)
    assert tree["size"] == 6 and meta["cancelled"] and meta["partial"]
    files, meta = algorithms._collect_large_files(tmp_path, min_bytes=1, limit=10)
    assert len(files) == 2 and meta["cancelled"] and meta["partial"]


def test_deep_exclusions_and_tree_representation_bound(tmp_path):
    nested = tmp_path / "node_modules"; nested.mkdir(); (nested / "value").write_bytes(b"123")
    for i in range(20): (tmp_path / str(i)).write_bytes(b"12")
    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=5)
    assert tree["size"] == 40 and meta["skipped"] == 1 and meta["representation_limited"]
    assert 1 + len(tree["children"]) <= 5
    full, _, info = algorithms._scan_tree(tmp_path, noisy_names=set())
    assert full["size"] == 43 and info["scan_filters"]["excluded_names"] == []


def test_history_accepts_worker_identity_without_parent_filesystem_probe(monkeypatch, tmp_path):
    from intelligence import storage_history
    monkeypatch.setattr(storage_history, "drive_identity", lambda _: pytest.fail("parent filesystem probe"))
    tree, _, meta = algorithms._scan_tree(tmp_path)
    identity = {"status": "unknown", "fingerprint": None, "detail": "Synthetic"}
    receipt = storage_history.capture("owner", tmp_path, tree, meta, identity, after=identity)
    assert receipt["available"]


def test_unavailable_drive_capacity_keeps_mount_without_zero_claim(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(algorithms, "_psutil", SimpleNamespace(disk_partitions=lambda **kw: [
        SimpleNamespace(mountpoint="X:/SyntheticUnavailable", device="fixture", fstype="fixture", opts="")]))
    monkeypatch.setattr(algorithms, "_safe_disk_usage", lambda *args, **kw: None)
    rows = algorithms._enumerate_drives()
    assert len(rows) == 1 and rows[0]["mountpoint"] == "X:/SyntheticUnavailable"
    assert rows[0]["availability"] == "unavailable" and rows[0]["available"] is False
    assert all(rows[0][field] is None for field in ("total_bytes", "used_bytes", "free_bytes", "percent_used"))


def test_failed_drive_enumeration_retains_unknown_home_fallback(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(algorithms, "_psutil", SimpleNamespace(disk_partitions=lambda **kw: []))
    def unavailable(_): raise OSError("synthetic unavailable")
    monkeypatch.setattr(algorithms.shutil, "disk_usage", unavailable)
    rows = algorithms._enumerate_drives()
    assert len(rows) == 1 and rows[0]["scope"] == "home_fallback"
    assert rows[0]["availability"] == "unavailable" and rows[0]["total_bytes"] is None


@pytest.mark.parametrize("operation", ["scan", "large_files", "duplicates", "path_exists"])
@pytest.mark.parametrize("ancestor", [False, True])
def test_explicit_root_or_ancestor_junction_rejected_before_resolving(tmp_path, monkeypatch, operation, ancestor):
    from storage_scan_worker import perform
    linked = tmp_path / "linked"; linked.mkdir(); nested = linked / "nested"; nested.mkdir()
    monkeypatch.setattr(Path, "is_junction", lambda p: p == linked, raising=False)
    monkeypatch.setattr(Path, "resolve", lambda *a, **kw: pytest.fail("must not erase link identity"))
    body = request(operation=operation, path=str(nested if ancestor else linked)); body.pop("request_id"); body["limits"] = PROFILES["quick"]
    with pytest.raises(algorithms.ScanError) as rejected:
        perform(body, lambda **kw: None)
    assert rejected.value.status_code == 422


def test_actual_root_symlink_is_not_followed(tmp_path):
    target = tmp_path / "target"; target.mkdir(); (target / "private.txt").write_bytes(b"untouched")
    link = tmp_path / "linked"
    try: link.symlink_to(target, target_is_directory=True)
    except OSError: pytest.skip("This test host does not permit symlink creation")
    with pytest.raises(algorithms.ScanError) as rejected: algorithms._resolve_root(str(link))
    assert rejected.value.status_code == 422 and (target / "private.txt").read_bytes() == b"untouched"


def test_common_location_ancestor_link_has_unknown_size_without_measurement(tmp_path, monkeypatch):
    parent = tmp_path / "linked"; parent.mkdir(); location = parent / "Cache"; location.mkdir()
    monkeypatch.setattr(Path, "is_junction", lambda p: p == parent, raising=False)
    monkeypatch.setattr(algorithms.platform, "system", lambda: "Windows")
    monkeypatch.setattr(algorithms, "_cleanup_targets_windows", lambda: [{"path": str(location), "label": "Synthetic", "safety": "manual"}])
    monkeypatch.setattr(algorithms, "_measure_cleanup", lambda *a, **kw: pytest.fail("linked location measured"))
    rows = algorithms.get_cleanup_targets()
    assert rows[0]["exists"] is None and rows[0]["size_partial"] and rows[0]["size_meta"]["denied"] == 1


def test_common_paths_does_not_offer_linked_defaults(tmp_path, monkeypatch):
    (tmp_path / "Downloads").mkdir(); (tmp_path / "Dropbox").mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(Path, "is_junction", lambda p: p.name in {"Downloads", "Dropbox"}, raising=False)
    returned = algorithms.common_paths()
    assert "downloads" not in returned["common"] and not returned["extras"]


def test_linked_drive_mount_is_unavailable_without_capacity_probe(tmp_path, monkeypatch):
    from types import SimpleNamespace
    linked = tmp_path / "linked"; linked.mkdir()
    monkeypatch.setattr(Path, "is_junction", lambda p: p == linked, raising=False)
    monkeypatch.setattr(algorithms, "_psutil", SimpleNamespace(disk_partitions=lambda **kw: [
        SimpleNamespace(mountpoint=str(linked), device="synthetic", fstype="fixture", opts="")]))
    monkeypatch.setattr(algorithms, "_safe_disk_usage", lambda *a, **kw: pytest.fail("linked drive measured"))
    assert algorithms._enumerate_drives()[0]["availability"] == "unavailable"


def test_posix_owned_group_confirmation_uses_only_child_group(monkeypatch):
    from types import SimpleNamespace
    calls, probes = [], [True, True, False]
    def killpg(pgid, sig):
        calls.append((pgid, sig))
        if sig == 0 and not probes.pop(0): raise ProcessLookupError()
    monkeypatch.setattr(transport.os, "killpg", killpg, raising=False)
    group = transport.PosixGroup(); group.assign_and_resume(SimpleNamespace(pid=24680))
    group.confirm_exit()
    assert all(pgid == 24680 for pgid, sig in calls)
    assert any(sig == 9 for pgid, sig in calls)


def test_posix_uncertain_group_probe_fails_closed(monkeypatch):
    from types import SimpleNamespace
    def inaccessible(*args): raise PermissionError("synthetic group ownership query")
    monkeypatch.setattr(transport.os, "killpg", inaccessible, raising=False)
    group = transport.PosixGroup(); group.assign_and_resume(SimpleNamespace(pid=24680))
    with pytest.raises(PermissionError): group.confirm_exit()


def test_all_read_routes_require_auth_before_any_worker(client, monkeypatch):
    from routers.system_routes import require_session
    def reject(): raise HTTPException(401, "locked")
    client.app.dependency_overrides[require_session] = reject
    monkeypatch.setattr(transport, "run", lambda *args: pytest.fail("unauthorized worker"))
    try:
        for endpoint in ["/visualizer/scan", "/visualizer/scan_directory", "/scan_directory", "/visualizer/treemap",
                         "/visualizer/large-files", "/visualizer/duplicates", "/visualizer/cleanup-targets", "/visualizer/drives", "/visualizer/paths", "/visualizer/open_in_files"]:
            assert client.get(endpoint, params={"path": "synthetic"}).status_code == 401
        assert client.post("/visualizer/jobs", json=request()).status_code == 401
    finally:
        client.app.dependency_overrides.pop(require_session, None)


def test_real_job_route_contract_and_no_store(authed_client, monkeypatch):
    monkeypatch.setattr(transport, "run", lambda *args: result())
    created = authed_client.post("/visualizer/jobs", json=request())
    assert created.status_code == 200 and created.headers["cache-control"] == "no-store"
    ident = created.json()["job"]["id"]; assert jobs._jobs[ident]["done"].wait(3)
    state = authed_client.get(f"/visualizer/jobs/{ident}")
    assert state.json()["protocol"] == "storage-jobs-v1" and "result" not in state.json()
    assert state.json()["job"]["status"] == "completed"
    assert authed_client.get(f"/visualizer/jobs/{ident}/results").json()["result"]["files"] == []
    assert authed_client.post(f"/visualizer/jobs/{ident}/cancel").json()["job"]["status"] == "completed"
