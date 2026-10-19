"""First-run progress remains durable across PIN creation and browser reloads."""
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import companion_auth
import security_state
import onboarding_store
import tli_state as S
from routers import system_routes as routes


@pytest.fixture
def onboarding(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "tli_pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(S, "log_debug", lambda *args, **kwargs: None)
    monkeypatch.setattr(routes, "_ONBOARDING_COMPLETE_FILE", tmp_path / "onboarding_complete.json")
    monkeypatch.setattr(routes, "_ONBOARDING_STARTED_FILE", tmp_path / "onboarding_started.json")
    monkeypatch.setattr(onboarding_store, "_SEEN", set())
    monkeypatch.setattr(onboarding_store, "_UNCERTAIN", set())
    app = FastAPI()
    app.middleware("http")(companion_auth.validate_authorization)
    app.include_router(routes.router)
    with TestClient(app, base_url="https://localhost", headers={"Origin": "https://localhost"}, client=("127.0.0.1", 50000)) as client:
        yield client


def status(client):
    response = client.get("/system/onboarding/status")
    assert response.status_code == 200
    return response.json()


def test_fresh_status_has_no_side_effects_and_start_is_idempotent(onboarding, tmp_path):
    assert status(onboarding) == {"complete": False, "started": False}
    assert list(tmp_path.iterdir()) == []
    result = onboarding.post("/system/onboarding/start")
    assert result.status_code == 200
    assert result.json() == {"ok": True, "complete": False, "started": True}
    original = routes._ONBOARDING_STARTED_FILE.read_bytes()
    assert json.loads(original)["started_at"]
    assert onboarding.post("/system/onboarding/start").json() == result.json()
    assert routes._ONBOARDING_STARTED_FILE.read_bytes() == original
    assert not routes._ONBOARDING_COMPLETE_FILE.exists()


def test_started_setup_survives_pin_creation_and_new_browser_until_completed(onboarding):
    assert onboarding.post("/system/onboarding/start").status_code == 200
    assert onboarding.post("/system/pin/set", json={"pin": "2468"}).status_code == 200
    assert status(onboarding) == {"complete": False, "started": True}
    # A fresh client has no frontend or authentication state. Progress is read
    # from the host's persisted marker, even though a PIN now exists.
    with TestClient(onboarding.app, base_url="https://localhost", headers={"Origin": "https://localhost"}, client=("127.0.0.1", 50001)) as reloaded:
        assert status(reloaded) == {"complete": False, "started": True}
        assert reloaded.post("/system/onboarding/complete").status_code == 401
        assert reloaded.post("/system/pin/verify", json={"pin": "2468"}).status_code == 200
        response = reloaded.post("/system/onboarding/complete")
        assert response.status_code == 200 and response.json() == {"ok": True}
        assert json.loads(routes._ONBOARDING_COMPLETE_FILE.read_text())["completed_at"]
    assert status(onboarding) == {"complete": True, "started": False}


def test_existing_pin_installation_stays_complete_without_read_mutations(onboarding, tmp_path):
    S.save_pin_config("a" * 64, "b" * 64)
    original = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    assert status(onboarding) == {"complete": True, "started": False}
    token = S.create_session_token("local")
    result = onboarding.post("/system/onboarding/start", headers={"Cookie": "tli_session=" + token})
    assert result.status_code == 200
    assert result.json() == {"ok": True, "complete": True, "started": False}
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == original


@pytest.mark.parametrize("marker", [{}, {"completed_at": "2025-01-01T00:00:00Z"}])
def test_completed_installation_is_never_reset_and_wins_over_started_marker(onboarding, marker):
    routes._ONBOARDING_COMPLETE_FILE.write_text(json.dumps(marker))
    routes._ONBOARDING_STARTED_FILE.write_text('{"started_at":"2025-01-01T00:00:00Z"}')
    original = routes._ONBOARDING_COMPLETE_FILE.read_bytes()
    assert status(onboarding) == {"complete": True, "started": False}
    result = onboarding.post("/system/onboarding/start")
    assert result.json() == {"ok": True, "complete": True, "started": False}
    assert onboarding.post("/system/onboarding/complete").json() == {"ok": True}
    assert routes._ONBOARDING_COMPLETE_FILE.read_bytes() == original


@pytest.mark.parametrize("endpoint", ["start", "complete"])
def test_mutations_require_session_when_pin_enabled(onboarding, endpoint):
    S.save_pin_config("a" * 64, "b" * 64)
    response = onboarding.post("/system/onboarding/" + endpoint)
    assert response.status_code == 401
    assert not routes._ONBOARDING_STARTED_FILE.exists()
    assert not routes._ONBOARDING_COMPLETE_FILE.exists()


@pytest.mark.parametrize("endpoint", ["start", "complete"])
def test_save_failure_is_visible_and_preserves_unfinished_progress(onboarding, monkeypatch, endpoint):
    if endpoint == "complete":
        assert onboarding.post("/system/onboarding/start").status_code == 200
    target = routes._ONBOARDING_STARTED_FILE if endpoint == "start" else routes._ONBOARDING_COMPLETE_FILE
    original = {path.name: path.read_bytes() for path in Path(S.DATA_DIR).iterdir()}
    # A definite pre-publication failure stays retryable. An exception from the
    # exclusive publication itself is deliberately uncertain (covered separately).
    monkeypatch.setattr(onboarding_store.os, "fsync", lambda _: (_ for _ in ()).throw(PermissionError("Synthetic read-only storage")))
    response = onboarding.post("/system/onboarding/" + endpoint)
    assert response.status_code == 503
    assert "preserved" in response.json()["detail"]
    assert {path.name: path.read_bytes() for path in Path(S.DATA_DIR).iterdir()} == original
    assert status(onboarding) == {"complete": False, "started": endpoint == "complete"}


@pytest.mark.parametrize("marker,contents", [
    ("complete", "{broken json"),
    ("complete", "[]"),
    ("complete", '{"completed_at":false}'),
    ("started", "{broken json"),
    ("started", "{}"),
    ("started", '{"started_at":false}'),
])
def test_unreadable_progress_is_preserved_and_never_treated_as_fresh(onboarding, marker, contents):
    path = routes._ONBOARDING_COMPLETE_FILE if marker == "complete" else routes._ONBOARDING_STARTED_FILE
    path.write_text(contents)
    assert onboarding.get("/system/onboarding/status").status_code == 503
    assert onboarding.post("/system/onboarding/start").status_code == 503
    assert onboarding.post("/system/onboarding/complete").status_code == 503
    assert path.read_text() == contents
    assert len(list(Path(S.DATA_DIR).iterdir())) == 1


def test_valid_session_does_not_bypass_unreadable_security(onboarding):
    token = S.create_session_token("local")
    S.PIN_CONFIG_FILE.write_text("{broken PIN data")
    headers = {"Cookie": "tli_session=" + token}
    assert onboarding.get("/system/onboarding/status").status_code == 503
    assert onboarding.post("/system/onboarding/start", headers=headers).status_code == 503
    assert onboarding.post("/system/onboarding/complete", headers=headers).status_code == 503
    assert not routes._ONBOARDING_STARTED_FILE.exists()
    assert not routes._ONBOARDING_COMPLETE_FILE.exists()
    assert S.PIN_CONFIG_FILE.read_text() == "{broken PIN data"
