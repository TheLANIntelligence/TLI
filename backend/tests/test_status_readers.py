"""Checked node/Vault observations; temporary files and synthetic authority."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import security_state as security
import tli_state as S
import vault_security as vault


NODE = {"node_id": "saved-node", "node_name": "Private host", "role": "host",
        "mesh_status": "approved", "created_at": "2026-01-01", "updated_at": "2026-01-02",
        "unknown_metadata": {"keep": True}}
META = {"password_hash": base64.b64encode(b"h" * 32).decode(),
        "password_salt": base64.b64encode(b"s" * 16).decode(),
        "encryption_salt": base64.b64encode(b"e" * 16).decode(),
        "failed_attempts": 3, "future": {"keep": True}}


@pytest.fixture
def installation(tmp_path, monkeypatch):
    root = tmp_path / "installation"
    data = root / "data"
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(S, "VAULT_DIR", str(data / "vault"))
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", data / "mesh" / "node_config.json")
    monkeypatch.setattr(vault, "VAULT_META_PATH", str(root / "vault_meta.json"))
    monkeypatch.setattr(vault, "_DATA_DIR", str(data))
    monkeypatch.setattr(vault, "UNLOCKED_VAULTS", {})
    monkeypatch.setattr(vault, "ENCRYPTION_KEYS", {})
    monkeypatch.setattr(security, "write_json", lambda *a, **kw: pytest.fail("Status wrote saved state"))
    return SimpleNamespace(root=root, data=data, node=Path(S.NODE_CONFIG_PATH), meta=Path(vault.VAULT_META_PATH))


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def read(kind, check):
    return S.read_node_config(check=check) if kind == "node" else vault.get_status("owner", check=check)


def guard(state, status=401):
    def check():
        if state["revoked"]:
            raise HTTPException(status, "Captured authority ended")
    return check


def test_clean_missing_identity_and_vault_are_read_only(installation):
    assert S.read_node_config(check=lambda: None) is None
    assert vault.get_status("owner", check=lambda: None) == {
        "is_initialized": False, "locked_until": None, "failed_attempts": 0,
        "is_unlocked_for_user": False}
    assert not installation.root.exists()


def test_single_metadata_snapshot_and_original_owner_only(installation, monkeypatch):
    put(installation.node, NODE)
    put(installation.meta, META)
    before = snapshot(installation.root)
    now = datetime.utcnow()
    vault.UNLOCKED_VAULTS.update(owner=now + timedelta(minutes=5), other=now + timedelta(minutes=5))
    vault.ENCRYPTION_KEYS.update(owner=b"o" * 32, other=b"x" * 32)
    original, calls = security.read_json, []
    def observed(path, *args, **kwargs):
        calls.append(Path(path))
        return original(path, *args, **kwargs)
    monkeypatch.setattr(security, "read_json", observed)
    monkeypatch.setattr(vault, "is_initialized", lambda: pytest.fail("Reread metadata"))
    result = vault.get_status(" OWNER ", check=lambda: None)
    assert result == {"is_initialized": True, "locked_until": None,
                      "failed_attempts": 3, "is_unlocked_for_user": True}
    assert calls == [installation.meta]
    assert vault.get_status("absent", check=lambda: None)["is_unlocked_for_user"] is False
    assert S.read_node_config(check=lambda: None).node_id == "saved-node"
    assert snapshot(installation.root) == before


@pytest.mark.parametrize("checked", [False, True])
def test_expired_session_observation_preserves_legacy_cleanup_contract(installation, checked):
    put(installation.meta, META)
    expiry = datetime.utcnow() - timedelta(seconds=1)
    vault.UNLOCKED_VAULTS.update(owner=expiry, other=expiry)
    vault.ENCRYPTION_KEYS.update(owner=b"o" * 32, other=b"x" * 32)
    result = vault.get_status("owner", **({"check": lambda: None} if checked else {}))
    assert result["is_unlocked_for_user"] is False
    assert ("owner" in vault.UNLOCKED_VAULTS) is checked
    assert ("owner" in vault.ENCRYPTION_KEYS) is checked
    assert "other" in vault.UNLOCKED_VAULTS and "other" in vault.ENCRYPTION_KEYS


@pytest.mark.parametrize("seconds,expected", [(-10, False), (600, True)])
def test_lockout_projection_does_not_reset_saved_metadata(installation, seconds, expected):
    value = {**META, "locked_until": (datetime.utcnow() + timedelta(seconds=seconds)).isoformat()}
    put(installation.meta, value)
    before = installation.meta.read_bytes()
    result = vault.get_status("owner", check=lambda: None)
    assert result["locked_until"] == (value["locked_until"] if expected else None)
    assert installation.meta.read_bytes() == before


@pytest.mark.parametrize("kind", ["node", "vault"])
@pytest.mark.parametrize("status", [401, 403, 409, 503])
def test_denied_admission_does_not_read(installation, monkeypatch, kind, status):
    monkeypatch.setattr(security, "read_json", lambda *a, **kw: pytest.fail("Read after denied admission"))
    with pytest.raises(HTTPException) as caught:
        read(kind, guard({"revoked": True}, status))
    assert caught.value.status_code == status and not installation.root.exists()


@pytest.mark.parametrize("kind", ["node", "vault"])
@pytest.mark.parametrize("status", [401, 403, 409, 503])
@pytest.mark.parametrize("fault", [False, True])
def test_revocation_during_file_read_denies_output_and_stops_followups(installation, monkeypatch, kind, status, fault):
    target = installation.node if kind == "node" else installation.meta
    put(target, NODE if kind == "node" else META)
    before, opened, state = snapshot(installation.root), [], {"revoked": False}
    original_open = Path.open
    class Read:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            self.stream.__enter__()
            return self
        def __exit__(self, *args):
            return self.stream.__exit__(*args)
        def read(self, limit):
            value = self.stream.read(limit)
            state["revoked"] = True
            if fault:
                raise OSError("private path failure")
            return value
    def wrapped(path, *args, **kwargs):
        opened.append(path)
        stream = original_open(path, *args, **kwargs)
        return Read(stream) if path == target else stream
    monkeypatch.setattr(Path, "open", wrapped)
    vault.UNLOCKED_VAULTS["owner"] = datetime.utcnow() - timedelta(seconds=1)
    vault.ENCRYPTION_KEYS["owner"] = b"o" * 32
    with pytest.raises(HTTPException) as caught:
        read(kind, guard(state, status))
    assert caught.value.status_code == status and caught.value.detail == "Captured authority ended"
    assert opened == [target]
    assert "owner" in vault.UNLOCKED_VAULTS and "owner" in vault.ENCRYPTION_KEYS
    monkeypatch.setattr(Path, "open", original_open)
    assert snapshot(installation.root) == before


@pytest.mark.parametrize("dependency", ["companion/credentials.json", "mesh/mesh_directory.json",
    "mesh/agent_state.json", "mesh/agent_tasks.json", "intelligence/device_context.json"])
@pytest.mark.parametrize("fault", [False, True])
def test_missing_node_dependency_revocation_stops_remaining_reads(installation, monkeypatch, dependency, fault):
    put(installation.data / "companion/credentials.json", {"version": 1, "devices": {}, "pairings": {}, "preferences": {}})
    for name in ("mesh/mesh_directory.json", "mesh/agent_state.json", "mesh/agent_tasks.json", "intelligence/device_context.json"):
        put(installation.data / name, {})
    target, original, calls, state = installation.data / dependency, security.read_json, [], {"revoked": False}
    before = snapshot(installation.root)
    def observed(path, *args, **kwargs):
        calls.append(Path(path))
        result = original(path, *args, **kwargs)
        if Path(path) == target:
            state["revoked"] = True
            if fault:
                raise security.SecurityStateUnavailable("fixture dependency")
        return result
    monkeypatch.setattr(security, "read_json", observed)
    with pytest.raises(HTTPException) as caught:
        S.read_node_config(check=guard(state))
    assert caught.value.status_code == 401 and calls[-1] == target
    assert snapshot(installation.root) == before


@pytest.mark.parametrize("kind", ["node", "vault"])
def test_authority_lost_while_waiting_for_lock_blocks_read(installation, monkeypatch, kind):
    entered, state = Event(), {"revoked": False}
    lock = S._NODE_CONFIG_LOCK if kind == "node" else vault._META_LOCK
    monkeypatch.setattr(security, "read_json", lambda *a, **kw: pytest.fail("Read after revoked lock wait"))
    def check():
        entered.set()
        guard(state)()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with lock:
            pending = pool.submit(read, kind, check)
            assert entered.wait(5)
            state["revoked"] = True
        with pytest.raises(HTTPException) as caught:
            pending.result(timeout=5)
    assert caught.value.status_code == 401 and not installation.root.exists()


@pytest.mark.parametrize("fault", [False, True])
def test_vault_directory_scan_revocation_closes_iterator_without_session_read(installation, monkeypatch, fault):
    state, observed = {"revoked": False}, []
    class Entries:
        closed = False
        reads = 0
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.closed = True
        def __iter__(self):
            return self
        def __next__(self):
            self.reads += 1
            assert self.reads == 1
            state["revoked"] = True
            if fault:
                raise OSError("private scan failure")
            return SimpleNamespace(name="private.vault")
    entries, original = Entries(), security.read_json
    monkeypatch.setattr(vault.os, "scandir", lambda *a: entries)
    def observed_read(path, *args, **kwargs):
        observed.append(Path(path))
        return original(path, *args, **kwargs)
    monkeypatch.setattr(security, "read_json", observed_read)
    with pytest.raises(HTTPException) as caught:
        vault.get_status("owner", check=guard(state, 503))
    assert caught.value.status_code == 503 and caught.value.detail == "Captured authority ended"
    assert entries.closed and observed == [installation.meta]


def test_vault_session_dependency_read_denies_after_revocation(installation, monkeypatch):
    path = installation.data / "vault_sessions.json"
    put(path, {})
    original, state, observed = security.read_json, {"revoked": False}, []
    def read_then_revoke(target, *args, **kwargs):
        observed.append(Path(target))
        result = original(target, *args, **kwargs)
        if Path(target) == path:
            state["revoked"] = True
        return result
    monkeypatch.setattr(security, "read_json", read_then_revoke)
    with pytest.raises(HTTPException) as caught:
        vault.get_status("owner", check=guard(state))
    assert caught.value.status_code == 401 and observed == [installation.meta, path]


@pytest.mark.parametrize("kind", ["node", "vault"])
@pytest.mark.parametrize("raw", [b"broken", b"[]", b"{}", b"x" * (1024 * 1024 + 1)],
                         ids=["broken", "array", "empty-object", "oversized"])
def test_damaged_state_is_preserved_and_never_substituted(installation, kind, raw):
    path = installation.node if kind == "node" else installation.meta
    path.parent.mkdir(parents=True)
    path.write_bytes(raw)
    before = snapshot(installation.root)
    with pytest.raises(security.SecurityStateUnavailable) as caught:
        read(kind, lambda: None)
    assert caught.value.status_code == 503 and snapshot(installation.root) == before


def test_malformed_vault_lockout_is_not_silently_cleared(installation):
    put(installation.meta, {**META, "locked_until": "invalid-private-time"})
    before = installation.meta.read_bytes()
    with pytest.raises(security.SecurityStateUnavailable):
        vault.get_status("owner", check=lambda: None)
    assert installation.meta.read_bytes() == before


@pytest.mark.parametrize("kind", ["node", "vault"])
def test_final_projection_revocation_withholds_result(installation, monkeypatch, kind):
    put(installation.node, NODE)
    put(installation.meta, META)
    state = {"revoked": False}
    if kind == "node":
        original = S.NodeConfig.model_validate
        def validate(cls, *args, **kwargs):
            result = original(*args, **kwargs)
            state["revoked"] = True
            return result
        monkeypatch.setattr(S.NodeConfig, "model_validate", classmethod(validate))
    else:
        original = vault._normalize_user_id
        def normalize(*args):
            result = original(*args)
            state["revoked"] = True
            return result
        monkeypatch.setattr(vault, "_normalize_user_id", normalize)
    before = snapshot(installation.root)
    with pytest.raises(HTTPException) as caught:
        read(kind, guard(state))
    assert caught.value.status_code == 401 and snapshot(installation.root) == before


@pytest.mark.parametrize("reader", ["json", "node", "vault", "meta", "companion", "node-dependencies", "vault-dependencies"])
@pytest.mark.parametrize("error_type", [FileNotFoundError, OSError, RuntimeError])
def test_one_shot_non_http_authority_failure_never_becomes_missing_or_damage(installation, monkeypatch, reader, error_type):
    companion = installation.data / "companion/credentials.json"
    sessions = installation.data / "vault_sessions.json"
    put(installation.node, NODE)
    put(installation.meta, META)
    put(companion, {"version": 1, "devices": {}, "pairings": {}, "preferences": {}})
    put(sessions, {})
    target = (companion if reader in {"companion", "node-dependencies"} else
              sessions if reader == "vault-dependencies" else
              installation.meta if reader in {"vault", "meta"} else installation.node)
    state, opened, original_open = {"armed": False}, [], Path.open
    failure = error_type("one captured check failure")
    def check():
        if state["armed"]:
            state["armed"] = False  # A later check succeeds; the first failure still wins.
            raise failure
    class Read:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            self.stream.__enter__()
            return self
        def __exit__(self, *args):
            return self.stream.__exit__(*args)
        def read(self, limit):
            result = self.stream.read(limit)
            state["armed"] = True
            return result
    def wrapped(path, *args, **kwargs):
        opened.append(path)
        stream = original_open(path, *args, **kwargs)
        return Read(stream) if path == target else stream
    monkeypatch.setattr(Path, "open", wrapped)
    calls = {
        "json": lambda: security.read_json(target, "fixture", check=check),
        "node": lambda: S.read_node_config(check=check),
        "vault": lambda: vault.get_status("owner", check=check),
        "meta": lambda: vault.read_existing_meta(check=check),
        "companion": lambda: security.companion_dependencies(installation.data, check=check),
        "node-dependencies": lambda: security.node_dependencies(installation.data, check=check),
        "vault-dependencies": lambda: vault._has_vault_dependencies(check=check),
    }
    with pytest.raises(error_type) as caught:
        calls[reader]()
    assert caught.value is failure and opened == [target]
    assert not state["armed"]


@pytest.mark.parametrize("error_type", [FileNotFoundError, OSError, RuntimeError])
def test_one_shot_authority_failure_during_scan_is_not_storage_error(installation, monkeypatch, error_type):
    state, failure = {"armed": False}, error_type("scan authority stopped once")
    def check():
        if state["armed"]:
            state["armed"] = False
            raise failure
    class Entries:
        closed = False
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.closed = True
        def __iter__(self):
            state["armed"] = True
            yield SimpleNamespace(name="private.vault")
            pytest.fail("Read another directory entry after authority failed")
    entries = Entries()
    monkeypatch.setattr(vault.os, "scandir", lambda *a: entries)
    monkeypatch.setattr(security, "read_json", lambda *a, **kw: pytest.fail("Read saved sessions after denied scan"))
    with pytest.raises(error_type) as caught:
        vault._has_vault_dependencies(check=check)
    assert caught.value is failure and entries.closed


@pytest.mark.parametrize("fault", [False, True])
def test_direct_node_dependency_error_rechecks_authority(installation, monkeypatch, fault):
    state, calls = {"revoked": False}, []
    def saved(path, *args, **kwargs):
        calls.append(Path(path))
        if str(path).endswith("credentials.json"):
            return {"version": 1, "devices": {}, "pairings": {}, "preferences": {}}
        state["revoked"] = True
        if fault:
            raise security.SecurityStateUnavailable("fixture")
        return []
    monkeypatch.setattr(security, "read_json", saved)
    with pytest.raises(HTTPException) as caught:
        security.node_dependencies(installation.data, check=guard(state))
    assert caught.value.status_code == 401
    assert calls == [installation.data / "companion/credentials.json", installation.data / "mesh/mesh_directory.json"]
