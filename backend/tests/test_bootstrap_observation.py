"""Public discovery is a read-only hint; synthetic metadata and transports only."""
import builtins
import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from ai import ai_manager
import lan_discovery as lan
import model_probe
import node_settings
import tli_state as S
from routers import system_routes as routes


@pytest.fixture
def bootstrap(tmp_path, monkeypatch):
    root = tmp_path / 'data'
    mesh = root / 'mesh'
    mesh.mkdir(parents=True)
    node_path = mesh / 'node_config.json'
    node = {'node_id': 'public-discovery-id', 'node_name': 'Public discovery name', 'role': 'host',
            'mesh_status': 'approved', 'created_at': '2026-10-01T00:00:00Z',
            'updated_at': '2026-10-01T00:00:00Z', 'host_address': 'PRIVATE retained address',
            'future': {'secret': 'PRIVATE future metadata'}}
    node_path.write_text(json.dumps(node), encoding='utf-8')
    monkeypatch.setattr(S, 'DATA_DIR', str(root))
    monkeypatch.setattr(S, 'MESH_DATA_DIR', mesh)
    monkeypatch.setattr(S, 'NODE_CONFIG_PATH', node_path)
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', root / 'pin.json')
    monkeypatch.setattr(node_settings, '_UNCERTAIN', set())
    monkeypatch.setattr(routes.platform, 'node', lambda: 'Synthetic-host')
    monkeypatch.setattr(routes.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(S, 'now_iso', lambda: '2026-10-16T12:00:00Z')
    forbidden = Mock(side_effect=AssertionError('Public ping attempted initialization or host probing'))
    for name in ('load_node_config', 'save_node_config', 'load_devices', 'save_devices', 'load_pin_config'):
        monkeypatch.setattr(S, name, forbidden)
    for name in ('get', 'status', 'observe_existing', 'ensure_running'):
        monkeypatch.setattr(ai_manager.BundledAIManager, name, forbidden)
    monkeypatch.setattr(ai_manager, '_resolve_model_path', forbidden)
    monkeypatch.setattr(model_probe, 'probe_json', forbidden)
    monkeypatch.setattr(routes, '_run_pwsh_json', forbidden)
    monkeypatch.setattr(routes, 'builtin_sys_snapshot', forbidden)
    monkeypatch.setattr(routes, 'psutil', SimpleNamespace(
        disk_partitions=forbidden, disk_usage=forbidden, virtual_memory=forbidden, cpu_percent=forbidden))
    app = FastAPI()
    app.include_router(routes.router)
    clients = []
    def client(target=app):
        value = TestClient(target, base_url='http://192.0.2.5:8000', client=('192.0.2.8', 5000),
                           raise_server_exceptions=False)
        clients.append(value)
        return value
    def files(): return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*') if path.is_file()}
    yield SimpleNamespace(root=root, node_path=node_path, node=node, client=client, files=files,
                          forbidden=forbidden)
    for value in clients: value.close()
    forbidden.assert_not_called()


def assert_hint(response, identity='existing'):
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    result = response.json()
    assert result['ok'] is True and result['identity_state'] == identity
    assert result['has_ai'] is None and result['ai_healthy'] is None and result['active_preset'] is None
    assert result['model_state'] == 'unobserved'
    assert result['os'] == 'Windows' and result['hostname'] == 'Synthetic-host'
    assert result['ts'] == '2026-10-16T12:00:00Z'
    assert 'PRIVATE' not in response.text
    return result


@pytest.mark.parametrize('pin', ['missing', 'enabled', 'damaged'])
@pytest.mark.parametrize('cookie', [None, 'stale-browser-cookie'])
def test_ping_keeps_public_hint_without_consulting_pin_or_session(bootstrap, pin, cookie):
    f = bootstrap
    if pin == 'enabled': S.PIN_CONFIG_FILE.write_text(json.dumps({'enabled': True, 'hash': 'a' * 64, 'salt': 'b' * 64}))
    if pin == 'damaged': S.PIN_CONFIG_FILE.write_bytes(b'{PRIVATE damaged security')
    before = f.files()
    client = f.client()
    if cookie: client.headers['Cookie'] = 'tli_session=' + cookie
    result = assert_hint(client.get('/agent/ping'))
    assert {key: result[key] for key in ('node_id', 'node_name', 'role')} == {
        key: f.node[key] for key in ('node_id', 'node_name', 'role')}
    assert f.files() == before


def test_ping_does_not_import_ai_even_when_import_would_be_available(bootstrap, monkeypatch):
    original = builtins.__import__
    attempts = []
    def guarded_import(name, *args, **kwargs):
        if name == 'ai' or name.startswith('ai.'):
            attempts.append(name)
            raise AssertionError('Public ping imported the AI lifecycle')
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded_import)
    assert_hint(bootstrap.client().get('/agent/ping'))
    assert attempts == []


def test_missing_identity_remains_truthfully_uninitialized(bootstrap):
    f = bootstrap
    f.node_path.unlink()
    before = f.files()
    result = assert_hint(f.client().get('/agent/ping'), 'uninitialized')
    assert result['node_id'] is None and result['node_name'] is None and result['role'] is None
    assert not f.node_path.exists() and f.files() == before


@pytest.mark.parametrize('damage', [b'{PRIVATE damaged node', b'[]', b'{}',
    b'{"node_id":"PRIVATE","node_name":false}', b'x' * 65537],
    ids=['malformed', 'list', 'empty', 'wrong-types', 'oversized'])
def test_damaged_identity_is_unavailable_and_preserved(bootstrap, damage):
    f = bootstrap
    f.node_path.write_bytes(damage)
    before = f.files()
    response = f.client().get('/agent/ping')
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and 'unknown' not in response.text
    assert f.files() == before


def test_missing_identity_with_saved_dependencies_is_not_fresh(bootstrap):
    f = bootstrap
    f.node_path.unlink()
    (f.node_path.parent / 'mesh_directory.json').write_text('{"PRIVATE peer":{}}', encoding='utf-8')
    before = f.files()
    response = f.client().get('/agent/ping')
    assert response.status_code == 503 and response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and f.files() == before


def test_uncertain_node_change_cannot_be_published_as_discovery(bootstrap):
    f = bootstrap
    node_settings._UNCERTAIN.add(str(f.node_path))
    before = f.files()
    response = f.client().get('/agent/ping')
    assert response.status_code == 503 and response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and f.files() == before


def test_unserializable_saved_name_is_generic_unavailability(bootstrap):
    f = bootstrap
    f.node_path.write_text(json.dumps({**f.node, 'node_name': '\ud800'}), encoding='utf-8')
    before = f.files()
    response = f.client().get('/agent/ping')
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and f.files() == before


@pytest.mark.parametrize('failure', [OSError('PRIVATE filesystem error'), RuntimeError('PRIVATE unexpected error')])
def test_read_error_is_generic_unavailability_not_healthy_fallback(bootstrap, monkeypatch, failure):
    monkeypatch.setattr(S, 'read_node_config', Mock(side_effect=failure))
    response = bootstrap.client().get('/agent/ping')
    assert response.status_code == 503 and response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and 'node_id' not in response.json()


@pytest.mark.parametrize('missing', [False, True])
def test_effective_main_ping_stays_anonymous_and_noninitializing(bootstrap, app, missing):
    f = bootstrap
    if missing: f.node_path.unlink()
    before = f.files()
    assert_hint(f.client(app).get('/agent/ping'), 'uninitialized' if missing else 'existing')
    assert f.files() == before


@pytest.fixture
def discovery_rows(monkeypatch):
    records = {}
    monkeypatch.setattr(S, 'load_node_config', lambda: SimpleNamespace(node_id='local'))
    monkeypatch.setattr(S, 'load_mesh_directory', lambda: copy.deepcopy(records))
    def save(value): records.clear(); records.update(copy.deepcopy(value))
    monkeypatch.setattr(S, 'save_mesh_directory', save)
    monkeypatch.setattr(lan.C, 'observe', Mock())
    monkeypatch.setattr(lan, '_presence_broadcast_fn', None)
    return records


@pytest.mark.parametrize('hints,expected', [
    ({'has_ai': None, 'ai_healthy': None, 'model_state': 'unobserved'}, (None, None)),
    ({'has_ai': True, 'ai_healthy': True, 'model_state': 'unobserved'}, (None, None)),
    ({'has_ai': True, 'ai_healthy': False}, (True, False)),
    ({'has_ai': False, 'ai_healthy': True}, (False, True)),
    ({'has_ai': 'true', 'ai_healthy': 1}, (None, None)),
    ({}, (None, None)),
])
def test_discovery_ai_hints_keep_unknown_distinct_from_negative(discovery_rows, hints, expected):
    lan._upsert_peer('peer', 'Peer', '192.168.4.20', 8443, ai_advertisement=hints,
                     source='diagnostic_scan', interface='192.168.4.10')
    observed = discovery_rows['peer']['discovery']
    assert (observed['has_ai'], observed['ai_healthy']) == expected
    if hints.get('model_state') == 'unobserved': assert observed['model_state'] == 'unobserved'
    assert observed['verified'] is False and 'peer_trust' not in discovery_rows['peer']


def test_unobserved_hint_replaces_old_ai_claim_without_changing_reviewed_authority(discovery_rows):
    original = {'display_name': 'Reviewed peer', 'status': 'blocked', 'ip': '192.168.4.20',
                'tli_port': 8443, 'peer_trust': {'grants': ['messages'], 'revision': 7}}
    discovery_rows['peer'] = {**copy.deepcopy(original),
                              'discovery': {'has_ai': True, 'ai_healthy': True}}
    lan._upsert_peer('peer', 'Unreviewed name', '192.168.4.21', 9443,
                     ai_advertisement={'has_ai': None, 'ai_healthy': None, 'model_state': 'unobserved'},
                     source='diagnostic_scan', interface='192.168.4.10')
    retained = copy.deepcopy(discovery_rows['peer'])
    observed = retained.pop('discovery')
    assert retained == original
    assert observed['has_ai'] is None and observed['ai_healthy'] is None
    assert observed['model_state'] == 'unobserved' and observed['verified'] is False


def test_legacy_boolean_hint_does_not_keep_stale_unobserved_label(discovery_rows):
    discovery_rows['peer'] = {'status': 'pending', 'discovery': {
        'has_ai': None, 'ai_healthy': None, 'model_state': 'unobserved'}}
    lan._upsert_peer('peer', 'Peer', '192.168.4.20', 8443,
                     ai_advertisement={'has_ai': True, 'ai_healthy': False},
                     source='diagnostic_scan', interface='192.168.4.10')
    observed = discovery_rows['peer']['discovery']
    assert observed['has_ai'] is True and observed['ai_healthy'] is False
    assert 'model_state' not in observed
