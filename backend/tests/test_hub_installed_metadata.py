"""Installed source cards use bounded metadata reads, never an empty fallback."""
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import script_sources
import tli_state as S
from routers import hub_routes as hub


@pytest.fixture
def installed_api(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(hub, "_load_installed", lambda: pytest.fail("Strict installed read must not use legacy fallback"))
    path = tmp_path / "hub_installed.json"
    path.write_text(json.dumps([
        {"id": "saved-script", "name": "Saved script", "type": "script", "version": "old", "unknown": {"preserve": [1, 2]}},
        {"id": "saved-theme", "name": "Saved theme", "type": "theme", "custom": "keep"},
    ]), encoding="utf-8")
    app = FastAPI()
    app.include_router(hub.router)
    with TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 12345)) as client:
        yield client, path


def test_installed_read_preserves_all_metadata_fields_and_bytes(installed_api):
    client, path = installed_api
    before = path.read_bytes()
    response = client.get("/hub/installed")
    assert response.status_code == 200
    assert response.json() == {"installed": json.loads(before)}
    assert response.headers["cache-control"] == "no-store"
    assert path.read_bytes() == before
    assert list(path.parent.iterdir()) == [path]


@pytest.mark.parametrize("raw", [
    b"{damaged retained registry", b"null", b"{}", b'[null]',
    b'[{"id":"saved","name":"Saved","type":"script","type":"theme"}]',
    b'[{"id":"saved","name":"Saved","type":"script","custom":NaN}]',
    b'[{"id":"saved","type":"script"}]',
    b'[{"id":"same","name":"One","type":"script"},{"id":"same","name":"Two","type":"script"}]',
    b' ' * (script_sources.INDEX_LIMIT + 1),
], ids=["broken", "null", "wrong-shape", "invalid-row", "duplicate-key", "nonfinite", "missing-name", "duplicate-id", "oversized"])
def test_damaged_installed_read_is_unavailable_and_preserves_original(installed_api, raw):
    client, path = installed_api
    path.write_bytes(raw)
    response = client.get("/hub/installed")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "installed" not in response.json()
    assert path.read_bytes() == raw
    assert list(path.parent.iterdir()) == [path]


def test_unreadable_installed_file_is_unavailable_without_replacement(installed_api, monkeypatch):
    client, path = installed_api
    before = path.read_bytes()
    open_file = script_sources.os.open

    def denied(current, *args, **kwargs):
        if Path(current) == path:
            raise PermissionError("PRIVATE filesystem detail")
        return open_file(current, *args, **kwargs)

    monkeypatch.setattr(script_sources.os, "open", denied)
    response = client.get("/hub/installed")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text
    assert path.read_bytes() == before
    assert list(path.parent.iterdir()) == [path]


def test_missing_installed_registry_remains_absent(installed_api):
    client, path = installed_api
    path.unlink()
    response = client.get("/hub/installed")
    assert response.status_code == 200
    assert response.json() == {"installed": []}
    assert not list(path.parent.iterdir())


def test_denied_installed_read_never_opens_metadata(installed_api, monkeypatch):
    client, path = installed_api
    before = path.read_bytes()
    monkeypatch.setattr(hub, "list_hub_metadata", lambda *_: pytest.fail("Denied read inspected private metadata"))
    response = client.get("/hub/installed", headers={"Authorization": "Bearer unsupported-device"})
    assert response.status_code == 403
    assert "Saved script" not in response.text
    assert path.read_bytes() == before


@pytest.mark.parametrize("fail_read", [False, True])
def test_installed_read_rechecks_original_session_after_read_or_error(installed_api, monkeypatch, fail_read):
    client, path = installed_api
    before = path.read_bytes()
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    token = S.create_session_token("local")
    client.cookies.set("tli_session", token)
    original = script_sources.os.open

    def revoke(current, *args, **kwargs):
        if Path(current) == path:
            S.revoke_session_token(token)
            if fail_read:
                raise PermissionError("PRIVATE read failure")
        return original(current, *args, **kwargs)

    monkeypatch.setattr(script_sources.os, "open", revoke)
    response = client.get("/hub/installed")
    assert response.status_code == 401
    assert "Saved script" not in response.text and "PRIVATE" not in response.text
    assert path.read_bytes() == before
