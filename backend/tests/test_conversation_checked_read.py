"""Checked history reads preserve existing bytes and stop after access loss."""
import base64
import builtins
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

import tli_state as S


ROWS = {"sample": {"id": "sample", "user_id": "owner", "messages": [
    {"role": "user", "content": "PRIVATE_HISTORY_CANARY"}]}}
KEY = b"k" * 32


@pytest.fixture
def history(tmp_path, monkeypatch):
    path = tmp_path / "conversations.json"
    path.write_text(json.dumps(ROWS), encoding="utf-8")
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(path))
    monkeypatch.setattr(S, "_store_key", lambda *a, **k: KEY)
    return path


def encrypted(path):
    nonce = b"n" * 12
    ciphertext = AESGCM(KEY).encrypt(nonce, json.dumps(ROWS).encode(), None)
    path.write_text(json.dumps({"_tli_enc": 1, "data": base64.b64encode(nonce + ciphertext).decode()}))


@pytest.mark.parametrize("secured", [False, True])
def test_checked_read_preserves_plaintext_and_encrypted_bytes(history, secured):
    if secured:
        encrypted(history)
    before = history.read_bytes()
    assert S.load_conversations(check=lambda: None) == ROWS
    assert S.load_conversations() == ROWS
    assert history.read_bytes() == before
    assert sorted(p.name for p in history.parent.iterdir()) == [history.name]


def test_checked_absence_does_not_create_history_or_keys(history, monkeypatch):
    history.unlink()
    monkeypatch.setattr(S, "_store_key", lambda *a, **k: pytest.fail("Read created a key"))
    assert S.load_conversations(check=lambda: None) == {}
    assert not list(history.parent.iterdir())


@pytest.mark.parametrize("phase", ["before_lock", "lock_acquired", "lock_error", "lock_released", "opened", "read", "read_error", "json", "key", "decrypt"])
@pytest.mark.parametrize("code", [401, 503])
def test_access_loss_blocks_next_work_and_disclosure(history, monkeypatch, phase, code):
    lost = phase == "before_lock"
    failure = HTTPException(code, "Original access unavailable")
    calls = []

    def check():
        if lost:
            raise failure

    class Lock:
        def __enter__(self):
            nonlocal lost
            calls.append("lock")
            if phase in {"lock_acquired", "lock_error"}:
                lost = True
            if phase == "lock_error":
                raise OSError("PRIVATE_LOCK_ERROR")
        def __exit__(self, *args):
            nonlocal lost
            if phase == "lock_released":
                lost = True

    monkeypatch.setattr(S, "CONVERSATIONS_LOCK", Lock())
    original_open = builtins.open

    class Stream:
        def __enter__(self):
            nonlocal lost
            calls.append("open")
            if phase == "opened":
                lost = True
            return self
        def read(self):
            nonlocal lost
            calls.append("read")
            with original_open(history, "rb") as handle:
                value = handle.read()
            if phase in {"read", "read_error"}:
                lost = True
            if phase == "read_error":
                raise OSError("PRIVATE_READ_ERROR")
            return value
        def __exit__(self, *args):
            calls.append("close")

    def open_file(path, *args, **kwargs):
        return Stream() if Path(path) == history else original_open(path, *args, **kwargs)

    if phase in {"key", "decrypt"}:
        encrypted(history)
    before = history.read_bytes()
    monkeypatch.setattr(builtins, "open", open_file)
    original_loads = S.json.loads

    def loads(*args, **kwargs):
        nonlocal lost
        calls.append("json")
        value = original_loads(*args, **kwargs)
        if phase == "json":
            lost = True
        return value

    def key(*args, **kwargs):
        nonlocal lost
        calls.append("key")
        assert kwargs.get("create", False) is False
        if phase == "key":
            lost = True
        return KEY

    class Cipher:
        def __init__(self, key):
            self.real = AESGCM(key)
        def decrypt(self, *args):
            nonlocal lost
            calls.append("decrypt")
            value = self.real.decrypt(*args)
            if phase == "decrypt":
                lost = True
            return value

    monkeypatch.setattr(S.json, "loads", loads)
    monkeypatch.setattr(S, "_store_key", key)
    monkeypatch.setattr(S, "AESGCM", Cipher)
    with pytest.raises(HTTPException) as denied:
        S.load_conversations(check=check)
    assert denied.value is failure
    if phase == "before_lock":
        assert calls == []
    if phase in {"lock_acquired", "lock_error"}:
        assert "open" not in calls
    if phase == "opened":
        assert "read" not in calls
    if phase in {"read", "read_error"}:
        assert "json" not in calls
    if phase == "key":
        assert "decrypt" not in calls
    assert history.read_bytes() == before


def test_a_single_failed_check_cannot_be_masked_by_a_later_success(history):
    calls = 0
    failure = HTTPException(503, "Security unavailable")
    def check():
        nonlocal calls
        calls += 1
        if calls == 4:
            raise failure
    with pytest.raises(HTTPException) as denied:
        S.load_conversations(check=check)
    assert denied.value is failure
    assert calls == 4


def test_malformed_history_stays_unavailable_and_unchanged(history):
    history.write_bytes(b"{ damaged PRIVATE_HISTORY_CANARY")
    before = history.read_bytes()
    with pytest.raises(HTTPException) as denied:
        S.load_conversations(check=lambda: None)
    assert denied.value.status_code == 503
    assert "PRIVATE_HISTORY_CANARY" not in str(denied.value.detail)
    assert history.read_bytes() == before
