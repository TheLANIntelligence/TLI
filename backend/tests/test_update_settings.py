"""Update preference reads and saves use synthetic persistence only."""
import json

import pytest

import auto_update
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import update_routes


@pytest.fixture
def settings_client(monkeypatch):
    app = FastAPI(); app.include_router(update_routes.router)
    monkeypatch.setattr(auto_update.S, 'load_pin_config', lambda: {'enabled': False})
    monkeypatch.setattr(auto_update.S, 'SERVER_BIND_PORT', 8000)
    monkeypatch.setattr(auto_update.S, 'TLS_ENABLED', False)
    with TestClient(app, base_url='http://localhost:8000', client=('127.0.0.1', 50001),
                    headers={'Origin': 'http://localhost:8000'}) as client:
        yield client


@pytest.mark.parametrize("automatic", [False, True])
def test_update_status_exposes_saved_automatic_check_without_changing_files(settings_client, tmp_path, monkeypatch, automatic):
    saved = tmp_path / "update_settings.json"
    saved.write_text(json.dumps({"update_url": "https://updates.example/manifest.json", "auto_check": automatic}), encoding="utf-8")
    monkeypatch.setattr(auto_update, "_SETTINGS_FILE", saved)
    before = saved.read_bytes()

    result = settings_client.get("/update/status")

    assert result.status_code == 200
    assert result.json()["auto_check"] is automatic
    assert result.json()["update_url"] == "https://updates.example/manifest.json"
    assert saved.read_bytes() == before


def test_saving_new_update_url_retains_explicit_disabled_automatic_checks(settings_client, tmp_path, monkeypatch):
    saved = tmp_path / "update_settings.json"
    saved.write_text('{"update_url":"https://old.example/manifest.json","auto_check":false}', encoding="utf-8")
    monkeypatch.setattr(auto_update, "_SETTINGS_FILE", saved)
    response = settings_client.post("/update/settings", json={"update_url": "https://new.example/manifest.json", "auto_check": False})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert json.loads(saved.read_text(encoding="utf-8")) == {"update_url": "https://new.example/manifest.json", "auto_check": False}
    assert settings_client.get("/update/status").json()["auto_check"] is False


def test_legacy_update_file_without_auto_check_retains_existing_default_without_rewriting(settings_client, tmp_path, monkeypatch):
    saved = tmp_path / "update_settings.json"
    saved.write_text('{"update_url":"https://legacy.example/manifest.json"}', encoding="utf-8")
    monkeypatch.setattr(auto_update, "_SETTINGS_FILE", saved)
    before = saved.read_bytes()
    assert settings_client.get("/update/status").json()["auto_check"] is True
    assert saved.read_bytes() == before
