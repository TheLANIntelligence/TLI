"""Saved HomePower evidence survives damage and failed edits; no live devices."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import home_power_store as storage
import license as licensing
import tli_state as S
from routers import home_power as hp


KINDS = ("devices", "scenes", "automations")
IDS = {"devices": "device_id", "scenes": "scene_id", "automations": "automation_id"}
SINGULAR = {"devices": "device", "scenes": "scene", "automations": "automation"}
PRIVATE = "Synthetic private metadata"


def row(kind, ident=None, **changes):
    samples = {
        "devices": {"device_id": "lamp-1", "name": "Study lamp", "vendor": "shelly",
                    "ip": "192.0.2.10", "relay": 0, "extra": {},
                    "capabilities": ["switch.on", "switch.off", "switch.toggle"],
                    "room": "Study", "tags": ["lamp"]},
        "scenes": {"scene_id": "scene-1", "name": "Evening", "description": "Saved scene",
                   "enabled": True, "actions": [{"device_id": "lamp-1", "capability": "switch.off"}]},
        "automations": {"automation_id": "automation-1", "name": "Evening automation", "enabled": False,
                        "trigger": "game_started", "run_scene_id": "scene-1", "cooldown_s": 600,
                        "time_hhmm": None, "after_hhmm": None, "game_name_contains": None},
    }
    value = deepcopy(samples[kind])
    if ident is not None:
        value[IDS[kind]] = ident
    return {**value, **changes}


def path_for(surface, kind):
    return surface.root / "home_power" / (kind + ".json")


def write_raw(surface, kind, raw):
    path = path_for(surface, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode())
    return path


def persist(surface, kind, value):
    return write_raw(surface, kind, json.dumps(value, allow_nan=True))


def seed(surface, kind, rows=None, **extra):
    return persist(surface, kind, {kind: [row(kind)] if rows is None else rows, **extra})


def load(surface, kind):
    return getattr(surface.runtime, "load_" + kind)()


def save(surface, kind, rows):
    return getattr(surface.runtime, "save_" + kind)(rows)


def http(surface, method, route, body=None):
    with TestClient(surface.app, base_url="http://localhost:8000", client=("127.0.0.1", 40000),
                    headers={"Origin": "http://localhost:8000", "Cookie": "tli_session=" + surface.token},
                    raise_server_exceptions=False) as client:
        return client.request(method, "/homepower" + route, **({"json": body} if body is not None else {}))


def upsert(surface, kind, value=None):
    return http(surface, "POST", "/" + kind + "/save", {SINGULAR[kind]: value or row(kind)})


def unavailable(call):
    with pytest.raises(HTTPException) as error:
        call()
    assert error.value.status_code == 503
    assert PRIVATE not in str(error.value.detail)


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    S.save_pin_config("a" * 64, "b" * 64)
    token = S.create_session_token("household")
    monkeypatch.setattr(licensing, "get_active_tier", lambda: "pro")
    monkeypatch.setattr(licensing, "has_feature", lambda *args: True)
    monkeypatch.setattr(hp, "games_detect_best", lambda: None)
    def forbidden(*args, **kwargs):
        pytest.fail("This preservation check must not contact or operate a device")
    driver = SimpleNamespace(turn_on=forbidden, turn_off=forbidden, toggle=forbidden, get_status=forbidden)
    logs = []
    runtime = hp.HomePowerRuntime(tmp_path, driver, lambda *args, **kwargs: logs.append((args, kwargs)))
    monkeypatch.setattr(hp, "_RUNTIME", runtime)
    app = FastAPI()
    app.include_router(hp.home_power_router)
    assert not app.dependency_overrides
    return SimpleNamespace(root=tmp_path, runtime=runtime, driver=driver, logs=logs, app=app, token=token)


def restart(surface, monkeypatch):
    surface.runtime = hp.HomePowerRuntime(surface.root, surface.driver,
                                        lambda *args, **kwargs: surface.logs.append((args, kwargs)))
    monkeypatch.setattr(hp, "_RUNTIME", surface.runtime)


def test_missing_fresh_stores_are_empty_without_read_side_effects(surface):
    for kind in KINDS:
        assert load(surface, kind) == []
        assert http(surface, "GET", "/" + kind).json() == {kind: []}
    assert not (surface.root / "home_power").exists()
    status = http(surface, "GET", "/status")
    assert status.status_code == 200
    assert status.json()["ok"] is True and status.json()["automation_ready"] is True


@pytest.mark.parametrize("kind", KINDS)
def test_missing_store_accepts_first_explicit_save_with_stable_id(surface, kind):
    response = upsert(surface, kind)
    assert response.status_code == 200, response.text
    assert load(surface, kind)[0][IDS[kind]] == row(kind)[IDS[kind]]
    assert len(load(surface, kind)) == 1


def test_first_explicit_automation_enable_establishes_history_before_enabled_store(surface, monkeypatch):
    path = seed(surface, "automations")
    original = os.replace
    committed = []
    def replace(source, destination):
        if Path(destination) == path:
            state = json.loads(path_for(surface, "runtime_state").read_text())
            assert state["last_game_present"] is False
            assert state["last_run_ts"] == {} and state["last_time_daily_fired"] == {}
            committed.append(True)
        return original(source, destination)
    monkeypatch.setattr(os, "replace", replace)
    response = http(surface, "POST", "/automations/enabled", {"automation_id": "automation-1", "enabled": True})
    assert response.status_code == 200 and committed == [True]
    assert load(surface, "automations")[0]["enabled"] is True


@pytest.mark.parametrize("kind", KINDS)
def test_observed_collection_disappearing_cannot_be_recreated_as_empty(surface, kind):
    path = seed(surface, kind)
    assert len(load(surface, kind)) == 1
    path.unlink()
    unavailable(lambda: load(surface, kind))
    assert upsert(surface, kind).status_code == 503
    assert not path.exists() and not surface.runtime._receipts_path.exists()


@pytest.mark.parametrize("existing", (False, True))
@pytest.mark.parametrize("invalid", ("duplicate", "coerced_number", "empty_id"))
def test_invalid_internal_automation_save_does_not_create_reservations_or_replace_data(surface, existing, invalid):
    path = path_for(surface, "automations")
    if existing:
        seed(surface, "automations")
    before = path.read_bytes() if existing else None
    value = row("automations", enabled=True)
    rows = [value]
    if invalid == "duplicate":
        rows.append(deepcopy(value))
    elif invalid == "coerced_number":
        value["cooldown_s"] = "600"
    else:
        value["automation_id"] = ""
    unavailable(lambda: surface.runtime.save_automations(rows))
    assert (path.read_bytes() if path.exists() else None) == before
    assert not path_for(surface, "runtime_state").exists()
    assert not surface.runtime._receipts_path.exists()


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("damage", ("empty", "truncated", "null", "array", "wrong_list", "scalar_row", "missing_id", "duplicate_id", "duplicate_key", "nonfinite"))
def test_damaged_collection_read_and_upsert_preserve_exact_bytes(surface, kind, damage):
    good = row(kind)
    records = {
        "empty": b"", "truncated": b'{"private":"Synthetic private metadata",',
        "null": b"null", "array": b"[]", "wrong_list": json.dumps({kind: {}}),
        "scalar_row": json.dumps({kind: [None]}),
        "missing_id": json.dumps({kind: [{key: value for key, value in good.items() if key != IDS[kind]}]}),
        "duplicate_id": json.dumps({kind: [good, deepcopy(good)]}),
        "duplicate_key": '{"' + kind + '": [], "' + kind + '": ' + json.dumps([good]) + '}',
        "nonfinite": json.dumps({kind: [good], "future": float("nan")}),
    }
    path = write_raw(surface, kind, records[damage])
    before = path.read_bytes()
    unavailable(lambda: load(surface, kind))
    response = http(surface, "GET", "/" + kind)
    assert response.status_code == 503 and PRIVATE not in response.text
    response = upsert(surface, kind)
    assert response.status_code == 503 and PRIVATE not in response.text
    assert path.read_bytes() == before
    assert not surface.runtime._receipts_path.exists()


@pytest.mark.parametrize("kind,field,value", [
    ("devices", "device_id", ""), ("devices", "relay", "0"),
    ("devices", "relay", True), ("devices", "capabilities", "switch.on"),
    ("scenes", "enabled", "false"), ("scenes", "actions", ["switch.off"]),
    ("scenes", "actions", [{"device_id": "lamp-1", "capability": "switch.destroy"}]),
    ("automations", "enabled", "false"), ("automations", "cooldown_s", "600"),
    ("automations", "trigger", "unknown"), ("automations", "time_hhmm", "27:99"),
])
def test_malformed_known_fields_are_not_coerced_or_dropped(surface, kind, field, value):
    path = seed(surface, kind, [row(kind, **{field: value})])
    before = path.read_bytes()
    unavailable(lambda: load(surface, kind))
    unavailable(lambda: save(surface, kind, [row(kind)]))
    assert path.read_bytes() == before


@pytest.mark.parametrize("kind", KINDS)
def test_bounded_reader_rejects_oversized_or_excess_rows_without_overwriting(surface, kind):
    raw = json.dumps({kind: [row(kind)]}).encode()
    path = write_raw(surface, kind, raw + b" " * (storage.MAX_BYTES + 1 - len(raw)))
    before = path.read_bytes()
    unavailable(lambda: load(surface, kind))
    assert upsert(surface, kind).status_code == 503
    assert path.read_bytes() == before
    seed(surface, kind, [row(kind, "entry-" + str(i)) for i in range(storage.MAX_ROWS + 1)])
    before = path.read_bytes()
    unavailable(lambda: load(surface, kind))
    assert upsert(surface, kind).status_code == 503
    assert path.read_bytes() == before


@pytest.mark.parametrize("kind", KINDS)
def test_unreadable_existing_collection_cannot_be_replaced_as_empty(surface, monkeypatch, kind):
    path = seed(surface, kind)
    before = path.read_bytes()
    original = Path.open
    def fail(target, *args, **kwargs):
        if target == path:
            raise PermissionError(PRIVATE)
        return original(target, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", fail)
        unavailable(lambda: load(surface, kind))
        assert upsert(surface, kind).status_code == 503
    assert path.read_bytes() == before
    assert not surface.runtime._receipts_path.exists()


@pytest.mark.parametrize("kind,route,method,body", [
    ("devices", "/devices/lamp-1", "DELETE", None),
    ("scenes", "/scenes/bootstrap", "POST", None),
    ("automations", "/automations/bootstrap", "POST", None),
    ("automations", "/automations/enabled", "POST", {"automation_id": "automation-1", "enabled": True}),
])
def test_secondary_mutation_paths_never_replace_corrupt_targets(surface, kind, route, method, body):
    path = write_raw(surface, kind, b'{"saved":')
    before = path.read_bytes()
    response = http(surface, method, route, body)
    assert response.status_code == 503
    assert path.read_bytes() == before
    assert not surface.runtime._receipts_path.exists()


@pytest.mark.parametrize("kind", KINDS)
def test_upsert_preserves_unknown_envelope_and_row_fields_and_unrelated_rows(surface, kind):
    first = row(kind, future={"format": 7, "private": PRIVATE})
    second = row(kind, "second", future={"keep": True})
    path = seed(surface, kind, [first, second], future_envelope={"version": 11}, original_id="retained")
    response = upsert(surface, kind, row(kind, name="Renamed"))
    assert response.status_code == 200, response.text
    value = json.loads(path.read_text())
    assert value["future_envelope"] == {"version": 11} and value["original_id"] == "retained"
    assert value[kind][0][IDS[kind]] == first[IDS[kind]]
    assert value[kind][0]["future"] == first["future"] and value[kind][0]["name"] == "Renamed"
    assert value[kind][1] == second


@pytest.mark.parametrize("update", ("omitted", "empty", "partial"))
def test_device_edit_preserves_saved_vendor_fields_when_extra_is_partial(surface, update):
    previous = {"username": "Synthetic user", "credential": "Synthetic token",
                "future_vendor": {"keep": True}, "target": "old"}
    seed(surface, "devices", [row("devices", extra=previous)])
    value = row("devices", name="Renamed")
    if update == "omitted":
        value.pop("extra")
    elif update == "partial":
        value["extra"] = {"target": "new"}
    response = upsert(surface, "devices", value)
    assert response.status_code == 200, response.text
    expected = {**previous, "target": "new"} if update == "partial" else previous
    assert load(surface, "devices")[0]["extra"] == expected


@pytest.mark.parametrize("field", ("time_hhmm", "after_hhmm"))
def test_legacy_empty_time_fields_remain_readable_without_normalizing_saved_bytes(surface, field):
    value = row("automations", **{field: ""})
    path = seed(surface, "automations", [value])
    before = path.read_bytes()
    assert load(surface, "automations") == [value]
    response = http(surface, "GET", "/automations")
    assert response.status_code == 200 and response.json()["automations"] == [value]
    assert path.read_bytes() == before


def test_dashboard_does_not_hide_damaged_homepower_inventory_with_legacy_registry(surface, monkeypatch):
    from routers.dashboard_presence import _smart_home_snapshot
    path = write_raw(surface, "devices", b'{"devices":')
    monkeypatch.setattr(S, "load_shelly_registry", lambda: pytest.fail("Damage must not select another inventory"))
    unavailable(_smart_home_snapshot)
    assert path.read_bytes() == b'{"devices":'


def test_dashboard_valid_empty_inventory_retains_legacy_registry_fallback(surface, monkeypatch):
    from routers.dashboard_presence import _smart_home_snapshot
    path = seed(surface, "devices", [])
    legacy = [{"id": "legacy-lamp", "name": "Legacy lamp", "ip": "192.0.2.20", "relay": 1}]
    monkeypatch.setattr(S, "load_shelly_registry", lambda: deepcopy(legacy))
    before = path.read_bytes()
    assert _smart_home_snapshot() == {"count": 1, "names": ["Legacy lamp"], "devices": legacy}
    assert path.read_bytes() == before


def test_scene_edit_preserves_nested_action_metadata_only_for_matching_action(surface):
    scene = row("scenes")
    scene["actions"][0]["future_action"] = {"audit": PRIVATE}
    seed(surface, "scenes", [scene])
    assert upsert(surface, "scenes", row("scenes", name="Renamed")).status_code == 200
    assert load(surface, "scenes")[0]["actions"][0]["future_action"] == {"audit": PRIVATE}
    changed = row("scenes", actions=[{"device_id": "lamp-1", "capability": "switch.on"}])
    assert upsert(surface, "scenes", changed).status_code == 200
    assert "future_action" not in load(surface, "scenes")[0]["actions"][0]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("boundary", ("fsync", "replace"))
def test_interrupted_collection_write_preserves_old_file_and_cleans_temporary(surface, monkeypatch, kind, boundary):
    path = seed(surface, kind, future_envelope={"keep": True})
    before = path.read_bytes()
    original_files = {item.name for item in path.parent.iterdir()}
    original = getattr(os, boundary)
    def fail(*args):
        if boundary == "fsync" or Path(args[1]) == path:
            raise OSError(PRIVATE)
        return original(*args)
    monkeypatch.setattr(os, boundary, fail)
    response = upsert(surface, kind, row(kind, name="Changed"))
    assert response.status_code == 503 and PRIVATE not in response.text
    assert path.read_bytes() == before
    assert {item.name for item in path.parent.iterdir()} == original_files
    assert not surface.runtime._receipts_path.exists()


@pytest.mark.parametrize("kind", KINDS)
def test_concurrent_disjoint_edits_keep_every_record_and_metadata(surface, kind):
    seed(surface, kind, [row(kind, "existing", future={"keep": True})], future_envelope={"keep": True})
    go = Event()
    def edit(index):
        assert go.wait(3)
        return upsert(surface, kind, row(kind, "new-" + str(index)))
    with ThreadPoolExecutor(8) as pool:
        pending = [pool.submit(edit, index) for index in range(8)]
        go.set()
        responses = [future.result(timeout=10) for future in pending]
    assert all(response.status_code == 200 for response in responses), [response.text for response in responses]
    rows = load(surface, kind)
    assert {item[IDS[kind]] for item in rows} == {"existing", *("new-" + str(i) for i in range(8))}
    assert next(item for item in rows if item[IDS[kind]] == "existing")["future"] == {"keep": True}
    assert json.loads(path_for(surface, kind).read_text())["future_envelope"] == {"keep": True}


@pytest.mark.parametrize("replacement", (b'{"damaged":', b'{"devices": [], "external_revision": 2}'))
def test_changed_file_during_write_preparation_is_preserved_instead_of_overwritten(surface, monkeypatch, replacement):
    path = seed(surface, "devices")
    original = os.fsync
    def change(descriptor):
        original(descriptor)
        path.write_bytes(replacement)
    monkeypatch.setattr(os, "fsync", change)
    response = upsert(surface, "devices", row("devices", name="Changed"))
    assert response.status_code == 503
    assert path.read_bytes() == replacement
    assert {item.name for item in path.parent.iterdir()} == {"devices.json"}


def test_concurrent_device_delete_and_unrelated_save_both_persist(surface):
    seed(surface, "devices", [row("devices", "delete-me"), row("devices", "keep-me", future={"keep": True})])
    go = Event()
    def remove():
        assert go.wait(3)
        return http(surface, "DELETE", "/devices/delete-me")
    def add():
        assert go.wait(3)
        return upsert(surface, "devices", row("devices", "new"))
    with ThreadPoolExecutor(2) as pool:
        pending = [pool.submit(remove), pool.submit(add)]
        go.set()
        assert [future.result(timeout=10).status_code for future in pending] == [200, 200]
    rows = load(surface, "devices")
    assert {item["device_id"] for item in rows} == {"keep-me", "new"}
    assert next(item for item in rows if item["device_id"] == "keep-me")["future"] == {"keep": True}


@pytest.mark.parametrize("raw", [
    b"", b"{", b"[]", b"null", b"{}",
    b'{"last_game_present":"false","last_time_daily_fired":{},"last_run_ts":{}}',
    b'{"last_game_present":false,"last_time_daily_fired":{},"last_run_ts":{"automation-1":NaN}}',
    b'{"last_game_present":false,"last_time_daily_fired":{},"last_run_ts":{"automation-1":-1}}',
    b'{"last_game_present":false,"last_time_daily_fired":{"automation-1":"not-a-date"},"last_run_ts":{}}',
    b'{"last_game_present":true,"last_game_present":false,"last_time_daily_fired":{},"last_run_ts":{}}',
])
def test_corrupt_runtime_state_pauses_automation_but_preserves_readable_inventory(surface, monkeypatch, raw):
    seed(surface, "devices")
    seed(surface, "scenes")
    seed(surface, "automations", [row("automations", enabled=True)])
    path = write_raw(surface, "runtime_state", raw)
    restart(surface, monkeypatch)
    before = path.read_bytes()
    assert http(surface, "GET", "/devices").json()["devices"][0]["device_id"] == "lamp-1"
    status = http(surface, "GET", "/status")
    assert status.status_code == 200 and status.json()["automation_ready"] is False
    assert status.json()["ok"] is False and PRIVATE not in status.text
    unavailable(surface.runtime._tick)
    try:
        surface.runtime.stop()
    except HTTPException as error:
        assert error.status_code == 503
    assert path.read_bytes() == before
    assert not surface.runtime._receipts_path.exists()


def test_missing_runtime_history_with_enabled_automation_is_not_a_fresh_install(surface, monkeypatch):
    seed(surface, "devices")
    seed(surface, "scenes")
    seed(surface, "automations", [row("automations", enabled=True)])
    restart(surface, monkeypatch)
    unavailable(surface.runtime._tick)
    assert http(surface, "GET", "/status").json()["automation_ready"] is False
    assert not path_for(surface, "runtime_state").exists()
    assert len(load(surface, "devices")) == 1


def automation_setup(surface, monkeypatch, *, trigger="game_started", count=1):
    seed(surface, "devices")
    seed(surface, "scenes")
    seed(surface, "automations", [row("automations", "auto-" + str(index), enabled=True, trigger=trigger,
                                     cooldown_s=0, time_hhmm="20:15" if trigger == "time_daily" else None)
                                   for index in range(count)])
    persist(surface, "runtime_state", {"last_game_present": False, "last_time_daily_fired": {},
                                       "last_run_ts": {}, "future_runtime": {"keep": True}})
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 15, 20, 15, tzinfo=tz)
    monkeypatch.setattr(hp, "datetime", Clock)
    monkeypatch.setattr(hp, "games_detect_best", lambda: {"game": {"name": "Synthetic game"}})
    restart(surface, monkeypatch)


@pytest.mark.parametrize("trigger", ("time_daily", "game_started"))
def test_automation_reserves_history_before_dispatch_and_does_not_repeat_after_restart(surface, monkeypatch, trigger):
    automation_setup(surface, monkeypatch, trigger=trigger, count=2)
    calls = []
    def execute(**kwargs):
        state = json.loads(path_for(surface, "runtime_state").read_text())
        assert state["future_runtime"] == {"keep": True}
        assert state["last_run_ts"], "A device ran before cooldown history was durable"
        if trigger == "time_daily":
            assert state["last_time_daily_fired"], "A daily action ran before its reservation was durable"
        else:
            assert state["last_game_present"] is True
        calls.append(kwargs)
        return {"ok": True}
    surface.driver.turn_off = execute
    surface.runtime._tick()
    assert len(calls) == 2
    restart(surface, monkeypatch)
    surface.runtime._tick()
    assert len(calls) == 2
    assert json.loads(path_for(surface, "runtime_state").read_text())["future_runtime"] == {"keep": True}


def test_inventory_damage_after_one_dispatch_stops_remaining_steps_and_pending_automations(surface, monkeypatch):
    automation_setup(surface, monkeypatch, count=2)
    path = seed(surface, "devices", [row("devices", "lamp-" + str(index), ip="192.0.2." + str(index + 10))
                                      for index in range(1, 4)])
    before = path.read_bytes()
    seed(surface, "scenes", [row("scenes", actions=[{"device_id": "lamp-" + str(index), "capability": "switch.off"}
                                                    for index in range(1, 4)])])
    calls = []
    def execute(**kwargs):
        calls.append(kwargs)
        path.write_bytes(b'{"damaged":')
        return {"ok": True, "summary": "Synthetic command accepted"}
    surface.driver.turn_off = execute
    unavailable(surface.runtime._tick)
    assert len(calls) == 1
    assert surface.runtime._automation_error is not None
    receipts = surface.runtime.read_receipts()
    assert len(receipts) == 1 and receipts[0]["kind"] == "scene_run"
    evidence = receipts[0]["extra"]
    assert evidence["ok"] is False and evidence["state_unavailable"] is True and evidence["dispatched"] == 1
    assert evidence["results"] == [{"device_id": "lamp-1", "capability": "switch.off", "ok": True,
                                    "summary": "Synthetic command accepted"}]
    assert path.read_bytes() == b'{"damaged":'
    path.write_bytes(before)
    unavailable(surface.runtime._tick)
    assert len(calls) == 1 and len(surface.runtime.read_receipts()) == 1


@pytest.mark.parametrize("outage", ("absent", "exception", "no_result", "filter_missing", "failed", "error", "missing_field"))
def test_game_detector_outage_and_recovery_do_not_create_a_false_rising_edge(surface, monkeypatch, outage):
    automation_setup(surface, monkeypatch)
    calls = []
    def execute(**kwargs):
        calls.append(kwargs)
        return {"ok": True}
    surface.driver.turn_off = execute
    surface.runtime._tick()
    assert len(calls) == 1
    path = path_for(surface, "runtime_state")
    before = path.read_bytes()
    def fail():
        raise OSError("Synthetic detector unavailable")
    unavailable_results = {
        "no_result": None,
        "filter_missing": {"game": None, "filter": {"reason": "psutil_missing"}},
        "failed": {"game": None, "ok": False},
        "error": {"game": None, "error": "Synthetic detector unavailable"},
        "missing_field": {"ok": True},
    }
    detector = None if outage == "absent" else fail if outage == "exception" else lambda: unavailable_results[outage]
    monkeypatch.setattr(hp, "games_detect_best", detector)
    surface.runtime._tick()
    assert path.read_bytes() == before and surface.runtime._last_game_present is True
    restart(surface, monkeypatch)
    monkeypatch.setattr(hp, "games_detect_best", lambda: {"game": {"name": "Synthetic game"}})
    surface.runtime._tick()
    assert len(calls) == 1
    # A successful observation that the game stopped can establish a new edge.
    monkeypatch.setattr(hp, "games_detect_best", lambda: {"game": None, "filter": {"reason": "no_store_games_running"}})
    surface.runtime._tick()
    monkeypatch.setattr(hp, "games_detect_best", lambda: {"game": {"name": "Synthetic game"}})
    surface.runtime._tick()
    assert len(calls) == 2


@pytest.mark.parametrize("boundary", ("fsync", "replace"))
def test_failed_automation_reservation_never_dispatches_and_latches_pause(surface, monkeypatch, boundary):
    automation_setup(surface, monkeypatch)
    path = path_for(surface, "runtime_state")
    before = path.read_bytes()
    original = getattr(os, boundary)
    def fail(*args):
        if boundary == "fsync" or Path(args[1]) == path:
            raise OSError(PRIVATE)
        return original(*args)
    with monkeypatch.context() as patch:
        patch.setattr(os, boundary, fail)
        unavailable(surface.runtime._tick)
    assert path.read_bytes() == before
    unavailable(surface.runtime._tick)
    status = http(surface, "GET", "/status")
    assert status.json()["automation_ready"] is False and PRIVATE not in status.text
    assert not surface.runtime._receipts_path.exists()


def test_late_reservation_replace_error_cannot_replay_after_restart(surface, monkeypatch):
    automation_setup(surface, monkeypatch)
    path = path_for(surface, "runtime_state")
    original = os.replace
    def fail_late(source, destination):
        result = original(source, destination)
        if Path(destination) == path:
            raise OSError(PRIVATE)
        return result
    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", fail_late)
        unavailable(surface.runtime._tick)
    state = json.loads(path.read_text())
    assert state["last_game_present"] is True and state["last_run_ts"]
    assert not surface.runtime._receipts_path.exists()
    restart(surface, monkeypatch)
    surface.runtime._tick()
    assert not surface.runtime._receipts_path.exists()


def test_observed_runtime_history_disappearing_pauses_without_recreation(surface, monkeypatch):
    automation_setup(surface, monkeypatch)
    path = path_for(surface, "runtime_state")
    path.unlink()
    unavailable(surface.runtime._tick)
    assert http(surface, "GET", "/status").json()["automation_ready"] is False
    assert not path.exists() and not surface.runtime._receipts_path.exists()


@pytest.mark.parametrize("kind", (*KINDS, "runtime_state"))
def test_tick_revalidates_every_store_before_any_device_action(surface, monkeypatch, kind):
    automation_setup(surface, monkeypatch)
    path = write_raw(surface, kind, b'{"damaged":')
    before = path.read_bytes()
    unavailable(surface.runtime._tick)
    assert path.read_bytes() == before
    assert not surface.runtime._receipts_path.exists()

