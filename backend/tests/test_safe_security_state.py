"""Saved security files must never silently become a fresh installation."""
from __future__ import annotations

import base64
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import data_protection as dp
import node_identity as identity
import security_state as security
import tli_state as S
import vault_security as vault
from routers import system_routes, vault_routes


@pytest.fixture()
def installation(tmp_path, monkeypatch):
    root = tmp_path / "installation"
    data = root / "data"
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(S, "VAULT_DIR", str(data / "vault"))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", data / "tli_pin.json")
    monkeypatch.setattr(S, "MESH_DATA_DIR", data / "mesh")
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", data / "mesh" / "node_config.json")
    monkeypatch.setattr(vault, "VAULT_META_PATH", str(root / "vault_meta.json"))
    monkeypatch.setattr(vault, "_DATA_DIR", str(data))
    monkeypatch.setattr(vault, "UNLOCKED_VAULTS", {})
    monkeypatch.setattr(vault, "ENCRYPTION_KEYS", {})
    monkeypatch.setattr(identity, "_ident", None)
    monkeypatch.setattr(identity, "_data_dir", str(data))
    monkeypatch.setattr(dp, "is_windows", lambda: False)
    return root


def put(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def paired():
    return {"version": 1, "pairings": {}, "devices": {"phone": {"revoked_at": None}}, "preferences": {}}


def assert_unavailable(call, area=None):
    with pytest.raises(security.SecurityStateUnavailable) as result:
        call()
    error = result.value
    assert error.status_code == 503 and "preserved" in error.detail
    if area:
        assert error.area == area
    assert "private-marker" not in error.detail
    return error


def test_preflight_fresh_installation_is_read_only(installation):
    security.validate_existing_security()
    assert not installation.exists()


def test_fresh_installation_initializes_and_legacy_files_reload_unchanged(installation):
    cfg = S.load_node_config()
    identity.init(S.DATA_DIR)
    S.save_pin_config("a" * 64, "b" * 64)
    vault.setup_password("safe-password")
    before = snapshot(installation)
    security.validate_existing_security()
    identity.init(S.DATA_DIR)
    assert S.load_node_config().node_id == cfg.node_id
    assert S.load_pin_config()["enabled"]
    assert vault.verify_password("safe-password")
    assert snapshot(installation) == before


@pytest.mark.parametrize("value", [None, {}, [], {"hash": "x", "salt": "y"}, {"hash": "a" * 64, "salt": 42}, {"enabled": True}, {"enabled": False, "hash": "a" * 64, "salt": "b" * 64}])
def test_invalid_pin_cannot_read_set_or_clear(installation, value):
    path = put(S.PIN_CONFIG_FILE, value)
    before = snapshot(installation)
    for call in (S.load_pin_config, lambda: S.save_pin_config("a" * 64, "b" * 64), S.clear_pin_config, security.validate_existing_security):
        assert_unavailable(call)
    assert snapshot(installation) == before and path.exists()


def test_unreadable_pin_never_disables_or_overwrites(installation, monkeypatch):
    path = put(S.PIN_CONFIG_FILE, {"hash": "a" * 64, "salt": "b" * 64})
    original = Path.open
    def denied(p, *args, **kwargs):
        if p == path:
            raise PermissionError("private-marker")
        return original(p, *args, **kwargs)
    before = snapshot(installation)
    with monkeypatch.context() as m:
        m.setattr(Path, "open", denied)
        assert_unavailable(S.load_pin_config)
        assert_unavailable(S.clear_pin_config)
        assert_unavailable(lambda: S.save_pin_config("a" * 64, "b" * 64))
    assert snapshot(installation) == before


def test_missing_pin_with_pairing_history_requires_recovery(installation):
    put(Path(S.DATA_DIR) / "companion" / "credentials.json", paired())
    before = snapshot(installation)
    assert_unavailable(S.load_pin_config, "PIN configuration")
    assert_unavailable(lambda: S.save_pin_config("a" * 64, "b" * 64))
    assert snapshot(installation) == before


def test_explicit_pin_removal_survives_existing_pairings(installation):
    S.save_pin_config("a" * 64, "b" * 64)
    put(Path(S.DATA_DIR) / "companion" / "credentials.json", paired())
    S.clear_pin_config()
    assert S.load_pin_config() == {"enabled": False}
    assert json.loads(S.PIN_CONFIG_FILE.read_text()) == {"enabled": False}
    S.save_pin_config("c" * 64, "d" * 64)
    assert S.load_pin_config()["hash"] == "c" * 64


@pytest.mark.parametrize("endpoint,body", [("status", None), ("verify", {"pin": "1234"}), ("set", {"pin": "1234"}), ("remove", {"pin": "1234"}), ("emergency-reset", {})])
def test_corrupt_pin_routes_fail_before_mutation_even_with_auth_override(installation, endpoint, body, monkeypatch):
    path = put(S.PIN_CONFIG_FILE, {})
    app = FastAPI()
    app.include_router(system_routes.router)
    app.dependency_overrides[system_routes.require_session] = lambda: "owner"
    monkeypatch.setattr(S, "revoke_all_sessions", lambda: pytest.fail("Must not revoke sessions"))
    before = snapshot(installation)
    client = TestClient(app, base_url="https://localhost", headers={"Origin": "https://localhost"}, client=("127.0.0.1", 50000))
    response = client.get("/system/pin/status") if body is None else client.post("/system/pin/" + endpoint, json=body)
    assert response.status_code == 503
    assert snapshot(installation) == before and path.exists()


def test_emergency_reset_requires_session_when_pin_enabled(installation):
    S.save_pin_config("a" * 64, "b" * 64)
    app = FastAPI()
    app.include_router(system_routes.router)
    before = snapshot(installation)
    assert TestClient(app, base_url="https://localhost", headers={"Origin": "https://localhost"}).post("/system/pin/emergency-reset").status_code == 401
    assert snapshot(installation) == before


@pytest.mark.parametrize("value", [{}, [], {"node_id": "private-marker"}])
def test_bad_node_config_cannot_regenerate_or_save(installation, value):
    path = put(S.NODE_CONFIG_PATH, value)
    before = snapshot(installation)
    cfg = S.NodeConfig(node_id="other", node_name="Other", created_at="now", updated_at="now")
    for call in (S.load_node_config, lambda: S.save_node_config(cfg), security.validate_existing_security):
        assert_unavailable(call)
    assert snapshot(installation) == before and path.exists()


@pytest.mark.parametrize("dependency", ["mesh/mesh_directory.json", "mesh/agent_state.json", "intelligence/device_context.json", "companion/credentials.json"])
def test_missing_node_files_with_dependent_state_are_preserved(installation, dependency):
    put(Path(S.DATA_DIR) / dependency, paired() if dependency.startswith("companion") else {"existing": {}})
    before = snapshot(installation)
    assert_unavailable(S.load_node_config)
    assert_unavailable(lambda: identity.init(S.DATA_DIR))
    assert snapshot(installation) == before


def test_node_config_preserves_unknown_metadata_on_edit(installation):
    cfg = S.load_node_config()
    raw = json.loads(S.NODE_CONFIG_PATH.read_text())
    raw["future_setting"] = {"keep": True}
    put(S.NODE_CONFIG_PATH, raw)
    cfg.node_name = "New name"
    S.save_node_config(cfg)
    assert json.loads(S.NODE_CONFIG_PATH.read_text())["future_setting"] == {"keep": True}


@pytest.mark.parametrize("mutation", ["json", "public_key", "private_key_enc", "node_id", "dpapi"])
def test_existing_identity_damage_never_regenerates(installation, mutation):
    identity.init(S.DATA_DIR)
    path = Path(S.DATA_DIR) / "node_identity.json"
    value = json.loads(path.read_text())
    if mutation == "json":
        path.write_text("private-marker corrupt")
    else:
        value[mutation] = {"public_key": "ab" * 32, "private_key_enc": "!", "node_id": "different", "dpapi": "yes"}[mutation]
        put(path, value)
    before = snapshot(installation)
    assert_unavailable(lambda: identity.init(S.DATA_DIR), "node identity")
    assert identity._ident is None
    assert snapshot(installation) == before


def test_dpapi_identity_wrong_account_preserves_original(installation, monkeypatch):
    monkeypatch.setattr(dp, "is_windows", lambda: True)
    monkeypatch.setattr(dp, "dpapi_protect", lambda raw: b"protected" + raw)
    monkeypatch.setattr(dp, "dpapi_unprotect", lambda blob: blob[9:])
    identity.init(S.DATA_DIR)
    before = snapshot(installation)
    identity.init(S.DATA_DIR)
    def fail(_):
        raise ValueError("private-marker")
    monkeypatch.setattr(dp, "dpapi_unprotect", fail)
    assert_unavailable(lambda: identity.init(S.DATA_DIR))
    assert snapshot(installation) == before


def test_dpapi_protection_failure_does_not_persist_identity(installation, monkeypatch):
    monkeypatch.setattr(dp, "is_windows", lambda: True)
    def fail(_):
        raise OSError("private-marker")
    monkeypatch.setattr(dp, "dpapi_protect", fail)
    assert_unavailable(lambda: identity.init(S.DATA_DIR))
    assert not installation.exists() and identity._ident is None


@pytest.mark.parametrize("value", [{}, [], {"password_hash": "not-base64"}, {"password_hash": "private-marker", "password_salt": "invalid"}])
def test_invalid_vault_metadata_cannot_setup_unlock_reset_or_write(installation, value):
    put(vault.VAULT_META_PATH, value)
    before = snapshot(installation)
    for call in (vault.get_status, lambda: vault.setup_password("safe-password"), lambda: vault.unlock("owner", "safe-password"), vault.reset_vault, lambda: vault.generate_api_key("owner"), security.validate_existing_security):
        assert_unavailable(call)
    assert snapshot(installation) == before


@pytest.mark.parametrize("dependency", ["vault/saved.vault", "vault_sessions.json"])
def test_missing_vault_metadata_refuses_setup_with_existing_payloads(installation, dependency):
    put(Path(S.DATA_DIR) / dependency, {"saved": "private-marker"})
    before = snapshot(installation)
    assert_unavailable(vault.get_status)
    assert_unavailable(lambda: vault.setup_password("safe-password"))
    assert snapshot(installation) == before


def test_legacy_vault_without_encryption_salt_only_upgrades_without_data(installation):
    vault.setup_password("safe-password")
    raw = json.loads(Path(vault.VAULT_META_PATH).read_text())
    raw.pop("encryption_salt")
    put(vault.VAULT_META_PATH, raw)
    before = snapshot(installation)
    security.validate_existing_security()
    assert snapshot(installation) == before
    assert vault.unlock("owner", "safe-password")["success"]
    assert "encryption_salt" in json.loads(Path(vault.VAULT_META_PATH).read_text())


def test_missing_vault_salt_with_ciphertext_does_not_generate_replacement(installation):
    vault.setup_password("safe-password")
    raw = json.loads(Path(vault.VAULT_META_PATH).read_text())
    raw.pop("encryption_salt")
    put(vault.VAULT_META_PATH, raw)
    put(Path(S.VAULT_DIR) / "saved.vault", {"ciphertext": "private-marker"})
    before = snapshot(installation)
    assert_unavailable(lambda: vault.unlock("owner", "safe-password"))
    assert snapshot(installation) == before


def test_corrupt_vault_metadata_blocks_reset_before_any_payload_deletion(installation):
    put(vault.VAULT_META_PATH, {})
    put(Path(S.VAULT_DIR) / "saved.vault", {"ciphertext": "private-marker"})
    app = FastAPI()
    app.include_router(vault_routes.router)
    app.dependency_overrides[system_routes.require_session] = lambda: "owner"
    before = snapshot(installation)
    response = TestClient(app).post("/vault/reset", json={"confirmation": "RESET VAULT", "password": "safe-password"})
    assert response.status_code == 503 and snapshot(installation) == before


def test_reset_file_deletion_failure_retains_metadata_and_remaining_files(installation, monkeypatch):
    vault.setup_password("safe-password")
    path = put(Path(S.VAULT_DIR) / "saved.vault", {"ciphertext": "private-marker"})
    app = FastAPI()
    app.include_router(vault_routes.router)
    app.dependency_overrides[system_routes.require_session] = lambda: "owner"
    original = vault_routes.os.remove
    def denied(target, *args, **kwargs):
        if Path(target) == path:
            raise PermissionError("private-marker")
        return original(target, *args, **kwargs)
    monkeypatch.setattr(vault_routes.os, "remove", denied)
    before = snapshot(installation)
    response = TestClient(app).post("/vault/reset", json={"confirmation": "RESET VAULT", "password": "safe-password"})
    assert response.status_code == 503
    assert response.json()["detail"]["deleted_files"] == 0
    assert "Password metadata was preserved" in response.text
    assert "private-marker" not in response.text and snapshot(installation) == before


def test_authorized_vault_reset_allows_new_setup(installation):
    vault.setup_password("safe-password")
    assert vault.unlock("owner", "safe-password")["success"]
    put(Path(S.VAULT_DIR) / "saved.vault", {"ciphertext": "private-marker"})
    app = FastAPI()
    app.include_router(vault_routes.router)
    app.dependency_overrides[system_routes.require_session] = lambda: "owner"
    response = TestClient(app).post("/vault/reset", json={"confirmation": "RESET VAULT", "password": "safe-password"})
    assert response.status_code == 200 and response.json()["deleted_files"] == 1
    vault.setup_password("replacement-password")
    assert vault.verify_password("replacement-password")


def test_cached_vault_session_cannot_bypass_damaged_metadata(installation):
    vault.setup_password("safe-password")
    vault.unlock("owner", "safe-password")
    put(vault.VAULT_META_PATH, {})
    before = snapshot(installation)
    assert_unavailable(lambda: vault.get_encryption_key("owner"))
    assert_unavailable(lambda: vault.is_vault_unlocked("owner"))
    assert snapshot(installation) == before


def test_security_new_write_is_exclusive_and_needs_no_hardlinks(installation, monkeypatch):
    path = installation / "new.json"
    monkeypatch.setattr(security.os, "link", lambda *a: pytest.fail("Hardlinks unavailable"))
    security.write_json(path, {"keep": True}, "test configuration", new=True)
    before = path.read_bytes()
    assert_unavailable(lambda: security.write_json(path, {"replace": True}, "test configuration", new=True))
    assert path.read_bytes() == before


def test_failed_replacement_preserves_original(installation, monkeypatch):
    S.save_pin_config("a" * 64, "b" * 64)
    before = snapshot(installation)
    def fail(*args):
        raise PermissionError("private-marker")
    monkeypatch.setattr(security.os, "replace", fail)
    assert_unavailable(lambda: S.save_pin_config("c" * 64, "d" * 64))
    assert snapshot(installation) == before


def test_failed_initial_persistence_returns_no_identity(installation, monkeypatch):
    def fail(*args):
        raise OSError("private-marker")
    monkeypatch.setattr(security.os, "fsync", fail)
    assert_unavailable(lambda: identity.init(S.DATA_DIR))
    assert identity._ident is None
    assert not (Path(S.DATA_DIR) / "node_identity.json").exists()


@pytest.mark.parametrize("area", ["node", "identity", "vault"])
def test_unreadable_security_files_preserved(installation, monkeypatch, area):
    S.load_node_config()
    identity.init(S.DATA_DIR)
    vault.setup_password("safe-password")
    path, reader = {
        "node": (S.NODE_CONFIG_PATH, S.load_node_config),
        "identity": (Path(S.DATA_DIR) / "node_identity.json", lambda: identity.init(S.DATA_DIR)),
        "vault": (Path(vault.VAULT_META_PATH), vault.get_status),
    }[area]
    before = snapshot(installation)
    original = Path.open
    def denied(p, *args, **kwargs):
        if p == path:
            raise PermissionError("private-marker")
        return original(p, *args, **kwargs)
    with monkeypatch.context() as m:
        m.setattr(Path, "open", denied)
        assert_unavailable(reader)
    assert snapshot(installation) == before


def test_concurrent_vault_setup_retains_one_password(installation):
    def create(password):
        try:
            vault.setup_password(password)
            return password
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, ("first-password", "second-password")))
    winners = [p for p in results if p]
    assert len(winners) == 1 and vault.verify_password(winners[0])
