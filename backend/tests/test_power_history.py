"""Passive meter history: exact relay/registry binding and absent readings."""
import copy
from types import SimpleNamespace
import pytest
import tli_state as S
from intelligence import power_history as P, devices
from drivers.shelly import ShellyDriver


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    device = {"id": "relay-b", "address": "192.0.2.9", "relay": 1, "kind": "smart_device", "vendor": "shelly"}
    monkeypatch.setattr(devices, "inventory", lambda: {"devices": [copy.deepcopy(device)]})
    P._history.clear()
    yield device
    P._history.clear()


def raw(**fields):
    return {"switch:0": {"apower": 9999}, "switch:1": {"output": True, "apower": 0, **fields}}


def test_driver_records_existing_request_once_no_additional_network(isolated, monkeypatch):
    calls = []
    driver = ShellyDriver()
    monkeypatch.setattr(driver, "_get_json", lambda url: calls.append(url) or raw(voltage=120, current=0.5, aenergy={"total": 123}))
    value = driver.get_status("192.0.2.9", 1)
    rows = P.view(isolated)["items"]
    assert len(calls) == 1 and value["relay"] == 1
    assert rows[0]["watts"] == 0 and rows[0]["volts"] == 120 and rows[0]["energy_counter_wh"] == 123
    assert rows[0]["seconds_since_previous"] is None
    assert not list(__import__("pathlib").Path(S.DATA_DIR).rglob("*"))
    P.view(isolated)
    assert len(calls) == 1


def test_unknown_wrong_relay_errors_booleans_nan_never_zero(isolated):
    target = P.binding("192.0.2.9", 1)
    for value in [None, {"switch:0": {"apower": 45}}, raw(apower=True, current=float("nan"), voltage=-1),
                  raw(apower=10, errors=["overvoltage"])]:
        P.record(target, value)
    result = P.view(isolated)
    assert result["sample_count"] == 4 and result["watts_samples"] == 0
    assert all(row["watts"] is None for row in result["items"])
    assert all(row["status"] == "unavailable" for row in result["items"])


def test_failed_request_preserves_previous_reading_and_records_gap(isolated, monkeypatch):
    clock = [10.0]
    monkeypatch.setattr(P.time, "monotonic", lambda: clock[0])
    driver = ShellyDriver()
    monkeypatch.setattr(driver, "_get_json", lambda url: raw(apower=35))
    driver.get_status("192.0.2.9", 1)
    clock[0] += 300
    def fail(url):
        raise RuntimeError("Disconnected")
    monkeypatch.setattr(driver, "_get_json", fail)
    with pytest.raises(RuntimeError):
        driver.get_status("192.0.2.9", 1)
    rows = P.view(isolated)["items"]
    assert rows[0]["watts"] == 35 and rows[1]["watts"] is None
    assert rows[1]["seconds_since_previous"] == 300 and rows[1]["status"] == "unavailable"


def test_target_replacement_during_request_and_duplicate_registration_do_not_retarget(isolated, monkeypatch):
    target = P.binding("192.0.2.9", 1)
    replacement = {**isolated, "id": "replacement"}
    monkeypatch.setattr(devices, "inventory", lambda: {"devices": [replacement]})
    P.record(target, raw(apower=100))
    assert not P.view(replacement)["items"]
    monkeypatch.setattr(devices, "inventory", lambda: {"devices": [isolated, replacement]})
    assert P.binding("192.0.2.9", 1) is None
    P.record(None, raw())
    assert not P.view(isolated)["items"]


def test_address_and_relay_change_hides_old_target_readings(isolated):
    P.record(P.binding("192.0.2.9", 1), raw())
    assert P.view(isolated)["items"]
    assert not P.view({**isolated, "address": "192.0.2.8"})["items"]
    assert not P.view({**isolated, "relay": 0})["items"]
    assert P.view({**isolated, "vendor": "hue"})["status"] == "unavailable"


def test_sample_and_time_limits_and_counter_reset_are_literal(isolated, monkeypatch):
    clock = [10.0]
    monkeypatch.setattr(P.time, "monotonic", lambda: clock[0])
    target = P.binding("192.0.2.9", 1)
    for index in range(P.MAX_SAMPLES + 3):
        clock[0] += 1
        P.record(target, raw(apower=-3, aenergy={"total": 0 if index > 1 else 100}))
    value = P.view(isolated)
    assert value["sample_count"] == P.MAX_SAMPLES and value["items"][-1]["energy_counter_wh"] == 0
    assert value["items"][-1]["watts"] == -3
    assert "consumption" not in value
    clock[0] += P.RETENTION_SECONDS + 1
    assert P.view(isolated)["status"] == "empty" and not P._history


def test_target_cap_and_data_directory_isolation(isolated, monkeypatch, tmp_path):
    entries = [{**isolated, "id": f"target-{n}", "address": f"192.0.2.{n+1}"} for n in range(P.MAX_TARGETS + 1)]
    monkeypatch.setattr(devices, "inventory", lambda: {"devices": entries})
    for row in entries:
        P.record(P.binding(row["address"], 1), raw())
    assert len(P._history) == P.MAX_TARGETS and not P.view(entries[0])["items"]
    assert P.view(entries[-1])["items"]
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "another-install"))
    assert not P.view(entries[-1])["items"]


def test_status_history_does_not_turn_on_off_or_record_actions(isolated, monkeypatch):
    driver = ShellyDriver()
    monkeypatch.setattr(driver, "_get_json", lambda *a, **kw: {"was_on": True})
    driver.turn_on("192.0.2.9", 1)
    driver.toggle("192.0.2.9", 1)
    assert not P.view(isolated)["items"]
