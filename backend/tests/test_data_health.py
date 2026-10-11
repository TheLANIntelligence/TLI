"""Data checks never repair, migrate, create keys or expose saved contents."""
import base64
import hashlib
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import tli_state as S
from intelligence import data_health

OWNER = 'test-user'
REAL_HOST_LOOKUP = data_health._host


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(data_health, '_host', lambda: {'id': 'fixture-host', 'name': 'Sample TLI'})
    monkeypatch.setattr(data_health.protection, 'is_windows', lambda: False)
    monkeypatch.setattr(data_health.protection, 'get_or_create_key', lambda _: pytest.fail('Checks cannot create keys'))


def encrypted(path, value, key_name, aad=None):
    key = b'F' * 32
    (Path(S.DATA_DIR) / key_name).write_bytes(key)
    nonce = b'N' * 12
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'_tli_enc': 1, 'data': base64.b64encode(nonce + AESGCM(key).encrypt(nonce, json.dumps(value).encode(), aad)).decode()}))


def snapshots():
    return {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in Path(S.DATA_DIR).rglob('*') if p.is_file()}


def test_first_check_creates_no_files_or_directories(authed_client):
    before = list(Path(S.DATA_DIR).iterdir())
    response = authed_client.get('/api/intelligence/data-health')
    assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
    data = response.json()
    assert data['schema_version'] == 1 and data['host']['id'] == 'fixture-host'
    assert data['backup']['status'] == 'unknown'
    assert {row['status'] for row in data['checks']} == {'not_created'}
    assert list(Path(S.DATA_DIR).iterdir()) == before


def test_checks_use_persisted_keys_and_return_no_private_content(authed_client, monkeypatch):
    secret = 'PRIVATE-SAMPLE-CONTENT-DO-NOT-PROJECT'
    encrypted(Path(S.memory_path_for_user(OWNER)), {'facts': [{'id': 'owned-note', 'text': secret}]}, 'memory_key.bin')
    encrypted(Path(S.CONVERSATIONS_FILE), {'owned': {'user_id': OWNER, 'title': secret, 'messages': []}, 'foreign': {'user_id': 'someone-else', 'title': secret, 'messages': []}}, 'conversations_key.bin')
    path = Path(S.DATA_DIR) / 'intelligence' / f'diagnostics-{hashlib.sha256(OWNER.encode()).hexdigest()}.json'
    encrypted(path, [{'id': 'report', 'scope': secret}], 'memory_key.bin', f'diagnostics:{OWNER}'.encode())
    monkeypatch.setattr(S, '_MEM_KEY', b'wrong cache' * 3)
    monkeypatch.setattr(S, '_CONV_KEY', b'wrong cache' * 3)
    before = snapshots()
    response = authed_client.get('/api/intelligence/data-health')
    assert response.status_code == 200
    assert {row['status'] for row in response.json()['checks']} == {'readable'}
    assert secret not in response.text and 'someone-else' not in response.text
    assert 'owned-note' not in response.text and str(Path(S.DATA_DIR)) not in response.text
    assert snapshots() == before


@pytest.mark.parametrize('fault', ['missing-key', 'bad-key', 'wrong-key', 'bad-json', 'invalid-shape'])
def test_failed_checks_preserve_store_and_keys(fault, authed_client, monkeypatch):
    path = Path(S.memory_path_for_user(OWNER))
    encrypted(path, {'facts': [{'text': 'sample'}]}, 'memory_key.bin')
    key = Path(S.DATA_DIR) / 'memory_key.bin'
    monkeypatch.setattr(S, '_MEM_KEY', key.read_bytes())
    if fault == 'missing-key':
        key.unlink()
    elif fault == 'bad-key':
        key.write_bytes(b'broken')
    elif fault == 'wrong-key':
        key.write_bytes(b'W' * 32)
    elif fault == 'bad-json':
        path.write_bytes(b'broken-json')
    else:
        encrypted(path, {'facts': 'wrong'}, 'memory_key.bin')
    before = snapshots()
    response = authed_client.get('/api/intelligence/data-health')
    assert response.status_code == 200
    assert response.json()['checks'][0]['status'] == 'unavailable'
    assert snapshots() == before


def test_foreign_data_does_not_appear_as_owned_data(authed_client):
    Path(S.memory_path_for_user('someone-else')).write_text(json.dumps({'facts': ['private']}))
    encrypted(Path(S.CONVERSATIONS_FILE), {'foreign': {'user_id': 'someone-else', 'messages': []}}, 'conversations_key.bin')
    data = authed_client.get('/api/intelligence/data-health').json()
    assert {row['status'] for row in data['checks']} == {'not_created'}


def test_legacy_data_is_readable_without_migration(authed_client):
    path = Path(S.memory_path_for_user(OWNER))
    path.write_text(json.dumps({'facts': ['old saved preference']}))
    before = snapshots()
    row = authed_client.get('/api/intelligence/data-health').json()['checks'][0]
    assert row['status'] == 'readable' and 'unencrypted' in row['detail']
    assert snapshots() == before


def test_unusable_note_metadata_and_unencrypted_sidecar_are_unavailable(authed_client):
    Path(S.memory_path_for_user(OWNER)).write_text(json.dumps({'facts': [{'text': 'sample', 'title': {'wrong': 'type'}}]}))
    path = Path(S.DATA_DIR) / 'intelligence' / f'diagnostics-{hashlib.sha256(OWNER.encode()).hexdigest()}.json'
    path.parent.mkdir()
    path.write_text('[]')
    before = snapshots()
    rows = authed_client.get('/api/intelligence/data-health').json()['checks']
    assert rows[0]['status'] == rows[2]['status'] == 'unavailable'
    assert snapshots() == before


def test_oversized_store_is_not_reported_as_corrupt_or_checked(authed_client, monkeypatch):
    monkeypatch.setattr(data_health, 'MAX_STORE_BYTES', 64)
    Path(S.memory_path_for_user(OWNER)).write_bytes(b'x' * 65)
    before = snapshots()
    data = authed_client.get('/api/intelligence/data-health').json()
    assert data['checks'][0]['status'] == 'not_checked' and data['backup']['status'] == 'unknown'
    assert snapshots() == before


def test_authentication_is_required_and_check_has_no_mutating_endpoint(client, monkeypatch):
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    assert client.get('/api/intelligence/data-health').status_code == 401
    assert client.post('/api/intelligence/data-health').status_code == 405


def test_native_invalid_credential_cannot_fall_through_to_open_local_access(client, monkeypatch):
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    assert client.get('/api/intelligence/data-health', headers={'Authorization': 'Bearer invalid-credential'}).status_code == 401


@pytest.mark.parametrize('raw', [None, b'broken JSON', b'{"node_id":[]}', b'x' * (64 * 1024 + 1)], ids=['missing', 'corrupt', 'invalid-shape', 'oversized'])
def test_real_host_lookup_never_initializes_or_repairs_files(raw, authed_client, monkeypatch):
    node_path = Path(S.DATA_DIR) / 'mesh' / 'node_config.json'
    monkeypatch.setattr(S, 'NODE_CONFIG_PATH', node_path)
    monkeypatch.setattr(S, 'load_node_config', lambda: pytest.fail('Read-only checks cannot initialize node configuration'))
    monkeypatch.setattr(data_health, '_host', REAL_HOST_LOOKUP)
    if raw is not None:
        node_path.parent.mkdir()
        node_path.write_bytes(raw)
    before = snapshots()
    directories = {p for p in Path(S.DATA_DIR).rglob('*') if p.is_dir()}
    response = authed_client.get('/api/intelligence/data-health')
    assert response.status_code == 200
    assert response.json()['host'] == {'id': 'unknown', 'name': 'Unknown TLI host'}
    assert snapshots() == before
    assert {p for p in Path(S.DATA_DIR).rglob('*') if p.is_dir()} == directories
    assert not (Path(S.DATA_DIR) / 'intelligence').exists()


def test_read_only_host_identity_matches_existing_config_and_name_override(authed_client, monkeypatch):
    node_path = Path(S.DATA_DIR) / 'mesh' / 'node_config.json'
    node_path.parent.mkdir()
    node_path.write_text(S.NodeConfig(node_id='paired-host-id', node_name='Original name',
                                   created_at='2026-01-01', updated_at='2026-01-01').model_dump_json())
    metadata = Path(S.DATA_DIR) / 'intelligence' / 'device_context.json'
    metadata.parent.mkdir()
    metadata.write_text(json.dumps({'node-paired-host-id': {'name': 'Kitchen TLI'}, 'private': {'name': 'Do not expose unrelated metadata'}}))
    monkeypatch.setattr(S, 'NODE_CONFIG_PATH', node_path)
    monkeypatch.setattr(data_health, '_host', REAL_HOST_LOOKUP)
    monkeypatch.setattr(S, 'load_node_config', lambda: pytest.fail('No mutable configuration helper'))
    before = snapshots()
    response = authed_client.get('/api/intelligence/data-health')
    assert response.json()['host'] == {'id': 'paired-host-id', 'name': 'Kitchen TLI'}
    assert 'unrelated metadata' not in response.text and snapshots() == before


@pytest.mark.parametrize('stored_owner, status', [('bundled-ai', 'readable'), ('local', 'readable'), (None, 'not_created'), ('someone-else', 'not_created')])
def test_local_conversation_ownership_matches_existing_history_rules(stored_owner, status):
    encrypted(Path(S.CONVERSATIONS_FILE), {'older': {'user_id': stored_owner, 'messages': []}}, 'conversations_key.bin')
    row = next(item for item in data_health.inspect('local')['checks'] if item['id'] == 'conversations')
    assert row['status'] == status
