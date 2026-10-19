"""Hub host authority through the real router, browser sessions and middleware."""
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import companion_auth
import tli_state as S
from routers import hub_routes as hub


PRIVATE_REQUESTS = [
    ("GET", "/hub/status", None),
    ("GET", "/hub/registry", None),
    ("GET", "/hub/sample", None),
    ("GET", "/hub/installed", None),
    ("GET", "/hub/apps", None),
    ("GET", "/hub/themes", None),
    ("GET", "/hub/presets", None),
    ("POST", "/hub/settings", {"enabled": True}),
    ("POST", "/hub/install", {"package_id": "fixture", "use_sample": True}),
    ("DELETE", "/hub/packages/fixture", None),
    ("POST", "/hub/packages/fixture/run", None),
    ("POST", "/hub/publish", {"id": "fixture", "name": "Fixture", "type": "script"}),
    ("DELETE", "/hub/local-registry/fixture", None),
]


@pytest.fixture
def isolated_hub(app, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": False}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    monkeypatch.setattr(S, "log_debug", Mock())
    runner = Mock(side_effect=AssertionError("No real Hub process may run in these tests"))
    network = Mock(side_effect=AssertionError("No live registry request may run in these tests"))
    monkeypatch.setattr(subprocess, "run", runner)
    monkeypatch.setattr(hub, "_fetch_registry", network)
    package_dir = tmp_path / "hub_packages"
    package_dir.mkdir()
    script = package_dir / "script_fixture.json"
    script.write_text(json.dumps({"shell": "powershell", "code": "fixture script source"}), encoding="utf-8")
    installed = tmp_path / "hub_installed.json"
    installed.write_text(json.dumps([
        {"id": "fixture", "name": "Private installed name", "type": "script", "custom": "preserve"},
    ], indent=3), encoding="utf-8")
    clients = []

    def browser(*, pin_enabled=False, remote=False, authenticated=False):
        pin["enabled"] = pin_enabled
        origin = "https://192.0.2.10:8443" if remote else "http://localhost:8000"
        client = TestClient(app, base_url=origin,
                            client=("192.0.2.20" if remote else "127.0.0.1", 12345),
                            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})
        token = S.create_session_token("local") if authenticated else None
        if token:
            client.headers["Cookie"] = "tli_session=" + token
        clients.append(client)
        return client, token

    yield SimpleNamespace(browser=browser, pin=pin, runner=runner, network=network,
                          script=script, installed=installed, root=tmp_path)
    for client in clients:
        client.close()


@pytest.mark.parametrize("method,path,body", PRIVATE_REQUESTS,
                         ids=[method + " " + path for method, path, _ in PRIVATE_REQUESTS])
@pytest.mark.parametrize("mode", ["pin-anonymous", "pin-off-lan"])
def test_private_routes_deny_before_hub_state_or_effects(isolated_hub, monkeypatch, mode, method, path, body):
    env = isolated_hub
    client, _ = env.browser(pin_enabled=mode == "pin-anonymous", remote=mode == "pin-off-lan")
    reads = []
    for name in ("_load_settings", "_load_installed", "_load_local_registry", "_pkg_dir"):
        read = Mock(side_effect=AssertionError("Denied Hub request must not inspect private state"))
        monkeypatch.setattr(hub, name, read)
        reads.append(read)

    response = client.request(method, path, **({"json": body} if body is not None else {}))

    assert response.status_code == (401 if mode == "pin-anonymous" else 403), response.text
    for read in reads:
        read.assert_not_called()
    env.runner.assert_not_called()
    env.network.assert_not_called()


@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https-lan"])
def test_retired_browser_run_preserves_installed_files_without_process(isolated_hub, monkeypatch, mode):
    env = isolated_hub
    client, _ = env.browser(pin_enabled=mode != "open-local", remote=mode == "pin-https-lan",
                            authenticated=mode != "open-local")
    before = {path: path.read_bytes() for path in (env.script, env.installed)}
    installed = Mock(side_effect=AssertionError("Retired execution cannot inspect saved packages"))
    monkeypatch.setattr(hub, "_load_installed", installed)

    # The existing UI sends this bodyless POST with the browser's Origin header.
    response = client.post("/hub/packages/fixture/run")

    assert response.status_code == 410, response.text
    assert "preserved" in response.json()["detail"]
    assert response.headers["cache-control"] == "no-store"
    env.runner.assert_not_called()
    installed.assert_not_called()
    assert all(path.read_bytes() == content for path, content in before.items())
    env.network.assert_not_called()


@pytest.mark.parametrize("attempt", ["companion-with-cookie", "peer-with-cookie", "cross-origin", "proxy", "stale-cookie"])
def test_nonbrowser_or_invalid_authority_never_enters_script_handler(isolated_hub, monkeypatch, attempt):
    env = isolated_hub
    client, token = env.browser(pin_enabled=attempt != "stale-cookie", remote=attempt == "companion-with-cookie",
                                authenticated=True)
    headers = {}
    if attempt == "companion-with-cookie":
        origin = str(client.base_url).rstrip("/")
        invitation, _ = companion_auth.create_pairing("local", origin, "f" * 64)
        device = companion_auth.redeem_pairing(invitation, origin, "f" * 64, "Fixture phone", "test")
        assert companion_auth.credential_owner(device["credential"]) == "local"
        headers["Authorization"] = "Bearer " + device["credential"]
    elif attempt == "peer-with-cookie":
        headers["X-TLI-Peer-Signature"] = "fixture-peer-signature"
    elif attempt == "cross-origin":
        headers["Origin"] = "https://unrelated.example.test"
    elif attempt == "proxy":
        headers["X-Forwarded-For"] = "127.0.0.1"
    else:
        S.revoke_session_token(token)
    installed = Mock(side_effect=AssertionError("Invalid authority must not reach installed metadata"))
    monkeypatch.setattr(hub, "_load_installed", installed)

    response = client.post("/hub/packages/fixture/run", headers=headers)

    assert response.status_code == (401 if attempt == "stale-cookie" else 403), response.text
    installed.assert_not_called()
    env.runner.assert_not_called()


@pytest.mark.parametrize("damage", ["corrupt-index", "missing-index", "corrupt-source", "missing-source", "unknown-shell"])
def test_retired_run_never_reads_or_changes_damaged_artifacts(isolated_hub, monkeypatch, damage):
    env = isolated_hub
    client, _ = env.browser(pin_enabled=True, authenticated=True)
    if damage == "corrupt-index":
        env.installed.write_bytes(b"{recoverable truncated index")
    elif damage == "missing-index":
        env.installed.unlink()
    elif damage == "corrupt-source":
        env.script.write_bytes(b"{recoverable truncated source")
    elif damage == "missing-source":
        env.script.unlink()
    else:
        env.script.write_text(json.dumps({"shell": "unknown", "code": "preserved source"}), encoding="utf-8")
    before = {p: p.read_bytes() for p in env.root.rglob("*") if p.is_file()}
    reads = Mock(side_effect=AssertionError("Retired execution must not read or create package paths"))
    monkeypatch.setattr(hub, "_load_installed", reads)
    monkeypatch.setattr(hub, "_pkg_dir", reads)
    result = client.post("/hub/packages/fixture/run")
    assert result.status_code == 410, result.text
    assert "preserved" in result.json()["detail"]
    reads.assert_not_called()
    env.runner.assert_not_called()
    assert {p: p.read_bytes() for p in env.root.rglob("*") if p.is_file()} == before


def test_retired_run_rechecks_captured_authority_before_returning():
    from fastapi import HTTPException
    check = Mock(side_effect=HTTPException(401, "Session revoked"))
    with pytest.raises(HTTPException) as error:
        hub.hub_run_script("fixture", check=check)
    assert error.value.status_code == 401
    check.assert_called_once_with()


def test_publish_and_unpublish_keep_installed_data_and_share_only_published_content(isolated_hub, monkeypatch):
    env = isolated_hub
    client, _ = env.browser(pin_enabled=True, authenticated=True)
    before = {path: path.read_bytes() for path in (env.script, env.installed)}
    published = {"id": "fixture", "type": "script", "name": "Public package name",
                 "shell": "powershell", "code": "intentionally published source"}

    response = client.post("/hub/publish", json=published)
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True

    # Public registry fetching is intentional and must not inspect installation state.
    installed = Mock(side_effect=AssertionError("Published registry must not disclose installed metadata"))
    monkeypatch.setattr(hub, "_load_installed", installed)
    public, _ = env.browser(pin_enabled=True, remote=True)
    result = public.get("/hub/local-registry")
    assert result.status_code == 200, result.text
    assert result.json()["packages"][0]["code"] == published["code"]
    assert result.json()["packages"][0]["name"] == published["name"]
    assert "installed" not in result.json()["packages"][0]
    assert "Private installed name" not in result.text
    installed.assert_not_called()

    response = client.delete("/hub/local-registry/fixture")
    assert response.status_code == 200, response.text
    assert public.get("/hub/local-registry").json()["packages"] == []
    assert all(path.read_bytes() == content for path, content in before.items())
    env.runner.assert_not_called()
    env.network.assert_not_called()
