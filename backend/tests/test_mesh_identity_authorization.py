"""Private Mesh snapshots use temporary stores; no discovery, probes or writes."""
import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import tli_state as S
from routers import mesh_routes as M


ROUTES = [('/mesh/node', 'get_node_identity'), ('/mesh/directory', 'get_mesh_directory'),
          ('/mesh/status', 'mesh_health_status')]


@pytest.fixture
def host(tmp_path, monkeypatch):
    root = tmp_path / 'data'
    mesh_dir = root / 'mesh'
    mesh_dir.mkdir(parents=True)
    node_path, directory_path = mesh_dir / 'node_config.json', mesh_dir / 'mesh_directory.json'
    node = {'node_id': 'private-self', 'node_name': 'PRIVATE host', 'role': 'host',
            'mesh_status': 'approved', 'host_address': '192.0.2.5:8000',
            'created_at': '2026-01-01T00:00:00Z', 'updated_at': '2026-01-02T00:00:00Z',
            'future': {'preserve': 'PRIVATE metadata'}}
    directory = {key: {'status': 'pending', 'display_name': 'PRIVATE ' + key,
                       'ip': address, 'tli_port': 8000, 'last_seen': '2026-01-03T00:00:00Z',
                       'notes': 'PRIVATE notes', 'future': {'preserve': True}}
                 for key, address in [('private-self', '192.0.2.5'), ('peer-a', '192.0.2.20'),
                                      ('peer-b', None)]}
    node_path.write_text(json.dumps(node), encoding='utf-8')
    directory_path.write_text(json.dumps(directory), encoding='utf-8')
    for name, value in [('DATA_DIR', str(root)), ('MESH_DATA_DIR', mesh_dir),
                        ('NODE_CONFIG_PATH', node_path), ('MESH_DIRECTORY_PATH', directory_path),
                        ('PIN_CONFIG_FILE', root / 'tli_pin.json'), ('_active_sessions', {})]:
        monkeypatch.setattr(S, name, value)
    S.save_pin_config('a' * 64, 'b' * 64)
    token = S.create_session_token('owner')
    node_read, directory_read = Mock(wraps=S.read_node_config), Mock(wraps=S.load_mesh_directory)
    monkeypatch.setattr(S, 'read_node_config', node_read)
    monkeypatch.setattr(S, 'load_mesh_directory', directory_read)
    blocked = []
    for obj, names in [(S, ('load_node_config', 'save_node_config', 'save_mesh_directory', 'server_port', 'now_iso')),
                       (M, ('_ensure_host_in_mesh_directory', '_refresh_own_host_address')),
                       (M.peer_trust, ('request', '_exchange', 'health', 'check_status')),
                       (M.connections, ('check', 'schedule')),
                       (M.socket, ('gethostname', 'gethostbyname'))]:
        for name in names:
            operation = Mock(side_effect=AssertionError('Read reached a writer or probe'))
            monkeypatch.setattr(obj, name, operation)
            blocked.append(operation)
    for name in ('_ROUTES', '_CHECKS', '_INFLIGHT'):
        monkeypatch.setattr(M.connections, name, {})
    app = FastAPI()
    app.include_router(M.router)
    clients = []

    def browser(mode='pin-local', target=app):
        local = mode not in {'pin-https', 'pin-off-lan', 'remote-http'}
        origin = 'http://localhost:8000' if local else ('http' if mode == 'remote-http' else 'https') + '://192.0.2.5:8443'
        if mode in {'open-local', 'pin-off-lan', 'pin-off-stale'}:
            S.clear_pin_config()
        client = TestClient(target, base_url=origin, client=('127.0.0.1' if local else '192.0.2.8', 1234),
                            headers={'Origin': origin}, raise_server_exceptions=False)
        if mode not in {'anonymous', 'open-local', 'pin-off-lan'}:
            client.headers['Cookie'] = 'tli_session=' + token
        if mode in {'revoked', 'pin-off-stale'}:
            S.revoke_session_token(token)
        if mode == 'expired': S._active_sessions[token]['expiry'] = 0
        if mode == 'foreign-origin': client.headers['Origin'] = 'https://foreign.invalid'
        if mode == 'same-site': client.headers['Sec-Fetch-Site'] = 'same-site'
        if mode == 'proxy': client.headers['Forwarded'] = 'for=127.0.0.1'
        if mode == 'peer': client.headers['X-TLI-Peer-Id'] = 'private-peer'
        if mode == 'bearer': client.headers['Authorization'] = 'Bearer synthetic-companion'
        clients.append(client)
        return client

    yield SimpleNamespace(root=root, node=node, directory=directory, node_path=node_path,
                          directory_path=directory_path, node_read=node_read, directory_read=directory_read,
                          token=token, browser=browser)
    for client in clients: client.close()
    for operation in blocked: operation.assert_not_called()


def private_failure(response, status):
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('path,service', ROUTES)
@pytest.mark.parametrize('mode,status', [('anonymous', 401), ('revoked', 401), ('expired', 401),
    ('pin-off-stale', 401), ('pin-off-lan', 403), ('remote-http', 403), ('foreign-origin', 403),
    ('same-site', 403), ('proxy', 403), ('peer', 403), ('bearer', 403), ('unavailable', 503)])
def test_admission_denies_before_private_reads(host, path, service, mode, status):
    if mode == 'unavailable': S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE": damaged')
    private_failure(host.browser(mode).get(path), status)
    host.node_read.assert_not_called()
    host.directory_read.assert_not_called()


@pytest.mark.parametrize('path,service', ROUTES)
@pytest.mark.parametrize('mode', ['pin-local', 'pin-https', 'open-local'])
def test_read_preserves_saved_bytes_times_addresses_and_shapes(host, path, service, mode):
    before = host.node_path.read_bytes(), host.directory_path.read_bytes()
    response = host.browser(mode).get(path)
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    data = response.json()
    if service == 'get_node_identity':
        assert data == {'node_id': 'private-self', 'display_name': 'PRIVATE host', 'role': 'host',
                        'join_mode': 'host', 'host_address': '192.0.2.5:8000',
                        'created_at': host.node['created_at'], 'last_seen': host.node['updated_at'], 'is_host': True}
        host.directory_read.assert_not_called()
    elif service == 'get_mesh_directory':
        assert data['this_device_id'] == data['host_device_id'] == 'private-self'
        assert data['mode'] == 'host'
        rows = {row['device_id']: row for row in data['devices']}
        assert set(rows) == {'peer-a', 'peer-b'}
        assert rows['peer-b']['ip'] is None
        assert rows['peer-a']['last_seen'] == host.directory['peer-a']['last_seen']
        assert rows['peer-a']['notes'] == 'PRIVATE notes'
        assert all(row['connection']['online'] is None for row in rows.values())
        assert all(not row['messaging']['available'] for row in rows.values())
        assert all('future' not in row for row in rows.values())
    else:
        assert data['node_id'] == 'private-self'
        assert data['host_address'] == '192.0.2.5:8000'
        assert data['self_last_seen'] == host.directory['private-self']['last_seen']
        assert data['online_nodes'] == ['private-self']
        assert data['unknown_nodes'] == ['peer-a', 'peer-b']
        assert data['offline_count'] == 0 and data['directory_total'] == 3
    assert (host.node_path.read_bytes(), host.directory_path.read_bytes()) == before
    assert callable(host.node_read.call_args.kwargs['check'])


@pytest.mark.parametrize('path,service', ROUTES)
@pytest.mark.parametrize('damage', [b'{"PRIVATE":broken', b'[]', b'{}'], ids=['invalid-json', 'list', 'empty'])
def test_damaged_identity_is_preserved_without_directory_fallback(host, path, service, damage):
    host.node_path.write_bytes(damage)
    private_failure(host.browser().get(path), 503)
    assert host.node_path.read_bytes() == damage
    host.directory_read.assert_not_called()


@pytest.mark.parametrize('path,service', ROUTES)
@pytest.mark.parametrize('dependent', [False, True])
def test_absent_identity_never_creates_or_returns_a_synthetic_node(host, path, service, dependent):
    host.node_path.unlink()
    if not dependent: host.directory_path.unlink()
    private_failure(host.browser().get(path), 503)
    assert not host.node_path.exists()
    assert host.directory_path.exists() is dependent
    host.directory_read.assert_not_called()


@pytest.mark.parametrize('path', ['/mesh/directory', '/mesh/status'])
@pytest.mark.parametrize('damage', [b'{"PRIVATE":broken', b'[]', b'{"peer":null}'], ids=['invalid-json', 'list', 'bad-row'])
def test_damaged_directory_is_not_an_empty_success(host, path, damage):
    host.directory_path.write_bytes(damage)
    private_failure(host.browser().get(path), 503)
    assert host.directory_path.read_bytes() == damage


@pytest.mark.parametrize('path', ['/mesh/directory', '/mesh/status'])
def test_fresh_absent_directory_is_observed_without_self_registration(host, path):
    host.directory_path.unlink()
    response = host.browser().get(path)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data.get('devices', []) == []
    if path.endswith('status'):
        assert data['self_in_directory'] is False
        assert data['directory_total'] == data['online_count'] == 0
    assert not host.directory_path.exists()


def revoke(host, change):
    if change == 'owner': S._active_sessions[host.token]['user_id'] = 'other-owner'
    elif change == 'epoch': S.revoke_all_sessions()
    elif change == 'mode': S.clear_pin_config()
    elif change == 'damage': S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE": broken')
    else: S.revoke_session_token(host.token)


@pytest.mark.parametrize('path,service', ROUTES)
@pytest.mark.parametrize('change', ['revoke', 'owner', 'epoch', 'mode', 'damage'])
@pytest.mark.parametrize('error', [False, True])
def test_route_rechecks_final_success_and_error(host, monkeypatch, path, service, change, error):
    client = host.browser('open-local' if change == 'epoch' else 'pin-local')
    def observed(*, check):
        check()
        revoke(host, change)
        if error: raise RuntimeError('PRIVATE saved read error')
        return {'PRIVATE': 'unconfirmed snapshot'}
    monkeypatch.setattr(M, service, observed)
    private_failure(client.get(path), 503 if change == 'damage' else 401)


@pytest.mark.parametrize('path', ['/mesh/directory', '/mesh/status'])
@pytest.mark.parametrize('stage', ['node', 'directory', 'connection', 'messaging', 'trust'])
@pytest.mark.parametrize('error', [False, True])
def test_revocation_stops_the_next_projection_and_second_peer(host, monkeypatch, path, stage, error):
    obj, name = {'node': (S, 'read_node_config'), 'directory': (S, 'load_mesh_directory'),
                 'connection': (M.connections, 'snapshot'), 'messaging': (M.peer_trust, 'message_readiness'),
                 'trust': (M.peer_trust, 'public_trust')}[stage]
    original, calls = getattr(obj, name), []
    def observed(*args, **kwargs):
        result = original(*args, **kwargs)
        calls.append(args)
        S.revoke_session_token(host.token)
        if error: raise RuntimeError('PRIVATE read failure')
        return result
    monkeypatch.setattr(obj, name, observed)
    private_failure(host.browser().get(path), 401)
    assert len(calls) == 1
    if stage == 'node': host.directory_read.assert_not_called()


@pytest.mark.parametrize('path', ['/mesh/directory', '/mesh/status'])
@pytest.mark.parametrize('stage', ['connection', 'messaging', 'trust'])
def test_unavailable_peer_state_cannot_become_review_required(host, monkeypatch, path, stage):
    obj, name = {'connection': (M.connections, 'snapshot'), 'messaging': (M.peer_trust, 'message_readiness'),
                 'trust': (M.peer_trust, 'public_trust')}[stage]
    monkeypatch.setattr(obj, name, Mock(side_effect=HTTPException(503, 'Saved peer state unavailable.')))
    private_failure(host.browser().get(path), 503)


@pytest.mark.parametrize('path,service', ROUTES)
def test_revoked_waiting_for_node_lock_never_reads_snapshot(host, monkeypatch, path, service):
    lock, waiting = threading.RLock(), threading.Event()
    class WaitingLock:
        def __enter__(self):
            waiting.set()
            lock.acquire()
        def __exit__(self, *args): lock.release()
    monkeypatch.setattr(S, '_NODE_CONFIG_LOCK', WaitingLock())
    read = Mock(wraps=S._security.read_json)
    monkeypatch.setattr(S._security, 'read_json', read)
    client = host.browser()
    with ThreadPoolExecutor(max_workers=1) as executor:
        lock.acquire()
        try:
            result = executor.submit(client.get, path)
            assert waiting.wait(3)
            S.revoke_session_token(host.token)
        finally:
            lock.release()
        private_failure(result.result(timeout=5), 401)
    assert all(call.args[0] != host.node_path for call in read.call_args_list)


@pytest.mark.parametrize('path,service', ROUTES)
def test_revoke_during_encoding_withholds_the_completed_private_body(host, monkeypatch, path, service):
    encode = M.jsonable_encoder
    def encoded(value):
        result = encode(value)
        S.revoke_session_token(host.token)
        return result
    monkeypatch.setattr(M, 'jsonable_encoder', encoded)
    private_failure(host.browser().get(path), 401)


@pytest.mark.parametrize('path,service', ROUTES)
def test_encoding_failure_is_generic_and_not_cacheable(host, monkeypatch, path, service):
    monkeypatch.setattr(M, service, lambda *, check: {'PRIVATE': '\ud800'})
    private_failure(host.browser().get(path), 503)


@pytest.mark.parametrize('path', ['/mesh/directory', '/mesh/status'])
@pytest.mark.parametrize('changed', [False, True])
def test_cached_reachability_keeps_observation_time_and_matches_final_trust(host, monkeypatch, path, changed):
    state = {'state': 'connected', 'online': True, 'fresh': True, 'trust_revision': 'earlier',
             'ready_grants': ['messages'], 'capabilities': {'messages': {'state': 'ready'}},
             'checked_at': '2026-01-04T00:00:00Z', 'reason': None}
    monkeypatch.setattr(M.connections, 'snapshot', lambda *a, check: (check(), copy.deepcopy(state))[1])
    monkeypatch.setattr(M.peer_trust, 'message_readiness', lambda *a, check: (check(), {'available': True})[1])
    monkeypatch.setattr(M.peer_trust, 'public_trust', lambda *a, check: (check(), {
        'trust_state': 'verified', 'trust_revision': 'later' if changed else 'earlier', 'reviewed_grants': ['messages']})[1])
    response = host.browser().get(path)
    assert response.status_code == 200, response.text
    data = response.json()
    if path.endswith('directory'):
        for row in data['devices']:
            assert row['connection']['checked_at'] == state['checked_at']
            assert row['connection']['online'] is (None if changed else True)
            assert row['connection']['fresh'] is (not changed)
            assert row['messaging']['available'] is (not changed)
            if changed:
                assert row['connection']['ready_grants'] == []
                assert row['connection']['capabilities'] == {}
                assert row['connection']['reason']['code'] == 'peer_changed'
    else:
        assert data['online_count'] == (1 if changed else 3)
        assert data['unknown_nodes'] == (['peer-a', 'peer-b'] if changed else [])
    assert state['online'] is True and state['ready_grants'] == ['messages']


@pytest.mark.parametrize('verified', [False, True])
def test_transient_message_grant_does_not_outlive_final_review(host, monkeypatch, verified):
    revision = 'prior-no-messages' if verified else None
    state = {'state': 'unknown' if verified else 'review_required', 'online': None, 'fresh': False,
             'trust_revision': revision, 'ready_grants': [], 'capabilities': {},
             'checked_at': '2026-01-04T00:00:00Z', 'reason': None}
    order = []
    def connection(*args, check):
        check(); order.append('connection')
        return copy.deepcopy(state)
    def temporary_message_grant(*args, check):
        check(); order.append('temporary-messages')
        return {'available': True, 'code': 'reviewed_locally'}
    def final_trust(*args, check):
        check(); order.append('final-review')
        return {'trust_state': 'verified' if verified else 'review_required',
                'trust_revision': revision, 'reviewed_grants': ['observe'] if verified else []}
    monkeypatch.setattr(M.connections, 'snapshot', connection)
    monkeypatch.setattr(M.peer_trust, 'message_readiness', temporary_message_grant)
    monkeypatch.setattr(M.peer_trust, 'public_trust', final_trust)
    response = host.browser().get('/mesh/directory')
    assert response.status_code == 200, response.text
    assert order == ['connection', 'temporary-messages', 'final-review'] * 2
    for row in response.json()['devices']:
        assert row['messaging']['available'] is False
        assert row['messaging']['code'] == 'messages_permission_required'
        assert row['connection']['checked_at'] == state['checked_at']
        assert row['connection']['online'] is None


@pytest.mark.parametrize('path,service', ROUTES)
@pytest.mark.parametrize('mode', ['anonymous', 'pin-off-lan', 'bearer', 'pin-https'])
def test_effective_main_uses_private_browser_route(host, monkeypatch, app, path, service, mode):
    import companion_auth
    if mode == 'bearer': monkeypatch.setattr(companion_auth, 'credential_owner', lambda _: 'owner')
    response = host.browser(mode, target=app).get(path)
    expected = 200 if mode == 'pin-https' else 401 if mode == 'anonymous' else 403
    assert response.status_code == expected, response.text
    assert response.headers['cache-control'] == 'no-store'
    if expected != 200:
        host.node_read.assert_not_called()
        host.directory_read.assert_not_called()


@pytest.mark.parametrize('path,service', ROUTES)
def test_effective_main_invalid_bearer_cannot_use_browser_cookie(host, monkeypatch, app, path, service):
    import companion_auth
    def invalid(_): raise HTTPException(401, 'Credential invalid.')
    monkeypatch.setattr(companion_auth, 'credential_owner', invalid)
    private_failure(host.browser('bearer', target=app).get(path), 401)
    host.node_read.assert_not_called()
    host.directory_read.assert_not_called()


@pytest.mark.parametrize('path,service', ROUTES)
@pytest.mark.parametrize('cookie', [False, True])
def test_valid_https_native_credential_does_not_grant_browser_mesh_observation(host, monkeypatch, app, path, service, cookie):
    import companion_auth
    monkeypatch.setattr(companion_auth, 'credential_owner', lambda _: 'owner')
    client = host.browser('pin-https', target=app)
    client.headers['Authorization'] = 'Bearer synthetic-valid-companion'
    if not cookie: del client.headers['Cookie']
    private_failure(client.get(path), 403)
    host.node_read.assert_not_called()
    host.directory_read.assert_not_called()


def test_legacy_lan_roster_does_not_initialize_genuinely_missing_identity(host):
    host.node_path.unlink()
    host.directory_path.unlink()
    result = M.get_lan_peers(_session='existing-internal-owner')
    assert result == {'protocol': M.connections.PROTOCOL, 'schema_version': M.connections.SCHEMA_VERSION,
                      'peers': [], 'self_id': None}
    assert not host.node_path.exists() and not host.directory_path.exists()


@pytest.mark.parametrize('missing', [False, True])
def test_native_lan_roster_keeps_its_existing_http_contract_without_initialization(host, monkeypatch, app, missing):
    import companion_auth
    monkeypatch.setattr(companion_auth, 'credential_owner', lambda _: 'owner')
    if missing:
        host.node_path.unlink()
        host.directory_path.unlink()
    client = host.browser('pin-https', target=app)
    client.headers['Authorization'] = 'Bearer synthetic-valid-companion'
    del client.headers['Cookie']
    del client.headers['Origin']
    response = client.get('/api/lan/peers')
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['protocol'] == M.connections.PROTOCOL
    assert data['schema_version'] == M.connections.SCHEMA_VERSION
    assert data['self_id'] == (None if missing else 'private-self')
    assert [peer['id'] for peer in data['peers']] == ([] if missing else ['peer-a'])
    assert host.node_path.exists() is (not missing)
    assert host.directory_path.exists() is (not missing)
