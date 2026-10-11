"""Recovery invariants with disposable key files and fake platform protection."""
import base64
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import data_protection as dp
import vault_security as vault


@pytest.fixture(autouse=True)
def platform(monkeypatch):
    monkeypatch.setattr(dp, 'is_windows', lambda: False)


@pytest.mark.parametrize('windows', [False, True])
def test_legacy_key_reads_never_rewrite(tmp_path, monkeypatch, windows):
    key = tmp_path / 'legacy.bin'
    key.write_bytes(b'L' * 32)
    before = key.stat().st_mtime_ns
    monkeypatch.setattr(dp, 'is_windows', lambda: windows)
    monkeypatch.setattr(dp, 'dpapi_protect', lambda _: pytest.fail('No migration during read'))
    assert dp.load_existing_key(key) == dp.get_or_create_key(key) == b'L' * 32
    assert key.read_bytes() == b'L' * 32 and key.stat().st_mtime_ns == before


def test_read_missing_key_does_not_create_directory(tmp_path):
    key = tmp_path / 'missing' / 'key.bin'
    with pytest.raises(FileNotFoundError):
        dp.load_existing_key(key)
    assert not key.parent.exists()


@pytest.mark.parametrize('content', [b'', b'broken', b'x' * 65537], ids=['empty', 'malformed', 'oversized'])
def test_corrupt_key_is_preserved_not_regenerated(tmp_path, monkeypatch, content):
    key = tmp_path / 'key.bin'
    key.write_bytes(content)
    monkeypatch.setattr(dp.os, 'urandom', lambda _: pytest.fail('No new key for existing file'))
    with pytest.raises(dp.KeyUnavailableError):
        dp.get_or_create_key(key)
    assert key.read_bytes() == content


def test_foreign_windows_key_is_preserved(tmp_path, monkeypatch):
    key = tmp_path / 'key.bin'
    key.write_bytes(b'protected-for-another-Windows-user')
    monkeypatch.setattr(dp, 'is_windows', lambda: True)
    monkeypatch.setattr(dp, 'dpapi_unprotect', lambda _: (_ for _ in ()).throw(OSError('foreign account')))
    monkeypatch.setattr(dp.os, 'urandom', lambda _: pytest.fail('Never replace unreadable key'))
    with pytest.raises(dp.KeyUnavailableError, match='preserved'):
        dp.get_or_create_key(key)
    assert key.read_bytes() == b'protected-for-another-Windows-user'


def test_unprotected_result_must_be_a_complete_aes_key(tmp_path, monkeypatch):
    key = tmp_path / 'key.bin'
    key.write_bytes(b'fake-protected-blob')
    monkeypatch.setattr(dp, 'is_windows', lambda: True)
    monkeypatch.setattr(dp, 'dpapi_unprotect', lambda _: b'short')
    with pytest.raises(dp.KeyUnavailableError):
        dp.load_existing_key(key)
    assert key.read_bytes() == b'fake-protected-blob'


def test_new_windows_key_roundtrip_and_concurrent_readers(tmp_path, monkeypatch):
    key = tmp_path / 'key.bin'
    monkeypatch.setattr(dp, 'is_windows', lambda: True)
    monkeypatch.setattr(dp, 'dpapi_protect', lambda raw: b'fake-DPAPI:' + raw)
    monkeypatch.setattr(dp, 'dpapi_unprotect', lambda raw: raw[11:])
    with ThreadPoolExecutor(max_workers=8) as pool:
        values = list(pool.map(lambda _: dp.get_or_create_key(key), range(16)))
    assert all(value == values[0] for value in values)
    assert len(values[0]) == 32 and key.read_bytes() == b'fake-DPAPI:' + values[0]


def test_creation_does_not_overwrite_a_competing_process_key(tmp_path, monkeypatch):
    key = tmp_path / 'key.bin'
    original = dp.os.open
    def compete(path, flags, mode):
        key.write_bytes(b'W' * 32)
        return original(path, flags, mode)
    monkeypatch.setattr(dp.os, 'open', compete)
    assert dp.get_or_create_key(key) == b'W' * 32
    assert key.read_bytes() == b'W' * 32


@pytest.mark.parametrize('stage', ['protect', 'create', 'flush'])
def test_failed_key_creation_never_returns_session_only_key(tmp_path, monkeypatch, stage):
    def fail(*args):
        raise OSError('Simulated storage failure')
    if stage == 'protect':
        monkeypatch.setattr(dp, 'is_windows', lambda: True)
        monkeypatch.setattr(dp, 'dpapi_protect', fail)
    elif stage == 'create':
        monkeypatch.setattr(dp.os, 'open', fail)
    else:
        monkeypatch.setattr(dp.os, 'fsync', fail)
    with pytest.raises(dp.KeyUnavailableError, match='safely saved'):
        dp.get_or_create_key(tmp_path / 'key.bin')


def test_permission_error_is_not_treated_as_missing_key(tmp_path, monkeypatch):
    key = tmp_path / 'key.bin'
    key.write_bytes(b'K' * 32)
    original = Path.open
    def denied(path, *args, **kwargs):
        if path == key:
            raise PermissionError('Denied')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', denied)
    monkeypatch.setattr(dp.os, 'urandom', lambda _: pytest.fail('No replacement'))
    with pytest.raises(dp.KeyUnavailableError):
        dp.get_or_create_key(key)


@pytest.mark.parametrize('key_bytes', [None, b'bad-key'])
def test_saved_vault_sessions_preserved_when_machine_key_unavailable(tmp_path, monkeypatch, key_bytes):
    monkeypatch.setattr(vault, '_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(vault, 'UNLOCKED_VAULTS', {})
    monkeypatch.setattr(vault, 'ENCRYPTION_KEYS', {})
    path = tmp_path / 'vault_sessions.json'
    path.write_text(json.dumps({'owner': {'expiry': (datetime.utcnow() + timedelta(hours=1)).isoformat(), 'key_enc': base64.b64encode(b'ciphertext').decode()}}))
    key = tmp_path / 'vault_machine_key.bin'
    if key_bytes is not None:
        key.write_bytes(key_bytes)
    before = path.read_bytes()
    vault.load_persisted_sessions()
    vault._persist_session('new-owner', datetime.utcnow() + timedelta(hours=1), b'S' * 32)
    assert path.read_bytes() == before and not vault.ENCRYPTION_KEYS
    assert key.read_bytes() == key_bytes if key_bytes is not None else not key.exists()


def test_corrupt_vault_session_file_is_not_overwritten_on_unlock(tmp_path, monkeypatch):
    monkeypatch.setattr(vault, '_DATA_DIR', str(tmp_path))
    path = tmp_path / 'vault_sessions.json'
    path.write_bytes(b'corrupt-json')
    vault._persist_session('owner', datetime.utcnow() + timedelta(hours=1), b'S' * 32)
    assert path.read_bytes() == b'corrupt-json'
    assert not (tmp_path / 'vault_machine_key.bin').exists()
