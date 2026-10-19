import copy
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
import tli_state as S
import device_commands as commands
from action_results import driver_succeeded
from routers import shelly_routes as shelly, home_power as hp

IP = "192.0.2.10"


@pytest.fixture(autouse=True)
def controls(monkeypatch):
    rows = [{"ip": IP, "relay": 0, "name": "Left", "id": "left", "aliases": ["reading"], "custom": {"keep": 1}},
            {"ip": IP, "relay": 1, "name": "Right", "id": "right", "room": "Office"}]
    calls = []
    def save(value, **kwargs):
        rows[:] = copy.deepcopy(value)
    def action(**kw):
        calls.append(kw)
        return {"raw": {"was_on": False}, "summary": "status loaded"}
    driver = SimpleNamespace(turn_on=action, turn_off=action, toggle=action,
                             get_status=lambda **kw: {"raw": {"switch:0": {"output": False}, "switch:1": {"output": True}}, "summary": "Status"})
    monkeypatch.setattr(S, "load_shelly_registry", lambda: copy.deepcopy(rows))
    monkeypatch.setattr(S, "save_shelly_registry", save)
    monkeypatch.setattr(S, "shelly_driver", driver)
    monkeypatch.setattr(shelly, "shelly_device_info_cached", lambda _: {"ok": True})
    device = {"device_id": "right", "vendor": "shelly", "ip": IP, "relay": 1}
    runtime = SimpleNamespace(_find_device=lambda ident: device if ident == "right" else None,
                              _driver_registry={}, shelly_driver=driver, load_devices=lambda: [device])
    monkeypatch.setattr(hp, "get_runtime", lambda: runtime)
    monkeypatch.setattr(commands, "_running", set())
    monkeypatch.setattr(commands, "_requests", {})
    import license
    monkeypatch.setattr(license, "has_feature", lambda *args: True)
    return rows, calls, driver, runtime


def test_registry_merge_preserves_other_relays_ids_and_metadata(controls, browser_client):
    rows, _, _, _ = controls
    response = browser_client.post('/homeauto/devices', json={"merge": True, "devices": [{"ip": IP, "relay": 1, "name": "Desk"}]})
    assert response.status_code == 200
    assert len(rows) == 2 and rows[0]["aliases"] == ["reading"]
    assert rows[0]["custom"] == {"keep": 1}
    assert rows[1]["id"] == "right" and rows[1]["room"] == "Office"
    assert rows[1]["name"] == "Desk"


def test_legacy_registry_name_only_uses_unique_existing_relay(controls, browser_client):
    rows, _, _, _ = controls
    rows.pop(0)
    r = browser_client.post('/homeauto/devices', json={"devices": [{"ip": IP, "name": "Renamed"}]})
    assert r.status_code == 200 and rows[0]["relay"] == 1 and rows[0]["id"] == "right"


@pytest.mark.parametrize('bad', [[{"ip": IP, "name": "Ambiguous"}],
    [{"ip": IP, "relay": 1}, {"ip": IP, "relay": 1}], [{"ip": IP, "relay": -1}], [{"ip": IP, "relay": "one"}]])
def test_invalid_registry_batch_writes_nothing(controls, browser_client, bad):
    rows, calls, _, _ = controls
    before = copy.deepcopy(rows)
    r = browser_client.post('/homeauto/devices', json={"merge": True, "devices": [{"ip": "192.0.2.20", "name": "New"}, *bad]})
    assert r.status_code in (409, 422) and rows == before and calls == []


def test_address_only_action_and_status_reject_shared_relays(controls, browser_client):
    assert browser_client.post('/shelly/relay', json={"ip": IP, "action": "on"}).status_code == 409
    assert browser_client.get('/shelly/status', params={"ip": IP}).status_code == 409
    assert controls[1] == []


def test_shelly_and_homepower_return_the_requested_relay_state(browser_client):
    for relay, on in ((0, False), (1, True)):
        r = browser_client.get('/shelly/status', params={"ip": IP, "relay": relay}).json()
        assert r['ok'] is True and r['on'] is on and r['relay'] == relay
    assert browser_client.get('/homepower/devices/right/status').json()['on'] is True


@pytest.mark.parametrize('output', [{"raw": {}}, {"raw": {"switch:0": {"output": False}}},
    {"ok": True, "raw": {"error": "rejected", "switch:1": {"output": True}}}, {"raw": {"switch:1": {"output": "false"}}}])
def test_missing_or_invalid_requested_relay_is_unknown(controls, browser_client, output):
    controls[2].get_status = lambda **kw: output
    for url in ('/shelly/status?ip='+IP+'&relay=1', '/homepower/devices/right/status'):
        r = browser_client.get(url).json()
        assert r['ok'] is False and r['on'] is None


def test_command_ack_is_distinct_from_state_and_replay_does_not_execute(controls, browser_client):
    body = {"ip": IP, "relay": 1, "action": "toggle", "request_id": "a"*32}
    first = browser_client.post('/shelly/relay', json=body).json()
    assert first['ok'] and first['outcome'] == 'accepted' and 'status reading' in first['summary']
    assert browser_client.post('/shelly/relay', json=body).json() == first
    assert controls[1] == [{"ip": IP, "relay": 1}]
    conflict = browser_client.post('/shelly/relay', json={**body, "relay": 0})
    assert conflict.status_code == 409 and len(controls[1]) == 1


def test_homepower_legacy_shelly_command_gets_truthful_ok(controls, browser_client):
    r = browser_client.post('/homepower/devices/right/execute', json={"capability": "switch.off", "request_id": "b"*32}).json()
    assert r['ok'] is True and controls[1] == [{"ip": IP, "relay": 1}]


@pytest.mark.parametrize('output', [{"ok": False, "summary": "rejected"}, {"ok": True, "raw": {"error": "rejected"}}, None])
def test_driver_failures_never_become_success(controls, browser_client, output):
    controls[2].turn_on = lambda **kw: output
    r = browser_client.post('/shelly/relay', json={"ip": IP, "relay": 1, "action": "on"}).json()
    assert r['ok'] is False and r['outcome'] == 'failed'
    assert not driver_succeeded(output)


def test_transport_failure_is_unconfirmed_and_cached_without_retry(controls, browser_client):
    def fail(**kw):
        controls[1].append(kw)
        raise TimeoutError('possibly delivered')
    controls[2].toggle = fail
    body = {"ip": IP, "relay": 1, "action": "toggle", "request_id": "c"*32}
    first = browser_client.post('/shelly/relay', json=body).json()
    assert first['ok'] is False and first['outcome'] == 'unknown'
    assert browser_client.post('/shelly/relay', json=body).json() == first
    assert len(controls[1]) == 1


def test_concurrent_commands_share_a_lock_across_panel_endpoints(controls):
    entered, release = threading.Event(), threading.Event()
    def wait(**kw):
        controls[1].append(kw); entered.set(); assert release.wait(3)
        return {"raw": {"was_on": False}}
    controls[2].turn_on = wait
    outcomes = []
    thread = threading.Thread(target=lambda: outcomes.append(shelly.shelly_relay(shelly.ShellyRelayRequest(ip=IP, relay=1, action='on', request_id='d'*32), user='alice')))
    thread.start(); assert entered.wait(2)
    try:
        with pytest.raises(HTTPException) as busy:
            hp.execute_device('right', hp.ExecuteDeviceRequest(capability='switch.off'), _s='alice')
        assert busy.value.status_code == 409
        with pytest.raises(HTTPException):
            shelly.shelly_relay(shelly.ShellyRelayRequest(ip=IP, relay=1, action='on', request_id='d'*32), user='alice')
        assert len(controls[1]) == 1
    finally:
        release.set(); thread.join(3)
    assert outcomes[0]['ok'] is True


def test_request_cache_is_bounded_and_does_not_launch_on_full(monkeypatch):
    monkeypatch.setattr(commands, '_requests', {('alice', str(i)): {'result': {}, 'at': commands.time.monotonic()} for i in range(512)})
    with pytest.raises(HTTPException) as error:
        commands.run('alice', ('device', 1), 'on', 'e'*32, lambda: pytest.fail('must not execute'))
    assert error.value.status_code == 429


@pytest.mark.parametrize('method,url,body', [('post','/shelly/relay',{'ip': IP, 'action':'on','relay':1}),
    ('get','/shelly/status?ip='+IP+'&relay=1',None), ('post','/homeauto/devices',{'devices':[]}),
    ('post','/homepower/devices/right/execute',{'capability':'switch.on'}), ('get','/homepower/devices/right/status',None)])
def test_home_control_endpoints_require_session(browser_client, monkeypatch, controls, method, url, body):
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled':True})
    browser_client.cookies.clear()
    r = getattr(browser_client, method)(url, **({'json':body} if body is not None else {}))
    assert r.status_code == 401 and controls[1] == []
