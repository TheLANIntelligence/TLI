"""Status is a captured browser observation, never a registry/identity writer."""
import json
import base64
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import tli_state as S
import vault_security as vault
from routers import system_routes as routes


@pytest.fixture
def status_host(tmp_path, monkeypatch):
    root = tmp_path / "data"
    node_path = root / "mesh" / "node_config.json"
    node_path.parent.mkdir(parents=True)
    node = {"node_id": "private-node", "node_name": "Private host", "role": "host",
            "mesh_status": "approved", "created_at": "2026-10-01T00:00:00Z",
            "updated_at": "2026-10-01T00:00:00Z", "unknown": "PRIVATE node metadata"}
    node_path.write_text(json.dumps(node), encoding="utf-8")
    devices_path = root / "devices.json"
    devices_path.write_bytes(b'{"PRIVATE registry": damaged')
    monkeypatch.setattr(S, "DATA_DIR", str(root))
    monkeypatch.setattr(S, "MESH_DATA_DIR", node_path.parent)
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", node_path)
    monkeypatch.setattr(S, "DEVICES_FILE", str(devices_path))
    monkeypatch.setattr(S, "VAULT_DIR", str(root / "vault"))
    monkeypatch.setattr(vault, "VAULT_META_PATH", str(tmp_path / "vault_meta.json"))
    monkeypatch.setattr(vault, "_DATA_DIR", str(root))
    monkeypatch.setattr(vault, "UNLOCKED_VAULTS", {})
    monkeypatch.setattr(vault, "ENCRYPTION_KEYS", {})
    cfg = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(cfg))
    monkeypatch.setattr(S, "_active_sessions", {})
    token = S.create_session_token("owner")
    health = Mock(return_value=True)
    provider = SimpleNamespace(health_check=health)
    monkeypatch.setattr(S, "lm_provider", provider)
    monkeypatch.setattr(routes, "_health_cache", {"result": False, "ts": 0, "provider": None})
    raw_vault = {"is_initialized": True, "locked_until": None, "failed_attempts": 2,
                 "is_unlocked_for_user": True, "secret": "PRIVATE Vault extra"}
    vault_read = Mock(return_value=raw_vault)
    monkeypatch.setattr(routes, "vault_get_status", vault_read)
    blocked = {}
    for name in ("load_node_config", "save_node_config", "load_devices", "save_devices"):
        blocked[name] = Mock(side_effect=AssertionError("Status reached a registry/identity writer"))
        monkeypatch.setattr(S, name, blocked[name])
    app = FastAPI(); app.include_router(routes.router)
    clients = []
    def browser(mode="pin-local", *, target=app):
        local = mode not in {"pin-https", "pin-off-lan", "remote-http"}
        origin = "http://localhost:8000" if local else ("http" if mode == "remote-http" else "https") + "://192.0.2.5:8443"
        if mode in {"open-local", "pin-off-lan", "pin-off-stale"}: cfg["enabled"] = False
        value = TestClient(target, base_url=origin, client=("127.0.0.1" if local else "192.0.2.8", 1234),
                           headers={"Origin": origin}, raise_server_exceptions=False)
        if mode not in {"anonymous", "open-local", "pin-off-lan"}:
            value.headers["Cookie"] = "tli_session=" + token
        if mode in {"revoked", "pin-off-stale"}: S.revoke_session_token(token)
        if mode == "expired": S._active_sessions[token]["expiry"] = 0
        if mode == "foreign-origin": value.headers["Origin"] = "https://foreign.invalid"
        if mode == "same-site": value.headers["Sec-Fetch-Site"] = "same-site"
        if mode == "proxy": value.headers["Forwarded"] = "for=127.0.0.1"
        if mode == "peer": value.headers["X-TLI-Peer-Id"] = "synthetic-peer"
        if mode == "bearer": value.headers["Authorization"] = "Bearer synthetic-companion"
        clients.append(value)
        return value
    yield SimpleNamespace(root=root, node_path=node_path, node=node, devices_path=devices_path,
                          cfg=cfg, token=token, provider=provider, health=health, vault=vault_read,
                          raw_vault=raw_vault, blocked=blocked, browser=browser)
    for value in clients: value.close()


def unchanged(f):
    assert f.devices_path.read_bytes() == b'{"PRIVATE registry": damaged'
    for blocked in f.blocked.values(): blocked.assert_not_called()


@pytest.mark.parametrize("mode,status", [("anonymous", 401), ("revoked", 401), ("expired", 401),
    ("pin-off-stale", 401), ("pin-off-lan", 403), ("remote-http", 403), ("foreign-origin", 403),
    ("same-site", 403), ("proxy", 403), ("peer", 403), ("bearer", 403), ("unavailable", 503)])
def test_status_denied_before_any_private_read(status_host, monkeypatch, mode, status):
    f = status_host
    if mode == "unavailable":
        monkeypatch.setattr(S, "load_pin_config", Mock(side_effect=HTTPException(503, "Security unavailable")))
    node_read = Mock(side_effect=AssertionError("Private node read reached"))
    monkeypatch.setattr(S, "read_node_config", node_read)
    result = f.browser(mode).get("/status")
    assert result.status_code == status, result.text
    assert result.headers["cache-control"] == "no-store"
    node_read.assert_not_called(); f.health.assert_not_called(); f.vault.assert_not_called()
    unchanged(f)


@pytest.mark.parametrize("mode", ["pin-local", "pin-https", "open-local"])
def test_supported_status_response_is_read_only_and_owner_bound(status_host, mode):
    f = status_host
    before = f.node_path.read_bytes()
    result = f.browser(mode).get("/status")
    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    assert result.json() == {"model_online": True, "device_id": "private-node", "device_nickname": "Private host",
                             "node_role": "host", "mesh_status": "approved", "vault_status": {
                                 "initialized": True, "locked_until": None, "failed_attempts": 2, "unlocked": True}}
    assert f.vault.call_args.args == ("local" if mode == "open-local" else "owner",)
    assert callable(f.vault.call_args.kwargs["check"])
    assert callable(f.health.call_args.kwargs["check"])
    assert f.node_path.read_bytes() == before
    unchanged(f)


def test_missing_identity_remains_absent_and_is_not_invented(status_host):
    f = status_host
    f.node_path.unlink()
    response = f.browser().get("/status")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["device_id"] is None and data["device_nickname"] == "TLI Node"
    assert data["node_role"] == "standalone" and data["mesh_status"] == "unpaired"
    assert not f.node_path.exists()
    unchanged(f)


@pytest.mark.parametrize("damage", [b'{"PRIVATE":broken', b'[]', b'{}', b'null', b'{"node_id": "PRIVATE"}'])
def test_damaged_node_is_not_a_fresh_host_or_a_model_probe(status_host, damage):
    f = status_host
    f.node_path.write_bytes(damage)
    response = f.browser().get("/status")
    assert response.status_code == 503, response.text
    assert response.headers["cache-control"] == "no-store" and "PRIVATE" not in response.text
    assert f.node_path.read_bytes() == damage
    f.health.assert_not_called(); f.vault.assert_not_called()
    unchanged(f)


def test_missing_node_with_saved_dependencies_is_not_fresh(status_host):
    f = status_host
    f.node_path.unlink()
    dependency = f.node_path.parent / "mesh_directory.json"
    dependency.write_text('{"private-peer": {"name": "Private peer"}}')
    before = dependency.read_bytes()
    response = f.browser().get("/status")
    assert response.status_code == 503
    assert dependency.read_bytes() == before and not f.node_path.exists()
    f.health.assert_not_called(); f.vault.assert_not_called()
    unchanged(f)


@pytest.mark.parametrize("stage", ["node", "model", "vault"])
@pytest.mark.parametrize("change", ["revoke", "expire", "owner", "epoch", "unavailable"])
@pytest.mark.parametrize("error", [False, True])
def test_status_retains_authority_through_reads_and_error_disclosure(status_host, monkeypatch, stage, change, error):
    f = status_host
    client = f.browser("open-local" if change == "epoch" else "pin-local")
    original_node = S.read_node_config
    def work(*args, **kwargs):
        value = original_node(**kwargs) if stage == "node" else True if stage == "model" else f.raw_vault
        if change == "revoke": S.revoke_session_token(f.token)
        elif change == "expire": S._active_sessions[f.token]["expiry"] = 0
        elif change == "owner": S._active_sessions[f.token]["user_id"] = "other-owner"
        elif change == "epoch": S.revoke_all_sessions()
        else: monkeypatch.setattr(S, "load_pin_config", Mock(side_effect=HTTPException(503, "Security unavailable")))
        if error: raise RuntimeError("PRIVATE source failure")
        return value
    if stage == "node": monkeypatch.setattr(S, "read_node_config", work)
    elif stage == "model": f.health.side_effect = work
    else: f.vault.side_effect = work
    response = client.get("/status")
    assert response.status_code == (503 if change == "unavailable" else 401), response.text
    assert response.headers["cache-control"] == "no-store" and "PRIVATE" not in response.text
    if stage == "node": f.health.assert_not_called()
    if stage != "vault": f.vault.assert_not_called()
    if stage == "model": assert routes._health_cache["result"] is False
    unchanged(f)


@pytest.mark.parametrize("stage", ["node", "model", "vault"])
def test_private_reader_failure_is_generic_not_successful_fallback(status_host, monkeypatch, stage):
    f = status_host
    failure = RuntimeError("PRIVATE filesystem path or provider credential")
    if stage == "node": monkeypatch.setattr(S, "read_node_config", Mock(side_effect=failure))
    elif stage == "model": f.health.side_effect = failure
    else: f.vault.side_effect = failure
    response = f.browser().get("/status")
    assert response.status_code == 503
    assert response.json() == {"detail": "Private system information is unavailable."}
    assert response.headers["cache-control"] == "no-store"
    unchanged(f)


def test_status_unavailable_model_is_truthful_without_losing_node_and_vault(status_host):
    f = status_host
    f.health.return_value = False
    response = f.browser().get("/status")
    assert response.status_code == 200
    assert response.json()["model_online"] is False
    assert response.json()["device_id"] == "private-node"
    assert response.json()["vault_status"]["initialized"] is True
    unchanged(f)


@pytest.mark.parametrize("checked", [False, True])
def test_status_health_cache_requires_checked_provenance(status_host, monkeypatch, checked):
    f = status_host
    monkeypatch.setattr(routes, "_health_cache", {"result": False, "ts": 10**12,
                                               "provider": f.provider, "checked": checked})
    response = f.browser().get("/status")
    assert response.status_code == 200
    assert response.json()["model_online"] is (False if checked else True)
    assert f.health.call_count == (0 if checked else 1)
    unchanged(f)


def test_other_browser_session_cannot_supply_vault_owner(status_host):
    f = status_host
    S.create_session_token("other-owner")
    response = f.browser().get("/status")
    assert response.status_code == 200
    assert f.vault.call_args.args == ("owner",)


@pytest.mark.parametrize("mode", ["anonymous", "revoked", "pin-off-lan", "foreign-origin", "bearer", "pin-https"])
def test_effective_main_status_route_has_browser_authority(status_host, monkeypatch, app, mode):
    import companion_auth
    f = status_host
    if mode == "bearer": monkeypatch.setattr(companion_auth, "credential_owner", lambda _: "owner")
    response = f.browser(mode, target=app).get("/status")
    expected = 401 if mode in {"anonymous", "revoked"} else 200 if mode == "pin-https" else 403
    assert response.status_code == expected, response.text
    assert response.headers["cache-control"] == "no-store"
    if expected != 200: f.health.assert_not_called(); f.vault.assert_not_called()
    unchanged(f)


def test_effective_main_invalid_bearer_does_not_fall_back_to_browser(status_host, monkeypatch, app):
    import companion_auth
    def invalid(_): raise HTTPException(401, "Credential revoked")
    monkeypatch.setattr(companion_auth, "credential_owner", invalid)
    f = status_host
    response = f.browser("bearer", target=app).get("/status")
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    f.health.assert_not_called(); f.vault.assert_not_called()
    unchanged(f)


def valid_vault_metadata():
    return {"password_hash": base64.b64encode(b"h" * 32).decode(),
            "password_salt": base64.b64encode(b"s" * 16).decode(),
            "encryption_salt": base64.b64encode(b"e" * 16).decode(),
            "failed_attempts": 3, "locked_until": None, "future": "PRIVATE metadata"}


@pytest.mark.parametrize("owner_unlocked", [False, True])
def test_actual_vault_status_is_bound_to_browser_owner(status_host, monkeypatch, owner_unlocked):
    f = status_host
    meta = Path(vault.VAULT_META_PATH)
    meta.write_text(json.dumps(valid_vault_metadata()))
    before = meta.read_bytes()
    now = datetime.utcnow()
    vault.UNLOCKED_VAULTS.update({"other-owner": now + timedelta(hours=1)})
    vault.ENCRYPTION_KEYS["other-owner"] = b"other synthetic key"
    if owner_unlocked:
        vault.UNLOCKED_VAULTS["owner"] = now + timedelta(hours=1)
        vault.ENCRYPTION_KEYS["owner"] = b"owner synthetic key"
    maps = dict(vault.UNLOCKED_VAULTS), dict(vault.ENCRYPTION_KEYS)
    monkeypatch.setattr(routes, "vault_get_status", vault.get_status)
    response = f.browser().get("/status")
    assert response.status_code == 200, response.text
    assert response.json()["vault_status"] == {"initialized": True, "locked_until": None,
                                               "failed_attempts": 3, "unlocked": owner_unlocked}
    assert "PRIVATE" not in response.text
    assert meta.read_bytes() == before
    assert (vault.UNLOCKED_VAULTS, vault.ENCRYPTION_KEYS) == maps
    unchanged(f)


def test_actual_expired_vault_status_does_not_prune_private_session_maps(status_host, monkeypatch):
    f = status_host
    meta = Path(vault.VAULT_META_PATH)
    meta.write_text(json.dumps(valid_vault_metadata()))
    before = meta.read_bytes()
    vault.UNLOCKED_VAULTS["owner"] = datetime.utcnow() - timedelta(hours=1)
    vault.ENCRYPTION_KEYS["owner"] = b"expired synthetic key"
    maps = dict(vault.UNLOCKED_VAULTS), dict(vault.ENCRYPTION_KEYS)
    monkeypatch.setattr(routes, "vault_get_status", vault.get_status)
    response = f.browser().get("/status")
    assert response.status_code == 200
    assert response.json()["vault_status"]["unlocked"] is False
    assert (vault.UNLOCKED_VAULTS, vault.ENCRYPTION_KEYS) == maps
    assert meta.read_bytes() == before
    unchanged(f)


@pytest.mark.parametrize("damage", [b'{"PRIVATE":broken', b'[]', b'{}'])
def test_actual_damaged_vault_metadata_is_preserved(status_host, monkeypatch, damage):
    f = status_host
    meta = Path(vault.VAULT_META_PATH)
    meta.write_bytes(damage)
    vault.UNLOCKED_VAULTS["owner"] = datetime.utcnow() + timedelta(hours=1)
    vault.ENCRYPTION_KEYS["owner"] = b"owner synthetic key"
    maps = dict(vault.UNLOCKED_VAULTS), dict(vault.ENCRYPTION_KEYS)
    monkeypatch.setattr(routes, "vault_get_status", vault.get_status)
    response = f.browser().get("/status")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store" and "PRIVATE" not in response.text
    assert meta.read_bytes() == damage
    assert (vault.UNLOCKED_VAULTS, vault.ENCRYPTION_KEYS) == maps
    unchanged(f)


@pytest.mark.parametrize("dependency", ["blob", "sessions"])
def test_actual_missing_vault_metadata_with_dependencies_is_not_empty(status_host, monkeypatch, dependency):
    f = status_host
    meta = Path(vault.VAULT_META_PATH)
    assert not meta.exists()
    if dependency == "blob":
        saved = Path(S.VAULT_DIR) / "private.vault"
        saved.parent.mkdir()
        saved.write_bytes(b"PRIVATE encrypted fixture")
    else:
        saved = f.root / "vault_sessions.json"
        saved.write_text('{"owner": "PRIVATE retained session"}')
    before = saved.read_bytes()
    monkeypatch.setattr(routes, "vault_get_status", vault.get_status)
    response = f.browser().get("/status")
    assert response.status_code == 503 and response.headers["cache-control"] == "no-store"
    assert not meta.exists() and saved.read_bytes() == before
    assert "PRIVATE" not in response.text
    unchanged(f)


def test_actual_fresh_vault_status_does_not_initialize_storage(status_host, monkeypatch):
    f = status_host
    monkeypatch.setattr(routes, "vault_get_status", vault.get_status)
    response = f.browser().get("/status")
    assert response.status_code == 200
    assert response.json()["vault_status"] == {"initialized": False, "locked_until": None,
                                               "failed_attempts": 0, "unlocked": False}
    assert not Path(vault.VAULT_META_PATH).exists()
    assert not Path(S.VAULT_DIR).exists() and not (f.root / "vault_sessions.json").exists()
    unchanged(f)


@pytest.mark.parametrize("stage", ["node", "vault"])
@pytest.mark.parametrize("source_error", [False, True])
def test_status_rechecks_inside_actual_private_json_read(status_host, monkeypatch, stage, source_error):
    import security_state
    f = status_host
    meta = Path(vault.VAULT_META_PATH)
    meta.write_text(json.dumps(valid_vault_metadata()))
    monkeypatch.setattr(routes, "vault_get_status", vault.get_status)
    read = security_state.read_json
    target = f.node_path if stage == "node" else meta
    before = target.read_bytes()
    calls = []
    def revoked(path, *args, **kwargs):
        result = read(path, *args, **kwargs)
        if Path(path) == target:
            calls.append(path)
            S.revoke_session_token(f.token)
            if source_error: raise OSError("PRIVATE read error")
        return result
    monkeypatch.setattr(security_state, "read_json", revoked)
    response = f.browser().get("/status")
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text and target.read_bytes() == before
    assert len(calls) == 1
    if stage == "node": f.health.assert_not_called()
    unchanged(f)


def test_owner_resolution_cannot_continue_after_session_revocation(status_host, monkeypatch):
    import companion_auth
    f = status_host
    resolve = companion_auth.resolve_user
    def revoked(*args, **kwargs):
        owner = resolve(*args, **kwargs)
        S.revoke_session_token(f.token)
        return owner
    monkeypatch.setattr(companion_auth, "resolve_user", revoked)
    node = Mock(side_effect=AssertionError("Node read after revoked owner resolution"))
    monkeypatch.setattr(S, "read_node_config", node)
    response = f.browser().get("/status")
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    node.assert_not_called(); f.health.assert_not_called(); f.vault.assert_not_called()
