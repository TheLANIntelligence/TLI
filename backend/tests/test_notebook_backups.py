"""Portable backups use only temporary stores and synthetic archive uploads."""
import base64
from contextlib import contextmanager
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import zipfile

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import tli_state as S
from intelligence import backups, store
from routers import backup_routes
from routers.system_routes import require_session

OWNER = "fixture-owner"
PASSWORD = "Synthetic passphrase 2026"
SECRET = "PRIVATE-NOTE-FOR-BACKUP-7f433a"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    data = tmp_path / "source"
    data.mkdir()
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(data / "conversations.json"))
    monkeypatch.setattr(backups.data_health, "_host", lambda: {"id": "fixture-node", "name": "Sample desktop"})
    monkeypatch.setattr(backups.data_protection, "is_windows", lambda: False)
    monkeypatch.setattr(backups.data_protection, "get_or_create_key", lambda *a: pytest.fail("Backup must not create source keys"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(backups, "_recent_requests", backups.OrderedDict())
    from ai.ai_manager import BundledAIManager
    monkeypatch.setattr(BundledAIManager, "get", lambda: pytest.fail("No backup inference"))


@pytest.fixture
def api():
    app = FastAPI()
    app.include_router(backup_routes.router)
    app.dependency_overrides[require_session] = lambda: OWNER
    with TestClient(app, base_url="https://fixture.invalid") as client:
        yield client


def encrypted(path, value, key_name, aad=None):
    key = b"F" * 32
    (Path(S.DATA_DIR) / key_name).write_bytes(key)
    nonce = b"N" * 12
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"_tli_enc": 1, "data": base64.b64encode(nonce + AESGCM(key).encrypt(nonce, json.dumps(value).encode(), aad)).decode()}))


def seed(owner=OWNER):
    notes = {"facts": [{"id": "saved-note", "text": SECRET, "title": "Spare drive", "category": "general", "deleted": False, "source": "user"},
                       {"id": "deleted-note", "text": "Retained deleted record", "deleted": True}]}
    conversations = {"owned": {"id": "owned", "user_id": owner, "title": "History", "messages": [{"role": "user", "content": "Question"}, {"role": "assistant", "content": "Answer", "document_context": {"provenance": "preserved"}}]},
                     "foreign": {"user_id": "other-person", "messages": [{"role": "user", "content": "FOREIGN-PRIVATE"}]}}
    diagnostics = [{"id": "d-example", "kind": "network", "checks": [{"id": "probe", "status": "passed"}], "created_at": "2026-09-01T00:00:00Z"}]
    encrypted(Path(S.memory_path_for_user(owner)), notes, "memory_key.bin")
    encrypted(Path(S.CONVERSATIONS_FILE), conversations, "conversations_key.bin")
    encrypted(store.private_path(owner, "diagnostics", create=False), diagnostics, "memory_key.bin", f"diagnostics:{owner}".encode())
    # These are deliberate excluded sentinels, never copied into the archive.
    (Path(S.DATA_DIR) / "pin-config.json").write_text("HOST-PIN-EXCLUDED")
    (Path(S.DATA_DIR) / "vault-sentinel").write_text("VAULT-SECRET-EXCLUDED")
    return notes, {"owned": conversations["owned"]}, diagnostics


def snapshots():
    return {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in Path(S.DATA_DIR).rglob("*") if p.is_file()}


def create(api, request_id="create-00000000000001", password=PASSWORD):
    return api.post("/api/intelligence/backups/create", json={"password": password, "request_id": request_id})


def verify(api, blob, request_id="verify-00000000000001", password=PASSWORD):
    return api.post("/api/intelligence/backups/verify", data={"password": password, "request_id": request_id}, files={"file": ("example.tlibackup", blob, "application/octet-stream")})


def test_owner_export_and_uploaded_verification_preserve_originals(api):
    seed()
    before = snapshots()
    response = create(api)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.headers["x-tli-backup-protocol"] == backups.PROTOCOL
    assert response.content.startswith(backups.MAGIC)
    assert SECRET.encode() not in response.content and PASSWORD.encode() not in response.content
    assert "attachment;" in response.headers["content-disposition"]
    checked = verify(api, response.content)
    assert checked.status_code == 200, checked.text
    data = checked.json()
    assert data["archive_integrity"] == "verified" and data["contents_readable"] is True and data["restored_live"] is False
    assert data["counts"] == {"notebook": 2, "conversations": 1, "diagnostics": 1}
    assert data["archive_sha256"] == response.headers["x-tli-backup-sha256"]
    assert data["source"]["owner_id"] == OWNER
    assert "PRIVATE" not in checked.text and PASSWORD not in checked.text
    assert "whole-installation" in str(data["manifest"]["limitations"])
    assert "saved places" in str(data["manifest"]["excluded"])
    assert "storage scan history" in str(data["manifest"]["excluded"])
    assert snapshots() == before
    raw = backups._decrypt(response.content, PASSWORD)
    assert b"FOREIGN-PRIVATE" not in raw and b"HOST-PIN-EXCLUDED" not in raw and b"VAULT-SECRET-EXCLUDED" not in raw


def test_empty_account_archive_has_explicit_zero_counts_and_creates_no_keys(api):
    before = snapshots()
    response = create(api)
    checked = verify(api, response.content).json()
    assert checked["counts"] == {"notebook": 0, "conversations": 0, "diagnostics": 0}
    assert set(checked["source"]["source_formats"].values()) == {"not_created"}
    assert snapshots() == before


def test_portable_roundtrip_uses_current_readers_in_a_separate_test_installation(tmp_path, monkeypatch):
    expected_notes, expected_history, expected_reports = seed()
    before = snapshots()
    blob = backups.create_archive(OWNER, PASSWORD)
    entries = backups._unpack(backups._decrypt(blob, PASSWORD))
    assert snapshots() == before
    # Test-only path overrides demonstrate current-reader compatibility. The
    # production verification endpoint never changes global installation paths.
    isolated_copy = tmp_path / "restored-test-copy"
    isolated_copy.mkdir()
    with monkeypatch.context() as copy:
        copy.setattr(S, "DATA_DIR", str(isolated_copy))
        copy.setattr(S, "CONVERSATIONS_FILE", str(isolated_copy / "conversations.json"))
        Path(S.memory_path_for_user(OWNER)).write_bytes(entries["notebook.json"])
        Path(S.CONVERSATIONS_FILE).write_bytes(entries["conversations.json"])
        encrypted(store.private_path(OWNER, "diagnostics", create=False), json.loads(entries["diagnostics.json"]), "memory_key.bin", f"diagnostics:{OWNER}".encode())
        loaded = S.load_memory(OWNER, strict=True)
        assert [note["text"] for note in loaded["facts"]] == [note["text"] for note in expected_notes["facts"]]
        assert loaded["facts"][1]["deleted"] is True
        assert S.load_conversations() == expected_history
        assert store.read_private(OWNER, "diagnostics", []) == expected_reports
    assert snapshots() == before


def test_legacy_notes_and_local_bundled_history_are_included_without_migration():
    Path(S.memory_path_for_user("local")).write_text(json.dumps({"facts": ["Old preference"], "last_updated": "2025-03-04"}))
    Path(S.CONVERSATIONS_FILE).write_text(json.dumps({"old": {"user_id": "bundled-ai", "messages": []}, "new": {"user_id": "local", "messages": []}, "foreign": {"user_id": OWNER, "messages": []}}))
    before = snapshots()
    blob = backups.create_archive("local", PASSWORD)
    report = backups.verify_archive(blob, PASSWORD)
    assert report["counts"] == {"notebook": 1, "conversations": 2, "diagnostics": 0}
    assert report["source"]["conversation_owner_ids"] == ["bundled-ai", "local"]
    assert snapshots() == before


def test_unopenable_chat_source_rejects_creation_and_saved_data_check_without_writes(api):
    notes, _, _ = seed()
    notes["facts"][0]["chat_source"] = {}
    encrypted(Path(S.memory_path_for_user(OWNER)), notes, "memory_key.bin")
    before = snapshots()
    response = create(api)
    assert response.status_code == 503 and "No partial backup was created" in response.text
    check = backups.data_health.inspect(OWNER)
    assert next(row for row in check["checks"] if row["id"] == "notebook")["status"] == "unavailable"
    with pytest.raises(Exception, match="Notebook"):
        S.load_memory(OWNER, strict=True)
    assert snapshots() == before


def test_checksum_valid_archive_with_unopenable_chat_source_fails_verification(api):
    seed()
    values, counts, created = backups._snapshot(OWNER)
    # This mimics an older archive that passed its looser structure check; its
    # encryption, manifest hashes and ownership are all valid.
    values["notebook.json"]["facts"][0]["chat_source"] = {}
    blob = backups._encrypt(backups._pack(values, counts, created), PASSWORD)
    before = snapshots()
    response = verify(api, blob)
    assert response.status_code == 422 and "saved-data compatibility verification failed" in response.text
    assert snapshots() == before


def test_valid_saved_chat_source_roundtrips_without_changes_or_migration():
    notes, _, _ = seed()
    source = {"conversation_id": "synthetic-chat", "message_index": 1, "revision": "b" * 64,
              "role": "assistant", "created_at": "2026-09-07T00:00:00Z", "provider": "bundled", "model": "fixture"}
    notes["facts"][0]["chat_source"] = source
    encrypted(Path(S.memory_path_for_user(OWNER)), notes, "memory_key.bin")
    before = snapshots()
    blob = backups.create_archive(OWNER, PASSWORD)
    report = backups.verify_archive(blob, PASSWORD)
    assert report["contents_readable"] is True and report["restored_live"] is False
    entries = backups._unpack(backups._decrypt(blob, PASSWORD))
    assert json.loads(entries["notebook.json"])["facts"][0]["chat_source"] == source
    assert S.load_memory(OWNER, strict=True)["facts"][0]["chat_source"] == source
    assert snapshots() == before


@pytest.mark.parametrize("fault", ["missing-key", "wrong-key", "corrupt-key", "corrupt-json", "malformed-note", "malformed-history", "unencrypted-diagnostics"])
def test_unreadable_sources_never_produce_partial_backup(fault, api):
    seed()
    if fault == "missing-key":
        (Path(S.DATA_DIR) / "memory_key.bin").unlink()
    elif fault == "wrong-key":
        (Path(S.DATA_DIR) / "memory_key.bin").write_bytes(b"W" * 32)
    elif fault == "corrupt-key":
        (Path(S.DATA_DIR) / "memory_key.bin").write_bytes(b"wrong")
    elif fault == "corrupt-json":
        Path(S.memory_path_for_user(OWNER)).write_text("broken")
    elif fault == "malformed-note":
        Path(S.memory_path_for_user(OWNER)).write_text('{"facts":[{"text":42}]}')
    elif fault == "malformed-history":
        Path(S.CONVERSATIONS_FILE).write_text(json.dumps({"owned": {"user_id": OWNER, "messages": [{"role": "assistant", "content": []}]}}))
    else:
        store.private_path(OWNER, "diagnostics", create=False).write_text("[]")
    before = snapshots()
    response = create(api)
    assert response.status_code == 503 and SECRET not in response.text and PASSWORD not in response.text
    assert snapshots() == before


def test_source_size_limit_rejects_before_read_or_kdf(api, monkeypatch):
    Path(S.memory_path_for_user(OWNER)).write_bytes(b"x" * 129)
    monkeypatch.setattr(backups, "MAX_SOURCE_BYTES", 128)
    monkeypatch.setattr(backups, "_key", lambda *a: pytest.fail("Oversized source cannot reach KDF"))
    assert create(api).status_code == 413


@pytest.mark.parametrize("password", ["short", " " * 12, "a" * 1025, 123, None])
def test_invalid_password_is_rejected_without_echo(password, api, monkeypatch):
    monkeypatch.setattr(backups, "_snapshot", lambda *a: pytest.fail("No source read for invalid password"))
    response = create(api, password=password)
    assert response.status_code == 422
    assert "input" not in response.text


@pytest.mark.parametrize("fault", ["password", "modified", "truncated", "unsupported"])
def test_corrupt_archive_and_wrong_password_fail_without_live_writes(fault, api):
    seed()
    blob = backups.create_archive(OWNER, PASSWORD)
    before = snapshots()
    if fault == "modified":
        blob = blob[:-1] + bytes([blob[-1] ^ 1])
    elif fault == "truncated":
        blob = blob[:-20]
    elif fault == "unsupported":
        blob = b"Unknown format"
    response = verify(api, blob, password="Wrong passphrase 2026" if fault == "password" else PASSWORD)
    assert response.status_code == 422 and not response.json().get("ok")
    assert snapshots() == before


def malicious_archive(mutate):
    values, counts, created = backups._snapshot(OWNER)
    entries = backups._unpack(backups._pack(values, counts, created))
    entries, compression = mutate(entries), zipfile.ZIP_STORED
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=compression) as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return backups._encrypt(stream.getvalue(), PASSWORD)


@pytest.mark.parametrize("fault", ["traversal", "absolute", "duplicate", "compression", "link", "manifest-hash", "schema", "foreign-owner", "extra-account-secret"])
def test_archive_structure_and_domain_schema_rejection(fault, api, monkeypatch):
    seed()
    def mutate(entries):
        if fault in ("traversal", "absolute"):
            entries["../escape.json" if fault == "traversal" else "C:/escape.json"] = b"bad"
        if fault == "duplicate":
            return [*entries.items(), ("account.json", entries["account.json"])]
        if fault in ("compression", "link"):
            info = zipfile.ZipInfo("notebook.json")
            if fault == "compression":
                info.compress_type = zipfile.ZIP_DEFLATED
            else:
                info.create_system = 3
                info.external_attr = 0o120777 << 16
            return [(info if name == "notebook.json" else name, value) for name, value in entries.items()]
        if fault in ("manifest-hash", "schema", "foreign-owner", "extra-account-secret"):
            name = "conversations.json" if fault == "foreign-owner" else "account.json" if fault == "extra-account-secret" else "notebook.json"
            value = json.loads(entries[name])
            if fault == "foreign-owner":
                value["owned"]["user_id"] = "different-owner"
            elif fault == "extra-account-secret":
                value["password"] = "Not accepted metadata"
            else:
                value["facts"] = "invalid schema"
            entries[name] = backups._json(value)
            if fault != "manifest-hash":
                manifest = json.loads(entries["manifest.json"])
                for row in manifest["entries"]:
                    if row["name"] == name:
                        row.update(bytes=len(entries[name]), sha256=hashlib.sha256(entries[name]).hexdigest())
                entries["manifest.json"] = backups._json(manifest)
        return list(entries.items())
    blob = malicious_archive(mutate)
    before = snapshots()
    response = verify(api, blob)
    assert response.status_code == 422 and "compatibility verification failed" in response.text
    assert snapshots() == before


def test_verification_temp_files_are_encrypted_and_cleaned(tmp_path, monkeypatch):
    seed()
    blob = backups.create_archive(OWNER, PASSWORD)
    before = snapshots()
    directory_paths, disk_bytes = [], []
    original_temp = backups.tempfile.TemporaryDirectory
    original_write = Path.write_bytes
    def temporary(**kwargs):
        handle = original_temp(dir=tmp_path, **kwargs)
        directory_paths.append(Path(handle.name))
        return handle
    def write(path, raw):
        if path.parent in directory_paths:
            disk_bytes.append(raw)
        return original_write(path, raw)
    monkeypatch.setattr(backups.tempfile, "TemporaryDirectory", temporary)
    monkeypatch.setattr(Path, "write_bytes", write)
    assert backups.verify_archive(blob, PASSWORD)["contents_readable"] is True
    assert len(disk_bytes) == 5
    assert all(SECRET.encode() not in raw and PASSWORD.encode() not in raw and b'"facts"' not in raw for raw in disk_bytes)
    assert all(not path.exists() for path in directory_paths)
    assert snapshots() == before


def test_duplicate_and_overlapping_operations_do_not_create_second_archive(api, monkeypatch):
    calls = []
    monkeypatch.setattr(backups, "create_archive", lambda *a: calls.append(1) or b"fixture encrypted bytes")
    assert create(api).status_code == 200
    assert create(api).status_code == 409 and calls == [1]
    with backups.operation():
        assert create(api, request_id="create-00000000000002").status_code == 409
    assert len(calls) == 1
    assert all(not isinstance(value, bytes) for value in backups._recent_requests.values())


def test_request_id_receipts_are_bounded(monkeypatch):
    monkeypatch.setattr(backups, "_MAX_REQUESTS", 3)
    with backups.operation():
        for i in range(5):
            backups.claim_request(OWNER, f"request-{i:016d}")
    assert len(backups._recent_requests) == 3


def test_auth_and_secure_transport_are_required(monkeypatch):
    app = FastAPI()
    app.include_router(backup_routes.router)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    with TestClient(app, base_url="https://fixture.invalid") as client:
        assert create(client).status_code == 401
        assert verify(client, b"encrypted").status_code == 401
    app.dependency_overrides[require_session] = lambda: OWNER
    with TestClient(app, base_url="http://fixture.invalid", client=("192.0.2.10", 5000)) as client:
        assert create(client).status_code == 400
        assert verify(client, b"encrypted").status_code == 400
    monkeypatch.setattr(backups, "create_archive", lambda *a: b"synthetic")
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 5000)) as client:
        assert create(client).status_code == 200


def test_bounded_upload_and_duplicate_form_fields(api, monkeypatch):
    monkeypatch.setattr(backup_routes, "MAX_VERIFY_BODY", 100)
    assert verify(api, b"x" * 101).status_code == 413
    monkeypatch.setattr(backup_routes, "MAX_VERIFY_BODY", 65536)
    response = api.post("/api/intelligence/backups/verify", files=[("password", (None, PASSWORD)), ("password", (None, PASSWORD)), ("request_id", (None, "request-00000000000001")), ("file", ("x.tlibackup", b"x"))])
    assert response.status_code == 422


def test_success_does_not_offer_a_live_restore_endpoint(api):
    assert api.post("/api/intelligence/backups/restore", json={}).status_code == 404


def test_archive_scope_ids_survive_prose_edits_without_inventing_scope():
    def mutate(entries):
        manifest = json.loads(entries["manifest.json"])
        manifest.update(scope="Earlier display title", included=["Earlier display wording"], excluded=["Earlier display wording"], limitations=["Earlier display wording"])
        entries["manifest.json"] = backups._json(manifest)
        return list(entries.items())
    report = backups.verify_archive(malicious_archive(mutate), PASSWORD)
    assert report["manifest"]["included"] == backups.INCLUDED
    assert report["manifest"]["excluded"] == backups.EXCLUDED
    assert report["recovery_scope"] == backups.SCOPE


def test_cancelled_request_keeps_operation_lease_until_worker_finishes(monkeypatch):
    import asyncio
    import threading
    from starlette.requests import Request
    entered, finish = threading.Event(), threading.Event()
    def worker(*args):
        entered.set()
        assert finish.wait(5)
        return b"synthetic encrypted archive"
    monkeypatch.setattr(backups, "create_archive", worker)
    async def exercise():
        async def receive():
            return {"type": "http.request", "body": json.dumps({"password": PASSWORD, "request_id": "cancelled-00000000001"}).encode(), "more_body": False}
        request = Request({"type": "http", "scheme": "https", "server": ("fixture.invalid", 443), "client": ("192.0.2.1", 5000), "headers": [], "method": "POST", "path": "/api/intelligence/backups/create", "query_string": b""}, receive)
        task = asyncio.create_task(backup_routes.create_backup(request, OWNER))
        try:
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(.01)
            assert entered.is_set()
            task.cancel()
            await asyncio.sleep(.05)
            assert not task.done()
            with pytest.raises(HTTPException) as busy:
                with backups.operation():
                    pytest.fail("Cancelled request must retain its worker's lease")
            assert busy.value.status_code == 409
        finally:
            finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        with backups.operation():
            pass
    asyncio.run(exercise())
