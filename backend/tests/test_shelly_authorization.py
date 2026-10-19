"""Shelly browser authority with synthetic devices, queued probes and temp files."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import device_commands
import license
import tli_state as S
from routers import home_power
from routers import shelly_routes as shelly


IP = "192.0.2.10"
PRIVATE_REQUESTS = [
    ("GET", "/homeauto/devices", None),
    ("POST", "/homeauto/devices", {"devices": [{"ip": IP, "relay": 1, "name": "Private lamp"}]}),
    ("GET", "/shelly/discover?subnet=192.0.2.0/30", None),
    ("GET", "/shelly/status?ip=" + IP + "&relay=1", None),
    ("POST", "/shelly/relay", {"ip": IP, "relay": 1, "action": "on", "request_id": "a" * 32}),
]


@pytest.fixture
def house(monkeypatch, tmp_path):
    registry = tmp_path / "shelly.json"
    registry.write_text(json.dumps([{"ip": IP, "relay": 1, "name": "Private lamp", "id": "saved-id",
                                     "aliases": ["reading light"], "custom": {"preserve": True}}]), encoding="utf-8")
    read = Mock(side_effect=lambda: json.loads(registry.read_text(encoding="utf-8")))
    save = Mock(side_effect=lambda rows, **kwargs: registry.write_text(json.dumps(rows), encoding="utf-8"))
    monkeypatch.setattr(S, "load_shelly_registry", read)
    monkeypatch.setattr(S, "save_shelly_registry", save)
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": False}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    monkeypatch.setattr(S, "log_debug", Mock())
    monkeypatch.setattr(home_power, "get_runtime", lambda: SimpleNamespace(load_devices=lambda: []))
    monkeypatch.setattr(license, "has_feature", lambda *args: True)
    monkeypatch.setattr(license, "get_active_tier", lambda: "pro")
    driver = SimpleNamespace(
        get_status=Mock(return_value={"ok": True, "raw": {"switch:1": {"output": True}}, "summary": "Private live state"}),
        turn_on=Mock(return_value={"raw": {"was_on": False}}),
        turn_off=Mock(return_value={"raw": {"was_on": True}}),
        toggle=Mock(return_value={"raw": {"was_on": False}}),
    )
    monkeypatch.setattr(S, "shelly_driver", driver)
    info = Mock(return_value={"ok": True, "model": "Private model"})
    monkeypatch.setattr(shelly, "shelly_device_info_cached", info)
    network = Mock(side_effect=AssertionError("Live network is forbidden"))
    monkeypatch.setattr(shelly.requests, "get", network)
    lan = Mock(return_value="192.0.2.9")
    probe = Mock(side_effect=lambda ip: {"ip": ip, "name": "Private discovered device"})
    monkeypatch.setattr(shelly, "_get_lan_ip", lan)
    monkeypatch.setattr(shelly, "_probe_shelly_ip", probe)
    monkeypatch.setattr(device_commands, "_requests", {})
    monkeypatch.setattr(device_commands, "_running", set())
    futures, pools = [], []
    class Future:
        def __init__(self, fn, args):
            self.fn, self.args, self.cancelled = fn, args, False
        def result(self):
            assert not self.cancelled
            return self.fn(*self.args)
        def cancel(self):
            self.cancelled = True
    class Pool:
        def __init__(self, **kwargs):
            pools.append(kwargs)
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def submit(self, fn, *args):
            future = Future(fn, args); futures.append(future); return future
    monkeypatch.setattr(shelly, "ThreadPoolExecutor", Pool)
    monkeypatch.setattr(shelly, "as_completed", lambda values: iter(values))
    app = FastAPI(); app.include_router(shelly.router)
    clients = []
    def browser(*, enabled=False, remote=False, authenticated=False, secure=True):
        pin["enabled"] = enabled
        origin = ("https" if secure else "http") + "://192.0.2.9:8443" if remote else "http://localhost:8000"
        client = TestClient(app, base_url=origin, client=("192.0.2.20" if remote else "127.0.0.1", 1234),
                            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})
        token = S.create_session_token("alice") if authenticated else None
        if token:
            client.headers["Cookie"] = "tli_session=" + token
        clients.append(client); return client, token
    yield SimpleNamespace(browser=browser, registry=registry, read=read, save=save, driver=driver,
                          info=info, pin=pin, lan=lan, probe=probe, pools=pools, futures=futures, network=network)
    for client in clients:
        client.close()
    network.assert_not_called()


def request(client, item, **kwargs):
    method, path, body = item
    return client.request(method, path, **({"json": body} if body is not None else {}), **kwargs)


@pytest.mark.parametrize("item", PRIVATE_REQUESTS, ids=[method + " " + path for method, path, _ in PRIVATE_REQUESTS])
@pytest.mark.parametrize("mode", ["pin-anonymous", "pin-off-lan", "cross-origin", "proxy", "bearer", "peer", "stale-cookie", "remote-http"])
def test_private_routes_deny_before_inventory_or_device_effects(house, item, mode):
    remote = mode in {"pin-off-lan", "remote-http"}
    client, token = house.browser(enabled=mode not in {"pin-off-lan", "stale-cookie"}, remote=remote,
                                  authenticated=mode not in {"pin-anonymous", "pin-off-lan"}, secure=mode != "remote-http")
    headers = {}
    if mode == "cross-origin": headers["Origin"] = "https://unrelated.invalid"
    if mode == "proxy": headers["X-Forwarded-For"] = "127.0.0.1"
    if mode == "bearer": headers["Authorization"] = "Bearer synthetic-device-credential"
    if mode == "peer": headers["X-TLI-Peer-Signature"] = "synthetic"
    if mode == "stale-cookie": S.revoke_session_token(token)
    before = house.registry.read_bytes()
    result = request(client, item, headers=headers)
    assert result.status_code == (401 if mode in {"pin-anonymous", "stale-cookie"} else 403), result.text
    assert result.headers["cache-control"] == "no-store"
    for mock in (house.read, house.save, house.lan, house.probe, house.info, *vars(house.driver).values()):
        mock.assert_not_called()
    assert not house.pools and house.registry.read_bytes() == before


@pytest.mark.parametrize("item", PRIVATE_REQUESTS, ids=[method + " " + path for method, path, _ in PRIVATE_REQUESTS])
@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https-lan"])
def test_real_browser_contracts_remain_available(house, item, mode):
    client, _ = house.browser(enabled=mode != "open-local", remote=mode == "pin-https-lan", authenticated=mode != "open-local")
    result = request(client, item)
    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    body = result.json()
    if item[1].startswith("/shelly/discover"):
        assert body["scanned"] == 2 and len(body["found"]) == 2 and len(house.pools) == 1
    elif item[1].startswith("/shelly/status"):
        assert body["on"] is True and body["relay"] == 1
    elif item[1] == "/shelly/relay":
        assert body["outcome"] == "accepted" and "status reading" in body["summary"]
        house.driver.turn_on.assert_called_once_with(ip=IP, relay=1)
    else:
        assert body["devices"][0]["custom"] == {"preserve": True}


@pytest.mark.parametrize("item", [PRIVATE_REQUESTS[1], PRIVATE_REQUESTS[4]])
def test_mutations_require_explicit_matching_browser_origin(house, item):
    client, _ = house.browser(); del client.headers["Origin"]
    result = request(client, item)
    assert result.status_code == 403
    house.read.assert_not_called(); house.save.assert_not_called(); house.driver.turn_on.assert_not_called()


def test_revoked_inventory_read_never_returns_private_rows(house):
    client, token = house.browser(enabled=True, authenticated=True)
    def revoked():
        S.revoke_session_token(token)
        return [{"name": "PRIVATE SAVED NAME"}]
    house.read.side_effect = revoked
    result = client.get("/homeauto/devices")
    assert result.status_code == 401 and "PRIVATE SAVED NAME" not in result.text


def test_revocation_during_registry_target_resolution_writes_nothing(house, monkeypatch):
    client, token = house.browser(enabled=True, authenticated=True)
    before = house.registry.read_bytes()
    def target(*args):
        S.revoke_session_token(token); return 1
    monkeypatch.setattr(shelly, "_target_relay", target)
    result = request(client, PRIVATE_REQUESTS[1])
    assert result.status_code == 401 and house.registry.read_bytes() == before
    house.save.assert_not_called()


def test_revocation_after_registry_commit_withholds_result_without_repeating_write(house):
    client, token = house.browser(enabled=True, authenticated=True)
    save = house.save.side_effect
    def committed(rows, **kwargs):
        save(rows); S.revoke_session_token(token)
    house.save.side_effect = committed
    result = client.post("/homeauto/devices", json={"devices": [{"ip": IP, "relay": 1, "name": "PRIVATE NEW NAME"}]})
    assert result.status_code == 401 and "PRIVATE NEW NAME" not in result.text
    assert json.loads(house.registry.read_text())[0]["name"] == "PRIVATE NEW NAME"
    assert house.save.call_count == 1


@pytest.mark.parametrize("phase", ["status", "info"])
def test_status_revocation_stops_followup_or_private_disclosure(house, phase):
    client, token = house.browser(enabled=True, authenticated=True)
    def revoked(**kwargs):
        S.revoke_session_token(token)
        return {"raw": {"switch:1": {"output": True}}, "summary": "PRIVATE LIVE RESULT"}
    if phase == "status": house.driver.get_status.side_effect = revoked
    else: house.info.side_effect = lambda ip: revoked()
    result = request(client, PRIVATE_REQUESTS[3])
    assert result.status_code == 401 and "PRIVATE LIVE RESULT" not in result.text
    if phase == "status": house.info.assert_not_called()


def test_revocation_at_dispatch_sends_no_driver_command(house, monkeypatch):
    client, token = house.browser(enabled=True, authenticated=True)
    original = shelly.run_command
    def delayed(*args):
        S.revoke_session_token(token)
        return original(*args)
    monkeypatch.setattr(shelly, "run_command", delayed)
    result = request(client, PRIVATE_REQUESTS[4])
    assert result.status_code == 401
    house.driver.turn_on.assert_not_called()


def test_revocation_after_dispatch_keeps_internal_receipt_but_never_discloses_or_repeats(house):
    client, token = house.browser(enabled=True, authenticated=True)
    def dispatched(**kwargs):
        S.revoke_session_token(token); return {"raw": {"was_on": False}, "private": "PRIVATE DEVICE RECEIPT"}
    house.driver.turn_on.side_effect = dispatched
    result = request(client, PRIVATE_REQUESTS[4])
    assert result.status_code == 401 and "PRIVATE DEVICE RECEIPT" not in result.text
    assert device_commands._requests[("alice", "a" * 32)]["result"]["outcome"] == "accepted"
    assert house.driver.turn_on.call_count == 1


def test_replay_requires_current_browser_authority_and_never_reexecutes(house):
    client, token = house.browser(enabled=True, authenticated=True)
    first = request(client, PRIVATE_REQUESTS[4])
    assert first.status_code == 200
    assert request(client, PRIVATE_REQUESTS[4]).json() == first.json()
    S.revoke_session_token(token)
    assert request(client, PRIVATE_REQUESTS[4]).status_code == 401
    assert house.driver.turn_on.call_count == 1


def test_discovery_revocation_cancels_unstarted_probes_and_hides_partial_results(house):
    client, token = house.browser(enabled=True, authenticated=True)
    def found(ip):
        S.revoke_session_token(token)
        return {"ip": ip, "name": "PRIVATE DISCOVERED NAME"}
    house.probe.side_effect = found
    result = request(client, PRIVATE_REQUESTS[2])
    assert result.status_code == 401 and "PRIVATE DISCOVERED NAME" not in result.text
    assert house.probe.call_count == 1 and all(future.cancelled for future in house.futures)


def test_discovery_rechecks_queued_worker_before_its_first_network_probe(house, monkeypatch):
    client, token = house.browser(enabled=True, authenticated=True)
    def revoked_iteration(futures):
        S.revoke_session_token(token)
        for future in futures:
            with pytest.raises(HTTPException) as error:
                future.result()
            assert error.value.status_code == 401
        return iter(futures)
    monkeypatch.setattr(shelly, "as_completed", revoked_iteration)
    result = request(client, PRIVATE_REQUESTS[2])
    assert result.status_code == 401
    house.probe.assert_not_called()
    assert all(future.cancelled for future in house.futures)


def test_pin_change_stops_original_open_local_authority(house):
    client, _ = house.browser()
    def changed(**kwargs):
        house.pin["enabled"] = True
        return {"raw": {"switch:1": {"output": True}}, "summary": "PRIVATE RESULT"}
    house.driver.get_status.side_effect = changed
    result = request(client, PRIVATE_REQUESTS[3])
    assert result.status_code == 401 and "PRIVATE RESULT" not in result.text
    house.info.assert_not_called()


@pytest.mark.parametrize("item", PRIVATE_REQUESTS[1:])
def test_existing_license_gate_still_denies_without_device_work(house, monkeypatch, item):
    client, _ = house.browser()
    monkeypatch.setattr(license, "has_feature", lambda *args: False)
    result = request(client, item)
    assert result.status_code == 402 and result.json()["detail"]["feature"] == "home_automation"
    house.read.assert_not_called(); house.save.assert_not_called(); house.lan.assert_not_called(); house.driver.turn_on.assert_not_called()


def test_authenticated_in_process_services_keep_existing_signatures(house):
    result = shelly.shelly_status(IP, 1, _s="alice", _l=None)
    assert result["on"] is True and result["relay"] == 1
    result = shelly.shelly_relay(shelly.ShellyRelayRequest(ip=IP, relay=1, action="off"), user="alice", _l=None)
    assert result["outcome"] == "accepted"
    house.driver.turn_off.assert_called_once_with(ip=IP, relay=1)
