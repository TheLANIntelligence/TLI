from types import SimpleNamespace

import pytest
from routers.home_power import HomePowerRuntime


@pytest.mark.parametrize("second, expected", [
    ({"raw": {"was_on": True}, "summary": "acknowledged"}, True),
    ({"raw": {"error": "device rejected the command"}}, False),
    ({"ok": False, "summary": "device unreachable"}, False),
])
def test_legacy_scene_acknowledgements_and_partial_failures(tmp_path, second, expected):
    responses = iter([{"raw": {"was_on": True}, "summary": "acknowledged"}, second])
    calls = []
    def turn_off(**kwargs):
        calls.append(kwargs)
        return next(responses)
    runtime = HomePowerRuntime(tmp_path, SimpleNamespace(turn_off=turn_off), lambda *a, **kw: None)
    runtime.save_devices([{"device_id": "one", "vendor": "shelly", "ip": "192.168.1.10", "relay": 1},
                          {"device_id": "two", "vendor": "shelly", "ip": "192.168.1.11", "relay": 2}])
    runtime.save_scenes([{"scene_id": "evening", "name": "Evening", "actions": [
        {"device_id": "one", "capability": "switch.off"}, {"device_id": "two", "capability": "switch.off"}]}])
    result = runtime.run_scene("evening")
    assert result["ok"] is expected
    assert [row["ok"] for row in result["results"]] == [True, expected]
    assert calls == [{"ip": "192.168.1.10", "relay": 1}, {"ip": "192.168.1.11", "relay": 2}]
    receipt = runtime.read_receipts()[0]["extra"]
    assert receipt["ok"] is expected
    assert receipt["results"] == result["results"]
