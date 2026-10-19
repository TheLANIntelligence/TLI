"""Saved action preservation, explicit review, duplicate saves and uncertain runs."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from routers import actions_engine as A
from routers.system_routes import require_session


@pytest.fixture
def setup(tmp_path, monkeypatch):
    import companion_auth as auth
    monkeypatch.setattr(auth.S, "validate_session_token", lambda token: token == "routine-fixture-session")
    monkeypatch.setattr(auth.S, "get_session_user_id", lambda token: "alice")
    calls = []
    devices = [{"id": "lamp", "name": "Desk", "ip": "192.0.2.1", "relay": 1}]
    monkeypatch.setattr(A, "_CTX", {**A._CTX, "data_dir": tmp_path, "shelly_registry_path": tmp_path / "registry.json",
        "shelly_driver": SimpleNamespace(turn_on=lambda **kw: calls.append(kw) or {"ok": True})})
    monkeypatch.setattr(A, "_read_shelly_registry", lambda: copy.deepcopy(devices))
    monkeypatch.setattr("intelligence.devices.with_context", lambda value: value)
    A._INFLIGHT.clear()
    app = FastAPI(); app.include_router(A.router)
    app.dependency_overrides[require_session] = lambda: "alice"
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 40000),
                    headers={"Origin": "http://localhost"}) as api:
        api.cookies.set("tli_session", "routine-fixture-session")
        yield api, calls, devices
    A._INFLIGHT.clear()


def draft(**extra):
    return {"name": "Desk setup", "steps": [{"type": "shelly.switch", "device": "Desk", "value": "on"}], **extra}


def saved(api):
    result = api.post("/actions/approve", json=draft())
    assert result.status_code == 200
    return result.json()["action"]["id"]


def review(api, ident, request="run-one"):
    result = api.get(f"/actions/{ident}/review")
    assert result.status_code == 200
    body = result.json()
    return {"request_id": request, "expected_revision": body["revision"], "expected_targets": body["target_revision"]}


def browser_receipts(headers=None):
    """Use the captured fixture cookie through actual receipt dependencies."""
    from companion_auth import validate_authorization
    app = FastAPI()
    app.include_router(A.router)
    app.middleware("http")(validate_authorization)
    assert not app.dependency_overrides
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 40000),
                    cookies={"tli_session": "routine-fixture-session"}) as api:
        return api.get("/actions/receipts", headers=headers)


@pytest.mark.parametrize("raw", [b"{broken", b"null", b"[]", b'{"actions":[],"triggers":null}',
                                  b'{"actions":[],"triggers":[],"actions":[]}'])
def test_corruption_cannot_be_replaced_or_displayed_as_empty(setup, raw):
    api, calls, _ = setup
    path = A._paths()[0]; path.write_bytes(raw)
    for result in [api.get("/actions/list"), api.post("/actions/approve", json=draft()), api.post("/actions/run/missing")]:
        assert result.status_code == 503
        assert path.read_bytes() == raw
    assert not calls


def test_parallel_saves_preserve_all_actions_and_same_request_saves_once(setup):
    api, calls, _ = setup
    def save(index):
        return api.post("/actions/approve", json=draft(name=f"Action {index}", request_id=f"save-{index}"))
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(save, [1, 2, 3, 1]))
    assert all(r.status_code == 200 for r in results)
    assert len(api.get("/actions/list").json()["actions"]) == 3
    bad = api.post("/actions/approve", json=draft(name="Different draft", request_id="save-1"))
    assert bad.status_code == 409 and not calls


def test_unsaved_preview_and_saved_review_do_not_mutate_or_execute(setup):
    api, calls, _ = setup
    response = api.post("/actions/preview", json=draft())
    assert response.status_code == 200 and response.json()["available"]
    assert response.json()["steps"][0]["target"]["relay"] == 1
    assert not A._paths()[0].exists() and not A._paths()[1].exists()
    ident = saved(api)
    before = A._paths()[0].read_bytes(), A._paths()[1].read_bytes()
    result = api.get(f"/actions/{ident}/review").json()
    assert not result["actions_performed"] and result["available"]
    assert (A._paths()[0].read_bytes(), A._paths()[1].read_bytes()) == before
    assert not calls
    assert api.get("/actions/capabilities").json()["trigger_engine"]["available"] is False


def test_target_changes_and_saved_edits_reject_before_devices(setup):
    api, calls, devices = setup
    ident = saved(api); body = review(api, ident)
    devices[0]["relay"] = 0
    assert api.post(f"/actions/run/{ident}", json=body).status_code == 409
    devices[0]["relay"] = 1
    store = A._load_json(A._paths()[0], {"actions": [], "triggers": []})
    store["actions"][0]["enabled"] = False
    A._save_json(A._paths()[0], store)
    assert api.post(f"/actions/run/{ident}", json=body).status_code == 409
    assert not calls


def test_completed_duplicate_returns_receipt_and_uncertain_started_does_not_replay(setup):
    api, calls, _ = setup
    ident = saved(api); body = review(api, ident)
    result = api.post(f"/actions/run/{ident}", json=body)
    assert result.status_code == 200 and result.json()["ok"]
    duplicate = api.post(f"/actions/run/{ident}", json=body).json()
    assert duplicate["ok"] and duplicate["duplicate"] and len(calls) == 1
    assert duplicate["receipt_saved"] is True
    lines = [json.loads(row) for row in A._paths()[1].read_text().splitlines()]
    A._paths()[1].write_text("\n".join(json.dumps(row) for row in lines if row["kind"] != "action_run") + "\n")
    A._INFLIGHT.clear()
    result = api.post(f"/actions/run/{ident}", json=body)
    assert result.status_code == 409 and "already started" in result.json()["detail"]
    assert len(calls) == 1


def test_simultaneous_reviewed_requests_are_guarded(setup, monkeypatch):
    api, calls, _ = setup
    ident = saved(api)
    body = review(api, ident)
    entered, release = Event(), Event()
    def execute(**kw):
        calls.append(kw); entered.set(); assert release.wait(5)
        return {"ok": True}
    monkeypatch.setitem(A._CTX, "shelly_driver", SimpleNamespace(turn_on=execute))
    with ThreadPoolExecutor(2) as pool:
        one = pool.submit(api.post, f"/actions/run/{ident}", json=body)
        try:
            assert entered.wait(3)
            assert api.post(f"/actions/run/{ident}", json=body).status_code == 409
        finally:
            release.set()
        assert one.result().json()["ok"]
    assert len(calls) == 1


def test_legacy_run_without_review_never_touches_devices_or_execution_receipts(setup):
    api, calls, _ = setup
    ident = saved(api)
    previous = A._paths()[1].read_bytes()
    with ThreadPoolExecutor(3) as pool:
        results = list(pool.map(lambda _: api.post(f"/actions/run/{ident}").json(), range(3)))
    assert all(r["review_required"] and not r["actions_performed"] for r in results)
    assert not calls and A._paths()[1].read_bytes() == previous


def test_lock_between_steps_preserves_first_outcome_and_skips_the_rest(setup, monkeypatch):
    api, calls, devices = setup
    import companion_auth
    authorized = [True]
    def bind(request, owner):
        def check():
            if not authorized[0]:
                from fastapi import HTTPException
                raise HTTPException(401, "Session locked")
        return check
    monkeypatch.setattr("browser_authority.operation_access", bind)
    ident = saved(api)
    store = A._load_json(A._paths()[0], {"actions": [], "triggers": []})
    store["actions"][0]["steps"] *= 2
    A._save_json(A._paths()[0], store)
    body = review(api, ident)
    def execute(**kw):
        calls.append(kw); authorized[0] = False
        return {"ok": True}
    monkeypatch.setitem(A._CTX, "shelly_driver", SimpleNamespace(turn_on=execute))
    response = api.post(f"/actions/run/{ident}", json=body)
    assert response.status_code == 401 and "results" not in response.json()
    result = A._read_request_receipts()[-1]
    assert result["kind"] == "action_run" and not result["ok"] and len(calls) == 1
    assert result["results"][0]["ok"] and result["results"][1]["skipped"]


def test_target_change_after_first_step_does_not_retarget_remaining_steps(setup, monkeypatch):
    api, calls, devices = setup
    ident = saved(api)
    store = A._load_json(A._paths()[0], {"actions": [], "triggers": []})
    store["actions"][0]["steps"] *= 2
    A._save_json(A._paths()[0], store)
    body = review(api, ident)
    def execute(**kw):
        calls.append(kw); devices[0]["relay"] = 7
        return {"ok": True}
    monkeypatch.setitem(A._CTX, "shelly_driver", SimpleNamespace(turn_on=execute))
    result = api.post(f"/actions/run/{ident}", json=body).json()
    assert not result["ok"] and len(calls) == 1 and calls[0]["relay"] == 1
    assert result["results"][1]["skipped"] and "changed" in result["results"][1]["error"]


@pytest.mark.parametrize("kind", ["browser", "bearer", "local"])
def test_bound_authority_cannot_fall_back_after_revocation(kind, monkeypatch):
    from starlette.requests import Request
    import companion_auth as auth
    valid = [True]
    monkeypatch.setattr(auth.S, "validate_session_token", lambda value: valid[0] and value == "original")
    monkeypatch.setattr(auth.S, "get_session_user_id", lambda value: "owner")
    monkeypatch.setattr(auth.S, "load_pin_config", lambda: {"enabled": kind != "local" or not valid[0]})
    monkeypatch.setattr(auth, "credential_owner", lambda value: "owner" if valid[0] else "different")
    headers = [(b"cookie", b"tli_session=original")] if kind == "browser" else [(b"authorization", b"Bearer original")] if kind == "bearer" else []
    request = Request({"type": "http", "scheme": "https", "server": ("testserver", 443), "method": "POST", "path": "/actions/run/demo", "headers": headers})
    check = auth.operation_access(request, "local" if kind == "local" else "owner")
    check(); valid[0] = False
    with pytest.raises(HTTPException) as error:
        check()
    assert error.value.status_code == 401


def test_revoked_cookie_before_binding_cannot_become_private_pin_off_access(monkeypatch):
    from starlette.requests import Request
    import companion_auth as auth
    monkeypatch.setattr(auth.S, "validate_session_token", lambda value: False)
    monkeypatch.setattr(auth.S, "load_pin_config", lambda: {"enabled": False})
    request = Request({"type": "http", "scheme": "https", "server": ("testserver", 443), "method": "POST", "path": "/actions/run/demo", "headers": [(b"cookie", b"tli_session=revoked")]})
    with pytest.raises(HTTPException) as error:
        auth.operation_access(request, "private-owner")
    assert error.value.status_code == 401


def test_revocation_during_target_revalidation_prevents_driver_call(setup, monkeypatch):
    import companion_auth
    api, calls, _ = setup
    ident = saved(api)
    body = review(api, ident)
    allowed = [True]
    prepared_calls = [0]
    original = A._prepare_steps
    def bind(request, owner):
        def check():
            if not allowed[0]:
                raise HTTPException(401, "Session revoked")
        return check
    def prepare(steps, **kwargs):
        result = original(steps, **kwargs)
        prepared_calls[0] += 1
        if prepared_calls[0] == 2:
            allowed[0] = False
        return result
    monkeypatch.setattr("browser_authority.operation_access", bind)
    monkeypatch.setattr(A, "_prepare_steps", prepare)
    response = api.post(f"/actions/run/{ident}", json=body)
    assert response.status_code == 401 and "results" not in response.json()
    result = A._read_request_receipts()[-1]
    assert result["kind"] == "action_run" and not calls and not result["ok"]
    assert result["results"][0]["skipped"]
    assert "revoked" in result["results"][0]["error"]


def test_unreadable_receipts_block_reviewed_execution_and_report_failure(setup):
    api, calls, _ = setup
    ident = saved(api); body = review(api, ident)
    path = A._paths()[1]; path.write_bytes(b"{broken receipt")
    assert browser_receipts().status_code == 503
    assert api.post(f"/actions/run/{ident}", json=body).status_code == 503
    assert not calls and path.read_bytes() == b"{broken receipt"


def test_receipt_save_failure_does_not_lie_about_device_result(setup, monkeypatch):
    api, calls, _ = setup
    ident = saved(api); body = review(api, ident)
    original = A._append_receipt
    def append(row, **kwargs):
        if row["kind"] == "action_run":
            raise OSError("disk full")
        return original(row, **kwargs)
    monkeypatch.setattr(A, "_append_receipt", append)
    result = api.post(f"/actions/run/{ident}", json=body).json()
    assert result["ok"] and result["receipt_saved"] is False and len(calls) == 1
    assert api.post(f"/actions/run/{ident}", json=body).status_code == 409
    assert len(calls) == 1


def test_auth_and_legacy_reader_compatibility(setup):
    api, _, _ = setup
    ident = saved(api)
    original = A._paths()[0].read_bytes()
    assert A.actions_list(check=lambda: None)["actions"][0]["id"] == ident
    assert A._paths()[0].read_bytes() == original
    def denied():
        raise HTTPException(401, "Locked")
    api.app.dependency_overrides[require_session] = denied
    for url in ["/actions/list", "/actions/receipts", "/actions/capabilities", f"/actions/{ident}/review"]:
        response = (browser_receipts({"Authorization": "Bearer invalid"})
                    if url == "/actions/receipts" else api.get(url))
        assert response.status_code == 401
    assert api.post("/actions/preview", json=draft()).status_code == 401
