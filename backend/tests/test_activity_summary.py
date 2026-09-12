from collections import deque
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
import event_bus as bus
import activity_summary as activity
import tli_state as S
from intelligence.store import private_path
from routers import visualizer


@pytest.fixture(autouse=True)
def isolated_activity(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(bus, "_events", deque(maxlen=200))
    monkeypatch.setattr(bus, "_stream_id", "a" * 32)
    monkeypatch.setattr(bus, "_sequence", 0)
    monkeypatch.setattr(bus, "_post_emit_hooks", [])
    monkeypatch.setattr(bus, "_loop", None)
    monkeypatch.setattr(bus, "_journal", None)


def emit(title="Device changed", level="info", node="Office"):
    bus.emit_event("device", level, title, "Observed by TLI", node=node)


def test_first_visit_is_read_only_and_does_not_invent_health():
    result = activity.get_summary("alice")
    assert result["total"] == 0 and result["coverage"] == "first_visit"
    assert "No previous review" in result["coverage_note"]
    assert not private_path("alice", "activity-review").exists()
    assert "healthy" not in str(result)


def test_groups_keep_nodes_levels_and_full_repetitions():
    for _ in range(3):
        emit()
    emit(level="critical")
    emit(node="Kitchen")
    result = activity.get_summary("alice")
    assert result["total"] == 5 and len(result["events"]) == 5
    assert result["group_count"] == 3
    assert result["groups"][0]["level"] == "critical"
    assert next(g for g in result["groups"] if g["count"] == 3)["node"] == "Office"
    assert result["warning_count"] == 1


def test_review_marks_only_displayed_snapshot_and_is_user_scoped():
    emit()
    seen = activity.get_summary("alice")
    emit("Event arriving during review")
    activity.mark_reviewed("alice", seen["cursor"])
    result = activity.get_summary("alice")
    assert result["coverage"] == "complete"
    assert [e["title"] for e in result["events"]] == ["Event arriving during review"]
    assert len(result["retained_events"]) == 2  # reviewing never hides retained history
    assert activity.get_summary("bob")["total"] == 2
    # Cursor persistence uses the existing encrypted per-user sidecar convention.
    assert "stream_id" not in private_path("alice", "activity-review").read_text()
    assert activity.get_summary("alice")["reviewed_at"] is not None


def test_stale_tab_cannot_move_review_backwards():
    emit()
    old = activity.get_summary("alice")["cursor"]
    emit()
    new = activity.get_summary("alice")["cursor"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda c: activity.mark_reviewed("alice", c), [new, old]))
    assert activity.get_summary("alice")["total"] == 0


def test_ring_overflow_is_honest_and_summary_is_bounded():
    activity.mark_reviewed("alice", bus.activity_snapshot()["cursor"])
    for n in range(205):
        emit(f"Event {n}")
    result = activity.get_summary("alice")
    assert result["coverage"] == "history_limited"
    assert len(result["events"]) == 200 and len(result["groups"]) == 6
    assert result["group_count"] == 200
    assert "incomplete" in result["coverage_note"]


def test_restart_never_reports_all_quiet_or_accepts_old_cursor(monkeypatch):
    old = bus.activity_snapshot()["cursor"]
    activity.mark_reviewed("alice", old)
    monkeypatch.setattr(bus, "_stream_id", "b" * 32)
    result = activity.get_summary("alice")
    assert result["coverage"] == "restarted" and "unavailable" in result["coverage_note"]
    with pytest.raises(HTTPException) as error:
        activity.mark_reviewed("alice", old)
    assert error.value.status_code == 409


def test_event_cursor_and_retained_snapshot_are_consistent_under_concurrency():
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda n: emit(f"Event {n}"), range(100)))
    snapshot = bus.activity_snapshot()
    assert [e["sequence"] for e in snapshot["events"]] == list(range(1, 101))
    assert snapshot["cursor"]["sequence"] == 100
    assert all(e["stream_id"] == snapshot["cursor"]["stream_id"] for e in snapshot["events"])
    assert bus.get_recent(-1) == []


def test_corrupt_review_is_not_overwritten_or_silently_reset():
    path = private_path("alice", "activity-review")
    path.write_text("broken", encoding="utf-8")
    for call in (lambda: activity.get_summary("alice"),
                 lambda: activity.mark_reviewed("alice", bus.activity_snapshot()["cursor"])):
        with pytest.raises(HTTPException) as error:
            call()
        assert error.value.status_code == 503
    assert path.read_text() == "broken"


def test_summary_and_review_require_session(client, monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    assert client.get("/dashboard/activity-summary").status_code == 401
    assert client.post("/dashboard/activity-summary/review", json=bus.activity_snapshot()["cursor"]).status_code == 401


def test_api_cursor_validation_and_legacy_feed_contract(authed_client):
    emit()
    data = authed_client.get("/dashboard/activity-summary").json()
    assert data["ok"] is True
    assert authed_client.post("/dashboard/activity-summary/review", json=data["cursor"]).json()["ok"] is True
    for invalid in ({"stream_id": "bad", "sequence": 0}, {**data["cursor"], "sequence": -1},
                    {**data["cursor"], "sequence": True}):
        assert authed_client.post("/dashboard/activity-summary/review", json=invalid).status_code == 422
    assert authed_client.post("/dashboard/activity-summary/review", json={**data["cursor"], "sequence": 500}).status_code == 409
    feed = authed_client.get("/api/events/recent").json()
    assert set(feed) == {"events"}
    assert {"id", "ts", "ts_fmt", "category", "level", "title", "body", "node", "actions"} <= set(feed["events"][0])


@pytest.mark.parametrize("route", ["scan", "large-files", "duplicates"])
def test_failed_scans_emit_failure_without_paths(authed_client, tmp_path, route):
    secret = str(tmp_path / "private-project-does-not-exist")
    assert authed_client.get(f"/visualizer/{route}", params={"path": secret}).status_code == 404
    events = bus.get_recent()
    assert len(events) == 2 and events[0]["level"] == "warn"
    assert "failed" in events[0]["title"] and "no files were changed" in events[0]["body"]
    assert secret not in str(events)


@pytest.mark.parametrize("route,helper,result", [
    ("large-files", "_collect_large_files", ([{"name": "private-name"}], {"partial": True})),
    ("duplicates", "_find_duplicates", ([], {"partial": True})),
])
def test_partial_scans_do_not_claim_completion(authed_client, tmp_path, monkeypatch, route, helper, result):
    import storage_jobs
    field = "files" if route == "large-files" else "groups"
    rows = [{"name": "private-name", "path": str(tmp_path / "private-name"), "size": 3}] if field == "files" else []
    monkeypatch.setattr(storage_jobs.process, "run", lambda *a, **kw: {
        "type": "result", "worker_stopped": True,
        "result": {field: rows, "meta": {"partial": True, "root": str(tmp_path)}}})
    assert authed_client.get(f"/visualizer/{route}", params={"path": str(tmp_path)}).status_code == 200
    event = bus.get_recent()[0]
    assert "partially completed" in event["title"] and event["level"] == "warn"
    assert "private-name" not in str(event)
