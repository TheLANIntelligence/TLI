"""Reviewed separate-copy recovery, entirely synthetic and with no live TLI."""
import base64
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import errno
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import threading

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
import pytest

import data_protection
import tli_state as S
from intelligence import backups, recovery as service

PASSWORD = "Synthetic archive passphrase"
SOURCE_OWNER = "archived-owner"
REQUEST_OWNER = "current-owner"
STAMP = "2025-09-07T00:00:00Z"


def archive(*, source_owner=SOURCE_OWNER, legacy=False, mutate=None):
    source = {"owner_id": source_owner, "conversation_owner_ids": sorted({source_owner, "bundled-ai"} if source_owner == "local" else {source_owner}),
              "exported_at": STAMP, "tli_version": "1.3.5-beta", "source_host": {"id": "source-host", "name": "Source fixture"},
              "source_formats": {"notebook": "legacy_plaintext" if legacy else "encrypted", "conversations": "encrypted", "diagnostics": "encrypted"}}
    notes = {"facts": ["Legacy preference", "Legacy fix"] if legacy else [
        {"id": "note-one", "text": "Synthetic spare SSD in the drawer", "title": "Spare SSD", "created_at": STAMP, "updated_at": STAMP,
         "category": "general", "deleted": False, "source": "user", "chat_source": {"conversation_id": "chat-one", "message_index": 1, "role": "assistant", "revision": "a" * 64}},
        {"id": "note-deleted", "text": "Retained synthetic tombstone", "deleted": True, "created_at": STAMP}], "last_updated": STAMP}
    history = {"chat-one": {"id": "chat-one", "user_id": source_owner, "title": "Synthetic chat", "created_at": STAMP,
                           "messages": [{"role": "user", "content": "Where is the spare SSD?", "timestamp": STAMP},
                                        {"role": "assistant", "content": "In the drawer.", "timestamp": STAMP, "note_context": {"note_ids": ["note-one"]}}]}}
    if source_owner == "local":
        history["legacy-chat"] = {"id": "legacy-chat", "user_id": "bundled-ai", "messages": []}
    reports = [{"id": "report-one", "kind": "system", "created_at": STAMP, "checks": [{"id": "cpu", "status": "passed", "detail": "Synthetic"}], "findings": [], "next_steps": []}]
    values = {"account.json": source, "notebook.json": notes, "conversations.json": history, "diagnostics.json": reports}
    if mutate:
        mutate(values)
    counts = {"notebook": len(values["notebook.json"]["facts"]), "conversations": len(history), "diagnostics": len(reports)}
    return backups._encrypt(backups._pack(values, counts, STAMP), PASSWORD), values


def tree(path):
    return {item.relative_to(path).as_posix(): (item.read_bytes(), item.stat().st_mtime_ns) for item in path.rglob("*") if item.is_file()}


def decrypted(stage):
    keys = {name: data_protection.load_existing_key(stage / "data" / name) for name in ("memory_key.bin", "conversations_key.bin")}
    values = {}
    for kind, relative in zip(("notebook", "conversations", "diagnostics", "origin"), service.STORE_FILES):
        envelope = json.loads((stage / relative).read_bytes())
        assert envelope["_tli_enc"] == 1
        raw = base64.b64decode(envelope["data"])
        key = keys["conversations_key.bin" if kind == "conversations" else "memory_key.bin"]
        aad = f"{'recovery-origin' if kind == 'origin' else kind}:local".encode() if kind in ("diagnostics", "origin") else None
        values[kind] = json.loads(AESGCM(key).decrypt(raw[:12], raw[12:], aad))
    return values


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    live = tmp_path / "live"
    live.mkdir()
    data = live / "data"
    data.mkdir()
    (data / "original.key").write_bytes(b"SOURCE-KEY-DO-NOT-COPY")
    (data / "private.json").write_bytes(b"SOURCE-DATA-DO-NOT-CHANGE")
    parent = tmp_path / "copies"
    parent.mkdir()
    monkeypatch.setattr(S, "BASE_DIR", str(live))
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(service, "_reviews", OrderedDict())
    monkeypatch.setattr(service, "_lock", threading.Lock())
    monkeypatch.setattr(service, "_drive_type", lambda anchor: 3)
    monkeypatch.setattr(data_protection, "is_windows", lambda: False)
    # Unit tests use the real v1 envelope and archive validators, replacing only
    # the costly KDF. Full v1 KDF coverage remains in notebook-backup tests.
    monkeypatch.setattr(backups, "_key", lambda password, salt: hashlib.sha256(password.encode() + salt).digest())
    monkeypatch.setattr(service.shutil, "disk_usage", lambda path: SimpleNamespace(free=1024 ** 3))
    calls = []
    def readback(stage, expected):
        values = decrypted(stage)
        assert {kind: service._digest(value) for kind, value in values.items()} == {kind: expected[kind] for kind in values}
        assert expected["owner"] == "local"
        calls.append((stage, values, expected))
        return {"ok": True, "schema_version": 1, "reader": "current-application", "owner": "local", "counts": expected["counts"],
                "checks": {"encrypted_payloads": True, "current_readers": True, "record_identifiers": True, "stored_metadata": True, "owner_mapping": True, "files_unchanged": True}, "checked_at": STAMP}
    monkeypatch.setattr(service, "_readback", readback)
    return SimpleNamespace(live=live, data=data, parent=parent, target=parent / "recovered", calls=calls, readback=readback)


def review(fixture, blob):
    return service.review_archive(blob, PASSWORD, REQUEST_OWNER, str(fixture.target))


def create(fixture, blob, reviewed):
    return service.create_copy(blob, PASSWORD, REQUEST_OWNER, str(fixture.target), reviewed["review_token"])


def test_review_explains_mapping_scope_expiry_and_creates_no_files(fixture):
    blob, _ = archive()
    before = tree(fixture.live)
    result = review(fixture, blob)
    assert result["scope"] == "separate-data-copy" and result["activated"] is False
    assert result["owner_mapping"] == {"source_owner": SOURCE_OWNER, "target_owner": "local"}
    assert result["archive_sha256"] == hashlib.sha256(blob).hexdigest()
    assert result["destination"] == str(fixture.target)
    assert result["counts"] == {"notebook": 2, "conversations": 1, "diagnostics": 1}
    assert result["required_free_bytes"] > service.SPACE_RESERVE and result["expires_at"] > result["checked_at"]
    assert "no PIN configured" in " ".join(result["limitations"])
    assert not fixture.calls and list(fixture.parent.iterdir()) == [] and tree(fixture.live) == before
    assert PASSWORD not in json.dumps(service._reviews) and "Synthetic spare SSD" not in json.dumps(service._reviews)


@pytest.mark.parametrize("legacy,source_owner", [(False, SOURCE_OWNER), (True, SOURCE_OWNER), (False, "local")])
def test_copy_preserves_metadata_with_new_keys_and_explicit_local_mapping(fixture, legacy, source_owner):
    blob, original = archive(legacy=legacy, source_owner=source_owner)
    before = tree(fixture.live)
    result = create(fixture, blob, review(fixture, blob))
    values = decrypted(fixture.target)
    assert values["notebook"] == original["notebook.json"] and values["diagnostics"] == original["diagnostics.json"]
    expected_history = {key: {**value, "user_id": "local"} for key, value in original["conversations.json"].items()}
    assert values["conversations"] == expected_history
    assert values["origin"]["source"] == original["account.json"]
    assert values["origin"]["conversation_owners"] == {key: value["user_id"] for key, value in original["conversations.json"].items()}
    assert result["readback"]["ok"] is True and result["activated"] is False
    assert json.loads((fixture.target / "recovery-receipt.json").read_bytes()) == result
    assert tree(fixture.live) == before and len(fixture.calls) == 1
    stored = tree(fixture.target)
    assert set(stored) == {*service.STORE_FILES, "recovery-receipt.json"}
    assert all(b"Synthetic spare SSD" not in content and b"SOURCE-KEY" not in content for content, _ in stored.values())
    assert (fixture.target / "data/memory_key.bin").read_bytes() != (fixture.target / "data/conversations_key.bin").read_bytes()
    assert not list(fixture.parent.glob(".tli-recovery-*"))


@pytest.mark.parametrize("bad", ["relative-copy", "", " ../copy", "x" * 1025])
def test_invalid_destination_rejects_without_creating_any_folder(fixture, bad):
    blob, _ = archive()
    with pytest.raises(HTTPException) as exc:
        service.review_archive(blob, PASSWORD, REQUEST_OWNER, bad)
    assert exc.value.status_code == 422 and list(fixture.parent.iterdir()) == []


@pytest.mark.parametrize("where", ["existing-empty", "existing-nonempty", "parent-missing", "inside-active", "active-ancestor", "inside-installation"])
def test_existing_linked_or_overlapping_destinations_are_never_approved(fixture, where):
    blob, _ = archive()
    if where.startswith("existing"):
        fixture.target.mkdir()
        if where == "existing-nonempty":
            (fixture.target / "keep").write_text("keep")
    elif where == "parent-missing":
        fixture.target = fixture.parent / "missing" / "copy"
    elif where == "inside-active":
        fixture.target = fixture.data / "copy"
    elif where == "active-ancestor":
        fixture.target = fixture.live
    else:
        fixture.target = fixture.live / "copy"
    before = tree(fixture.live), tree(fixture.parent)
    with pytest.raises(HTTPException) as exc:
        review(fixture, blob)
    assert exc.value.status_code == 422 and (tree(fixture.live), tree(fixture.parent)) == before


def test_reparse_parent_is_rejected_before_archive_decryption(fixture, monkeypatch):
    original = Path.lstat
    def attributes(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path == fixture.parent:
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400, st_dev=info.st_dev, st_ino=info.st_ino)
        return info
    monkeypatch.setattr(Path, "lstat", attributes)
    monkeypatch.setattr(service, "_archive", lambda *a: pytest.fail("Linked destinations cannot decrypt archives"))
    with pytest.raises(HTTPException) as exc:
        review(fixture, b"unused")
    assert exc.value.status_code == 422 and not fixture.target.exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows drive-type policy")
@pytest.mark.parametrize("drive_type", [0, 1, 4, 5])
def test_mapped_or_unconfirmed_windows_drive_is_not_approved(fixture, monkeypatch, drive_type):
    monkeypatch.setattr(service, "_drive_type", lambda anchor: drive_type)
    monkeypatch.setattr(service, "_archive", lambda *a: pytest.fail("Unsupported drive cannot decrypt private archives"))
    with pytest.raises(HTTPException) as exc:
        review(fixture, b"unused")
    assert exc.value.status_code == 422 and list(fixture.parent.iterdir()) == []


def test_complete_service_reopens_copy_through_real_isolated_application_readers(fixture, monkeypatch):
    from intelligence.recovery_readback import run_readback
    monkeypatch.setattr(service, "_readback", run_readback)
    blob, original = archive()
    before = tree(fixture.live)
    result = create(fixture, blob, review(fixture, blob))
    assert result["readback"]["ok"] is True and all(result["readback"]["checks"].values())
    assert result["readback"]["reader"] == "current-application"
    assert decrypted(fixture.target)["notebook"] == original["notebook.json"]
    assert tree(fixture.live) == before and not list(fixture.parent.glob(".tli-recovery-*"))


@pytest.mark.parametrize("change", ["archive", "owner", "destination", "expired", "parent"])
def test_review_is_bound_to_account_archive_path_parent_and_expiry(fixture, monkeypatch, change):
    blob, _ = archive()
    reviewed = review(fixture, blob)
    owner, destination = REQUEST_OWNER, str(fixture.target)
    if change == "archive": blob += b"changed"
    if change == "owner": owner = "other-owner"
    if change == "destination": destination = str(fixture.parent / "different")
    if change == "expired": service._reviews[reviewed["review_token"]]["expires"] = 0
    if change == "parent":
        fixture.parent.rename(fixture.parent.with_name("original-parent"))
        fixture.parent.mkdir()
    with pytest.raises(HTTPException) as exc:
        service.create_copy(blob, PASSWORD, owner, destination, reviewed["review_token"])
    assert exc.value.status_code == 409 and not fixture.target.exists() and not fixture.calls
    assert reviewed["review_token"] not in service._reviews


def test_review_is_single_use_after_success(fixture):
    blob, _ = archive()
    reviewed = review(fixture, blob)
    create(fixture, blob, reviewed)
    before = tree(fixture.target)
    with pytest.raises(HTTPException) as exc:
        create(fixture, blob, reviewed)
    assert exc.value.status_code == 409 and tree(fixture.target) == before and len(fixture.calls) == 1


@pytest.mark.parametrize("when", ["review", "create"])
@pytest.mark.parametrize("free", [0, None, -1, True])
def test_missing_or_insufficient_free_space_never_stages(fixture, monkeypatch, when, free):
    blob, _ = archive()
    reviewed = review(fixture, blob) if when == "create" else None
    monkeypatch.setattr(service.shutil, "disk_usage", lambda path: SimpleNamespace(free=free))
    with pytest.raises(HTTPException) as exc:
        create(fixture, blob, reviewed) if reviewed else review(fixture, blob)
    assert exc.value.status_code == (507 if free == 0 and type(free) is int else 503)
    assert list(fixture.parent.iterdir()) == [] and not fixture.calls


@pytest.mark.parametrize("fault", ["key", "write", "disk", "readback", "readback-shape", "mutation", "publish"])
def test_failed_copy_never_publishes_or_changes_existing_data(fixture, monkeypatch, fault):
    blob, _ = archive()
    reviewed = review(fixture, blob)
    before = tree(fixture.live)
    def failed(*a, **kw):
        if fault == "disk": raise OSError(errno.ENOSPC, "Synthetic disk full")
        raise RuntimeError("Synthetic failure contains private diagnostic content")
    if fault == "key": monkeypatch.setattr(service, "_new_key", failed)
    if fault in ("write", "disk"): monkeypatch.setattr(service, "_write", failed)
    if fault == "readback": monkeypatch.setattr(service, "_readback", failed)
    if fault == "readback-shape": monkeypatch.setattr(service, "_readback", lambda *a: {"ok": True})
    if fault == "mutation":
        def changed(stage, expected):
            result = fixture.readback(stage, expected)
            (stage / service.STORE_FILES[0]).write_bytes(b"changed after verification")
            return result
        monkeypatch.setattr(service, "_readback", changed)
    if fault == "publish": monkeypatch.setattr(service, "_atomic_publish", failed)
    with pytest.raises(HTTPException) as exc:
        create(fixture, blob, reviewed)
    assert exc.value.status_code == (507 if fault == "disk" else 503)
    assert "private diagnostic content" not in exc.value.detail
    assert tree(fixture.live) == before and list(fixture.parent.iterdir()) == []
    with pytest.raises(HTTPException) as again:
        create(fixture, blob, reviewed)
    assert again.value.status_code == 409


@pytest.mark.parametrize("moment", ["readback", "publish"])
def test_destination_created_after_review_is_preserved_even_if_empty(fixture, monkeypatch, moment):
    blob, _ = archive()
    reviewed = review(fixture, blob)
    if moment == "readback":
        def race(stage, expected):
            result = fixture.readback(stage, expected)
            fixture.target.mkdir()
            (fixture.target / "keep").write_text("External folder must survive")
            return result
        monkeypatch.setattr(service, "_readback", race)
    else:
        publish = service._atomic_publish
        def race(stage, destination, lease):
            fixture.target.mkdir()
            publish(stage, destination, lease)
        monkeypatch.setattr(service, "_atomic_publish", race)
    with pytest.raises(HTTPException) as exc:
        create(fixture, blob, reviewed)
    assert exc.value.status_code == 409 and fixture.target.is_dir()
    assert not (fixture.target / "data").exists()
    if moment == "readback": assert (fixture.target / "keep").read_text() == "External folder must survive"
    assert not list(fixture.parent.glob(".tli-recovery-*"))


def test_simultaneous_create_requests_cannot_publish_twice(fixture, monkeypatch):
    blob, _ = archive()
    reviewed = review(fixture, blob)
    entered, finish = threading.Event(), threading.Event()
    def wait(stage, expected):
        entered.set()
        assert finish.wait(5)
        return fixture.readback(stage, expected)
    monkeypatch.setattr(service, "_readback", wait)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(create, fixture, blob, reviewed)
        try:
            assert entered.wait(5)
            with pytest.raises(HTTPException) as exc:
                create(fixture, blob, reviewed)
            assert exc.value.status_code == 409 and not fixture.target.exists()
        finally:
            finish.set()
        assert pending.result(timeout=5)["ok"] is True
    assert len(fixture.calls) == 1


@pytest.mark.parametrize("fault", ["bad-chat-source", "duplicate-report", "hidden-note", "foreign-owner"])
def test_unreadable_or_foreign_records_are_rejected_during_review(fixture, fault):
    def change(values):
        if fault == "bad-chat-source": values["notebook.json"]["facts"][0]["chat_source"] = {}
        if fault == "duplicate-report": values["diagnostics.json"].append(dict(values["diagnostics.json"][0]))
        if fault == "hidden-note": values["notebook.json"]["facts"][0]["deleted"] = "false"
        if fault == "foreign-owner": values["conversations.json"]["chat-one"]["user_id"] = "not-the-archive-owner"
    blob, _ = archive(mutate=change)
    with pytest.raises(HTTPException) as exc:
        review(fixture, blob)
    assert exc.value.status_code == 422 and not service._reviews and list(fixture.parent.iterdir()) == []


def test_frozen_runtime_is_rejected_during_review_before_decryption_or_writes(fixture, monkeypatch):
    monkeypatch.setattr(service.sys, "frozen", True, raising=False)
    monkeypatch.setattr(service, "_archive", lambda *a: pytest.fail("Unsupported runtime cannot decrypt private archives"))
    with pytest.raises(HTTPException) as exc:
        review(fixture, b"unused")
    assert exc.value.status_code == 409 and "packaged runtime" in exc.value.detail
    assert list(fixture.parent.iterdir()) == []


def test_review_cache_is_bounded_and_contains_no_archive_contents(fixture, monkeypatch):
    blob, _ = archive()
    monkeypatch.setattr(service, "MAX_REVIEWS", 2)
    first = review(fixture, blob)
    second = review(fixture, blob)
    third = review(fixture, blob)
    assert list(service._reviews) == [second["review_token"], third["review_token"]]
    assert first["review_token"] not in service._reviews


@pytest.mark.skipif(os.name != "nt", reason="Windows filename policy")
@pytest.mark.parametrize("character", list('<>:"|?*'))
def test_windows_impossible_leaf_is_rejected_during_review(fixture, monkeypatch, character):
    fixture.target = fixture.parent / ("recovered" + character + "copy")
    monkeypatch.setattr(service, "_archive", lambda *a: pytest.fail("Invalid destinations cannot decrypt an archive"))
    with pytest.raises(HTTPException) as exc:
        review(fixture, b"unused")
    assert exc.value.status_code == 422 and not list(fixture.parent.iterdir())


def test_unicode_review_owner_is_bound_and_can_create_copy(fixture):
    blob, _ = archive()
    reviewed = service.review_archive(blob, PASSWORD, "müller", str(fixture.target))
    result = service.create_copy(blob, PASSWORD, "müller", str(fixture.target), reviewed["review_token"])
    assert result["ok"] is True


@pytest.mark.parametrize("fault", ["missing-check", "false-check", "wrong-schema"])
def test_incomplete_current_reader_proof_cannot_publish(fixture, monkeypatch, fault):
    blob, _ = archive()
    def bad(stage, expected):
        result = fixture.readback(stage, expected)
        if fault == "missing-check": del result["checks"]["current_readers"]
        if fault == "false-check": result["checks"]["files_unchanged"] = False
        if fault == "wrong-schema": result["schema_version"] = 2
        return result
    monkeypatch.setattr(service, "_readback", bad)
    with pytest.raises(HTTPException) as exc:
        create(fixture, blob, review(fixture, blob))
    assert exc.value.status_code == 503 and not list(fixture.parent.iterdir())


def test_injected_existing_key_is_never_adopted_or_overwritten(fixture, monkeypatch):
    blob, _ = archive()
    original = service._stage_files
    captured = []
    def inject(stage, mapped, lease):
        path = stage / "data/memory_key.bin"
        path.write_bytes(b"attacker-selected-key".ljust(32, b"!"))
        captured.append(path.read_bytes())
        try:
            return original(stage, mapped, lease)
        finally:
            assert path.read_bytes() == captured[0]
            assert not (stage / service.STORE_FILES[0]).exists()
    monkeypatch.setattr(service, "_stage_files", inject)
    with pytest.raises(HTTPException):
        create(fixture, blob, review(fixture, blob))
    assert captured and not fixture.target.exists() and not list(fixture.parent.iterdir())


@pytest.mark.skipif(os.name != "nt", reason="Actual Windows handle protection")
@pytest.mark.parametrize("relative", [".", "data", "data/intelligence"])
def test_windows_stage_and_write_parents_cannot_be_replaced_during_writes(fixture, monkeypatch, relative):
    blob, _ = archive()
    outside = fixture.parent / "untouched"
    outside.mkdir()
    original = service._stage_files
    attempted = []
    def swap(stage, mapped, lease):
        source = stage / relative
        renamed = source.with_name(source.name + "-moved")
        with pytest.raises(OSError):
            source.rename(renamed)
        attempted.append(relative)
        assert not renamed.exists()
        return original(stage, mapped, lease)
    monkeypatch.setattr(service, "_stage_files", swap)
    result = create(fixture, blob, review(fixture, blob))
    assert result["ok"] is True and attempted == [relative] and list(outside.iterdir()) == []


def test_stage_replaced_before_lease_is_rejected_before_any_store_write(fixture, monkeypatch):
    blob, _ = archive()
    outside = fixture.parent / "untouched"
    outside.mkdir()
    original = service._StageLease.__enter__
    replaced = []
    def swap(lease):
        moved = lease.stage.with_name(lease.stage.name + "-original")
        lease.stage.rename(moved)
        try:
            lease.stage.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            moved.rename(lease.stage)
            pytest.skip(f"Synthetic directory symlink unavailable: {exc}")
        replaced.append((lease.stage, moved))
        return original(lease)
    monkeypatch.setattr(service._StageLease, "__enter__", swap)
    with pytest.raises(HTTPException) as exc:
        create(fixture, blob, review(fixture, blob))
    assert exc.value.status_code == 503 and not fixture.target.exists()
    assert replaced and list(outside.iterdir()) == []
    assert list(replaced[0][1].iterdir()) == []
    # Only unlink this test's synthetic link. The service must not follow it.
    replaced[0][0].unlink()


@pytest.mark.skipif(os.name != "nt", reason="Windows drive probe")
def test_failed_drive_probe_is_an_explicit_unavailable_result(fixture, monkeypatch):
    def failed(anchor): raise OSError("Synthetic drive probe failure")
    monkeypatch.setattr(service, "_drive_type", failed)
    with pytest.raises(HTTPException) as exc:
        review(fixture, b"unused")
    assert exc.value.status_code == 503 and "could not be confirmed" in exc.value.detail
