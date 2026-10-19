from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import actions_engine as actions, dashboard_presence as dp
from narrator_policy import NarratorPolicy
from action_results import driver_succeeded


def run_reviewed(api):
    value = api.get("/actions/test/review").json()
    return api.post("/actions/run/test", headers={"Cookie": "tli_session=routine-fixture-session"}, json={"request_id": "reviewed-test-run",
        "expected_revision": value["revision"], "expected_targets": value["target_revision"]})


@pytest.fixture
def saved_actions(monkeypatch, tmp_path):
    import companion_auth as auth
    monkeypatch.setattr(auth.S, "validate_session_token", lambda token: token == "routine-fixture-session")
    monkeypatch.setattr(auth.S, "get_session_user_id", lambda token: "test-user")
    registry = [
        {"name": "Office Lamp", "ip": "192.168.1.10", "relay": 0},
        {"name": "Office Fan", "ip": "192.168.1.11", "relay": 0},
    ]
    calls = []
    responses = [True, True]
    def execute(**kw):
        calls.append(kw)
        out = responses[len(calls) - 1]
        if isinstance(out, Exception):
            raise out
        return out
    monkeypatch.setattr(actions, "_CTX", {**actions._CTX, "data_dir": tmp_path,
                        "shelly_registry_path": tmp_path / "shelly.json",
                        "shelly_driver": SimpleNamespace(set_relay=execute)})
    monkeypatch.setattr(actions, "_read_shelly_registry", lambda: registry)
    def save(targets):
        steps = [{"type": "shelly.switch", "device": target, "value": "off"} for target in targets]
        actions._save_json(actions._paths()[0], {"actions": [{"id": "test", "name": "Office", "steps": steps}], "triggers": []})
    return save, calls, responses


@pytest.fixture
def action_browser_client(app, saved_actions):
    """Use the saved-action fixture's browser identity over supported transport."""
    # Do not enter the full app's lifespan for these route tests.
    api = TestClient(app, base_url="http://localhost", client=("127.0.0.1", 40000),
                     headers={"Origin": "http://localhost"},
                     cookies={"tli_session": "routine-fixture-session"})
    try:
        yield api
    finally:
        api.close()


def test_ambiguous_later_step_prevents_all_execution(action_browser_client, saved_actions):
    save, calls, _ = saved_actions
    save(["Office Lamp", "Office"])
    body = action_browser_client.post("/actions/run/test").json()
    assert body["ok"] is False
    assert calls == []
    assert body["review_required"] and not body["actions_performed"]
    review = action_browser_client.get("/actions/test/review").json()
    assert not review["available"] and "Multiple devices" in review["errors"]["1"]
    assert run_reviewed(action_browser_client).status_code == 409


@pytest.mark.parametrize("responses, expected, word", [
    ([True, True], True, "Completed"),
    ([True, False], False, "Partially"),
    ([False, RuntimeError("unreachable")], False, "Failed"),
])
def test_saved_action_truthful_results_and_receipts(action_browser_client, saved_actions, responses, expected, word):
    save, calls, replies = saved_actions
    save(["Office Lamp", "Office Fan"])
    replies[:] = responses
    body = run_reviewed(action_browser_client).json()
    assert body["ok"] is expected
    assert word in body["summary"]
    assert len(calls) == 2
    receipt_app = FastAPI()
    receipt_app.include_router(actions.router)
    # Keep the existing execution fixture; receipt reads exercise real route
    # dependencies over direct loopback with its captured browser credential.
    with TestClient(receipt_app, base_url="http://localhost", client=("127.0.0.1", 40000),
                    cookies={"tli_session": "routine-fixture-session"}) as receipt_client:
        response = receipt_client.get("/actions/receipts")
    assert response.status_code == 200
    receipt = next(row for row in response.json()["items"] if row.get("kind") == "action_run")
    assert receipt["ok"] is expected
    assert receipt["results"] == body["results"]


@pytest.mark.parametrize("result, expected", [(False, False), ({"ok": False}, False),
    ({"ok": True}, True), ({"raw": {"was_on": True}}, True),
    ({"raw": {"code": -1, "message": "bad"}}, False), ({}, False)])
def test_legacy_and_current_driver_results(result, expected):
    assert driver_succeeded(result) is expected


def test_bundled_shelly_driver_contract_is_supported(action_browser_client, saved_actions, monkeypatch):
    save, calls, _ = saved_actions
    save(["Office Lamp"])
    def turn_off(**kw):
        calls.append(kw)
        return {"raw": {"was_on": True}, "summary": "status loaded"}
    monkeypatch.setitem(actions._CTX, "shelly_driver", SimpleNamespace(turn_off=turn_off))
    assert run_reviewed(action_browser_client).json()["ok"] is True
    assert calls == [{"ip": "192.168.1.10", "relay": 0}]


@pytest.fixture
def dashboard(monkeypatch):
    action = dp._make_action("Review storage", "", "Review", "open_visualizer", 10)
    monkeypatch.setattr(dp, "_action_queue", [action])
    monkeypatch.setattr(dp, "_inflight_actions", set())
    monkeypatch.setattr(dp, "_narrator_policy", NarratorPolicy())
    monkeypatch.setattr(dp, "_narrator", {"type": "status", "text": "", "timestamp": 0})
    receipts = []
    monkeypatch.setattr(actions, "_append_receipt", receipts.append)
    return action, receipts


def test_navigation_reports_opened_panel(browser_client, dashboard):
    action, receipts = dashboard
    body = browser_client.post("/dashboard/action/confirm", json={"action_id": action["id"]}).json()
    assert body["ok"] is True
    assert body["receipt"]["navigate_to"] == "panel-visualizer"
    assert "Opened Free Space for review" in dp._get_narrator()["text"]
    assert action not in dp._action_queue
    assert receipts[0]["ok"] is True


def test_failed_action_stays_for_explicit_retry(browser_client, dashboard, monkeypatch):
    action, receipts = dashboard
    calls = []
    def handler(_, **kwargs):
        calls.append(1)
        return {"ok": False, "error": "Device unreachable"}
    monkeypatch.setattr(dp, "_dispatch_handler", handler)
    body = browser_client.post("/dashboard/action/confirm", json={"action_id": action["id"]}).json()
    assert body["ok"] is False
    assert dp._get_narrator()["type"] == "alert"
    assert "failed" in dp._get_narrator()["text"]
    assert action in dp._action_queue
    assert calls == [1] and receipts[0]["ok"] is False


def test_simultaneous_confirmations_execute_once(browser_client, dashboard, monkeypatch):
    action, _ = dashboard
    entered, release = Event(), Event()
    calls = []
    def handler(_, **kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return {"ok": True}
    monkeypatch.setattr(dp, "_dispatch_handler", handler)
    def request():
        return browser_client.post("/dashboard/action/confirm", json={"action_id": action["id"]})
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(request)
        try:
            assert entered.wait(5)
            assert request().status_code == 409
        finally:
            release.set()
        assert first.result(timeout=5).json()["ok"] is True
    assert len(calls) == 1
    assert request().status_code == 404


def test_secondary_failure_preserves_card_and_status(browser_client, dashboard, monkeypatch):
    action, _ = dashboard
    action["secondary_handler"] = "unknown"
    body = browser_client.post("/dashboard/action/secondary", json={"action_id": action["id"]}).json()
    assert body["ok"] is False
    assert action in dp._action_queue


def test_partial_scene_is_not_success(monkeypatch):
    from routers import home_power
    monkeypatch.setattr(home_power, "get_runtime", lambda: SimpleNamespace(run_scene=lambda _: {
        "ok": False, "results": [{"ok": True}, {"ok": False}]}))
    receipt = dp._dispatch_handler("run_scene:test")
    assert receipt["ok"] is False
    assert "Partially" in receipt["narrator_msg"]


def test_missing_explicit_id_prevents_earlier_shelly_step(action_browser_client, saved_actions, monkeypatch):
    save, calls, _ = saved_actions
    save(["Office Lamp"])
    path = actions._paths()[0]
    store = actions._load_json(path, {})
    store["actions"][0]["steps"].append({"type": "homepower.execute", "device_id": "missing", "capability": "switch.off"})
    actions._save_json(path, store)
    monkeypatch.setitem(actions._CTX, "home_power_runtime", SimpleNamespace(_find_device=lambda _: None))
    assert action_browser_client.post("/actions/run/test").json()["ok"] is False
    assert run_reviewed(action_browser_client).status_code == 409
    assert not calls


def test_explicit_id_action_keeps_its_target(action_browser_client, saved_actions, monkeypatch):
    save, calls, _ = saved_actions
    save([])
    path = actions._paths()[0]
    store = actions._load_json(path, {})
    store["actions"][0]["steps"] = [{"type": "homepower.execute", "device_id": "lamp-1", "capability": "switch.off"}]
    actions._save_json(path, store)
    device = {"device_id": "lamp-1", "vendor": "test"}
    def execute(target, cap):
        calls.append((target, cap))
        return {"ok": True}
    runtime = SimpleNamespace(_find_device=lambda ident: device if ident == "lamp-1" else None,
                              _driver_registry={"test": SimpleNamespace(execute=execute)})
    monkeypatch.setitem(actions._CTX, "home_power_runtime", runtime)
    assert run_reviewed(action_browser_client).json()["ok"] is True
    assert calls == [(device, "switch.off")]


def test_legacy_cleanup_action_opens_review_without_moving_or_scanning(monkeypatch):
    from cleanup import executor
    from routers import cleanup_routes
    monkeypatch.setattr(cleanup_routes, "get_file_index", lambda: pytest.fail("No legacy scan read"))
    monkeypatch.setattr(executor, "execute_clean_safe", lambda *a, **kw: pytest.fail("No move"))
    receipt = dp._dispatch_handler("cleanup_clean_safe")
    assert receipt["ok"] is True and receipt["review_required"] is True
    assert receipt["navigate_to"] == "panel-visualizer"
    assert "Nothing was moved" in receipt["narrator_msg"] and "receipt" not in receipt


def test_failure_cannot_return_a_success_message_to_frontend(browser_client, dashboard, monkeypatch):
    action, _ = dashboard
    monkeypatch.setattr(dp, "_dispatch_handler", lambda _, **kwargs: {"ok": False, "narrator_msg": "Done"})
    body = browser_client.post("/dashboard/action/confirm", json={"action_id": action["id"]}).json()
    assert body["receipt"]["narrator_msg"].startswith("Action failed:")
