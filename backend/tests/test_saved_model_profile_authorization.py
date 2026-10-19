"""Saved model/profile HTTP boundaries with real browser checks and temp state."""
import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import tli_state as S
from routers import system_routes as routes


CASES = [
    ("GET", "/system/profile", None),
    ("POST", "/system/profile", {"profile": "power"}),
    ("POST", "/models/set-default", {"model_id": "new-model", "label": "New model"}),
    ("GET", "/models/available", None),
]


@pytest.fixture
def settings(tmp_path, monkeypatch):
    model_path = tmp_path / "tli_model_config.json"
    profile_path = tmp_path / "tli_system_profile.json"
    model = {"default_key": "primary", "default_model_key": "primary",
             "models": {"primary": {"id": "old-model", "label": "Old model", "future": {"keep": 1}},
                        "secondary": {"id": "other-model", "label": "Other model", "future": {"keep": 2}}},
             "future": {"keep": [1, True, None]}}
    profile = {"profile": "balanced", "future": {"keep": [1, True, None]}}
    model_path.write_text(json.dumps(model), encoding="utf-8")
    profile_path.write_text(json.dumps(profile), encoding="utf-8")
    monkeypatch.setattr(S, "MODEL_CONFIG_FILE", model_path)
    monkeypatch.setattr(S, "SYSTEM_PROFILE_FILE", profile_path)
    monkeypatch.setattr(S, "MODEL_CONFIG", copy.deepcopy(model["models"]))
    monkeypatch.setattr(S, "DEFAULT_MODEL_KEY", "primary")
    monkeypatch.setattr(S, "CURRENT_SYSTEM_PROFILE", "balanced")
    cfg = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(cfg))
    monkeypatch.setattr(S, "_active_sessions", {})
    token = S.create_session_token("owner")
    log = Mock(); monkeypatch.setattr(S, "log_debug", log)
    provider = SimpleNamespace(models_url="https://provider.invalid/v1/models",
                               list_models=Mock(return_value=[{"id": "old-model", "label": "Old model"}]),
                               health_report=Mock(return_value={"ok": True, "chat_ok": True}))
    monkeypatch.setattr(S, "lm_provider", provider)
    api = FastAPI(); api.include_router(routes.router)
    clients = []

    def browser(mode="pin-local", *, app=api):
        local = mode not in {"pin-https", "pin-off-lan", "remote-http"}
        origin = "http://localhost:8000" if local else ("http" if mode == "remote-http" else "https") + "://192.0.2.5:8443"
        if mode in {"open-local", "pin-off-lan", "pin-off-stale"}:
            cfg["enabled"] = False
        client = TestClient(app, base_url=origin, client=("127.0.0.1" if local else "192.0.2.8", 1234),
                            headers={"Origin": origin}, raise_server_exceptions=False)
        if mode not in {"anonymous", "open-local", "pin-off-lan"}:
            client.headers["Cookie"] = "tli_session=" + token
        if mode in {"revoked", "pin-off-stale"}: S.revoke_session_token(token)
        if mode == "expired": S._active_sessions[token]["expiry"] = 0
        if mode == "cross-origin": client.headers["Origin"] = "https://foreign.invalid"
        if mode == "same-site": client.headers["Sec-Fetch-Site"] = "same-site"
        if mode == "missing-origin": del client.headers["Origin"]
        if mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
        if mode == "peer": client.headers["X-TLI-Peer-Id"] = "peer"
        if mode == "bearer": client.headers["Authorization"] = "Bearer synthetic-device"
        clients.append(client)
        return client

    yield SimpleNamespace(model_path=model_path, profile_path=profile_path, model=model, profile=profile,
                          cfg=cfg, token=token, provider=provider, log=log, browser=browser)
    for client in clients:
        client.close()


def send(client, case):
    method, path, body = case
    return client.request(method, path, **({"json": body} if body is not None else {}))


def unchanged(f, model_bytes, profile_bytes):
    assert f.model_path.read_bytes() == model_bytes
    assert f.profile_path.read_bytes() == profile_bytes
    assert S.DEFAULT_MODEL_KEY == "primary"
    assert S.MODEL_CONFIG == f.model["models"]
    assert S.CURRENT_SYSTEM_PROFILE == "balanced"


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("mode", ["anonymous", "revoked", "expired", "pin-off-stale", "pin-off-lan",
                                  "remote-http", "cross-origin", "same-site", "proxy", "peer", "bearer"])
def test_denied_settings_requests_never_read_store_or_provider(settings, monkeypatch, case, mode):
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    readers = []
    for name in ("read_model_settings", "read_profile_settings", "save_default_model", "save_profile"):
        reader = Mock(side_effect=AssertionError("Private state reached"))
        monkeypatch.setattr(S, name, reader)
        readers.append(reader)
    response = send(f.browser(mode), case)
    assert response.status_code == (401 if mode in {"anonymous", "revoked", "expired", "pin-off-stale"} else 403), response.text
    assert response.headers["cache-control"] == "no-store"
    for reader in readers: reader.assert_not_called()
    f.provider.list_models.assert_not_called(); f.provider.health_report.assert_not_called()
    unchanged(f, *before)


@pytest.mark.parametrize("case", [CASES[1], CASES[2]])
def test_saved_mutations_require_exact_origin(settings, case):
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    response = send(f.browser("missing-origin"), case)
    assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    unchanged(f, *before)


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("mode", ["pin-local", "pin-https", "open-local"])
def test_supported_browser_modes_preserve_saved_contracts(settings, case, mode):
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    response = send(f.browser(mode), case)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    data = response.json()
    if case == CASES[0]:
        assert data == {"current": "balanced", "profiles": S.SYSTEM_PROFILES,
                        "ui_defaults": S.SYSTEM_PROFILES["balanced"]["ui_defaults"],
                        "limits": S.SYSTEM_PROFILE_LIMITS["balanced"]}
        unchanged(f, *before)
    elif case == CASES[1]:
        assert data == {"ok": True, "current": "power"}
        assert json.loads(f.profile_path.read_bytes()) == {**f.profile, "profile": "power"}
        assert S.CURRENT_SYSTEM_PROFILE == "power"
        assert f.model_path.read_bytes() == before[0]
    elif case == CASES[2]:
        key = data["default_key"]
        assert data == {"ok": True, "default_key": key, "model": {"id": "new-model", "label": "New model"}}
        saved = json.loads(f.model_path.read_bytes())
        assert key not in f.model["models"] and saved["default_model_key"] == key
        assert saved["future"] == f.model["future"]
        for old_key, value in f.model["models"].items():
            assert saved["models"][old_key] == value
        assert S.DEFAULT_MODEL_KEY == key and S.MODEL_CONFIG[key]["id"] == "new-model"
        assert f.profile_path.read_bytes() == before[1]
    else:
        assert data["current"]["default_key"] == "primary"
        assert data["current"]["models"]["primary"]["id"] == "old-model"
        unchanged(f, *before)
    if case != CASES[3]:
        f.provider.list_models.assert_not_called(); f.provider.health_report.assert_not_called()


def test_existing_id_reuses_key_and_retains_other_records(settings):
    f = settings
    response = f.browser().post("/models/set-default", json={"model_id": "other-model", "label": "Updated label"})
    assert response.status_code == 200, response.text
    assert response.json()["default_key"] == "secondary"
    saved = json.loads(f.model_path.read_bytes())
    assert saved["models"]["primary"] == f.model["models"]["primary"]
    assert saved["models"]["secondary"] == {**f.model["models"]["secondary"], "label": "Updated label"}
    assert saved["future"] == f.model["future"]


@pytest.mark.parametrize("case,body", [(CASES[1], {}), (CASES[1], {"profile": 1}),
    (CASES[1], {"profile": "PRIVATE" * 20}), (CASES[2], {}), (CASES[2], {"model_id": 1}),
    (CASES[2], {"model_id": "PRIVATE" * 200}), (CASES[2], {"model_id": "valid", "label": "PRIVATE" * 200})])
def test_invalid_request_validation_never_echoes_settings(settings, case, body):
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    response = f.browser().post(case[1], json=body)
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": "Provide valid bounded model or profile settings."}
    assert response.headers["cache-control"] == "no-store"
    unchanged(f, *before)


@pytest.mark.parametrize("path,body,status", [("/system/profile", {"profile": "PRIVATE-invalid"}, 400),
    ("/models/set-default", {"model_id": "  "}, 400), ("/models/set-default", {"model_id": "model\nPRIVATE"}, 400),
    ("/models/set-default", {"model_id": "\ud800"}, 422)])
def test_invalid_semantic_setting_is_not_saved(settings, path, body, status):
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    # ASCII encoding represents an invalid Unicode scalar without HTTPX encoding it first.
    response = f.browser().post(path, content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store" and "PRIVATE" not in response.text
    unchanged(f, *before)


@pytest.mark.parametrize("case", CASES)
def test_damaged_saved_state_never_returns_globals_or_overwrites(settings, case):
    f = settings
    path = f.profile_path if case in CASES[:2] else f.model_path
    path.write_bytes(b'{"PRIVATE": damaged')
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    response = send(f.browser(), case)
    assert response.status_code == 503, response.text
    assert response.headers["cache-control"] == "no-store" and "PRIVATE" not in response.text
    unchanged(f, *before)
    f.provider.list_models.assert_not_called(); f.provider.health_report.assert_not_called()


@pytest.mark.parametrize("stage", ["models", "health"])
@pytest.mark.parametrize("outcome", ["revoke", "epoch", "read-error", "damage"])
def test_current_model_projection_rechecks_after_provider_work(settings, monkeypatch, stage, outcome):
    f = settings
    method = f.provider.list_models if stage == "models" else f.provider.health_report
    value = method.return_value
    client = f.browser("open-local" if outcome == "epoch" else "pin-local")
    def completed(*args, **kwargs):
        if outcome == "revoke": S.revoke_session_token(f.token)
        elif outcome == "epoch": S.revoke_all_sessions()
        elif outcome == "damage": f.model_path.write_bytes(b'{"PRIVATE": broken')
        else:
            S.revoke_session_token(f.token)
            raise RuntimeError("PRIVATE provider failure")
        return value
    method.side_effect = completed
    response = client.get("/models/available")
    assert response.status_code == (503 if outcome == "damage" else 401), response.text
    assert "PRIVATE" not in response.text
    if stage == "models" and outcome != "damage": f.provider.health_report.assert_not_called()
    assert S.DEFAULT_MODEL_KEY == "primary" and S.MODEL_CONFIG == f.model["models"]


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("service_error", [False, True])
def test_route_final_check_withholds_settings_after_service_revocation(settings, monkeypatch, case, service_error):
    f = settings
    service_name = ("read_profile_settings" if case == CASES[0] else "save_profile" if case == CASES[1] else
                    "save_default_model" if case == CASES[2] else "read_model_settings")
    def denied(*args, **kwargs):
        S.revoke_session_token(f.token)
        if service_error: raise RuntimeError("PRIVATE settings failure")
        return {"PRIVATE": "completed setting"}
    monkeypatch.setattr(S, service_name, denied)
    response = send(f.browser(), case)
    assert response.status_code == 401, response.text
    assert response.headers["cache-control"] == "no-store" and "PRIVATE" not in response.text


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("mode", ["anonymous", "pin-off-lan", "bearer", "pin-https"])
def test_actual_main_route_registration_preserves_guard(settings, monkeypatch, app, case, mode):
    import companion_auth
    f = settings
    if mode == "bearer":
        # A valid native credential passes shared middleware but grants none of these browser controls.
        monkeypatch.setattr(companion_auth, "credential_owner", lambda _: "owner")
    response = send(f.browser(mode, app=app), case)
    assert response.status_code == (401 if mode == "anonymous" else 403 if mode in {"pin-off-lan", "bearer"} else 200), response.text
    assert response.headers["cache-control"] == "no-store"


def test_actual_main_invalid_bearer_cannot_fall_back_to_browser_cookie(settings, monkeypatch, app):
    import companion_auth
    def invalid(_): raise HTTPException(401, "Invalid companion credential")
    monkeypatch.setattr(companion_auth, "credential_owner", invalid)
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    response = f.browser("bearer", app=app).post("/models/set-default", json=CASES[2][2])
    assert response.status_code == 401
    unchanged(f, *before)


@pytest.mark.parametrize("case", [CASES[1], CASES[2]])
@pytest.mark.parametrize("loss", ["revoke", "epoch", "unavailable"])
def test_revocation_during_staging_prevents_saved_change(settings, monkeypatch, case, loss):
    import selection_settings as store
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    client = f.browser("open-local" if loss == "epoch" else "pin-local")
    original_fsync = store.os.fsync
    def staged(fd):
        original_fsync(fd)
        if loss == "epoch": S.revoke_all_sessions()
        elif loss == "unavailable":
            monkeypatch.setattr(S, "load_pin_config", Mock(side_effect=HTTPException(503, "Security unavailable")))
        else: S.revoke_session_token(f.token)
    monkeypatch.setattr(store.os, "fsync", staged)
    response = send(client, case)
    assert response.status_code == (503 if loss == "unavailable" else 401), response.text
    assert response.headers["cache-control"] == "no-store"
    unchanged(f, *before)
    assert list(f.model_path.parent.glob(".tli-selection-*")) == []


@pytest.mark.parametrize("case", [CASES[1], CASES[2]])
def test_confirmed_replace_publishes_choice_before_late_denial(settings, monkeypatch, case):
    import selection_settings as store
    f = settings
    original_replace = store.os.replace
    replacements = []
    def replaced(source, destination):
        original_replace(source, destination)
        replacements.append(destination)
        S.revoke_session_token(f.token)
    monkeypatch.setattr(store.os, "replace", replaced)
    response = send(f.browser(), case)
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    assert len(replacements) == 1
    if case == CASES[1]:
        assert S.CURRENT_SYSTEM_PROFILE == "power"
        assert json.loads(f.profile_path.read_bytes())["profile"] == "power"
    else:
        saved = json.loads(f.model_path.read_bytes())
        assert S.DEFAULT_MODEL_KEY == saved["default_key"]
        assert S.MODEL_CONFIG[S.DEFAULT_MODEL_KEY]["id"] == "new-model"
        assert saved["models"]["primary"] == f.model["models"]["primary"]
    assert list(f.model_path.parent.glob(".tli-selection-*")) == []


@pytest.mark.parametrize("case", [CASES[1], CASES[2]])
def test_uncertain_replace_is_not_success_or_permission_to_retry(settings, monkeypatch, case):
    import selection_settings as store
    f = settings
    original_replace = store.os.replace
    replacements = []
    def uncertain(source, destination):
        original_replace(source, destination)
        replacements.append(destination)
        raise OSError("PRIVATE uncertain replacement")
    monkeypatch.setattr(store.os, "replace", uncertain)
    client = f.browser()
    response = send(client, case)
    assert response.status_code == 503 and "PRIVATE" not in response.text
    assert S.CURRENT_SYSTEM_PROFILE == "balanced"
    assert S.DEFAULT_MODEL_KEY == "primary" and S.MODEL_CONFIG == f.model["models"]
    retained = f.model_path.read_bytes(), f.profile_path.read_bytes()
    read = client.get("/system/profile" if case == CASES[1] else "/models/available")
    assert read.status_code == 503
    retry = send(client, case)
    assert retry.status_code == 503
    assert (f.model_path.read_bytes(), f.profile_path.read_bytes()) == retained
    assert len(replacements) == 1
    f.provider.list_models.assert_not_called(); f.provider.health_report.assert_not_called()


@pytest.mark.parametrize("case", [CASES[1], CASES[2]])
def test_failed_replace_never_reports_success_or_prepublishes_runtime(settings, monkeypatch, case):
    import selection_settings as store
    f = settings
    before = f.model_path.read_bytes(), f.profile_path.read_bytes()
    monkeypatch.setattr(store.os, "replace", Mock(side_effect=PermissionError("PRIVATE write failure")))
    response = send(f.browser(), case)
    assert response.status_code == 503 and "PRIVATE" not in response.text
    unchanged(f, *before)
    assert list(f.model_path.parent.glob(".tli-selection-*")) == []
