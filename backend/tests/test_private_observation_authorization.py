"""Private directory/log reads and legacy printer aliases use real browser authority."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import tli_state as S
from intelligence import devices
from routers import file_routes as files, printers


@pytest.fixture
def private_host(app, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "log_debug", Mock())
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: pin.copy())
    folder = tmp_path / "private-folder"
    folder.mkdir()
    (folder / "private-note.txt").write_text("fixture", encoding="utf-8")
    (folder / "photo.jpg").write_bytes(b"fixture")
    (folder / "child").mkdir()
    log = tmp_path / "fixture-debug.jsonl"
    log.write_text(json.dumps({"subsystem": "fixture", "level": "INFO", "message": "private log"}) + "\n", encoding="utf-8")
    monkeypatch.setattr(S, "DEBUG_LOG_PATH", log)
    provider = Mock()
    provider.health_check.return_value = False
    provider.complete.side_effect = AssertionError("No live model calls")
    monkeypatch.setattr(S, "lm_provider", provider)
    hardware = Mock(side_effect=AssertionError("No real printer calls"))
    monkeypatch.setattr(printers, "get_printers", hardware)
    clients = []

    def browser(*, enabled=True, authenticated=True, remote=False):
        pin["enabled"] = enabled
        origin = "https://tli.example.test:8443" if remote else "http://localhost:8000"
        client = TestClient(app, base_url=origin, client=("192.0.2.4" if remote else "127.0.0.1", 10000),
                            headers={"Origin": origin})
        token = S.create_session_token("local") if authenticated else None
        if token:
            client.cookies.set("tli_session", token)
        clients.append(client)
        return client, token

    yield SimpleNamespace(folder=folder, log=log, pin=pin, provider=provider, hardware=hardware, browser=browser)
    for client in clients:
        client.close()


READS = [
    ("POST", "/file/scan"), ("POST", "/files/scan"),
    ("POST", "/files/apply_rules"), ("POST", "/files/insight"),
    ("GET", "/debug/logs"), ("GET", "/printers"), ("GET", "/devices/printers"),
    ("POST", "/api/intelligence/printers/refresh"),
]


def payload(route, folder):
    if route == "/file/scan":
        return {"path": str(folder)}
    if route.startswith("/files/"):
        return {"root": str(folder), "rules": "Group by type"}
    return None


@pytest.mark.parametrize("method,route", READS)
@pytest.mark.parametrize("mode", ["pin-anonymous", "open-lan"])
def test_private_routes_reject_before_any_read(private_host, monkeypatch, method, route, mode):
    env = private_host
    client, _ = env.browser(enabled=mode == "pin-anonymous", authenticated=False, remote=mode == "open-lan")
    expansion = Mock(side_effect=AssertionError("Denied callers cannot inspect paths"))
    monkeypatch.setattr(files, "expand_base_path", expansion)
    log = Mock()
    log.exists.side_effect = AssertionError("Denied callers cannot inspect logs")
    monkeypatch.setattr(S, "DEBUG_LOG_PATH", log)
    response = client.request(method, route, json=payload(route, env.folder))
    assert response.status_code == (401 if mode == "pin-anonymous" else 403), response.text
    expansion.assert_not_called()
    log.exists.assert_not_called()
    env.hardware.assert_not_called()
    env.provider.health_check.assert_not_called()
    env.provider.complete.assert_not_called()


@pytest.mark.parametrize("route", ["/file/scan", "/files/scan", "/files/apply_rules", "/files/insight", "/debug/logs"])
@pytest.mark.parametrize("mode", ["open-local", "pin-https"])
def test_allowed_reads_preserve_data_and_result_contracts(private_host, route, mode):
    env = private_host
    client, _ = env.browser(enabled=mode != "open-local", authenticated=mode != "open-local", remote=mode == "pin-https")
    before = {p: p.read_bytes() for p in [env.folder / "private-note.txt", env.folder / "photo.jpg", env.log]}
    response = client.request("GET" if route == "/debug/logs" else "POST", route, json=payload(route, env.folder))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    data = response.json()
    if route == "/file/scan":
        assert data["total_files"] == 2
        assert data["buckets"] == {"Documents": ["private-note.txt"], "Images": ["photo.jpg"]}
    elif route == "/files/scan":
        assert {row["extension"] for row in data["extension_summary"]} == {".txt", ".jpg"}
    elif route == "/files/apply_rules":
        assert data["plan"] == {"Documents": ["private-note.txt"], "Images": ["photo.jpg"]}
        assert data["ai"] is False
        assert "No files were moved." in data["summary"]
    elif route == "/files/insight":
        assert "2 files" in data["summary"] and "1 subfolders" in data["summary"]
        assert data["ai"] is False
    else:
        assert data == [{"subsystem": "fixture", "level": "INFO", "message": "private log"}]
    assert all(p.read_bytes() == content for p, content in before.items())
    env.provider.complete.assert_not_called()


@pytest.mark.parametrize("route", ["/file/scan", "/files/scan", "/files/apply_rules", "/files/insight"])
def test_revocation_during_directory_enumeration_withholds_metadata(private_host, monkeypatch, route):
    env = private_host
    client, token = env.browser()
    original = Path.iterdir

    def enumerating(path):
        for entry in original(path):
            if path == env.folder:
                S._active_sessions.pop(token, None)
            yield entry

    monkeypatch.setattr(Path, "iterdir", enumerating)
    response = client.post(route, json=payload(route, env.folder))
    assert response.status_code == 401
    assert "private-note" not in response.text
    env.provider.health_check.assert_not_called()
    env.provider.complete.assert_not_called()


@pytest.mark.parametrize("route", ["/files/apply_rules", "/files/insight"])
@pytest.mark.parametrize("stage", ["health", "inference", "inference-error"])
def test_revocation_cannot_leak_model_output_or_fallback(private_host, route, stage):
    env = private_host
    client, token = env.browser()

    def revoke_health():
        S._active_sessions.pop(token, None)
        return True

    def revoke_inference(**kwargs):
        S._active_sessions.pop(token, None)
        if stage == "inference-error":
            raise RuntimeError("fixture model failed after revoke")
        return {"text": '{"Documents":["private-note.txt"]}'}

    env.provider.health_check.side_effect = revoke_health if stage == "health" else None
    env.provider.health_check.return_value = True
    env.provider.complete.side_effect = revoke_inference
    response = client.post(route, json=payload(route, env.folder))
    assert response.status_code == 401, response.text
    assert "private-note" not in response.text and "plan" not in response.json()
    if stage == "health":
        env.provider.complete.assert_not_called()
    else:
        env.provider.complete.assert_called_once()


@pytest.mark.parametrize("failure", [False, True])
def test_log_revocation_after_read_never_discloses_contents(private_host, monkeypatch, failure):
    env = private_host
    client, token = env.browser()
    log = Mock()
    log.exists.return_value = True

    def read(**kwargs):
        S._active_sessions.pop(token, None)
        if failure:
            raise OSError("private log path from failed reader")
        return '{"message":"private log"}\n'

    log.read_text.side_effect = read
    monkeypatch.setattr(S, "DEBUG_LOG_PATH", log)
    response = client.get("/debug/logs")
    assert response.status_code == 401
    assert "private log" not in response.text


@pytest.mark.parametrize("route", ["/file/scan", "/files/scan", "/files/apply_rules", "/files/insight"])
def test_revocation_during_missing_path_probe_withholds_error_metadata(private_host, monkeypatch, route):
    env = private_host
    client, token = env.browser()
    original = Path.exists

    def exists(path):
        if path == env.folder:
            S._active_sessions.pop(token, None)
            return False
        return original(path)

    monkeypatch.setattr(Path, "exists", exists)
    response = client.post(route, json=payload(route, env.folder))
    assert response.status_code == 401
    assert str(env.folder) not in response.text


@pytest.mark.parametrize("route", ["/printers", "/devices/printers"])
def test_legacy_alias_preserves_inventory_only_for_live_browser(private_host, route):
    env = private_host
    client, token = env.browser()
    env.hardware.side_effect = lambda **kwargs: (kwargs["check"](), [{"name": "Fixture"}])[1]
    assert client.get(route).json() == [{"name": "Fixture"}]

    def revoke(**kwargs):
        S._active_sessions.pop(token, None)
        return [{"name": "Private printer"}]

    env.hardware.side_effect = revoke
    response = client.get(route)
    assert response.status_code == 401
    assert "Private printer" not in response.text


def test_refresh_revocation_retains_previous_cache(private_host, monkeypatch):
    env = private_host
    client, token = env.browser()
    cache = devices.root() / "printer_cache.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text('{"printers":[{"name":"Original"}]}', encoding="utf-8")
    before = cache.read_bytes()

    def revoke(**kwargs):
        S._active_sessions.pop(token, None)
        return [{"name": "Replacement"}]

    env.hardware.side_effect = revoke
    response = client.post("/api/intelligence/printers/refresh")
    assert response.status_code == 401
    assert cache.read_bytes() == before
