"""Vault rebuild regressions using disposable metadata, keys and ciphertext only."""
from __future__ import annotations

import builtins
import base64
from datetime import datetime, timedelta
import hashlib
import io
import json
from pathlib import Path
from urllib.parse import quote
import zipfile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import data_protection as dp
import tli_state as S
import vault_security as security
from routers import system_routes, vault_routes as routes


PASSWORD = "  preserve literal passphrase  "


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    directory = tmp_path / "vault"
    directory.mkdir()
    monkeypatch.setattr(S, "VAULT_DIR", str(directory))
    monkeypatch.setattr(security, "VAULT_META_PATH", str(tmp_path / "vault_meta.json"))
    monkeypatch.setattr(security, "_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(security, "UNLOCKED_VAULTS", {})
    monkeypatch.setattr(security, "ENCRYPTION_KEYS", {})
    monkeypatch.setattr(dp, "is_windows", lambda: False)
    security.setup_password(PASSWORD)
    assert security.unlock("owner", PASSWORD)["success"]
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[system_routes.require_session] = lambda: "owner"
    return TestClient(app, raise_server_exceptions=False), directory, tmp_path


def login():
    return {"name": "Router", "domain": "router.test", "username": "owner", "password": "synthetic-only"}


def store_path(kind):
    return Path(routes._vault_secrets_path("owner") if kind == "secrets" else routes._vault_logins_path("owner"))


def mutation(client, kind):
    return client.post("/vault/secret/new", json={"value": "replacement"}) if kind == "secrets" else client.post("/vault/logins", json=login())


@pytest.mark.parametrize("kind", ["secrets", "logins"])
def test_absent_stores_remain_valid_empty_then_can_be_created(vault, kind):
    client, directory, _ = vault
    before = list(directory.iterdir())
    response = client.get("/vault/" + kind)
    assert response.status_code == 200
    assert response.json() == ({"keys": []} if kind == "secrets" else {"logins": []})
    assert list(directory.iterdir()) == before
    assert mutation(client, kind).status_code == 200
    assert store_path(kind).exists()


@pytest.mark.parametrize("kind", ["secrets", "logins"])
@pytest.mark.parametrize("damage", ["ciphertext", "json", "shape", "entry"])
def test_unreadable_store_never_becomes_empty_or_gets_replaced(vault, kind, damage):
    client, _, _ = vault
    if damage == "ciphertext":
        blob = b"damaged private-marker ciphertext"
    else:
        invalid = {"json": b"private-marker not JSON", "shape": b"null",
                   "entry": b'[{}]' if kind == "logins" else b'["private-marker"]'}[damage]
        blob = routes._encrypt_for_user("owner", invalid)
    path = store_path(kind)
    path.write_bytes(blob)
    checks = [lambda: client.get("/vault/" + kind), lambda: mutation(client, kind)]
    if kind == "secrets":
        checks.extend([lambda: client.get("/vault/secret/new"), lambda: client.delete("/vault/secret/new")])
    else:
        checks.extend([lambda: client.get("/vault/logins/new"),
                       lambda: client.put("/vault/logins/new", json={"name": "updated"}),
                       lambda: client.delete("/vault/logins/new")])
    for check in checks:
        response = check()
        assert response.status_code == 503
        assert "preserved" in response.text and "private-marker" not in response.text
        assert path.read_bytes() == blob


@pytest.mark.parametrize("kind", ["secrets", "logins"])
def test_permission_denied_store_is_preserved(vault, monkeypatch, kind):
    client, _, _ = vault
    assert mutation(client, kind).status_code == 200
    path = store_path(kind)
    before = path.read_bytes()
    def denied(filename, *args, **kwargs):
        if Path(filename) == path:
            raise PermissionError("private-marker")
        return builtins.open(filename, *args, **kwargs)
    monkeypatch.setattr(routes, "open", denied, raising=False)
    response = mutation(client, kind)
    assert response.status_code == 503 and "private-marker" not in response.text
    assert path.read_bytes() == before


@pytest.mark.parametrize("kind", ["file", "note", "secret", "login"])
@pytest.mark.parametrize("stage", ["flush", "replace"])
def test_failed_replacement_preserves_existing_ciphertext(vault, monkeypatch, kind, stage):
    client, directory, _ = vault
    if kind == "file":
        write = lambda value: client.post("/vault/upload", files={"file": ("keep.txt", value.encode())})
    elif kind == "note":
        write = lambda value: client.post("/vault/note", json={"title": "keep", "content": value})
    elif kind == "secret":
        write = lambda value: client.post("/vault/secret/keep", json={"value": value})
    else:
        initial = client.post("/vault/logins", json=login()).json()["id"]
        write = lambda value: client.put("/vault/logins/" + initial, json={"password": value})
    assert write("original").status_code == 200
    before = {p.name: p.read_bytes() for p in directory.iterdir()}
    def fail(*args, **kwargs):
        raise OSError("private-marker storage failure")
    monkeypatch.setattr(routes.os, "fsync" if stage == "flush" else "replace", fail)
    response = write("replacement")
    assert response.status_code == 503 and "preserved" in response.text
    assert "private-marker" not in response.text
    assert {p.name: p.read_bytes() for p in directory.iterdir()} == before


def test_failed_first_write_leaves_no_partial_file(vault, monkeypatch):
    client, directory, _ = vault
    def fail(*args):
        raise OSError("full disk")
    monkeypatch.setattr(routes.os, "replace", fail)
    response = client.post("/vault/upload", files={"file": ("new.txt", b"new content")})
    assert response.status_code == 503 and not list(directory.iterdir())


@pytest.mark.parametrize("name", ["__secrets_owner", "__secrets_owner.vault", "__logins_owner", "__note_keep", "? __secrets_owner"])
def test_upload_cannot_replace_internal_stores(vault, name):
    client, directory, _ = vault
    assert client.post("/vault/secret/keep", json={"value": "private"}).status_code == 200
    before = {p.name: p.read_bytes() for p in directory.iterdir()}
    response = client.post("/vault/upload", files={"file": (name, b"replacement")})
    assert response.status_code == 400
    assert {p.name: p.read_bytes() for p in directory.iterdir()} == before


@pytest.mark.parametrize("identifier", ["..\\outside", "__note_\\..\\..\\outside", "C:\\outside", "outside:stream", "a/b", "__secrets_owner"])
def test_file_routes_reject_unsafe_and_internal_identifiers(vault, identifier):
    client, directory, root = vault
    sentinel = root / "outside.vault"
    sentinel.write_bytes(b"outside-private-marker")
    for response in (
        client.get("/vault/get_file", params={"file_id": identifier}),
        client.post("/vault/delete_file", json={"file_id": identifier}),
    ):
        assert response.status_code == 400
    assert sentinel.read_bytes() == b"outside-private-marker" and not list(directory.iterdir())


@pytest.mark.parametrize("identifier", ["..\\outside", "__note_\\..\\..\\outside", "C:\\outside", "outside:stream", "a/b"])
def test_note_routes_reject_unsafe_identifiers(vault, identifier):
    client, directory, root = vault
    sentinel = root / "outside.vault"
    sentinel.write_bytes(b"outside-private-marker")
    for response in (client.get("/vault/note/" + quote(identifier, safe="")),
                     client.delete("/vault/note/" + quote(identifier, safe=""))):
        assert response.status_code in (400, 404)
    assert sentinel.read_bytes() == b"outside-private-marker" and not list(directory.iterdir())


def test_legacy_file_and_note_identifiers_and_ciphertext_remain_readable(vault):
    client, directory, root = vault
    # Build the exact pre-refresh nonce+ciphertext format, without invoking writers.
    blob = routes._encrypt_for_user("owner", b"legacy bytes")
    (directory / "legacy_name.vault").write_bytes(blob)
    (directory / "__note_Old_note.vault").write_bytes(blob)
    meta_before = (root / "vault_meta.json").read_bytes()
    assert client.get("/vault/get_file", params={"file_id": "legacy_name"}).content == b"legacy bytes"
    assert client.get("/vault/get_file", params={"file_id": "legacy_name.vault"}).content == b"legacy bytes"
    assert client.get("/vault/note/__note_Old_note").json()["content"] == "legacy bytes"
    assert client.get("/vault/note/Old_note").json()["content"] == "legacy bytes"
    assert (directory / "legacy_name.vault").read_bytes() == blob
    assert (directory / "__note_Old_note.vault").read_bytes() == blob
    assert (root / "vault_meta.json").read_bytes() == meta_before


def test_successful_replacement_remains_readable_by_legacy_aes_reader(vault):
    client, directory, root = vault
    assert client.post("/vault/upload", files={"file": ("same.txt", b"first")}).status_code == 200
    assert client.post("/vault/upload", files={"file": ("same.txt", b"second")}).status_code == 200
    assert client.get("/vault/get_file", params={"file_id": "same_txt"}).content == b"second"
    assert client.post("/vault/note", json={"title": "same note", "content": "first"}).status_code == 200
    assert client.post("/vault/note", json={"title": "same note", "content": "second"}).status_code == 200
    assert client.get("/vault/note/__note_same_note").json()["content"] == "second"
    meta = json.loads((root / "vault_meta.json").read_text())
    legacy_key = hashlib.pbkdf2_hmac("sha256", PASSWORD.encode(), base64.b64decode(meta["encryption_salt"]), 200_000, dklen=32)
    for path in (directory / "same_txt.vault", directory / "__note_same_note.vault"):
        blob = path.read_bytes()
        assert AESGCM(legacy_key).decrypt(blob[:12], blob[12:], None) == b"second"


@pytest.mark.parametrize("stage", ["read", "replace"])
def test_lock_failure_clears_memory_but_reports_unrevoked_saved_session(vault, monkeypatch, stage):
    client, _, root = vault
    path = root / "vault_sessions.json"
    before = path.read_bytes()
    def fail(*args):
        raise OSError("private-marker")
    with monkeypatch.context() as patch:
        patch.setattr(security, "_load_sessions_file", fail) if stage == "read" else patch.setattr(security.os, "replace", fail)
        response = client.post("/vault/lock")
    assert response.status_code == 503 and "Restarting TLI may restore access" in response.text
    assert "private-marker" not in response.text
    assert not security.ENCRYPTION_KEYS and not security.UNLOCKED_VAULTS
    assert path.read_bytes() == before
    assert client.get("/vault/secret/private").status_code == 403
    # An explicit retry removes the persisted owner; a simulated restart cannot reopen it.
    assert client.post("/vault/lock").status_code == 200
    security.load_persisted_sessions()
    assert not security.is_vault_unlocked("owner")


def test_lock_is_owner_scoped_and_durable_across_restart(vault):
    client, _, root = vault
    assert security.unlock("other-owner", PASSWORD)["success"]
    response = client.post("/vault/lock")
    assert response.status_code == 200 and response.json() == {"ok": True}
    assert set(json.loads((root / "vault_sessions.json").read_text())) == {"other-owner"}
    security.ENCRYPTION_KEYS.clear()
    security.UNLOCKED_VAULTS.clear()
    security.load_persisted_sessions()
    assert not security.is_vault_unlocked("owner")
    assert security.is_vault_unlocked("other-owner")


def test_export_scope_remains_a_partial_encrypted_copy(vault):
    client, directory, root = vault
    client.post("/vault/upload", files={"file": ("document.txt", b"plain-file")})
    client.post("/vault/note", json={"title": "private note", "content": "plain-note"})
    client.post("/vault/secret/key", json={"value": "plain-secret"})
    client.post("/vault/logins", json=login())
    before = {p.name: p.read_bytes() for p in directory.iterdir()}
    response = client.get("/vault/export_backup")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert set(archive.namelist()) == {"document_txt.vault", "__note_private_note.vault", "__secrets_owner.vault"}
        assert all(archive.read(name) == before[name] for name in archive.namelist())
    assert {p.name: p.read_bytes() for p in directory.iterdir()} == before
    assert (root / "vault_meta.json").exists()


def test_authentication_still_guards_vault_before_mutation(vault, monkeypatch):
    client, directory, root = vault
    client.app.dependency_overrides.clear()
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    requests = (
        lambda: client.get("/vault/status"),
        lambda: client.get("/vault/list"),
        lambda: client.get("/vault/secrets"),
        lambda: client.get("/vault/export_backup"),
        lambda: client.post("/vault/lock"),
        lambda: client.post("/vault/unlock", json={"password": PASSWORD}),
        lambda: client.post("/vault/secret/new", json={"value": "not saved"}),
        lambda: client.post("/vault/upload", files={"file": ("new.txt", b"not saved")}),
        lambda: client.post("/vault/note", json={"title": "new", "content": "not saved"}),
    )
    assert all(request().status_code == 401 for request in requests)
    assert {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()} == before
    assert not list(directory.iterdir())


def test_tenth_wrong_passphrase_locks_out_for_ten_minutes(vault, monkeypatch):
    client, _, _ = vault
    now = datetime(2026, 9, 7, 12, 0, 0)
    monkeypatch.setattr(security, "_now", lambda: now)
    assert client.post("/vault/lock").status_code == 200
    for count in range(1, 11):
        response = client.post("/vault/unlock", json={"password": "wrong"})
        assert response.status_code == 403
        detail = response.json()["detail"]
        assert detail["failed_attempts"] == count
        assert bool(detail["locked_until"]) is (count == 10)
    locked = client.post("/vault/unlock", json={"password": PASSWORD})
    assert locked.status_code == 403 and locked.json()["detail"]["reason"] == "locked_out"
    assert datetime.fromisoformat(locked.json()["detail"]["locked_until"]) == now + timedelta(minutes=10)
    now += timedelta(minutes=10, seconds=1)
    assert client.post("/vault/unlock", json={"password": PASSWORD}).json()["success"]


def test_fixed_unlock_expiry_does_not_slide_when_contents_are_read(vault, monkeypatch):
    client, _, _ = vault
    now = datetime(2026, 9, 7, 12, 0, 0)
    monkeypatch.setattr(security, "_now", lambda: now)
    response = client.post("/vault/unlock", json={"password": PASSWORD})
    assert datetime.fromisoformat(response.json()["unlocked_until"]) == now + timedelta(minutes=30)
    now += timedelta(minutes=29)
    assert client.get("/vault/secrets").status_code == 200
    now += timedelta(minutes=1)
    assert client.get("/vault/status").json()["unlocked"] is False
    assert client.get("/vault/secrets").status_code == 403
