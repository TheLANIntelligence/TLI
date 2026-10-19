"""Temporary-state coverage for the legacy Builder chat preservation boundary."""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from threading import Event

from fastapi import HTTPException
import pytest

from builder import chat, chat_store as store


@pytest.fixture
def history(tmp_path, monkeypatch):
    path = tmp_path / "builder" / "chat.json"
    monkeypatch.setattr(chat, "CHAT_PATH", path)
    monkeypatch.setattr(store, "_SEEN", set())
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    return path


def _save(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return path.read_bytes()


def _unavailable(call):
    with pytest.raises(HTTPException) as raised:
        call()
    assert raised.value.status_code == 503
    assert raised.value.headers["Cache-Control"] == "no-store"
    return raised.value


def _stages(path):
    return list(path.parent.glob(".tli-builder-chat-*"))


def test_genuine_absence_reads_without_creation_and_first_append_works(history):
    assert chat.load_chat_messages() == []
    assert chat.find_chat("missing") is None
    assert not history.parent.exists()
    item = chat.add_chat_message("Hello", "Welcome", attachments=[{"name": "note.txt"}])
    assert json.loads(history.read_bytes()) == [item]
    assert chat.find_chat(item["id"]) == item
    assert _stages(history) == []


@pytest.mark.parametrize("raw", [
    b"", b"{broken", b"null", b"{}", b"[null]", b"[1]", b"[\xff]",
    b'[{"id":"same","id":"changed"}]',
    b'[{"id":"one","extra":{"label":1,"label":2}}]',
    b'[{"id":"same"},{"id":"same"}]',
    b'[{"task":12}]', b'[{"attachments":{}}]',
    b'[{"extra":NaN}]', b'[{"extra":Infinity}]', b'[{"extra":1e999}]',
])
def test_damaged_existing_history_is_never_empty_or_overwritten(history, raw):
    history.parent.mkdir()
    history.write_bytes(raw)
    for operation in (chat.load_chat_messages, lambda: chat.find_chat("one"),
                      lambda: chat.add_chat_message("new", "reply")):
        error = _unavailable(operation)
        assert "broken" not in error.detail
        assert history.read_bytes() == raw
        assert _stages(history) == []


def test_oversized_file_is_rejected_before_open(history, monkeypatch):
    history.parent.mkdir()
    raw = b" " * 513
    history.write_bytes(raw)
    monkeypatch.setattr(store, "MAX_BYTES", 512)
    original_open = store.os.open
    opened = []
    def guarded_open(path, *args, **kwargs):
        if Path(path) == history:
            opened.append(path)
            raise OSError("Oversized history must not be opened")
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(store.os, "open", guarded_open)
    _unavailable(chat.load_chat_messages)
    _unavailable(lambda: chat.add_chat_message("new", "reply"))
    assert opened == []
    assert history.read_bytes() == raw


def test_too_many_existing_rows_are_preserved(history):
    raw = _save(history, [{"id": str(i)} for i in range(store.MAX_ROWS + 1)])
    _unavailable(lambda: chat.add_chat_message("new", "reply"))
    assert history.read_bytes() == raw


def test_unreadable_history_is_preserved(history, monkeypatch):
    raw = _save(history, [{"id": "existing", "task": "private prompt"}])
    original_open = store.os.open
    def denied(path, *args, **kwargs):
        if Path(path) == history:
            raise PermissionError("private path or content must not be exposed")
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(store.os, "open", denied)
    for operation in (chat.load_chat_messages, lambda: chat.add_chat_message("new", "reply")):
        error = _unavailable(operation)
        assert "private" not in error.detail
    assert history.read_bytes() == raw
    assert _stages(history) == []


def test_valid_metadata_is_retained_and_returned_rows_are_detached(history):
    old = {"id": "old", "task": "Earlier", "response": "Answer",
           "future_metadata": {"tags": ["家庭"], "score": 0.5},
           "attachments": [{"name": "context", "future_field": {"kept": True}}]}
    _save(history, [old])
    loaded = chat.load_chat_messages()
    loaded[0]["future_metadata"]["tags"].append("caller mutation")
    added = chat.add_chat_message("New", "Reply", thread_id="existing-thread", parent_id="old")
    added["attachments"].append({"name": "caller mutation"})
    saved = json.loads(history.read_bytes())
    assert saved[0] == old
    assert saved[1]["attachments"] == []
    assert saved[1]["thread_id"] == "existing-thread"
    assert saved[1]["parent_id"] == "old"
    assert chat.load_chat_messages(limit=1)[0]["task"] == "New"


def test_existing_latest_200_retention_policy_is_preserved(history):
    old = [{"id": str(i), "future_metadata": {"index": i}} for i in range(200)]
    _save(history, old)
    added = chat.add_chat_message("New", "Reply")
    saved = json.loads(history.read_bytes())
    assert saved == old[1:] + [added]


def test_concurrent_append_keeps_each_message_and_existing_metadata(history):
    old = {"id": "seed", "metadata": {"retain": True}}
    _save(history, [old])
    with ThreadPoolExecutor(max_workers=6) as workers:
        items = list(workers.map(lambda i: chat.add_chat_message(f"prompt {i}", f"reply {i}"), range(24)))
    saved = json.loads(history.read_bytes())
    assert saved[0] == old
    assert len(saved) == 25
    assert {row["id"] for row in saved[1:]} == {row["id"] for row in items}
    assert {row["task"] for row in saved[1:]} == {f"prompt {i}" for i in range(24)}
    assert _stages(history) == []


def test_known_staging_write_failure_preserves_original_and_cleans_owned_stage(history, monkeypatch):
    raw = _save(history, [{"id": "old"}])
    with monkeypatch.context() as patch:
        patch.setattr(store.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("disk full")))
        _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert history.read_bytes() == raw
    assert _stages(history) == []
    # No publication was attempted and cleanup was confirmed, so a later explicit append is safe.
    chat.add_chat_message("Another explicit request", "Reply")
    assert len(json.loads(history.read_bytes())) == 2


@pytest.mark.parametrize("existing", [False, True])
def test_stage_fdopen_failure_closes_descriptor_and_cleans_known_owned_stage(history, monkeypatch, existing):
    raw = _save(history, [{"id": "old"}]) if existing else None
    original_mkstemp, original_fdopen = store.tempfile.mkstemp, store.os.fdopen
    descriptors = []
    def created(*args, **kwargs):
        descriptor, name = original_mkstemp(*args, **kwargs)
        descriptors.append(descriptor)
        return descriptor, name
    def wrap_failed(descriptor, mode, *args, **kwargs):
        if mode == "wb" and descriptor in descriptors:
            raise OSError("stream wrapper unavailable")
        return original_fdopen(descriptor, mode, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(store.tempfile, "mkstemp", created)
        patch.setattr(store.os, "fdopen", wrap_failed)
        _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert len(descriptors) == 1
    with pytest.raises(OSError):
        store.os.fstat(descriptors[0])
    assert _stages(history) == []
    assert (history.read_bytes() if history.exists() else None) == raw
    assert chat.load_chat_messages() == ([{"id": "old"}] if existing else [])


@pytest.mark.parametrize("existing", [False, True])
def test_initial_stage_fstat_failure_closes_descriptor_retains_stage_and_latches(history, monkeypatch, existing):
    raw = _save(history, [{"id": "old"}]) if existing else None
    original_mkstemp, original_fstat = store.tempfile.mkstemp, store.os.fstat
    descriptors = []
    def created(*args, **kwargs):
        descriptor, name = original_mkstemp(*args, **kwargs)
        descriptors.append(descriptor)
        return descriptor, name
    def inspection_failed(descriptor):
        if descriptor in descriptors:
            raise OSError("stage identity unavailable")
        return original_fstat(descriptor)
    with monkeypatch.context() as patch:
        patch.setattr(store.tempfile, "mkstemp", created)
        patch.setattr(store.os, "fstat", inspection_failed)
        _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert len(descriptors) == 1
    with pytest.raises(OSError):
        original_fstat(descriptors[0])
    stages = _stages(history)
    assert len(stages) == 1
    assert stages[0].read_bytes() == b""
    assert (history.read_bytes() if history.exists() else None) == raw
    assert store._key(history) in store._UNCERTAIN
    _unavailable(chat.load_chat_messages)
    _unavailable(lambda: chat.add_chat_message("No retry", "Reply"))
    assert _stages(history) == stages


@pytest.mark.parametrize("publish_first", [False, True])
def test_uncertain_replacement_retains_evidence_and_blocks_reads_and_appends(history, monkeypatch, publish_first):
    raw = _save(history, [{"id": "old", "unknown": {"preserve": True}}])
    original_publish = store._publish
    def uncertain(staged, path, *, new):
        if publish_first:
            original_publish(staged, path, new=new)
        raise OSError("replacement result unavailable")
    monkeypatch.setattr(store, "_publish", uncertain)
    _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    retained = list(history.parent.glob("*.recovery.json"))
    assert len(retained) == 1
    evidence = json.loads(retained[0].read_bytes())
    assert base64.b64decode(evidence["before"]["base64"]) == raw
    after = base64.b64decode(evidence["after"]["base64"])
    assert json.loads(after)[-1]["task"] == "New"
    assert history.read_bytes() == (after if publish_first else raw)
    preserved = {path.name: path.read_bytes() for path in history.parent.iterdir()}
    monkeypatch.setattr(store, "_publish", original_publish)
    _unavailable(chat.load_chat_messages)
    _unavailable(lambda: chat.find_chat("old"))
    _unavailable(lambda: chat.add_chat_message("No retry", "Reply"))
    assert {path.name: path.read_bytes() for path in history.parent.iterdir()} == preserved


def test_unresolved_staging_cleanup_blocks_later_access(history, monkeypatch):
    raw = _save(history, [{"id": "old"}])
    with monkeypatch.context() as patch:
        patch.setattr(store.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("disk full")))
        patch.setattr(store, "_cleanup", lambda records: False)
        _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert history.read_bytes() == raw
    assert _stages(history)
    _unavailable(chat.load_chat_messages)
    _unavailable(lambda: chat.add_chat_message("No retry", "Reply"))


def test_cleanup_failure_after_confirmed_commit_retains_evidence_and_blocks_access(history, monkeypatch):
    raw = _save(history, [{"id": "old"}])
    original_unlink = Path.unlink
    def denied(path, *args, **kwargs):
        if path.name.endswith(".recovery.json"):
            raise PermissionError("cleanup denied")
        return original_unlink(path, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", denied)
        _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert json.loads(history.read_bytes())[-1]["task"] == "New"
    retained = list(history.parent.glob("*.recovery.json"))
    assert len(retained) == 1
    assert base64.b64decode(json.loads(retained[0].read_bytes())["before"]["base64"]) == raw
    _unavailable(chat.load_chat_messages)
    _unavailable(lambda: chat.add_chat_message("No retry", "Reply"))


def test_lock_wait_is_bounded_and_does_not_read_or_write(history, monkeypatch):
    raw = _save(history, [{"id": "old"}])
    acquired, release = Event(), Event()
    def hold_lock():
        with store.LOCK:
            acquired.set()
            release.wait(timeout=10)
    monkeypatch.setattr(store, "LOCK_TIMEOUT", 0.01)
    with ThreadPoolExecutor(max_workers=1) as worker:
        future = worker.submit(hold_lock)
        try:
            assert acquired.wait(timeout=5)
            error = _unavailable(chat.load_chat_messages)
            assert "busy" in error.detail
            _unavailable(lambda: chat.add_chat_message("No write", "Reply"))
        finally:
            release.set()
        future.result(timeout=5)
    assert history.read_bytes() == raw
    assert _stages(history) == []
    assert chat.load_chat_messages() == [{"id": "old"}]


def test_hard_linked_history_is_preserved_without_read_or_append(history):
    raw = _save(history, [{"id": "old"}])
    alias = history.parent / "alias.json"
    store.os.link(history, alias)
    _unavailable(chat.load_chat_messages)
    _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert history.read_bytes() == raw
    assert alias.read_bytes() == raw
    assert _stages(history) == []


def test_disappearing_previously_seen_history_cannot_be_recreated(history):
    _save(history, [{"id": "old"}])
    assert chat.find_chat("old") == {"id": "old"}
    history.unlink()
    _unavailable(chat.load_chat_messages)
    _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert not history.exists()
    assert _stages(history) == []


def test_external_change_during_staging_is_not_overwritten(history, monkeypatch):
    _save(history, [{"id": "old"}])
    original_stage = store._stage
    replacement = [{"id": "external", "metadata": "retain"}]
    def changed(path, raw, suffix, records):
        result = original_stage(path, raw, suffix, records)
        if suffix == ".recovery.json":
            _save(history, replacement)
        return result
    monkeypatch.setattr(store, "_stage", changed)
    _unavailable(lambda: chat.add_chat_message("New", "Reply"))
    assert json.loads(history.read_bytes()) == replacement
    assert _stages(history) == []


def test_chat_route_rejects_damaged_history_before_inference(history, monkeypatch):
    from routers import builder as routes
    history.parent.mkdir()
    raw = b'{"private":"damaged history"}'
    history.write_bytes(raw)
    calls = []
    monkeypatch.setattr(routes, "complete_chat", lambda *a, **kw: calls.append("inference"))
    monkeypatch.setattr(routes, "load_state", lambda: calls.append("state"))
    monkeypatch.setattr(routes, "add_receipt", lambda *a, **kw: calls.append("receipt"))
    _unavailable(lambda: routes.chat_with_builder(routes.ChatRequest(message="Hello")))
    assert calls == []
    assert history.read_bytes() == raw
