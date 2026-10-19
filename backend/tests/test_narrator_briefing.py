"""Narrator briefings expose bounded evidence without changing action authority."""
import json

import pytest

from narrator_briefing import build_briefing
from narrator_policy import NarratorPolicy


def state(t=0, **changes):
    return {"probed_ts": 1000 + t, "cpu_pct": 20, "ram_pct": 40,
            "disk_pct_by_drive": {"C:\\": 40}, "host": {"name": "Test computer"}, **changes}


def briefing(policy=None, t=0, event=None, **changes):
    policy = policy or NarratorPolicy()
    snapshot = state(t, **changes)
    policy.render(snapshot, t, 1000 + t, event)
    return build_briefing(snapshot, policy, t, 1000 + t)


def test_healthy_snapshot_names_only_observed_system_checks():
    result = briefing()
    assert result == {"version": 1, "generated_at": 1000, "observed_at": 1000,
                      "freshness": "current", "host": "Test computer",
                      "summary": "Your latest system checks are within range.",
                      "attention_count": 0, "items": []}


def test_all_drive_warnings_are_counted_sorted_and_bounded():
    result = briefing(disk_pct_by_drive={f"{letter}:\\": 90 + n for n, letter in enumerate("CDEFGHIJK")})
    assert result["attention_count"] == 9
    assert len(result["items"]) == 6
    assert result["summary"] == "9 storage warnings need your attention."
    assert [row["target"]["path"] for row in result["items"]] == [f"{letter}:\\" for letter in "KJIHGF"]
    assert result["items"][0]["severity"] == "critical"
    assert result["items"][-1]["severity"] == "warning"
    assert result["items"][0]["action"] == {"kind": "storage", "label": "Review in Free Space", "path": "K:\\"}


@pytest.mark.parametrize("changes,freshness", [
    ({"probed_ts": 969}, "stale"), ({"probed_ts": 1006}, "unavailable"),
    ({"probed_ts": None}, "unavailable"), ({"probed_ts": float("nan")}, "unavailable"),
    ({"probed_ts": True}, "unavailable"), ({"probe_error": "failed"}, "unavailable"),
])
def test_unavailable_or_stale_readings_never_retain_disk_claims(changes, freshness):
    result = briefing(disk_pct_by_drive={"C:\\": 99}, **changes)
    assert result["freshness"] == freshness
    assert [row["kind"] for row in result["items"]] == ["monitoring"]
    assert "within range" not in result["summary"]
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("value", [None, True, float("nan"), float("inf"), -1, 101, "95"])
def test_invalid_cpu_ram_and_disk_values_are_unknown_not_healthy_or_pressure(value):
    result = briefing(cpu_pct=value, ram_pct=value, disk_pct_by_drive={"C:\\": value})
    assert result["freshness"] == "current"
    assert result["attention_count"] == 0
    assert result["summary"] == "Some system checks are unavailable."
    assert [row["id"] for row in result["items"]] == ["coverage"]
    json.dumps(result, allow_nan=False)


def test_partial_storage_readings_keep_valid_warning_and_coverage_gap():
    result = briefing(disk_pct_by_drive={"C:\\": 98, "D:\\": float("nan")})
    assert result["attention_count"] == 1
    assert [row["id"] for row in result["items"]] == ["disk:C:\\", "coverage"]


def test_critical_drive_does_not_hide_activity_or_retime_it_on_each_probe():
    policy = NarratorPolicy()
    event = {"category": "device", "title": "Device command completed", "ts": 998}
    first = briefing(policy, event=event, disk_pct_by_drive={"C:\\": 98})
    later = briefing(policy, t=10, disk_pct_by_drive={"C:\\": 98})
    assert first["activity"] == later["activity"]
    assert first["activity"] == {"text": "Device command completed.", "observed_at": 998, "expires_at": 1028}
    assert later["observed_at"] == 1010
    assert later["items"][0]["observed_at"] == 1010
    assert "activity" not in briefing(policy, t=28, disk_pct_by_drive={"C:\\": 98})
    # Deduplicating the same event does not renew its independent activity row.
    assert "activity" not in briefing(policy, t=29, event=event, disk_pct_by_drive={"C:\\": 98})


def test_pressure_needs_sustained_readings_and_explains_recovery_duration():
    policy = NarratorPolicy()
    for t in range(0, 30, 5):
        result = briefing(policy, t=t, cpu_pct=95, ram_pct=94)
        assert result["attention_count"] == 0
        assert "elevated" in result["summary"]
    result = briefing(policy, t=30, cpu_pct=95, ram_pct=94)
    assert [row["kind"] for row in result["items"]] == ["cpu_pct", "ram_pct"]
    assert result["attention_count"] == 2
    result = briefing(policy, t=35)
    assert all("Waiting for 30 seconds below" in row["detail"] for row in result["items"])
    for t in range(40, 66, 5):
        result = briefing(policy, t=t)
    assert result["attention_count"] == 0


def test_confirmation_and_critical_event_still_control_summary():
    policy = NarratorPolicy()
    policy.confirm("Opened Devices.", 0)
    assert briefing(policy, t=9)["summary"] == "Opened Devices."
    assert briefing(policy, t=10)["summary"] == "Your latest system checks are within range."
    policy.confirm("Opened Devices.", 11)
    assert briefing(policy, t=12, disk_pct_by_drive={"C:\\": 99})["summary"] == "1 storage warning needs your attention."
    result = briefing(policy, t=13, event={"title": "Critical operation failure", "level": "critical"})
    assert result["summary"] == "Critical operation failure."
    assert result["observed_at"] == 1013


def test_current_warning_is_not_replaced_by_a_healthy_summary():
    policy = NarratorPolicy()
    event = {"title": "Device unavailable", "level": "warning", "ts": 1000}
    result = briefing(policy, event=event)
    assert result["summary"] == "Device unavailable."
    assert result["attention_count"] == 0
    assert result["activity"]["text"] == result["summary"]
    assert briefing(policy, t=5, disk_pct_by_drive={"C:\\": 98})["summary"] == "1 storage warning needs your attention."
    policy.confirm("Opened Devices.", 6)
    assert briefing(policy, t=7)["summary"] == "Opened Devices."
    assert briefing(policy, t=30)["summary"] == "Your latest system checks are within range."


def test_failed_dashboard_action_remains_the_briefing_summary(monkeypatch):
    from routers import actions_engine, dashboard_presence as dp
    now = [0]
    policy = NarratorPolicy()
    action = dp._make_action("Review storage", "", "Review", "open_visualizer", 10)
    monkeypatch.setattr(dp, "_action_queue", [action])
    monkeypatch.setattr(dp, "_inflight_actions", set())
    monkeypatch.setattr(dp, "_narrator_policy", policy)
    monkeypatch.setattr(dp, "_narrator", {"text": "", "type": "status", "timestamp": 0})
    monkeypatch.setattr(dp, "_last_narrator_briefing", None)
    monkeypatch.setattr(dp, "_read_state", lambda: state(now[0]))
    monkeypatch.setattr(dp.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(dp.time, "time", lambda: 1000 + now[0])
    monkeypatch.setattr(dp, "_get_emit_meta", lambda: lambda *_: None)
    monkeypatch.setattr(dp, "_dispatch_handler", lambda *args, **kwargs: {"ok": False, "error": "Device unreachable"})
    receipts = []
    monkeypatch.setattr(actions_engine, "_append_receipt", receipts.append)
    response = dp._execute_dashboard_action(action["id"], check=lambda: None)
    result = dp._get_narrator()
    assert response["ok"] is False and receipts[0]["ok"] is False
    assert result["type"] == "alert"
    assert result["briefing"]["summary"] == response["receipt"]["narrator_msg"]
    assert "Action failed" in result["briefing"]["summary"]
    assert result["briefing"]["activity"]["text"] == result["briefing"]["summary"]
    assert action in dp._action_queue
    now[0] = 31
    dp._refresh_narrator()
    assert dp._get_narrator()["briefing"]["summary"] == "Your latest system checks are within range."


def test_briefing_is_a_pure_read_of_policy():
    policy = NarratorPolicy()
    policy.render(state(), 0, 1000, {"title": "A change", "ts": 1000})
    before = repr(vars(policy))
    first = build_briefing(state(), policy, 1, 1001)
    second = build_briefing(state(), policy, 1, 1001)
    assert first == second and repr(vars(policy)) == before


def test_each_fresh_probe_broadcasts_briefing_without_retiming_headline(monkeypatch):
    from routers import dashboard_presence as dp
    policy = NarratorPolicy()
    now = [0]
    monkeypatch.setattr(dp, "_narrator_policy", policy)
    monkeypatch.setattr(dp, "_narrator", {"text": "", "type": "status", "timestamp": 0})
    monkeypatch.setattr(dp, "_last_narrator_briefing", None)
    monkeypatch.setattr(dp, "_read_state", lambda: state(now[0]))
    monkeypatch.setattr(dp.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(dp.time, "time", lambda: 1000 + now[0])
    events = []
    monkeypatch.setattr(dp, "_get_emit_meta", lambda: lambda kind, payload: events.append((kind, payload)))
    dp._refresh_narrator()
    first = events[-1][1]
    now[0] = 5
    dp._refresh_narrator()
    second = events[-1][1]
    assert len(events) == 2
    assert first["text"] == second["text"] and first["timestamp"] == second["timestamp"] == 1000
    assert first["briefing"]["observed_at"] == 1000 and second["briefing"]["observed_at"] == 1005
    dp._refresh_narrator()
    assert len(events) == 2
