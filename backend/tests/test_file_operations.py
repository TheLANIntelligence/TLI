from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import threading
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import file_operations as ops
import tli_state as S
from routers import file_routes


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    home = tmp_path / "files"; home.mkdir()
    data = tmp_path / "data"; data.mkdir()
    monkeypatch.setattr(S, "BASE_DIR", str(tmp_path / "install"))
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(S, "VAULT_DIR", str(data / "vault"))
    monkeypatch.setattr(S, "LAST_FILE_OP_PATH", data / "last_file_op.json")
    monkeypatch.setattr(ops, "_plans", {})
    calls = []
    original = ops._exclusive_move
    def move(source, destination, expected):
        assert source.is_relative_to(home) and destination.is_relative_to(home)
        calls.append((source, destination))
        return original(source, destination, expected)
    monkeypatch.setattr(ops, "_exclusive_move", move)
    return home, calls


def write(home, name, content="original"):
    path = home / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content)
    return path


def organize(home, actions, confirm=False, token=None, user="alice"):
    return ops.request("organize", user, {"path": str(home), "actions": actions}, confirm=confirm, preview_id=token)


def undo(confirm=False, token=None, ident=None):
    return ops.request("undo", "alice", {"operation_id": ident}, confirm=confirm, preview_id=token)


def test_preview_exact_files_move_once_and_identity_bound_undo(isolated):
    home, calls = isolated
    write(home, "one.txt"); write(home, "two.txt")
    review = organize(home, {"Documents": ["one.txt", "two.txt"]})
    assert review["can_execute"] and not calls and not S.LAST_FILE_OP_PATH.exists()
    assert not (home / "Documents").exists()
    result = organize(home, {"Documents": ["one.txt", "two.txt"]}, True, review["preview_id"])
    assert result["ok"] and result["moved_count"] == 2 and result["undo_available"]
    assert organize(home, {"Documents": ["one.txt", "two.txt"]}, True, review["preview_id"]) == result
    assert len(calls) == 2
    saved = json.loads(S.LAST_FILE_OP_PATH.read_text())
    assert saved["moves"][0]["identity"]["inode"]
    restore = undo()
    assert restore["can_execute"] and len(calls) == 2
    response = undo(True, restore["preview_id"])
    assert response["ok"] and response["undone"] == 2
    assert (home / "one.txt").read_text() == "original"
    assert undo(True, restore["preview_id"]) == response and len(calls) == 4
    assert undo(True)["status"] == "no_op" and len(calls) == 4


@pytest.mark.parametrize("bad", ["missing", "collision", "duplicate", "directory", "protected", "linked", "hardlink"])
def test_later_bad_file_rejects_whole_plan_without_any_writes(isolated, monkeypatch, bad):
    home, calls = isolated
    write(home, "good.txt"); other = write(home, "bad.txt")
    names = ["good.txt", "bad.txt"]
    if bad == "missing": other.unlink()
    elif bad == "collision": write(home, "Target/bad.txt", "unrelated")
    elif bad == "duplicate": names = ["good.txt", "good.txt"]
    elif bad == "directory": other.unlink(); other.mkdir()
    elif bad == "protected": monkeypatch.setattr(S, "is_protected_system_path", lambda p: p.name == "bad.txt")
    elif bad == "linked":
        original = Path.lstat
        monkeypatch.setattr(Path, "lstat", lambda p: SimpleNamespace(st_mode=0, st_file_attributes=0x400) if p == other else original(p))
    elif bad == "hardlink": os.link(other, home / "second-link.txt")
    result = organize(home, {"Target": names}, True)
    assert not result["ok"] and result["status"] == "rejected" and not calls
    assert not S.LAST_FILE_OP_PATH.exists() and (home / "good.txt").exists()
    if bad != "collision": assert not (home / "Target").exists()


@pytest.mark.parametrize("destination", ["../escape", "/absolute", "C:\\escape", "a/../b", "x:stream", "CON", "trailing.", ""])
def test_invalid_destination_is_rejected_before_writes(isolated, destination):
    home, calls = isolated; write(home, "file.txt")
    with pytest.raises(HTTPException) as error:
        organize(home, {destination: ["file.txt"]}, True)
    assert error.value.status_code == 400 and not calls and not S.LAST_FILE_OP_PATH.exists()


@pytest.mark.parametrize("name", ["../file.txt", "sub/file.txt", "sub\\file.txt", "file.txt:stream"])
def test_source_names_are_not_silently_rewritten_to_basenames(isolated, name):
    home, calls = isolated; write(home, "file.txt")
    with pytest.raises(HTTPException): organize(home, {"Target": [name]}, True)
    assert not calls


def test_file_changed_after_review_requires_new_review(isolated):
    home, calls = isolated; write(home, "one.txt"); write(home, "two.txt")
    actions = {"Target": ["one.txt", "two.txt"]}
    preview = organize(home, actions)
    write(home, "two.txt", "changed externally")
    result = organize(home, actions, True, preview["preview_id"])
    assert not result["ok"] and not calls and not S.LAST_FILE_OP_PATH.exists()


def test_preview_is_owner_bound_payload_bound_and_expiring(isolated, monkeypatch):
    home, calls = isolated; write(home, "file.txt")
    review = organize(home, {"Target": ["file.txt"]})
    with pytest.raises(HTTPException): organize(home, {"Target": ["file.txt"]}, True, review["preview_id"], "bob")
    with pytest.raises(HTTPException): organize(home, {"Other": ["file.txt"]}, True, review["preview_id"])
    monkeypatch.setattr(ops.time, "time", lambda: review["expires_at"] + 1)
    with pytest.raises(HTTPException): organize(home, {"Target": ["file.txt"]}, True, review["preview_id"])
    assert not calls


def test_rename_has_exact_preview_and_collision_blocks_all(isolated):
    home, calls = isolated; write(home, "a.txt"); write(home, "b.png")
    payload = {"path": str(home), "prefix": "photo"}
    preview = ops.request("rename", "alice", payload, confirm=False)
    assert preview["can_execute"] and [Path(r["destination"]).name for r in preview["items"]] == ["photo_1.txt", "photo_2.png"]
    result = ops.request("rename", "alice", payload, confirm=True, preview_id=preview["preview_id"])
    assert result["ok"] and result["count"] == 2 and len(result["renamed"]) == 2
    assert undo(True)["undone"] == 2
    write(home, "photo_1.txt", "unrelated")
    assert not ops.request("rename", "alice", payload, confirm=True)["ok"]
    assert len(calls) == 4 and (home / "photo_1.txt").read_text() == "unrelated"


def test_empty_folder_after_rename_review_is_rejected_not_called_success(isolated):
    home, calls = isolated; file = write(home, "a.txt")
    payload = {"path": str(home), "prefix": "new"}
    review = ops.request("rename", "alice", payload, confirm=False); file.unlink()
    response = ops.request("rename", "alice", payload, confirm=True, preview_id=review["preview_id"])
    assert response["status"] == "rejected" and not response["ok"] and not calls


def test_runtime_failure_keeps_truthful_partial_receipt_and_undo(isolated, monkeypatch):
    home, calls = isolated
    for name in ("one", "two", "three"): write(home, name)
    original = ops._exclusive_move
    def move(source, destination, identity):
        if source.name == "two": raise PermissionError("File is in use")
        return original(source, destination, identity)
    monkeypatch.setattr(ops, "_exclusive_move", move)
    result = organize(home, {"Target": ["one", "two", "three"]}, True)
    assert result["status"] == "partial" and not result["ok"] and result["moved_count"] == 1
    assert [r["status"] for r in result["results"]] == ["moved", "failed", "not_attempted"]
    assert undo(True)["undone"] == 1 and (home / "two").exists()


@pytest.mark.parametrize("replacement", ["original_path", "moved_file"])
def test_undo_never_overwrites_replacement_or_moves_changed_file(isolated, replacement):
    home, calls = isolated; write(home, "file.txt")
    organize(home, {"Target": ["file.txt"]}, True)
    changed = home / "file.txt" if replacement == "original_path" else home / "Target/file.txt"
    changed.write_text("unrelated replacement")
    before = S.LAST_FILE_OP_PATH.read_bytes()
    response = undo(True)
    assert not response["ok"] and response["undone"] == 0 and len(calls) == 1
    assert changed.read_text() == "unrelated replacement" and S.LAST_FILE_OP_PATH.read_bytes() == before


def test_partial_undo_retains_unresolved_entries_for_explicit_retry(isolated, monkeypatch):
    home, calls = isolated; write(home, "one"); write(home, "two")
    organize(home, {"Target": ["one", "two"]}, True)
    original = ops._exclusive_move
    def move(source, destination, identity):
        if source.name == "two": raise PermissionError("Busy")
        return original(source, destination, identity)
    monkeypatch.setattr(ops, "_exclusive_move", move)
    result = undo(True)
    assert result["status"] == "partial" and result["undone"] == 1
    saved = json.loads(S.LAST_FILE_OP_PATH.read_text())
    assert [item["undo_status"] for item in saved["moves"]] == ["undone", "unresolved"]
    monkeypatch.setattr(ops, "_exclusive_move", original)
    assert undo(True)["undone"] == 1 and len(calls) == 4


def test_new_operation_retains_previous_unresolved_undo(isolated):
    home, _ = isolated; write(home, "one"); write(home, "two")
    first = organize(home, {"Target": ["one"]}, True)
    second = organize(home, {"Target": ["two"]}, True)
    history = undo()["history"]
    assert [r["id"] for r in history] == [second["operation_id"], first["operation_id"]]
    assert undo(True, ident=first["operation_id"])["undone"] == 1
    assert (home / "one").exists() and (home / "Target/two").exists()


def test_legacy_undo_is_readable_but_never_guesses_identity(isolated):
    home, calls = isolated; moved = write(home, "Target/one")
    legacy = {"type": "organize", "moves": [{"src": str(home / "one"), "dst": str(moved)}], "renames": []}
    S.LAST_FILE_OP_PATH.write_text(json.dumps(legacy)); before = S.LAST_FILE_OP_PATH.read_bytes()
    result = undo(True)
    assert not result["ok"] and result["undone"] == 0 and not calls
    assert "identity" in result["results"][0]["reason"] and S.LAST_FILE_OP_PATH.read_bytes() == before


@pytest.mark.parametrize("failure", ["corrupt", "unwritable"])
def test_recovery_record_failure_prevents_first_filesystem_change(isolated, monkeypatch, failure):
    home, calls = isolated; write(home, "file")
    if failure == "corrupt": S.LAST_FILE_OP_PATH.write_text("{broken")
    else: monkeypatch.setattr(ops, "_save", lambda record: (_ for _ in ()).throw(OSError("Disk full")))
    with pytest.raises(Exception): organize(home, {"Target": ["file"]}, True)
    assert not calls and not (home / "Target").exists() and (home / "file").exists()
    if failure == "corrupt": assert S.LAST_FILE_OP_PATH.read_text() == "{broken"


def test_shared_lock_refuses_competing_operations(isolated, monkeypatch):
    home, calls = isolated; write(home, "one"); write(home, "two")
    entered, release = threading.Event(), threading.Event()
    original = ops._exclusive_move
    def move(*args):
        entered.set(); assert release.wait(4); return original(*args)
    monkeypatch.setattr(ops, "_exclusive_move", move)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(organize, home, {"Target": ["one"]}, True)
        assert entered.wait(3)
        try:
            with pytest.raises(HTTPException) as error: organize(home, {"Target": ["two"]}, True)
            assert error.value.status_code == 409
        finally: release.set()
        assert first.result()["ok"]
    assert len(calls) == 1


def test_destination_created_after_preflight_is_preserved(isolated, monkeypatch):
    home, calls = isolated; write(home, "one")
    original = ops._exclusive_move
    def race(source, destination, identity):
        write(home, "Target/one", "raced unrelated file")
        return original(source, destination, identity)
    monkeypatch.setattr(ops, "_exclusive_move", race)
    response = organize(home, {"Target": ["one"]}, True)
    assert not response["ok"] and (home / "one").read_text() == "original"
    assert (home / "Target/one").read_text() == "raced unrelated file"


def test_existing_api_fields_and_authenticated_undo(authed_client, client, isolated, monkeypatch):
    home, _ = isolated; write(home, "one.txt")
    capability = authed_client.get("/file/operations/capabilities")
    assert capability.json() == {"ok": True, "protocol": "reviewed-file-operations-v1"}
    assert capability.headers["Cache-Control"] == "no-store"
    response = authed_client.post("/file/rename", json={"path": str(home), "prefix": "legacy"})
    assert response.status_code == 200 and response.json()["count"] == 1
    from main import app
    from routers.system_routes import require_session
    from unittest.mock import patch
    with patch.dict(app.dependency_overrides, {}, clear=True):
        monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
        assert client.post("/file/undo").status_code == 401
        assert client.get("/file/operations/capabilities").status_code == 401
    result = authed_client.post("/file/undo").json()
    assert result["undone"] == 1 and result["message"]


@pytest.mark.parametrize("record", [
    {"previous_operations": [None]}, {"previous_operations": [{"moves": ["bad"]}]},
    {"moves": [{"src": 3, "dst": "a"}]}, {"results": "bad"},
    {"previous_operations": [{"previous_operations": [{}]}]},
])
def test_malformed_nested_record_fails_closed_without_rewriting(isolated, record):
    home, calls = isolated; write(home, "file")
    S.LAST_FILE_OP_PATH.write_text(json.dumps(record)); before = S.LAST_FILE_OP_PATH.read_bytes()
    with pytest.raises(HTTPException) as error: organize(home, {"Target": ["file"]}, True)
    assert error.value.status_code == 503 and not calls and S.LAST_FILE_OP_PATH.read_bytes() == before


def test_unchanged_rename_row_is_not_pending_even_before_first_move(isolated, monkeypatch):
    home, _ = isolated; write(home, "prefix_1.txt"); write(home, "z.txt")
    original = ops._save
    saved = []
    def save(value):
        saved.append(json.loads(json.dumps(value))); original(value)
    monkeypatch.setattr(ops, "_save", save)
    result = ops.request("rename", "tester", {"path": str(home), "prefix": "prefix"}, confirm=True)
    assert result["ok"] and result["count"] == 1 and "1 already" in result["message"]
    assert saved[0]["results"][0]["status"] == "unchanged"
    assert len(ops._undo_entries(saved[-1])) == 1


def test_replayed_saved_token_requires_matching_operation_and_payload(isolated):
    home, calls = isolated; write(home, "file")
    preview = organize(home, {"Target": ["file"]})
    first = organize(home, {"Target": ["file"]}, True, token=preview["preview_id"])
    ops._plans.clear()
    assert organize(home, {"Target": ["file"]}, True, token=preview["preview_id"]) == first
    with pytest.raises(HTTPException) as error:
        ops.request("rename", "tester", {"path": str(home), "prefix": "wrong"}, confirm=True, preview_id=preview["preview_id"])
    assert error.value.status_code == 410 and len(calls) == 1
