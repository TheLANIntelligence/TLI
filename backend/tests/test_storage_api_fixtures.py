"""Actual authenticated ASGI envelopes from a synthetic read-only worker."""
import copy
import hashlib
import json
import os
from pathlib import Path
import threading

from fastapi.testclient import TestClient

import storage_jobs as jobs
import tli_state as S


def test_authenticated_api_envelopes_and_observation_host(app, monkeypatch):
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "_requests", {})
    monkeypatch.setattr(jobs, "_active", None)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    from intelligence import data_health, storage_history
    monkeypatch.setattr(data_health, "_host", lambda: {"id": "synthetic-host", "name": "Synthetic API fixture"})
    monkeypatch.setattr(storage_history, "_host", data_health._host)
    monkeypatch.setattr(storage_history, "_recent", {})
    fixture_root = "C:/Synthetic API fixture"
    meta = {"root": fixture_root, "partial": True, "denied": 1, "entries_seen": 2, "files": 2,
            "seconds": .01, "folder_summary": [], "direct_file_bytes": 3,
            "scan_filters": {"max_seconds": 15, "max_entries": 50000, "max_depth": 18,
                             "excluded_names": ["AppData", "node_modules"], "follow_links": False}}
    payloads = {
        "scan": {"tree": {"name": "Synthetic API fixture", "path": fixture_root, "size": 3,
                    "size_known": True, "size_partial": True, "size_reason": "incomplete_coverage", "children": [
                        {"name": "unreadable.bin", "path": fixture_root + "/unreadable.bin", "size": 0,
                         "size_known": False, "size_partial": True, "size_reason": "unreadable"},
                        {"name": "example.txt", "path": fixture_root + "/example.txt", "size": 3,
                         "size_known": True, "size_partial": False, "size_reason": None}]}, "largest": [], "meta": meta},
        "large_files": {"files": [{"name": "large.bin", "path": fixture_root + "/large.bin", "size": 1048576}],
                        "meta": {**meta, "partial": False, "denied": 0, "found": 1, "returned": 1, "total_bytes": 1048576}},
        "duplicates": {"groups": [{"size": 8192, "count": 2, "wasted_bytes": 8192, "verified": True,
                                    "paths": [fixture_root + "/copy-a.bin", fixture_root + "/copy-b.bin"]}],
                       "meta": {**meta, "partial": False, "denied": 0, "verification": "full_sha256", "files_hashed": 2}},
        "common_folders": {"os": "Windows", "targets": [{"path": fixture_root + "/Downloads", "label": "Downloads",
                           "safety": "manual", "tip": "Review individual files", "how": "Review", "exists": True,
                           "size_bytes": 3, "size_mb": 0, "size_partial": True, "size_meta": {"partial": True, "denied": 1}}],
                           "protected_prefixes": [], "meta": {"partial": True, "scope": "host_common_folders"}},
    }
    entered, cancel_mode = threading.Event(), [False]
    def worker(request, cancel, progress, authorized, *, inventory=None):
        assert authorized()
        entered.set()
        if cancel_mode[0]: assert cancel.wait(3)
        body = copy.deepcopy(payloads[request["operation"]])
        if cancel_mode[0]: body["meta"].update(partial=True, cancelled=True)
        unknown = {"status": "unknown", "fingerprint": None, "detail": "Synthetic identity"}
        return {"type": "result", "result": body, "identity": {"before": unknown, "after": unknown}, "worker_stopped": True}
    monkeypatch.setattr(jobs.process, "run", worker)
    token = S.create_session_token("fixture-owner")
    client = TestClient(app, raise_server_exceptions=False)
    client.cookies.set("tli_session", token)
    fixtures = {}
    for operation in ["scan", "large_files", "duplicates", "common_folders", "cancelled"]:
        actual = "scan" if operation == "cancelled" else operation
        cancel_mode[0] = operation == "cancelled"; entered.clear()
        body = {"operation": actual, "path": fixture_root, "profile": "quick", "include_excluded": False, "request_id": operation}
        start = client.post("/visualizer/jobs", json=body)
        assert start.status_code == 200, start.text
        ident = start.json()["job"]["id"]
        assert entered.wait(3)
        if cancel_mode[0]:
            assert client.post(f"/visualizer/jobs/{ident}/cancel").status_code == 200
        assert jobs._jobs[ident]["done"].wait(3)
        state = client.get(f"/visualizer/jobs/{ident}")
        returned = client.get(f"/visualizer/jobs/{ident}/results")
        assert state.status_code == returned.status_code == 200
        assert state.headers["cache-control"] == returned.headers["cache-control"] == "no-store"
        assert returned.json()["job"]["host"] == {"id": "synthetic-host", "name": "Synthetic API fixture"}
        assert returned.json()["job"]["status"] == ("cancelled" if cancel_mode[0] else "partial" if returned.json()["result"]["meta"]["partial"] else "completed")
        fixtures[operation] = {"request": body, "start": start.json(), "status": state.json(), "results": returned.json()}
    assert all("result" not in row["status"] for row in fixtures.values())
    # Revocation clears cached payloads immediately and the real cookie fails.
    jobs.revoke_browser_session(token)
    S.revoke_session_token(token)
    assert not jobs._jobs and not jobs._requests
    assert client.get(f"/visualizer/jobs/{ident}/results").status_code == 401
    output = os.environ.get("TLI_STORAGE_API_FIXTURE_OUTPUT")
    if output:
        folder = Path(output); folder.mkdir(parents=True, exist_ok=True)
        record = {"synthetic": True, "authentication": "real isolated browser session cookie; no dependency override",
                  "worker": "synthetic response stub; no host filesystem scan", "fixtures": fixtures}
        target = folder / "envelopes.json"
        target.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
        backend = Path(__file__).resolve().parents[1]
        sources = {name: hashlib.sha256((backend / name).read_bytes()).hexdigest() for name in
                   ["storage_jobs.py", "storage_scan_worker.py", "storage_scan_algorithms.py", "storage_scan_process.py",
                    "routers/visualizer.py", "intelligence/storage_history.py", "tests/test_storage_api_fixtures.py"]}
        (folder / "provenance.json").write_text(json.dumps({"source_sha256": sources,
            "envelopes_sha256": hashlib.sha256(target.read_bytes()).hexdigest()}, indent=2), encoding="utf-8")
