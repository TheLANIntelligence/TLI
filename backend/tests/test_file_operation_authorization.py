"""Captured service authority with temporary ordinary files and no host effects."""
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import HTTPException
import pytest

import file_operations as ops
import tli_state as S
from routers import file_routes


class Access:
    revoked = False
    status = 401
    def __call__(self):
        if self.revoked:
            raise HTTPException(self.status, "Original browser session expired")


@pytest.fixture
def files(tmp_path, monkeypatch):
    home = tmp_path / "files"; home.mkdir()
    data = tmp_path / "data"; data.mkdir()
    monkeypatch.setattr(S, "BASE_DIR", str(tmp_path / "install"))
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(S, "VAULT_DIR", str(data / "vault"))
    monkeypatch.setattr(S, "LAST_FILE_OP_PATH", data / "last_file_op.json")
    monkeypatch.setattr(ops, "_plans", {})
    access, calls = Access(), []
    original = ops._exclusive_move
    def move(source, destination, expected, **kwargs):
        assert source.is_relative_to(home) and destination.is_relative_to(home)
        calls.append((source, destination))
        return original(source, destination, expected, **kwargs)
    monkeypatch.setattr(ops, "_exclusive_move", move)
    for name in ("one.txt", "two.txt"):
        (home / name).write_text(name, encoding="utf-8")
    payload = {"path": str(home), "actions": {"Target": ["one.txt", "two.txt"]}}
    def request(*, confirm=False, token=None, check=access, kind="organize", body=payload):
        return ops.request(kind, "owner", body, confirm=confirm, preview_id=token, check=check)
    return SimpleNamespace(home=home, access=access, calls=calls, request=request, payload=payload,
                           record=S.LAST_FILE_OP_PATH)


def denied(operation, status=401):
    with pytest.raises(HTTPException) as caught:
        operation()
    assert caught.value.status_code == status
    assert caught.value.detail == "Original browser session expired"


def unchanged(files):
    assert (files.home / "one.txt").read_text() == "one.txt"
    assert (files.home / "two.txt").read_text() == "two.txt"
    assert not files.calls


def test_initial_denial_precedes_private_record_or_file_reads(files, monkeypatch):
    read = Mock(side_effect=AssertionError("private record must not be read"))
    monkeypatch.setattr(ops, "_load", read)
    files.access.revoked = True
    denied(files.request)
    read.assert_not_called(); unchanged(files)
    assert not files.record.exists() and not ops._plans


@pytest.mark.parametrize("admitted", [False, True])
def test_access_rechecked_after_lock_attempt(files, monkeypatch, admitted):
    original = file_routes.FILE_MUTATION_LOCK
    releases = []
    class Lock:
        def acquire(self, **kwargs):
            if admitted: assert original.acquire(**kwargs)
            files.access.revoked = True
            return admitted
        def release(self): releases.append(True); original.release()
    monkeypatch.setattr(file_routes, "FILE_MUTATION_LOCK", Lock())
    read = Mock(side_effect=AssertionError("private record must not be read"))
    monkeypatch.setattr(ops, "_load", read)
    denied(files.request)
    assert releases == ([True] if admitted else [])
    read.assert_not_called(); unchanged(files)


@pytest.mark.parametrize("boundary", ["_load", "_base", "_inspect", "_destination"])
@pytest.mark.parametrize("failed", [False, True])
def test_revocation_during_private_planning_reads_blocks_further_work(files, monkeypatch, boundary, failed):
    original = getattr(ops, boundary)
    def revoked(*args, **kwargs):
        result = original(*args, **kwargs)
        files.access.revoked = True
        if failed: raise OSError("PRIVATE FILE ERROR")
        return result
    monkeypatch.setattr(ops, boundary, revoked)
    denied(files.request)
    unchanged(files)
    assert not files.record.exists() and not ops._plans


def test_rename_enumeration_rechecks_before_inspecting_next_entry(files, monkeypatch):
    original = os.scandir
    count = []
    class Scan:
        def __enter__(self): self.scan = original(files.home); return self
        def __exit__(self, *args): self.scan.close()
        def __iter__(self):
            for entry in self.scan:
                count.append(entry.name); files.access.revoked = True
                yield entry
    monkeypatch.setattr(ops.os, "scandir", lambda path: Scan())
    denied(lambda: files.request(kind="rename", body={"path": str(files.home), "prefix": "new"}))
    assert len(count) == 1
    unchanged(files)
    assert not files.record.exists()


@pytest.mark.parametrize("status", [401, 403, 503])
def test_denial_during_initial_fsync_does_not_consume_review_or_commit_record(files, monkeypatch, status):
    files.access.status = status
    review = files.request(); original = os.fsync
    def fsync(fd): original(fd); files.access.revoked = True
    with monkeypatch.context() as change:
        change.setattr(ops.security_state.os, "fsync", fsync)
        denied(lambda: files.request(confirm=True, token=review["preview_id"]), status)
    unchanged(files)
    assert not files.record.exists() and not (files.home / "Target").exists()
    saved_plan = ops._plans[review["preview_id"]]
    assert not saved_plan.get("receipt") and not saved_plan.get("interrupted")
    files.access.revoked = False
    assert files.request(confirm=True, token=review["preview_id"])["moved_count"] == 2


@pytest.mark.parametrize("status", [401, 403, 503])
def test_revocation_after_initial_commit_retires_review_without_moving_files(files, monkeypatch, status):
    files.access.status = status
    review = files.request(); original = os.replace; calls = []
    def replace(source, destination):
        result = original(source, destination)
        calls.append(True)
        if len(calls) == 1: files.access.revoked = True
        return result
    monkeypatch.setattr(ops.security_state.os, "replace", replace)
    denied(lambda: files.request(confirm=True, token=review["preview_id"]), status)
    unchanged(files)
    saved = json.loads(files.record.read_bytes())
    assert saved["status"] == "failed" and saved["receipt"]["moved_count"] == 0
    assert all(row["status"] == "not_attempted" for row in saved["results"])
    files.access.revoked = False
    assert files.request(confirm=True, token=review["preview_id"])["moved_count"] == 0
    assert not files.calls


def test_initial_replace_then_raise_is_not_retried_by_same_review(files, monkeypatch):
    review = files.request(); original = os.replace
    def replace(source, destination):
        original(source, destination)
        raise OSError("replacement landed but completion was lost")
    with monkeypatch.context() as change:
        change.setattr(ops.security_state.os, "replace", replace)
        with pytest.raises(HTTPException) as caught:
            files.request(confirm=True, token=review["preview_id"])
        assert caught.value.status_code == 503
    unchanged(files)
    assert json.loads(files.record.read_bytes())["status"] == "running"
    with pytest.raises(HTTPException) as caught:
        files.request(confirm=True, token=review["preview_id"])
    assert caught.value.status_code == 409
    unchanged(files)


def test_revocation_after_destination_mkdir_stops_actual_rename(files, monkeypatch):
    review = files.request(); original = Path.mkdir
    def mkdir(path, *args, **kwargs):
        result = original(path, *args, **kwargs)
        if path == files.home / "Target": files.access.revoked = True
        return result
    monkeypatch.setattr(Path, "mkdir", mkdir)
    denied(lambda: files.request(confirm=True, token=review["preview_id"]))
    assert (files.home / "one.txt").exists() and (files.home / "two.txt").exists()
    assert (files.home / "Target").is_dir()
    saved = json.loads(files.record.read_bytes())
    assert saved["receipt"]["moved_count"] == 0 and saved["results"][0]["status"] == "not_attempted"


@pytest.mark.parametrize("failed_save", [False, True])
@pytest.mark.parametrize("status", [401, 403, 503])
def test_completed_first_move_survives_denial_and_same_token_never_resumes(files, monkeypatch, failed_save, status):
    files.access.status = status
    review = files.request(); original = ops._exclusive_move; save = ops._save
    def move(*args, **kwargs):
        value = original(*args, **kwargs); files.access.revoked = True; return value
    monkeypatch.setattr(ops, "_exclusive_move", move)
    if failed_save:
        def unavailable(value, **kwargs):
            if files.calls: raise OSError("receipt device unavailable")
            return save(value, **kwargs)
        monkeypatch.setattr(ops, "_save", unavailable)
    denied(lambda: files.request(confirm=True, token=review["preview_id"]), status)
    assert len(files.calls) == 1 and (files.home / "Target/one.txt").read_text() == "one.txt"
    assert (files.home / "two.txt").exists()
    retained = ops._plans[review["preview_id"]]["receipt"]
    assert retained["moved_count"] == 1 and retained["status"] == "partial"
    assert [row["status"] for row in retained["results"]] == ["moved", "not_attempted"]
    denied(lambda: files.request(confirm=True, token=review["preview_id"]), status)
    files.access.revoked = False
    assert files.request(confirm=True, token=review["preview_id"]) == retained
    assert len(files.calls) == 1
    ops._plans.clear()
    if failed_save:
        with pytest.raises(HTTPException) as caught:
            files.request(confirm=True, token=review["preview_id"])
        assert caught.value.status_code == 410
    else:
        assert files.request(confirm=True, token=review["preview_id"]) == retained
    assert len(files.calls) == 1


@pytest.mark.parametrize("phase", ["per-file-save", "final-save", "response-format"])
@pytest.mark.parametrize("status", [401, 503])
def test_late_revocation_keeps_completed_identities_and_receipt_without_disclosure(files, monkeypatch, phase, status):
    files.access.status = status
    review = files.request(); original_save = ops._save; original_response = ops._response
    def save(value, **kwargs):
        original_save(value, **kwargs)
        if (phase == "per-file-save" and len(value.get("moves", [])) == 1
                or phase == "final-save" and "receipt" in value):
            files.access.revoked = True
    def response(*args, **kwargs):
        result = original_response(*args, **kwargs)
        if phase == "response-format" and not kwargs["preview"]: files.access.revoked = True
        return result
    monkeypatch.setattr(ops, "_save", save); monkeypatch.setattr(ops, "_response", response)
    denied(lambda: files.request(confirm=True, token=review["preview_id"]), status)
    expected = 1 if phase == "per-file-save" else 2
    record = json.loads(files.record.read_bytes())
    assert len(record["moves"]) == expected and all(row["identity"]["inode"] for row in record["moves"])
    assert record["receipt"]["moved_count"] == expected
    files.access.revoked = False
    assert files.request(confirm=True, token=review["preview_id"])["moved_count"] == expected
    assert len(files.calls) == expected


@pytest.mark.parametrize("status", [401, 403, 503, 409])
def test_completed_all_moves_then_final_receipt_fsync_revoked_keeps_exact_result(files, monkeypatch, status):
    files.access.status = status
    review = files.request(); original = os.fsync; count = 0
    def fsync(fd):
        nonlocal count
        original(fd); count += 1
        if count == 4: files.access.revoked = True
    monkeypatch.setattr(ops.security_state.os, "fsync", fsync)
    denied(lambda: files.request(confirm=True, token=review["preview_id"]), status)
    retained = json.loads(files.record.read_bytes())["receipt"]
    assert retained["status"] == "completed" and retained["ok"] and retained["moved_count"] == 2
    files.access.revoked = False
    assert files.request(confirm=True, token=review["preview_id"]) == retained
    assert len(files.calls) == 2


def test_partial_undo_is_recorded_and_same_review_never_restores_remaining_file(files, monkeypatch):
    files.request(confirm=True)
    payload = {"operation_id": None}
    review = files.request(kind="undo", body=payload)
    original = ops._exclusive_move
    def move(*args, **kwargs):
        value = original(*args, **kwargs); files.access.revoked = True; return value
    monkeypatch.setattr(ops, "_exclusive_move", move)
    denied(lambda: files.request(kind="undo", body=payload, confirm=True, token=review["preview_id"]))
    record = json.loads(files.record.read_bytes())
    assert record["undo_status"] == "partial" and record["undo_receipt"]["undone"] == 1
    assert record["moves"][0]["undo_status"] == "undone"
    assert (files.home / "one.txt").exists() and (files.home / "Target/two.txt").exists()
    files.access.revoked = False
    assert files.request(kind="undo", body=payload, confirm=True, token=review["preview_id"])["undone"] == 1
    assert len(files.calls) == 3


@pytest.mark.parametrize("status", [401, 403, 503])
def test_posix_link_then_revocation_preserves_both_paths_without_unlink(files, monkeypatch, status):
    files.access.status = status
    review = files.request(); original_link = os.link
    def link(source, destination, **kwargs):
        original_link(source, destination, **kwargs); files.access.revoked = True
    proxy = SimpleNamespace(**{**vars(os), "name": "posix", "link": link})
    monkeypatch.setattr(ops, "os", proxy)
    denied(lambda: files.request(confirm=True, token=review["preview_id"]), status)
    source, destination = files.home / "one.txt", files.home / "Target/one.txt"
    assert source.read_text() == destination.read_text() == "one.txt"
    assert source.stat().st_ino == destination.stat().st_ino and source.stat().st_nlink == 2
    record = json.loads(files.record.read_bytes())
    assert record["results"][0]["status"] == "unknown" and record["receipt"]["moved_count"] == 0
    assert not record["moves"] and not record["receipt"]["undo_available"]
    files.access.revoked = False
    assert files.request(confirm=True, token=review["preview_id"])["results"][0]["status"] == "unknown"
    assert source.exists() and destination.exists() and len(files.calls) == 1


def test_cached_receipt_private_copy_is_rechecked_before_disclosure(files, monkeypatch):
    review = files.request(); files.request(confirm=True, token=review["preview_id"])
    original = ops.copy.deepcopy
    def copy(value, *args, **kwargs):
        result = original(value, *args, **kwargs)
        if isinstance(value, dict) and value.get("moved_count") == 2: files.access.revoked = True
        return result
    monkeypatch.setattr(ops.copy, "deepcopy", copy)
    denied(lambda: files.request(confirm=True, token=review["preview_id"]))
    assert len(files.calls) == 2
