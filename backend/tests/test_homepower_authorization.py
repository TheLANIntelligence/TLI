"""Real browser authority and synthetic HomePower effects; no host/device I/O."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import companion_auth
import device_commands
import home_power_store
import license as licensing
import tli_state as S
from routers import home_power as hp

PRIVATE = "PRIVATE household fixture"
DEVICE = {"device_id": "one", "name": PRIVATE, "vendor": "fixture", "ip": "192.0.2.10"}
SCENE = {"scene_id": "evening", "name": PRIVATE, "actions": [
    {"device_id": "one", "capability": "switch.off"}, {"device_id": "two", "capability": "switch.off"}]}
AUTO = {"automation_id": "night", "name": PRIVATE, "enabled": False, "trigger": "game_started", "run_scene_id": "evening"}
ROUTES = [
    ("GET", "/status", None), ("GET", "/devices", None), ("GET", "/scenes", None),
    ("GET", "/automations", None), ("GET", "/receipts", None), ("GET", "/devices/one/status", None),
    ("POST", "/devices/save", {"device": DEVICE}), ("DELETE", "/devices/one", None),
    ("POST", "/scenes/save", {"scene": SCENE}), ("POST", "/scenes/bootstrap", None),
    ("POST", "/scenes/run", {"scene_id": "evening"}),
    ("POST", "/automations/save", {"automation": AUTO}), ("POST", "/automations/bootstrap", None),
    ("POST", "/automations/enabled", {"automation_id": "night", "enabled": True}),
    ("POST", "/devices/one/execute", {"capability": "switch.off", "request_id": "a" * 32}),
]
ROUTE_IDS = [method + " " + path for method, path, _ in ROUTES]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    monkeypatch.setattr(licensing, "has_feature", lambda *a: True)
    monkeypatch.setattr(licensing, "get_active_tier", lambda: "pro")
    monkeypatch.setattr(device_commands, "_running", set())
    monkeypatch.setattr(device_commands, "_requests", {})
    monkeypatch.setattr(hp, "games_detect_best", lambda: None)
    execute = Mock(return_value={"ok": True, "summary": PRIVATE})
    status = Mock(return_value={"ok": True, "on": True, "summary": PRIVATE})
    driver = SimpleNamespace(execute=execute, get_status=status)
    legacy = SimpleNamespace(turn_on=execute, turn_off=execute, toggle=execute, get_status=status)
    rt = hp.HomePowerRuntime(tmp_path, legacy, lambda *a, **k: None, {"fixture": driver})
    rt.save_devices([DEVICE, {**DEVICE, "device_id": "two", "ip": "192.0.2.11"}])
    rt.save_scenes([SCENE]); rt.save_automations([AUTO])
    monkeypatch.setattr(hp, "_RUNTIME", rt)
    app = FastAPI(); app.include_router(hp.home_power_router)
    clients = []
    def browser(*, remote=False, authenticated=True):
        origin = "https://192.0.2.20:8443" if remote else "http://localhost:8000"
        client = TestClient(app, base_url=origin, client=("192.0.2.30" if remote else "127.0.0.1", 1200),
                            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})
        token = S.create_session_token("household") if authenticated else None
        if token: client.headers["Cookie"] = "tli_session=" + token
        clients.append(client)
        return client, token
    client, token = browser()
    yield SimpleNamespace(root=tmp_path, rt=rt, pin=pin, client=client, token=token, browser=browser,
                          revoke=lambda: S.revoke_session_token(token), execute=execute, status=status, app=app)
    for client in clients: client.close()


def request(client, method, path, body=None):
    return client.request(method, "/homepower" + path, **({"json": body} if body is not None else {}))


def saved(env):
    return {p.relative_to(env.root).as_posix(): p.read_bytes() for p in (env.root / "home_power").rglob("*") if p.is_file()}


@pytest.mark.parametrize("method,path,body", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("mode", ["anonymous", "pin-off-lan", "foreign-origin", "expired", "revoked",
                                 "pin-off-expired", "pin-off-revoked", "paired", "peer", "proxy"])
def test_denied_routes_never_read_runtime_or_operate_devices(env, monkeypatch, mode, method, path, body):
    client = env.client
    if mode == "anonymous": client.headers.pop("Cookie")
    elif mode == "pin-off-lan":
        env.pin["enabled"] = False
        client, _ = env.browser(remote=True, authenticated=False)
    elif mode == "foreign-origin": client.headers["Origin"] = "https://foreign.example"
    elif mode in {"expired", "pin-off-expired"}:
        if mode.startswith("pin-off"): env.pin["enabled"] = False
        S._active_sessions[env.token]["expiry"] = 0
    elif mode in {"revoked", "pin-off-revoked"}:
        if mode.startswith("pin-off"): env.pin["enabled"] = False
        env.revoke()
    elif mode == "paired":
        invitation, _ = companion_auth.create_pairing("household", "https://192.0.2.20:8443", "a" * 64)
        paired = companion_auth.redeem_pairing(invitation, "https://192.0.2.20:8443", "a" * 64, "Fixture", "test")
        assert companion_auth.credential_owner(paired["credential"]) == "household"
        client.headers["Authorization"] = "Bearer " + paired["credential"]
    elif mode == "peer": client.headers["X-TLI-Peer-Signature"] = "unsupported"
    elif mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
    before = saved(env)
    runtime = Mock(side_effect=AssertionError("Denied request reached runtime"))
    monkeypatch.setattr(hp, "get_runtime", runtime)
    response = request(client, method, path, body)
    assert response.status_code == (401 if mode in {"anonymous", "expired", "revoked", "pin-off-expired", "pin-off-revoked"} else 403), response.text
    assert PRIVATE not in response.text
    runtime.assert_not_called(); env.execute.assert_not_called(); env.status.assert_not_called()
    assert saved(env) == before


@pytest.mark.parametrize("method,path,body", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("mode", ["local-pin", "local-open", "https-pin"])
def test_valid_browser_routes_retain_contracts(env, mode, method, path, body):
    client = env.client
    if mode == "local-open":
        env.pin["enabled"] = False
        client, _ = env.browser(authenticated=False)
    elif mode == "https-pin": client, _ = env.browser(remote=True)
    response = request(client, method, path, body)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert isinstance(response.json(), dict)


@pytest.mark.parametrize("method,path,body", [route for route in ROUTES if route[0] != "GET"],
                         ids=[i for i, route in zip(ROUTE_IDS, ROUTES) if route[0] != "GET"])
def test_mutations_require_exact_origin_before_runtime(env, monkeypatch, method, path, body):
    env.client.headers.pop("Origin")
    runtime = Mock(side_effect=AssertionError("Missing Origin reached runtime"))
    monkeypatch.setattr(hp, "get_runtime", runtime)
    assert request(env.client, method, path, body).status_code == 403
    runtime.assert_not_called()


@pytest.mark.parametrize("kind", ["devices", "scenes", "automations"])
@pytest.mark.parametrize("stage", ["read", "failed-read", "fsync", "replace"])
def test_save_rechecks_before_replacement_and_retains_completed_write(env, monkeypatch, kind, stage):
    target = env.rt._stores[kind]
    before = target.path.read_bytes()
    if stage in {"read", "failed-read"}:
        original = target.read
        def read():
            value = original(); env.revoke()
            if stage == "failed-read": raise OSError("PRIVATE read failure")
            return value
        monkeypatch.setattr(target, "read", read)
    elif stage == "fsync":
        original = home_power_store.os.fsync
        def fsync(fd): original(fd); env.revoke()
        monkeypatch.setattr(home_power_store.os, "fsync", fsync)
    else:
        original = home_power_store.os.replace
        def replace(source, destination):
            result = original(source, destination)
            if Path(destination) == target.path: env.revoke()
            return result
        monkeypatch.setattr(home_power_store.os, "replace", replace)
    key, value = {"devices": ("device", DEVICE), "scenes": ("scene", SCENE), "automations": ("automation", AUTO)}[kind]
    response = request(env.client, "POST", "/" + kind + "/save", {key: {**value, "name": "Changed"}})
    assert response.status_code == 401 and PRIVATE not in response.text
    if stage == "replace":
        assert json.loads(target.path.read_text())[kind][0]["name"] == "Changed"
    else: assert target.path.read_bytes() == before
    assert not env.rt._receipts_path.exists()
    assert not list(target.path.parent.glob(".tli-homepower-*.tmp"))
    env.execute.assert_not_called()


@pytest.mark.parametrize("route,method", [("/status", "automation_status"), ("/devices", "load_devices"),
    ("/scenes", "load_scenes"), ("/automations", "load_automations"), ("/receipts", "read_receipts")])
@pytest.mark.parametrize("failure", [False, True])
def test_private_read_or_error_after_revocation_withholds_data(env, monkeypatch, route, method, failure):
    original = getattr(env.rt, method)
    def read(*args, **kwargs):
        value = original(*args, **kwargs); env.revoke()
        if failure: raise OSError(PRIVATE)
        return value
    monkeypatch.setattr(env.rt, method, read)
    response = request(env.client, "GET", route)
    assert response.status_code == 401 and PRIVATE not in response.text


@pytest.mark.parametrize("failure", [False, True])
def test_device_status_revocation_does_not_become_successful_error_text(env, failure):
    def status(_):
        env.revoke()
        if failure: raise TimeoutError(PRIVATE)
        return {"ok": True, "on": True, "summary": PRIVATE}
    env.status.side_effect = status
    response = request(env.client, "GET", "/devices/one/status")
    assert response.status_code == 401 and PRIVATE not in response.text
    env.execute.assert_not_called()


def test_command_revocation_before_dispatch_never_reaches_adapter(env, monkeypatch):
    original = hp.run_command
    def run(*args): env.revoke(); return original(*args)
    monkeypatch.setattr(hp, "run_command", run)
    response = request(env.client, "POST", "/devices/one/execute", {"capability": "switch.off", "request_id": "b" * 32})
    assert response.status_code == 401
    env.execute.assert_not_called()
    assert not device_commands._running


@pytest.mark.parametrize("failure", [False, True])
def test_dispatched_outcome_remains_cached_without_repeating_after_reauthentication(env, failure):
    def execute(*args):
        env.revoke()
        if failure: raise TimeoutError(PRIVATE)
        return {"ok": True, "summary": PRIVATE}
    env.execute.side_effect = execute
    body = {"capability": "switch.off", "request_id": "c" * 32}
    response = request(env.client, "POST", "/devices/one/execute", body)
    assert response.status_code == 401 and PRIVATE not in response.text
    client, _ = env.browser()
    result = request(client, "POST", "/devices/one/execute", body)
    assert result.status_code == 200
    assert result.json()["outcome"] == ("unknown" if failure else "accepted")
    assert env.execute.call_count == 1


def test_scene_stops_remaining_devices_and_retains_truthful_partial_receipt(env):
    def execute(*args): env.revoke(); return {"ok": True, "summary": PRIVATE}
    env.execute.side_effect = execute
    response = request(env.client, "POST", "/scenes/run", {"scene_id": "evening"})
    assert response.status_code == 401 and PRIVATE not in response.text
    assert env.execute.call_count == 1
    receipt = env.rt.read_receipts()[0]["extra"]
    assert receipt["access_stopped"] is True and receipt["dispatched"] == 1
    assert len(receipt["results"]) == 1 and receipt["results"][0]["ok"] is True


def test_enabling_revoked_after_history_commit_never_enables_automation(env, monkeypatch):
    before = env.rt._autos_path.read_bytes()
    original = home_power_store.os.replace
    def replace(source, destination):
        result = original(source, destination)
        if Path(destination) == env.rt._state_path: env.revoke()
        return result
    monkeypatch.setattr(home_power_store.os, "replace", replace)
    response = request(env.client, "POST", "/automations/enabled", {"automation_id": "night", "enabled": True})
    assert response.status_code == 401
    assert env.rt._state_path.exists() and env.rt._autos_path.read_bytes() == before
    assert not env.rt._receipts_path.exists()


def test_metadata_receipt_rechecks_before_append_and_preserves_completed_config(env, monkeypatch):
    original = hp._append_jsonl
    def append(path, payload, **kwargs): env.revoke(); return original(path, payload, **kwargs)
    monkeypatch.setattr(hp, "_append_jsonl", append)
    response = request(env.client, "POST", "/devices/save", {"device": {**DEVICE, "name": "Changed"}})
    assert response.status_code == 401
    assert env.rt.load_devices()[0]["name"] == "Changed"
    assert not env.rt._receipts_path.exists()


def test_internal_services_and_scene_runtime_still_work_without_http_dependencies(env):
    assert hp.get_device_status("one", _s="internal")["on"] is True
    assert hp.execute_device("one", hp.ExecuteDeviceRequest(capability="switch.off"), _s="internal")["ok"] is True
    result = env.rt.run_scene("evening", reason="automation:fixture")
    assert result["ok"] is True and len(result["results"]) == 2
