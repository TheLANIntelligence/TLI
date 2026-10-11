"""Routine edits retain legacy definitions and never operate physical devices."""
import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import actions_engine as A
from routers.system_routes import require_session


@pytest.fixture
def routine_api(tmp_path, monkeypatch):
    import companion_auth as auth
    monkeypatch.setattr(auth.S, "validate_session_token", lambda token: token == "routine-session")
    monkeypatch.setattr(auth.S, "get_session_user_id", lambda token: "alice")
    calls = []
    monkeypatch.setattr(A, "_CTX", {**A._CTX, "data_dir": tmp_path,
        "shelly_registry_path": tmp_path / "registry.json", "home_power_runtime": None,
        "shelly_driver": SimpleNamespace(turn_on=lambda **kw: calls.append(kw) or {"ok": True})})
    monkeypatch.setattr(A, "_INFLIGHT", set())
    monkeypatch.setattr(A, "_read_shelly_registry", lambda: [{"id": "lamp", "name": "Desk", "ip": "192.0.2.1", "relay": 0}])
    monkeypatch.setattr("intelligence.devices.with_context", lambda rows: rows)
    app = FastAPI(); app.include_router(A.router)
    app.dependency_overrides[require_session] = lambda: "alice"
    with TestClient(app) as api:
        api.cookies.set("tli_session", "routine-session")
        action = api.post("/actions/approve", json={"name": "Evening", "request_id": "create",
            "steps": [{"type": "shelly.switch", "device": "lamp", "value": "on", "driver_note": {"keep": True}, "_saved_driver_config": {"keep": True}}]}).json()["action"]
        yield api, action["id"], calls


def definition(api, ident):
    response = api.get(f"/actions/{ident}/definition")
    assert response.status_code == 200
    return response.json()


def patch(api, ident, **changes):
    return api.patch(f"/actions/{ident}", json={"expected_revision": definition(api, ident)["revision"],
                                               "request_id": "change", **changes})


def test_edit_retains_identity_legacy_metadata_and_receipts(routine_api):
    api, ident, calls = routine_api
    path, receipts = A._paths()
    store = A._load_json(path, {"actions": [], "triggers": []})
    store["actions"][0]["future"] = {"setting": [1, "keep"]}
    store["actions"][0]["steps"].append({"type": "future.wait", "duration": 15})
    store["triggers"] = [{"action_id": ident, "type": "daily", "enabled": True}]
    store["future_store"] = {"keep": True}
    A._save_json(path, store)
    original = copy.deepcopy(store)
    prior_receipts = receipts.read_bytes()
    response = patch(api, ident, name="Bedtime")
    assert response.status_code == 200
    changed = response.json()["action"]
    assert changed["name"] == "Bedtime"
    for key in ("id", "created_at", "enabled", "future", "steps"):
        assert changed[key] == original["actions"][0][key]
    persisted = A._load_json(path, {"actions": [], "triggers": []})["actions"][0]
    for key in ("_save_request", "_save_fingerprint"):
        assert persisted[key] == original["actions"][0][key]
    saved = api.get("/actions/list").json()
    assert saved["triggers"] == original["triggers"]
    assert saved["future_store"] == original["future_store"]
    assert receipts.read_bytes().startswith(prior_receipts)
    assert not calls


def test_edit_steps_preserves_metadata_and_rejects_unknown_step_loss(routine_api):
    api, ident, calls = routine_api
    path, _ = A._paths()
    store = A._load_json(path, {"actions": [], "triggers": []})
    legacy = {"type": "future.wait", "seconds": 3}
    store["actions"][0]["steps"].append(legacy)
    A._save_json(path, store)
    steps = copy.deepcopy(store["actions"][0]["steps"])
    steps[0]["value"] = "off"
    assert patch(api, ident, steps=steps).status_code == 200
    assert definition(api, ident)["action"]["steps"] == steps
    prior = path.read_bytes()
    assert patch(api, ident, request_id="remove-legacy", steps=steps[:1]).status_code == 422
    assert path.read_bytes() == prior and not calls


def test_definition_and_duplicate_round_trip_all_json_step_keys(routine_api):
    api, ident, calls = routine_api
    original = definition(api, ident)["action"]
    assert original["steps"][0]["_saved_driver_config"] == {"keep": True}
    duplicate = api.post('/actions/approve', json={"name": "Copy", "request_id": "copy", "steps": original["steps"]}).json()["action"]
    assert duplicate["id"] != ident and duplicate["steps"] == original["steps"]
    changed = copy.deepcopy(original["steps"]); changed[0]["value"] = "off"
    assert patch(api, ident, steps=changed).json()["action"]["steps"] == changed
    assert definition(api, ident)["action"]["steps"][0]["_saved_driver_config"] == {"keep": True}
    assert not calls


def test_request_replay_conflict_and_concurrent_edits(routine_api):
    api, ident, calls = routine_api
    initial = definition(api, ident)
    body = {"expected_revision": initial["revision"], "request_id": "edit-one", "name": "Office"}
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: api.patch(f"/actions/{ident}", json=body), range(2)))
    assert all(r.status_code == 200 for r in results)
    assert sum(r.json().get("duplicate", False) for r in results) == 1
    assert api.patch(f"/actions/{ident}", json={**body, "name": "Different"}).status_code == 409
    assert api.patch(f"/actions/{ident}", json={**body, "request_id": "other"}).status_code == 409
    assert patch(api, ident, request_id="newer", name="Current").status_code == 200
    assert api.patch(f"/actions/{ident}", json=body).status_code == 409
    assert definition(api, ident)["action"]["name"] == "Current" and not calls


def test_archive_blocks_prepared_run_and_restore_keeps_disabled(routine_api):
    api, ident, calls = routine_api
    reviewed = api.get(f"/actions/{ident}/review").json()
    run = {"request_id": "run", "expected_revision": reviewed["revision"], "expected_targets": reviewed["target_revision"]}
    assert patch(api, ident, archived=True).status_code == 200
    assert api.get(f"/actions/{ident}/review").json()["available"] is False
    assert api.post(f"/actions/run/{ident}", json=run).status_code == 409
    path, _ = A._paths(); store = A._load_json(path, {"actions": [], "triggers": []})
    store["actions"][0]["enabled"] = False; A._save_json(path, store)
    response = patch(api, ident, request_id="restore", archived=False)
    assert response.status_code == 200 and response.json()["action"]["enabled"] is False
    assert api.get(f"/actions/{ident}/review").json()["available"] is False
    assert not calls


def test_running_routine_rejects_edit_and_archive(routine_api, monkeypatch):
    api, ident, calls = routine_api
    entered, release = Event(), Event()
    def execute(**kw):
        calls.append(kw); entered.set(); assert release.wait(5)
        return {"ok": True}
    monkeypatch.setitem(A._CTX, "shelly_driver", SimpleNamespace(turn_on=execute))
    reviewed = api.get(f"/actions/{ident}/review").json()
    run = {"request_id": "run", "expected_revision": reviewed["revision"], "expected_targets": reviewed["target_revision"]}
    with ThreadPoolExecutor(2) as pool:
        running = pool.submit(api.post, f"/actions/run/{ident}", json=run)
        try:
            assert entered.wait(3)
            assert patch(api, ident, name="Edit").status_code == 409
            assert patch(api, ident, archived=True).status_code == 409
        finally:
            release.set()
        assert running.result().json()["ok"]
    assert len(calls) == 1


def test_failed_write_preserves_store_and_metadata_validation(routine_api, monkeypatch):
    api, ident, calls = routine_api
    path, _ = A._paths(); before = path.read_bytes()
    for body in ({"name": "  "}, {"archived": "false"}, {"steps": []}, {"enabled": True}):
        assert patch(api, ident, **body).status_code == 422
    def fail(*args):
        from fastapi import HTTPException
        raise HTTPException(503, "Fixture disk full")
    monkeypatch.setattr(A, "_save_json", fail)
    assert patch(api, ident, name="Unwritten").status_code == 503
    assert path.read_bytes() == before and not calls


def test_receipt_failure_does_not_lose_confirmed_mutation_or_retry_it(routine_api, monkeypatch):
    api, ident, calls = routine_api
    body = {"expected_revision": definition(api, ident)["revision"], "request_id": "edit", "name": "Saved"}
    monkeypatch.setattr(A, "_append_receipt", lambda row: (_ for _ in ()).throw(OSError("disk full")))
    result = api.patch(f"/actions/{ident}", json=body)
    assert result.status_code == 200 and result.json()["receipt_saved"] is False
    assert api.patch(f"/actions/{ident}", json=body).json()["duplicate"] is True
    assert definition(api, ident)["action"]["name"] == "Saved" and not calls
