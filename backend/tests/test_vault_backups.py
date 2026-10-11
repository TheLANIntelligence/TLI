"""Synthetic portable Vault preservation, crypto and separate-reader checks."""
import hashlib
import io
import json
import os
from pathlib import Path
import threading
import tarfile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
import pytest

import data_protection
import tli_state as S
import vault_security as security
import vault_backup as backup
import vault_backup_recovery as recovery
from routers import vault_routes as routes

PASSWORD = "Synthetic source Vault passphrase"
ARCHIVE_PASSWORD = "Independent archive passphrase"
NEW_PASSWORD = "New destination Vault passphrase"


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "source"
    directory = root / "data" / "vault"
    directory.mkdir(parents=True)
    monkeypatch.setattr(S, "VAULT_DIR", str(directory))
    monkeypatch.setattr(S, "DATA_DIR", str(root / "data"))
    monkeypatch.setattr(S, "BASE_DIR", str(root))
    monkeypatch.setattr(security, "VAULT_META_PATH", str(root / "vault_meta.json"))
    monkeypatch.setattr(security, "_DATA_DIR", str(root / "data"))
    monkeypatch.setattr(security, "UNLOCKED_VAULTS", {})
    monkeypatch.setattr(security, "ENCRYPTION_KEYS", {})
    monkeypatch.setattr(data_protection, "is_windows", lambda: False)
    monkeypatch.setattr(backup.tempfile, "tempdir", str(tmp_path))
    security.setup_password(PASSWORD)
    assert security.unlock("owner", PASSWORD)["success"]
    routes._write_vault_file("owner", "Manual", b"Synthetic private file\x00\xff")
    routes.vault_write_note(routes.VaultNoteWriteRequest(title="Past fix", content="Keep literal café\n新しい"), "owner")
    routes.save_vault_secrets("owner", {"api": "synthetic-secret"})
    routes.save_vault_logins("owner", [{"id": "login-preserved", "name": "Router", "domain": "router.invalid",
        "username": "person", "password": "synthetic-login", "notes": "extra metadata preserved", "updated_at": "2025-01-01"}])
    (directory / "__secrets_someone_else.vault").write_bytes(b"not ours and deliberately unreadable")
    before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    yield root, directory, before
    assert {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()} == before


def make(vault):
    path, result = backup.create_archive("owner", ARCHIVE_PASSWORD)
    raw = path.read_bytes()
    path.unlink()
    return raw, result


def test_complete_archive_is_portable_and_source_unchanged(vault):
    raw, result = make(vault)
    assert result["counts"] == {"file": 1, "note": 1, "secrets": 1, "logins": 1}
    assert b"synthetic-secret" not in raw and b"Manual" not in raw
    verified = backup.verify_archive(io.BytesIO(raw), ARCHIVE_PASSWORD)
    assert verified["checks"] == dict.fromkeys(("archive_authenticated", "all_entries_readable", "entry_hashes"), True)
    assert verified["restored"] is False


def test_recovery_new_passphrase_current_readers_and_no_activation(vault, tmp_path):
    raw, _ = make(vault)
    target = tmp_path / "recovered"
    reviewed = recovery.review(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target))
    assert not target.exists()
    result = recovery.create(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target), reviewed["review_token"], NEW_PASSWORD)
    assert result["created"] is True and result["restored"] is False
    assert result["readback"]["checks"]["current_readers"] is True
    assert (target / "data/vault/__logins_local.vault").exists()
    assert not (target / "data/vault/__secrets_someone_else.vault").exists()
    assert not (target / "data/vault_sessions.json").exists()
    assert not (target / "data/tli_pin.json").exists()
    assert not (target / "data/node_identity.json").exists()
    metadata = json.loads((target / "vault_meta.json").read_bytes())
    assert metadata["encryption_salt"] != json.loads((vault[0] / "vault_meta.json").read_bytes())["encryption_salt"]


@pytest.mark.parametrize("damage", ["password", "header", "body", "tag", "truncated", "extended"])
def test_authentication_failure_never_parses_or_writes(vault, monkeypatch, damage):
    raw, _ = make(vault)
    password = ARCHIVE_PASSWORD
    if damage == "password":
        password = "different archive passphrase"
    elif damage == "truncated":
        raw = raw[:-17]
    elif damage == "extended":
        raw += b"extra"
    else:
        index = {"header": len(backup.MAGIC) + 1, "body": 70, "tag": -1}[damage]
        data = bytearray(raw)
        data[index] ^= 1
        raw = bytes(data)
    monkeypatch.setattr(backup.tarfile, "open", lambda *a, **kw: pytest.fail("Unauthenticated archive was parsed"))
    with pytest.raises(HTTPException) as error:
        backup.verify_archive(io.BytesIO(raw), password)
    assert error.value.status_code == 422


def test_unknown_internal_store_cannot_be_silently_omitted(vault):
    path = vault[1] / "__future_data.vault"
    path.write_bytes(b"unhandled")
    try:
        with pytest.raises(HTTPException):
            backup.create_archive("owner", ARCHIVE_PASSWORD)
    finally:
        path.unlink()


def test_destination_exists_and_review_owner_are_protected(vault, tmp_path):
    raw, _ = make(vault)
    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(HTTPException):
        recovery.review(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(existing))
    target = tmp_path / "new-copy"
    reviewed = recovery.review(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target))
    with pytest.raises(HTTPException) as error:
        recovery.create(io.BytesIO(raw), ARCHIVE_PASSWORD, "different-owner", str(target), reviewed["review_token"], NEW_PASSWORD)
    assert error.value.status_code == 409 and not target.exists()


def test_frozen_recovery_refuses_before_archive_or_destination(vault, monkeypatch, tmp_path):
    import vault_backup_readback as readback
    monkeypatch.setattr(readback.sys, "frozen", True, raising=False)
    monkeypatch.setattr(backup, "scan_archive", lambda *a: pytest.fail("No decode in unsupported runtime"))
    with pytest.raises(HTTPException) as error:
        recovery.review(io.BytesIO(b"x"), ARCHIVE_PASSWORD, "owner", str(tmp_path / "never-created"))
    assert error.value.status_code == 409


def authenticated_tar(manifest, payloads=(), mutate=None):
    output = io.BytesIO()
    with tarfile.open(mode="w", fileobj=output, format=tarfile.USTAR_FORMAT) as tar:
        raw = backup.json_bytes(manifest)
        tar.addfile(backup._tar_info("manifest.json", len(raw)), io.BytesIO(raw))
        for index, raw in enumerate(payloads):
            tar.addfile(backup._tar_info(f"payload/{index:05d}", len(raw)), io.BytesIO(raw))
    plaintext = output.getvalue()
    if mutate:
        plaintext = mutate(plaintext)
    salt, nonce = os.urandom(16), os.urandom(12)
    header = backup.MAGIC + salt + nonce
    return header + AESGCM(backup._key(ARCHIVE_PASSWORD, salt)).encrypt(nonce, plaintext, header)


def manifest_for(raw=b"exact", **changes):
    entry = {"kind": "file", "name": "Example.vault", "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "records": 1}
    entry.update(changes)
    return {"protocol": backup.PROTOCOL, "created_at": backup.iso(), "source_owner": "owner", "scope": backup.SCOPE,
            "entries": [entry], "total_bytes": len(raw)}


@pytest.mark.parametrize("changes", [{"name": "../outside.vault"}, {"name": "__secrets_other.vault"}, {"size": -1},
    {"size": True}, {"size": 250 * 1024 * 1024 + 1}, {"kind": "future"}, {"name": "CON.vault"}, {"sha256": "0" * 64}, {"records": 2}])
def test_authenticated_but_unsupported_entries_rejected(changes):
    raw = authenticated_tar(manifest_for(**changes), [b"exact"])
    with pytest.raises(HTTPException) as error:
        backup.verify_archive(io.BytesIO(raw), ARCHIVE_PASSWORD)
    assert error.value.status_code == 422


@pytest.mark.parametrize("kind", [tarfile.GNUTYPE_LONGNAME, tarfile.XHDTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.GNUTYPE_SPARSE])
def test_authenticated_tar_extensions_rejected_before_large_length_read(kind, monkeypatch):
    def change(raw):
        header = tarfile.TarInfo("manifest.json")
        header.type, header.size = kind, 999999999999
        return header.tobuf(format=tarfile.GNU_FORMAT) + raw[512:]
    raw = authenticated_tar(manifest_for(), [b"exact"], change)
    with pytest.raises(HTTPException):
        backup.verify_archive(io.BytesIO(raw), ARCHIVE_PASSWORD)


def test_case_collisions_and_duplicate_store_ids_are_rejected():
    manifest = manifest_for()
    manifest["entries"].append({**manifest["entries"][0], "name": "example.vault"})
    manifest["total_bytes"] = 10
    with pytest.raises(ValueError):
        backup.validate_manifest(manifest)
    duplicate = [{"id": "same", "name": "n", "domain": "d", "username": "u", "password": "p"}] * 2
    with pytest.raises(ValueError):
        backup.validate_plain("logins", [backup.json_bytes(duplicate)])
    with pytest.raises(ValueError):
        backup.validate_plain("secrets", [b'{"key": "first", "key": "second"}'])
    with pytest.raises(ValueError):
        backup.validate_plain("secrets", [b'{"key": 123}'])
    with pytest.raises(UnicodeError):
        backup.validate_plain("note", [b"invalid\xff"])


def test_explicit_source_check_writes_no_archive_and_reports_exact_scope(vault, tmp_path):
    before = set(tmp_path.iterdir())
    result = backup.check_source("owner")
    assert result["checked"] is True and result["archive_created"] is False and result["source_unchanged"] is True
    assert result["counts"]["logins"] == 1
    assert "archive_authenticated" not in result["checks"]
    assert set(tmp_path.iterdir()) == before


def test_source_check_busy_blocks_write_but_lock_remains_possible(vault):
    acquired, release = threading.Event(), threading.Event()
    def hold():
        with security.content_transaction():
            acquired.set()
            release.wait(5)
    worker = threading.Thread(target=hold)
    worker.start()
    assert acquired.wait(2)
    try:
        with pytest.raises(HTTPException) as error:
            routes._delete_vault_file("owner", "Manual")
        assert error.value.status_code == 409
    finally:
        release.set()
        worker.join(2)


def test_low_temporary_disk_and_source_limits_leave_no_artifact(vault, monkeypatch, tmp_path):
    from collections import namedtuple
    usage = namedtuple("usage", "total used free")
    before = set(tmp_path.iterdir())
    monkeypatch.setattr(backup.shutil, "disk_usage", lambda path: usage(100, 100, 0))
    with pytest.raises(HTTPException) as error:
        backup.create_archive("owner", ARCHIVE_PASSWORD)
    assert error.value.status_code == 507
    assert set(tmp_path.iterdir()) == before


@pytest.mark.parametrize("limit,value", [("MAX_TOTAL", 1), ("MAX_FILE", 1), ("MAX_ENTRIES", 3)])
def test_declared_source_limits_fail_without_partial_backup(vault, monkeypatch, tmp_path, limit, value):
    before = set(tmp_path.iterdir())
    monkeypatch.setattr(backup, limit, value)
    with pytest.raises(HTTPException):
        backup.create_archive("owner", ARCHIVE_PASSWORD)
    assert set(tmp_path.iterdir()) == before


def test_input_decryption_uses_bounded_reads():
    data = b"0123456789" * (backup.CHUNK // 2)
    raw = authenticated_tar(manifest_for(data), [data])
    class Bounded(io.BytesIO):
        def read(self, size=-1):
            assert 0 <= size <= backup.CHUNK
            return super().read(size)
    result = backup.verify_archive(Bounded(raw), ARCHIVE_PASSWORD)
    assert result["total_bytes"] == len(data)


@pytest.mark.parametrize("failure", ["reader", "authorization", "destination_appears"])
def test_failed_recovery_never_publishes_or_overwrites(vault, tmp_path, monkeypatch, failure):
    raw, _ = make(vault)
    target = tmp_path / "rejected-copy"
    reviewed = recovery.review(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target))
    if failure == "reader":
        import vault_backup_readback
        monkeypatch.setattr(vault_backup_readback, "run_readback", lambda *a: {"ok": False})
    elif failure == "destination_appears":
        target.mkdir()
        (target / "keep.txt").write_text("original")
    calls = []
    def authorize():
        calls.append(True)
        if failure == "authorization" and len(calls) > 1:
            raise HTTPException(401, "expired")
    with pytest.raises(HTTPException):
        recovery.create(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target), reviewed["review_token"], NEW_PASSWORD, authorize)
    if failure == "destination_appears":
        assert (target / "keep.txt").read_text() == "original"
    else:
        assert not target.exists()
    assert not list(tmp_path.glob(".tli-recovery-*"))


def test_recovery_rejects_replaced_parent_and_consumed_review(vault, tmp_path):
    raw, _ = make(vault)
    parent = tmp_path / "parent"
    parent.mkdir()
    target = parent / "new-copy"
    reviewed = recovery.review(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target))
    parent.rename(tmp_path / "old-parent")
    parent.mkdir()
    for _ in range(2):
        with pytest.raises(HTTPException) as error:
            recovery.create(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target), reviewed["review_token"], NEW_PASSWORD)
        assert error.value.status_code == 409
    assert not target.exists()


def test_lock_during_final_validation_discards_archive(vault, monkeypatch, tmp_path):
    verify = backup.verify_archive
    def lock_after_verification(*args, **kwargs):
        result = verify(*args, **kwargs)
        security.UNLOCKED_VAULTS.clear()
        return result
    monkeypatch.setattr(backup, "verify_archive", lock_after_verification)
    with pytest.raises(HTTPException) as error:
        backup.create_archive("owner", ARCHIVE_PASSWORD)
    assert error.value.status_code == 403
    assert not list(tmp_path.glob("tli-vault-backup-*.encrypted"))


def test_unreadable_source_prevents_check_and_complete_archive(vault):
    path = vault[1] / "Manual.vault"
    original = path.read_bytes()
    path.write_bytes(b"unreadable ciphertext" * 3)
    try:
        for action in (lambda: backup.check_source("owner"), lambda: backup.create_archive("owner", ARCHIVE_PASSWORD)):
            with pytest.raises(HTTPException) as error:
                action()
            assert error.value.status_code == 422
    finally:
        path.write_bytes(original)


@pytest.mark.parametrize("hardlink", [False, True])
def test_existing_staging_file_is_never_adopted_or_overwritten(vault, tmp_path, monkeypatch, hardlink):
    raw, _ = make(vault)
    target = tmp_path / "injection-rejected"
    outside = tmp_path / "unrelated-private-file"
    outside.write_bytes(b"keep-exact")
    reviewed = recovery.review(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target))
    pin = recovery.StageLease._pin
    def inject(lease, relative):
        pin(lease, relative)
        if relative == "data/vault":
            existing = lease.stage / "data/vault/Manual.vault"
            if hardlink:
                os.link(outside, existing)
            else:
                existing.write_bytes(b"do-not-adopt")
    monkeypatch.setattr(recovery.StageLease, "_pin", inject)
    with pytest.raises(HTTPException):
        recovery.create(io.BytesIO(raw), ARCHIVE_PASSWORD, "owner", str(target), reviewed["review_token"], NEW_PASSWORD)
    assert not target.exists() and outside.read_bytes() == b"keep-exact"
    assert not list(tmp_path.glob(".tli-recovery-*"))


def test_duplicate_submissions_fail_before_a_second_source_read(vault):
    with backup.operation():
        backup.claim("owner", "duplicate_request_identifier")
        with pytest.raises(HTTPException) as error:
            backup.claim("owner", "duplicate_request_identifier")
        assert error.value.status_code == 409


def test_valid_but_swapped_source_ciphertext_is_not_a_matching_snapshot():
    key, nonce = os.urandom(32), os.urandom(12)
    original = nonce + AESGCM(key).encrypt(nonce, b"original record", None)
    other_nonce = os.urandom(12)
    swapped = other_nonce + AESGCM(key).encrypt(other_nonce, b"other account data", None)
    reader = backup.DecryptedReader(io.BytesIO(swapped), key, expected_digest=hashlib.sha256(original).hexdigest())
    with pytest.raises(ValueError, match="source bytes changed"):
        backup.validate_plain("file", backup._chunks(reader))


@pytest.mark.parametrize("action", ["create", "check"])
def test_lock_at_end_of_final_source_hash_never_returns_success(vault, monkeypatch, tmp_path, action):
    unchanged = backup._unchanged
    def revoke_after_hash(*args):
        unchanged(*args)
        security.UNLOCKED_VAULTS.clear()
    monkeypatch.setattr(backup, "_unchanged", revoke_after_hash)
    with pytest.raises(HTTPException) as error:
        if action == "create":
            backup.create_archive("owner", ARCHIVE_PASSWORD)
        else:
            backup.check_source("owner")
    assert error.value.status_code == 403
    assert not list(tmp_path.glob("tli-vault-backup-*.encrypted"))
