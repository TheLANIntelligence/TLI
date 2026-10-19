"""Real admission and synthetic action/scene boundaries; no running host or hardware."""
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import companion_auth
import tli_state as S
from narrator_policy import NarratorPolicy
from routers import actions_engine, dashboard_presence as dp, home_power


LOCAL = "http://localhost:8000"
REMOTE = "https://tli.test:8000"
PRIVATE = "Synthetic private action"
OPERATIONS = ("confirm", "secondary", "dismiss")


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    action = dp._make_action(PRIVATE, "Private context", "Review", "open_devices", 10)
    action["secondary_handler"] = "open_home_auto"
    monkeypatch.setattr(dp, "_action_queue", [action])
    monkeypatch.setattr(dp, "_inflight_actions", set())
    monkeypatch.setattr(dp, "_disk_snoozes", {})
    monkeypatch.setattr(dp, "_narrator_policy", NarratorPolicy())
    monkeypatch.setattr(dp, "_narrator", {"type": "status", "text": "", "timestamp": 0})
    calls, receipts = [], []
    original_prune = dp._prune_disk_actions

    def prune(now):
        calls.append("prune")
        return original_prune(now)

    monkeypatch.setattr(dp, "_prune_disk_actions", prune)
    monkeypatch.setattr(dp, "_refresh_narrator", lambda *args: None)
    monkeypatch.setattr(dp, "_broadcast_narrator_update", lambda: None)
    monkeypatch.setattr(dp, "_broadcast_action_update", lambda: calls.append("broadcast"))
    monkeypatch.setattr(dp, "log_debug", lambda *args: None)
    monkeypatch.setattr(actions_engine, "_append_receipt", receipts.append)
    app = FastAPI()
    app.include_router(dp.router)
    assert not app.dependency_overrides
    return SimpleNamespace(app=app, action=action, calls=calls, receipts=receipts)


def token():
    S.save_pin_config("a" * 64, "b" * 64)
    return S.create_session_token("alice")


def post(surface, operation, *, origin=REMOTE, peer="192.168.1.20", headers=None, action_id=None):
    with TestClient(surface.app, base_url=origin, client=(peer, 40000)) as client:
        return client.post("/dashboard/action/" + operation,
                           json={"action_id": action_id or surface.action["id"]}, headers=headers or {})


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("mode,status", [
    ("missing_cookie", 401), ("revoked_cookie", 401),
    ("open_lan", 403), ("loopback_dns", 403), ("http_remote", 403),
    ("missing_origin", 403), ("cross_origin", 403), ("duplicate_origin", 403),
    ("same_site", 403), ("companion", 403), ("peer", 403), ("proxy", 403),
])
def test_denied_before_queue_or_dispatch(surface, operation, mode, status):
    original = deepcopy(surface.action)
    cookie = token()
    origin, peer = REMOTE, "192.168.1.20"
    headers = {"Cookie": "tli_session=" + cookie, "Origin": REMOTE}
    if mode == "missing_cookie":
        headers.pop("Cookie")
    elif mode == "revoked_cookie":
        S._active_sessions.clear()
    elif mode in ("open_lan", "loopback_dns"):
        S.clear_pin_config()
        headers.pop("Cookie")
        if mode == "loopback_dns":
            peer = "127.0.0.1"
    elif mode == "http_remote":
        origin = "http://tli.test:8000"
        headers["Origin"] = origin
    elif mode == "missing_origin":
        headers.pop("Origin")
    elif mode == "cross_origin":
        headers["Origin"] = "https://other.test"
    elif mode == "duplicate_origin":
        headers = [*headers.items(), ("Origin", REMOTE)]
    elif mode == "same_site":
        headers["Sec-Fetch-Site"] = "same-site"
    elif mode == "companion":
        invitation, _ = companion_auth.create_pairing("alice", REMOTE, "f" * 64)
        paired = companion_auth.redeem_pairing(invitation, REMOTE, "f" * 64, "Synthetic phone", "ios")
        headers["Authorization"] = "Bearer " + paired["credential"]
    elif mode == "peer":
        headers["X-TLI-Peer-Id"] = "synthetic-peer"
    elif mode == "proxy":
        headers["Forwarded"] = "for=127.0.0.1;proto=https"
    response = post(surface, operation, origin=origin, peer=peer, headers=headers)
    assert response.status_code == status, response.text
    assert PRIVATE not in response.text
    assert surface.calls == [] and surface.receipts == []
    assert surface.action == original and not dp._inflight_actions


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("mode", ("open_local", "pin_local", "pin_https"))
def test_authorized_browser_preserves_action_contract(surface, operation, mode):
    origin = REMOTE if mode == "pin_https" else LOCAL
    peer = "192.168.1.20" if mode == "pin_https" else "127.0.0.1"
    headers = {"Origin": origin}
    if mode == "open_local":
        S.clear_pin_config()
    else:
        headers["Cookie"] = "tli_session=" + token()
    response = post(surface, operation, origin=origin, peer=peer, headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["ok"] is True
    assert not dp._inflight_actions
    if operation == "dismiss":
        assert surface.action["snoozed_until_ts"] == response.json()["snoozed_until"]
        assert not surface.receipts
    else:
        assert len(surface.receipts) == 1 and surface.receipts[0]["ok"] is True
        assert (surface.action in dp._action_queue) is (operation == "secondary")


@pytest.mark.parametrize("operation", OPERATIONS)
def test_revoked_while_waiting_for_queue_lock_changes_nothing(surface, monkeypatch, operation):
    cookie = token()
    original = deepcopy(surface.action)

    @contextmanager
    def revoking_lock():
        S._active_sessions.clear()
        yield

    monkeypatch.setattr(dp, "_action_lock", revoking_lock())
    response = post(surface, operation, headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401
    assert surface.action == original and not surface.calls and not surface.receipts


@pytest.mark.parametrize("operation", OPERATIONS)
def test_revoked_during_queue_refresh_cannot_dispatch_or_snooze(surface, monkeypatch, operation):
    cookie = token()
    original = deepcopy(surface.action)
    monkeypatch.setattr(dp, "_prune_disk_actions", lambda now: S._active_sessions.clear())
    response = post(surface, operation, headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401
    assert surface.action == original and not surface.receipts and not dp._inflight_actions


@pytest.mark.parametrize("operation", ("confirm", "secondary"))
def test_revoked_after_claim_releases_inflight_without_dispatch(surface, monkeypatch, operation):
    cookie = token()

    class Claims(set):
        def add(self, value):
            super().add(value)
            S._active_sessions.clear()

    monkeypatch.setattr(dp, "_inflight_actions", Claims())
    monkeypatch.setattr(dp, "_dispatch_handler", lambda *args, **kwargs: pytest.fail("Dispatch after revocation"))
    response = post(surface, operation, headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401
    assert surface.action in dp._action_queue and not surface.receipts and not dp._inflight_actions


@pytest.mark.parametrize("audit_failure", (False, True))
def test_completed_outcome_is_not_disclosed_after_revocation(surface, monkeypatch, audit_failure):
    cookie = token()

    def handler(*args, **kwargs):
        S._active_sessions.clear()
        return {"ok": True, "narrator_msg": PRIVATE}

    monkeypatch.setattr(dp, "_dispatch_handler", handler)
    if audit_failure:
        def fail(receipt):
            raise OSError("Synthetic private receipt path")
        monkeypatch.setattr(actions_engine, "_append_receipt", fail)
    response = post(surface, "confirm", headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401
    assert PRIVATE not in response.text and "receipt path" not in response.text
    assert surface.action not in dp._action_queue and not dp._inflight_actions
    if not audit_failure:
        assert surface.receipts[0]["ok"] is True


@pytest.fixture
def scene(tmp_path, monkeypatch):
    calls = []
    runtime = home_power.HomePowerRuntime(tmp_path, SimpleNamespace(), lambda *args, **kw: None)
    runtime.save_scenes([{"scene_id": "synthetic", "name": PRIVATE, "actions": [
        {"device_id": "one", "capability": "switch.off"},
        {"device_id": "two", "capability": "switch.off"},
    ]}])
    runtime.save_devices([{"device_id": name, "vendor": "test", "ip": "192.0.2." + str(index)}
                          for index, name in enumerate(("one", "two"), 1)])

    def execute(device, capability):
        calls.append(device["device_id"])
        return {"ok": True, "summary": "Acknowledged"}

    runtime._driver_registry = {"test": SimpleNamespace(execute=execute)}
    monkeypatch.setattr(home_power, "get_runtime", lambda: runtime)
    return runtime, calls


@pytest.mark.parametrize("operation", ("confirm", "secondary"))
@pytest.mark.parametrize("boundary", ("scene_read", "device_read", "driver_success", "driver_error"))
def test_scene_rechecks_between_reads_and_effects(surface, scene, monkeypatch, operation, boundary):
    runtime, calls = scene
    surface.action["handler"] = surface.action["secondary_handler"] = "run_scene:synthetic"
    cookie = token()
    if boundary in ("scene_read", "device_read"):
        name = "_find_scene" if boundary == "scene_read" else "_find_device"
        original = getattr(runtime, name)
        def lookup(value):
            result = original(value)
            S._active_sessions.clear()
            return result
        monkeypatch.setattr(runtime, name, lookup)
    else:
        def execute(device, capability):
            calls.append(device["device_id"])
            S._active_sessions.clear()
            if boundary == "driver_error":
                raise RuntimeError("Synthetic private adapter failure")
            return {"ok": True, "summary": "Acknowledged"}
        runtime._driver_registry["test"].execute = execute
    response = post(surface, operation, headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401, response.text
    assert PRIVATE not in response.text and "adapter failure" not in response.text
    assert not dp._inflight_actions
    if boundary in ("scene_read", "device_read"):
        assert calls == [] and not runtime.read_receipts() and not surface.receipts
        assert surface.action in dp._action_queue
    else:
        assert calls == ["one"]
        assert surface.action not in dp._action_queue
        evidence = runtime.read_receipts()[0]["extra"]
        assert evidence["ok"] is False and evidence["access_stopped"] is True
        assert evidence["dispatched"] == 1 and len(evidence["results"]) == 1
        assert evidence["results"][0]["ok"] is (boundary == "driver_success")
        assert surface.receipts[0]["receipt"]["access_stopped"] is True
        # Even a newly unlocked browser cannot replay the partially run ID.
        retry = post(surface, operation, headers={"Origin": REMOTE, "Cookie": "tli_session=" + token()})
        assert retry.status_code == 404 and calls == ["one"]


@pytest.mark.parametrize("capability", ("switch.on", "switch.off", "switch.toggle"))
def test_legacy_adapter_checks_access_after_dispatch_and_stops_later_device(scene, monkeypatch, capability):
    runtime, calls = scene
    denied = [False]
    def check():
        if denied[0]:
            raise HTTPException(401, "Synthetic access revoked")
    def execute(**kwargs):
        calls.append(kwargs["ip"])
        denied[0] = True
        return {"raw": {"was_on": False}, "summary": "Acknowledged"}
    runtime.shelly_driver = SimpleNamespace(turn_on=execute, turn_off=execute, toggle=execute)
    runtime.save_devices([{"device_id": name, "vendor": "shelly", "ip": "192.0.2." + str(index)}
                          for index, name in enumerate(("one", "two"), 1)])
    saved = runtime.load_scenes()
    for action in saved[0]["actions"]:
        action["capability"] = capability
    runtime.save_scenes(saved)
    with pytest.raises(home_power.SceneAccessStopped) as error:
        runtime.run_scene("synthetic", check=check)
    assert error.value.status_code == 401 and calls == ["192.0.2.1"]
    assert error.value.scene_result["access_stopped"] is True


def test_scene_receipt_failure_cannot_hide_access_denial_or_repeat(surface, scene, monkeypatch):
    runtime, calls = scene
    surface.action["handler"] = "run_scene:synthetic"
    cookie = token()
    def execute(device, capability):
        calls.append(device["device_id"])
        S._active_sessions.clear()
        return {"ok": True}
    def fail(*args, **kwargs):
        raise OSError("Synthetic private receipt failure")
    runtime._driver_registry["test"].execute = execute
    monkeypatch.setattr(runtime, "receipt", fail)
    response = post(surface, "confirm", headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401 and calls == ["one"]
    assert surface.action not in dp._action_queue and not dp._inflight_actions
    assert surface.receipts[0]["receipt"]["scene_result"]["receipt_unavailable"] is True


def test_scene_ordinary_failure_still_records_all_steps_for_internal_callers(scene):
    runtime, calls = scene
    def execute(device, capability):
        calls.append(device["device_id"])
        if device["device_id"] == "one":
            raise RuntimeError("Synthetic unreachable device")
        return {"ok": True}
    runtime._driver_registry["test"].execute = execute
    result = runtime.run_scene("synthetic")
    assert result["ok"] is False and calls == ["one", "two"]
    assert [row["ok"] for row in result["results"]] == [False, True]
    assert "access_stopped" not in result


def test_scene_preview_never_dispatches_and_retains_contract(scene):
    runtime, calls = scene
    result = runtime.run_scene("synthetic", dry_run=True, check=lambda: None)
    assert result["ok"] is True and calls == []
    assert all(row["dry_run"] for row in result["results"])
    assert runtime.read_receipts()[0]["kind"] == "scene_preview"


@pytest.mark.parametrize("operation", ("confirm", "secondary"))
@pytest.mark.parametrize("success", (False, True))
@pytest.mark.parametrize("append_error", (False, True))
def test_access_lost_while_scene_receipt_is_saved_retires_id_without_losing_outcome(surface, scene, monkeypatch, operation, success, append_error):
    runtime, calls = scene
    cookie = token()
    surface.action["handler"] = surface.action["secondary_handler"] = "run_scene:synthetic"
    def execute(device, capability):
        calls.append(device["device_id"])
        return {"ok": success}
    runtime._driver_registry["test"].execute = execute
    original = runtime.receipt
    def record(*args, **kwargs):
        result = original(*args, **kwargs)
        S._active_sessions.clear()
        if append_error:
            raise OSError("Synthetic late append failure")
        return result
    monkeypatch.setattr(runtime, "receipt", record)
    response = post(surface, operation, headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401 and calls == ["one", "two"]
    assert surface.action not in dp._action_queue and not dp._inflight_actions
    assert len(runtime.read_receipts()) == 1
    assert runtime.read_receipts()[0]["extra"]["ok"] is success
    outcome = surface.receipts[0]["receipt"]["scene_result"]
    assert outcome["execution_completed"] is True and outcome["ok"] is success
    assert len(outcome["results"]) == 2
    assert outcome.get("receipt_unavailable", False) is append_error


@pytest.mark.parametrize("operation", ("confirm", "secondary"))
@pytest.mark.parametrize("boundary", ("audit_return", "audit_error", "next_action"))
def test_late_access_loss_retires_failed_attempt_without_exposing_it(surface, monkeypatch, operation, boundary):
    cookie = token()
    monkeypatch.setattr(dp, "_dispatch_handler", lambda *args, **kwargs: {"ok": False, "error": PRIVATE})
    if boundary.startswith("audit"):
        def record(receipt):
            surface.receipts.append(receipt)
            S._active_sessions.clear()
            if boundary == "audit_error":
                raise OSError("Synthetic private audit path")
        monkeypatch.setattr(actions_engine, "_append_receipt", record)
    else:
        def next_action():
            S._active_sessions.clear()
            return {"id": PRIVATE}
        monkeypatch.setattr(dp, "get_top_action", next_action)
    response = post(surface, operation, headers={"Origin": REMOTE, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401
    assert PRIVATE not in response.text and "audit path" not in response.text
    assert surface.action not in dp._action_queue and not dp._inflight_actions
    assert surface.receipts[0]["ok"] is False


@pytest.mark.parametrize("first,second", [("confirm", "secondary"), ("secondary", "confirm")])
def test_confirm_and_secondary_share_one_inflight_claim(surface, monkeypatch, first, second):
    cookie = token()
    headers = {"Origin": REMOTE, "Cookie": "tli_session=" + cookie}
    entered, release = Event(), Event()
    calls = []
    def handler(*args, **kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return {"ok": True}
    monkeypatch.setattr(dp, "_dispatch_handler", handler)
    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(post, surface, first, headers=headers)
        try:
            assert entered.wait(5)
            assert post(surface, second, headers=headers).status_code == 409
        finally:
            release.set()
        assert future.result(timeout=5).status_code == 200
    assert calls == [1] and not dp._inflight_actions


def test_pin_removal_mid_scene_does_not_turn_original_cookie_into_local_authority(surface, scene):
    runtime, calls = scene
    cookie = token()
    surface.action["handler"] = "run_scene:synthetic"
    def execute(device, capability):
        calls.append(device["device_id"])
        S.clear_pin_config()
        return {"ok": True}
    runtime._driver_registry["test"].execute = execute
    response = post(surface, "confirm", origin=LOCAL, peer="127.0.0.1",
                    headers={"Origin": LOCAL, "Cookie": "tli_session=" + cookie})
    assert response.status_code == 401 and calls == ["one"]
    assert surface.action not in dp._action_queue and not dp._inflight_actions
