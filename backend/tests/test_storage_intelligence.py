"""Synthetic evidence, ownership and monitoring checks; no household disk scans."""
import copy
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import storage_jobs as jobs
import tli_state as S
from intelligence import storage_diagnosis as diagnosis, storage_monitor as monitor
from intelligence import store


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="fixture", node_name="Fixture", role="standalone", host_address=None))
    monkeypatch.setattr(jobs.Access, "valid", lambda self: True)
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "_requests", {})
    monkeypatch.setattr(jobs, "_active", None)
    monkeypatch.setattr(monitor, "_active", {})
    credential = jobs.Access("local", "local", "")
    return credential


def envelope():
    return {"job": {"id": "a" * 32, "operation": "scan", "status": "completed", "finished_at": "2026-10-07T12:00:00Z", "host": {"id": "fixture"}},
            "result": {"tree": {"size": 1024}, "meta": {"root": "C:/Users/Fixture", "partial": True, "denied": 1, "folder_summary": [{"name": "Downloads", "bytes": 1024}]},
                       "largest": [{"path": "C:/Users/Fixture/Downloads/private.iso", "size": 1024}]}}


@pytest.mark.parametrize("text", ["Why is my C: drive always full?", "What is taking up the most space?", "What grew overnight?", "Find my largest files.", "Is LM Studio taking too much storage?", "Can I safely delete these files?", "What can I clean without breaking Windows?"])
def test_narrow_storage_intents(text):
    assert diagnosis.classify(text)


@pytest.mark.parametrize("text", ["Write a story about a full disk", 'Explain the phrase "what grew overnight"', "What is storage?", "Hello", "delete C:/Windows", "What grew overnight? Also email all my files."])
def test_general_and_composed_requests_do_not_trigger_storage(text):
    assert not diagnosis.classify(text)


def test_diagnosis_preserves_partial_evidence_and_never_promises_recovery(isolated, monkeypatch):
    monkeypatch.setattr(jobs, "results", lambda *a: envelope())
    result = diagnosis.investigate(isolated, "a" * 32)
    assert result["local_only"] and result["evidence"]["logical_bytes"] == 1024
    assert "incomplete" in result["reply"] and "One scan cannot" in result["reply"]
    assert result["recommendations"][0]["classification"] == "requires_review"
    assert "Trash may not free space" in result["reply"]


@pytest.mark.parametrize("path", ["D:/Windows/system.bin", "C:/Users/User/live.sqlite", "C:/Code/node_modules/a.js", "C:/Unknown/critical.xyz", "D:/ProgramData/app/model.gguf"])
def test_cleanup_classification_conservatively_blocks_critical_or_unknown(path):
    assert diagnosis.recommendation({"path": path, "size": 500})["classification"] == "protected"


def test_cleanup_temp_is_review_only():
    row = diagnosis.recommendation({"path": "C:/Users/User/AppData/Local/Temp/file.tmp", "size": 5})
    assert row["classification"] == "generally_safe_to_review" and row["action"] == "review"
    row = diagnosis.recommendation({"path": "C:/$Recycle.Bin/file", "size": 5})
    assert row["action"] == "windows_storage_settings"


def test_real_job_boundary_hides_other_session_evidence(isolated):
    with pytest.raises(HTTPException) as denied:
        diagnosis.investigate(isolated, "b" * 32)
    assert denied.value.status_code == 404


def test_capacity_growth_samples_are_bounded_deduped_and_not_file_attribution(isolated, monkeypatch):
    events = []
    import event_bus
    monkeypatch.setattr(event_bus, "emit_event", lambda *a, **kw: events.append(a))
    monitor.configure(isolated, {"enabled": True, "sample_interval_seconds": 60, "sudden_bytes": 1024**2})
    total = 100 * 1024**2
    monitor.sample("C:/", total, total // 2, total // 2, now=1000)
    monitor.sample("C:/", total, total // 2 + 2 * 1024**2, total // 2 - 2 * 1024**2, now=1060)
    monitor.sample("C:/", total, total // 2 + 3 * 1024**2, total // 2 - 3 * 1024**2, now=1120)
    state = monitor.status(isolated)
    assert len(state["findings"]) == 1 and state["findings"][0]["free_loss_bytes"] == 2 * 1024**2
    assert "cannot identify files" in state["findings"][0]["message"]
    assert len(events) == 1 and "C:/" not in str(events)
    for i in range(400): monitor.sample("C:/", total, 1, total - 1, now=1200 + i * 60)
    assert len(monitor.status(isolated)["samples"]["C:/"]) <= 256


def test_monitor_settings_owner_encryption_and_revocation(isolated, monkeypatch):
    monitor.configure(isolated, {"enabled": True})
    path = store.private_path(isolated.owner, "storage_monitor", create=False)
    assert '"enabled"' not in path.read_text()
    stranger = jobs.Access("other", "local", "")
    assert monitor.status(stranger)["active"] is False
    assert monitor.status(stranger)["settings"]["enabled"] is False
    monkeypatch.setattr(jobs.Access, "valid", lambda self: False)
    monitor.tick()
    assert not monitor._active


def test_schedules_require_reviewed_scope_and_never_save_credentials(isolated, monkeypatch):
    with pytest.raises(HTTPException): monitor.configure(isolated, {"enabled": True, "schedule_enabled": True})
    data = envelope(); data["job"]["result_available"] = True
    monkeypatch.setattr(jobs, "results", lambda *a: data)
    state = monitor.configure(isolated, {"enabled": True, "schedule_enabled": True, "job_id": "a" * 32})
    assert state["schedule_scope"] == "C:/Users/Fixture"
    saved = store.read_private(isolated.owner, "storage_monitor", {})
    assert "job_id" not in saved and "path" not in saved and "access" not in saved
    starts = []
    monkeypatch.setattr(jobs, "start", lambda auth, req, **kw: starts.append((auth, req, kw)) or {"job": {"id": "b" * 32}})
    row = monitor._active[isolated.owner]
    monitor.tick(now=row["next_scan"] - 1)
    assert starts == []
    monitor.tick(now=row["next_scan"])
    assert len(starts) == 1 and starts[0][1]["profile"] == "quick" and not starts[0][1]["include_excluded"]
    monkeypatch.setattr(jobs, "status", lambda *a: {"job": {"status": "running"}})
    monitor.tick(now=row["next_scan"] + 100000)
    assert len(starts) == 1 and row["pending"] == "b" * 32


@pytest.mark.parametrize("change", [{"warn_percent": 95, "critical_percent": 85}, {"scan_interval_hours": 1}, {"sudden_bytes": -1}, {"enabled": "true"}, {"sample_interval_seconds": 1}])
def test_monitor_rejects_invalid_resource_settings(change):
    with pytest.raises(ValidationError): monitor.Settings(**change)


@pytest.mark.parametrize("path", ["/api/ai/chat", "/api/ai/chat/stream", "/chat"])
def test_storage_chat_uses_receipts_without_provider_or_private_history(path, isolated, client, monkeypatch):
    from ai import ai_routes
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: pytest.fail("No inference startup"))
    monkeypatch.setattr(S.lm_provider, "complete", lambda **kw: pytest.fail("No external provider"))
    monkeypatch.setattr(diagnosis, "answer", lambda *a: pytest.fail("Imported adapters are tested below"))
    # Seed a session-bound server-owned observation; no request-supplied evidence.
    data = envelope()
    monkeypatch.setattr(jobs, "results", lambda *a: data)
    jobs._jobs["a" * 32] = {"id": "a" * 32, "operation": "scan", "status": "completed", "access": isolated,
        "expiry": 10**12, "result_available": True, "created": 1, "path": data["result"]["meta"]["root"], "result": data["result"]}
    response = client.post(path, json={"message": "Find my largest files."})
    assert response.status_code == 200, response.text
    assert "private.iso" in response.text and "storage_evidence" in response.text
    assert "private.iso" not in str(S.load_conversations())


def test_investigation_and_settings_api_validation(isolated, client, monkeypatch):
    monkeypatch.setattr(jobs, "results", lambda *a: envelope())
    response = client.post("/visualizer/investigate", json={"job_id": "a" * 32})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert client.post("/visualizer/investigate", json={"job_id": "../../secret"}).status_code == 422
    assert client.post("/visualizer/investigate", json={"job_id": "a" * 32, "size": 500}).status_code == 422
    assert client.put("/visualizer/history/retention", json={"max_snapshots": 4, "max_age_days": 30, "auto_prune": False}).status_code == 200
    assert client.get("/visualizer/history/retention").json()["max_snapshots"] == 4
    assert client.put("/visualizer/monitor", json={"enabled": True}).json()["active"]


def test_monitor_clock_regression_and_critical_escalation(isolated):
    monitor.configure(isolated, {"enabled": True, "warn_percent": 80, "critical_percent": 90})
    monitor.sample("X:/", 1000, 850, 150, now=1000)
    monitor.sample("X:/", 1000, 920, 80, now=1200)
    assert [r["critical"] for r in monitor.status(isolated)["findings"]] == [False, True]
    monitor.sample("X:/", 1000, 700, 300, now=100)
    assert monitor.status(isolated)["samples"]["X:/"] == [{"at": 100, "total": 1000, "used": 700, "free": 300}]


def test_scheduled_compare_precedes_pruning_and_checks_revocation(isolated, monkeypatch):
    from intelligence import storage_history as history
    data = envelope(); data["job"]["result_available"] = True
    data["result"]["meta"]["saved_scan"] = {"available": True, "scan_id": "c" * 32}
    monkeypatch.setattr(jobs, "results", lambda *a: data)
    monkeypatch.setattr(jobs, "status", lambda *a: {"job": data["job"]})
    monitor.configure(isolated, {"enabled": True, "schedule_enabled": True, "job_id": "a" * 32, "sudden_bytes": 1024**2})
    monitor._active[isolated.owner]["pending"] = "a" * 32
    calls = []
    monkeypatch.setattr(history, "history", lambda *a: {"snapshots": [{"id": "b" * 32, "root": data["result"]["meta"]["root"]}]})
    monkeypatch.setattr(history, "compare", lambda *a: calls.append("compare") or {"comparable": True, "totals": {"delta_bytes": 2 * 1024**2}, "files": []})
    monkeypatch.setattr(history, "save", lambda *a: calls.append("save") or {"removed_ids": ["b" * 32]})
    monitor.tick()
    assert calls == ["compare", "save"]
    assert monitor.status(isolated)["findings"][0]["baseline_retained"] is False
    monitor._active[isolated.owner]["pending"] = "a" * 32
    def revoked(*args):
        monkeypatch.setattr(jobs.Access, "valid", lambda self: False)
        return {"comparable": False}
    monkeypatch.setattr(history, "compare", revoked)
    monitor.tick()
    assert calls == ["compare", "save"]  # no save after revocation during history read


def test_stream_rechecks_access_between_metadata_and_private_delta(isolated, monkeypatch):
    from ai import ai_routes
    from starlette.requests import Request
    monkeypatch.setattr(ai_routes, "storage_answer", lambda *a: "private-file.iso 500 bytes")
    monkeypatch.setattr(ai_routes, "_save_turn", lambda *a, **kw: None)
    monkeypatch.setattr(ai_routes.shared_context, "request_user", lambda *a: "local")
    monkeypatch.setattr(ai_routes.chat_continuity, "recorded_outcome", lambda *a, **kw: None)
    monkeypatch.setattr(ai_routes.chat_continuity, "source_refs", lambda *a: {})
    monkeypatch.setattr(ai_routes, "diagnostic_answer", lambda *a: None)
    req = Request({"type": "http", "method": "POST", "scheme": "http", "path": "/", "headers": []})
    stream = ai_routes._stream_response(req, "Find my largest files.", "fixture", None, 500, .2)
    assert '"type": "meta"' in next(stream)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    rest = "".join(stream)
    assert '"type": "error"' in rest and "private-file" not in rest


@pytest.mark.parametrize("method,path,body", [("get", "/visualizer/monitor", None), ("get", "/visualizer/history/retention", None), ("post", "/visualizer/investigate", {"job_id": "a" * 32}), ("put", "/visualizer/monitor", {"enabled": True})])
def test_storage_intelligence_routes_require_authentication(isolated, monkeypatch, client, method, path, body):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    response = getattr(client, method)(path, **({"json": body} if body is not None else {}))
    assert response.status_code in (401, 403)


def test_diagnosis_reports_partial_path_growth_without_total_claim(isolated, monkeypatch):
    from intelligence import storage_history
    data = envelope(); data["result"]["meta"]["saved_scan"] = {"scan_id": "c" * 32}
    monkeypatch.setattr(jobs, "results", lambda *a: data)
    monkeypatch.setattr(storage_history, "compare", lambda *a: {"comparable": False, "totals": None,
        "reasons": ["Coverage is incomplete"], "file_comparison": {"available": True, "complete": False, "reason": "Only matching recorded path sizes are compared."},
        "files": [{"path": "growing.log", "status": "grew", "delta_bytes": 100}], "capacity": {"available": False}})
    report = diagnosis.investigate(isolated, "a" * 32, "What grew overnight?", "b" * 32)
    assert "growing.log: grew, +100 logical bytes" in report["reply"]
    assert "Compared scan logical-size change" not in report["reply"]


def test_failed_scheduled_reader_is_visible_and_not_retried_immediately(isolated, monkeypatch):
    data = envelope(); data["job"]["result_available"] = True
    monkeypatch.setattr(jobs, "results", lambda *a: data)
    monitor.configure(isolated, {"enabled": True, "schedule_enabled": True, "job_id": "a" * 32})
    row = monitor._active[isolated.owner]; row["pending"] = "a" * 32
    monkeypatch.setattr(jobs, "status", lambda *a: {"job": {"status": "failed", "result_available": False}})
    monkeypatch.setattr(jobs, "start", lambda *a, **kw: pytest.fail("No immediate retry"))
    monitor.tick()
    assert row["pending"] is None
    assert monitor.status(isolated)["findings"][-1]["kind"] == "schedule_failed"


def test_storage_trend_integrates_narrator_and_retains_only_generic_activity(tmp_path):
    import activity_history
    from routers import dashboard_presence
    event = {"sequence": 1, "stream_id": "a" * 32, "ts": 1000,
        "category": "system", "level": "warn", "title": "Storage trend needs review", "body": "PRIVATE C:/Users/Secret/file.gguf"}
    assert dashboard_presence.classify_event(event)["narrator_worthy"]
    recorder = activity_history.Journal(tmp_path, clock=lambda: 1100).start()
    try:
        recorder.record(event)
    finally:
        assert recorder.stop()
    assert "PRIVATE" not in recorder.path.read_text() and "file.gguf" not in recorder.path.read_text()
    assert recorder.snapshot()["events"][0]["title"] == "Storage trend needs review"
