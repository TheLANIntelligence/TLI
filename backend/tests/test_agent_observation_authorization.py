"""Rich local/Mesh observations retain real browser authority without live probes."""
import json
import time
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import tli_state as S
from ai import ai_manager
from routers import system_routes as system, mesh_routes as mesh


ENDPOINTS = [('/agent/health', system, 'agent_health'), ('/agent/info', system, 'agent_info'),
             ('/api/mesh/health', mesh, 'mesh_health')]
GB = 1024 ** 3


@pytest.fixture
def agent_host(tmp_path, monkeypatch):
    root = tmp_path / 'data'
    mesh_dir = root / 'mesh'
    mesh_dir.mkdir(parents=True)
    node_path = mesh_dir / 'node_config.json'
    directory_path = mesh_dir / 'mesh_directory.json'
    node = {'node_id': 'private-self', 'node_name': 'PRIVATE host', 'role': 'host',
            'mesh_status': 'approved', 'created_at': '2026-10-01T00:00:00Z',
            'updated_at': '2026-10-01T00:00:00Z', 'future': 'PRIVATE node metadata'}
    node_path.write_text(json.dumps(node), encoding='utf-8')
    directory = {ident: {'status': 'pending', 'display_name': 'PRIVATE ' + ident,
                        'ip': address, 'tli_port': 8000, 'future': {'secret': 'PRIVATE additive field'}}
                 for ident, address in [('peer-a', '192.0.2.20'), ('peer-b', '192.0.2.21')]}
    directory_path.write_text(json.dumps(directory), encoding='utf-8')
    monkeypatch.setattr(S, 'DATA_DIR', str(root))
    monkeypatch.setattr(S, 'MESH_DATA_DIR', mesh_dir)
    monkeypatch.setattr(S, 'NODE_CONFIG_PATH', node_path)
    monkeypatch.setattr(S, 'MESH_DIRECTORY_PATH', directory_path)
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', root / 'tli_pin.json')
    monkeypatch.setattr(S, '_active_sessions', {})
    S.save_pin_config('a' * 64, 'b' * 64)
    token = S.create_session_token('owner')
    node_read = Mock(wraps=S.read_node_config)
    directory_read = Mock(wraps=S.load_mesh_directory)
    monkeypatch.setattr(S, 'read_node_config', node_read)
    monkeypatch.setattr(S, 'load_mesh_directory', directory_read)
    blocked = {}
    for name in ('load_node_config', 'save_node_config', 'save_mesh_directory', 'load_devices', 'save_devices'):
        blocked[name] = Mock(side_effect=AssertionError('Private observation reached a persistent writer'))
        monkeypatch.setattr(S, name, blocked[name])
    for name in ('get', 'status', 'start', 'ensure_running'):
        blocked['manager.' + name] = Mock(side_effect=AssertionError('Observation reached AI manager lifecycle'))
        monkeypatch.setattr(ai_manager.BundledAIManager, name, blocked['manager.' + name])
    for name in ('request', '_exchange', 'health'):
        blocked['peer.' + name] = Mock(side_effect=AssertionError('Cached roster reached peer network'))
        monkeypatch.setattr(mesh.peer_trust, name, blocked['peer.' + name])
    for name in ('check', 'schedule'):
        blocked['connections.' + name] = Mock(side_effect=AssertionError('Observation scheduled a connection check'))
        monkeypatch.setattr(mesh.connections, name, blocked['connections.' + name])
    monkeypatch.setattr(mesh.connections, '_ROUTES', {})
    monkeypatch.setattr(mesh.connections, '_CHECKS', {})
    monkeypatch.setattr(mesh.connections, '_INFLIGHT', {})
    observe = Mock(return_value={'status': 'observed', 'model_exists': True, 'healthy': True,
                                'active_preset': 'synthetic', 'active_model': 'PRIVATE synthetic model'})
    monkeypatch.setattr(ai_manager.BundledAIManager, 'observe_existing', observe, raising=False)
    probes = SimpleNamespace(cpu_percent=Mock(return_value=12),
                             virtual_memory=Mock(return_value=SimpleNamespace(total=32 * GB, used=12 * GB,
                                                                             available=20 * GB, percent=37.5)),
                             disk_usage=Mock(return_value=SimpleNamespace(total=100 * GB, free=60 * GB, percent=40)),
                             boot_time=Mock(return_value=1))
    monkeypatch.setattr(system, 'psutil', probes)
    platform = {}
    for name, value in [('node', 'PRIVATE hostname'), ('platform', 'Synthetic Windows'), ('system', 'Windows')]:
        platform[name] = Mock(return_value=value)
        monkeypatch.setattr(system.platform, name, platform[name])
    cpu_count = Mock(return_value=8)
    monkeypatch.setattr(system.os, 'cpu_count', cpu_count)
    app = FastAPI()
    app.include_router(system.router)
    app.include_router(mesh.router)
    clients = []

    def browser(mode='pin-local', *, target=app):
        local = mode not in {'pin-https', 'pin-off-lan', 'remote-http'}
        origin = 'http://localhost:8000' if local else (
            'http' if mode == 'remote-http' else 'https') + '://192.0.2.5:8443'
        if mode in {'open-local', 'pin-off-lan', 'pin-off-stale'}: S.clear_pin_config()
        client = TestClient(target, base_url=origin,
                            client=('127.0.0.1' if local else '192.0.2.8', 1234),
                            headers={'Origin': origin}, raise_server_exceptions=False)
        if mode not in {'anonymous', 'open-local', 'pin-off-lan'}:
            client.headers['Cookie'] = 'tli_session=' + token
        if mode in {'revoked', 'pin-off-stale'}: S.revoke_session_token(token)
        if mode == 'expired': S._active_sessions[token]['expiry'] = 0
        if mode == 'foreign-origin': client.headers['Origin'] = 'https://foreign.invalid'
        if mode == 'same-site': client.headers['Sec-Fetch-Site'] = 'same-site'
        if mode == 'proxy': client.headers['Forwarded'] = 'for=127.0.0.1'
        if mode == 'peer': client.headers['X-TLI-Peer-Id'] = 'synthetic-peer'
        if mode == 'bearer': client.headers['Authorization'] = 'Bearer synthetic-companion'
        clients.append(client)
        return client

    yield SimpleNamespace(root=root, token=token, node_path=node_path, directory_path=directory_path,
                          directory=directory, node_read=node_read, directory_read=directory_read,
                          blocked=blocked, observe=observe, ps=probes, platform=platform, cpu_count=cpu_count,
                          browser=browser)
    for client in clients: client.close()
    for operation in blocked.values(): operation.assert_not_called()


def no_observations(f):
    f.node_read.assert_not_called(); f.directory_read.assert_not_called(); f.observe.assert_not_called()
    for operation in vars(f.ps).values(): operation.assert_not_called()
    for operation in f.platform.values(): operation.assert_not_called()
    f.cpu_count.assert_not_called()


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
@pytest.mark.parametrize('mode,status', [('anonymous', 401), ('revoked', 401), ('expired', 401),
    ('pin-off-stale', 401), ('pin-off-lan', 403), ('remote-http', 403), ('foreign-origin', 403),
    ('same-site', 403), ('proxy', 403), ('peer', 403), ('bearer', 403), ('unavailable', 503)])
def test_agent_reads_denied_before_private_work(agent_host, mode, status, path, module, service):
    f = agent_host
    if mode == 'unavailable': S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE": damaged')
    response = f.browser(mode).get(path)
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text
    no_observations(f)


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
@pytest.mark.parametrize('mode', ['pin-local', 'pin-https', 'open-local'])
def test_authorized_agent_reads_preserve_shapes_without_writes_or_peer_requests(agent_host, mode, path, module, service):
    f = agent_host
    before = f.node_path.read_bytes(), f.directory_path.read_bytes()
    response = f.browser(mode).get(path)
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    data = response.json()
    if service == 'agent_info':
        assert data['node']['node_id'] == 'private-self'
        assert data['system']['hostname'] == 'PRIVATE hostname'
        assert data['system']['memory']['total_gb'] == 32
        f.observe.assert_not_called()
    else:
        own = data['nodes'][0] if service == 'mesh_health' else data
        assert own['node_id'] == 'private-self'
        assert own['cpu_percent'] == 12 and own['ram_total_gb'] == 32
        assert own['ai_status'] == 'observed' and own['ai_healthy'] is True
        assert own['active_model'] == 'PRIVATE synthetic model'
        assert callable(f.observe.call_args.kwargs['check'])
        if service == 'mesh_health':
            peers = data['nodes'][1:]
            assert {row['peer_id'] for row in peers} == {'peer-a', 'peer-b'}
            assert all(row['online'] is None and row['connection_state'] == 'review_required' for row in peers)
            assert all(row['ready_grants'] == [] for row in peers)
            assert 'PRIVATE additive field' not in response.text
    assert (f.node_path.read_bytes(), f.directory_path.read_bytes()) == before


def deny(f, change):
    if change == 'revoke': S.revoke_session_token(f.token)
    elif change == 'expiry': S._active_sessions[f.token]['expiry'] = 0
    elif change == 'owner': S._active_sessions[f.token]['user_id'] = 'different-owner'
    elif change == 'epoch': S.revoke_all_sessions()
    elif change == 'mode': S.clear_pin_config()
    else: S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE security": damaged')


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
@pytest.mark.parametrize('change', ['revoke', 'expiry', 'owner', 'epoch', 'mode', 'damage'])
@pytest.mark.parametrize('error', [False, True])
def test_agent_http_rechecks_service_completion_and_error(agent_host, monkeypatch, path, module, service, change, error):
    f = agent_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    def observed(*, check=None):
        assert callable(check)
        check()
        deny(f, change)
        if error: raise RuntimeError('PRIVATE host error')
        return {'PRIVATE': 'unconfirmed output'}
    monkeypatch.setattr(module, service, observed)
    response = client.get(path)
    assert response.status_code == (503 if change == 'damage' else 401), response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
@pytest.mark.parametrize('damage', [b'{"PRIVATE":broken', b'[]', b'{}'])
def test_damaged_identity_fails_before_metrics_and_is_preserved(agent_host, path, module, service, damage):
    f = agent_host
    f.node_path.write_bytes(damage)
    response = f.browser().get(path)
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and f.node_path.read_bytes() == damage
    f.observe.assert_not_called(); f.directory_read.assert_not_called()
    for operation in vars(f.ps).values(): operation.assert_not_called()


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
def test_fresh_missing_identity_is_null_without_creating_state(agent_host, path, module, service):
    f = agent_host
    f.node_path.unlink(); f.directory_path.unlink()
    response = f.browser().get(path)
    assert response.status_code == 200, response.text
    data = response.json()
    own = data['nodes'][0] if service == 'mesh_health' else data['node'] if service == 'agent_info' else data
    assert own['node_id'] is None
    assert not f.node_path.exists() and not f.directory_path.exists()


@pytest.mark.parametrize('stage', ['self', 'directory', 'folding', 'connection', 'messaging', 'trust'])
@pytest.mark.parametrize('error', [False, True])
def test_mesh_rechecks_every_projection_before_next_private_stage(agent_host, monkeypatch, stage, error):
    f = agent_host
    obj, name = {'self': (system, 'agent_health'), 'directory': (S, 'load_mesh_directory'),
                 'folding': (mesh.peer_presentation, 'previous_discoveries'),
                 'connection': (mesh.connections, 'snapshot'), 'messaging': (mesh.peer_trust, 'message_readiness'),
                 'trust': (mesh.peer_trust, 'public_trust')}[stage]
    original = getattr(obj, name)
    calls = []
    def observed(*args, **kwargs):
        result = original(*args, **kwargs)
        calls.append(args)
        S.revoke_session_token(f.token)
        if error: raise RuntimeError('PRIVATE projection failed')
        return result
    monkeypatch.setattr(obj, name, observed)
    response = f.browser().get('/api/mesh/health')
    assert response.status_code == 401, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert len(calls) == 1
    if stage == 'self': f.directory_read.assert_not_called()


@pytest.mark.parametrize('stage', ['self', 'directory', 'connection', 'messaging', 'trust'])
def test_mesh_checked_failure_is_unavailable_not_healthy_or_review_required(agent_host, monkeypatch, stage):
    obj, name = {'self': (system, 'agent_health'), 'directory': (S, 'load_mesh_directory'),
                 'connection': (mesh.connections, 'snapshot'), 'messaging': (mesh.peer_trust, 'message_readiness'),
                 'trust': (mesh.peer_trust, 'public_trust')}[stage]
    monkeypatch.setattr(obj, name, Mock(side_effect=RuntimeError('PRIVATE projection error')))
    response = agent_host.browser().get('/api/mesh/health')
    assert response.status_code == 503
    assert response.json() == {'detail': 'Private system information is unavailable.'}
    assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('damage', [b'{"PRIVATE":broken', b'[]', b'{"private-peer":null}'])
def test_mesh_damaged_directory_never_becomes_empty_roster(agent_host, damage):
    f = agent_host
    f.directory_path.write_bytes(damage)
    response = f.browser().get('/api/mesh/health')
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert f.directory_path.read_bytes() == damage


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
@pytest.mark.parametrize('mode', ['anonymous', 'pin-off-lan', 'bearer', 'pin-https'])
def test_effective_main_agent_reads_keep_browser_admission(agent_host, monkeypatch, app, path, module, service, mode):
    import companion_auth
    if mode == 'bearer': monkeypatch.setattr(companion_auth, 'credential_owner', lambda _: 'owner')
    response = agent_host.browser(mode, target=app).get(path)
    assert response.status_code == (200 if mode == 'pin-https' else 401 if mode == 'anonymous' else 403), response.text
    assert response.headers['cache-control'] == 'no-store'
    if mode != 'pin-https': no_observations(agent_host)


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
def test_effective_main_invalid_bearer_does_not_reuse_cookie(agent_host, monkeypatch, app, path, module, service):
    import companion_auth
    def invalid(_): raise HTTPException(401, 'Credential revoked')
    monkeypatch.setattr(companion_auth, 'credential_owner', invalid)
    response = agent_host.browser('bearer', target=app).get(path)
    assert response.status_code == 401
    assert response.headers['cache-control'] == 'no-store'
    no_observations(agent_host)


@pytest.mark.parametrize('path,stage', [('/agent/health', 'cpu'), ('/agent/health', 'memory'),
    ('/agent/health', 'disk'), ('/agent/health', 'uptime'), ('/agent/health', 'ai'),
    ('/agent/info', 'hostname'), ('/agent/info', 'cpu-count'), ('/agent/info', 'memory'),
    ('/api/mesh/health', 'ai')])
@pytest.mark.parametrize('error', [False, True])
def test_actual_agent_service_rechecks_probe_before_further_work(agent_host, path, stage, error):
    f = agent_host
    operation = {'cpu': f.ps.cpu_percent, 'memory': f.ps.virtual_memory,
                 'disk': f.ps.disk_usage, 'uptime': f.ps.boot_time, 'ai': f.observe,
                 'hostname': f.platform['node'], 'cpu-count': f.cpu_count}[stage]
    value = operation.return_value
    def probe(*args, **kwargs):
        S.revoke_session_token(f.token)
        if error: raise OSError('PRIVATE observation error')
        return value
    operation.side_effect = probe
    response = f.browser().get(path)
    assert response.status_code == 401, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    if stage == 'cpu': f.ps.virtual_memory.assert_not_called()
    if stage == 'disk': f.ps.boot_time.assert_not_called()
    if stage in {'cpu', 'disk', 'uptime', 'memory'}: f.observe.assert_not_called()
    if path == '/api/mesh/health': f.directory_read.assert_not_called()


@pytest.mark.parametrize('path,module,service', ENDPOINTS)
def test_one_shot_security_failure_after_node_read_cannot_become_fallback(agent_host, monkeypatch, path, module, service):
    f = agent_host
    original_node = f.node_read._mock_wraps
    original_pin = S.load_pin_config
    failure = HTTPException(503, 'Security temporarily unavailable')
    def read(*args, **kwargs):
        result = original_node(*args, **kwargs)
        calls = []
        def once():
            calls.append(True)
            if len(calls) == 1: raise failure
            return original_pin()
        monkeypatch.setattr(S, 'load_pin_config', once)
        return result
    f.node_read.side_effect = read
    response = f.browser().get(path)
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert response.json() == {'detail': 'Security temporarily unavailable'}
    f.observe.assert_not_called(); f.directory_read.assert_not_called()
    for operation in vars(f.ps).values(): operation.assert_not_called()


def test_public_discovery_ping_keeps_its_separate_contract(monkeypatch, tmp_path):
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', tmp_path / 'pin.json')
    S.save_pin_config('a' * 64, 'b' * 64)
    read = Mock(return_value=SimpleNamespace(
        node_id='synthetic-public-id', node_name='Synthetic discovery', role='host'))
    monkeypatch.setattr(S, 'read_node_config', read)
    forbidden = Mock(side_effect=AssertionError('Public ping initialized or probed private state'))
    monkeypatch.setattr(S, 'load_node_config', forbidden)
    monkeypatch.setattr(S, 'save_node_config', forbidden)
    monkeypatch.setattr(system.platform, 'node', lambda: 'synthetic-hostname')
    monkeypatch.setattr(system.platform, 'system', lambda: 'SyntheticOS')
    monkeypatch.setattr(ai_manager.BundledAIManager, 'get', forbidden)
    monkeypatch.setattr(ai_manager.BundledAIManager, 'status', forbidden)
    monkeypatch.setattr(ai_manager.BundledAIManager, 'observe_existing', forbidden)
    app = FastAPI()
    app.include_router(system.router)
    client = TestClient(app, base_url='http://192.0.2.5:8000', client=('192.0.2.8', 1234))
    try:
        response = client.get('/agent/ping')
    finally:
        client.close()
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.json()['node_id'] == 'synthetic-public-id'
    assert response.json()['identity_state'] == 'existing'
    assert response.json()['has_ai'] is None and response.json()['ai_healthy'] is None
    assert response.json()['active_preset'] is None and response.json()['model_state'] == 'unobserved'
    read.assert_called_once_with()
    forbidden.assert_not_called()


def test_mesh_grant_change_during_projection_cannot_reuse_previous_readiness(agent_host, monkeypatch):
    from tests.test_peer_trust import computer, entry
    f = agent_host
    _, card = computer('peer-a', '192.168.2.20', 8443)
    directory = {'peer-a': entry(card, grants=['messages'])}
    f.directory_path.write_text(json.dumps(directory), encoding='utf-8')
    old_revision = mesh.peer_trust.trusted('peer-a')[2]
    checked_at = '2026-10-16T01:02:03Z'
    mesh.connections._CHECKS['peer-a'] = {
        'revision': old_revision, 'expires': time.monotonic() + 100,
        'next': time.monotonic() + 10, 'value': {
            'state': 'connected', 'online': True, 'checked_at': checked_at,
            'expires_at': '2026-10-16T01:03:33Z', 'reason': None,
            'trust_revision': 'untrusted cached metadata must not override the local revision',
            'ready_grants': ['messages'], 'capabilities': {'messages': {'state': 'ready'}}}}
    original = mesh.peer_trust.message_readiness
    def grant_changed(*args, **kwargs):
        value = original(*args, **kwargs)
        directory['peer-a']['peer_trust']['grants'] = ['observe']
        f.directory_path.write_text(json.dumps(directory), encoding='utf-8')
        return value
    monkeypatch.setattr(mesh.peer_trust, 'message_readiness', grant_changed)
    response = f.browser().get('/api/mesh/health')
    assert response.status_code == 200, response.text
    peer = response.json()['nodes'][1]
    assert peer['reviewed_grants'] == ['observe'] and peer['trust_revision'] != old_revision
    assert peer['online'] is None and peer['ready_grants'] == []
    assert peer['connection_state'] == 'unknown' and peer['reason']['code'] == 'peer_changed'
    assert peer['connection']['fresh'] is False and peer['connection']['capabilities'] == {}
    assert peer['connection']['trust_revision'] == old_revision
    assert peer['connection']['checked_at'] == checked_at
    assert peer['messaging']['available'] is False and peer['messaging']['code'] == 'peer_changed'
    assert mesh.connections._CHECKS['peer-a']['value']['ready_grants'] == ['messages']
