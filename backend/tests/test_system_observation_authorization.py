"""Three private System readers: real browser checks, disposable state only."""
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import shelly_store
import tli_state as S
from routers import system_routes as routes


PATHS = ["/system/capabilities", "/api/diagnostics/whoami", "/debug/selftest"]


@pytest.fixture
def private_system(tmp_path, monkeypatch):
    cfg = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(cfg))
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "SHELLY_REGISTRY_PATH", tmp_path / "shelly.json")
    monkeypatch.setattr(shelly_store, "_SEEN", set())
    token = S.create_session_token("owner")
    provider = SimpleNamespace(status_code=200, close=Mock())
    outbound = Mock(return_value=provider)
    session = MagicMock()
    session.__enter__.return_value = session
    session.__exit__.return_value = False
    session.get = outbound
    session_factory = Mock(return_value=session)
    vault = Mock(return_value=True)
    cwd = Mock(return_value="PRIVATE-CWD")
    monkeypatch.setattr(routes.requests, "Session", session_factory)
    monkeypatch.setattr(routes, "vault_is_initialized", vault)
    monkeypatch.setattr(routes, "os", SimpleNamespace(getcwd=cwd))
    app = FastAPI()
    app.include_router(routes.router)
    clients = []

    def client(*, base="https://host.test", peer="192.0.2.20", cookie=True, headers=None, target=app):
        value = TestClient(target, base_url=base, client=(peer, 1234),
                           headers={"Origin": base, **(headers or {})},
                           cookies={"tli_session": token} if cookie else {},
                           raise_server_exceptions=False)
        clients.append(value)
        return value

    yield SimpleNamespace(cfg=cfg, token=token, client=client, outbound=outbound,
                          provider=provider, vault=vault, cwd=cwd, path=S.SHELLY_REGISTRY_PATH,
                          session=session, session_factory=session_factory)
    for value in clients:
        value.close()


DENIED = [
    ("anonymous", 401), ("revoked", 401), ("expired", 401),
    ("foreign-origin", 403), ("foreign-fetch", 403), ("remote-http", 403),
    ("pin-off-remote", 403), ("pin-off-stale", 401),
    ("bearer", 403), ("peer", 403), ("proxy", 403), ("unavailable-pin", 503),
]


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode,status", DENIED)
def test_private_system_denied_before_any_observation(private_system, monkeypatch, path, mode, status):
    f = private_system
    options = {}
    if mode == "anonymous":
        options["cookie"] = False
    elif mode in {"revoked", "pin-off-stale"}:
        S.revoke_session_token(f.token)
        if mode == "pin-off-stale":
            f.cfg["enabled"] = False
            options.update(base="http://localhost", peer="127.0.0.1")
    elif mode == "expired":
        S._active_sessions[f.token]["expiry"] = 0
    elif mode == "foreign-origin":
        options["headers"] = {"Origin": "https://unrelated.invalid"}
    elif mode == "foreign-fetch":
        options["headers"] = {"Sec-Fetch-Site": "cross-site"}
    elif mode == "remote-http":
        options["base"] = "http://host.test"
    elif mode == "pin-off-remote":
        f.cfg["enabled"] = False
        options["cookie"] = False
    elif mode == "bearer":
        options["headers"] = {"Authorization": "Bearer synthetic-companion"}
    elif mode == "peer":
        options["headers"] = {"X-TLI-Peer-Id": "synthetic-peer"}
    elif mode == "proxy":
        options["headers"] = {"X-Forwarded-For": "127.0.0.1"}
    elif mode == "unavailable-pin":
        def unavailable():
            raise HTTPException(503, "PIN state unavailable")
        monkeypatch.setattr(S, "load_pin_config", unavailable)
    read = Mock(side_effect=AssertionError("Denied read"))
    monkeypatch.setattr(shelly_store, "read", read)
    response = f.client(**options).get(path)
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    for probe in (read, f.session_factory, f.outbound, f.vault, f.cwd):
        probe.assert_not_called()
    assert not f.path.exists()


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["pin-browser", "local-browser", "open-local"])
def test_private_system_supported_browser_access(private_system, path, mode):
    f = private_system
    options = {}
    if mode != "pin-browser":
        options.update(base="http://localhost", peer="127.0.0.1")
    if mode == "open-local":
        f.cfg["enabled"] = False
        options["cookie"] = False
    response = f.client(**options).get(path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    if path == PATHS[0]:
        assert response.json() == {"devices": []}
    elif path == PATHS[1]:
        assert response.json()["cwd"] == "PRIVATE-CWD"
    else:
        assert response.json() == {"lmstudio": {"ok": True, "status_code": 200}, "vault": {"initialized": True}}
        assert f.outbound.call_args.kwargs["allow_redirects"] is False
        assert f.outbound.call_args.kwargs["stream"] is True
        assert f.session.trust_env is False
        f.provider.close.assert_called_once()
        f.session.__exit__.assert_called_once()


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("change", ["revoke", "expire", "pin-change", "owner-change", "unavailable"])
@pytest.mark.parametrize("source_error", [False, True])
def test_private_system_denies_after_observation_and_errors(private_system, monkeypatch, path, change, source_error):
    f = private_system

    def lose_access(*args, **kwargs):
        if change == "revoke":
            S.revoke_session_token(f.token)
        elif change == "expire":
            S._active_sessions[f.token]["expiry"] = 0
        elif change == "pin-change":
            f.cfg["enabled"] = False
        elif change == "owner-change":
            S._active_sessions[f.token]["user_id"] = "different-owner"
        else:
            def unavailable():
                raise HTTPException(503, "PIN state unavailable")
            monkeypatch.setattr(S, "load_pin_config", unavailable)
        if source_error:
            raise OSError("PRIVATE-ERROR")
        return [] if path == PATHS[0] else "PRIVATE-CWD" if path == PATHS[1] else f.provider

    if path == PATHS[0]:
        monkeypatch.setattr(shelly_store, "read", lose_access)
    elif path == PATHS[1]:
        f.cwd.side_effect = lose_access
    else:
        f.outbound.side_effect = lose_access
    response = f.client().get(path)
    assert response.status_code == (503 if change == "unavailable" else 401), response.text
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text and "initialized" not in response.text
    f.vault.assert_not_called()
    if path == PATHS[2] and not source_error:
        f.provider.close.assert_called_once()


@pytest.mark.parametrize("phase", ["model-close", "vault-read"])
def test_selftest_late_revocation_stops_followup_and_disclosure(private_system, phase):
    f = private_system
    target = f.provider.close if phase == "model-close" else f.vault
    target.side_effect = lambda: S.revoke_session_token(f.token)
    response = f.client().get(PATHS[2])
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    assert "initialized" not in response.text
    f.provider.close.assert_called_once()
    if phase == "model-close":
        f.vault.assert_not_called()


@pytest.mark.parametrize("damage", ['{', '{}', '[{"ip":"192.0.2.4","relay":-1}]', '[{"ip":"192.0.2.4","ip":"192.0.2.5"}]'])
def test_capabilities_preserves_damaged_registry(private_system, damage):
    f = private_system
    f.path.write_text(damage, encoding="utf-8")
    response = f.client().get(PATHS[0])
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "devices" not in response.json()
    assert f.path.read_text(encoding="utf-8") == damage


def test_capabilities_projects_existing_registry_without_rewriting(private_system):
    f = private_system
    data = [{"host": "192.0.2.7", "label": "Desk", "relay": 2, "future": {"private": "preserve"}}]
    raw = json.dumps(data).encode()
    f.path.write_bytes(raw)
    response = f.client().get(PATHS[0])
    assert response.status_code == 200
    assert response.json() == {"devices": [{"name": "Desk", "ip": "192.0.2.7", "relay": 2,
        "vendor": "shelly", "capabilities": ["switch.on", "switch.off"]}]}
    assert "private" not in response.text and f.path.read_bytes() == raw


def test_capabilities_checks_after_registry_lock_wait(private_system, monkeypatch):
    f = private_system
    class LosingLock:
        def __enter__(self):
            S.revoke_session_token(f.token)
        def __exit__(self, *args):
            pass
    monkeypatch.setattr(shelly_store, "LOCK", LosingLock())
    reader = Mock(side_effect=AssertionError("Read after denied lock admission"))
    # The snapshot owns admission after the lock; spy on its first filesystem
    # walk, without replacing the authorization check we are verifying.
    monkeypatch.setattr(shelly_store, "_chain", reader)
    response = f.client().get(PATHS[0])
    assert response.status_code == 401
    reader.assert_not_called()


def test_selftest_failures_are_bounded_private_results(private_system):
    f = private_system
    f.outbound.side_effect = OSError("PRIVATE upstream address")
    f.vault.side_effect = OSError("PRIVATE vault path")
    response = f.client().get(PATHS[2])
    assert response.status_code == 200
    assert response.json() == {"lmstudio": {"ok": False, "error": "Model server probe failed"},
                               "vault": {"ok": False, "error": "Vault status unavailable"}}
    assert "PRIVATE" not in response.text


@pytest.mark.parametrize("path", PATHS)
def test_effective_main_mount_keeps_private_system_guard(app, private_system, monkeypatch, path):
    f = private_system
    denied = Mock(side_effect=AssertionError("Effective main route bypassed admission"))
    monkeypatch.setattr(shelly_store, "read", denied)
    response = f.client(target=app, cookie=False).get(path)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    for probe in (denied, f.outbound, f.vault, f.cwd):
        probe.assert_not_called()


@pytest.mark.parametrize("path,service", [
    ("/devices/usb/list", "devices_usb_list"), ("/devices/usb/info", "devices_usb_info"),
    ("/devices/usb/raw", "devices_usb_raw"), ("/devices/usb/detail", "devices_usb_detail"),
    ("/devices/usb", "devices_usb"), ("/devices/scan", "devices_scan"),
])
def test_effective_main_mount_keeps_device_observation_guard(app, private_system, monkeypatch, path, service):
    from routers import device_routes
    denied = Mock(side_effect=AssertionError("Effective main route bypassed device admission"))
    monkeypatch.setattr(device_routes, service, denied)
    response = private_system.client(target=app, cookie=False).get(path)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    denied.assert_not_called()
