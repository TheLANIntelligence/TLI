"""Captured chat authority is checked at the encrypted-store commit boundary."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request, Response

import data_protection
import tli_state as S
import workspace_events
from ai import ai_routes as ai
from browser_authority import browser_control_access


@pytest.fixture
def saved(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "tli_pin.json")
    monkeypatch.setattr(S, "_CONV_KEY", None)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(data_protection, "is_windows", lambda: False)
    publish = Mock()
    monkeypatch.setattr(workspace_events, "publish", publish)
    original = {"kept": {"id": "kept", "user_id": "local", "title": "Existing conversation",
                         "messages": [{"role": "user", "content": "Keep my history"}],
                         "future_metadata": {"keep": True}}}
    S.save_conversations(original)
    publish.reset_mock()
    S.save_pin_config("a" * 64, "b" * 64)
    token = S.create_session_token("local")
    request = Request({"type": "http", "scheme": "http", "method": "POST", "path": "/api/ai/chat",
                       "query_string": b"", "server": ("localhost", 8000), "client": ("127.0.0.1", 1234),
                       "headers": [(b"host", b"localhost:8000"), (b"origin", b"http://localhost:8000"),
                                   (b"cookie", ("tli_session=" + token).encode())]})
    check = browser_control_access(request, Response())
    path = Path(S.CONVERSATIONS_FILE)
    key = tmp_path / "conversations_key.bin"
    updated = copy.deepcopy(original)
    updated["kept"]["messages"].append({"role": "assistant", "content": "Private device result"})
    return SimpleNamespace(path=path, temp=Path(str(path) + ".tmp"), key=key,
                           before=path.read_bytes(), key_before=key.read_bytes(), original=original,
                           updated=updated, check=check, revoke=lambda: S.revoke_session_token(token),
                           publish=publish)


def write(saved, via_turn=False):
    if via_turn:
        ai._save_turn("kept", "assistant", "Private device result", _authorize=saved.check, provider="tli-action")
    else:
        S.save_conversations(saved.updated, check=saved.check)


def denied(call, status=401):
    with pytest.raises(HTTPException) as error:
        call()
    assert error.value.status_code == status


def preserved(saved):
    assert saved.path.read_bytes() == saved.before
    assert saved.key.read_bytes() == saved.key_before
    assert not saved.temp.exists()
    saved.publish.assert_not_called()


@pytest.mark.parametrize("via_turn", [False, True])
def test_authorized_save_preserves_encryption_and_unknown_metadata(saved, via_turn):
    write(saved, via_turn)
    loaded = S.load_conversations()["kept"]
    assert loaded["future_metadata"] == {"keep": True}
    assert loaded["messages"][0] == saved.original["kept"]["messages"][0]
    assert loaded["messages"][-1]["content"] == "Private device result"
    assert "authorize" not in loaded["messages"][-1]
    assert json.loads(saved.path.read_text())["_tli_enc"] == 1
    assert b"Private device result" not in saved.path.read_bytes()
    assert saved.key.read_bytes() == saved.key_before
    assert not saved.temp.exists()
    saved.publish.assert_called_once_with("local", "conversation", "kept")


@pytest.mark.parametrize("via_turn", [False, True])
def test_revoked_admission_never_reads_or_changes_store(saved, monkeypatch, via_turn):
    read = Mock(side_effect=AssertionError("Denied work cannot read private history"))
    monkeypatch.setattr(S, "load_conversations", read)
    saved.revoke()
    denied(lambda: write(saved, via_turn))
    read.assert_not_called()
    preserved(saved)


@pytest.mark.parametrize("via_turn", [False, True])
@pytest.mark.parametrize("stage", ["read", "encryption", "staging"])
@pytest.mark.parametrize("failure", [False, True])
def test_revocation_during_private_work_blocks_commit_and_masks_failure(saved, monkeypatch, via_turn, stage, failure):
    if stage == "read":
        original = S.load_conversations
        reads = 0

        def read():
            nonlocal reads
            result = original()
            reads += 1
            # _save_turn first reads to construct its turn, then the store
            # independently verifies existing history before replacement.
            if reads == (2 if via_turn else 1):
                saved.revoke()
                if failure:
                    raise OSError("Synthetic private read failed")
            return result

        monkeypatch.setattr(S, "load_conversations", read)
    elif stage == "encryption":
        original = S.AESGCM

        def cipher(key):
            actual = original(key)

            def encrypt(*args):
                result = actual.encrypt(*args)
                saved.revoke()
                if failure:
                    raise OSError("Synthetic private encryption failed")
                return result

            return SimpleNamespace(decrypt=actual.decrypt, encrypt=encrypt)

        monkeypatch.setattr(S, "AESGCM", cipher)
    else:
        original = json.dump

        def stage_dump(value, handle, *args, **kwargs):
            result = original(value, handle, *args, **kwargs)
            if Path(handle.name) == saved.temp:
                saved.revoke()
                if failure:
                    raise OSError("Synthetic private staging failed")
            return result

        monkeypatch.setattr(json, "dump", stage_dump)
    denied(lambda: write(saved, via_turn))
    preserved(saved)


def test_failed_commit_preserves_history_and_cleans_own_staging(saved, monkeypatch):
    original = Path.replace

    def replace(source, target):
        if source == saved.temp:
            raise PermissionError("Synthetic destination refused replacement")
        return original(source, target)

    monkeypatch.setattr(Path, "replace", replace)
    denied(lambda: write(saved), status=503)
    preserved(saved)


def test_late_revocation_preserves_actual_completed_commit_without_publishing(saved, monkeypatch):
    original = Path.replace

    def replace(source, target):
        result = original(source, target)
        if source == saved.temp:
            saved.revoke()
        return result

    monkeypatch.setattr(Path, "replace", replace)
    denied(lambda: write(saved))
    assert S.load_conversations() == saved.updated
    assert saved.key.read_bytes() == saved.key_before
    assert not saved.temp.exists()
    saved.publish.assert_not_called()


def test_unbound_save_retains_existing_call_contract(saved, monkeypatch):
    persist = Mock()
    monkeypatch.setattr(S, "save_conversations", persist)
    ai._save_turn("kept", "assistant", "Ordinary text")
    assert persist.call_count == 1
    assert persist.call_args.kwargs == {}
    assert persist.call_args.args[0]["kept"]["messages"][-1]["content"] == "Ordinary text"
