"""Synthetic clock and temporary metadata only; never imports/runs device producers."""
from collections import deque
import json
import queue
import time

import pytest

import activity_history as history
import activity_summary as summary
import event_bus as bus
import tli_state as S


def event(n=1, title="Storage scan finished", category="system", stream="a" * 32):
    return {"sequence": n, "stream_id": stream, "ts": 1000 + n, "title": title, "category": category,
            "body": "SECRET /private/folder command=delete", "node": "PRIVATE OWNER", "actions": [{"secret": "TOKEN"}]}


def test_restart_keeps_only_catalogue_metadata_and_rejects_dynamic_details(tmp_path):
    recorder = history.Journal(tmp_path, clock=lambda: 1100).start()
    recorder.record(event())
    recorder.record(event(2, "PRIVATE /filename model ready", "ai"))
    assert recorder.stop()
    raw = recorder.path.read_text()
    assert all(secret not in raw for secret in ("SECRET", "PRIVATE", "TOKEN", "folder", "Storage scan"))
    recovered = history.Journal(tmp_path, clock=lambda: 1100).start()
    try:
        snapshot = recovered.snapshot()
        assert recovered.was_clean and len(snapshot["events"]) == 1
        assert snapshot["events"][0]["title"] == "Storage scan finished"
        assert snapshot["events"][0]["retained_generic"] is True
        assert snapshot["cursor"]["sequence"] == 1
    finally:
        recovered.stop()


@pytest.mark.parametrize("raw", [b"not json", b'{}', b'{"events":["PRIVATE"]}', b"x" * (history.MAX_BYTES + 1)],
                         ids=["invalid-json", "invalid-schema", "private-shape", "oversized"])
def test_damaged_history_is_preserved_and_live_recording_never_overwrites(tmp_path, raw):
    path = tmp_path / "activity-history.json"
    path.write_bytes(raw)
    recorder = history.Journal(tmp_path).start()
    recorder.record(event())
    assert recorder.snapshot()["status"] == "unavailable"
    assert not recorder.stop()
    assert path.read_bytes() == raw


def test_retention_limits_and_expiration_are_reported(tmp_path):
    now = [2000]
    recorder = history.Journal(tmp_path, clock=lambda: now[0])
    rows = [{"code": "scan_done", "ts": 1000 + i, "sequence": i + 1,
             "stream_id": "a" * 32, "live_sequence": i + 1} for i in range(510)]
    recorder._write(rows, 510)
    assert len(recorder.snapshot()["events"]) == history.LIMIT
    assert recorder.snapshot()["dropped"] == 10
    assert recorder.path.stat().st_size <= history.MAX_BYTES
    now[0] += history.MAX_AGE
    assert recorder.snapshot()["events"] == []
    assert recorder.snapshot()["dropped"] == 510


def test_queue_overflow_is_bounded_persisted_and_visible(tmp_path):
    recorder = history.Journal(tmp_path, clock=lambda: 1100)
    recorder.accepting = True
    recorder.queue = queue.Queue(maxsize=1)
    recorder.record(event())
    recorder.record(event(2))
    assert recorder.queue.qsize() == 1 and recorder.snapshot()["queue_omitted"] == 1
    recorder._write([], 0)
    restored = history.Journal(tmp_path, clock=lambda: 1100).start()
    try:
        assert restored.snapshot()["queue_omitted"] == 1
    finally:
        restored.stop()


def test_idle_history_prunes_expired_disk_entries_without_new_events(tmp_path, monkeypatch):
    monkeypatch.setattr(history, "IDLE_CHECK_SECONDS", 0.01)
    now = [1100]
    recorder = history.Journal(tmp_path, clock=lambda: now[0])
    recorder._write([{"code": "scan_done", "ts": 1001, "sequence": 1,
                      "stream_id": "a" * 32, "live_sequence": 1}], 1)
    recorder.start()
    try:
        now[0] += history.MAX_AGE
        deadline = time.monotonic() + 2
        # Wait for the idle writer's committed state; a direct file read can
        # overlap Windows' atomic replacement and fail with a sharing error.
        while time.monotonic() < deadline:
            with recorder.lock:
                idle_pruned = recorder.entries == []
            if idle_pruned:
                break
            time.sleep(0.005)
        assert idle_pruned
        assert recorder.snapshot()["dropped"] == 1
    finally:
        recorder.stop()
    assert json.loads(recorder.path.read_text())["events"] == []


def test_write_failure_preserves_previous_bytes_and_does_not_break_feed(tmp_path, monkeypatch):
    recorder = history.Journal(tmp_path, clock=lambda: 1100).start()
    previous = recorder.path.read_bytes()
    monkeypatch.setattr(history.os, "replace", lambda *args: (_ for _ in ()).throw(OSError("PRIVATE")))
    monkeypatch.setattr(bus, "_journal", recorder)
    monkeypatch.setattr(bus, "_events", deque(maxlen=200))
    monkeypatch.setattr(bus, "_post_emit_hooks", [])
    bus.emit_event("system", "ok", "Storage scan finished", "PRIVATE")
    recorder.stop()
    assert bus.get_recent()[0]["title"] == "Storage scan finished"
    assert recorder.snapshot()["status"] == "unavailable"
    assert recorder.path.read_bytes() == previous


def test_lifecycle_records_uncertain_previous_shutdown_and_normal_stop(tmp_path, monkeypatch):
    # A persisted open-session marker without a stop is uncertainty, not proof of a crash.
    seed = history.Journal(tmp_path)
    seed._write([], 0, clean=False)
    monkeypatch.setattr(bus, "_journal", None)
    monkeypatch.setattr(bus, "_events", deque(maxlen=200))
    monkeypatch.setattr(bus, "_post_emit_hooks", [])
    bus.start_activity_history(tmp_path)
    assert bus.stop_activity_history()
    data = json.loads(seed.path.read_text())
    assert data["clean"] is True
    assert [row["code"] for row in data["events"]] == ["unclean", "started", "stopped"]


def test_review_cursor_survives_restart_and_preserves_new_events(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    recorder = history.Journal(tmp_path, clock=lambda: 1100).start()
    recorder.record(event())
    recorder.stop()
    recorder = history.Journal(tmp_path, clock=lambda: 1100).start()
    monkeypatch.setattr(bus, "_journal", recorder)
    monkeypatch.setattr(bus, "_stream_id", "b" * 32)
    monkeypatch.setattr(bus, "_sequence", 0)
    monkeypatch.setattr(bus, "_events", deque(maxlen=200))
    monkeypatch.setattr(bus, "_post_emit_hooks", [])
    try:
        shown = summary.get_summary("alice")
        assert shown["total"] == 1 and shown["events"][0]["retained_generic"]
        bus.emit_event("system", "info", "New live-only event")
        summary.mark_reviewed("alice", {**shown["cursor"], "history_cursor": shown["history_cursor"]})
        newer = summary.get_summary("alice")
        assert newer["total"] == 1 and newer["events"][0]["title"] == "New live-only event"
        assert summary.get_summary("bob")["total"] == 2
        assert "generic summaries" in newer["coverage_note"]
        assert len(newer["retained_events"]) == 2
    finally:
        recorder.stop()


def test_live_and_saved_duplicate_are_shown_once_and_review_does_not_go_backwards(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(bus, "_stream_id", "a" * 32)
    monkeypatch.setattr(bus, "_sequence", 1)
    live = event()
    live["level"] = "ok"
    monkeypatch.setattr(bus, "_events", deque([live], maxlen=200))
    recorder = history.Journal(tmp_path, clock=lambda: 1100).start()
    recorder.record(live)
    recorder.stop()
    monkeypatch.setattr(bus, "_journal", recorder)
    shown = summary.get_summary("alice")
    assert shown["total"] == 1
    cursor = {**shown["cursor"], "history_cursor": shown["history_cursor"]}
    summary.mark_reviewed("alice", cursor)
    summary.mark_reviewed("alice", {**cursor, "history_cursor": {**shown["history_cursor"], "sequence": 0}})
    assert summary.get_summary("alice")["total"] == 0
    assert summary.get_summary("alice")["history_cursor"]["sequence"] == 1
