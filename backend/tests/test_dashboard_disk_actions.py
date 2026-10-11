"""Synthetic cached observations only: no poller, real probes, or live actions."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from narrator_policy import NarratorPolicy
from routers import dashboard_presence as dp


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(dp.time, "time", lambda: now[0])
    monkeypatch.setattr(dp, "_action_queue", [])
    monkeypatch.setattr(dp, "_disk_snoozes", {})
    monkeypatch.setattr(dp, "_disk_last_sample_ts", 0.0)
    monkeypatch.setattr(dp, "_inflight_actions", set())
    monkeypatch.setattr(dp, "_broadcast_action_update", lambda: None)
    monkeypatch.setattr(dp, "_broadcast_state_update", lambda _: None)
    monkeypatch.setattr(dp, "_refresh_narrator", lambda: None)
    monkeypatch.setattr(dp, "log_debug", lambda *args: None)
    monkeypatch.setattr(dp.S, "load_node_config", lambda: SimpleNamespace(node_id="host-a", node_name="Synthetic host"))
    monkeypatch.setattr(dp, "_dispatch_handler", lambda _: pytest.fail("Unexpected action dispatch"))
    return now


def observation(now, disks=None, **extra):
    return {"probed_ts": now, "sampled_ts": now, "observation_id": f"sample-{now}",
            "host": {"id": "host-a", "name": "Synthetic host"},
            "disk_pct_by_drive": disks or {}, "cpu_pct": 10, "ram_pct": 30, **extra}


def test_exact_drives_rank_and_refresh_without_narrator_association(clock):
    state = observation(clock[0], {"C:\\": 96, "L:\\": 99})
    dp._score_disk_actions(state)
    assert len(dp._action_queue) == 2
    first = dp.get_top_action()
    assert first["target"]["path"] == "L:\\"
    assert "L:\\" in NarratorPolicy().render(state, 0, clock[0])[0]
    previous_id = first["id"]
    clock[0] += 5
    dp._score_disk_actions(observation(clock[0], {"C:\\": 10, "L:\\": 88}))
    updated = dp.get_top_action()
    assert len(dp._action_queue) == 1 and updated["id"] == previous_id
    assert updated["score"] == 80 and "88%" in updated["title"]
    assert updated["observation"]["observed_at"] == clock[0]
    payload = dp._safe_action_payload(updated)
    assert payload["handler"] == "open_visualizer:" + payload["target"]["path"]
    assert payload["observation"]["target_id"] == payload["target"]["id"]
    assert payload["relationship"] == "independent_suggestion"
    payload["target"]["path"] = "altered consumer copy"
    assert dp.get_top_action()["target"]["path"] == "L:\\"


@pytest.mark.parametrize("change", [
    {"disk_pct_by_drive": {"C:\\": 84}}, {"disk_pct_by_drive": {}},
    {"probe_error": "synthetic unavailable"}, {"host": None},
    {"probed_ts": 960}, {"probed_ts": 1100},
    {"disk_pct_by_drive": {"C:\\": None}}, {"disk_pct_by_drive": {"C:\\": True}},
    {"disk_pct_by_drive": {"C:\\": float("nan")}}, {"disk_pct_by_drive": {"C:\\": 101}},
])
def test_missing_cleared_invalid_stale_withdraw_only_disk(clock, change):
    other = dp._make_action("Automation failed", "", "Review", "open_automations", 1)
    dp._action_queue.append(other)
    dp._score_disk_actions(observation(clock[0], {"C:\\": 99}))
    clock[0] += 5
    dp._score_disk_actions(observation(clock[0], {"C:\\": 99}, **change))
    assert dp._action_queue == [other]


def test_snooze_survives_refresh_clear_reappearance_but_not_other_target(clock):
    dp._score_disk_actions(observation(clock[0], {"C:\\": 99, "L:\\": 96}))
    first = dp.get_top_action()
    dp.post_action_dismiss(dp.DismissRequest(action_id=first["id"], snooze_minutes=1))
    assert dp.get_top_action()["target"]["path"] == "L:\\"
    clock[0] += 5
    dp._score_disk_actions(observation(clock[0], {}))
    assert dp.get_top_action() is None
    clock[0] += 5
    dp._score_disk_actions(observation(clock[0], {"c:/": 100}))
    assert dp.get_top_action() is None
    clock[0] = 1060
    dp._score_disk_actions(observation(clock[0], {"C:\\": 100}))
    assert dp.get_top_action()["target"]["path"] == "C:\\"


def test_expiry_pruned_on_read_and_confirm_without_any_dispatch(clock):
    dp._score_disk_actions(observation(clock[0], {"C:\\": 96}))
    action = dp.get_top_action()
    clock[0] += 30
    with pytest.raises(HTTPException) as error:
        dp._execute_dashboard_action(action["id"])
    assert error.value.status_code == 404
    assert dp.get_top_action() is None


def test_older_observation_cannot_revive_or_replace_current_target(clock):
    dp._score_disk_actions(observation(clock[0], {"C:\\": 99}))
    clock[0] += 5
    dp._score_disk_actions(observation(clock[0], {"L:\\": 96}))
    dp._score_disk_actions(observation(1000, {"C:\\": 99}))
    assert [a["target"]["path"] for a in dp._action_queue] == ["L:\\"]


def test_host_change_cannot_inherit_drive_snooze(clock):
    dp._score_disk_actions(observation(clock[0], {"C:\\": 99}))
    dp.post_action_dismiss(dp.DismissRequest(action_id=dp.get_top_action()["id"]))
    clock[0] += 5
    dp._score_disk_actions(observation(clock[0], {"C:\\": 99}, host={"id":"host-b", "name":"Other synthetic host"}))
    assert dp.get_top_action()["target"]["host_id"] == "host-b"


def test_poll_refreshes_same_band_and_failure_withdraws(clock, monkeypatch):
    monkeypatch.setattr(dp, "_state", {"device_count": 0, "last_event_ts": None})
    monkeypatch.setattr(dp, "_probe_metrics", lambda: {"cpu_pct": 10, "ram_pct": 30, "disk_pct_by_drive": {"C:\\": 96}})
    broadcasts = []
    monkeypatch.setattr(dp, "_broadcast_action_update", lambda: broadcasts.append(1))
    dp._poll_once()
    assert dp.get_top_action()["target"]["host_name"] == "Synthetic host"
    clock[0] += 5
    dp._poll_once()
    assert dp.get_top_action()["observation"]["observed_at"] == clock[0]
    assert len(broadcasts) == 2
    def fail():
        raise OSError("synthetic metrics failure")
    monkeypatch.setattr(dp, "_probe_metrics", fail)
    clock[0] += 5
    dp._poll_once()
    assert dp.get_top_action() is None
    state = dp.get_dashboard_state()
    assert state["probe_error"] and state["probed_ts"] == 1005


def test_unavailable_node_does_not_fabricate_identity(clock, monkeypatch):
    def fail():
        raise OSError("synthetic config failure")
    monkeypatch.setattr(dp.S, "load_node_config", fail)
    assert dp._host_identity() is None
    assert dp._node_snapshot()["id"] is None and dp._node_snapshot()["name"] is None


def test_confirm_refresh_race_removes_only_reviewed_action_identity(clock, monkeypatch):
    from routers import actions_engine
    monkeypatch.setattr(actions_engine, "_append_receipt", lambda _: None)
    monkeypatch.setattr(dp, "_narrator_policy", NarratorPolicy())
    dp._score_disk_actions(observation(clock[0], {"C:\\": 96, "L:\\": 99}))
    action = dp.get_top_action()
    def navigate(handler):
        clock[0] += 5
        dp._score_disk_actions(observation(clock[0], {"C:\\": 97, "L:\\": 100}))
        return {"ok": True, "navigate_to": "panel-visualizer", "scan_path": handler.split(":", 1)[1]}
    monkeypatch.setattr(dp, "_dispatch_handler", navigate)
    result = dp._execute_dashboard_action(action["id"])
    assert result["receipt"]["scan_path"] == result["receipt"]["target"]["path"] == "L:\\"
    assert len(dp._action_queue) == 1 and dp.get_top_action()["target"]["path"] == "C:\\"


@pytest.mark.parametrize("value", [None, True, float("nan"), float("inf"), -1, 101])
def test_narrator_never_turns_invalid_disk_data_into_warning(clock, value):
    state = observation(clock[0], {"C:\\": value})
    policy = NarratorPolicy()
    assert "critically full" not in policy.render(state, 0, clock[0])[0]
    assert not any(row["kind"] == "disk" for row in policy.explanations(state, 0, clock[0]))
