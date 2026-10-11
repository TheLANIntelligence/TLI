"""Update preference reads and saves use synthetic persistence only."""
import json

import pytest

import auto_update


@pytest.mark.parametrize("automatic", [False, True])
def test_update_status_exposes_saved_automatic_check_without_changing_files(client, tmp_path, monkeypatch, automatic):
    saved = tmp_path / "update_settings.json"
    saved.write_text(json.dumps({"update_url": "https://updates.example/manifest.json", "auto_check": automatic}), encoding="utf-8")
    monkeypatch.setattr(auto_update, "_SETTINGS_FILE", saved)
    before = saved.read_bytes()

    result = client.get("/update/status")

    assert result.status_code == 200
    assert result.json()["auto_check"] is automatic
    assert result.json()["update_url"] == "https://updates.example/manifest.json"
    assert saved.read_bytes() == before


def test_saving_new_update_url_retains_explicit_disabled_automatic_checks(authed_client, tmp_path, monkeypatch):
    saved = tmp_path / "update_settings.json"
    saved.write_text('{"update_url":"https://old.example/manifest.json","auto_check":false}', encoding="utf-8")
    monkeypatch.setattr(auto_update, "_SETTINGS_FILE", saved)
    response = authed_client.post("/update/settings", json={"update_url": "https://new.example/manifest.json", "auto_check": False})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert json.loads(saved.read_text(encoding="utf-8")) == {"update_url": "https://new.example/manifest.json", "auto_check": False}
    assert authed_client.get("/update/status").json()["auto_check"] is False


def test_legacy_update_file_without_auto_check_retains_existing_default_without_rewriting(client, tmp_path, monkeypatch):
    saved = tmp_path / "update_settings.json"
    saved.write_text('{"update_url":"https://legacy.example/manifest.json"}', encoding="utf-8")
    monkeypatch.setattr(auto_update, "_SETTINGS_FILE", saved)
    before = saved.read_bytes()
    assert client.get("/update/status").json()["auto_check"] is True
    assert saved.read_bytes() == before
