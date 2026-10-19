"""Bluetooth HTTP/service integration with temporary state and synthetic adapters."""
import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import companion_auth
import bluetooth_profiles as profiles
import device_commands
import home_conversation as home
import home_power_store
import license as licensing
import tli_state as S
from routers import bluetooth_routes as bt, home_power as hp

ADDRESS = "AA:BB:CC:DD:EE:FF"
BODY = {"address": ADDRESS, "name": "Private lamp", "model": "H6125", "confirm_model": True}
RECORD = bt._record(bt.EnrollRequest(**BODY))
SENT = {"ok": True, "acknowledged": False, "outcome": "sent", "verified": False}
ROUTES = [("GET", "/bluetooth/status", None), ("POST", "/bluetooth/discover", None),
          ("POST", "/bluetooth/enroll", BODY)]


@pytest.fixture
def house(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    monkeypatch.setattr(licensing, "has_feature", lambda *a: True)
    monkeypatch.setattr(licensing, "get_active_tier", lambda: "pro")
    monkeypatch.setattr(device_commands, "_running", set())
    monkeypatch.setattr(device_commands, "_requests", {})
    monkeypatch.setattr(hp, "games_detect_best", None)
    driver = SimpleNamespace(probe_checked=Mock(return_value={"ok": True, "model": "H6125", "profile": bt.PROFILE}),
        execute_checked=Mock(return_value=dict(SENT)), get_status_checked=Mock(return_value={"ok": True, "on": True, "verified": True}),
        execute=Mock(side_effect=AssertionError("unchecked BLE dispatch")), get_status=Mock(side_effect=AssertionError("unchecked BLE status")))
    rt = hp.HomePowerRuntime(tmp_path, SimpleNamespace(), lambda *a, **k: None, {bt.VENDOR: driver})
    monkeypatch.setattr(hp, "_RUNTIME", rt)
    software = Mock(return_value={"available": True, "platform": "Windows", "reason": None})
    scan = Mock(return_value=[{"address": ADDRESS, "name": "Private advertised lamp", "model": "H6125", "supported": True}])
    monkeypatch.setattr(bt.bluetooth_support, "support_status", software)
    monkeypatch.setattr(bt.bluetooth_support, "discover", scan)
    # The only permitted radio boundary is the synthetic adapter above.
    monkeypatch.setattr(bt.bluetooth_support, "run", Mock(side_effect=AssertionError("real radio work")))
    app = FastAPI(); app.include_router(hp.home_power_router)
    monkeypatch.setattr(home, "_license", lambda: None)
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [])
    def inventory():
        return {"devices": [{"id": "lamp", "source": "homepower", "source_id": r["device_id"],
                             "kind": "smart_device", "vendor": r["vendor"], "name": r["name"],
                             "address": r["ip"], "relay": 0, "aliases": []} for r in rt.load_devices()]}
    monkeypatch.setattr(home.devices, "inventory", inventory)
    @app.post("/answer")
    def answer(request: Request, message: str):
        return {"reply": home.answer(request, message)}
    clients = []
    def browser(remote=False, authenticated=True, target=None):
        origin = "https://tli.invalid" if remote else "http://localhost:8000"
        client = TestClient(target or app, base_url=origin, client=("192.0.2.20" if remote else "127.0.0.1", 1234),
                            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})
        token = S.create_session_token("alice") if authenticated else None
        if token: client.headers["Cookie"] = "tli_session=" + token
        clients.append(client)
        return client, token
    client, token = browser()
    yield SimpleNamespace(root=tmp_path, pin=pin, rt=rt, driver=driver, software=software, scan=scan,
                          browser=browser, client=client, token=token, app=app, revoke=lambda: S.revoke_session_token(token))
    for client in clients: client.close()
    driver.execute.assert_not_called(); driver.get_status.assert_not_called()


def request(client, method, path, body=None):
    return client.request(method, "/homepower" + path, **({"json": body} if body is not None else {}))


@pytest.mark.parametrize("method,path,body", ROUTES)
@pytest.mark.parametrize("mode", ["anonymous", "remote-no-pin", "stale-no-pin", "foreign-origin", "proxy", "peer", "bearer", "revoked"])
def test_denied_bluetooth_requests_never_touch_saved_state_or_radio(house, monkeypatch, method, path, body, mode):
    client = house.client
    if mode == "anonymous": client.headers.pop("Cookie")
    elif mode == "remote-no-pin":
        house.pin["enabled"] = False; client, _ = house.browser(remote=True, authenticated=False)
    elif mode == "stale-no-pin": house.revoke(); house.pin["enabled"] = False
    elif mode == "foreign-origin": client.headers["Origin"] = "https://other.invalid"
    elif mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
    elif mode == "peer": client.headers["X-TLI-Peer-Id"] = "other"
    elif mode == "bearer": client.headers["Authorization"] = "Bearer invalid"
    else: house.revoke()
    reader = Mock(side_effect=AssertionError("private store touched")); monkeypatch.setattr(house.rt, "load_devices", reader)
    result = request(client, method, path, body)
    assert result.status_code in (401, 403), result.text
    assert result.headers["cache-control"] == "no-store"
    assert "Private" not in result.text
    reader.assert_not_called(); house.software.assert_not_called(); house.scan.assert_not_called(); house.driver.probe_checked.assert_not_called()


@pytest.mark.parametrize("mode", ["local-pin", "remote-pin", "local-open"])
def test_supported_browser_explicit_scan_and_enrollment_contract(house, mode):
    client = house.client
    if mode == "remote-pin": client, _ = house.browser(remote=True)
    if mode == "local-open": house.pin["enabled"] = False; client, _ = house.browser(authenticated=False)
    status = request(client, "GET", "/bluetooth/status")
    assert status.status_code == 200 and status.json()["available"] is True
    house.scan.assert_not_called(); house.driver.probe_checked.assert_not_called()
    candidates = request(client, "POST", "/bluetooth/discover")
    assert candidates.status_code == 200 and candidates.json()["devices"][0]["address"] == ADDRESS
    assert not house.rt._devices_path.exists()
    result = request(client, "POST", "/bluetooth/enroll", BODY)
    assert result.status_code == 200 and result.json() == {"ok": True, "device": RECORD}
    assert result.headers["cache-control"] == status.headers["cache-control"] == candidates.headers["cache-control"] == "no-store"
    assert house.rt.load_devices() == [RECORD]
    house.driver.probe_checked.assert_called_once()
    house.driver.execute_checked.assert_not_called(); house.driver.get_status_checked.assert_not_called()


@pytest.mark.parametrize("patch", [{"address": "not-an-address"}, {"address": "AA:BB:CC:DD:EE:FF/other"},
    {"name": " "}, {"name": "bad\nlabel"}, {"room": "bad\0room"}, {"model": "H9999"},
    {"confirm_model": False}, {"confirm_model": 1}, {"uuid": "arbitrary"}])
def test_invalid_enrollment_is_redacted_and_never_connects(house, patch):
    result = request(house.client, "POST", "/bluetooth/enroll", {**BODY, **patch})
    assert result.status_code == 422 and result.json() == {"detail": "Bluetooth request is invalid."}
    assert result.headers["cache-control"] == "no-store"
    house.driver.probe_checked.assert_not_called()
    assert not house.rt._devices_path.exists()


@pytest.mark.parametrize("response", [{"ok": False}, {"ok": True}, {"ok": True, "model": "H9999", "profile": bt.PROFILE},
                                      {"ok": True, "model": "H6125", "profile": "other"}, None])
def test_enrollment_requires_supported_probe_before_saving(house, response):
    house.driver.probe_checked.return_value = response
    result = request(house.client, "POST", "/bluetooth/enroll", BODY)
    assert result.status_code == 422
    assert not house.rt._devices_path.exists()


@pytest.mark.parametrize("code", ["dependency_missing", "device_not_found", "bluetooth_busy", "cleanup_pending"])
def test_unavailable_probe_is_not_reported_as_profile_mismatch(house, code):
    house.driver.probe_checked.return_value = {"ok": False, "error": code}
    result = request(house.client, "POST", "/bluetooth/enroll", BODY)
    assert result.status_code == 503 and "profile" not in result.text
    assert not house.rt._devices_path.exists()


@pytest.mark.parametrize("stage", ["software", "scan", "probe"])
@pytest.mark.parametrize("error", [False, True])
def test_revocation_during_adapter_result_or_error_prevents_disclosure_and_save(house, stage, error):
    call, method, path, body = {"software": (house.software, "GET", "/bluetooth/status", None),
        "scan": (house.scan, "POST", "/bluetooth/discover", None),
        "probe": (house.driver.probe_checked, "POST", "/bluetooth/enroll", BODY)}[stage]
    original = call.return_value
    def work(*a, **kw):
        house.revoke()
        if error: raise RuntimeError("Private transport error")
        return original
    call.side_effect = work
    result = request(house.client, method, path, body)
    assert result.status_code == 401 and "Private" not in result.text
    assert not house.rt._devices_path.exists()


def test_damaged_store_blocks_probe_and_remains_identical(house):
    house.rt._devices_path.parent.mkdir(parents=True, exist_ok=True)
    raw = b'{"devices": [broken'; house.rt._devices_path.write_bytes(raw)
    result = request(house.client, "POST", "/bluetooth/enroll", BODY)
    assert result.status_code == 503 and house.rt._devices_path.read_bytes() == raw
    house.driver.probe_checked.assert_not_called()


def test_enrollment_preserves_other_devices_and_unknown_envelope(house):
    prior = {"device_id": "other", "name": "Old lamp", "vendor": "fixture", "ip": "192.0.2.10", "future": {"keep": True}}
    house.rt.save_devices([prior])
    value = json.loads(house.rt._devices_path.read_text()); value["future"] = {"keep": True}
    house.rt._devices_path.write_text(json.dumps(value))
    assert request(house.client, "POST", "/bluetooth/enroll", BODY).status_code == 200
    value = json.loads(house.rt._devices_path.read_text())
    assert value["future"] == {"keep": True} and value["devices"] == [prior, RECORD]


def test_existing_target_is_not_reprobed_or_duplicated(house):
    house.rt.save_devices([{**RECORD, "device_id": "legacy-id"}])
    before = house.rt._devices_path.read_bytes()
    assert request(house.client, "POST", "/bluetooth/enroll", BODY).status_code == 409
    assert house.rt._devices_path.read_bytes() == before
    house.driver.probe_checked.assert_not_called()


def test_concurrent_enrollment_rechecks_after_probe(house):
    barrier = threading.Barrier(2)
    def probe(*a, **kw):
        barrier.wait(timeout=5)
        return {"ok": True, "model": "H6125", "profile": bt.PROFILE}
    house.driver.probe_checked.side_effect = probe
    second, _ = house.browser()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(request, client, "POST", "/bluetooth/enroll", BODY) for client in (house.client, second)]
        assert sorted(f.result(timeout=10).status_code for f in futures) == [200, 409]
    assert house.rt.load_devices() == [RECORD]


@pytest.mark.parametrize("after_replace", [False, True])
def test_enrollment_rechecks_staging_and_keeps_known_commit(house, monkeypatch, after_replace):
    if after_replace:
        original = home_power_store.os.replace
        def replace(*a, **k):
            original(*a, **k); house.revoke()
        monkeypatch.setattr(home_power_store.os, "replace", replace)
    else:
        original = home_power_store.os.fsync
        def fsync(*a, **k):
            original(*a, **k); house.revoke()
        monkeypatch.setattr(home_power_store.os, "fsync", fsync)
    result = request(house.client, "POST", "/bluetooth/enroll", BODY)
    assert result.status_code == 401
    assert house.rt.load_devices() == ([RECORD] if after_replace else [])
    assert not house.rt._receipts_path.exists()


@pytest.mark.parametrize("edit", [{"vendor": "govee"}, {"ip": "ble://00:11:22:33:44:55"},
    {"extra": {"address": "00:11:22:33:44:55"}}, {"extra": {"profile": "other"}}, {"capabilities": ["switch.toggle"]}])
def test_generic_save_cannot_rebind_bluetooth_target(house, edit):
    house.rt.save_devices([RECORD]); before = house.rt._devices_path.read_bytes()
    candidate = {**RECORD, **edit}
    result = request(house.client, "POST", "/devices/save", {"device": candidate})
    assert result.status_code == 409 and house.rt._devices_path.read_bytes() == before
    house.driver.probe_checked.assert_not_called()


def test_generic_save_cannot_inject_bluetooth_but_metadata_edits_preserve_binding(house):
    result = request(house.client, "POST", "/devices/save", {"device": RECORD})
    assert result.status_code == 409 and not house.rt._devices_path.exists()
    saved = {**RECORD, "extra": {**RECORD["extra"], "future": "preserved"}, "unknown": True}
    house.rt.save_devices([saved])
    result = request(house.client, "POST", "/devices/save", {"device": {"device_id": RECORD["device_id"], "ip": RECORD["ip"], "name": "New name"}})
    assert result.status_code == 200
    assert house.rt.load_devices() == [{**saved, "name": "New name"}]


@pytest.mark.parametrize("code", [401, 403, 503])
@pytest.mark.parametrize("known", [None, SENT, {"ok": False, "outcome": "unknown", "acknowledged": False}])
def test_sticky_driver_denial_preserves_known_private_outcome_and_never_replays(house, code, known):
    house.rt.save_devices([RECORD])
    failure = HTTPException(code, "Stopped")
    fail = [False]
    def access():
        if fail[0]:
            fail[0] = False
            raise failure
    def execute(device, capability, *, check):
        fail[0] = True
        try: check()
        except HTTPException as error:
            if known is not None: error.device_result = dict(known)
            raise
    house.driver.execute_checked.side_effect = execute
    req = hp.ExecuteDeviceRequest(capability="switch.on", request_id="a" * 32)
    with pytest.raises(HTTPException) as caught:
        hp.execute_device(RECORD["device_id"], req, _s="alice", check=access)
    assert caught.value is failure
    retained = device_commands._requests[("alice", req.request_id)]["result"]
    assert retained["outcome"] == ("sent" if known and known.get("ok") else "unknown")
    result = hp.execute_device(RECORD["device_id"], req, _s="alice", check=lambda: None)
    assert result == retained and house.driver.execute_checked.call_count == 1


@pytest.mark.parametrize("code", [401, 503])
def test_scene_retains_sent_step_and_stops_after_transient_authority_failure(house, code):
    house.rt.save_devices([RECORD, {**RECORD, "device_id": "next", "ip": "ble://00:11:22:33:44:55"}])
    house.rt.save_scenes([{"scene_id": "scene", "name": "Scene", "actions": [
        {"device_id": RECORD["device_id"], "capability": "switch.on"}, {"device_id": "next", "capability": "switch.off"}]}])
    failure = HTTPException(code, "Stopped"); fail = [False]
    def access():
        if fail[0]: fail[0] = False; raise failure
    def execute(device, capability, *, check):
        fail[0] = True
        try: check()
        except HTTPException as error: error.device_result = dict(SENT); raise
    house.driver.execute_checked.side_effect = execute
    with pytest.raises(hp.SceneAccessStopped) as caught:
        house.rt.run_scene("scene", check=access)
    assert caught.value.status_code == code
    assert caught.value.scene_result["results"][0]["outcome"] == "sent"
    assert house.driver.execute_checked.call_count == 1
    assert house.rt.read_receipts()[0]["extra"]["results"][0]["acknowledged"] is False


def test_no_check_internal_calls_cannot_start_bluetooth(house):
    house.rt.save_devices([RECORD])
    with pytest.raises(HTTPException):
        hp.execute_device(RECORD["device_id"], hp.ExecuteDeviceRequest(capability="switch.on"), _s="internal")
    with pytest.raises(HTTPException): hp.get_device_status(RECORD["device_id"])
    house.driver.execute_checked.assert_not_called(); house.driver.get_status_checked.assert_not_called()


def test_unattended_scene_refuses_bluetooth_without_dispatch_claim(house):
    house.rt.save_devices([RECORD])
    house.rt.save_scenes([{"scene_id": "scene", "name": "Scene", "actions": [
        {"device_id": RECORD["device_id"], "capability": "switch.on"}]}])
    result = house.rt.run_scene("scene", reason="scheduled")
    assert result["ok"] is False
    assert result["results"][0]["outcome"] == "not_sent" and result["results"][0]["dispatched"] is False
    house.driver.execute_checked.assert_not_called()


@pytest.mark.parametrize("error_type", [RuntimeError, OSError])
@pytest.mark.parametrize("sent", [False, True])
def test_non_http_authority_error_is_sticky_redacted_and_retains_scene_effect(house, error_type, sent):
    house.rt.save_devices([RECORD])
    house.rt.save_scenes([{"scene_id": "scene", "name": "Scene", "actions": [
        {"device_id": RECORD["device_id"], "capability": "switch.on"},
        {"device_id": RECORD["device_id"], "capability": "switch.off"}]}])
    fail = [False]
    def access():
        if fail[0]: fail[0] = False; raise error_type("PRIVATE security error")
    def execute(device, capability, *, check):
        fail[0] = True
        try: check()
        except HTTPException as error:
            if sent: error.device_result = dict(SENT)
            raise
    house.driver.execute_checked.side_effect = execute
    with pytest.raises(HTTPException) as caught:
        house.rt.run_scene("scene", check=access)
    assert caught.value.status_code == 503 and "PRIVATE" not in str(caught.value.detail)
    assert house.driver.execute_checked.call_count == 1
    if sent:
        assert isinstance(caught.value, hp.SceneAccessStopped)
        assert caught.value.scene_result["results"][0]["outcome"] == "sent"
    else:
        assert not house.rt._receipts_path.exists()


def test_revocation_waiting_for_enrollment_store_lock_never_connects(house, monkeypatch):
    entered = threading.Event()
    original = hp.get_runtime
    def runtime(): entered.set(); return original()
    monkeypatch.setattr(hp, "get_runtime", runtime)
    with house.rt._lock:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(request, house.client, "POST", "/bluetooth/enroll", BODY)
            assert entered.wait(5)
            house.revoke()
            # Release before joining the worker which must acquire this lock.
            house.rt._lock.release()
            try: result = future.result(timeout=5)
            finally: house.rt._lock.acquire()
    assert result.status_code == 401
    house.driver.probe_checked.assert_not_called()
    assert not house.rt._devices_path.exists()


@pytest.mark.parametrize("method,path,body", ROUTES)
def test_revocation_during_json_encoding_withholds_private_result(house, monkeypatch, method, path, body):
    original = bt.JSONResponse
    def response(*args, **kwargs):
        value = original(*args, **kwargs); house.revoke(); return value
    monkeypatch.setattr(bt, "JSONResponse", response)
    result = request(house.client, method, path, body)
    assert result.status_code == 401 and "Private" not in result.text
    if path.endswith("enroll"):
        assert house.rt.load_devices() == [RECORD]


def test_same_bluetooth_address_across_legacy_ids_serializes_one_physical_target(house):
    house.rt.save_devices([RECORD, {**RECORD, "device_id": "legacy-duplicate"}])
    started, finish = threading.Event(), threading.Event()
    def execute(*a, **k):
        started.set(); assert finish.wait(5); return dict(SENT)
    house.driver.execute_checked.side_effect = execute
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(hp.execute_device, RECORD["device_id"], hp.ExecuteDeviceRequest(capability="switch.on"), "alice", check=lambda: None)
        try:
            assert started.wait(5)
            with pytest.raises(HTTPException) as caught:
                hp.execute_device("legacy-duplicate", hp.ExecuteDeviceRequest(capability="switch.off"), "alice", check=lambda: None)
            assert caught.value.status_code == 409
        finally: finish.set()
        assert first.result(timeout=5)["outcome"] == "sent"
    house.driver.execute_checked.assert_called_once()


@pytest.mark.parametrize("method,path,body", ROUTES)
@pytest.mark.parametrize("cookie", [False, True])
def test_valid_native_pairing_does_not_grant_bluetooth_browser_routes(house, method, path, body, cookie):
    client, _ = house.browser(remote=True, authenticated=cookie)
    invitation, _ = companion_auth.create_pairing("alice", "https://tli.invalid", "fingerprint")
    paired = companion_auth.redeem_pairing(invitation, "https://tli.invalid", "fingerprint", "Synthetic phone", "test")
    client.headers["Authorization"] = "Bearer " + paired["credential"]
    result = request(client, method, path, body)
    assert result.status_code == 403
    house.scan.assert_not_called(); house.software.assert_not_called(); house.driver.probe_checked.assert_not_called()


def test_real_http_postwrite_revocation_retains_sent_without_disclosure_or_replay(house):
    house.rt.save_devices([RECORD])
    def write(*a, **k): house.revoke(); return dict(SENT)
    house.driver.execute_checked.side_effect = write
    body = {"capability": "switch.on", "request_id": "a" * 32}
    result = request(house.client, "POST", "/devices/" + RECORD["device_id"] + "/execute", body)
    assert result.status_code == 401 and "Private" not in result.text
    assert device_commands._requests[("alice", "a" * 32)]["result"]["outcome"] == "sent"
    fresh, _ = house.browser()
    result = request(fresh, "POST", "/devices/" + RECORD["device_id"] + "/execute", body)
    assert result.status_code == 200 and result.json()["outcome"] == "sent"
    house.driver.execute_checked.assert_called_once()


def test_unverified_bluetooth_status_cannot_become_boolean_state(house):
    house.rt.save_devices([RECORD])
    house.driver.get_status_checked.return_value = {"ok": True, "on": True, "verified": False}
    result = request(house.client, "GET", "/devices/" + RECORD["device_id"] + "/status")
    assert result.status_code == 200 and result.json()["ok"] is False and result.json()["on"] is None


@pytest.mark.parametrize("mode", ["browser", "companion"])
@pytest.mark.parametrize("verified", [False, True])
def test_named_chat_sent_wording_and_one_status_read_keep_existing_clients(house, mode, verified):
    house.rt.save_devices([RECORD])
    house.driver.get_status_checked.return_value = {"ok": verified, "on": True if verified else None, "verified": verified}
    client = house.client
    if mode == "companion":
        client, _ = house.browser(remote=True, authenticated=False)
        client.headers.pop("Origin"); client.headers.pop("Sec-Fetch-Site")
        invitation, _ = companion_auth.create_pairing("alice", "https://tli.invalid", "fingerprint")
        paired = companion_auth.redeem_pairing(invitation, "https://tli.invalid", "fingerprint", "Synthetic phone", "test")
        client.headers["Authorization"] = "Bearer " + paired["credential"]
    result = client.post("/answer", params={"message": "turn on Private lamp"})
    assert result.status_code == 200, result.text
    reply = result.json()["reply"]
    assert "was sent" in reply and "acknowledged" not in reply
    assert ("**ON**" in reply) is verified
    assert ("could not be verified" in reply) is not verified
    house.driver.execute_checked.assert_called_once(); house.driver.get_status_checked.assert_called_once()


@pytest.mark.parametrize("method,path,body", ROUTES)
def test_effective_main_routes_enforce_same_browser_contract(house, app, method, path, body):
    client, _ = house.browser(target=app, authenticated=False)
    assert request(client, method, path, body).status_code == 401
    client, _ = house.browser(target=app)
    assert request(client, method, path, body).status_code == 200


@pytest.fixture
def other_brand(house, monkeypatch):
    # A synthetic descriptor proves dispatch structure, not real brand support.
    descriptor = profiles.Profile(id="synthetic_light_v1", vendor="synthetic_ble", brand="Synthetic test brand",
                                  model="TEST100", id_prefix="synthetic-ble-", capabilities=("switch.on", "switch.off"))
    monkeypatch.setattr(profiles, "_PROFILES", (*profiles._PROFILES, descriptor))
    driver = SimpleNamespace(probe_checked=Mock(return_value={"ok": True, "model": descriptor.model, "profile": descriptor.id}),
        execute_checked=Mock(return_value=dict(SENT)), get_status_checked=Mock(return_value={"ok": True, "on": False, "verified": True}),
        execute=Mock(side_effect=AssertionError("unchecked synthetic execution")),
        get_status=Mock(side_effect=AssertionError("unchecked synthetic status")))
    house.rt._driver_registry[descriptor.vendor] = driver
    body = {**BODY, "name": "Synthetic lamp", "profile": descriptor.id, "model": descriptor.model}
    record = bt._record(bt.EnrollRequest(**body))
    yield SimpleNamespace(profile=descriptor, driver=driver, body=body, record=record)
    driver.execute.assert_not_called(); driver.get_status.assert_not_called()


def test_status_exposes_detached_catalog_without_radio_or_saved_state(house, other_brand, monkeypatch):
    reader = Mock(side_effect=AssertionError("software status read registry"))
    monkeypatch.setattr(house.rt, "load_devices", reader)
    result = request(house.client, "GET", "/bluetooth/status")
    assert result.status_code == 200
    assert result.json()["profiles"] == profiles.list_profiles()
    assert result.json()["profiles"][1] == other_brand.profile.public()
    reader.assert_not_called(); house.scan.assert_not_called(); other_brand.driver.probe_checked.assert_not_called()


@pytest.mark.parametrize("explicit", [False, True])
def test_second_brand_enrollment_uses_exact_catalog_descriptor(house, other_brand, explicit):
    body = dict(other_brand.body)
    if not explicit: body.pop("profile")
    result = request(house.client, "POST", "/bluetooth/enroll", body)
    assert result.status_code == 200 and result.json()["device"] == other_brand.record
    assert house.rt.load_devices() == [other_brand.record]
    other_brand.driver.probe_checked.assert_called_once()
    house.driver.probe_checked.assert_not_called(); other_brand.driver.execute_checked.assert_not_called()


def test_legacy_govee_enrollment_and_read_preserve_existing_identity_bytes(house, other_brand):
    result = request(house.client, "POST", "/bluetooth/enroll", BODY)
    assert result.status_code == 200 and result.json()["device"] == RECORD
    original = house.rt._devices_path.read_bytes()
    assert request(house.client, "GET", "/devices").json()["devices"] == [RECORD]
    assert request(house.client, "GET", "/bluetooth/status").status_code == 200
    assert house.rt._devices_path.read_bytes() == original
    other_brand.driver.probe_checked.assert_not_called()


@pytest.mark.parametrize("body", [{**BODY, "profile": "unknown_profile"},
    {**BODY, "profile": "synthetic_light_v1"}, {**BODY, "model": "TEST999"},
    {**BODY, "profile": "govee_h6125_v1", "model": "TEST100"}])
def test_unknown_or_mismatched_profile_rejected_before_runtime_or_radio(house, other_brand, monkeypatch, body):
    runtime = Mock(side_effect=AssertionError("private state read before profile validation"))
    monkeypatch.setattr(hp, "get_runtime", runtime)
    result = request(house.client, "POST", "/bluetooth/enroll", body)
    assert result.status_code == 422 and result.json() == {"detail": "Bluetooth request is invalid."}
    runtime.assert_not_called(); house.driver.probe_checked.assert_not_called(); other_brand.driver.probe_checked.assert_not_called()


def test_ambiguous_model_requires_explicit_profile_before_any_private_read(house, other_brand, monkeypatch):
    from dataclasses import replace
    ambiguous = replace(other_brand.profile, model="H6125")
    monkeypatch.setattr(profiles, "_PROFILES", (profiles._PROFILES[0], ambiguous))
    runtime = Mock(side_effect=AssertionError("ambiguous model touched runtime"))
    monkeypatch.setattr(hp, "get_runtime", runtime)
    assert request(house.client, "POST", "/bluetooth/enroll", BODY).status_code == 422
    runtime.assert_not_called()
    monkeypatch.setattr(hp, "get_runtime", lambda: house.rt)
    assert request(house.client, "POST", "/bluetooth/enroll", {**BODY, "profile": "govee_h6125_v1"}).status_code == 200
    other_brand.driver.probe_checked.assert_not_called()


@pytest.mark.parametrize("mode", ["anonymous", "remote-no-pin", "bearer"])
def test_second_brand_enrollment_has_same_browser_admission(house, other_brand, mode):
    client = house.client
    if mode == "anonymous": client.headers.pop("Cookie")
    elif mode == "remote-no-pin": house.pin["enabled"] = False; client, _ = house.browser(remote=True, authenticated=False)
    else: client.headers["Authorization"] = "Bearer invalid"
    assert request(client, "POST", "/bluetooth/enroll", other_brand.body).status_code in (401, 403)
    other_brand.driver.probe_checked.assert_not_called()
    assert not house.rt._devices_path.exists()


@pytest.mark.parametrize("action", ["execute", "status", "scene"])
def test_second_brand_uses_only_its_checked_driver(house, other_brand, action):
    house.rt.save_devices([other_brand.record])
    if action == "scene":
        house.rt.save_scenes([{"scene_id": "synthetic-scene", "name": "Synthetic", "actions": [
            {"device_id": other_brand.record["device_id"], "capability": "switch.off"}]}])
        result = request(house.client, "POST", "/scenes/run", {"scene_id": "synthetic-scene"})
        assert result.status_code == 200 and result.json()["results"][0]["outcome"] == "sent"
    elif action == "execute":
        result = request(house.client, "POST", "/devices/" + other_brand.record["device_id"] + "/execute",
                         {"capability": "switch.off", "request_id": "b" * 32})
        assert result.status_code == 200 and result.json()["outcome"] == "sent"
    else:
        result = request(house.client, "GET", "/devices/" + other_brand.record["device_id"] + "/status")
        assert result.status_code == 200 and result.json()["on"] is False and result.json()["verified"] is True
    assert other_brand.driver.execute_checked.call_count == int(action != "status")
    assert other_brand.driver.get_status_checked.call_count == int(action == "status")
    house.driver.execute_checked.assert_not_called(); house.driver.get_status_checked.assert_not_called()


@pytest.mark.parametrize("missing", ["probe_checked", "execute_checked", "get_status_checked"])
@pytest.mark.parametrize("action", ["enroll", "execute", "status", "scene"])
def test_missing_checked_method_never_falls_back_to_legacy_adapter(house, other_brand, missing, action):
    delattr(other_brand.driver, missing)
    if action != "enroll": house.rt.save_devices([other_brand.record])
    if action == "enroll": result = request(house.client, "POST", "/bluetooth/enroll", other_brand.body)
    elif action == "execute": result = request(house.client, "POST", "/devices/" + other_brand.record["device_id"] + "/execute", {"capability": "switch.on"})
    elif action == "status": result = request(house.client, "GET", "/devices/" + other_brand.record["device_id"] + "/status")
    else:
        house.rt.save_scenes([{"scene_id": "s", "name": "Synthetic", "actions": [{"device_id": other_brand.record["device_id"], "capability": "switch.on"}]}])
        result = request(house.client, "POST", "/scenes/run", {"scene_id": "s"})
    assert result.status_code == (200 if action == "scene" else 503)
    if action == "scene": assert result.json()["ok"] is False
    for method in ("probe_checked", "execute_checked", "get_status_checked"):
        if method != missing: getattr(other_brand.driver, method).assert_not_called()


@pytest.mark.parametrize("change", ["vendor", "profile", "model", "transport", "address", "ip", "caps", "relay"])
@pytest.mark.parametrize("action", ["execute", "status", "scene"])
def test_invalid_bluetooth_binding_never_reaches_other_or_legacy_driver(house, other_brand, change, action):
    row = copy.deepcopy(other_brand.record)
    if change == "vendor": row["vendor"] = "shelly"
    elif change == "profile": row["extra"]["profile"] = "unknown"
    elif change == "model": row["extra"]["model"] = "OTHER"
    elif change == "transport": row["extra"]["transport"] = "lan"
    elif change == "address": row["extra"]["address"] = "00:11:22:33:44:55"
    elif change == "ip": row["ip"] = "192.0.2.11"
    elif change == "caps": row["capabilities"] = ["switch.toggle"]
    else: row["relay"] = 1
    house.rt.save_devices([row])
    if action == "scene":
        house.rt.save_scenes([{"scene_id": "s", "name": "Synthetic", "actions": [{"device_id": row["device_id"], "capability": "switch.on"}]}])
        result = request(house.client, "POST", "/scenes/run", {"scene_id": "s"})
        assert result.status_code == 200 and result.json()["ok"] is False
        assert result.json()["results"][0]["dispatched"] is False
    elif action == "execute":
        assert request(house.client, "POST", "/devices/" + row["device_id"] + "/execute", {"capability": "switch.on"}).status_code == 422
    else: assert request(house.client, "GET", "/devices/" + row["device_id"] + "/status").status_code == 422
    other_brand.driver.execute_checked.assert_not_called(); other_brand.driver.get_status_checked.assert_not_called()
    house.driver.execute_checked.assert_not_called(); house.driver.get_status_checked.assert_not_called()


def test_second_brand_generic_save_cannot_create_rebind_or_downgrade(house, other_brand):
    assert request(house.client, "POST", "/devices/save", {"device": other_brand.record}).status_code == 409
    house.rt.save_devices([other_brand.record]); original = house.rt._devices_path.read_bytes()
    for changed in ({**other_brand.record, "vendor": "shelly"}, {**other_brand.record, "extra": {**other_brand.record["extra"], "profile": bt.PROFILE}}):
        assert request(house.client, "POST", "/devices/save", {"device": changed}).status_code == 409
        assert house.rt._devices_path.read_bytes() == original
    assert request(house.client, "POST", "/devices/save", {"device": {"device_id": other_brand.record["device_id"], "ip": other_brand.record["ip"], "room": "Office"}}).status_code == 200
    assert house.rt.load_devices() == [{**other_brand.record, "room": "Office"}]


def test_enrollment_rejects_same_address_registered_under_another_vendor(house, other_brand):
    house.rt.save_devices([RECORD]); original = house.rt._devices_path.read_bytes()
    result = request(house.client, "POST", "/bluetooth/enroll", other_brand.body)
    assert result.status_code == 409 and house.rt._devices_path.read_bytes() == original
    other_brand.driver.probe_checked.assert_not_called()


def test_command_lock_is_shared_across_brand_and_alias_ids(house, other_brand):
    house.rt.save_devices([RECORD, {**other_brand.record, "device_id": "legacy-alias"}])
    entered, finish = threading.Event(), threading.Event()
    def execute(*a, **k): entered.set(); assert finish.wait(5); return dict(SENT)
    house.driver.execute_checked.side_effect = execute
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(hp.execute_device, RECORD["device_id"], hp.ExecuteDeviceRequest(capability="switch.on"), "alice", check=lambda: None)
        try:
            assert entered.wait(5)
            with pytest.raises(HTTPException) as caught:
                hp.execute_device("legacy-alias", hp.ExecuteDeviceRequest(capability="switch.off"), "alice", check=lambda: None)
            assert caught.value.status_code == 409
        finally: finish.set()
        assert pending.result(timeout=5)["outcome"] == "sent"
    other_brand.driver.execute_checked.assert_not_called()


@pytest.mark.parametrize("action", ["status", "execute", "scene"])
def test_second_brand_revocation_stops_disclosure_and_retains_known_scene_result(house, other_brand, action):
    house.rt.save_devices([other_brand.record])
    method = other_brand.driver.get_status_checked if action == "status" else other_brand.driver.execute_checked
    original = method.return_value
    def work(*args, **kwargs): house.revoke(); return original
    method.side_effect = work
    if action == "scene":
        house.rt.save_scenes([{"scene_id": "s", "name": "Synthetic", "actions": [
            {"device_id": other_brand.record["device_id"], "capability": "switch.on"},
            {"device_id": other_brand.record["device_id"], "capability": "switch.off"}]}])
        result = request(house.client, "POST", "/scenes/run", {"scene_id": "s"})
        assert house.rt.read_receipts()[0]["extra"]["results"][0]["outcome"] == "sent"
    elif action == "execute": result = request(house.client, "POST", "/devices/" + other_brand.record["device_id"] + "/execute", {"capability": "switch.on"})
    else: result = request(house.client, "GET", "/devices/" + other_brand.record["device_id"] + "/status")
    assert result.status_code == 401 and "Synthetic lamp" not in result.text
    method.assert_called_once()


def test_second_brand_no_check_and_unadvertised_capability_have_no_effect(house, other_brand):
    house.rt.save_devices([other_brand.record])
    with pytest.raises(HTTPException) as caught:
        hp.execute_device(other_brand.record["device_id"], hp.ExecuteDeviceRequest(capability="switch.on"), "internal")
    assert caught.value.status_code == 403
    result = request(house.client, "POST", "/devices/" + other_brand.record["device_id"] + "/execute", {"capability": "switch.toggle"})
    assert result.status_code == 422
    other_brand.driver.execute_checked.assert_not_called()


def test_second_brand_unknown_state_is_not_turned_into_false_or_true(house, other_brand):
    house.rt.save_devices([other_brand.record])
    other_brand.driver.get_status_checked.return_value = {"ok": True, "on": True, "verified": False}
    result = request(house.client, "GET", "/devices/" + other_brand.record["device_id"] + "/status")
    assert result.status_code == 200 and result.json()["ok"] is False and result.json()["on"] is None


@pytest.mark.parametrize("state", [None, "true", 0, 1, "missing"])
def test_future_bluetooth_adapter_cannot_verify_malformed_state(house, other_brand, state):
    house.rt.save_devices([other_brand.record])
    output = {"ok": True, "verified": True, "summary": "ON"}
    if state != "missing": output["on"] = state
    other_brand.driver.get_status_checked.return_value = output
    result = request(house.client, "GET", "/devices/" + other_brand.record["device_id"] + "/status")
    assert result.status_code == 200
    value = result.json()
    assert value["ok"] is False and value["on"] is None and value["verified"] is False
    assert value["summary"] == "Bluetooth state has not been verified."
