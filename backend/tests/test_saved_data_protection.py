"""Recovery failure paths preserve synthetic stores and persisted keys."""
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
import data_protection as protection
import tli_state as S
from intelligence import memory, store
from routers import mesh_routes


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(S, 'MESH_DATA_DIR', tmp_path / 'mesh')
    monkeypatch.setattr(mesh_routes, 'MESH_CHAT_DIR', tmp_path / 'mesh' / 'chat')
    monkeypatch.setattr(S, '_CONV_KEY', None)
    monkeypatch.setattr(S, '_MEM_KEY', None)
    monkeypatch.setattr(S, '_CHAT_KEY', None)
    monkeypatch.setattr(protection, 'is_windows', lambda: False)
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})


def fixture(kind):
    if kind == 'conversations':
        original = {'conv-1': {'id': 'conv-1', 'user_id': 'local', 'messages': [{'role': 'user', 'content': 'Keep this conversation'}]}}
        S.save_conversations(original)
        return Path(S.CONVERSATIONS_FILE), Path(S.DATA_DIR) / 'conversations_key.bin', S.load_conversations, lambda: S.save_conversations({}), original
    if kind == 'memory':
        original = memory.save_fact('local', 'Keep this private note', title='Saved note')
        return Path(S.memory_path_for_user('local')), Path(S.DATA_DIR) / 'memory_key.bin', lambda: S.load_memory('local'), lambda: S.save_memory('local', {'facts': []}), original
    original = [{'id': 'report-1', 'detail': 'Keep this report'}]
    store.write_private('local', 'diagnostics', original)
    return store.private_path('local', 'diagnostics'), Path(S.DATA_DIR) / 'memory_key.bin', lambda: store.read_private('local', 'diagnostics', []), lambda: store.write_private('local', 'diagnostics', []), original


def unavailable(call):
    with pytest.raises(HTTPException) as error:
        call()
    assert error.value.status_code == 503
    assert 'preserved' in error.value.detail


@pytest.mark.parametrize('kind', ['conversations', 'memory', 'reports'])
@pytest.mark.parametrize('failure', ['missing', 'malformed', 'wrong-key'])
def test_keys_unavailable_block_reads_and_writes_despite_cached_key(kind, failure):
    path, key, read, write, _ = fixture(kind)
    original = path.read_bytes()
    if failure == 'missing':
        key.unlink()
    else:
        key.write_bytes(b'bad key' if failure == 'malformed' else b'x' * 32)
    saved_key = key.read_bytes() if key.exists() else None
    unavailable(read)
    unavailable(write)
    assert path.read_bytes() == original
    assert (key.read_bytes() if key.exists() else None) == saved_key


@pytest.mark.parametrize('kind', ['conversations', 'memory', 'reports'])
@pytest.mark.parametrize('content', [b'broken json', b'[]', b'{"_tli_enc":1,"data":"bad data"}'])
def test_unreadable_store_never_becomes_empty_or_gets_replaced(kind, content):
    path, key, read, write, _ = fixture(kind)
    key_bytes = key.read_bytes()
    path.write_bytes(content)
    unavailable(read)
    unavailable(write)
    assert path.read_bytes() == content and key.read_bytes() == key_bytes


def test_fresh_store_and_legacy_plaintext_roundtrip_without_read_mutations(tmp_path):
    assert S.load_conversations() == {} and S.load_memory('local')['facts'] == []
    assert not list(tmp_path.glob('*key.bin'))
    conversations = {'older': {'id': 'older', 'messages': [], 'user_id': 'local'}}
    Path(S.CONVERSATIONS_FILE).write_text(json.dumps(conversations))
    note_path = Path(S.memory_path_for_user('local'))
    note_path.write_text('{"facts":["Paper size is A4"]}')
    loaded = S.load_memory('local')
    assert loaded['facts'][0]['text'] == 'Paper size is A4'
    assert S.load_conversations() == conversations
    assert not list(tmp_path.glob('*key.bin'))
    S.save_conversations(conversations)
    S.save_memory('local', loaded)
    assert S.load_conversations() == conversations
    assert S.load_memory('local')['facts'] == loaded['facts']
    assert json.loads(note_path.read_text())['_tli_enc'] == 1


def test_absent_sidecar_read_creates_no_directories(tmp_path):
    assert store.read_private('local', 'images', []) == []
    assert not (tmp_path / 'intelligence').exists()
    assert not (tmp_path / 'memory_key.bin').exists()


@pytest.mark.parametrize('existing', ['memory', 'reports'])
@pytest.mark.parametrize('write_kind', ['memory', 'reports'])
def test_missing_shared_memory_key_blocks_new_owner_or_sidecar(existing, write_kind):
    original, key, _, _, _ = fixture(existing)
    preserved = original.read_bytes()
    key.unlink()
    if write_kind == 'memory':
        unavailable(lambda: memory.save_fact('new-owner', 'New note must not create a replacement key'))
        assert not Path(S.memory_path_for_user('new-owner')).exists()
    else:
        unavailable(lambda: store.write_private('new-owner', 'images', []))
        assert not store.private_path('new-owner', 'images').exists()
    assert not key.exists() and original.read_bytes() == preserved


def test_existing_encrypted_lan_chat_blocks_missing_key_creation_and_returns_503(client):
    directory = S.MESH_DATA_DIR / 'chat'
    directory.mkdir(parents=True)
    path = directory / 'existing.jsonl'
    path.write_text(S.encrypt_jsonl_line({'ts': 1, 'text': 'Keep LAN chat'}) + '\n')
    key = Path(S.DATA_DIR) / 'chat_key.bin'
    key.unlink()
    before = path.read_bytes()
    unavailable(lambda: S.encrypt_jsonl_line({'text': 'Do not split keys'}))
    unavailable(lambda: S.decrypt_jsonl_line(path.read_text()))
    unavailable(lambda: mesh_routes._append_chat_msg('new-thread', {'text': 'No empty file either'}))
    response = client.get('/mesh/chat/messages?thread_id=existing')
    assert response.status_code == 503
    assert path.read_bytes() == before and not key.exists()
    assert not (directory / 'new-thread.jsonl').exists()


def test_plaintext_lan_chat_still_supports_first_encrypted_append():
    directory = S.MESH_DATA_DIR / 'chat'
    directory.mkdir(parents=True)
    path = directory / 'older.jsonl'
    path.write_text('{"ts":1,"text":"Legacy message"}\n')
    encrypted = S.encrypt_jsonl_line({'ts': 2, 'text': 'Encrypted message'})
    assert S.decrypt_jsonl_line(encrypted)['text'] == 'Encrypted message'
    assert S.decrypt_jsonl_line(path.read_text())['text'] == 'Legacy message'


@pytest.mark.parametrize('kind', ['conversations', 'memory', 'reports'])
def test_write_permission_failure_is_actionable_and_preserves_existing(kind, monkeypatch):
    path, key, _, write, _ = fixture(kind)
    original, key_bytes = path.read_bytes(), key.read_bytes()
    real_replace = Path.replace
    def refuse(source, target):
        if Path(target) == path:
            raise PermissionError('Synthetic read-only destination')
        return real_replace(source, target)
    monkeypatch.setattr(Path, 'replace', refuse)
    unavailable(write)
    assert path.read_bytes() == original and key.read_bytes() == key_bytes


def test_corrupt_conversation_is_visible_to_both_existing_history_routes(client):
    path = Path(S.CONVERSATIONS_FILE)
    path.write_text('invalid JSON')
    assert client.get('/api/ai/conversations').status_code == 503
    assert client.get('/conversations').status_code == 503
    assert client.post('/api/ai/chat', json={'message': 'Hello'}).status_code == 503
    assert path.read_text() == 'invalid JSON'


def test_missing_key_check_does_not_search_unrelated_files(tmp_path):
    (tmp_path / 'unrelated.json').write_text('not JSON')
    (tmp_path / 'unrelated-folder').mkdir()
    (tmp_path / 'unrelated-folder' / 'memory_user.json').write_text('{"_tli_enc":1}')
    memory.save_fact('local', 'Valid new notebook')
    assert S.load_memory('local')['facts'][0]['text'] == 'Valid new notebook'


def test_bounded_missing_key_inspection_rejects_unknown_large_store(tmp_path):
    path = tmp_path / 'memory_older.json'
    path.write_bytes(b' ' * (8 * 1024 * 1024 + 1))
    unavailable(lambda: memory.save_fact('new-owner', 'Cannot establish a fresh shared key safely'))
    assert not (tmp_path / 'memory_key.bin').exists()
    assert path.stat().st_size == 8 * 1024 * 1024 + 1
