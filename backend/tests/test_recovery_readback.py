"""Real fresh-process recovery readers use synthetic encrypted data only."""
import base64
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import pytest

import tli_state as S
from intelligence import recovery_readback as readback

PRIVATE = "PRIVATE-RECOVERY-CONTENT-DO-NOT-RETURN-7175"


def values():
    return {
        "notebook": {"facts": [
            {"id": "note-1", "text": PRIVATE, "title": "Router setup", "category": "setup",
             "source": "user", "device_id": "old-host", "report_id": "diagnostic-1",
             "created_at": "2026-01-01T10:00:00Z", "updated_at": "2026-02-01T10:00:00Z", "deleted": False,
             "chat_source": {"conversation_id": "conversation-1", "message_index": 1, "revision": "a" * 64,
                             "role": "assistant", "provider": "bundled"}, "future_metadata": {"kept": True}},
            {"id": "deleted-1", "text": "Retained deleted text", "deleted": True}],
            "last_updated": "2026-03-01T10:00:00Z"},
        "conversations": {"conversation-1": {"id": "conversation-1", "user_id": "local", "title": "Private history",
            "device_id": "old-host", "last_updated": "2026-03-01T10:00:00Z", "provider": "bundled",
            "messages": [{"role": "user", "content": "Question"}, {"role": "assistant", "content": PRIVATE,
                          "note_context": {"notes": [{"id": "note-1"}]}, "future_metadata": {"preserved": True}}]}},
        "diagnostics": [{"id": "diagnostic-1", "kind": "network", "created_at": "2026-03-01T10:00:00Z",
            "checks": [{"id": "sample", "status": "pass", "detail": PRIVATE}], "verified_fix": {"text": PRIVATE},
            "host": {"id": "old-host", "name": "Old host"}, "memory_id": "note-1"}],
        "origin": {"schema_version": 1, "source": {"owner_id": "archive-owner", "conversation_owner_ids": ["archive-owner"],
            "source_host": {"id": "old-host", "name": "Old host"}}, "conversation_owners": {"conversation-1": "archive-owner"},
            "recovered_owner": "local"},
    }


def expectation(payload):
    return {**{kind: readback.canonical_digest(payload[kind]) for kind in readback.KINDS}, "owner": "local",
            "counts": {"notebook": len(payload["notebook"]["facts"]), "conversations": len(payload["conversations"]), "diagnostics": len(payload["diagnostics"])}}


def write_area(root, kind, value, *, aad=None):
    key = b"C" * 32 if kind == "conversations" else b"M" * 32
    nonce = os.urandom(12)
    if aad is None:
        aad = {"diagnostics": b"diagnostics:local", "origin": b"recovery-origin:local"}.get(kind)
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
    envelope = {"_tli_enc": 1, "data": base64.b64encode(nonce + AESGCM(key).encrypt(nonce, raw, aad)).decode()}
    (root / readback.FILES[kind]).write_text(json.dumps(envelope), encoding="utf-8")


def seed(root, payload):
    root.mkdir()
    for name in readback.DIRECTORIES:
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / "data/memory_key.bin").write_bytes(b"M" * 32)
    (root / "data/conversations_key.bin").write_bytes(b"C" * 32)
    for kind in readback.KINDS:
        write_area(root, kind, payload[kind])
    return root


def tree(root):
    return {path.relative_to(root).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob("*") if path.is_file()}


def test_current_readers_reopen_encrypted_copy_with_preserved_metadata_and_no_effects(tmp_path, monkeypatch):
    payload = values()
    root = seed(tmp_path / "separate-copy", payload)
    before = tree(root)
    # The parent process's imported state/readers cannot establish the result.
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Parent reader must not be used"))
    result = readback.run_readback(root, expectation(payload))
    assert result["ok"] is True and result["reader"] == "current-application"
    assert result["counts"] == {"notebook": 2, "conversations": 1, "diagnostics": 1}
    assert result["checks"] == dict.fromkeys(readback.CHECKS, True)
    assert tree(root) == before
    rendered = json.dumps(result)
    assert PRIVATE not in rendered and "archive-owner" not in rendered and "old-host" not in rendered
    assert not any(path.name in {"tli_pin.json", "node_identity.json", "node_config.json"} for path in root.rglob("*"))


@pytest.mark.parametrize("legacy", [False, True])
def test_empty_and_legacy_notes_reopen_without_migration(tmp_path, legacy):
    payload = values()
    payload["notebook"] = {"facts": ["An older private note", "Another note"] if legacy else [], "last_updated": "2025-10-01"}
    payload["conversations"] = {}
    payload["diagnostics"] = []
    payload["origin"]["conversation_owners"] = {}
    root = seed(tmp_path / "copy", payload)
    before = tree(root)
    assert readback.run_readback(root, expectation(payload))["counts"]["notebook"] == (2 if legacy else 0)
    assert tree(root) == before


@pytest.mark.parametrize("kind", readback.KINDS)
def test_any_changed_metadata_or_record_fails_digest_check_without_mutation(tmp_path, kind):
    payload = values()
    root = seed(tmp_path / "copy", payload)
    expected = expectation(payload)
    altered = deepcopy(payload[kind])
    if kind == "notebook":
        altered["facts"][0]["updated_at"] = "2026-09-08"
    elif kind == "conversations":
        altered["conversation-1"]["messages"][1]["future_metadata"] = {"preserved": False}
    elif kind == "diagnostics":
        altered[0]["memory_id"] = "wrong-note"
    else:
        altered["source"]["source_host"]["name"] = "Different source"
    write_area(root, kind, altered)
    before = tree(root)
    with pytest.raises(readback.ReadbackError):
        readback.run_readback(root, expected)
    assert tree(root) == before


@pytest.mark.parametrize("problem", ["duplicate_note", "hidden_note", "mixed_notes", "duplicate_report", "missing_report_id", "bad_turn", "wrong_owner", "wrong_origin"])
def test_readers_cannot_certify_hidden_malformed_or_ambiguous_records(tmp_path, problem):
    payload = values()
    if problem == "duplicate_note": payload["notebook"]["facts"][1]["id"] = "note-1"
    if problem == "hidden_note": payload["notebook"]["facts"][0]["deleted"] = "false"
    if problem == "mixed_notes": payload["notebook"]["facts"].append("Legacy string mixed into current records")
    if problem == "duplicate_report": payload["diagnostics"].append(deepcopy(payload["diagnostics"][0]))
    if problem == "missing_report_id": payload["diagnostics"][0].pop("id")
    if problem == "bad_turn": payload["conversations"]["conversation-1"]["messages"].append({"role": "assistant", "content": {"bad": True}})
    if problem == "wrong_owner": payload["conversations"]["conversation-1"]["user_id"] = "another-owner"
    if problem == "wrong_origin": payload["origin"]["conversation_owners"]["conversation-1"] = "another-owner"
    root = seed(tmp_path / "copy", payload)
    before = tree(root)
    with pytest.raises(readback.ReadbackError):
        readback.run_readback(root, expectation(payload))
    assert tree(root) == before


def test_inherited_persistence_python_and_startup_overrides_are_not_used(tmp_path, monkeypatch):
    payload = values()
    root = seed(tmp_path / "copy", payload)
    hostile = tmp_path / "other-root"
    hostile.mkdir()
    sentinel = hostile / "source-data"
    sentinel.write_text(PRIVATE)
    (hostile / "sitecustomize.py").write_text("raise RuntimeError('Injected site module must not run')")
    monkeypatch.setenv("TLI_ROOT", str(hostile))
    monkeypatch.setenv("PYTHONPATH", str(hostile))
    monkeypatch.setenv("TLI_AI_MODE", "launch")
    monkeypatch.setenv("TLI_OPEN_BROWSER", "1")
    run = readback.subprocess.run
    captured = []
    def inspect(args, **kwargs):
        captured.append((args, kwargs))
        return run(args, **kwargs)
    monkeypatch.setattr(readback.subprocess, "run", inspect)
    assert readback.run_readback(root, expectation(payload))["ok"]
    args, kw = captured[0]
    assert args[1:3] == ["-I", "-B"] and kw["shell"] is False
    assert kw["env"]["TLI_ROOT"] == str(root)
    assert set(name for name in kw["env"] if name.startswith("TLI_")) == {"TLI_ROOT"}
    assert "PYTHONPATH" not in kw["env"] and PRIVATE not in kw["input"]
    assert sentinel.read_text() == PRIVATE


@pytest.mark.parametrize("problem", ["missing_key", "wrong_key", "wrong_aad", "plaintext", "extra_file", "hardlink", "wrong_count"])
def test_incomplete_or_unsafe_destination_is_never_approved(tmp_path, problem):
    payload = values()
    root = seed(tmp_path / "copy", payload)
    expected = expectation(payload)
    key = root / "data/memory_key.bin"
    if problem == "missing_key": key.unlink()
    if problem == "wrong_key": key.write_bytes(b"X" * 32)
    if problem == "wrong_aad": write_area(root, "diagnostics", payload["diagnostics"], aad=b"diagnostics:other-owner")
    if problem == "plaintext": (root / readback.FILES["notebook"]).write_text(json.dumps(payload["notebook"]))
    if problem == "extra_file": (root / "data/tli_pin.json").write_text("not allowed")
    if problem == "hardlink": os.link(key, tmp_path / "shared-key")
    if problem == "wrong_count": expected["counts"]["notebook"] += 1
    before = tree(root)
    with pytest.raises(readback.ReadbackError):
        readback.run_readback(root, expected)
    assert tree(root) == before


def test_frozen_runtime_and_active_root_fail_before_subprocess_or_directory_creation(tmp_path, monkeypatch):
    expected = expectation(values())
    monkeypatch.setattr(readback.subprocess, "run", lambda *a, **kw: pytest.fail("Must not launch TLI or read active data"))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    with pytest.raises(readback.ReadbackError, match="Python/source installation"):
        readback.ensure_available()
    with pytest.raises(readback.ReadbackError, match="packaged runtime"):
        readback.run_readback(tmp_path / "not-created", expected)
    assert not (tmp_path / "not-created").exists()
    monkeypatch.delattr(sys, "frozen")
    monkeypatch.setenv("TLI_ROOT", str(tmp_path))
    with pytest.raises(readback.ReadbackError):
        readback.run_readback(tmp_path, expected)


def test_timeout_and_untrusted_child_output_never_expose_saved_content(tmp_path, monkeypatch):
    root = seed(tmp_path / "copy", values())
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"], output=PRIVATE)
    monkeypatch.setattr(readback.subprocess, "run", timeout)
    with pytest.raises(readback.ReadbackError, match="timed out") as error:
        readback.run_readback(root, expectation(values()))
    assert PRIVATE not in str(error.value)
    monkeypatch.setattr(readback.subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a[0], 1, PRIVATE, PRIVATE))
    with pytest.raises(readback.ReadbackError) as error:
        readback.run_readback(root, expectation(values()))
    assert PRIVATE not in str(error.value)


def test_local_legacy_conversation_ownership_is_recorded_then_mapped(tmp_path):
    payload = values()
    payload["origin"]["source"] = {"owner_id": "local", "conversation_owner_ids": ["bundled-ai", "local"]}
    payload["origin"]["conversation_owners"]["conversation-1"] = "bundled-ai"
    root = seed(tmp_path / "copy", payload)
    assert readback.run_readback(root, expectation(payload))["checks"]["owner_mapping"] is True


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-protected keys are verified on Windows")
def test_current_windows_reader_reopens_new_dpapi_keys_in_fresh_process(tmp_path):
    import data_protection
    payload = values()
    root = seed(tmp_path / "copy", payload)
    for key_file in readback.KEY_FILES:
        path = root / key_file
        path.write_bytes(data_protection.dpapi_protect(path.read_bytes()))
    before = tree(root)
    assert readback.run_readback(root, expectation(payload))["ok"]
    assert tree(root) == before


def test_duplicate_json_fields_cannot_be_hidden_by_current_json_readers(tmp_path):
    payload = values()
    root = seed(tmp_path / "copy", payload)
    path = root / readback.FILES["notebook"]
    normal = path.read_text()
    path.write_text(normal.replace('{"_tli_enc": 1,', '{"_tli_enc": 2, "_tli_enc": 1,', 1))
    with pytest.raises(readback.ReadbackError):
        readback.run_readback(root, expectation(payload))


def test_child_guard_blocks_network_processes_threads_and_writes(tmp_path):
    # Test the actual permanent audit hook only inside its own interpreter.
    backend = Path(readback.__file__).resolve().parents[1]
    code = """
import sys, pathlib, socket, subprocess, threading, json
sys.path.insert(0, sys.argv[1])
from intelligence.recovery_readback import _guard_child
root = pathlib.Path(sys.argv[2])
_guard_child(root)
checks = []
for attempt in [lambda: (root / 'forbidden').write_text('private'),
                lambda: socket.socket(),
                lambda: subprocess.Popen([sys.executable, '-c', 'pass']),
                lambda: threading.Thread(target=lambda: None).start()]:
    try:
        attempt()
        checks.append(False)
    except RuntimeError:
        checks.append(True)
print(json.dumps(checks))
"""
    result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(backend), str(tmp_path)],
        capture_output=True, text=True, timeout=10, cwd=tmp_path,
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}))
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [True] * 4
    assert not (tmp_path / "forbidden").exists()


def test_file_growth_after_stat_cannot_trigger_an_unbounded_read(tmp_path, monkeypatch):
    root = seed(tmp_path / "copy", values())
    target = root / readback.FILES["notebook"]
    monkeypatch.setattr(readback, "MAX_FILE_BYTES", 10000)
    original_open = Path.open
    requested = []
    class GrowingFile(io.BytesIO):
        def read(self, size=-1):
            requested.append(size)
            assert size == 10001
            return super().read(size)
    def replaced(path, *args, **kwargs):
        if path == target:
            return GrowingFile(b"x" * 10002)
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, "open", replaced)
    with pytest.raises(ValueError, match="read limit"):
        readback._snapshot(root)
    assert requested == [10001]
